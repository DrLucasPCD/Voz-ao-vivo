import assert from "node:assert/strict";
import test from "node:test";

import {
  correctWithTrainedWords,
  tokenizeTrainingPhrase,
} from "../app/word-training.ts";

test("splits a clinical phrase into guided words", () => {
  assert.deepEqual(
    tokenizeTrainingPhrase("Você teve dor no peito?"),
    ["Você", "teve", "dor", "no", "peito"],
  );
  assert.deepEqual(
    tokenizeTrainingPhrase("Há náusea, vômito ou pré-síncope?"),
    ["Há", "náusea", "vômito", "ou", "pré-síncope"],
  );
});

test("combines trained words to correct a new sentence", () => {
  assert.equal(
    correctWithTrainedWords(
      "Voce sente cardiologa frequente?",
      ["você", "cardiologia", "frequente"],
    ),
    "Você sente cardiologia frequente?",
  );
});

test("does not replace unrelated short words", () => {
  assert.equal(
    correctWithTrainedWords("dor no pé", ["de", "na", "peito"]),
    "dor no pé",
  );
});
