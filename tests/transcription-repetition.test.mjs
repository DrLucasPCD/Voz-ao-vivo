import assert from "node:assert/strict";
import test from "node:test";

import {
  appendRecognitionResult,
  collapseRecognitionRepetitions,
} from "../app/transcription-repetition.ts";

test("removes a long repeated-word loop from continuous recognition", () => {
  const corrupted = `Então, vamos fazer uma ${"próxima ".repeat(80)}`;
  assert.equal(
    collapseRecognitionRepetitions(corrupted),
    "Então, vamos fazer uma próxima",
  );
});

test("keeps a short natural repetition", () => {
  assert.equal(
    collapseRecognitionRepetitions("Não, não senti febre."),
    "Não, não senti febre.",
  );
});

test("removes a repeated multi-word recognition loop", () => {
  assert.equal(
    collapseRecognitionRepetitions("vamos respirar fundo vamos respirar fundo vamos respirar fundo"),
    "vamos respirar fundo",
  );
});

test("does not append the same final result returned again by the browser", () => {
  assert.equal(
    appendRecognitionResult(
      "Então, vamos fazer uma próxima",
      "próxima",
    ),
    "Então, vamos fazer uma próxima",
  );
});
