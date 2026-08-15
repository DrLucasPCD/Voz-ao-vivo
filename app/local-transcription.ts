export const LOCAL_TRANSCRIPTION_DOWNLOAD_MB = 58;
const LOCAL_TRANSCRIPTION_VERSION = "whisper-tiny-q8-onnx-v1";

export type LocalTranscriptionProgress = {
  phase: "download" | "ready" | "transcribing";
  percent?: number;
  file?: string;
};

type PendingRequest = {
  resolve: (text?: string) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: LocalTranscriptionProgress) => void;
};

let worker: Worker | null = null;
const pending = new Map<string, PendingRequest>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker("/local-transcription.worker.js", {
    type: "module",
    name: "clara-whisper-local",
  });
  worker.onmessage = (
    event: MessageEvent<{
      id: string;
      type: "progress" | "ready" | "transcribing" | "complete" | "error";
      percent?: number;
      file?: string;
      text?: string;
      message?: string;
    }>,
  ) => {
    const message = event.data;
    const request = pending.get(message.id);
    if (!request) return;

    if (message.type === "progress") {
      request.onProgress?.({
        phase: "download",
        percent: message.percent,
        file: message.file,
      });
      return;
    }
    if (message.type === "transcribing") {
      request.onProgress?.({ phase: "transcribing" });
      return;
    }

    pending.delete(message.id);
    if (message.type === "error") {
      request.reject(
        new Error(message.message ?? "Falha no reconhecimento local"),
      );
    } else {
      request.onProgress?.({ phase: "ready", percent: 100 });
      request.resolve(message.text);
    }
  };
  worker.onerror = () => {
    const error = new Error("O reconhecimento local parou inesperadamente");
    pending.forEach((request) => request.reject(error));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function requestWorker(
  type: "prepare" | "transcribe",
  audio: Float32Array | undefined,
  onProgress?: (progress: LocalTranscriptionProgress) => void,
) {
  const id = crypto.randomUUID();
  return new Promise<string | undefined>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    if (audio) {
      getWorker().postMessage({ id, type, audio: audio.buffer }, [audio.buffer]);
    } else {
      getWorker().postMessage({ id, type });
    }
  });
}

async function decodeAndResampleAudio(blob: Blob) {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const channelLength = decoded.length;
    const mono = new Float32Array(channelLength);
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      const samples = decoded.getChannelData(channel);
      for (let index = 0; index < channelLength; index += 1) {
        mono[index] += samples[index] / decoded.numberOfChannels;
      }
    }

    if (decoded.sampleRate === 16_000) return mono;
    const outputLength = Math.max(
      1,
      Math.round((mono.length * 16_000) / decoded.sampleRate),
    );
    const resampled = new Float32Array(outputLength);
    const ratio = decoded.sampleRate / 16_000;
    for (let index = 0; index < outputLength; index += 1) {
      const position = index * ratio;
      const left = Math.floor(position);
      const right = Math.min(mono.length - 1, left + 1);
      const fraction = position - left;
      resampled[index] = mono[left] * (1 - fraction) + mono[right] * fraction;
    }
    return resampled;
  } finally {
    await context.close();
  }
}

export function isLocalTranscriptionPrepared() {
  return (
    localStorage.getItem("clara-local-transcription-ready") ===
    LOCAL_TRANSCRIPTION_VERSION
  );
}

export async function prepareLocalTranscription(
  onProgress?: (progress: LocalTranscriptionProgress) => void,
) {
  await requestWorker("prepare", undefined, onProgress);
  localStorage.setItem(
    "clara-local-transcription-ready",
    LOCAL_TRANSCRIPTION_VERSION,
  );
}

export async function transcribeLocally(
  blob: Blob,
  onProgress?: (progress: LocalTranscriptionProgress) => void,
) {
  const samples = await decodeAndResampleAudio(blob);
  const text = await requestWorker("transcribe", samples, onProgress);
  localStorage.setItem(
    "clara-local-transcription-ready",
    LOCAL_TRANSCRIPTION_VERSION,
  );
  return text?.trim() ?? "";
}
