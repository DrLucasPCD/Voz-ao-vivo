import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(projectRoot, "public/piper-voice.worker.js");

await mkdir(dirname(output), { recursive: true });
await build({
  entryPoints: [resolve(projectRoot, "app/piper-voice.worker.ts")],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
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

console.log("Worker da voz Piper preparado para o navegador.");
