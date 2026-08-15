const FIREBASE_API_KEY = "AIzaSyD1_C9GQjcDCP25B1Bn_tpPWBpHx55LUCo";
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 30;

type FirebaseUser = {
  localId: string;
  email?: string;
};

type OpenAITranscription = {
  text?: string;
  error?: { message?: string };
};

const recentRequests = new Map<string, number[]>();

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });

function valuesFromJson(value: FormDataEntryValue | null, limit: number) {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function isAllowedAudio(file: File) {
  return (
    file.size > 0 &&
    file.size <= MAX_AUDIO_BYTES &&
    [
      "audio/webm",
      "audio/ogg",
      "audio/wav",
      "audio/mpeg",
      "audio/mp4",
      "audio/x-m4a",
    ].some((mimeType) => file.type.startsWith(mimeType))
  );
}

async function verifyFirebaseToken(token: string) {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: token }),
    },
  );
  if (!response.ok) return null;
  const payload = (await response.json()) as { users?: FirebaseUser[] };
  return payload.users?.[0] ?? null;
}

function isUserAllowed(user: FirebaseUser) {
  const allowedEmails = (process.env.ALLOWED_FIREBASE_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const allowedUids = (process.env.ALLOWED_FIREBASE_UIDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!allowedEmails.length && !allowedUids.length) return false;
  return (
    allowedUids.includes(user.localId) ||
    Boolean(user.email && allowedEmails.includes(user.email.toLowerCase()))
  );
}

function isRateLimited(uid: string) {
  const now = Date.now();
  const active = (recentRequests.get(uid) ?? []).filter(
    (timestamp) => now - timestamp < RATE_WINDOW_MS,
  );
  if (active.length >= RATE_LIMIT) return true;
  active.push(now);
  recentRequests.set(uid, active);
  return false;
}

function audioExtension(mimeType: string) {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "m4a";
  return "webm";
}

async function callOpenAI({
  audio,
  reference,
  specialty,
  vocabulary,
  corrections,
}: {
  audio: File;
  reference: File | null;
  specialty: string;
  vocabulary: string[];
  corrections: string[];
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { response: null, configured: false, usedReference: false };
  }

  const model = process.env.OPENAI_TRANSCRIPTION_MODEL ?? "gpt-transcribe";
  const createBody = async (includeReference: boolean) => {
    const body = new FormData();
    body.append(
      "file",
      audio,
      `fala.${audioExtension(audio.type)}`,
    );
    body.append("model", model);
    body.append("language", "pt");
    body.append("response_format", "json");

    const keywords = Array.from(new Set([...vocabulary, ...corrections])).slice(
      0,
      80,
    );
    keywords.forEach((keyword) => body.append("keywords[]", keyword));
    body.append(
      "prompt",
      [
        "Transcreva fielmente uma pergunta em português do Brasil.",
        "O falante é um estudante de medicina com paralisia cerebral e disartria.",
        `Contexto clínico: ${specialty || "Clínica geral"}.`,
        "Priorize os termos médicos fornecidos, preserve o sentido e não invente informações.",
      ].join(" "),
    );

    if (includeReference && reference) {
      const referenceBase64 = Buffer.from(
        await reference.arrayBuffer(),
      ).toString("base64");
      body.append("known_speaker_names[]", "lucas");
      body.append(
        "known_speaker_references[]",
        `data:${reference.type};base64,${referenceBase64}`,
      );
    }
    return body;
  };

  const send = async (includeReference: boolean) =>
    fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: await createBody(includeReference),
    });

  let usedReference = Boolean(reference);
  let response = await send(usedReference);
  if (!response.ok && usedReference) {
    usedReference = false;
    response = await send(false);
  }
  return { response, configured: true, usedReference, model };
}

export default async (request: Request) => {
  if (request.method !== "POST") {
    return json({ error: "Método não permitido." }, 405);
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_AUDIO_BYTES * 2 + 1024 * 1024) {
    return json({ error: "A solicitação de áudio é muito grande." }, 413);
  }

  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (!token) return json({ error: "Entre na sua conta para usar a nuvem." }, 401);

  try {
    const user = await verifyFirebaseToken(token);
    if (!user) return json({ error: "Sua sessão expirou. Entre novamente." }, 401);
    if (!isUserAllowed(user)) {
      return json(
        {
          error:
            "Esta conta ainda não foi autorizada para usar a transcrição em nuvem.",
          code: "account_not_allowed",
        },
        403,
      );
    }
    if (isRateLimited(user.localId)) {
      return json(
        { error: "Limite temporário de transcrições atingido. Aguarde alguns minutos." },
        429,
      );
    }

    const form = await request.formData();
    const audio = form.get("audio");
    const referenceEntry = form.get("voiceReference");
    const reference = referenceEntry instanceof File ? referenceEntry : null;
    if (!(audio instanceof File) || !isAllowedAudio(audio)) {
      return json({ error: "Áudio ausente, muito grande ou em formato inválido." }, 400);
    }
    if (reference && !isAllowedAudio(reference)) {
      return json({ error: "A amostra de referência não é válida." }, 400);
    }

    const specialty =
      typeof form.get("specialty") === "string"
        ? String(form.get("specialty")).slice(0, 100)
        : "Clínica geral";
    const vocabulary = valuesFromJson(form.get("vocabulary"), 60);
    const corrections = valuesFromJson(form.get("corrections"), 50);
    const result = await callOpenAI({
      audio,
      reference,
      specialty,
      vocabulary,
      corrections,
    });

    if (!result.configured || !result.response) {
      return json(
        {
          error: "A transcrição em nuvem ainda não foi configurada no Netlify.",
          code: "cloud_not_configured",
        },
        503,
      );
    }

    const payload = (await result.response.json()) as OpenAITranscription;
    if (!result.response.ok || !payload.text?.trim()) {
      return json(
        {
          error: "O serviço de transcrição não conseguiu entender esta fala.",
          code: "transcription_failed",
        },
        502,
      );
    }

    return json({
      text: payload.text.trim(),
      source: "personalized-cloud",
      usedVoiceReference: result.usedReference,
      model: result.model,
    });
  } catch {
    return json(
      { error: "A transcrição em nuvem falhou. O modo do navegador continuará disponível." },
      500,
    );
  }
};
