import assert from "node:assert/strict";
import { File } from "node:buffer";
import test from "node:test";
import handler from "../netlify/functions/transcribe.ts";

test("protects and submits personalized cloud transcription", async () => {
  const unauthorized = await handler(
    new Request("http://localhost/.netlify/functions/transcribe", {
      method: "POST",
    }),
  );
  assert.equal(unauthorized.status, 401);

  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalAllowedEmails = process.env.ALLOWED_FIREBASE_EMAILS;
  const calls = [];
  process.env.OPENAI_API_KEY = "test-key-not-real";
  process.env.ALLOWED_FIREBASE_EMAILS = "lucas@example.com";

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body });
    if (String(url).includes("identitytoolkit")) {
      return Response.json({
        users: [{ localId: "uid-lucas", email: "lucas@example.com" }],
      });
    }
    return Response.json({ text: "Qual é o principal motivo da consulta?" });
  };

  try {
    const form = new FormData();
    form.append(
      "audio",
      new File([new Uint8Array([1, 2, 3])], "fala.webm", {
        type: "audio/webm",
      }),
    );
    form.append(
      "voiceReference",
      new File([new Uint8Array([4, 5, 6])], "referencia.webm", {
        type: "audio/webm",
      }),
    );
    form.append("specialty", "Clínica geral");
    form.append("vocabulary", JSON.stringify(["consulta", "medicamento"]));
    form.append("corrections", JSON.stringify(["alergia"]));

    const response = await handler(
      new Request("http://localhost/.netlify/functions/transcribe", {
        method: "POST",
        headers: { Authorization: "Bearer firebase-test-token" },
        body: form,
      }),
    );
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.text, "Qual é o principal motivo da consulta?");
    assert.equal(payload.source, "personalized-cloud");
    assert.equal(payload.usedVoiceReference, true);
    assert.equal(calls.length, 2);

    const openAiBody = calls[1].body;
    assert.ok(openAiBody instanceof FormData);
    assert.ok(openAiBody.getAll("keywords[]").includes("medicamento"));
    assert.match(
      String(openAiBody.get("known_speaker_references[]")),
      /^data:audio\/webm;base64,/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
    if (originalAllowedEmails === undefined) {
      delete process.env.ALLOWED_FIREBASE_EMAILS;
    } else {
      process.env.ALLOWED_FIREBASE_EMAILS = originalAllowedEmails;
    }
  }
});
