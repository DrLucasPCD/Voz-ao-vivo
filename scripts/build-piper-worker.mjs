import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDirectory = resolve(projectRoot, "public");
const piperOutput = resolve(publicDirectory, "piper-voice.worker.js");
const transcriptionOutput = resolve(
  publicDirectory,
  "local-transcription.worker.js",
);

const workerBuildOptions = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
};

await mkdir(dirname(piperOutput), { recursive: true });
await build({
  entryPoints: [resolve(projectRoot, "app/piper-voice.worker.ts")],
  outfile: piperOutput,
  ...workerBuildOptions,
  plugins: [
    {
      name: "ignore-inactive-node-branches",
      setup(buildContext) {
        buildContext.onResolve({ filter: /^(fs|path)$/ }, () => ({
          path: resolve(projectRoot, "app/browser-empty.ts"),
        }));
      },
    },
  ],
});

await build({
  entryPoints: [resolve(projectRoot, "app/local-transcription.worker.ts")],
  outfile: transcriptionOutput,
  ...workerBuildOptions,
});

const assetCopies = [
  {
    source: resolve(
      projectRoot,
      "node_modules/@diffusionstudio/piper-wasm/build/piper_phonemize.data",
    ),
    target: resolve(
      publicDirectory,
      "offline-assets/piper/piper_phonemize.data",
    ),
  },
  {
    source: resolve(
      projectRoot,
      "node_modules/@diffusionstudio/piper-wasm/build/piper_phonemize.wasm",
    ),
    target: resolve(
      publicDirectory,
      "offline-assets/piper/piper_phonemize.wasm",
    ),
  },
  {
    source: resolve(
      projectRoot,
      "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
    ),
    target: resolve(
      publicDirectory,
      "offline-assets/piper-onnx/ort-wasm-simd-threaded.wasm",
    ),
  },
  {
    source: resolve(
      projectRoot,
      "node_modules/onnxruntime-web/dist/ort-wasm-simd.wasm",
    ),
    target: resolve(
      publicDirectory,
      "offline-assets/piper-onnx/ort-wasm-simd.wasm",
    ),
  },
  {
    source: resolve(
      projectRoot,
      "node_modules/onnxruntime-web/dist/ort-wasm-threaded.wasm",
    ),
    target: resolve(
      publicDirectory,
      "offline-assets/piper-onnx/ort-wasm-threaded.wasm",
    ),
  },
  {
    source: resolve(
      projectRoot,
      "node_modules/onnxruntime-web/dist/ort-wasm.wasm",
    ),
    target: resolve(
      publicDirectory,
      "offline-assets/piper-onnx/ort-wasm.wasm",
    ),
  },
  {
    source: resolve(
      projectRoot,
      "node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
    ),
    target: resolve(
      publicDirectory,
      "offline-assets/transformers/ort-wasm-simd-threaded.wasm",
    ),
  },
  {
    source: resolve(
      projectRoot,
      "node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs",
    ),
    target: resolve(
      publicDirectory,
      "offline-assets/transformers/ort-wasm-simd-threaded.jsep.mjs",
    ),
  },
  {
    source: resolve(
      projectRoot,
      "node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm",
    ),
    target: resolve(
      publicDirectory,
      "offline-assets/transformers/ort-wasm-simd-threaded.jsep.wasm",
    ),
  },
];

for (const asset of assetCopies) {
  await mkdir(dirname(asset.target), { recursive: true });
  await copyFile(asset.source, asset.target);
}

console.log("Workers e recursos locais de voz preparados para o navegador.");
