export const PIPER_VOICE_NAME = "Faber — português do Brasil";
export const PIPER_MODEL_SIZE_MB = 63;
export const PIPER_FIRST_USE_DOWNLOAD_MB = 95;

export async function isPiperVoiceCached() {
  if (!navigator.storage?.getDirectory) return false;
  try {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("piper");
    const model = await directory
      .getFileHandle("pt_BR-faber-medium.onnx")
      .then((handle) => handle.getFile());
    const config = await directory
      .getFileHandle("pt_BR-faber-medium.onnx.json")
      .then((handle) => handle.getFile());
    return model.size >= 60_000_000 && config.size >= 1_000;
  } catch {
    return false;
  }
}

export type PiperProgress = {
  loaded: number;
  total: number;
  file?: string;
  phase: "download" | "ready" | "generating";
};

type PendingRequest = {
  resolve: (audio?: Blob) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: PiperProgress) => void;
};

let worker: Worker | null = null;
const pending = new Map<string, PendingRequest>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker("/piper-voice.worker.js", {
    type: "module",
    name: "clara-piper-faber",
  });
  worker.onmessage = (
    event: MessageEvent<{
      id: string;
      type: "progress" | "model-ready" | "generating" | "complete" | "error";
      loaded?: number;
      total?: number;
      file?: string;
      audio?: Blob;
      message?: string;
    }>,
  ) => {
    const message = event.data;
    const request = pending.get(message.id);
    if (!request) return;

    if (message.type === "progress") {
      request.onProgress?.({
        loaded: message.loaded ?? 0,
        total: message.total ?? 0,
        file: message.file,
        phase: "download",
      });
      return;
    }
    if (message.type === "model-ready") {
      request.onProgress?.({ loaded: 1, total: 1, phase: "ready" });
      return;
    }
    if (message.type === "generating") {
      request.onProgress?.({ loaded: 1, total: 1, phase: "generating" });
      return;
    }

    pending.delete(message.id);
    if (message.type === "error") {
      const error = new Error(message.message ?? "Falha na voz Piper");
      request.reject(error);
      pending.forEach((otherRequest) => otherRequest.reject(error));
      pending.clear();
      worker?.terminate();
      worker = null;
    } else {
      request.resolve(message.audio);
    }
  };
  worker.onerror = () => {
    const error = new Error("O mecanismo local da voz Faber parou inesperadamente");
    pending.forEach((request) => request.reject(error));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function requestPiper(
  type: "prepare" | "synthesize",
  text: string | undefined,
  onProgress?: (progress: PiperProgress) => void,
) {
  const id = crypto.randomUUID();
  return new Promise<Blob | undefined>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, type, ...(text ? { text } : {}) });
  });
}

export async function preparePiperVoice(
  onProgress?: (progress: PiperProgress) => void,
) {
  await requestPiper("prepare", undefined, onProgress);
}

export async function synthesizeWithPiper(
  text: string,
  onProgress?: (progress: PiperProgress) => void,
) {
  const audio = await requestPiper("synthesize", text, onProgress);
  if (!audio) throw new Error("A voz Faber não gerou áudio");
  return audio;
}
