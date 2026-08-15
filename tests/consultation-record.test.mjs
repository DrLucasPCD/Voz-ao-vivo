import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClinicalRecord,
  classifyDoctorUtterance,
  clinicalRecordTemplateForSpecialty,
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

test("selects the specialty-specific clinical record model", () => {
  assert.equal(clinicalRecordTemplateForSpecialty("Psiquiatria"), "psychiatry");
  assert.equal(clinicalRecordTemplateForSpecialty("Pediatria"), "child");
  assert.equal(clinicalRecordTemplateForSpecialty("Ginecologia"), "woman");
  assert.equal(clinicalRecordTemplateForSpecialty("Saúde do adolescente"), "adolescent");
  assert.equal(clinicalRecordTemplateForSpecialty("Geriatria"), "older-adult");
  assert.equal(clinicalRecordTemplateForSpecialty("Cardiologia"), "general");

  const psychiatry = buildClinicalRecord(
    [turn("1", "patient", "Estou triste e não consigo dormir.", "information", "00")],
    "Psiquiatria",
  );
  assert.match(psychiatry, /EXAME DO ESTADO MENTAL/);
  assert.match(psychiatry, /AVALIAÇÃO DE RISCO/);
  assert.match(psychiatry, /COMPETÊNCIAS DESENVOLVIDAS/);

  const adolescent = buildClinicalRecord(
    [turn("1", "patient", "Estou sofrendo bullying na escola.", "information", "00")],
    "Saúde do adolescente",
  );
  assert.match(adolescent, /TRIAGEM PSICOSSOCIAL SSHADESS/);
});
