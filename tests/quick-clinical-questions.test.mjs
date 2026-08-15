import assert from "node:assert/strict";
import test from "node:test";
import { CLINICAL_SPECIALTIES } from "../app/clinical-phrases.ts";
import {
  classifyNonOwnerSpeech,
  prioritizeQuickQuestions,
  quickQuestionsForSpecialty,
} from "../app/quick-clinical-questions.ts";

test("provides at least one hundred quick questions for every specialty", () => {
  CLINICAL_SPECIALTIES.forEach((specialty) => {
    assert.ok(
      quickQuestionsForSpecialty(specialty).length >= 100,
      `${specialty} precisa ter pelo menos 100 perguntas`,
    );
  });
});

test("prioritizes questions from the patient answer", () => {
  const questions = prioritizeQuickQuestions(
    "Cardiologia",
    "Estou com dor no peito quando faço esforço e fico sem ar",
  );
  assert.ok(questions.slice(0, 10).some((question) => /dor no peito/i.test(question.text)));
  assert.ok(questions.slice(0, 15).some((question) => /falta de ar|respirar/i.test(question.text)));
});

test("separates patient reports from team discussion", () => {
  assert.equal(
    classifyNonOwnerSpeech("Estou com dor no peito e não consigo respirar"),
    "patient",
  );
  assert.equal(
    classifyNonOwnerSpeech("Qual seria sua hipótese diagnóstica e a próxima conduta?"),
    "team",
  );
});
