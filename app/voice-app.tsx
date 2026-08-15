"use client";

import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  CircleStop,
  ClipboardCheck,
  ClipboardCopy,
  Cloud,
  Database,
  Download,
  FileAudio,
  FileText,
  Headphones,
  HardDriveDownload,
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
  WifiOff,
  X,
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
  classifyNonOwnerSpeech,
  prioritizeQuickQuestions,
  type QuickClinicalQuestion,
} from "./quick-clinical-questions";
import {
  buildClinicalRecord,
  classifyDoctorUtterance,
  type ConsultationSpeaker,
  type ConsultationTurn,
  type ConsultationUtteranceKind,
} from "./consultation-record";
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
  extractVoiceSignature,
  identifyEnrolledSpeaker,
  matchLocalVoiceProfile,
} from "./local-voice-matcher";
import {
  appleAuthProvider,
  appleSignInEnabled,
  firebaseAuth,
  googleAuthProvider,
} from "./firebase";
import {
  isPiperVoiceCached,
  PIPER_FIRST_USE_DOWNLOAD_MB,
  PIPER_MODEL_SIZE_MB,
  PIPER_VOICE_NAME,
  preparePiperVoice,
  synthesizeWithPiper,
  type PiperProgress,
} from "./piper-voice";
import {
  isLocalTranscriptionPrepared,
  LOCAL_TRANSCRIPTION_DOWNLOAD_MB,
  prepareLocalTranscription,
  transcribeLocally,
  type LocalTranscriptionProgress,
} from "./local-transcription";
import {
  cacheAppForOffline,
  isOfflineShellPrepared,
  registerOfflineServiceWorker,
} from "./offline-support";

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

type BrowserRecognition = EventTarget & {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
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
    webkitAudioContext?: typeof AudioContext;
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
  voiceSignature?: number[];
  speakerFingerprint?: number[];
  cloudId?: string;
  audioBytes?: CloudVoiceSample["audioBytes"];
  synced?: boolean;
  firestoreAudioSynced?: boolean;
};

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
    byCloudId.set(sample.cloudId, {
      ...sample,
      ...local,
      synced: true,
      firestoreAudioSynced: true,
    });
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

function removeLastMatchingTurn(turns: string[], text: string) {
  const index = turns.findLastIndex((turn) => normalize(turn) === normalize(text));
  return index < 0 ? turns : turns.filter((_, turnIndex) => turnIndex !== index);
}

function authFailureDetails(authFailure: unknown) {
  if (typeof authFailure === "string") {
    return { code: "", message: authFailure, name: "" };
  }
  if (!authFailure || typeof authFailure !== "object") {
    return { code: "", message: "", name: "" };
  }

  const candidate = authFailure as {
    code?: unknown;
    message?: unknown;
    name?: unknown;
  };
  return {
    code: typeof candidate.code === "string" ? candidate.code : "",
    message:
      typeof candidate.message === "string"
        ? candidate.message.replace(/\s+/g, " ").trim().slice(0, 220)
        : "",
    name: typeof candidate.name === "string" ? candidate.name : "",
  };
}

export function VoiceApp() {
  const [mode, setMode] = useState<"talk" | "train">("talk");
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState("");
  const [isSigningIn, setIsSigningIn] = useState(false);
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
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [piperStatus, setPiperStatus] = useState<
    "idle" | "downloading" | "ready" | "generating" | "fallback"
  >("idle");
  const [piperDownloadPercent, setPiperDownloadPercent] = useState(0);
  const [piperError, setPiperError] = useState("");
  const [isOnline, setIsOnline] = useState(true);
  const [localTranscriptionReady, setLocalTranscriptionReady] = useState(false);
  const [offlineStatus, setOfflineStatus] = useState<
    "idle" | "preparing" | "ready" | "error"
  >("idle");
  const [offlinePhase, setOfflinePhase] = useState("Preparação não iniciada");
  const [offlineProgress, setOfflineProgress] = useState(0);
  const [offlineError, setOfflineError] = useState("");
  const [patientTurns, setPatientTurns] = useState<string[]>([]);
  const [teamTurns, setTeamTurns] = useState<string[]>([]);
  const [lastDetectedSpeaker, setLastDetectedSpeaker] = useState<
    "doctor" | "patient" | "team" | null
  >(null);
  const [lastDetectedText, setLastDetectedText] = useState("");
  const [showAllQuickQuestions, setShowAllQuickQuestions] = useState(false);
  const [quickKindFilter, setQuickKindFilter] = useState<
    "all" | "question" | "orientation" | "conduct"
  >("all");
  const [consultationTurns, setConsultationTurns] = useState<ConsultationTurn[]>([]);
  const [consultationHydrated, setConsultationHydrated] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  const [recordText, setRecordText] = useState("");
  const [recordCopied, setRecordCopied] = useState(false);
  const [recordMessage, setRecordMessage] = useState("");
  const [transcriptionSource, setTranscriptionSource] = useState<
    "browser" | "voice-profile" | "local-whisper"
  >("browser");
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [correctionSaved, setCorrectionSaved] = useState(false);
  const recognitionRef = useRef<BrowserRecognition | null>(null);
  const latestFinalRef = useRef("");
  const latestContextualFinalRef = useRef("");
  const autoSpeakRef = useRef(true);
  const isAppSpeakingRef = useRef(false);
  const lastSynthesizedTextRef = useRef("");
  const synthesisEndedAtRef = useRef(0);
  const startListeningRef = useRef<(() => void) | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const activePiperAudioRef = useRef<HTMLAudioElement | null>(null);
  const activePiperAudioUrlRef = useRef("");
  const activeNativeUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const speechRequestRef = useRef(0);
  const conversationRecorderRef = useRef<MediaRecorder | null>(null);
  const conversationChunksRef = useRef<Blob[]>([]);
  const conversationStreamRef = useRef<MediaStream | null>(null);
  const conversationStartedAtRef = useRef(0);
  const conversationTimeoutRef = useRef<number | null>(null);
  const pendingCorrectionDurationMsRef = useRef(0);
  const [pendingCorrectionAudio, setPendingCorrectionAudio] = useState<Blob | null>(null);
  const [isPreparingCorrectionAudio, setIsPreparingCorrectionAudio] = useState(false);

  const addConsultationTurn = useCallback(
    (
      speaker: ConsultationSpeaker,
      text: string,
      source: ConsultationTurn["source"],
      kind?: ConsultationUtteranceKind,
    ) => {
      const cleanText = text.trim();
      if (!cleanText) return;
      const turn: ConsultationTurn = {
        id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
        speaker,
        text: cleanText,
        kind:
          kind ??
          (speaker === "doctor" ? classifyDoctorUtterance(cleanText) : "information"),
        createdAt: new Date().toISOString(),
        source,
      };
      setConsultationTurns((turns) => {
        const previous = turns.at(-1);
        if (
          previous?.speaker === turn.speaker &&
          normalize(previous.text) === normalize(turn.text)
        ) {
          return turns;
        }
        return [...turns, turn].slice(-250);
      });
    },
    [],
  );

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
    void getRedirectResult(firebaseAuth).catch(async (redirectError) => {
      await Promise.race([
        firebaseAuth.authStateReady(),
        new Promise((resolve) => window.setTimeout(resolve, 800)),
      ]);
      if (firebaseAuth.currentUser) return;

      const { code, message, name } = authFailureDetails(redirectError);
      console.error("[Clara: login redirecionado]", { code, message, name });
      if (code === "auth/unauthorized-domain") {
        setAuthError(
          `O Firebase ainda não autorizou ${window.location.hostname}. Adicione este domínio em Authentication → Settings → Authorized domains.`,
        );
      } else {
        setAuthError(
          `Não consegui concluir o login redirecionado.${code ? ` Código: ${code}.` : ""}${message ? ` Detalhe: ${message}` : " Tente novamente."}`,
        );
      }
    });
  }, []);

  useEffect(() => {
    const transcriptionPrepared = isLocalTranscriptionPrepared();
    const shellPrepared = isOfflineShellPrepared();
    window.setTimeout(() => {
      setIsOnline(navigator.onLine);
      setLocalTranscriptionReady(transcriptionPrepared);
    }, 0);
    void isPiperVoiceCached().then((piperPrepared) => {
      if (piperPrepared) setPiperStatus("ready");
      if (transcriptionPrepared && shellPrepared && piperPrepared) {
        setOfflineStatus("ready");
        setOfflineProgress(100);
        setOfflinePhase("App e reconhecimento disponíveis sem internet");
      }
    });

    void registerOfflineServiceWorker().catch(() => undefined);
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    const savedCorrections = localStorage.getItem("clara-corrections");
    const savedAutoSpeakSetting = localStorage.getItem("clara-auto-speak");
    const savedAutoSpeak = savedAutoSpeakSetting !== "false";
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
      if (savedSpecialty && CLINICAL_SPECIALTIES.includes(savedSpecialty)) {
        const savedPhrases = phrasesForSpecialty(savedSpecialty);
        setSelectedSpecialty(savedSpecialty);
        setPromptIndex(0);
        setTrainingPhrase(savedPhrases[0].text);
      }
    }, 0);
    getTrainingSamples()
      .then(async (samples) => {
        const upgraded: TrainingSample[] = [];
        for (const sample of samples) {
          if (
            sample.blob &&
            (!sample.voiceSignature?.length || !sample.speakerFingerprint?.length)
          ) {
            const signature = await extractVoiceSignature(sample.blob).catch(
              () => null,
            );
            if (signature) {
              const updated = {
                ...sample,
                durationMs: signature.durationMs,
                voiceSignature: signature.features,
                speakerFingerprint: signature.speakerFingerprint,
              };
              await updateTrainingSample(updated);
              upgraded.push(updated);
              continue;
            }
          }
          upgraded.push(sample);
        }
        setTrainingSamples(upgraded);
        setTrainingCount(upgraded.length);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const savedConsultation = localStorage.getItem("clara-active-consultation-v1");
    window.setTimeout(() => {
      if (savedConsultation) {
        try {
          const parsed = JSON.parse(savedConsultation) as ConsultationTurn[];
          if (Array.isArray(parsed)) {
            const validTurns = parsed.filter(
              (turn) =>
                turn &&
                typeof turn.id === "string" &&
                typeof turn.text === "string" &&
                ["doctor", "patient", "team"].includes(turn.speaker),
            );
            setConsultationTurns(validTurns.slice(-250));
            setPatientTurns(
              validTurns
                .filter((turn) => turn.speaker === "patient")
                .map((turn) => turn.text)
                .slice(-20),
            );
            setTeamTurns(
              validTurns
                .filter((turn) => turn.speaker === "team")
                .map((turn) => turn.text)
                .slice(-20),
            );
          }
        } catch {
          localStorage.removeItem("clara-active-consultation-v1");
        }
      }
      setConsultationHydrated(true);
    }, 0);
  }, []);

  useEffect(() => {
    if (!consultationHydrated) return;
    localStorage.setItem(
      "clara-active-consultation-v1",
      JSON.stringify(consultationTurns),
    );
  }, [consultationHydrated, consultationTurns]);

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
          if (!active || sample.firestoreAudioSynced || !sample.blob) continue;
          const cloudSample = await uploadVoiceSample(user.uid, {
            cloudId: sample.cloudId,
            phrase: sample.phrase,
            heard: sample.heard,
            blob: sample.blob,
            mimeType: sample.mimeType,
            createdAt: sample.createdAt,
            durationMs: sample.durationMs,
            voiceSignature: sample.voiceSignature,
            speakerFingerprint: sample.speakerFingerprint,
            source: sample.source ?? "guided",
          });
          const updated = {
            ...sample,
            cloudId: cloudSample.cloudId,
            synced: true,
            firestoreAudioSynced: true,
          };
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
      if (conversationTimeoutRef.current !== null) {
        window.clearTimeout(conversationTimeoutRef.current);
      }
      window.speechSynthesis?.cancel();
      activePiperAudioRef.current?.pause();
      if (activePiperAudioUrlRef.current) {
        URL.revokeObjectURL(activePiperAudioUrlRef.current);
      }
      void outputAudioContextRef.current?.close();
      if (latestRecordingUrl) URL.revokeObjectURL(latestRecordingUrl);
    };
  }, [latestRecordingUrl]);

  const specialtyPhrases = phrasesForSpecialty(selectedSpecialty);
  const patientContext = patientTurns.join(" ");
  const usedDoctorTexts = consultationTurns
    .filter((turn) => turn.speaker === "doctor")
    .map((turn) => turn.text);
  const prioritizedQuickQuestions = prioritizeQuickQuestions(
    selectedSpecialty,
    patientContext,
    usedDoctorTexts,
  );
  const filteredQuickQuestions =
    quickKindFilter === "all"
      ? prioritizedQuickQuestions
      : prioritizedQuickQuestions.filter(
          (question) => question.kind === quickKindFilter,
        );
  const visibleQuickQuestions = showAllQuickQuestions
    ? filteredQuickQuestions
    : filteredQuickQuestions.slice(0, 10);
  const recognitionVocabulary = Array.from(
    new Set([
      ...specialtyPhrases.map((phrase) => phrase.text),
      ...trainingSamples.map((sample) => sample.phrase.trim()).filter(Boolean),
      ...corrections.map((correction) => correction.intended.trim()),
    ]),
  );
  const localVoiceTemplateCount = trainingSamples.filter(
    (sample) => sample.voiceSignature?.length,
  ).length;

  const handleSignIn = async (
    provider: AuthProvider,
    providerName: "Google" | "Apple",
  ) => {
    setError("");
    setAuthError("");
    setIsSigningIn(true);
    const currentDomain = window.location.hostname;
    const showAuthFailure = (signInError: unknown) => {
      const { code, message, name } = authFailureDetails(signInError);
      console.error("[Clara: login]", { providerName, code, message, name });
      if (code === "auth/unauthorized-domain") {
        setAuthError(
          `O Firebase recusou ${currentDomain}. Adicione este domínio em Authentication → Settings → Authorized domains.`,
        );
      } else if (code === "auth/operation-not-allowed") {
        setAuthError(`O login com ${providerName} ainda precisa ser ativado no Firebase.`);
      } else if (code === "auth/popup-closed-by-user") {
        setAuthError(
          currentDomain === "voz-ao-vivo.netlify.app"
            ? "A janela do Google fechou sem concluir. Se apareceu Erro 400: redirect_uri_mismatch, adicione https://voz-ao-vivo.netlify.app/__/auth/handler em Google Cloud → Google Auth Platform → Clientes → URIs de redirecionamento autorizados."
            : `A janela de login foi fechada antes da conclusão. Confirme que ${currentDomain} está nos domínios autorizados do Firebase.`,
        );
      } else if (code === "auth/network-request-failed") {
        setAuthError("A conexão com o Google falhou. Verifique a internet e tente novamente.");
      } else if (code === "auth/web-storage-unsupported") {
        setAuthError(
          "O navegador bloqueou o armazenamento necessário para manter o login. Saia do modo privado ou permita os dados do site e tente novamente.",
        );
      } else if (code === "auth/account-exists-with-different-credential") {
        setAuthError(
          "Este e-mail já está associado a outro método de login no Firebase.",
        );
      } else if (name === "AuthFlowTimeout") {
        setAuthError(
          "A conta Google foi aberta, mas o aplicativo não recebeu a confirmação do login. Feche outras janelas de login e tente novamente. Se continuar, o retorno OAuth deste domínio ainda precisa ser liberado no Google Cloud.",
        );
      } else {
        const diagnostic = code
          ? `Código: ${code}.`
          : message
            ? `Detalhe: ${message}`
            : name
              ? `Detalhe: ${name}.`
              : "O navegador não informou o motivo.";
        setAuthError(`Não consegui entrar com ${providerName}. ${diagnostic}`);
      }
    };
    try {
      // Popup is also the safest option on mobile when the app is hosted outside
      // Firebase Hosting, because it does not depend on third-party storage.
      const credential = await Promise.race([
        signInWithPopup(firebaseAuth, provider),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => {
            const timeoutError = new Error(
              "A janela do Google fechou sem devolver a sessão ao aplicativo.",
            );
            timeoutError.name = "AuthFlowTimeout";
            reject(timeoutError);
          }, 25_000);
        }),
      ]);
      setUser(credential.user);
      setSyncStatus("syncing");
      setAuthError("");
    } catch (signInError) {
      await Promise.race([
        firebaseAuth.authStateReady(),
        new Promise((resolve) => window.setTimeout(resolve, 800)),
      ]);
      if (firebaseAuth.currentUser) {
        setAuthError("");
        return;
      }

      const { code } = authFailureDetails(signInError);
      if (
        code === "auth/popup-blocked" ||
        code === "auth/operation-not-supported-in-this-environment"
      ) {
        try {
          await signInWithRedirect(firebaseAuth, provider);
        } catch (redirectError) {
          showAuthFailure(redirectError);
        }
      } else showAuthFailure(signInError);
    } finally {
      setIsSigningIn(false);
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
    if (!user || !sample.blob || sample.firestoreAudioSynced) return sample;
    setSyncStatus("syncing");
    try {
      const cloudSample = await uploadVoiceSample(user.uid, {
        cloudId: sample.cloudId,
        phrase: sample.phrase,
        heard: sample.heard,
        blob: sample.blob,
        mimeType: sample.mimeType,
        createdAt: sample.createdAt,
        durationMs: sample.durationMs,
        voiceSignature: sample.voiceSignature,
        speakerFingerprint: sample.speakerFingerprint,
        source: sample.source ?? "guided",
      });
      const updated = {
        ...sample,
        cloudId: cloudSample.cloudId,
        synced: true,
        firestoreAudioSynced: true,
      };
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

  const updatePiperProgress = useCallback((progress: PiperProgress) => {
    if (progress.phase === "download") {
      const percent = progress.total
        ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
        : 0;
      setPiperStatus("downloading");
      setPiperDownloadPercent(percent);
      setMessage(
        percent
          ? `Baixando voz Faber… ${percent}%`
          : "Baixando voz Faber pela primeira vez…",
      );
    } else if (progress.phase === "generating") {
      setPiperStatus("generating");
      setMessage("Preparando áudio com a voz Faber…");
    } else {
      setPiperStatus("ready");
      setPiperDownloadPercent(100);
      setMessage("Voz Faber carregada neste dispositivo");
    }
  }, []);

  const ensureOutputAudioContext = useCallback(() => {
    const AudioContextConstructor =
      window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextConstructor) return null;
    if (!outputAudioContextRef.current || outputAudioContextRef.current.state === "closed") {
      outputAudioContextRef.current = new AudioContextConstructor();
    }
    return outputAudioContextRef.current;
  }, []);

  const unlockAudioOutput = useCallback(() => {
    const context = ensureOutputAudioContext();
    window.speechSynthesis?.resume();
    if (!context) return null;
    if (context.state === "suspended") void context.resume();
    try {
      const silentBuffer = context.createBuffer(1, 1, context.sampleRate || 22_050);
      const silentSource = context.createBufferSource();
      silentSource.buffer = silentBuffer;
      silentSource.connect(context.destination);
      silentSource.start(0);
    } catch {
      // O contexto ainda pode ser ativado normalmente sem a amostra silenciosa.
    }
    return context;
  }, [ensureOutputAudioContext]);

  const speak = useCallback(async (text: string, resumeListening = false) => {
    const phrase = text.trim();
    if (!phrase) return;
    const requestId = ++speechRequestRef.current;
    recognitionRef.current?.abort();
    if (conversationRecorderRef.current?.state === "recording") {
      conversationRecorderRef.current.stop();
    }
    window.speechSynthesis?.cancel();
    activePiperAudioRef.current?.pause();
    activePiperAudioRef.current = null;
    if (activePiperAudioUrlRef.current) {
      URL.revokeObjectURL(activePiperAudioUrlRef.current);
      activePiperAudioUrlRef.current = "";
    }
    const outputContext = unlockAudioOutput();
    isAppSpeakingRef.current = true;
    lastSynthesizedTextRef.current = phrase;
    setIsSpeaking(true);
    setPiperError("");

    const finish = (finalMessage = "Pronto para ouvir") => {
      if (requestId !== speechRequestRef.current) return;
      isAppSpeakingRef.current = false;
      synthesisEndedAtRef.current = Date.now();
      setIsSpeaking(false);
      setMessage(
        resumeListening
          ? "Áudio concluído; preparando escuta automática…"
          : finalMessage,
      );
      if (resumeListening) {
        window.setTimeout(() => startListeningRef.current?.(), 550);
      }
    };

    let nativeFallbackStarted = false;
    const playNativeFallback = (
      speakingMessage = "Falando com a voz do aparelho",
      markAsFallback = true,
    ) => {
      if (nativeFallbackStarted) return;
      nativeFallbackStarted = true;
      if (markAsFallback) setPiperStatus("fallback");
      if (!("speechSynthesis" in window)) {
        finish("A voz do navegador não está disponível; preparando o Piper para a próxima reprodução.");
        return;
      }
      const utterance = new SpeechSynthesisUtterance(phrase);
      const voices = window.speechSynthesis.getVoices();
      utterance.voice =
        voices.find((voice) => voice.lang.toLowerCase() === "pt-br") ??
        voices.find((voice) => voice.lang.toLowerCase().startsWith("pt")) ??
        null;
      utterance.lang = "pt-BR";
      utterance.rate = 0.92;
      utterance.pitch = 1;
      utterance.volume = 1;
      utterance.onstart = () => setMessage(speakingMessage);
      utterance.onend = () => {
        activeNativeUtteranceRef.current = null;
        finish();
      };
      utterance.onerror = () => {
        activeNativeUtteranceRef.current = null;
        finish("O navegador bloqueou o áudio. Toque em Testar áudio agora.");
      };
      activeNativeUtteranceRef.current = utterance;
      window.speechSynthesis.resume();
      window.speechSynthesis.speak(utterance);
    };

    if (piperStatus !== "ready") {
      playNativeFallback("Falando agora com a voz do aparelho", false);
      if (navigator.onLine && piperStatus !== "downloading" && piperStatus !== "generating") {
        setPiperStatus("downloading");
        setPiperDownloadPercent(0);
        void preparePiperVoice((progress) => {
          if (progress.phase === "download") {
            setPiperStatus("downloading");
            setPiperDownloadPercent(
              progress.total
                ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
                : 0,
            );
          }
        })
          .then(() => {
            setPiperStatus("ready");
            setPiperDownloadPercent(100);
          })
          .catch((preparationError) => {
            setPiperStatus("fallback");
            setPiperError(
              preparationError instanceof Error
                ? preparationError.message
                : "Não consegui preparar a voz Faber",
            );
          });
      }
      return;
    }

    try {
      const audioBlob = await synthesizeWithPiper(phrase, updatePiperProgress);
      if (requestId !== speechRequestRef.current) return;
      if (outputContext) {
        const decodedAudio = await outputContext.decodeAudioData(
          await audioBlob.arrayBuffer(),
        );
        if (requestId !== speechRequestRef.current) return;
        const samples = decodedAudio.getChannelData(0);
        let peak = 0;
        for (let index = 0; index < samples.length; index += 128) {
          peak = Math.max(peak, Math.abs(samples[index]));
        }
        if (peak < 0.0005) {
          throw new Error("A voz Faber gerou um áudio sem volume");
        }
      }
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      audio.preload = "auto";
      audio.volume = 1;
      activePiperAudioRef.current = audio;
      activePiperAudioUrlRef.current = audioUrl;
      const releaseAudio = () => {
        if (activePiperAudioRef.current === audio) {
          activePiperAudioRef.current = null;
        }
        if (activePiperAudioUrlRef.current === audioUrl) {
          URL.revokeObjectURL(audioUrl);
          activePiperAudioUrlRef.current = "";
        }
      };
      audio.onended = () => {
        releaseAudio();
        setPiperStatus("ready");
        finish();
      };
      audio.onplay = () => {
        setPiperStatus("ready");
        setMessage("Falando com a voz Faber");
      };
      audio.onerror = () => {
        releaseAudio();
        playNativeFallback("Falando com a voz do aparelho porque o Piper não tocou");
      };
      setMessage("Falando com a voz Faber");
      await audio.play();
    } catch (piperFailure) {
      if (requestId !== speechRequestRef.current) return;
      activePiperAudioRef.current?.pause();
      activePiperAudioRef.current = null;
      if (activePiperAudioUrlRef.current) {
        URL.revokeObjectURL(activePiperAudioUrlRef.current);
        activePiperAudioUrlRef.current = "";
      }
      setPiperError(
        piperFailure instanceof Error
          ? piperFailure.message
          : "A voz Faber não pôde ser carregada",
      );
      playNativeFallback();
    }
  }, [piperStatus, unlockAudioOutput, updatePiperProgress]);

  const prepareFaberVoice = async () => {
    setPiperError("");
    setPiperStatus("downloading");
    try {
      await preparePiperVoice(updatePiperProgress);
      setPiperStatus("ready");
      setPiperDownloadPercent(100);
      setMessage("Voz Faber pronta para a consulta");
    } catch (preparationError) {
      setPiperStatus("fallback");
      setPiperError(
        preparationError instanceof Error
          ? preparationError.message
          : "Não consegui baixar a voz Faber",
      );
    }
  };

  const updateOfflineTranscriptionProgress = (
    progress: LocalTranscriptionProgress,
  ) => {
    if (progress.phase === "transcribing") {
      setOfflinePhase("Reconhecendo a fala localmente…");
      return;
    }
    if (progress.phase === "download") {
      setOfflinePhase("Baixando o reconhecimento Whisper para este aparelho…");
      if (typeof progress.percent === "number") {
        const percent = progress.percent;
        setOfflineProgress((current) =>
          Math.max(current, 5 + Math.round(percent * 0.5)),
        );
      }
      return;
    }
    setOfflineProgress((current) => Math.max(current, 55));
  };

  const prepareCompleteOfflineMode = async () => {
    if (!navigator.onLine) {
      setOfflineStatus("error");
      setOfflineError(
        "Conecte-se à internet somente para a preparação inicial deste aparelho.",
      );
      return;
    }

    setOfflineStatus("preparing");
    setOfflineProgress(2);
    setOfflineError("");
    setOfflinePhase("Salvando as telas e perguntas no aparelho…");
    try {
      await cacheAppForOffline();
      setOfflineProgress(5);

      await prepareLocalTranscription(updateOfflineTranscriptionProgress);
      setLocalTranscriptionReady(true);
      setOfflineProgress((current) => Math.max(current, 55));

      setOfflinePhase("Baixando a voz Piper Faber para este aparelho…");
      await preparePiperVoice((progress) => {
        updatePiperProgress(progress);
        if (progress.phase === "download") {
          const isModel = progress.file?.endsWith(".onnx");
          if (isModel && progress.total) {
            setOfflineProgress((current) =>
              Math.max(
                current,
                55 + Math.round((progress.loaded / progress.total) * 44),
              ),
            );
          }
        }
      });

      setPiperStatus("ready");
      setPiperDownloadPercent(100);
      setOfflineProgress(100);
      setOfflineStatus("ready");
      setOfflinePhase("Tudo pronto para funcionar sem internet");
      localStorage.setItem("clara-offline-ready", "true");
      setMessage("Modo offline completo preparado neste dispositivo");
    } catch (preparationError) {
      setOfflineStatus("error");
      setOfflineError(
        preparationError instanceof Error
          ? preparationError.message
          : "Não consegui concluir a preparação offline",
      );
      setOfflinePhase("Preparação interrompida; toque para tentar novamente");
    }
  };

  const stopSpeaking = () => {
    speechRequestRef.current += 1;
    activePiperAudioRef.current?.pause();
    activePiperAudioRef.current = null;
    if (activePiperAudioUrlRef.current) {
      URL.revokeObjectURL(activePiperAudioUrlRef.current);
      activePiperAudioUrlRef.current = "";
    }
    window.speechSynthesis?.cancel();
    activeNativeUtteranceRef.current = null;
    isAppSpeakingRef.current = false;
    setIsSpeaking(false);
    setMessage("Pronto para ouvir");
  };

  const startListening = async () => {
    if (isAppSpeakingRef.current) return;
    unlockAudioOutput();
    setError("");
    setCorrectionSaved(false);
    setPendingCorrectionAudio(null);
    pendingCorrectionDurationMsRef.current = 0;
    setIsPreparingCorrectionAudio(false);
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    const useLocalRecognition = localTranscriptionReady;
    if (!navigator.onLine && !useLocalRecognition) {
      setError(
        "O reconhecimento offline ainda não foi preparado neste aparelho. Conecte-se e toque em Preparar uso offline.",
      );
      return;
    }
    if (!Recognition && !useLocalRecognition) {
      setError("O reconhecimento de voz ainda não funciona neste navegador. Abra o app no Chrome ou Edge.");
      return;
    }

    latestFinalRef.current = "";
    latestContextualFinalRef.current = "";

    window.speechSynthesis?.cancel();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      conversationStreamRef.current = stream;
      const recorder = new MediaRecorder(stream, { audioBitsPerSecond: 24000 });
      conversationRecorderRef.current = recorder;
      conversationChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) conversationChunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        if (conversationTimeoutRef.current !== null) {
          window.clearTimeout(conversationTimeoutRef.current);
          conversationTimeoutRef.current = null;
        }
        const durationMs = Math.max(
          0,
          new Date().getTime() - conversationStartedAtRef.current,
        );
        if (conversationChunksRef.current.length) {
          const recordedAudio = new Blob(conversationChunksRef.current, {
            type: recorder.mimeType,
          });
          let speakerIdentification = {
            ready: false,
            isOwner: true,
            confidence: 0,
            sampleCount: 0,
          };
          try {
            const currentSignature = await extractVoiceSignature(recordedAudio);
            speakerIdentification = identifyEnrolledSpeaker(
              currentSignature,
              trainingSamples,
            );
          } catch {
            // Sem assinatura válida, o turno permanece como fala do usuário.
          }

          let topTranscript = latestFinalRef.current.trim();
          let contextualTranscript = latestContextualFinalRef.current.trim();
          let usedLocalTranscription = false;

          if (localTranscriptionReady) {
            setMessage("Transcrevendo no próprio aparelho…");
            try {
              const localText = await transcribeLocally(
                recordedAudio,
                updateOfflineTranscriptionProgress,
              );
              if (localText) {
                topTranscript = localText;
                contextualTranscript = localText;
                usedLocalTranscription = true;
              }
            } catch (localError) {
              if (!navigator.onLine || !topTranscript) {
                setError(
                  localError instanceof Error
                    ? `Reconhecimento local: ${localError.message}`
                    : "Não consegui reconhecer a fala localmente",
                );
              }
            }
          }

          const looksLikeAppEcho =
            topTranscript &&
            Date.now() - synthesisEndedAtRef.current < 3500 &&
            similarity(topTranscript, lastSynthesizedTextRef.current) >= 0.86;
          if (looksLikeAppEcho) {
            setMessage("Áudio emitido pela própria Clara foi ignorado");
            stream.getTracks().forEach((track) => track.stop());
            conversationStreamRef.current = null;
            setIsPreparingCorrectionAudio(false);
            return;
          }
          if (speakerIdentification.ready && !speakerIdentification.isOwner) {
            setPendingCorrectionAudio(null);
            if (topTranscript) {
              const role = classifyNonOwnerSpeech(topTranscript);
              setLastDetectedSpeaker(role);
              setLastDetectedText(topTranscript);
              addConsultationTurn(role, topTranscript, "microphone");
              if (role === "patient") {
                setPatientTurns((turns) => [...turns, topTranscript].slice(-20));
              } else {
                setTeamTurns((turns) => [...turns, topTranscript].slice(-20));
              }
              setError("");
              setMessage(
                role === "patient"
                  ? "Paciente identificado; prioridades atualizadas"
                  : "Equipe ou preceptoria identificada",
              );
            } else {
              setLastDetectedSpeaker("patient");
              setLastDetectedText("");
              setMessage("Paciente identificado, mas não consegui transcrever a resposta");
            }
            stream.getTracks().forEach((track) => track.stop());
            conversationStreamRef.current = null;
            setIsPreparingCorrectionAudio(false);
            return;
          }

          setLastDetectedSpeaker("doctor");
          setLastDetectedText(
            contextualTranscript || topTranscript,
          );
          setPendingCorrectionAudio(recordedAudio);
          pendingCorrectionDurationMsRef.current = durationMs;

          let recognizedText =
            contextualTranscript || topTranscript;
          let finalText = recognizedText
            ? applyLearnedCorrection(
                recognizedText,
                corrections,
                recognitionVocabulary,
              )
            : "";
          let usedVoiceProfile = false;

          if (localVoiceTemplateCount > 0) {
            setMessage("Comparando com suas amostras de voz…");
            try {
              const match = await matchLocalVoiceProfile(
                recordedAudio,
                trainingSamples,
              );
              if (match) {
                const textSupport = recognizedText
                  ? similarity(recognizedText, match.phrase)
                  : 0;
                const examplesForPhrase = trainingSamples.filter(
                  (sample) => normalize(sample.phrase) === normalize(match.phrase),
                ).length;
                const supportedByText = match.score >= 0.82 && textSupport >= 0.38;
                const supportedByRepeatedVoice =
                  !recognizedText && match.score >= 0.94 && examplesForPhrase >= 2;
                if (supportedByText || supportedByRepeatedVoice) {
                  finalText = match.phrase;
                  usedVoiceProfile = true;
                }
              }
            } catch {
              // O reconhecimento do navegador e as correções continuam disponíveis.
            }
          }

          if (finalText) {
            if (!recognizedText) recognizedText = finalText;
            latestFinalRef.current = recognizedText;
            setRawTranscript(recognizedText);
            setTranscript(finalText);
            setTranscriptionSource(
              usedVoiceProfile
                ? "voice-profile"
                : usedLocalTranscription
                  ? "local-whisper"
                  : "browser",
            );
            setError("");
            setMessage(
              usedVoiceProfile
                ? "Frase reconhecida pelo seu perfil de voz local"
                : usedLocalTranscription
                  ? "Frase reconhecida pelo Whisper no aparelho"
                  : "Frase reconhecida gratuitamente",
            );
            addConsultationTurn("doctor", finalText, "microphone");
            if (autoSpeakRef.current) speak(finalText, true);
          } else {
            setMessage("Não consegui entender esta fala");
          }
        }
        stream.getTracks().forEach((track) => track.stop());
        conversationStreamRef.current = null;
        setIsPreparingCorrectionAudio(false);
      };
      conversationStartedAtRef.current = new Date().getTime();
      recorder.start();
      conversationTimeoutRef.current = window.setTimeout(() => {
        setMessage("Turno de 28 segundos concluído; processando a fala…");
        recognitionRef.current?.stop();
        if (recorder.state === "recording") recorder.stop();
        setIsListening(false);
      }, 28_000);
    } catch {
      setError("Não consegui acessar o microfone. Verifique a permissão do navegador.");
      return;
    }

    if (useLocalRecognition) {
      recognitionRef.current = null;
      setIsListening(true);
      setMessage("Ouvindo localmente; toque novamente quando terminar…");
      return;
    }

    if (!Recognition) {
      if (conversationRecorderRef.current?.state === "recording") {
        conversationRecorderRef.current.stop();
      }
      setError("O reconhecimento deste navegador não pôde ser iniciado.");
      return;
    }
    const recognition = new Recognition();
    recognition.lang = "pt-BR";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 5;
    recognition.onresult = (event) => {
      let topFinalText = "";
      let contextualFinalText = "";
      let interimText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) {
          topFinalText += result[0].transcript;
          contextualFinalText += bestRecognitionAlternative(
            result,
            recognitionVocabulary,
          );
        }
        else interimText += result[0].transcript;
      }
      setInterimTranscript(interimText);
      if (isAppSpeakingRef.current) return;
      if (topFinalText.trim()) latestFinalRef.current = topFinalText.trim();
      if (contextualFinalText.trim()) {
        latestContextualFinalRef.current = contextualFinalText.trim();
      }
    };

    recognition.onerror = (event) => {
      const messages: Record<string, string> = {
        "not-allowed": "Permita o acesso ao microfone para eu ouvir você.",
        "audio-capture": "Não encontrei um microfone disponível.",
        "no-speech": "Não ouvi uma frase. Vamos tentar novamente?",
        network: "A conexão falhou durante o reconhecimento. Tente novamente.",
      };
      setError(messages[event.error] ?? "Não consegui entender desta vez. Tente novamente.");
      setMessage(
        localVoiceTemplateCount
          ? "Tentando reconhecer pelas suas amostras…"
          : "Pronto para tentar novamente",
      );
      setIsListening(false);
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      setIsListening(false);
      setInterimTranscript("");
      setMessage(
        localVoiceTemplateCount
          ? "Analisando seu perfil de voz local…"
          : latestFinalRef.current
            ? "Frase reconhecida"
            : "Pronto para ouvir",
      );
      if (conversationRecorderRef.current?.state === "recording") {
        setIsPreparingCorrectionAudio(true);
        conversationRecorderRef.current.stop();
      }
    };

    recognitionRef.current = recognition;
    setIsListening(true);
    setMessage("Estou ouvindo e identificando o falante…");
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

  useEffect(() => {
    startListeningRef.current = startListening;
  });

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
      const signature = await extractVoiceSignature(pendingCorrectionAudio).catch(
        () => null,
      );
      const saved = await storeTrainingSample({
        phrase: transcript.trim(),
        heard: rawTranscript.trim(),
        blob: pendingCorrectionAudio,
        mimeType: pendingCorrectionAudio.type,
        createdAt,
        durationMs:
          signature?.durationMs ?? pendingCorrectionDurationMsRef.current,
        ...(signature ? { voiceSignature: signature.features } : {}),
        ...(signature
          ? { speakerFingerprint: signature.speakerFingerprint }
          : {}),
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

  const relabelLastSpeaker = (role: "doctor" | "patient" | "team") => {
    const text = lastDetectedText.trim();
    if (!text || role === lastDetectedSpeaker) return;

    setPatientTurns((turns) => removeLastMatchingTurn(turns, text));
    setTeamTurns((turns) => removeLastMatchingTurn(turns, text));
    setConsultationTurns((turns) => {
      const matchingIndex = turns.findLastIndex(
        (turn) => normalize(turn.text) === normalize(text),
      );
      if (matchingIndex < 0) return turns;
      return turns.map((turn, index) =>
        index === matchingIndex
          ? {
              ...turn,
              speaker: role,
              kind:
                role === "doctor"
                  ? classifyDoctorUtterance(turn.text)
                  : "information",
            }
          : turn,
      );
    });
    if (role === "patient") {
      setPatientTurns((turns) => [...turns, text].slice(-20));
      if (lastDetectedSpeaker === "doctor" && normalize(rawTranscript) === normalize(text)) {
        clearPhrase();
      }
      setMessage("Turno corrigido para paciente; prioridades atualizadas");
    } else if (role === "team") {
      setTeamTurns((turns) => [...turns, text].slice(-20));
      if (lastDetectedSpeaker === "doctor" && normalize(rawTranscript) === normalize(text)) {
        clearPhrase();
      }
      setMessage("Turno corrigido para equipe ou preceptoria");
    } else {
      setRawTranscript(text);
      setTranscript(applyLearnedCorrection(text, corrections, recognitionVocabulary));
      setTranscriptionSource("browser");
      setMessage("Turno corrigido para sua fala");
      if (autoSpeakRef.current) {
        speak(applyLearnedCorrection(text, corrections, recognitionVocabulary), true);
      }
    }
    setLastDetectedSpeaker(role);
  };

  const toggleAutoSpeak = () => {
    const next = !autoSpeak;
    setAutoSpeak(next);
    autoSpeakRef.current = next;
    localStorage.setItem("clara-auto-speak", String(next));
  };

  const playQuickPhrase = (question: QuickClinicalQuestion) => {
    const phrase = question.text;
    setRawTranscript("");
    setTranscript(phrase);
    setLastDetectedSpeaker("doctor");
    setLastDetectedText(phrase);
    addConsultationTurn(
      "doctor",
      phrase,
      "quick-action",
      question.kind,
    );
    speak(phrase, true);
  };

  const speakTypedPhrase = () => {
    const phrase = transcript.trim();
    if (!phrase) return;
    setLastDetectedSpeaker("doctor");
    setLastDetectedText(phrase);
    addConsultationTurn("doctor", phrase, "typed");
    speak(phrase, true);
  };

  const finishConsultation = () => {
    setRecordText(buildClinicalRecord(consultationTurns, selectedSpecialty));
    setRecordCopied(false);
    setRecordMessage("");
    setRecordOpen(true);
  };

  const copyClinicalRecord = async () => {
    try {
      await navigator.clipboard.writeText(recordText);
      setRecordCopied(true);
      setRecordMessage("Prontuário copiado. Revise antes de salvar no sistema oficial.");
    } catch {
      setRecordMessage("Não consegui copiar automaticamente. Selecione o texto e copie manualmente.");
    }
  };

  const clearConsultationAfterCopy = () => {
    if (!recordCopied) return;
    const confirmed = window.confirm(
      "Confirma que o prontuário já foi copiado? Todo o histórico desta consulta será apagado deste dispositivo.",
    );
    if (!confirmed) return;
    setConsultationTurns([]);
    setPatientTurns([]);
    setTeamTurns([]);
    setLastDetectedSpeaker(null);
    setLastDetectedText("");
    setRecordText("");
    setRecordCopied(false);
    setRecordMessage("");
    setRecordOpen(false);
    clearPhrase();
    localStorage.removeItem("clara-active-consultation-v1");
  };

  const selectSpecialty = (specialtyName: string) => {
    const nextPhrases = phrasesForSpecialty(specialtyName);
    setSelectedSpecialty(specialtyName);
    setPromptIndex(0);
    setTrainingPhrase(nextPhrases[0].text);
    setTrainingMessage("Leia a frase no seu ritmo");
    setShowAllQuickQuestions(false);
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
      const recorder = new MediaRecorder(stream, { audioBitsPerSecond: 24000 });
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
        const signature = await extractVoiceSignature(blob).catch(() => null);
        const saved = await storeTrainingSample({
          phrase: trainingPhrase.trim(),
          blob,
          mimeType: recorder.mimeType,
          createdAt: new Date().toISOString(),
          durationMs: signature?.durationMs ?? durationMs,
          ...(signature ? { voiceSignature: signature.features } : {}),
          ...(signature
            ? { speakerFingerprint: signature.speakerFingerprint }
            : {}),
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
        (sample.audioBytes
          ? await downloadVoiceSample({
              audioBytes: sample.audioBytes,
              mimeType: sample.mimeType,
            })
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
      if (sample.cloudId && user) {
        setSyncStatus("syncing");
        await deleteCloudVoiceSample(user.uid, {
          cloudId: sample.cloudId,
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
          (sample.audioBytes
            ? await downloadVoiceSample({
                audioBytes: sample.audioBytes,
                mimeType: sample.mimeType,
              })
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
          {!isOnline ? (
            <div className="sync-badge offline" title="Sem conexão com a internet">
              <WifiOff size={15} />
              <span>Modo offline</span>
            </div>
          ) : null}
          {user ? (
            <>
              <div className="account-profile" title={user.email ?? "Conta Google conectada"}>
                <span className="account-avatar" aria-hidden="true">
                  {(user.displayName || user.email || "C").trim().charAt(0).toUpperCase()}
                </span>
                <span className="account-identity">
                  <strong>{user.displayName || "Conta Google"}</strong>
                  <small>{user.email || "Perfil conectado"}</small>
                </span>
              </div>
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
                disabled={!authReady || isSigningIn}
              >
                {isSigningIn ? <RefreshCw size={16} /> : <LogIn size={16} />}
                {isSigningIn ? "Entrando…" : authReady ? "Entrar com Google" : "Carregando…"}
              </button>
              {appleSignInEnabled ? (
                <button
                  className="account-button apple"
                  onClick={() => handleSignIn(appleAuthProvider, "Apple")}
                  disabled={!authReady || isSigningIn}
                >
                  <LogIn size={16} /> Entrar com Apple
                </button>
              ) : null}
            </div>
          )}
          {authError ? (
            <div className="auth-error" role="alert">{authError}</div>
          ) : null}
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
                  <strong>{isListening ? "Pode falar. Estou identificando a voz." : "Toque para ouvir qualquer pessoa"}</strong>
                  <span>{isListening ? "Toque novamente quando terminar" : "Minha fala, paciente ou equipe serão separados automaticamente"}</span>
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
                          ? "Perfil de voz local e gratuito"
                          : transcriptionSource === "local-whisper"
                            ? "Whisper local — áudio não saiu do aparelho"
                            : "Reconhecimento gratuito do navegador"}
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
                    onClick={isSpeaking ? stopSpeaking : speakTypedPhrase}
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

            <article className="speaker-detection-card" aria-live="polite">
              <div>
                <strong>Identificação automática de quem está falando</strong>
                <span>
                  {lastDetectedSpeaker === "doctor"
                    ? "Minha fala"
                    : lastDetectedSpeaker === "patient"
                      ? "Paciente"
                      : lastDetectedSpeaker === "team"
                        ? "Equipe, colega ou preceptoria"
                        : localVoiceTemplateCount >= 3
                          ? "Pronta para identificar o próximo turno"
                          : `Grave mais ${Math.max(0, 3 - localVoiceTemplateCount)} amostras da sua voz para ativar`}
                </span>
                {lastDetectedText ? <small>“{lastDetectedText}”</small> : null}
              </div>
              {lastDetectedText ? (
                <div className="speaker-correction" aria-label="Corrigir falante identificado">
                  <button onClick={() => relabelLastSpeaker("doctor")}>Era minha fala</button>
                  <button onClick={() => relabelLastSpeaker("patient")}>Era o paciente</button>
                  <button onClick={() => relabelLastSpeaker("team")}>Era da equipe</button>
                </div>
              ) : null}
            </article>

            <article className="free-recognition-card">
              <div className="free-recognition-icon"><Check size={22} /></div>
              <div>
                <strong>Reconhecimento personalizado gratuito</strong>
                <span>
                  O Whisper reconhece a fala no próprio aparelho e a Clara compara
                  ritmo e frequências com suas amostras, sem API paga.
                </span>
                <small>
                  {localVoiceTemplateCount
                    ? `${localVoiceTemplateCount} assinaturas acústicas disponíveis. `
                    : "Grave cada pergunta duas vezes para fortalecer o reconhecimento local. "}
                  Com login, as amostras pequenas são sincronizadas no limite gratuito do Firestore.
                </small>
              </div>
              <span className="free-badge">R$ 0</span>
            </article>

            <article className={`offline-card ${offlineStatus}`} aria-live="polite">
              <div className="offline-icon">
                {offlineStatus === "ready" ? <Check size={23} /> : <HardDriveDownload size={23} />}
              </div>
              <div className="offline-copy">
                <div className="offline-heading">
                  <strong>Uso completo sem internet</strong>
                  <span className={`offline-status ${offlineStatus}`}>
                    {offlineStatus === "preparing"
                      ? "Preparando neste aparelho"
                      : offlineStatus === "ready"
                        ? "Pronto para modo avião"
                        : offlineStatus === "error"
                          ? "Preparação incompleta"
                          : "Preparação necessária"}
                  </span>
                </div>
                <span>{offlinePhase}</span>
                <small>
                  Salva o app, as perguntas, o Whisper e o Piper Faber neste
                  navegador. O primeiro preparo transfere cerca de {LOCAL_TRANSCRIPTION_DOWNLOAD_MB + PIPER_FIRST_USE_DOWNLOAD_MB} MB;
                  depois, microfone, reconhecimento e voz funcionam sem conexão.
                  Firebase apenas sincroniza novamente quando a internet voltar.
                </small>
                {offlineStatus === "preparing" ? (
                  <div
                    className="offline-progress"
                    role="progressbar"
                    aria-label="Preparação para uso offline"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={offlineProgress}
                  >
                    <span style={{ width: `${offlineProgress}%` }} />
                  </div>
                ) : null}
                {offlineError ? <small className="offline-error">{offlineError}</small> : null}
              </div>
              <button
                className="offline-download-button"
                onClick={prepareCompleteOfflineMode}
                disabled={offlineStatus === "preparing"}
              >
                {offlineStatus === "ready" ? (
                  <><Check size={17} /> Verificar arquivos</>
                ) : offlineStatus === "preparing" ? (
                  <><RefreshCw size={17} /> Preparando…</>
                ) : (
                  <><Download size={17} /> Preparar uso offline</>
                )}
              </button>
            </article>

            <article className="piper-voice-card" aria-live="polite">
              <div className="piper-voice-icon"><Volume2 size={23} /></div>
              <div className="piper-voice-copy">
                <div className="piper-voice-heading">
                  <strong>Voz neural {PIPER_VOICE_NAME}</strong>
                  <span className={`piper-status ${piperStatus}`}>
                    {piperStatus === "downloading"
                      ? piperDownloadPercent
                        ? `Baixando ${piperDownloadPercent}%`
                        : "Iniciando download"
                      : piperStatus === "generating"
                        ? "Preparando voz"
                        : piperStatus === "ready"
                          ? "Pronta neste dispositivo"
                          : piperStatus === "fallback"
                            ? "Alternativa do aparelho ativa"
                            : "Disponível para baixar"}
                  </span>
                </div>
                <span>
                  O modelo Piper é baixado e executado localmente neste dispositivo.
                  Depois do primeiro download, funciona até em modo avião.
                </span>
                <small>
                  O modelo tem aproximadamente {PIPER_MODEL_SIZE_MB} MB e fica no
                  armazenamento privado deste navegador. A primeira preparação pode
                  transferir até cerca de {PIPER_FIRST_USE_DOWNLOAD_MB} MB com os
                  componentes de execução. Em aparelhos mais antigos, a Clara usa
                  automaticamente a voz nativa como alternativa.
                </small>
                {piperStatus === "downloading" ? (
                  <div
                    className="piper-progress"
                    role="progressbar"
                    aria-label="Download da voz Faber"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={piperDownloadPercent}
                  >
                    <span style={{ width: `${piperDownloadPercent}%` }} />
                  </div>
                ) : null}
                {piperError ? <small className="piper-error">{piperError}</small> : null}
              </div>
              <div className="piper-actions">
                <button
                  className="piper-test-button"
                  onClick={() => speak("Teste de áudio da Clara.")}
                  disabled={isSpeaking}
                >
                  <Play size={16} fill="currentColor" /> Testar áudio agora
                </button>
                <button
                  className="piper-download-button"
                  onClick={prepareFaberVoice}
                  disabled={piperStatus === "downloading" || piperStatus === "generating" || piperStatus === "ready"}
                >
                  {piperStatus === "ready" ? (
                    <><Check size={17} /> Voz pronta</>
                  ) : piperStatus === "downloading" ? (
                    <><RefreshCw size={17} /> Baixando…</>
                  ) : (
                    <><Download size={17} /> Baixar voz</>
                  )}
                </button>
              </div>
            </article>

            <section className="lower-grid">
              <article className="quick-card">
                <div className="small-card-heading">
                  <span><Sparkles size={16} /> Falas rápidas priorizadas</span>
                  <small>{prioritizedQuickQuestions.length} opções em {selectedSpecialty}</small>
                </div>
                <div className="patient-context-box">
                  <strong>Raciocínio clínico adaptativo</strong>
                  <span>
                    {patientTurns.length
                      ? patientTurns.slice(-3).join(" • ")
                      : "Quando o paciente relatar sintomas, perguntas, orientações e condutas seguras serão reordenadas automaticamente."}
                  </span>
                </div>
                <div className="quick-kind-filters" aria-label="Filtrar falas rápidas por tipo">
                  {([
                    ["all", "Todas"],
                    ["question", "Perguntas"],
                    ["orientation", "Orientações"],
                    ["conduct", "Condutas"],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      className={quickKindFilter === value ? "active" : ""}
                      onClick={() => {
                        setQuickKindFilter(value);
                        setShowAllQuickQuestions(false);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="quick-list">
                  {visibleQuickQuestions.map((question) => (
                    <button key={question.id} onClick={() => playQuickPhrase(question)}>
                      <span>
                        <small className={`quick-kind ${question.kind}`}>
                          {question.kind === "question"
                            ? "Pergunta"
                            : question.kind === "orientation"
                              ? "Orientação"
                              : "Conduta"}
                        </small>
                        {question.text}
                      </span>
                      <Play size={14} fill="currentColor" />
                    </button>
                  ))}
                </div>
                <button
                  className="show-questions-button"
                  onClick={() => setShowAllQuickQuestions((visible) => !visible)}
                >
                  {showAllQuickQuestions
                    ? "Mostrar somente as 10 prioritárias"
                    : `Ver todas as ${filteredQuickQuestions.length} falas`}
                </button>
                {teamTurns.length ? (
                  <p className="team-context-note">
                    <strong>Equipe/preceptoria:</strong> {teamTurns.slice(-2).join(" • ")}
                  </p>
                ) : null}
                <section className="consultation-history" aria-label="Histórico desta consulta">
                  <div className="consultation-history-heading">
                    <div>
                      <strong>Mini-histórico desta consulta</strong>
                      <span>Salvo somente neste dispositivo até você copiar o prontuário.</span>
                    </div>
                    <small>{consultationTurns.length} falas</small>
                  </div>
                  {consultationTurns.length ? (
                    <div className="consultation-turns">
                      {consultationTurns.slice(-8).map((turn) => (
                        <div className={`consultation-turn ${turn.speaker}`} key={turn.id}>
                          <strong>
                            {turn.speaker === "doctor"
                              ? "Eu"
                              : turn.speaker === "patient"
                                ? "Paciente"
                                : "Equipe"}
                          </strong>
                          <span>{turn.text}</span>
                          <time dateTime={turn.createdAt}>
                            {new Date(turn.createdAt).toLocaleTimeString("pt-BR", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </time>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="empty-consultation-history">
                      As falas identificadas aparecerão aqui e não serão sugeridas novamente.
                    </p>
                  )}
                  <button
                    className="finish-consultation-button"
                    onClick={finishConsultation}
                    disabled={!consultationTurns.length}
                  >
                    <FileText size={17} /> Encerrar consulta e gerar prontuário
                  </button>
                </section>
              </article>

              <article className="auto-card">
                <div className="auto-icon"><Headphones size={22} /></div>
                <div>
                  <strong>Reprodução automática</strong>
                  <span>Emite somente sua fala e depois reabre o microfone sem captar o próprio áudio</span>
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

      {recordOpen ? (
        <div className="record-modal-backdrop" role="presentation">
          <section
            className="record-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="record-modal-title"
          >
            <div className="record-modal-heading">
              <div>
                <span className="section-label"><FileText size={17} /> Rascunho clínico local</span>
                <h2 id="record-modal-title">Prontuário da consulta</h2>
                <p>
                  Gerado apenas com o que foi registrado. Campos ausentes permanecem como
                  “não informado”; revise tudo com a preceptoria.
                </p>
              </div>
              <button
                className="icon-button"
                onClick={() => setRecordOpen(false)}
                aria-label="Fechar prontuário e continuar consulta"
              >
                <X size={20} />
              </button>
            </div>
            <textarea
              className="record-textarea"
              value={recordText}
              onChange={(event) => {
                setRecordText(event.target.value);
                setRecordCopied(false);
                setRecordMessage("");
              }}
              aria-label="Prontuário editável"
            />
            {recordMessage ? (
              <p className={`record-message ${recordCopied ? "success" : ""}`} role="status">
                {recordMessage}
              </p>
            ) : null}
            <div className="record-actions">
              <button className="secondary-button" onClick={() => setRecordOpen(false)}>
                Continuar consulta
              </button>
              <button className="primary-button" onClick={copyClinicalRecord}>
                {recordCopied ? <ClipboardCheck size={19} /> : <ClipboardCopy size={19} />}
                {recordCopied ? "Prontuário copiado" : "Copiar prontuário"}
              </button>
              {recordCopied ? (
                <button className="delete-consultation-button" onClick={clearConsultationAfterCopy}>
                  <Trash2 size={17} /> Já copiei — apagar histórico
                </button>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      <footer>
        <span>Clara — sua voz, mais clara.</span>
        <span>{user ? "Perfil protegido e sincronizado" : "Perfil adaptativo local"} • Português do Brasil</span>
      </footer>
    </div>
  );
}
