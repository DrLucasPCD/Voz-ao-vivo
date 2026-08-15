import assert from "node:assert/strict";
import test from "node:test";
import {
  createClinicalRecordPdfDocument,
  parseClinicalRecordSections,
} from "../app/clinical-record-pdf.ts";

const sample = `FICHA DE AVALIAÇÃO GERIÁTRICA AMPLA
Data/hora: 15/08/2026 10:30
Área selecionada: Geriatria

QUEIXA PRINCIPAL E HISTÓRIA ATUAL
- Teve duas quedas no último mês.

FUNCIONALIDADE - AIVD DE LAWTON E ABVD DE KATZ
- Precisa de ajuda para organizar medicamentos e finanças.

PLANO TERAPÊUTICO, CONDUTAS E ORIENTAÇÕES
- Vou discutir prevenção de quedas com a preceptoria.`;

test("parses and creates a local A4 specialty record PDF", () => {
  const parsed = parseClinicalRecordSections(sample);
  assert.equal(parsed.title, "FICHA DE AVALIAÇÃO GERIÁTRICA AMPLA");
  assert.ok(parsed.sections.some((section) => section.heading.includes("LAWTON")));

  const document = createClinicalRecordPdfDocument(
    sample,
    "Geriatria",
    new Date("2026-08-15T10:30:00-03:00"),
  );
  const bytes = new Uint8Array(document.output("arraybuffer"));
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "%PDF");
  assert.ok(bytes.byteLength > 2_000);
});
