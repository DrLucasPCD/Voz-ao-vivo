import assert from "node:assert/strict";
import test from "node:test";

import { retryDelayMs, voiceSyncProgress } from "../app/voice-sync-state.ts";

test("counts confirmed and pending voice samples", () => {
  const progress = voiceSyncProgress([
    { synced: true, firestoreAudioSynced: true },
    { blob: new Blob(["voice"]), firestoreAudioSynced: false },
    { synced: true },
  ]);
  assert.deepEqual(progress, { total: 3, synced: 2, pending: 1 });
});

test("uses bounded exponential retry delays", () => {
  assert.equal(retryDelayMs(1), 800);
  assert.equal(retryDelayMs(2), 1_600);
  assert.equal(retryDelayMs(10), 12_000);
});
