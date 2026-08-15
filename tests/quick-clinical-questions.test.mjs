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
    const options = quickQuestionsForSpecialty(specialty);
    assert.ok(
      options.length >= 100,
      `${specialty} precisa ter pelo menos 100 perguntas`,
    );
    assert.ok(options.some((option) => option.kind === "question"));
    assert.ok(options.some((option) => option.kind === "orientation"));
    assert.ok(options.some((option) => option.kind === "conduct"));
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

test("adapts general-clinic reasoning and removes already used phrases", () => {
  const first = prioritizeQuickQuestions(
    "Clínica geral",
    "A dor no peito começou no esforço e veio com suor frio",
  );
  assert.ok(first.slice(0, 8).some((option) => option.clinicalPath === "Dor torácica e cardiovascular"));

  const usedText = first[0].text;
  const next = prioritizeQuickQuestions(
    "Clínica geral",
    "A dor no peito começou no esforço e veio com suor frio",
    [usedText],
  );
  assert.ok(!next.some((option) => option.text === usedText));
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
