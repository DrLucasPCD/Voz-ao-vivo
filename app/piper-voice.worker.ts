/// <reference lib="webworker" />

import { TtsSession } from "@mintplex-labs/piper-tts-web";

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const VOICE_ID = "pt_BR-faber-medium";
const CACHE_DIRECTORY = "piper";
const MODEL_SOURCE =
  "https://huggingface.co/Trelis/piper-pt-br-faber-medium/resolve/main";

const MODEL_FILES = [
  {
    sourceUrl: `${MODEL_SOURCE}/model.onnx.json`,
    cachedName: `${VOICE_ID}.onnx.json`,
    minimumBytes: 1_000,
  },
  {
    sourceUrl: `${MODEL_SOURCE}/model.onnx`,
    cachedName: `${VOICE_ID}.onnx`,
    minimumBytes: 60_000_000,
  },
];

type WorkerRequest =
  | { id: string; type: "prepare" }
  | { id: string; type: "synthesize"; text: string };

let sessionPromise: Promise<TtsSession> | null = null;
let modelPreparationPromise: Promise<void> | null = null;
let synthesisQueue: Promise<void> = Promise.resolve();

function send(id: string, payload: Record<string, unknown>) {
  workerScope.postMessage({ id, ...payload });
}

async function getCachedFile(
  directory: FileSystemDirectoryHandle,
  name: string,
) {
  try {
    const handle = await directory.getFileHandle(name);
    return await handle.getFile();
  } catch {
    return null;
  }
}

async function downloadToCache(
  id: string,
  directory: FileSystemDirectoryHandle,
  file: (typeof MODEL_FILES)[number],
) {
  const cached = await getCachedFile(directory, file.cachedName);
  if (cached && cached.size >= file.minimumBytes) return;

  const response = await fetch(file.sourceUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Falha ao baixar ${file.cachedName}`);
  }

  const total = Number(response.headers.get("Content-Length") ?? 0);
  const handle = await directory.getFileHandle(file.cachedName, { create: true });
  const writable = await handle.createWritable();
  const reader = response.body.getReader();
  let loaded = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      loaded += value.byteLength;
      send(id, { type: "progress", loaded, total, file: file.cachedName });
    }
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    await directory.removeEntry(file.cachedName).catch(() => undefined);
    throw error;
  }

  if (loaded < file.minimumBytes) {
    await directory.removeEntry(file.cachedName).catch(() => undefined);
    throw new Error(`O arquivo ${file.cachedName} chegou incompleto`);
  }
}

async function prepareModel(id: string) {
  if (!modelPreparationPromise) {
    modelPreparationPromise = (async () => {
      if (!navigator.storage?.getDirectory) {
        throw new Error("Este navegador não oferece armazenamento local para o modelo");
      }
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle(CACHE_DIRECTORY, {
        create: true,
      });

      for (const file of MODEL_FILES) {
        await downloadToCache(id, directory, file);
      }
    })().catch((error) => {
      modelPreparationPromise = null;
      throw error;
    });
  }
  await modelPreparationPromise;
  send(id, { type: "model-ready" });
}

async function getSession(id: string) {
  await prepareModel(id);
  if (!sessionPromise) {
    // Sem isolamento entre origens, o ONNX Runtime precisa operar em uma thread.
    if (!workerScope.crossOriginIsolated) {
      try {
        Object.defineProperty(navigator, "hardwareConcurrency", {
          configurable: true,
          value: 1,
        });
      } catch {
        // O runtime também limita as threads quando SharedArrayBuffer não existe.
      }
    }
    sessionPromise = TtsSession.create({ voiceId: VOICE_ID });
  }
  return sessionPromise;
}

function runSynthesis<T>(job: () => Promise<T>) {
  const result = synthesisQueue.then(job);
  synthesisQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

workerScope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === "prepare") {
      const session = await getSession(request.id);
      send(request.id, { type: "generating" });
      // A primeira síntese curta carrega e armazena também fonemizador e WASM.
      await runSynthesis(() => session.predict("Voz pronta."));
      send(request.id, { type: "complete" });
      return;
    }

    const session = await getSession(request.id);
    send(request.id, { type: "generating" });
    const audio = await runSynthesis(() => session.predict(request.text));
    send(request.id, { type: "complete", audio });
  } catch (error) {
    sessionPromise = null;
    send(request.id, {
      type: "error",
      message: error instanceof Error ? error.message : "Falha na voz Piper",
    });
  }
};
