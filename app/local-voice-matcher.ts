const FRAME_COUNT = 64;
const BAND_FREQUENCIES = [250, 500, 1000, 2000, 3000, 4000];
const FEATURE_COUNT = 3 + BAND_FREQUENCIES.length;

export type VoiceSignature = {
  features: number[];
  durationMs: number;
  speakerFingerprint: number[];
};

export type VoiceTemplate = {
  phrase: string;
  voiceSignature?: number[];
  durationMs?: number;
  speakerFingerprint?: number[];
};

export type TrainedWordMatch = {
  text: string;
  matchedWords: number;
  averageScore: number;
};

const WORD_PATTERN = /[\p{L}\p{M}\d]+(?:['’-][\p{L}\p{M}\d]+)*/gu;

const normalizeWord = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

function wordSimilarity(left: string, right: string) {
  const a = normalizeWord(left);
  const b = normalizeWord(right);
  if (!a || !b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= a.length; leftIndex += 1) {
    let diagonal = row[0];
    row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= b.length; rightIndex += 1) {
      const previous = row[rightIndex];
      row[rightIndex] = Math.min(
        row[rightIndex] + 1,
        row[rightIndex - 1] + 1,
        diagonal + (a[leftIndex - 1] === b[rightIndex - 1] ? 0 : 1),
      );
      diagonal = previous;
    }
  }
  return 1 - row[b.length] / Math.max(a.length, b.length);
}

function goertzelPower(
  samples: Float32Array,
  start: number,
  end: number,
  sampleRate: number,
  frequency: number,
) {
  const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / sampleRate);
  let previous = 0;
  let beforePrevious = 0;
  for (let index = start; index < end; index += 1) {
    const current = samples[index] + coefficient * previous - beforePrevious;
    beforePrevious = previous;
    previous = current;
  }
  return Math.max(
    0,
    previous * previous + beforePrevious * beforePrevious -
      coefficient * previous * beforePrevious,
  );
}

function normalizeFeatures(frames: number[][]) {
  const means = Array(FEATURE_COUNT).fill(0);
  const deviations = Array(FEATURE_COUNT).fill(0);

  frames.forEach((frame) =>
    frame.forEach((value, index) => {
      means[index] += value / frames.length;
    }),
  );
  frames.forEach((frame) =>
    frame.forEach((value, index) => {
      deviations[index] += (value - means[index]) ** 2 / frames.length;
    }),
  );

  return frames.flatMap((frame) =>
    frame.map((value, index) => {
      const standardDeviation = Math.sqrt(deviations[index]) || 1;
      return Number(
        (Math.max(-3, Math.min(3, (value - means[index]) / standardDeviation)) / 3).toFixed(4),
      );
    }),
  );
}

function signatureFromSamples(
  samples: Float32Array,
  sampleRate: number,
): VoiceSignature {
    let maximum = 0;
    for (let index = 0; index < samples.length; index += 1) {
      maximum = Math.max(maximum, Math.abs(samples[index]));
    }
    const threshold = Math.max(0.006, maximum * 0.08);
    let first = 0;
    let last = samples.length - 1;
    while (first < last && Math.abs(samples[first]) < threshold) first += 1;
    while (last > first && Math.abs(samples[last]) < threshold) last -= 1;
    const padding = Math.floor(sampleRate * 0.08);
    first = Math.max(0, first - padding);
    last = Math.min(samples.length - 1, last + padding);

    const trimmedLength = last - first + 1;
    if (trimmedLength < sampleRate * 0.16) {
      throw new Error("Amostra de voz muito curta");
    }

    const frames: number[][] = [];
    for (let frameIndex = 0; frameIndex < FRAME_COUNT; frameIndex += 1) {
      const start = first + Math.floor((frameIndex * trimmedLength) / FRAME_COUNT);
      const end = Math.max(
        start + 1,
        first + Math.floor(((frameIndex + 1) * trimmedLength) / FRAME_COUNT),
      );
      let squared = 0;
      let crossings = 0;
      let change = 0;
      for (let index = start; index < end; index += 1) {
        const value = samples[index];
        squared += value * value;
        if (index > start) {
          if ((samples[index - 1] >= 0) !== (value >= 0)) crossings += 1;
          change += Math.abs(value - samples[index - 1]);
        }
      }
      const length = Math.max(1, end - start);
      const bandPowers = BAND_FREQUENCIES.map((frequency) =>
        goertzelPower(samples, start, end, sampleRate, frequency),
      );
      const totalBandPower = bandPowers.reduce((sum, value) => sum + value, 0) || 1;
      frames.push([
        Math.log1p(Math.sqrt(squared / length) * 100),
        crossings / length,
        change / length,
        ...bandPowers.map((power) => Math.log1p((power / totalBandPower) * 20)),
      ]);
    }

    const speakerMeans = Array(FEATURE_COUNT).fill(0);
    const speakerDeviations = Array(FEATURE_COUNT).fill(0);
    frames.forEach((frame) =>
      frame.forEach((value, index) => {
        speakerMeans[index] += value / frames.length;
      }),
    );
    frames.forEach((frame) =>
      frame.forEach((value, index) => {
        speakerDeviations[index] +=
          (value - speakerMeans[index]) ** 2 / frames.length;
      }),
    );

    return {
      features: normalizeFeatures(frames),
      durationMs: (trimmedLength / sampleRate) * 1000,
      speakerFingerprint: [
        ...speakerMeans,
        ...speakerDeviations.map((value) => Math.sqrt(value)),
      ].map((value) => Number(value.toFixed(5))),
    };
}

async function decodeVoiceBlob(blob: Blob) {
  const AudioContextClass = window.AudioContext;
  if (!AudioContextClass) throw new Error("Análise de áudio indisponível");
  const context = new AudioContextClass();
  try {
    const audioBuffer = await context.decodeAudioData(await blob.arrayBuffer());
    const mono = new Float32Array(audioBuffer.length);
    for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
      const channelSamples = audioBuffer.getChannelData(channel);
      for (let index = 0; index < mono.length; index += 1) {
        mono[index] += channelSamples[index] / audioBuffer.numberOfChannels;
      }
    }
    return { samples: mono, sampleRate: audioBuffer.sampleRate };
  } finally {
    await context.close();
  }
}

export async function extractVoiceSignature(blob: Blob): Promise<VoiceSignature> {
  const decoded = await decodeVoiceBlob(blob);
  return signatureFromSamples(decoded.samples, decoded.sampleRate);
}

function splitByEnergyValleys(
  samples: Float32Array,
  sampleRate: number,
  expectedParts: number,
) {
  let maximum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    maximum = Math.max(maximum, Math.abs(samples[index]));
  }
  const threshold = Math.max(0.005, maximum * 0.07);
  let first = 0;
  let last = samples.length - 1;
  while (first < last && Math.abs(samples[first]) < threshold) first += 1;
  while (last > first && Math.abs(samples[last]) < threshold) last -= 1;
  if (last <= first) return [];

  const length = last - first + 1;
  const minimumPart = Math.max(1, Math.floor(sampleRate * 0.12));
  if (length < minimumPart * expectedParts) return [];

  const energyWindow = Math.max(1, Math.floor(sampleRate * 0.035));
  const cuts = [first];
  for (let part = 1; part < expectedParts; part += 1) {
    const ideal = first + Math.floor((part * length) / expectedParts);
    const radius = Math.floor(length / expectedParts / 3);
    const lower = Math.max(cuts.at(-1)! + minimumPart, ideal - radius);
    const upper = Math.min(last - (expectedParts - part) * minimumPart, ideal + radius);
    let quietest = Math.max(lower, Math.min(ideal, upper));
    let quietestEnergy = Number.POSITIVE_INFINITY;
    for (let index = lower; index <= upper; index += energyWindow) {
      const start = Math.max(first, index - Math.floor(energyWindow / 2));
      const end = Math.min(last + 1, index + Math.floor(energyWindow / 2));
      let energy = 0;
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        energy += samples[sampleIndex] ** 2;
      }
      energy /= Math.max(1, end - start);
      if (energy < quietestEnergy) {
        quietestEnergy = energy;
        quietest = index;
      }
    }
    cuts.push(quietest);
  }
  cuts.push(last + 1);

  const padding = Math.floor(sampleRate * 0.035);
  return cuts.slice(0, -1).map((start, index) =>
    samples.slice(
      Math.max(first, start - padding),
      Math.min(last + 1, cuts[index + 1] + padding),
    ),
  );
}

export function compareVoiceSignatures(left: number[], right: number[]) {
  if (
    left.length !== FRAME_COUNT * FEATURE_COUNT ||
    right.length !== FRAME_COUNT * FEATURE_COUNT
  ) {
    return 0;
  }

  let best = -1;
  for (let shift = -3; shift <= 3; shift += 1) {
    let dot = 0;
    let leftMagnitude = 0;
    let rightMagnitude = 0;
    for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
      const otherFrame = frame + shift;
      if (otherFrame < 0 || otherFrame >= FRAME_COUNT) continue;
      for (let feature = 0; feature < FEATURE_COUNT; feature += 1) {
        const leftValue = left[frame * FEATURE_COUNT + feature];
        const rightValue = right[otherFrame * FEATURE_COUNT + feature];
        dot += leftValue * rightValue;
        leftMagnitude += leftValue * leftValue;
        rightMagnitude += rightValue * rightValue;
      }
    }
    const cosine = dot / Math.sqrt(leftMagnitude * rightMagnitude || 1);
    best = Math.max(best, cosine);
  }
  return Math.max(0, Math.min(1, (best + 1) / 2));
}

export function decodeTrainedWordSignatures(
  heardText: string,
  segments: VoiceSignature[],
  templates: VoiceTemplate[],
): TrainedWordMatch | null {
  const heardWords = heardText.match(WORD_PATTERN) ?? [];
  if (!heardWords.length || heardWords.length !== segments.length) return null;

  const grouped = new Map<string, VoiceTemplate[]>();
  templates.forEach((template) => {
    const words = template.phrase.match(WORD_PATTERN) ?? [];
    if (words.length !== 1 || !template.voiceSignature?.length || !template.durationMs) {
      return;
    }
    const key = normalizeWord(words[0]);
    grouped.set(key, [...(grouped.get(key) ?? []), template]);
  });
  if (grouped.size < 2) return null;

  const replacements: string[] = [];
  const acceptedScores: number[] = [];
  segments.forEach((segment, index) => {
    const heardWord = heardWords[index];
    const candidates = Array.from(grouped.values())
      .map((examples) => {
        const phrase = examples[0].phrase;
        const exampleScores = examples
          .map((example) => {
            const acoustic = compareVoiceSignatures(
              segment.features,
              example.voiceSignature ?? [],
            );
            const duration = Math.min(
              segment.durationMs / (example.durationMs ?? segment.durationMs),
              (example.durationMs ?? segment.durationMs) / segment.durationMs,
            );
            return acoustic * 0.9 + duration * 0.1;
          })
          .sort((left, right) => right - left);
        const acousticScore =
          exampleScores.length > 1
            ? exampleScores[0] * 0.72 + exampleScores[1] * 0.28
            : exampleScores[0];
        const lexicalScore = wordSimilarity(heardWord, phrase);
        return {
          phrase,
          acousticScore,
          lexicalScore,
          score: acousticScore * 0.88 + lexicalScore * 0.12,
        };
      })
      .sort((left, right) => right.score - left.score);

    const best = candidates[0];
    const runnerUp = candidates[1];
    const margin = best.score - (runnerUp?.score ?? 0);
    const accepted =
      best.acousticScore >= 0.76 &&
      best.score >= 0.75 &&
      (margin >= 0.025 || best.lexicalScore >= 0.42);
    if (!accepted) {
      replacements.push(heardWord);
      return;
    }

    const replacement = /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/u.test(heardWord)
      ? `${best.phrase.charAt(0).toUpperCase()}${best.phrase.slice(1)}`
      : best.phrase.toLowerCase();
    replacements.push(replacement);
    acceptedScores.push(best.score);
  });

  if (!acceptedScores.length) return null;
  let wordIndex = 0;
  return {
    text: heardText.replace(WORD_PATTERN, () => replacements[wordIndex++]),
    matchedWords: acceptedScores.length,
    averageScore:
      acceptedScores.reduce((sum, score) => sum + score, 0) /
      acceptedScores.length,
  };
}

export async function matchTrainedWordsInUtterance(
  blob: Blob,
  heardText: string,
  templates: VoiceTemplate[],
) {
  const heardWords = heardText.match(WORD_PATTERN) ?? [];
  const uniqueTrainedWords = new Set(
    templates
      .filter((template) => (template.phrase.match(WORD_PATTERN) ?? []).length === 1)
      .map((template) => normalizeWord(template.phrase)),
  );
  if (
    heardWords.length < 2 ||
    heardWords.length > 14 ||
    uniqueTrainedWords.size < 2
  ) {
    return null;
  }

  const decoded = await decodeVoiceBlob(blob);
  const parts = splitByEnergyValleys(
    decoded.samples,
    decoded.sampleRate,
    heardWords.length,
  );
  if (parts.length !== heardWords.length) return null;
  const signatures: VoiceSignature[] = [];
  for (const part of parts) {
    try {
      signatures.push(signatureFromSamples(part, decoded.sampleRate));
    } catch {
      return null;
    }
  }
  return decodeTrainedWordSignatures(heardText, signatures, templates);
}

export async function matchLocalVoiceProfile(
  blob: Blob,
  templates: VoiceTemplate[],
) {
  const available = templates.filter(
    (template) => template.voiceSignature?.length && template.durationMs,
  );
  if (!available.length) return null;

  const current = await extractVoiceSignature(blob);
  const matches = available
    .map((template) => {
      const acoustic = compareVoiceSignatures(
        current.features,
        template.voiceSignature ?? [],
      );
      const duration = Math.min(
        current.durationMs / (template.durationMs ?? current.durationMs),
        (template.durationMs ?? current.durationMs) / current.durationMs,
      );
      return { phrase: template.phrase, score: acoustic * 0.88 + duration * 0.12 };
    })
    .sort((left, right) => right.score - left.score);

  return matches[0] ?? null;
}

export function identifyEnrolledSpeaker(
  current: VoiceSignature,
  templates: VoiceTemplate[],
) {
  const fingerprints = templates
    .map((template) => template.speakerFingerprint)
    .filter((fingerprint): fingerprint is number[] =>
      Boolean(fingerprint?.length === FEATURE_COUNT * 2),
    );
  if (fingerprints.length < 3) {
    return { ready: false, isOwner: true, confidence: 0, sampleCount: fingerprints.length };
  }

  const dimensions = FEATURE_COUNT * 2;
  const center = Array(dimensions).fill(0);
  fingerprints.forEach((fingerprint) =>
    fingerprint.forEach((value, index) => {
      center[index] += value / fingerprints.length;
    }),
  );
  const variance = Array(dimensions).fill(0);
  fingerprints.forEach((fingerprint) =>
    fingerprint.forEach((value, index) => {
      variance[index] += (value - center[index]) ** 2 / fingerprints.length;
    }),
  );

  const distanceFromCenter = (fingerprint: number[]) =>
    Math.sqrt(
      fingerprint.reduce((sum, value, index) => {
        const scale = Math.max(variance[index], Math.abs(center[index]) * 0.025, 0.0001);
        return sum + ((value - center[index]) ** 2) / scale;
      }, 0) / dimensions,
    );

  const enrolledDistances = fingerprints.map(distanceFromCenter);
  const acceptanceDistance = Math.max(
    2.35,
    Math.max(...enrolledDistances) * 1.65,
  );
  const currentDistance = distanceFromCenter(current.speakerFingerprint);
  const confidence = Math.max(
    0,
    Math.min(1, 1 - currentDistance / (acceptanceDistance * 1.65)),
  );
  return {
    ready: true,
    isOwner: currentDistance <= acceptanceDistance,
    confidence,
    sampleCount: fingerprints.length,
  };
}
