export type VoiceSyncSample = {
  synced?: boolean;
  firestoreAudioSynced?: boolean;
  blob?: Blob;
};

export function voiceSyncProgress(samples: VoiceSyncSample[]) {
  const total = samples.length;
  const synced = samples.filter(
    (sample) => sample.synced || sample.firestoreAudioSynced,
  ).length;
  const pending = samples.filter(
    (sample) => sample.blob && !sample.firestoreAudioSynced,
  ).length;
  return { total, synced, pending };
}

export function retryDelayMs(failedAttempt: number) {
  return Math.min(12_000, 800 * 2 ** Math.max(0, failedAttempt - 1));
}
