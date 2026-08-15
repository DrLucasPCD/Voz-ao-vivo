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

export async function extractVoiceSignature(blob: Blob): Promise<VoiceSignature> {
  const AudioContextClass = window.AudioContext;
  if (!AudioContextClass) throw new Error("Análise de áudio indisponível");

  const context = new AudioContextClass();
  try {
    const audioBuffer = await context.decodeAudioData(await blob.arrayBuffer());
    const samples = audioBuffer.getChannelData(0);
    let maximum = 0;
    for (let index = 0; index < samples.length; index += 1) {
      maximum = Math.max(maximum, Math.abs(samples[index]));
    }
    const threshold = Math.max(0.006, maximum * 0.08);
    let first = 0;
    let last = samples.length - 1;
    while (first < last && Math.abs(samples[first]) < threshold) first += 1;
    while (last > first && Math.abs(samples[last]) < threshold) last -= 1;
    const padding = Math.floor(audioBuffer.sampleRate * 0.08);
    first = Math.max(0, first - padding);
    last = Math.min(samples.length - 1, last + padding);

    const trimmedLength = last - first + 1;
    if (trimmedLength < audioBuffer.sampleRate * 0.25) {
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
        goertzelPower(samples, start, end, audioBuffer.sampleRate, frequency),
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
      durationMs: (trimmedLength / audioBuffer.sampleRate) * 1000,
      speakerFingerprint: [
        ...speakerMeans,
        ...speakerDeviations.map((value) => Math.sqrt(value)),
      ].map((value) => Number(value.toFixed(5))),
    };
  } finally {
    await context.close();
  }
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
