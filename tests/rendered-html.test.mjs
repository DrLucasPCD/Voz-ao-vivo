import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("is configured as a standard Next.js app for Netlify", async () => {
  const [packageJson, netlifyConfig] = await Promise.all([
    readFile(new URL("package.json", root), "utf8"),
    readFile(new URL("netlify.toml", root), "utf8"),
  ]);

  assert.match(packageJson, /"next": "\^16\.3\.1"/);
  assert.match(packageJson, /"build": "npm run build:piper-worker && next build"/);
  assert.doesNotMatch(packageJson, /vinext|wrangler|cloudflare/);
  assert.match(netlifyConfig, /command = "npm run build"/);
  assert.match(netlifyConfig, /publish = "\.next"/);
  assert.match(netlifyConfig, /Cache-Control = "no-cache, no-store, must-revalidate"/);
  assert.match(
    netlifyConfig,
    /Permissions-Policy = "microphone=\(self\), on-device-speech-recognition=\(self\)"/,
  );
});

test("ships a complete installable offline mode", async () => {
  const [source, transcription, worker, offlineSupport, serviceWorker, manifest] =
    await Promise.all([
      readFile(new URL("app/voice-app.tsx", root), "utf8"),
      readFile(new URL("app/local-transcription.ts", root), "utf8"),
      readFile(new URL("app/local-transcription.worker.ts", root), "utf8"),
      readFile(new URL("app/offline-support.ts", root), "utf8"),
      readFile(new URL("public/sw.js", root), "utf8"),
      readFile(new URL("public/manifest.webmanifest", root), "utf8"),
    ]);

  assert.match(source, /Preparar uso offline/);
  assert.match(source, /transcribeLocally/);
  assert.match(transcription, /local-transcription\.worker\.js/);
  assert.match(worker, /onnx-community\/whisper-tiny/);
  assert.match(worker, /language: "portuguese"/);
  assert.match(worker, /chunk_length_s: 28/);
  assert.match(worker, /ort-wasm-simd-threaded\.jsep\.mjs/);
  assert.match(worker, /ort-wasm-simd-threaded\.jsep\.wasm/);
  assert.match(offlineSupport, /serviceWorker\.register\("\/sw\.js"/);
  assert.match(serviceWorker, /CACHE_URLS/);
  assert.match(serviceWorker, /request\.mode === "navigate"/);
  assert.match(serviceWorker, /clara-offline-v3/);
  assert.match(serviceWorker, /mustRefresh/);
  assert.match(manifest, /"display": "standalone"/);
});

test("ships the local Piper Faber Brazilian voice", async () => {
  const [source, piperClient, piperWorker, packageJson] = await Promise.all([
    readFile(new URL("app/voice-app.tsx", root), "utf8"),
    readFile(new URL("app/piper-voice.ts", root), "utf8"),
    readFile(new URL("app/piper-voice.worker.ts", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);

  assert.match(source, /Voz neural \{PIPER_VOICE_NAME\}/);
  assert.match(source, /synthesizeWithPiper/);
  assert.match(source, /new Audio\(audioUrl\)/);
  assert.match(source, /Testar áudio agora/);
  assert.match(piperClient, /pt_BR-faber-medium\.onnx/);
  assert.match(piperClient, /piper-voice\.worker\.js/);
  assert.match(piperWorker, /Trelis\/piper-pt-br-faber-medium/);
  assert.match(piperWorker, /TtsSession\.create/);
  assert.match(piperWorker, /navigator\.storage\.getDirectory/);
  assert.match(piperWorker, /offline-assets\/piper-onnx/);
  assert.match(piperWorker, /offline-assets\/piper\/piper_phonemize/);
  assert.match(packageJson, /@mintplex-labs\/piper-tts-web/);
});

test("ships personalized recognition without a paid API", async () => {
  const [source, matcherSource, netlifyConfig, exampleEnv] = await Promise.all([
    readFile(new URL("app/voice-app.tsx", root), "utf8"),
    readFile(new URL("app/local-voice-matcher.ts", root), "utf8"),
    readFile(new URL("netlify.toml", root), "utf8"),
    readFile(new URL(".env.example", root), "utf8"),
  ]);

  assert.match(source, /Reconhecimento personalizado gratuito/);
  assert.match(source, /matchLocalVoiceProfile/);
  assert.match(source, /assinaturas acústicas/);
  assert.match(matcherSource, /extractVoiceSignature/);
  assert.match(matcherSource, /compareVoiceSignatures/);
  assert.doesNotMatch(source, /OpenAI|requestPersonalizedTranscription/);
  assert.doesNotMatch(netlifyConfig, /\[functions\]/);
  assert.doesNotMatch(exampleEnv, /OPENAI|API_KEY/);
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
  assert.match(source, /Identificação automática de quem está falando/);
  assert.match(source, /Equipe, colega ou preceptoria/);
  assert.match(source, /prioritizeQuickQuestions/);
  assert.match(source, /Especialidade desta consulta/);
  assert.match(source, /Falas rápidas priorizadas/);
  assert.match(source, /Mini-histórico desta consulta/);
  assert.match(source, /Encerrar consulta e gerar prontuário/);
  assert.match(source, /Já copiei — apagar histórico/);
  assert.match(source, /clara-active-consultation-v1/);
  assert.match(source, /buildClinicalRecord/);
});

test("ships private free-tier Firebase voice-profile synchronization", async () => {
  const [source, firebaseSource, cloudSource, firestoreRules, firebaseConfig, netlifyConfig] =
    await Promise.all([
      readFile(new URL("app/voice-app.tsx", root), "utf8"),
      readFile(new URL("app/firebase.ts", root), "utf8"),
      readFile(new URL("app/cloud-voice-profile.ts", root), "utf8"),
      readFile(new URL("firestore.rules", root), "utf8"),
      readFile(new URL("firebase.json", root), "utf8"),
      readFile(new URL("netlify.toml", root), "utf8"),
    ]);

  assert.match(firebaseSource, /GoogleAuthProvider/);
  assert.match(firebaseSource, /OAuthProvider\("apple\.com"\)/);
  assert.match(firebaseSource, /NEXT_PUBLIC_ENABLE_APPLE_SIGN_IN/);
  assert.match(firebaseSource, /projectId: "voz-ao-vivo"/);
  assert.match(source, /Entrar com Google/);
  assert.match(source, /Entrar com Apple/);
  assert.match(source, /signInWithRedirect/);
  assert.match(source, /max-width: 767px/);
  assert.match(source, /syncTrainingSample/);
  assert.match(cloudSource, /uploadVoiceSample/);
  assert.match(cloudSource, /subscribeToVoiceSamples/);
  assert.match(cloudSource, /Bytes\.fromUint8Array/);
  assert.match(cloudSource, /MAX_SYNCED_AUDIO_BYTES/);
  assert.match(firestoreRules, /request\.auth\.uid == userId/);
  assert.match(firestoreRules, /audioBytes\.size\(\) < 700 \* 1024/);
  assert.doesNotMatch(firebaseSource, /getStorage|firebase\/storage/);
  assert.doesNotMatch(firebaseConfig, /"storage"/);
  assert.match(netlifyConfig, /from = "\/__\/auth\/\*"/);
});
