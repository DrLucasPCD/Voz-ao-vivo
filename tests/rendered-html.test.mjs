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
  const [source, phraseSource] = await Promise.all([
    readFile(new URL("app/voice-app.tsx", root), "utf8"),
    readFile(new URL("app/clinical-phrases.ts", root), "utf8"),
  ]);

  assert.match(source, /Consulta médica assistida/);
  assert.match(phraseSource, /Qual é o principal motivo da consulta/);
  assert.match(phraseSource, /"Cardiologia"/);
  assert.match(phraseSource, /"Pediatria"/);
  assert.match(phraseSource, /"Psiquiatria"/);
  assert.match(phraseSource, /"Ginecologia"/);
  assert.match(phraseSource, /"Urgência e emergência"/);
  assert.match(source, /clara-corrections/);
  assert.match(source, /clara-voice-training/);
  assert.match(source, /speechSynthesis/);
  assert.match(source, /MediaRecorder/);
  assert.match(source, /perfil-de-voz-clara/);
  assert.match(source, /maxAlternatives = 5/);
  assert.match(source, /SpeechRecognitionPhrase/);
  assert.match(source, /Especialidade desta consulta/);
});

test("ships private Firebase voice-profile synchronization", async () => {
  const [source, firebaseSource, cloudSource, firestoreRules, storageRules, netlifyConfig] =
    await Promise.all([
      readFile(new URL("app/voice-app.tsx", root), "utf8"),
      readFile(new URL("app/firebase.ts", root), "utf8"),
      readFile(new URL("app/cloud-voice-profile.ts", root), "utf8"),
      readFile(new URL("firestore.rules", root), "utf8"),
      readFile(new URL("storage.rules", root), "utf8"),
      readFile(new URL("netlify.toml", root), "utf8"),
    ]);

  assert.match(firebaseSource, /GoogleAuthProvider/);
  assert.match(firebaseSource, /projectId: "voz-ao-vivo"/);
  assert.match(source, /Entrar para sincronizar/);
  assert.match(source, /signInWithRedirect/);
  assert.match(source, /syncTrainingSample/);
  assert.match(cloudSource, /uploadVoiceSample/);
  assert.match(cloudSource, /subscribeToVoiceSamples/);
  assert.match(firestoreRules, /request\.auth\.uid == userId/);
  assert.match(storageRules, /request\.resource\.contentType\.matches\('audio\/\.\*'\)/);
  assert.match(netlifyConfig, /from = "\/__\/auth\/\*"/);
});
