"use client";

import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  CircleStop,
  Cloud,
  Database,
  Download,
  FileAudio,
  Headphones,
  LogIn,
  LogOut,
  Mic,
  Pause,
  Play,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  Volume2,
  WandSparkles,
} from "lucide-react";
import { strToU8, zipSync } from "fflate";
import {
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type AuthProvider,
  type User,
} from "firebase/auth";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CLINICAL_PHRASES,
  CLINICAL_SPECIALTIES,
  phrasesForSpecialty,
} from "./clinical-phrases";
import {
  deleteCloudVoiceSample,
  downloadVoiceSample,
  loadCloudCorrections,
  saveCloudCorrections,
  subscribeToVoiceSamples,
  uploadVoiceSample,
  type CloudVoiceSample,
} from "./cloud-voice-profile";
import {
  appleAuthProvider,
  appleSignInEnabled,
  firebaseAuth,
  googleAuthProvider,
} from "./firebase";

type RecognitionAlternative = { transcript: string; confidence: number };

type RecognitionResult = {
  isFinal: boolean;
  length: number;
  [index: number]: RecognitionAlternative;
};

type RecognitionResultEvent = Event & {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
};

type RecognitionErrorEvent = Event & { error: string };

type BrowserRecognitionPhrase = { phrase: string; boost: number };

type BrowserRecognition = EventTarget & {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  phrases?: BrowserRecognitionPhrase[];
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
};

type BrowserRecognitionConstructor = new () => BrowserRecognition;

declare global {
  interface Window {
    SpeechRecognition?: BrowserRecognitionConstructor;
    webkitSpeechRecognition?: BrowserRecognitionConstructor;
    SpeechRecognitionPhrase?: new (
      phrase: string,
      boost?: number,
    ) => BrowserRecognitionPhrase;
  }
}

type Correction = {
  heard: string;
  intended: string;
  createdAt: string;
};

type TrainingSample = {
  id?: number;
  phrase: string;
  blob?: Blob;
  mimeType: string;
  createdAt: string;
  source?: "guided" | "correction";
  heard?: string;
  durationMs?: number;
  cloudId?: string;
  storagePath?: string;
  synced?: boolean;
};

const GENERAL_QUICK_PHRASES = [
  "Qual é o principal motivo da consulta de hoje?",
  "Quando esse sintoma começou?",
  "Quais medicamentos você usa atualmente?",
  "Você tem alergia a algum medicamento, alimento ou substância?",
];

const normalize = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

function levenshtein(a: string, b: string) {
  const matrix = Array.from({ length: b.length + 1 }, () =>
    Array(a.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i += 1) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j += 1) matrix[j][0] = j;
  for (let j = 1; j <= b.length; j += 1) {
    for (let i = 1; i <= a.length; i += 1) {
      matrix[j][i] = Math.min(
        matrix[j - 1][i] + 1,
        matrix[j][i - 1] + 1,
        matrix[j - 1][i - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return matrix[b.length][a.length];
}

function similarity(a: string, b: string) {
  const left = normalize(a);
  const right = normalize(b);
  const longest = Math.max(left.length, right.length);
  if (!longest) return 1;
  return 1 - levenshtein(left, right) / longest;
}

function bestRecognitionAlternative(
  result: RecognitionResult,
  contextualPhrases: string[],
) {
  const alternatives = Array.from(
    { length: Math.min(result.length, 5) },
    (_, index) => result[index],
  ).filter(Boolean);
  if (!alternatives.length) return "";

  return alternatives.reduce((best, alternative) => {
    const contextScore = contextualPhrases.reduce(
      (highest, phrase) =>
        Math.max(highest, similarity(alternative.transcript, phrase)),
      0,
    );
    const bestContextScore = contextualPhrases.reduce(
      (highest, phrase) =>
        Math.max(highest, similarity(best.transcript, phrase)),
      0,
    );
    const score = contextScore * 0.78 + alternative.confidence * 0.22;
    const bestScore = bestContextScore * 0.78 + best.confidence * 0.22;
    return score > bestScore ? alternative : best;
  }).transcript;
}

function applyLearnedCorrection(
  value: string,
  corrections: Correction[],
  trainedPhrases: string[] = [],
) {
  let best: Correction | undefined;
  let bestScore = 0;
  corrections.forEach((correction) => {
    const score = similarity(value, correction.heard);
    if (score > bestScore) {
      best = correction;
      bestScore = score;
    }
  });
  if (best && bestScore >= 0.84) return best.intended;

  let closestPhrase = "";
  let phraseScore = 0;
  trainedPhrases.forEach((phrase) => {
    const score = similarity(value, phrase);
    if (score > phraseScore) {
      closestPhrase = phrase;
      phraseScore = score;
    }
  });
  return closestPhrase && phraseScore >= 0.72 ? closestPhrase : value;
}

function openTrainingDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("clara-voice-training", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("samples")) {
        db.createObjectStore("samples", { keyPath: "id", autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeTrainingSample(sample: TrainingSample) {
  const db = await openTrainingDatabase();
  const id = await new Promise<number>((resolve, reject) => {
    const transaction = db.transaction("samples", "readwrite");
    const request = transaction.objectStore("samples").add(sample);
    request.onsuccess = () => resolve(request.result as number);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return { ...sample, id };
}

async function getTrainingSamples() {
  const db = await openTrainingDatabase();
  const samples = await new Promise<TrainingSample[]>((resolve, reject) => {
    const request = db.transaction("samples", "readonly").objectStore("samples").getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return samples.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function updateTrainingSample(sample: TrainingSample) {
  if (sample.id === undefined) return;
  const db = await openTrainingDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("samples", "readwrite");
    transaction.objectStore("samples").put(sample);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function removeTrainingSample(id: number) {
  const db = await openTrainingDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("samples", "readwrite");
    transaction.objectStore("samples").delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

function mergeTrainingSamples(
  existing: TrainingSample[],
  remote: CloudVoiceSample[],
) {
  const byCloudId = new Map<string, TrainingSample>();
  const localOnly: TrainingSample[] = [];

  existing.forEach((sample) => {
    if (sample.cloudId) byCloudId.set(sample.cloudId, sample);
    else if (sample.id !== undefined) localOnly.push(sample);
  });

  remote.forEach((sample) => {
    const local = byCloudId.get(sample.cloudId);
    byCloudId.set(sample.cloudId, { ...sample, ...local, synced: true });
  });

  return [...byCloudId.values(), ...localOnly].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

function mergeCorrections(local: Correction[], remote: Correction[]) {
  const merged = new Map<string, Correction>();
  [...remote, ...local].forEach((correction) => {
    merged.set(normalize(correction.heard), correction);
  });
  return [...merged.values()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

export function VoiceApp() {
  const [mode, setMode] = useState<"talk" | "train">("talk");
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [syncStatus, setSyncStatus] = useState<
    "local" | "syncing" | "synced" | "error"
  >("local");
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [rawTranscript, setRawTranscript] = useState("");
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [message, setMessage] = useState("Pronto para ouvir");
  const [error, setError] = useState("");
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [cloudRecognition, setCloudRecognition] = useState(false);
  const [transcriptionSource, setTranscriptionSource] = useState<
    "browser" | "cloud" | "voice-profile"
  >("browser");
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [correctionSaved, setCorrectionSaved] = useState(false);
  const recognitionRef = useRef<BrowserRecognition | null>(null);
  const latestFinalRef = useRef("");
  const autoSpeakRef = useRef(false);
  const conversationRecorderRef = useRef<MediaRecorder | null>(null);
  const conversationChunksRef = useRef<Blob[]>([]);
  const conversationStreamRef = useRef<MediaStream | null>(null);
  const conversationStartedAtRef = useRef(0);
  const pendingCorrectionDurationMsRef = useRef(0);
  const [pendingCorrectionAudio, setPendingCorrectionAudio] = useState<Blob | null>(null);
  const [isPreparingCorrectionAudio, setIsPreparingCorrectionAudio] = useState(false);

  const [selectedSpecialty, setSelectedSpecialty] = useState("Clínica geral");
  const [promptIndex, setPromptIndex] = useState(0);
  const [trainingPhrase, setTrainingPhrase] = useState(CLINICAL_PHRASES[0].text);
  const [isRecording, setIsRecording] = useState(false);
  const [trainingCount, setTrainingCount] = useState(0);
  const [trainingSamples, setTrainingSamples] = useState<TrainingSample[]>([]);
  const [isExporting, setIsExporting] = useState(false);
  const [latestRecordingUrl, setLatestRecordingUrl] = useState("");
  const [trainingMessage, setTrainingMessage] = useState("Leia a frase no seu ritmo");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const trainingStartedAtRef = useRef(0);

  useEffect(() => {
    return onAuthStateChanged(firebaseAuth, (currentUser) => {
      setUser(currentUser);
      setAuthReady(true);
      setSyncStatus(currentUser ? "syncing" : "local");
    });
  }, []);

  useEffect(() => {
    void getRedirectResult(firebaseAuth).catch(() => {
      setError("Não consegui concluir o login. Tente entrar novamente.");
    });
  }, []);

  useEffect(() => {
    const savedCorrections = localStorage.getItem("clara-corrections");
    const savedAutoSpeak = localStorage.getItem("clara-auto-speak") === "true";
    const savedCloudRecognition =
      localStorage.getItem("clara-cloud-recognition") === "true";
    const savedSpecialty = localStorage.getItem("clara-specialty");
    window.setTimeout(() => {
      if (savedCorrections) {
        try {
          setCorrections(JSON.parse(savedCorrections));
        } catch {
          localStorage.removeItem("clara-corrections");
        }
      }
      setAutoSpeak(savedAutoSpeak);
      autoSpeakRef.current = savedAutoSpeak;
      setCloudRecognition(savedCloudRecognition);
      if (savedSpecialty && CLINICAL_SPECIALTIES.includes(savedSpecialty)) {
        const savedPhrases = phrasesForSpecialty(savedSpecialty);
        setSelectedSpecialty(savedSpecialty);
        setPromptIndex(0);
        setTrainingPhrase(savedPhrases[0].text);
      }
    }, 0);
    getTrainingSamples()
      .then((samples) => {
        setTrainingSamples(samples);
        setTrainingCount(samples.length);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!user) return;
    let active = true;

    const unsubscribe = subscribeToVoiceSamples(
      user.uid,
      (remoteSamples) => {
        if (!active) return;
        setTrainingSamples((existing) => {
          const merged = mergeTrainingSamples(existing, remoteSamples);
          setTrainingCount(merged.length);
          return merged;
        });
        setSyncStatus("synced");
      },
      () => {
        if (active) setSyncStatus("error");
      },
    );

    const hydrateCloudProfile = async () => {
      try {
        const savedCorrections = localStorage.getItem("clara-corrections");
        const localCorrections = savedCorrections
          ? (JSON.parse(savedCorrections) as Correction[])
          : [];
        const remoteCorrections = await loadCloudCorrections(user.uid);
        const mergedCorrections = mergeCorrections(
          localCorrections,
          remoteCorrections,
        );
        if (!active) return;
        setCorrections(mergedCorrections);
        localStorage.setItem(
          "clara-corrections",
          JSON.stringify(mergedCorrections),
        );
        await saveCloudCorrections(user.uid, mergedCorrections);

        const localSamples = await getTrainingSamples();
        for (const sample of localSamples) {
          if (!active || sample.cloudId || !sample.blob) continue;
          const cloudSample = await uploadVoiceSample(user.uid, {
            phrase: sample.phrase,
            heard: sample.heard,
            blob: sample.blob,
            mimeType: sample.mimeType,
            createdAt: sample.createdAt,
            durationMs: sample.durationMs,
            source: sample.source ?? "guided",
          });
          const updated = { ...sample, ...cloudSample };
          await updateTrainingSample(updated);
          setTrainingSamples((samples) =>
            samples.map((item) =>
              item.id === updated.id ? updated : item,
            ),
          );
        }
        if (active) setSyncStatus("synced");
      } catch {
        if (active) setSyncStatus("error");
      }
    };

    void hydrateCloudProfile();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [user]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      conversationStreamRef.current?.getTracks().forEach((track) => track.stop());
      window.speechSynthesis?.cancel();
      if (latestRecordingUrl) URL.revokeObjectURL(latestRecordingUrl);
    };
  }, [latestRecordingUrl]);

  const specialtyPhrases = phrasesForSpecialty(selectedSpecialty);
  const quickPhrases =
    selectedSpecialty === "Clínica geral"
      ? GENERAL_QUICK_PHRASES
      : specialtyPhrases.slice(0, 4).map((phrase) => phrase.text);
  const recognitionVocabulary = Array.from(
    new Set([
      ...specialtyPhrases.map((phrase) => phrase.text),
      ...trainingSamples.map((sample) => sample.phrase.trim()).filter(Boolean),
      ...corrections.map((correction) => correction.intended.trim()),
    ]),
  );
  const hasVoiceReference = trainingSamples.some(
    (sample) =>
      sample.durationMs !== undefined &&
      sample.durationMs >= 2000 &&
      sample.durationMs <= 10000 &&
      Boolean(sample.blob || sample.storagePath),
  );

  const handleSignIn = async (
    provider: AuthProvider,
    providerName: "Google" | "Apple",
  ) => {
    setError("");
    try {
      const prefersRedirect =
        window.matchMedia("(max-width: 767px)").matches ||
        /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

      if (prefersRedirect) {
        await signInWithRedirect(firebaseAuth, provider);
        return;
      }

      await signInWithPopup(firebaseAuth, provider);
    } catch (signInError) {
      const code =
        typeof signInError === "object" && signInError && "code" in signInError
          ? String(signInError.code)
          : "";
      if (
        code === "auth/popup-blocked" ||
        code === "auth/operation-not-supported-in-this-environment"
      ) {
        await signInWithRedirect(firebaseAuth, provider);
      } else if (code === "auth/operation-not-allowed") {
        setError(
          `O login com ${providerName} ainda precisa ser ativado no Firebase.`,
        );
      } else if (code !== "auth/popup-closed-by-user") {
        setError(`Não consegui entrar com ${providerName}. Tente novamente.`);
      }
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(firebaseAuth);
      const localSamples = await getTrainingSamples();
      setTrainingSamples(localSamples);
      setTrainingCount(localSamples.length);
      setSyncStatus("local");
    } catch {
      setError("Não consegui sair da conta. Tente novamente.");
    }
  };

  const syncTrainingSample = async (sample: TrainingSample) => {
    if (!user || !sample.blob || sample.cloudId) return sample;
    setSyncStatus("syncing");
    try {
      const cloudSample = await uploadVoiceSample(user.uid, {
        phrase: sample.phrase,
        heard: sample.heard,
        blob: sample.blob,
        mimeType: sample.mimeType,
        createdAt: sample.createdAt,
        durationMs: sample.durationMs,
        source: sample.source ?? "guided",
      });
      const updated = { ...sample, ...cloudSample };
      await updateTrainingSample(updated);
      setTrainingSamples((samples) =>
        mergeTrainingSamples(
          samples.map((item) =>
            item.id === updated.id ? updated : item,
          ),
          [cloudSample],
        ),
      );
      setSyncStatus("synced");
      return updated;
    } catch {
      setSyncStatus("error");
      return sample;
    }
  };

  const requestPersonalizedTranscription = async (audioBlob: Blob) => {
    if (!user) throw new Error("Entre na sua conta para usar a nuvem.");

    const referenceSample = trainingSamples.find(
      (sample) =>
        sample.durationMs !== undefined &&
        sample.durationMs >= 2000 &&
        sample.durationMs <= 10000 &&
        Boolean(sample.blob || sample.storagePath),
    );
    let referenceBlob: Blob | null = null;
    if (referenceSample?.blob) referenceBlob = referenceSample.blob;
    else if (referenceSample?.storagePath) {
      try {
        referenceBlob = await downloadVoiceSample(referenceSample.storagePath);
      } catch {
        referenceBlob = null;
      }
    }

    const token = await user.getIdToken();
    const body = new FormData();
    const audioExtension = audioBlob.type.includes("ogg") ? "ogg" : "webm";
    body.append(
      "audio",
      new File([audioBlob], `fala.${audioExtension}`, {
        type: audioBlob.type || "audio/webm",
      }),
    );
    body.append("specialty", selectedSpecialty);
    body.append(
      "vocabulary",
      JSON.stringify(recognitionVocabulary.slice(0, 60)),
    );
    body.append(
      "corrections",
      JSON.stringify(
        corrections.slice(-50).map((correction) => correction.intended),
      ),
    );
    if (referenceBlob) {
      const extension = referenceBlob.type.includes("ogg") ? "ogg" : "webm";
      body.append(
        "voiceReference",
        new File([referenceBlob], `referencia.${extension}`, {
          type: referenceBlob.type || "audio/webm",
        }),
      );
    }

    const response = await fetch("/.netlify/functions/transcribe", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body,
    });
    const payload = (await response.json().catch(() => ({}))) as {
      text?: string;
      error?: string;
      usedVoiceReference?: boolean;
    };
    if (!response.ok || !payload.text) {
      throw new Error(
        payload.error ?? "A transcrição em nuvem não está disponível.",
      );
    }
    return {
      text: payload.text,
      usedVoiceReference: Boolean(payload.usedVoiceReference),
    };
  };

  const speak = useCallback((text: string) => {
    if (!text.trim() || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text.trim());
    const voices = window.speechSynthesis.getVoices();
    utterance.voice =
      voices.find((voice) => voice.lang.toLowerCase() === "pt-br") ??
      voices.find((voice) => voice.lang.toLowerCase().startsWith("pt")) ??
      null;
    utterance.lang = "pt-BR";
    utterance.rate = 0.92;
    utterance.pitch = 1;
    utterance.onstart = () => {
      setIsSpeaking(true);
      setMessage("Falando em voz clara");
    };
    utterance.onend = () => {
      setIsSpeaking(false);
      setMessage("Pronto para ouvir");
    };
    utterance.onerror = () => {
      setIsSpeaking(false);
      setMessage("Não consegui reproduzir o áudio");
    };
    window.speechSynthesis.speak(utterance);
  }, []);

  const stopSpeaking = () => {
    window.speechSynthesis?.cancel();
    setIsSpeaking(false);
    setMessage("Pronto para ouvir");
  };

  const startListening = async () => {
    setError("");
    setCorrectionSaved(false);
    setPendingCorrectionAudio(null);
    pendingCorrectionDurationMsRef.current = 0;
    setIsPreparingCorrectionAudio(false);
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    const cloudEnabledForTurn = cloudRecognition && Boolean(user);
    if (!Recognition && !cloudEnabledForTurn) {
      setError("O reconhecimento de voz ainda não funciona neste navegador. Abra o app no Chrome ou Edge.");
      return;
    }

    window.speechSynthesis?.cancel();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      conversationStreamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      conversationRecorderRef.current = recorder;
      conversationChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) conversationChunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        const durationMs = Math.max(
          0,
          new Date().getTime() - conversationStartedAtRef.current,
        );
        if (conversationChunksRef.current.length) {
          const recordedAudio = new Blob(conversationChunksRef.current, {
            type: recorder.mimeType,
          });
          setPendingCorrectionAudio(recordedAudio);
          pendingCorrectionDurationMsRef.current = durationMs;

          if (cloudEnabledForTurn) {
            setMessage("Aprimorando com seu perfil de voz…");
            try {
              const cloudResult =
                await requestPersonalizedTranscription(recordedAudio);
              const cloudText = cloudResult.text.trim();
              const corrected = applyLearnedCorrection(
                cloudText,
                corrections,
                recognitionVocabulary,
              );
              latestFinalRef.current = cloudText;
              setRawTranscript(cloudText);
              setTranscript(corrected);
              setTranscriptionSource(
                cloudResult.usedVoiceReference ? "voice-profile" : "cloud",
              );
              setError("");
              setMessage(
                cloudResult.usedVoiceReference
                  ? "Reconhecida com sua referência de voz"
                  : "Reconhecida pela nuvem clínica",
              );
              if (autoSpeakRef.current) speak(corrected);
            } catch (cloudError) {
              const cloudMessage =
                cloudError instanceof Error
                  ? cloudError.message
                  : "A nuvem não está disponível.";
              setTranscriptionSource("browser");
              setError(`${cloudMessage} Mantive o resultado do navegador.`);
              setMessage(
                latestFinalRef.current
                  ? "Frase reconhecida pelo navegador"
                  : "Não consegui entender esta fala",
              );
              if (autoSpeakRef.current && latestFinalRef.current) {
                speak(
                  applyLearnedCorrection(
                    latestFinalRef.current,
                    corrections,
                    recognitionVocabulary,
                  ),
                );
              }
            }
          }
        }
        stream.getTracks().forEach((track) => track.stop());
        conversationStreamRef.current = null;
        setIsPreparingCorrectionAudio(false);
      };
      conversationStartedAtRef.current = new Date().getTime();
      recorder.start();
    } catch {
      setError("Não consegui acessar o microfone. Verifique a permissão do navegador.");
      return;
    }

    if (!Recognition) {
      recognitionRef.current = null;
      setIsListening(true);
      setMessage("Estou ouvindo você pela nuvem…");
      return;
    }

    const recognition = new Recognition();
    recognition.lang = "pt-BR";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 5;
    const RecognitionPhrase = window.SpeechRecognitionPhrase;
    if (RecognitionPhrase && "phrases" in recognition) {
      try {
        recognition.phrases = recognitionVocabulary
          .slice(0, 60)
          .map((phrase) => new RecognitionPhrase(phrase, 5));
      } catch {
        // Contextual biasing is experimental; the alternatives below remain active.
      }
    }
    latestFinalRef.current = "";

    recognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) {
          finalText += bestRecognitionAlternative(
            result,
            recognitionVocabulary,
          );
        }
        else interimText += result[0].transcript;
      }
      setInterimTranscript(interimText);
      if (finalText.trim()) {
        const cleanText = finalText.trim();
        latestFinalRef.current = cleanText;
        setTranscriptionSource("browser");
        setRawTranscript(cleanText);
        setTranscript(
          applyLearnedCorrection(
            cleanText,
            corrections,
            recognitionVocabulary,
          ),
        );
      }
    };

    recognition.onerror = (event) => {
      const messages: Record<string, string> = {
        "not-allowed": "Permita o acesso ao microfone para eu ouvir você.",
        "audio-capture": "Não encontrei um microfone disponível.",
        "no-speech": "Não ouvi uma frase. Vamos tentar novamente?",
        network: "A conexão falhou durante o reconhecimento. Tente novamente.",
      };
      if (cloudEnabledForTurn) {
        setError("");
        setMessage("O navegador não entendeu; tentando seu perfil na nuvem…");
      } else {
        setError(messages[event.error] ?? "Não consegui entender desta vez. Tente novamente.");
        setMessage("Pronto para tentar novamente");
      }
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
      setInterimTranscript("");
      setMessage(
        cloudEnabledForTurn
          ? "Preparando transcrição personalizada…"
          : latestFinalRef.current
            ? "Frase reconhecida"
            : "Pronto para ouvir",
      );
      if (conversationRecorderRef.current?.state === "recording") {
        setIsPreparingCorrectionAudio(true);
        conversationRecorderRef.current.stop();
      }
      if (!cloudEnabledForTurn && autoSpeakRef.current && latestFinalRef.current) {
        const corrected = applyLearnedCorrection(
          latestFinalRef.current,
          corrections,
          recognitionVocabulary,
        );
        window.setTimeout(() => speak(corrected), 180);
      }
    };

    recognitionRef.current = recognition;
    setIsListening(true);
    setMessage("Estou ouvindo você…");
    try {
      recognition.start();
    } catch {
      if (conversationRecorderRef.current?.state === "recording") {
        conversationRecorderRef.current.stop();
      }
      setIsListening(false);
      setError("Não consegui iniciar a escuta. Tente novamente.");
    }
  };

  const stopListening = () => {
    recognitionRef.current?.stop();
    if (
      !recognitionRef.current &&
      conversationRecorderRef.current?.state === "recording"
    ) {
      setIsPreparingCorrectionAudio(true);
      conversationRecorderRef.current.stop();
    }
    setIsListening(false);
  };

  const saveCorrection = async () => {
    if (!rawTranscript.trim() || !transcript.trim() || normalize(rawTranscript) === normalize(transcript)) return;
    const createdAt = new Date().toISOString();
    const next = [
      ...corrections.filter((item) => normalize(item.heard) !== normalize(rawTranscript)),
      { heard: rawTranscript.trim(), intended: transcript.trim(), createdAt },
    ];
    setCorrections(next);
    localStorage.setItem("clara-corrections", JSON.stringify(next));

    if (user) {
      setSyncStatus("syncing");
      try {
        await saveCloudCorrections(user.uid, next);
        setSyncStatus("synced");
      } catch {
        setSyncStatus("error");
      }
    }

    if (pendingCorrectionAudio) {
      const saved = await storeTrainingSample({
        phrase: transcript.trim(),
        heard: rawTranscript.trim(),
        blob: pendingCorrectionAudio,
        mimeType: pendingCorrectionAudio.type,
        createdAt,
        durationMs: pendingCorrectionDurationMsRef.current,
        source: "correction",
      });
      setTrainingSamples((samples) => [saved, ...samples]);
      setTrainingCount((count) => count + 1);
      setPendingCorrectionAudio(null);
      void syncTrainingSample(saved);
    }
    setCorrectionSaved(true);
    setMessage(
      pendingCorrectionAudio
        ? "Correção e áudio adicionados ao seu perfil de voz"
        : "Correção aprendida neste dispositivo",
    );
  };

  const clearPhrase = () => {
    setTranscript("");
    setRawTranscript("");
    setInterimTranscript("");
    setCorrectionSaved(false);
    setError("");
    setMessage("Pronto para ouvir");
    setTranscriptionSource("browser");
  };

  const toggleAutoSpeak = () => {
    const next = !autoSpeak;
    setAutoSpeak(next);
    autoSpeakRef.current = next;
    localStorage.setItem("clara-auto-speak", String(next));
  };

  const toggleCloudRecognition = () => {
    if (!user) {
      setError("Entre na sua conta antes de ativar o reconhecimento personalizado.");
      return;
    }
    const next = !cloudRecognition;
    setCloudRecognition(next);
    localStorage.setItem("clara-cloud-recognition", String(next));
    setError("");
    setMessage(
      next
        ? "Reconhecimento personalizado ativado"
        : "Reconhecimento do navegador ativado",
    );
  };

  const playQuickPhrase = (phrase: string) => {
    setRawTranscript("");
    setTranscript(phrase);
    speak(phrase);
  };

  const selectSpecialty = (specialtyName: string) => {
    const nextPhrases = phrasesForSpecialty(specialtyName);
    setSelectedSpecialty(specialtyName);
    setPromptIndex(0);
    setTrainingPhrase(nextPhrases[0].text);
    setTrainingMessage("Leia a frase no seu ritmo");
    localStorage.setItem("clara-specialty", specialtyName);
  };

  const nextTrainingPhrase = () => {
    const next = (promptIndex + 1) % specialtyPhrases.length;
    setPromptIndex(next);
    setTrainingPhrase(specialtyPhrases[next].text);
    setTrainingMessage("Leia a frase no seu ritmo");
  };

  const startTrainingRecording = async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recordingChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) recordingChunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType });
        const durationMs = Math.max(
          0,
          new Date().getTime() - trainingStartedAtRef.current,
        );
        const saved = await storeTrainingSample({
          phrase: trainingPhrase.trim(),
          blob,
          mimeType: recorder.mimeType,
          createdAt: new Date().toISOString(),
          durationMs,
          source: "guided",
        });
        if (latestRecordingUrl) URL.revokeObjectURL(latestRecordingUrl);
        setLatestRecordingUrl(URL.createObjectURL(blob));
        setTrainingSamples((samples) => [saved, ...samples]);
        setTrainingCount((count) => count + 1);
        setTrainingMessage(
          user
            ? "Amostra salva; sincronizando com sua conta…"
            : "Amostra salva com segurança neste dispositivo",
        );
        void syncTrainingSample(saved);
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      };
      trainingStartedAtRef.current = new Date().getTime();
      recorder.start();
      setIsRecording(true);
      setTrainingMessage("Gravando sua voz…");
    } catch {
      setError("Não consegui acessar o microfone. Verifique a permissão do navegador.");
    }
  };

  const stopTrainingRecording = () => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    setIsRecording(false);
  };

  const playTrainingSample = async (sample: TrainingSample) => {
    try {
      const blob =
        sample.blob ??
        (sample.storagePath
          ? await downloadVoiceSample(sample.storagePath)
          : null);
      if (!blob) throw new Error("Amostra sem áudio");
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      audio.onerror = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch {
      setError("Não consegui carregar esta amostra de voz.");
    }
  };

  const deleteTrainingSample = async (sample: TrainingSample) => {
    try {
      if (sample.cloudId && sample.storagePath && user) {
        setSyncStatus("syncing");
        await deleteCloudVoiceSample(user.uid, {
          cloudId: sample.cloudId,
          storagePath: sample.storagePath,
        });
      }
      if (sample.id !== undefined) await removeTrainingSample(sample.id);
      setTrainingSamples((samples) => {
        const next = samples.filter((item) =>
          sample.cloudId
            ? item.cloudId !== sample.cloudId
            : item.id !== sample.id,
        );
        setTrainingCount(next.length);
        return next;
      });
      setSyncStatus(user ? "synced" : "local");
      setTrainingMessage("Amostra removida do seu perfil");
    } catch {
      setSyncStatus("error");
      setError("Não consegui remover esta amostra. Tente novamente.");
    }
  };

  const exportVoiceProfile = async () => {
    if (!trainingSamples.length) return;
    setIsExporting(true);
    try {
      const files: Record<string, Uint8Array> = {};
      const manifest = [];
      for (let index = 0; index < trainingSamples.length; index += 1) {
        const sample = trainingSamples[index];
        const blob =
          sample.blob ??
          (sample.storagePath
            ? await downloadVoiceSample(sample.storagePath)
            : null);
        if (!blob) continue;
        const extension = sample.mimeType.includes("ogg") ? "ogg" : "webm";
        const fileName = `audios/amostra-${String(index + 1).padStart(3, "0")}.${extension}`;
        files[fileName] = new Uint8Array(await blob.arrayBuffer());
        manifest.push({
          audio: fileName,
          texto_correto: sample.phrase,
          reconhecido_como: sample.heard ?? null,
          origem: sample.source ?? "guided",
          gravado_em: sample.createdAt,
          tipo_audio: sample.mimeType,
        });
      }
      files["manifesto.json"] = strToU8(
        JSON.stringify(
          {
            formato: "clara-voice-profile-v1",
            idioma: "pt-BR",
            total_amostras: manifest.length,
            correcoes_textuais: corrections,
            amostras: manifest,
          },
          null,
          2,
        ),
      );
      const archive = zipSync(files, { level: 6 });
      const archiveBuffer = archive.buffer.slice(
        archive.byteOffset,
        archive.byteOffset + archive.byteLength,
      ) as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([archiveBuffer], { type: "application/zip" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `perfil-de-voz-clara-${new Date().toISOString().slice(0, 10)}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
      setTrainingMessage("Perfil de voz exportado com sucesso");
    } finally {
      setIsExporting(false);
    }
  };

  const hasCorrection =
    rawTranscript.trim() && transcript.trim() && normalize(rawTranscript) !== normalize(transcript);

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#inicio" aria-label="Clara, página inicial">
          <span className="brand-mark" aria-hidden="true"><Volume2 size={22} /></span>
          <span>clara</span>
        </a>
        <nav className="mode-switch" aria-label="Modos do aplicativo">
          <button className={mode === "talk" ? "active" : ""} onClick={() => setMode("talk")}>
            <Mic size={17} /> Conversar
          </button>
          <button className={mode === "train" ? "active" : ""} onClick={() => setMode("train")}>
            <BookOpen size={17} /> Treinar minha voz
          </button>
        </nav>
        <div className="account-area">
          {user ? (
            <>
              <div className={`sync-badge ${syncStatus}`} title={user.email ?? "Conta conectada"}>
                {syncStatus === "syncing" ? <RefreshCw size={15} /> : <Cloud size={15} />}
                <span>
                  {syncStatus === "syncing"
                    ? "Sincronizando…"
                    : syncStatus === "error"
                      ? "Falha ao sincronizar"
                      : "Perfil sincronizado"}
                </span>
              </div>
              <button className="account-button subtle" onClick={handleSignOut} aria-label="Sair da conta">
                <LogOut size={16} /> Sair
              </button>
            </>
          ) : (
            <div className="signin-buttons" aria-label="Opções de login">
              <button
                className="account-button"
                onClick={() => handleSignIn(googleAuthProvider, "Google")}
                disabled={!authReady}
              >
                <LogIn size={16} /> {authReady ? "Entrar com Google" : "Carregando…"}
              </button>
              {appleSignInEnabled ? (
                <button
                  className="account-button apple"
                  onClick={() => handleSignIn(appleAuthProvider, "Apple")}
                  disabled={!authReady}
                >
                  <LogIn size={16} /> Entrar com Apple
                </button>
              ) : null}
            </div>
          )}
        </div>
      </header>

      <main id="inicio">
        {mode === "talk" ? (
          <>
            <section className="hero">
              <div>
                <p className="eyebrow"><Sparkles size={16} /> Consulta médica assistida</p>
                <h1>Sua voz conduz<br /><em>a consulta.</em></h1>
              </div>
              <p className="hero-copy">
                Faça suas perguntas ao paciente do seu jeito. A Clara escuta, aprende com suas correções e reproduz sua fala com clareza.
              </p>
            </section>

            <section className="clinical-context" aria-label="Contexto clínico do reconhecimento">
              <div>
                <label htmlFor="talk-specialty">Especialidade desta consulta</label>
                <span>Ajuda o reconhecimento a priorizar perguntas e termos da área.</span>
              </div>
              <select
                id="talk-specialty"
                value={selectedSpecialty}
                onChange={(event) => selectSpecialty(event.target.value)}
                disabled={isListening}
              >
                {CLINICAL_SPECIALTIES.map((specialtyName) => (
                  <option key={specialtyName} value={specialtyName}>{specialtyName}</option>
                ))}
              </select>
            </section>

            <section className="talk-grid" aria-label="Área principal de conversa">
              <article className={`listen-card ${isListening ? "listening" : ""}`}>
                <div className="status-line">
                  <span className={`status-dot ${isListening ? "live" : ""}`} />
                  <span aria-live="polite">{message}</span>
                  {(corrections.length > 0 || trainingCount > 0) && (
                    <span className="learned-count"><WandSparkles size={14} /> perfil adaptativo ativo</span>
                  )}
                </div>

                <button
                  className={`mic-button ${isListening ? "recording" : ""}`}
                  onClick={isListening ? stopListening : startListening}
                  aria-label={isListening ? "Parar de ouvir" : "Começar a ouvir"}
                >
                  <span className="mic-ripple ripple-one" />
                  <span className="mic-ripple ripple-two" />
                  {isListening ? <CircleStop size={50} strokeWidth={1.5} /> : <Mic size={50} strokeWidth={1.5} />}
                </button>
                <div className="mic-instruction">
                  <strong>{isListening ? "Pode falar. Estou ouvindo." : "Toque para começar a falar"}</strong>
                  <span>{isListening ? "Toque novamente quando terminar" : "Fale naturalmente, no seu ritmo"}</span>
                </div>
              </article>

              <article className="message-card">
                <div className="message-header">
                  <div>
                    <span className="section-label">Sua pergunta ao paciente</span>
                    <span className="section-hint">Corrija o texto antes de reproduzir durante a consulta</span>
                    {transcript && (
                      <span className={`transcription-source ${transcriptionSource}`}>
                        {transcriptionSource === "voice-profile"
                          ? "Perfil de voz personalizado"
                          : transcriptionSource === "cloud"
                            ? "Nuvem clínica"
                            : "Reconhecimento do navegador"}
                      </span>
                    )}
                  </div>
                  {(transcript || interimTranscript) && (
                    <button className="icon-button" onClick={clearPhrase} aria-label="Limpar frase"><Trash2 size={18} /></button>
                  )}
                </div>

                <div className="transcript-wrap">
                  <textarea
                    value={transcript}
                    onChange={(event) => {
                      setTranscript(event.target.value);
                      setCorrectionSaved(false);
                    }}
                    placeholder={interimTranscript || "Sua pergunta aparecerá aqui…"}
                    aria-label="Mensagem reconhecida, editável"
                  />
                  {isListening && interimTranscript && <p className="interim-text">Ouvindo: {interimTranscript}</p>}
                </div>

                {error && <div className="error-message" role="alert">{error}</div>}

                <div className="message-actions">
                  <button
                    className="primary-button"
                    onClick={isSpeaking ? stopSpeaking : () => speak(transcript)}
                    disabled={!transcript.trim()}
                  >
                    {isSpeaking ? <Pause size={20} /> : <Volume2 size={20} />}
                    {isSpeaking ? "Parar áudio" : "Falar em voz clara"}
                  </button>
                  {hasCorrection && (
                    <button className="secondary-button" onClick={saveCorrection} disabled={isPreparingCorrectionAudio}>
                      {correctionSaved ? <Check size={18} /> : <Save size={18} />}
                      {correctionSaved ? "Aprendido" : isPreparingCorrectionAudio ? "Preparando áudio…" : "Ensinar correção"}
                    </button>
                  )}
                </div>
                {hasCorrection && pendingCorrectionAudio && !correctionSaved && (
                  <p className="audio-learning-note">
                    <FileAudio size={14} /> Ao ensinar, a Clara guarda esta fala junto com o texto correto.
                  </p>
                )}
              </article>
            </section>

            <article className={`cloud-recognition-card ${cloudRecognition && user ? "active" : ""}`}>
              <div className="cloud-recognition-icon"><Cloud size={22} /></div>
              <div>
                <strong>Reconhecimento personalizado na nuvem</strong>
                <span>
                  {user
                    ? "Usa uma amostra curta da sua voz, suas correções e os termos da especialidade para melhorar a transcrição."
                    : "Entre na sua conta para usar seu perfil de voz sincronizado."}
                </span>
                <small>
                  {hasVoiceReference
                    ? "Sua referência curta de voz está pronta. "
                    : "Grave uma frase de 2 a 10 segundos para criar a referência de voz. "}
                  Quando ativado, sua fala é enviada à API da OpenAI. Evite falar dados identificáveis do paciente.
                </small>
              </div>
              <button
                className={`toggle ${cloudRecognition && user ? "on" : ""}`}
                onClick={toggleCloudRecognition}
                role="switch"
                aria-checked={Boolean(cloudRecognition && user)}
                aria-label="Ativar reconhecimento personalizado na nuvem"
                disabled={!user || isListening}
              ><span /></button>
            </article>

            <section className="lower-grid">
              <article className="quick-card">
                <div className="small-card-heading">
                  <span><Sparkles size={16} /> Perguntas rápidas</span>
                  <small>Um toque para perguntar</small>
                </div>
                <div className="quick-list">
                  {quickPhrases.map((phrase) => (
                    <button key={phrase} onClick={() => playQuickPhrase(phrase)}>{phrase}<Play size={14} fill="currentColor" /></button>
                  ))}
                </div>
              </article>

              <article className="auto-card">
                <div className="auto-icon"><Headphones size={22} /></div>
                <div>
                  <strong>Reprodução automática</strong>
                  <span>Fala a mensagem assim que você termina</span>
                </div>
                <button
                  className={`toggle ${autoSpeak ? "on" : ""}`}
                  onClick={toggleAutoSpeak}
                  role="switch"
                  aria-checked={autoSpeak}
                  aria-label="Ativar reprodução automática"
                ><span /></button>
              </article>
            </section>
          </>
        ) : (
          <section className="training-view">
            <div className="training-intro">
              <p className="eyebrow"><WandSparkles size={16} /> Treinamento clínico</p>
              <h1>Treine sua voz para<br /><em>conduzir consultas.</em></h1>
              <p>
                Grave perguntas que você usa na anamnese. Cada exemplo associa sua voz ao texto correto e fortalece seu perfil de reconhecimento clínico.
              </p>
              <p className="phrase-catalog-count">
                {CLINICAL_PHRASES.length} perguntas em {CLINICAL_SPECIALTIES.length} áreas clínicas para praticar no estágio.
              </p>
              <div className="training-progress">
                <strong>{trainingCount}</strong>
                <span>amostras {user ? "sincronizadas" : "salvas"}<br />{user ? "na sua conta" : "neste dispositivo"}</span>
              </div>
              <div className="profile-progress" aria-label={`${Math.min(trainingCount, 40)} de 40 amostras recomendadas`}>
                <div><span>Base inicial</span><strong>{Math.min(trainingCount, 40)}/40</strong></div>
                <span><i style={{ width: `${Math.min(100, (trainingCount / 40) * 100)}%` }} /></span>
                <small>{trainingCount < 40 ? `Grave mais ${40 - trainingCount} para formar uma boa base inicial.` : "Sua base inicial está completa. Continue corrigindo durante o uso."}</small>
              </div>
              <div className="privacy-box">
                {user ? <Cloud size={18} /> : <Check size={18} />}
                <span>
                  <strong>{user ? "Sincronização privada." : "Local por padrão."}</strong>{" "}
                  {user
                    ? "Suas amostras ficam protegidas pelo seu login e disponíveis nos seus dispositivos."
                    : "Entre na sua conta para acessar suas amostras em outros dispositivos."}
                </span>
              </div>
            </div>

            <article className={`training-card ${isRecording ? "recording" : ""}`}>
              <div className="specialty-field">
                <label htmlFor="training-specialty">Especialidade para treinar</label>
                <select
                  id="training-specialty"
                  value={selectedSpecialty}
                  onChange={(event) => selectSpecialty(event.target.value)}
                  disabled={isRecording}
                >
                  {CLINICAL_SPECIALTIES.map((specialtyName) => (
                    <option key={specialtyName} value={specialtyName}>{specialtyName}</option>
                  ))}
                </select>
              </div>
              <div className="step-heading">
                <span>Frase {promptIndex + 1} de {specialtyPhrases.length}</span>
                <button onClick={nextTrainingPhrase} disabled={isRecording}>Pular frase <ChevronRight size={16} /></button>
              </div>
              <div className="context-chip">Contexto: {specialtyPhrases[promptIndex].context}</div>
              <label htmlFor="training-phrase">Leia esta pergunta — ou escreva uma que você usa na consulta</label>
              <textarea
                id="training-phrase"
                value={trainingPhrase}
                onChange={(event) => setTrainingPhrase(event.target.value)}
                disabled={isRecording}
              />

              <div className="recording-area">
                <button
                  className={`training-mic ${isRecording ? "active" : ""}`}
                  onClick={isRecording ? stopTrainingRecording : startTrainingRecording}
                  disabled={!trainingPhrase.trim()}
                  aria-label={isRecording ? "Parar e salvar gravação" : "Gravar frase"}
                >
                  {isRecording ? <CircleStop size={32} /> : <Mic size={32} />}
                </button>
                <div>
                  <strong>{trainingMessage}</strong>
                  <span>{isRecording ? "Quando terminar, toque para salvar" : "Toque no microfone e fale naturalmente"}</span>
                </div>
              </div>

              {latestRecordingUrl && (
                <div className="saved-sample">
                  <div><Check size={18} /><span>Última amostra salva</span></div>
                  {/* A gravação é fala do próprio usuário; uma faixa de legendas não se aplica a esta prévia. */}
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <audio controls src={latestRecordingUrl} aria-label="Ouvir última amostra gravada" />
                </div>
              )}
              {error && <div className="error-message" role="alert">{error}</div>}
              <button className="next-button" onClick={nextTrainingPhrase} disabled={isRecording}>
                Próxima frase <ArrowRight size={18} />
              </button>
            </article>

            <article className="voice-library">
              <div className="library-heading">
                <div>
                  <span className="section-label"><Database size={17} /> Meu perfil de voz</span>
                  <p>Áudios rotulados que ajudam a Clara a adaptar frases conhecidas e preparam o treinamento do modelo personalizado.</p>
                </div>
                <button
                  className="export-button"
                  onClick={exportVoiceProfile}
                  disabled={!trainingSamples.length || isExporting}
                >
                  <Download size={18} /> {isExporting ? "Preparando…" : "Exportar base"}
                </button>
              </div>

              {trainingSamples.length ? (
                <div className="sample-list">
                  {trainingSamples.slice(0, 6).map((sample, index) => (
                    <div className="sample-row" key={sample.cloudId ?? sample.id ?? `${sample.createdAt}-${index}`}>
                      <button className="sample-play" onClick={() => playTrainingSample(sample)} aria-label={`Ouvir: ${sample.phrase}`}>
                        <Play size={15} fill="currentColor" />
                      </button>
                      <div>
                        <strong>{sample.phrase}</strong>
                        <span>
                          {sample.source === "correction" ? "Correção durante conversa" : "Treino guiado"}
                          {sample.heard ? ` • ouvido como “${sample.heard}”` : ""}
                          {sample.synced ? " • sincronizada" : user ? " • aguardando sincronização" : " • somente neste dispositivo"}
                        </span>
                      </div>
                      <time dateTime={sample.createdAt}>{new Date(sample.createdAt).toLocaleDateString("pt-BR")}</time>
                      <button className="sample-delete" onClick={() => deleteTrainingSample(sample)} aria-label={`Excluir amostra: ${sample.phrase}`}>
                        <Trash2 size={17} />
                      </button>
                    </div>
                  ))}
                  {trainingSamples.length > 6 && <p className="more-samples">+ {trainingSamples.length - 6} amostras guardadas no perfil exportado</p>}
                </div>
              ) : (
                <div className="empty-library"><FileAudio size={23} /><span>Suas gravações aparecerão aqui.</span></div>
              )}
            </article>
          </section>
        )}
      </main>

      <footer>
        <span>Clara — sua voz, mais clara.</span>
        <span>{user ? "Perfil protegido e sincronizado" : "Perfil adaptativo local"} • Português do Brasil</span>
      </footer>
    </div>
  );
}
