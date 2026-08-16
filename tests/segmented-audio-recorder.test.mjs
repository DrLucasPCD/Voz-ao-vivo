import assert from "node:assert/strict";
import test from "node:test";

import { createSegmentedAudioRecorder } from "../app/segmented-audio-recorder.ts";

test("creates a complete decodable container for every continuous segment", async () => {
  const originalMediaRecorder = globalThis.MediaRecorder;
  const originalWindow = globalThis.window;
  let recorderCount = 0;

  class FakeMediaRecorder {
    state = "inactive";
    mimeType = "audio/webm";
    ondataavailable = null;
    onerror = null;
    onstop = null;
    id;

    constructor() {
      recorderCount += 1;
      this.id = recorderCount;
    }

    start() {
      this.state = "recording";
    }

    stop() {
      this.state = "inactive";
      queueMicrotask(() => {
        this.ondataavailable?.({
          data: new Blob([`complete-segment-${this.id}`], {
            type: this.mimeType,
          }),
        });
        this.onstop?.();
      });
    }
  }

  globalThis.MediaRecorder = FakeMediaRecorder;
  globalThis.window = {
    setInterval,
    clearInterval,
  };

  try {
    const segments = [];
    const capture = createSegmentedAudioRecorder(
      {},
      {
        intervalMs: 10_000,
        onSegment: (blob) => segments.push(blob),
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 190));
    capture.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(recorderCount, 2);
    assert.equal(await segments[0].text(), "complete-segment-1");

    await new Promise((resolve) => setTimeout(resolve, 190));
    capture.flush();
    await capture.stop();
    assert.equal(recorderCount, 2);
    assert.equal(await segments[1].text(), "complete-segment-2");
    assert.equal(await capture.stop(), undefined);
  } finally {
    globalThis.MediaRecorder = originalMediaRecorder;
    globalThis.window = originalWindow;
  }
});
