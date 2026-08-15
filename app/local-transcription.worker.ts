/// <reference lib="webworker" />

import { env, pipeline } from "@huggingface/transformers";

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const MODEL_ID = "onnx-community/whisper-tiny";
const runtimeRequestUrls: string[] = [];

const nativeFetch = workerScope.fetch.bind(workerScope);
(workerScope as unknown as { fetch: typeof fetch }).fetch = async (
  input,
  init,
) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("offline-assets")) runtimeRequestUrls.push(url);
  return nativeFetch(input, init);
};

if (typeof XMLHttpRequest !== "undefined") {
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function patchedOpen(
    method: string,
    url: string | URL,
    async = true,
    username?: string | null,
    password?: string | null,
  ) {
    const target = String(url);
    if (target.includes("offline-assets")) runtimeRequestUrls.push(target);
    return Reflect.apply(nativeOpen, this, [method, url, async, username, password]);
  };
}

env.allowLocalModels = false;
env.useBrowserCache = true;
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = {
    mjs: "/offline-assets/transformers/ort-wasm-simd-threaded.jsep.mjs",
    wasm: "/offline-assets/transformers/ort-wasm-simd-threaded.jsep.wasm",
  };
  env.backends.onnx.wasm.numThreads = 1;
}

type WorkerRequest =
  | { id: string; type: "prepare" }
  | { id: string; type: "transcribe"; audio: ArrayBuffer };

type Transcriber = Awaited<ReturnType<typeof pipeline<"automatic-speech-recognition">>>;

let transcriberPromise: Promise<Transcriber> | null = null;
let inferenceQueue: Promise<void> = Promise.resolve();

function send(id: string, payload: Record<string, unknown>) {
  workerScope.postMessage({ id, ...payload });
}

function getTranscriber(id: string) {
  if (!transcriberPromise) {
    transcriberPromise = pipeline(
      "automatic-speech-recognition",
      MODEL_ID,
      {
        device: "wasm",
        dtype: "q8",
        progress_callback: (progress) => {
          const details = progress as {
            status?: string;
            file?: string;
            progress?: number;
            loaded?: number;
            total?: number;
          };
          send(id, {
            type: "progress",
            status: details.status,
            file: details.file,
            percent:
              typeof details.progress === "number"
                ? Math.max(0, Math.min(100, Math.round(details.progress)))
                : undefined,
            loaded: details.loaded,
            total: details.total,
          });
        },
      },
    ).catch((error) => {
      transcriberPromise = null;
      throw error;
    });
  }
  return transcriberPromise;
}

function runInference<T>(job: () => Promise<T>) {
  const result = inferenceQueue.then(job);
  inferenceQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

workerScope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    const transcriber = await getTranscriber(request.id);
    if (request.type === "prepare") {
      send(request.id, { type: "ready" });
      return;
    }

    send(request.id, { type: "transcribing" });
    const result = await runInference(() =>
      transcriber(new Float32Array(request.audio), {
        language: "portuguese",
        task: "transcribe",
        chunk_length_s: 28,
        stride_length_s: 4,
      }),
    );
    const output = Array.isArray(result) ? result[0] : result;
    send(request.id, { type: "complete", text: output?.text?.trim() ?? "" });
  } catch (error) {
    send(request.id, {
      type: "error",
      message:
        error instanceof Error
          ? `${error.message}${runtimeRequestUrls.length ? ` | Recursos: ${runtimeRequestUrls.slice(-4).join(", ")}` : ""}`
          : "Falha no reconhecimento local de voz",
    });
  }
};
