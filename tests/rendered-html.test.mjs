import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Clara voice assistant", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html[^>]*lang="pt-BR"/i);
  assert.match(html, /<title>Clara — sua voz, mais clara<\/title>/i);
  assert.match(html, /Sua voz merece/);
  assert.match(html, /Treinar minha voz/);
  assert.match(html, /Falar em voz clara/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Starter Project/i);
});

test("ships the personal correction and recording flows", async () => {
  const source = await readFile(new URL("../app/voice-app.tsx", import.meta.url), "utf8");
  assert.match(source, /clara-corrections/);
  assert.match(source, /clara-voice-training/);
  assert.match(source, /webkitSpeechRecognition/);
  assert.match(source, /speechSynthesis/);
  assert.match(source, /MediaRecorder/);
  assert.match(source, /perfil-de-voz-clara/);
  assert.match(source, /zipSync/);
  assert.match(source, /source:\s*"correction"/);
  assert.match(source, /trainedPhrases/);
});
