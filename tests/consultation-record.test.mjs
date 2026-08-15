import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClinicalRecord,
  classifyDoctorUtterance,
} from "../app/consultation-record.ts";

const turn = (id, speaker, text, kind, minute) => ({
  id,
  speaker,
  text,
  kind,
  source: "microphone",
  createdAt: `2026-08-15T10:${minute}:00.000Z`,
});

test("classifies questions, orientations, and conducts", () => {
  assert.equal(classifyDoctorUtterance("Há quanto tempo começou?"), "question");
  assert.equal(classifyDoctorUtterance("É importante retornar se piorar."), "orientation");
  assert.equal(classifyDoctorUtterance("Vou realizar o exame físico."), "conduct");
});

test("builds a reviewable record without inventing missing data", () => {
  const record = buildClinicalRecord(
    [
      turn("1", "doctor", "O que você está sentindo?", "question", "00"),
      turn("2", "patient", "Estou com dor no peito há dois dias.", "information", "01"),
      turn("3", "doctor", "Agora vou conferir seus sinais vitais.", "conduct", "02"),
      turn("4", "doctor", "Procure atendimento imediatamente se houver piora.", "orientation", "03"),
    ],
    "Clínica geral",
  );

  assert.match(record, /dor no peito há dois dias/i);
  assert.match(record, /conferir seus sinais vitais/i);
  assert.match(record, /procure atendimento imediatamente/i);
  assert.match(record, /Não informado na conversa/);
  assert.match(record, /RASCUNHO PARA REVISÃO/);
  assert.match(record, /REGISTRO CRONOLÓGICO DA CONVERSA/);
});
