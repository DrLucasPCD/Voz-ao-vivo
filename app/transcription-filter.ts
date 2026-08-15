const NON_SPEECH_WORDS = new Set([
  "aplauso",
  "aplausos",
  "ambiente",
  "inaudivel",
  "music",
  "musica",
  "ruido",
  "ruidos",
  "silencio",
  "som",
]);

const normalizeMarker = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function isNonSpeechTranscript(value: string) {
  const normalized = normalizeMarker(value);
  if (!normalized) return true;
  const words = normalized.split(" ");
  return words.length <= 4 && words.every((word) => NON_SPEECH_WORDS.has(word));
}

export function isLocalDecodingFailure(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error && typeof error === "object" && "message" in error
          ? String(error.message)
          : "";
  const normalizedMessage = message.toLowerCase();
  return (
    normalizedMessage.includes("decoding failed") ||
    normalizedMessage.includes("decode failed")
  );
}
