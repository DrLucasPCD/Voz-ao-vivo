import { jsPDF } from "jspdf";
import {
  CLINICAL_RECORD_TEMPLATE_LABELS,
  clinicalRecordTemplateForSpecialty,
} from "./consultation-record.ts";

type PdfSection = {
  heading: string;
  paragraphs: string[];
};

const PAGE_WIDTH = 210;
const MARGIN_X = 16;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;
const HEADER_BOTTOM = 33;
const FOOTER_TOP = 283;

function pdfSafeText(value: string) {
  return value
    .replace(/[–—]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/•/g, "-")
    .replace(/…/g, "...")
    .replace(/\u00a0/g, " ")
    .trim();
}

function looksLikeHeading(line: string) {
  const clean = line.trim();
  if (!clean || clean.length > 120 || clean.startsWith("-") || clean.includes(":")) {
    return false;
  }
  const letters = clean.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, "");
  return letters.length >= 4 && clean === clean.toLocaleUpperCase("pt-BR");
}

export function parseClinicalRecordSections(recordText: string) {
  const lines = recordText.split(/\r?\n/).map(pdfSafeText);
  const title = lines.find(Boolean) || "PRONTUÁRIO DA CONSULTA";
  const sections: PdfSection[] = [];
  let current: PdfSection = { heading: "DADOS DO ATENDIMENTO", paragraphs: [] };

  lines.slice(lines.indexOf(title) + 1).forEach((line) => {
    if (!line) return;
    if (looksLikeHeading(line)) {
      if (current.paragraphs.length) sections.push(current);
      current = { heading: line, paragraphs: [] };
    } else {
      current.paragraphs.push(line);
    }
  });
  if (current.paragraphs.length || !sections.length) sections.push(current);

  return { title, sections };
}

export function createClinicalRecordPdfDocument(
  recordText: string,
  specialty: string,
  generatedAt = new Date(),
) {
  const template = clinicalRecordTemplateForSpecialty(specialty);
  const templateLabel = CLINICAL_RECORD_TEMPLATE_LABELS[template];
  const { title, sections } = parseClinicalRecordSections(recordText);
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
  let y = HEADER_BOTTOM + 7;

  const drawPageHeader = () => {
    doc.setFillColor(22, 75, 65);
    doc.rect(0, 0, PAGE_WIDTH, 21, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("CLARA - PRONTUÁRIO ASSISTIDO", MARGIN_X, 9);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.text(pdfSafeText(templateLabel), MARGIN_X, 15);
    doc.setTextColor(27, 43, 39);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text(pdfSafeText(specialty), MARGIN_X, 27);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(90, 104, 99);
    doc.text(
      generatedAt.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }),
      PAGE_WIDTH - MARGIN_X,
      27,
      { align: "right" },
    );
    doc.setDrawColor(196, 211, 205);
    doc.line(MARGIN_X, 31, PAGE_WIDTH - MARGIN_X, 31);
  };

  const addPage = () => {
    doc.addPage();
    drawPageHeader();
    y = HEADER_BOTTOM + 7;
  };

  const ensureSpace = (height: number) => {
    if (y + height > FOOTER_TOP) addPage();
  };

  const drawHeading = (heading: string) => {
    ensureSpace(13);
    doc.setFillColor(229, 241, 236);
    doc.roundedRect(MARGIN_X, y - 4.5, CONTENT_WIDTH, 8, 1.2, 1.2, "F");
    doc.setTextColor(22, 75, 65);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8.5);
    doc.text(pdfSafeText(heading), MARGIN_X + 3, y + 0.6);
    y += 8;
  };

  const drawParagraph = (paragraph: string) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.2);
    doc.setTextColor(35, 49, 45);
    const isListItem = paragraph.startsWith("-");
    const left = MARGIN_X + (isListItem ? 4 : 1.5);
    const width = CONTENT_WIDTH - (isListItem ? 5.5 : 3);
    const normalized = isListItem ? paragraph.slice(1).trim() : paragraph;
    const wrapped = doc.splitTextToSize(normalized || "Não informado.", width) as string[];
    const height = Math.max(5, wrapped.length * 4.2 + 1.5);
    ensureSpace(height);
    if (isListItem) {
      doc.setFillColor(22, 75, 65);
      doc.circle(MARGIN_X + 1.2, y - 1.1, 0.65, "F");
    }
    doc.text(wrapped, left, y);
    y += height;
  };

  drawPageHeader();
  doc.setTextColor(27, 43, 39);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  const titleLines = doc.splitTextToSize(pdfSafeText(title), CONTENT_WIDTH) as string[];
  doc.text(titleLines, MARGIN_X, y);
  y += titleLines.length * 5.5 + 4;

  sections.forEach((section) => {
    drawHeading(section.heading);
    section.paragraphs.forEach(drawParagraph);
    y += 1.5;
  });

  const totalPages = doc.getNumberOfPages();
  for (let page = 1; page <= totalPages; page += 1) {
    doc.setPage(page);
    // Reaplica o cabeçalho ao final para garantir o fundo colorido em todas as
    // páginas, inclusive nas criadas durante a quebra automática de conteúdo.
    drawPageHeader();
    doc.setDrawColor(210, 219, 215);
    doc.line(MARGIN_X, FOOTER_TOP, PAGE_WIDTH - MARGIN_X, FOOTER_TOP);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(103, 117, 112);
    doc.text(
      "Rascunho local. Revise com a preceptoria antes do registro oficial.",
      MARGIN_X,
      288,
    );
    doc.text(`Página ${page} de ${totalPages}`, PAGE_WIDTH - MARGIN_X, 288, {
      align: "right",
    });
  }

  return doc;
}

function filenamePart(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

export function downloadClinicalRecordPdf(recordText: string, specialty: string) {
  const generatedAt = new Date();
  const doc = createClinicalRecordPdfDocument(recordText, specialty, generatedAt);
  const day = generatedAt.toISOString().slice(0, 10);
  const filename = `prontuario-${filenamePart(specialty)}-${day}.pdf`;
  const blob = doc.output("blob");
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return filename;
}
