import assert from "node:assert/strict";
import test from "node:test";
import {
  compareVoiceSignatures,
  identifyEnrolledSpeaker,
} from "../app/local-voice-matcher.ts";

test("compares local acoustic signatures without a remote API", () => {
  const signature = Array.from({ length: 64 * 9 }, (_, index) =>
    Math.sin(index / 7),
  );
  const different = Array.from({ length: 64 * 9 }, (_, index) =>
    Math.cos(index / 3),
  );

  assert.equal(compareVoiceSignatures(signature, signature), 1);
  assert.ok(compareVoiceSignatures(signature, different) < 0.6);
  assert.equal(compareVoiceSignatures([], signature), 0);
});

test("identifies the enrolled owner separately from another voice", () => {
  const ownerFingerprint = Array.from({ length: 18 }, (_, index) => 0.2 + index * 0.01);
  const templates = Array.from({ length: 4 }, (_, sampleIndex) => ({
    phrase: `frase ${sampleIndex}`,
    speakerFingerprint: ownerFingerprint.map(
      (value, index) => value + Math.sin(index + sampleIndex) * 0.002,
    ),
  }));
  const owner = identifyEnrolledSpeaker(
    { features: [], durationMs: 1000, speakerFingerprint: ownerFingerprint },
    templates,
  );
  const anotherVoice = identifyEnrolledSpeaker(
    {
      features: [],
      durationMs: 1000,
      speakerFingerprint: ownerFingerprint.map((value) => value + 0.5),
    },
    templates,
  );

  assert.equal(owner.ready, true);
  assert.equal(owner.isOwner, true);
  assert.equal(anotherVoice.isOwner, false);
});
