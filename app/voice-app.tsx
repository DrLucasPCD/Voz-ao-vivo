"use client";

import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  CircleStop,
  Headphones,
  Mic,
  Pause,
  Play,
  Save,
  Sparkles,
  Trash2,
  Volume2,
  WandSparkles,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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
  blob: Blob;
  mimeType: string;
  createdAt: string;
};

const QUICK_PHRASES = [
  "Sim, por favor.",
  "Não, obrigado.",
  "Pode repetir?",
  "Preciso de ajuda.",
];

const TRAINING_PHRASES = [
  "Olá, tudo bem com você?",
  "Eu gostaria de um copo de água.",
  "Por favor, fale um pouco mais devagar.",
  "Preciso de ajuda agora.",
  "Obrigado por me escutar.",
  "Meu nome é Lucas.",
  "Pode repetir o que você disse?",
  "Estou pronto para começar.",
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

function applyLearnedCorrection(value: string, corrections: Correction[]) {
  let best: Correction | undefined;
  let bestScore = 0;
  corrections.forEach((correction) => {
    const score = similarity(value, correction.heard);
    if (score > bestScore) {
      best = correction;
      bestScore = score;
    }
  });
  return best && bestScore >= 0.84 ? best.intended : value;
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
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("samples", "readwrite");
    transaction.objectStore("samples").add(sample);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function countTrainingSamples() {
  const db = await openTrainingDatabase();
  const count = await new Promise<number>((resolve, reject) => {
    const request = db.transaction("samples", "readonly").objectStore("samples").count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return count;
}

export function VoiceApp() {
  const [mode, setMode] = useState<"talk" | "train">("talk");
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

  const [promptIndex, setPromptIndex] = useState(0);
  const [trainingPhrase, setTrainingPhrase] = useState(TRAINING_PHRASES[0]);
  const [isRecording, setIsRecording] = useState(false);
  const [trainingCount, setTrainingCount] = useState(0);
  const [latestRecordingUrl, setLatestRecordingUrl] = useState("");
  const [trainingMessage, setTrainingMessage] = useState("Leia a frase no seu ritmo");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

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
    countTrainingSamples().then(setTrainingCount).catch(() => undefined);
  }, []);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      window.speechSynthesis?.cancel();
      if (latestRecordingUrl) URL.revokeObjectURL(latestRecordingUrl);
    };
  }, [latestRecordingUrl]);

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

  const startListening = () => {
    setError("");
    setCorrectionSaved(false);
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      setError("O reconhecimento de voz ainda não funciona neste navegador. Abra o app no Chrome ou Edge.");
      return;
    }

    window.speechSynthesis?.cancel();
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
        setTranscript(applyLearnedCorrection(cleanText, corrections));
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
      if (autoSpeakRef.current && latestFinalRef.current) {
        const corrected = applyLearnedCorrection(latestFinalRef.current, corrections);
        window.setTimeout(() => speak(corrected), 180);
      }
    };

    recognitionRef.current = recognition;
    setIsListening(true);
    setMessage("Estou ouvindo você…");
    recognition.start();
  };

  const stopListening = () => {
    recognitionRef.current?.stop();
    setIsListening(false);
  };

  const saveCorrection = () => {
    if (!rawTranscript.trim() || !transcript.trim() || normalize(rawTranscript) === normalize(transcript)) return;
    const next = [
      ...corrections.filter((item) => normalize(item.heard) !== normalize(rawTranscript)),
      { heard: rawTranscript.trim(), intended: transcript.trim(), createdAt: new Date().toISOString() },
    ];
    setCorrections(next);
    localStorage.setItem("clara-corrections", JSON.stringify(next));
    setCorrectionSaved(true);
    setMessage("Correção aprendida neste dispositivo");
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
    setTrainingPhrase(TRAINING_PHRASES[next]);
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
        await storeTrainingSample({
          phrase: trainingPhrase.trim(),
          blob,
          mimeType: recorder.mimeType,
          createdAt: new Date().toISOString(),
        });
        if (latestRecordingUrl) URL.revokeObjectURL(latestRecordingUrl);
        setLatestRecordingUrl(URL.createObjectURL(blob));
        setTrainingCount((count) => count + 1);
        setTrainingMessage("Amostra salva com segurança neste dispositivo");
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
        <div className="privacy-note"><span /> Seus dados ficam neste dispositivo</div>
      </header>

      <main id="inicio">
        {mode === "talk" ? (
          <>
            <section className="hero">
              <div>
                <p className="eyebrow"><Sparkles size={16} /> Comunicação assistida</p>
                <h1>Sua voz merece<br /><em>ser compreendida.</em></h1>
              </div>
              <p className="hero-copy">
                Fale do seu jeito. A Clara escuta, aprende com suas correções e reproduz sua mensagem com clareza.
              </p>
            </section>

            <section className="talk-grid" aria-label="Área principal de conversa">
              <article className={`listen-card ${isListening ? "listening" : ""}`}>
                <div className="status-line">
                  <span className={`status-dot ${isListening ? "live" : ""}`} />
                  <span aria-live="polite">{message}</span>
                  {corrections.length > 0 && (
                    <span className="learned-count"><WandSparkles size={14} /> {corrections.length} {corrections.length === 1 ? "correção" : "correções"}</span>
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
                    <span className="section-label">Sua mensagem</span>
                    <span className="section-hint">Você pode corrigir antes de reproduzir</span>
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
                    placeholder={interimTranscript || "O que você disser aparecerá aqui…"}
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
                    <button className="secondary-button" onClick={saveCorrection}>
                      {correctionSaved ? <Check size={18} /> : <Save size={18} />}
                      {correctionSaved ? "Aprendido" : "Ensinar correção"}
                    </button>
                  )}
                </div>
              </article>
            </section>

            <section className="lower-grid">
              <article className="quick-card">
                <div className="small-card-heading">
                  <span><Sparkles size={16} /> Frases rápidas</span>
                  <small>Um toque para falar</small>
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
              <p className="eyebrow"><WandSparkles size={16} /> Treinamento pessoal</p>
              <h1>Ajude a Clara a<br /><em>conhecer sua voz.</em></h1>
              <p>
                Cada frase gravada cria um exemplo com sua voz e o texto correto. Com o tempo, isso forma a base para um reconhecimento realmente personalizado.
              </p>
              <div className="training-progress">
                <strong>{trainingCount}</strong>
                <span>amostras salvas<br />neste dispositivo</span>
              </div>
              <div className="privacy-box">
                <Check size={18} />
                <span><strong>Privado por padrão.</strong> Nenhum áudio sai deste dispositivo nesta versão.</span>
              </div>
            </div>

            <article className={`training-card ${isRecording ? "recording" : ""}`}>
              <div className="step-heading">
                <span>Frase {promptIndex + 1} de {TRAINING_PHRASES.length}</span>
                <button onClick={nextTrainingPhrase} disabled={isRecording}>Pular frase <ChevronRight size={16} /></button>
              </div>
              <label htmlFor="training-phrase">Leia esta frase — ou escreva uma que você usa muito</label>
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
          </section>
        )}
      </main>

      <footer>
        <span>Clara — sua voz, mais clara.</span>
        <span>Protótipo inicial • Português do Brasil</span>
      </footer>
    </div>
  );
}
