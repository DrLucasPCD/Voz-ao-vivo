import assert from "node:assert/strict";
import test from "node:test";

import {
  hasUsableBrowserTranscript,
  isLocalDecodingFailure,
  isNonSpeechTranscript,
} from "../app/transcription-filter.ts";

test("blocks music and other non-speech Whisper markers", () => {
  assert.equal(isNonSpeechTranscript("[MÚSICA]"), true);
  assert.equal(isNonSpeechTranscript("Música música"), true);
  assert.equal(isNonSpeechTranscript("(ruído)"), true);
  assert.equal(isNonSpeechTranscript("[inaudível]"), true);
  assert.equal(isNonSpeechTranscript("som ambiente"), true);
});

test("keeps real clinical sentences that mention noise", () => {
  assert.equal(
    isNonSpeechTranscript("O paciente relata exposição a ruído intenso"),
    false,
  );
  assert.equal(isNonSpeechTranscript("Há ruído no ouvido esquerdo"), false);
});

test("recognizes local decoder failures", () => {
  assert.equal(isLocalDecodingFailure(new Error("Decoding failed")), true);
  assert.equal(isLocalDecodingFailure("Audio decode failed at frame 2"), true);
  assert.equal(isLocalDecodingFailure(new Error("Network error")), false);
});

test("keeps valid browser speech when the local decoder fails", () => {
  assert.equal(
    hasUsableBrowserTranscript("Você sente dor no peito?", ""),
    true,
  );
  assert.equal(hasUsableBrowserTranscript("[MÚSICA]", ""), false);
  assert.equal(hasUsableBrowserTranscript("", "   "), false);
});
