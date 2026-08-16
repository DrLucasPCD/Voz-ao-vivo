import assert from "node:assert/strict";
import test from "node:test";

import {
  consultationRecordSignature,
  recordPdfWasConfirmed,
} from "../app/record-download-state.ts";

const turns = [
  {
    id: "turn-1",
    speaker: "doctor",
    text: "Você teve febre?",
    createdAt: "2026-08-15T10:00:00.000Z",
  },
];

test("keeps the PDF confirmation for the same consultation", () => {
  const signature = consultationRecordSignature("Clínica geral", turns);
  assert.equal(recordPdfWasConfirmed(signature, signature), true);
});

test("invalidates the PDF confirmation when the consultation changes", () => {
  const saved = consultationRecordSignature("Clínica geral", turns);
  const changed = consultationRecordSignature("Clínica geral", [
    ...turns,
    {
      id: "turn-2",
      speaker: "patient",
      text: "Tive ontem.",
      createdAt: "2026-08-15T10:01:00.000Z",
    },
  ]);
  assert.equal(recordPdfWasConfirmed(saved, changed), false);
});
