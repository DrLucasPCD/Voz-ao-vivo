export type OfflineShellStatus = "unsupported" | "installing" | "ready";

export async function registerOfflineServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

export async function cacheAppForOffline() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Este navegador não permite instalar o app para uso offline");
  }

  const registration = await registerOfflineServiceWorker();
  if (!registration) throw new Error("Não consegui ativar o modo offline");
  await navigator.serviceWorker.ready;

  const sameOriginResources = performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((url) => {
      try {
        const parsed = new URL(url);
        return parsed.origin === location.origin;
      } catch {
        return false;
      }
    });

  const urls = Array.from(
    new Set([
      "/",
      "/manifest.webmanifest",
      "/app-icon.svg",
      "/piper-voice.worker.js",
      "/local-transcription.worker.js",
      ...sameOriginResources,
    ]),
  );

  const target = registration.active ?? navigator.serviceWorker.controller;
  if (!target) {
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), {
        once: true,
      });
    });
  }

  const controller = registration.active ?? navigator.serviceWorker.controller;
  if (!controller) throw new Error("O modo offline ainda não está ativo");

  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(
      () => reject(new Error("O cache offline demorou mais que o esperado")),
      30_000,
    );
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timeout);
      if (event.data?.ok) resolve();
      else reject(new Error(event.data?.message ?? "Falha ao salvar o app"));
    };
    controller.postMessage({ type: "CACHE_URLS", urls }, [channel.port2]);
  });

  localStorage.setItem("clara-offline-shell-ready", "true");
}

export function isOfflineShellPrepared() {
  return localStorage.getItem("clara-offline-shell-ready") === "true";
}
