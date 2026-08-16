import assert from "node:assert/strict";
import test from "node:test";

import { isPlaybackPermissionError } from "../app/piper-voice.ts";

test("recognizes Safari playback blocking without treating the model as removed", () => {
  assert.equal(
    isPlaybackPermissionError({
      name: "NotAllowedError",
      message:
        "The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.",
    }),
    true,
  );
  assert.equal(
    isPlaybackPermissionError(new Error("A voz Faber gerou um áudio sem volume")),
    false,
  );
});
