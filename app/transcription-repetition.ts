const normalizeToken = (token: string) =>
  token
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]/g, "");

const normalizedWords = (value: string) =>
  value
    .trim()
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean);

const sameBlock = (
  normalized: string[],
  firstStart: number,
  secondStart: number,
  blockSize: number,
) => {
  for (let offset = 0; offset < blockSize; offset += 1) {
    if (normalized[firstStart + offset] !== normalized[secondStart + offset]) {
      return false;
    }
  }
  return true;
};

/**
 * Remove loops típicos do reconhecimento contínuo, como uma palavra ou um
 * pequeno trecho repetido três ou mais vezes. Duas repetições são mantidas
 * porque podem ser intencionais (por exemplo: "não, não").
 */
export function collapseRecognitionRepetitions(value: string) {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return tokens.join(" ");

  const normalized = tokens.map(normalizeToken);
  const output: string[] = [];
  let index = 0;

  while (index < tokens.length) {
    let collapsed = false;
    const maxBlockSize = Math.min(8, Math.floor((tokens.length - index) / 3));

    for (let blockSize = 1; blockSize <= maxBlockSize; blockSize += 1) {
      if (normalized.slice(index, index + blockSize).some((token) => !token)) {
        continue;
      }

      let repeatCount = 1;
      while (
        index + (repeatCount + 1) * blockSize <= tokens.length &&
        sameBlock(normalized, index, index + repeatCount * blockSize, blockSize)
      ) {
        repeatCount += 1;
      }

      if (repeatCount >= 3) {
        output.push(...tokens.slice(index, index + blockSize));
        index += repeatCount * blockSize;
        collapsed = true;
        break;
      }
    }

    if (!collapsed) {
      output.push(tokens[index]);
      index += 1;
    }
  }

  return output.join(" ").replace(/\s+([,.;!?])/g, "$1").trim();
}

/** Junta um novo resultado do navegador sem anexar novamente o mesmo final. */
export function appendRecognitionResult(current: string, incoming: string) {
  const previous = collapseRecognitionRepetitions(current);
  const next = collapseRecognitionRepetitions(incoming);
  if (!previous) return next;
  if (!next) return previous;

  const previousWords = normalizedWords(previous);
  const nextWords = normalizedWords(next);
  const previousKey = previousWords.join(" ");
  const nextKey = nextWords.join(" ");

  if (!nextKey || previousKey === nextKey || previousKey.endsWith(` ${nextKey}`)) {
    return previous;
  }
  if (nextKey.startsWith(`${previousKey} `)) {
    return next;
  }

  return collapseRecognitionRepetitions(`${previous} ${next}`);
}
