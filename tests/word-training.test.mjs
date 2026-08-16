import assert from "node:assert/strict";
import test from "node:test";

import {
  choosePersonalizedRecognition,
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

test("combines browser and local recognition using the trained context", () => {
  const selected = choosePersonalizedRecognition(
    [
      { text: "Você sente dor no peito", source: "browser-context" },
      { text: "Você sempre dorme direito", source: "local-whisper" },
    ],
    ["você", "sente", "dor", "peito"],
    ["Você sente dor no peito?"],
  );

  assert.equal(selected?.text, "Você sente dor no peito");
  assert.equal(selected?.source, "browser-context");
});
