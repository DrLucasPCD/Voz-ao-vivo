const WORD_PATTERN = /[\p{L}\p{M}\d]+(?:['’-][\p{L}\p{M}\d]+)*/gu;

const normalizeWord = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const levenshtein = (left: string, right: string) => {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = row[0];
    row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const previous = row[rightIndex];
      row[rightIndex] = Math.min(
        row[rightIndex] + 1,
        row[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      diagonal = previous;
    }
  }
  return row[right.length];
};

const wordSimilarity = (left: string, right: string) => {
  const normalizedLeft = normalizeWord(left);
  const normalizedRight = normalizeWord(right);
  const longest = Math.max(normalizedLeft.length, normalizedRight.length);
  if (!longest) return 1;
  return 1 - levenshtein(normalizedLeft, normalizedRight) / longest;
};

export function tokenizeTrainingPhrase(value: string) {
  return value.match(WORD_PATTERN) ?? [];
}

export function correctWithTrainedWords(value: string, trainedWords: string[]) {
  const vocabulary = Array.from(
    new Map(
      trainedWords
        .map((word) => word.trim())
        .filter(Boolean)
        .map((word) => [normalizeWord(word), word]),
    ).values(),
  );
  if (!vocabulary.length) return value;

  return value.replace(WORD_PATTERN, (heardWord) => {
    const normalizedHeard = normalizeWord(heardWord);
    const preserveCase = (word: string) =>
      /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/u.test(heardWord)
        ? `${word.charAt(0).toUpperCase()}${word.slice(1)}`
        : word.toLowerCase();
    const exactWord = vocabulary.find(
      (word) => normalizeWord(word) === normalizedHeard,
    );
    if (exactWord) return preserveCase(exactWord);
    let bestWord = "";
    let bestScore = 0;
    vocabulary.forEach((word) => {
      const normalizedCandidate = normalizeWord(word);
      if (Math.abs(normalizedCandidate.length - normalizedHeard.length) > 2) return;
      const score = wordSimilarity(normalizedHeard, normalizedCandidate);
      if (score > bestScore) {
        bestScore = score;
        bestWord = word;
      }
    });
    const threshold = normalizedHeard.length <= 3 ? 0.9 : 0.78;
    if (!bestWord || bestScore < threshold) return heardWord;
    return preserveCase(bestWord);
  });
}

export type RecognitionCandidate = {
  text: string;
  source: "browser" | "browser-context" | "local-whisper";
};

export function choosePersonalizedRecognition(
  candidates: RecognitionCandidate[],
  trainedWords: string[],
  contextualPhrases: string[],
) {
  const unique = Array.from(
    new Map(
      candidates
        .map((candidate) => ({ ...candidate, text: candidate.text.trim() }))
        .filter((candidate) => candidate.text)
        .map((candidate) => [normalizeWord(candidate.text), candidate]),
    ).values(),
  );
  if (!unique.length) return null;

  const normalizedVocabulary = trainedWords
    .map(normalizeWord)
    .filter(Boolean);
  const normalizedContexts = contextualPhrases
    .map((phrase) => normalizeWord(phrase.trim()))
    .filter(Boolean);
  const sourcePrior: Record<RecognitionCandidate["source"], number> = {
    "browser-context": 0.09,
    browser: 0.06,
    "local-whisper": 0,
  };

  return unique
    .map((candidate) => {
      const candidateWords = tokenizeTrainingPhrase(candidate.text);
      const wordSupport = candidateWords.length && normalizedVocabulary.length
        ? candidateWords.reduce((sum, word) => {
            const best = normalizedVocabulary.reduce(
              (highest, trained) =>
                Math.max(highest, wordSimilarity(word, trained)),
              0,
            );
            return sum + (best >= 0.68 ? best : 0);
          }, 0) / candidateWords.length
        : 0;
      const normalizedCandidate = normalizeWord(candidate.text);
      const contextSupport = normalizedContexts.reduce(
        (highest, context) =>
          Math.max(highest, wordSimilarity(normalizedCandidate, context)),
        0,
      );
      const score =
        contextSupport * 0.58 +
        wordSupport * 0.27 +
        sourcePrior[candidate.source] +
        Math.min(0.04, candidateWords.length * 0.006);
      return { ...candidate, score };
    })
    .sort((left, right) => right.score - left.score)[0];
}
