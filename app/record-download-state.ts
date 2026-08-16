type ArchivedConsultationTurn = {
  id: string;
  text: string;
  speaker: string;
  createdAt: string;
};

export const RECORD_PDF_CONFIRMATION_KEY = "clara-record-pdf-confirmation-v1";

export function consultationRecordSignature(
  specialty: string,
  turns: ArchivedConsultationTurn[],
) {
  const input = [
    specialty,
    ...turns.map(
      (turn) =>
        `${turn.id}|${turn.speaker}|${turn.createdAt}|${turn.text.trim()}`,
    ),
  ].join("\n");
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${turns.length}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function recordPdfWasConfirmed(
  storedSignature: string | null,
  currentSignature: string,
) {
  return Boolean(currentSignature && storedSignature === currentSignature);
}
