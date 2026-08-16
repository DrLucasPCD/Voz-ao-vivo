export type SegmentedAudioRecorder = {
  flush: () => void;
  stop: () => Promise<void>;
};

type SegmentedAudioRecorderOptions = {
  intervalMs?: number;
  audioBitsPerSecond?: number;
  onSegment: (blob: Blob, durationMs: number) => void;
  onError?: (error: unknown) => void;
};

export function createSegmentedAudioRecorder(
  stream: MediaStream,
  {
    intervalMs = 8_000,
    audioBitsPerSecond = 24_000,
    onSegment,
    onError,
  }: SegmentedAudioRecorderOptions,
): SegmentedAudioRecorder {
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let segmentStartedAt = 0;
  let stopped = false;
  let stopResolver: (() => void) | null = null;
  let stopPromise: Promise<void> | null = null;

  const startSegment = () => {
    if (stopped) return;
    const nextRecorder = new MediaRecorder(stream, { audioBitsPerSecond });
    recorder = nextRecorder;
    chunks = [];
    segmentStartedAt = Date.now();
    nextRecorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    nextRecorder.onerror = (event) => {
      onError?.(event);
    };
    nextRecorder.onstop = () => {
      const durationMs = Math.max(0, Date.now() - segmentStartedAt);
      const blob = new Blob(chunks, {
        type: nextRecorder.mimeType || chunks[0]?.type || "audio/webm",
      });
      recorder = null;
      chunks = [];

      if (!stopped) startSegment();
      if (blob.size) onSegment(blob, durationMs);
      if (stopped && stopResolver) {
        const resolve = stopResolver;
        stopResolver = null;
        resolve();
      }
    };
    nextRecorder.start();
  };

  const flush = () => {
    if (recorder?.state !== "recording") return;
    if (Date.now() - segmentStartedAt < 180) return;
    recorder.stop();
  };

  const interval = window.setInterval(flush, intervalMs);
  startSegment();

  return {
    flush,
    stop: () => {
      if (stopPromise) return stopPromise;
      stopped = true;
      window.clearInterval(interval);
      stopPromise = new Promise<void>((resolve) => {
        if (recorder) {
          stopResolver = resolve;
          if (recorder.state === "recording") recorder.stop();
          return;
        }
        resolve();
      });
      return stopPromise;
    },
  };
}
