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
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteCloudVoiceSample,
  downloadVoiceSample,
  loadCloudCorrections,
  saveCloudCorrections,
  subscribeToVoiceSamples,
  uploadVoiceSample,
  type CloudVoiceSample,
} from "./cloud-voice-profile";
import { firebaseAuth, googleAuthProvider } from "./firebase";

type RecognitionResultEvent = Event & {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string; confidence: number };
  }>;
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
  cloudId?: string;
  storagePath?: string;
  synced?: boolean;
};

const QUICK_PHRASES = [
  "Qual é o principal motivo da consulta?",
  "Quando os sintomas começaram?",
  "Você usa algum medicamento continuamente?",
  "Você tem alergia a algum medicamento?",
];

const TRAINING_PHRASES = [
  { context: "Abertura", text: "Bom dia, eu sou o doutor Lucas e vou conduzir sua consulta." },
  { context: "Abertura", text: "Como você prefere ser chamado?" },
  { context: "Abertura", text: "Qual é o principal motivo da consulta de hoje?" },
  { context: "Abertura", text: "Além disso, existe outra preocupação que você gostaria de conversar?" },
  { context: "Queixa principal", text: "Conte com suas palavras o que está sentindo." },
  { context: "Queixa principal", text: "Quando esse sintoma começou?" },
  { context: "Queixa principal", text: "O início foi súbito ou aconteceu aos poucos?" },
  { context: "Queixa principal", text: "Esse sintoma está melhorando, piorando ou permanece igual?" },
  { context: "Caracterização", text: "Em qual parte do corpo você sente o problema?" },
  { context: "Caracterização", text: "Como você descreveria essa sensação?" },
  { context: "Caracterização", text: "De zero a dez, qual é a intensidade do sintoma?" },
  { context: "Caracterização", text: "O sintoma é contínuo ou aparece em alguns momentos?" },
  { context: "Caracterização", text: "Existe algo que melhora o sintoma?" },
  { context: "Caracterização", text: "Existe algo que piora o sintoma?" },
  { context: "Sintomas associados", text: "Você teve febre ou calafrios?" },
  { context: "Sintomas associados", text: "Você sentiu falta de ar, tontura ou desmaio?" },
  { context: "Sintomas associados", text: "Você teve náuseas, vômitos ou alteração do apetite?" },
  { context: "Sintomas associados", text: "Percebeu alguma alteração no sono, no peso ou na disposição?" },
  { context: "Antecedentes", text: "Você tem alguma doença ou condição de saúde diagnosticada?" },
  { context: "Antecedentes", text: "Já precisou ser internado ou fazer alguma cirurgia?" },
  { context: "Antecedentes", text: "Já teve esse mesmo problema antes?" },
  { context: "Antecedentes", text: "Existe alguma doença importante na sua família?" },
  { context: "Medicamentos", text: "Quais medicamentos você usa atualmente?" },
  { context: "Medicamentos", text: "Você sabe a dose e o horário de cada medicamento?" },
  { context: "Medicamentos", text: "Usou algum remédio por conta própria para esse sintoma?" },
  { context: "Alergias", text: "Você tem alergia a algum medicamento, alimento ou substância?" },
  { context: "Alergias", text: "O que acontece quando você entra em contato com essa substância?" },
  { context: "Hábitos", text: "Você fuma ou já fumou?" },
  { context: "Hábitos", text: "Você consome bebidas alcoólicas? Com que frequência?" },
  { context: "Hábitos", text: "Como são sua alimentação e sua rotina de atividade física?" },
  { context: "Segurança", text: "Neste momento, você sente dor muito forte ou dificuldade para respirar?" },
  { context: "Segurança", text: "Houve perda de consciência, fraqueza súbita ou alteração da fala?" },
  { context: "Compreensão", text: "Vou repetir o que entendi para confirmar se está correto." },
  { context: "Compreensão", text: "Existe algum detalhe importante que eu ainda não perguntei?" },
  { context: "Plano", text: "Agora vou realizar o exame físico e explicar os próximos passos." },
  { context: "Plano", text: "Você entendeu as orientações ou gostaria que eu explicasse novamente?" },
  { context: "Encerramento", text: "Você tem alguma dúvida antes de encerrarmos a consulta?" },
  { context: "Encerramento", text: "Obrigado por compartilhar essas informações comigo." },
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
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [correctionSaved, setCorrectionSaved] = useState(false);
  const recognitionRef = useRef<BrowserRecognition | null>(null);
  const latestFinalRef = useRef("");
  const autoSpeakRef = useRef(false);
  const conversationRecorderRef = useRef<MediaRecorder | null>(null);
  const conversationChunksRef = useRef<Blob[]>([]);
  const conversationStreamRef = useRef<MediaStream | null>(null);
  const [pendingCorrectionAudio, setPendingCorrectionAudio] = useState<Blob | null>(null);
  const [isPreparingCorrectionAudio, setIsPreparingCorrectionAudio] = useState(false);

  const [promptIndex, setPromptIndex] = useState(0);
  const [trainingPhrase, setTrainingPhrase] = useState(TRAINING_PHRASES[0].text);
  const [isRecording, setIsRecording] = useState(false);
  const [trainingCount, setTrainingCount] = useState(0);
  const [trainingSamples, setTrainingSamples] = useState<TrainingSample[]>([]);
  const [isExporting, setIsExporting] = useState(false);
  const [latestRecordingUrl, setLatestRecordingUrl] = useState("");
  const [trainingMessage, setTrainingMessage] = useState("Leia a frase no seu ritmo");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    return onAuthStateChanged(firebaseAuth, (currentUser) => {
      setUser(currentUser);
      setAuthReady(true);
      setSyncStatus(currentUser ? "syncing" : "local");
    });
  }, []);

  useEffect(() => {
    const savedCorrections = localStorage.getItem("clara-corrections");
    const savedAutoSpeak = localStorage.getItem("clara-auto-speak") === "true";
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

  const trainedPhrases = Array.from(
    new Set(trainingSamples.map((sample) => sample.phrase.trim()).filter(Boolean)),
  );

  const handleSignIn = async () => {
    setError("");
    try {
      await signInWithPopup(firebaseAuth, googleAuthProvider);
    } catch (signInError) {
      const code =
        typeof signInError === "object" && signInError && "code" in signInError
          ? String(signInError.code)
          : "";
      if (code !== "auth/popup-closed-by-user") {
        setError("Não consegui entrar com o Google. Tente novamente.");
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
    setIsPreparingCorrectionAudio(false);
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
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
      recorder.onstop = () => {
        if (conversationChunksRef.current.length) {
          setPendingCorrectionAudio(
            new Blob(conversationChunksRef.current, { type: recorder.mimeType }),
          );
        }
        stream.getTracks().forEach((track) => track.stop());
        conversationStreamRef.current = null;
        setIsPreparingCorrectionAudio(false);
      };
      recorder.start();
    } catch {
      setError("Não consegui acessar o microfone. Verifique a permissão do navegador.");
      return;
    }

    const recognition = new Recognition();
    recognition.lang = "pt-BR";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    latestFinalRef.current = "";

    recognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) finalText += result[0].transcript;
        else interimText += result[0].transcript;
      }
      setInterimTranscript(interimText);
      if (finalText.trim()) {
        const cleanText = finalText.trim();
        latestFinalRef.current = cleanText;
        setRawTranscript(cleanText);
        setTranscript(applyLearnedCorrection(cleanText, corrections, trainedPhrases));
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
      setIsListening(false);
      setMessage("Pronto para tentar novamente");
    };

    recognition.onend = () => {
      setIsListening(false);
      setInterimTranscript("");
      setMessage(latestFinalRef.current ? "Frase reconhecida" : "Pronto para ouvir");
      if (conversationRecorderRef.current?.state === "recording") {
        setIsPreparingCorrectionAudio(true);
        conversationRecorderRef.current.stop();
      }
      if (autoSpeakRef.current && latestFinalRef.current) {
        const corrected = applyLearnedCorrection(
          latestFinalRef.current,
          corrections,
          trainedPhrases,
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
  };

  const toggleAutoSpeak = () => {
    const next = !autoSpeak;
    setAutoSpeak(next);
    autoSpeakRef.current = next;
    localStorage.setItem("clara-auto-speak", String(next));
  };

  const playQuickPhrase = (phrase: string) => {
    setRawTranscript("");
    setTranscript(phrase);
    speak(phrase);
  };

  const nextTrainingPhrase = () => {
    const next = (promptIndex + 1) % TRAINING_PHRASES.length;
    setPromptIndex(next);
    setTrainingPhrase(TRAINING_PHRASES[next].text);
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
        const saved = await storeTrainingSample({
          phrase: trainingPhrase.trim(),
          blob,
          mimeType: recorder.mimeType,
          createdAt: new Date().toISOString(),
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
              <button className="account-button subtle" onClick={handleSignOut} aria-label="Sair da conta Google">
                <LogOut size={16} /> Sair
              </button>
            </>
          ) : (
            <button className="account-button" onClick={handleSignIn} disabled={!authReady}>
              <LogIn size={16} /> {authReady ? "Entrar para sincronizar" : "Carregando…"}
            </button>
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

            <section className="lower-grid">
              <article className="quick-card">
                <div className="small-card-heading">
                  <span><Sparkles size={16} /> Perguntas rápidas</span>
                  <small>Um toque para perguntar</small>
                </div>
                <div className="quick-list">
                  {QUICK_PHRASES.map((phrase) => (
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
                    : "Entre com Google para acessar suas amostras em outros dispositivos."}
                </span>
              </div>
            </div>

            <article className={`training-card ${isRecording ? "recording" : ""}`}>
              <div className="step-heading">
                <span>Frase {promptIndex + 1} de {TRAINING_PHRASES.length}</span>
                <button onClick={nextTrainingPhrase} disabled={isRecording}>Pular frase <ChevronRight size={16} /></button>
              </div>
              <div className="context-chip">Contexto: {TRAINING_PHRASES[promptIndex].context}</div>
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
