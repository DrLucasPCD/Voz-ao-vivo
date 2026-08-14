import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("is configured as a standard Next.js app for Netlify", async () => {
  const [packageJson, netlifyConfig] = await Promise.all([
    readFile(new URL("package.json", root), "utf8"),
    readFile(new URL("netlify.toml", root), "utf8"),
  ]);

  assert.match(packageJson, /"next": "\^16\.2\.6"/);
  assert.match(packageJson, /"build": "next build"/);
  assert.doesNotMatch(packageJson, /vinext|wrangler|cloudflare/);
  assert.match(netlifyConfig, /command = "npm run build"/);
  assert.match(netlifyConfig, /publish = "\.next"/);
  assert.match(netlifyConfig, /Permissions-Policy = "microphone=\(self\)"/);
});

test("ships the clinical consultation voice workflow", async () => {
  const source = await readFile(new URL("app/voice-app.tsx", root), "utf8");

  assert.match(source, /Consulta médica assistida/);
  assert.match(source, /Qual é o principal motivo da consulta/);
  assert.match(source, /context: "Queixa principal"/);
  assert.match(source, /context: "Medicamentos"/);
  assert.match(source, /context: "Alergias"/);
  assert.match(source, /context: "Encerramento"/);
  assert.match(source, /clara-corrections/);
  assert.match(source, /clara-voice-training/);
  assert.match(source, /speechSynthesis/);
  assert.match(source, /MediaRecorder/);
  assert.match(source, /perfil-de-voz-clara/);
});
