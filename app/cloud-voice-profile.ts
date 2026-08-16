import {
  Bytes,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  setDoc,
} from "firebase/firestore";
import { firebaseDb } from "./firebase";

export const MAX_SYNCED_AUDIO_BYTES = 700 * 1024;

export type CloudCorrection = {
  heard: string;
  intended: string;
  createdAt: string;
};

export type CloudVoiceSample = {
  cloudId: string;
  phrase: string;
  mimeType: string;
  createdAt: string;
  source: "guided" | "word" | "correction";
  heard?: string;
  durationMs?: number;
  voiceSignature?: number[];
  speakerFingerprint?: number[];
  audioBytes: Bytes;
  synced: true;
};

type UploadableSample = Omit<CloudVoiceSample, "cloudId" | "audioBytes" | "synced"> & {
  cloudId?: string;
  blob: Blob;
};

export async function uploadVoiceSample(uid: string, sample: UploadableSample) {
  const cloudId = sample.cloudId ?? crypto.randomUUID();
  if (sample.blob.size > MAX_SYNCED_AUDIO_BYTES) {
    throw new Error("A amostra excede o limite gratuito de sincronização.");
  }
  const audioBytes = Bytes.fromUint8Array(
    new Uint8Array(await sample.blob.arrayBuffer()),
  );

  const cloudSample: CloudVoiceSample = {
    cloudId,
    phrase: sample.phrase,
    mimeType: sample.mimeType,
    createdAt: sample.createdAt,
    source: sample.source,
    audioBytes,
    synced: true,
    ...(sample.heard ? { heard: sample.heard } : {}),
    ...(sample.durationMs ? { durationMs: sample.durationMs } : {}),
    ...(sample.voiceSignature ? { voiceSignature: sample.voiceSignature } : {}),
    ...(sample.speakerFingerprint
      ? { speakerFingerprint: sample.speakerFingerprint }
      : {}),
  };

  await setDoc(
    doc(firebaseDb, "users", uid, "voiceSamples", cloudId),
    cloudSample,
  );
  return cloudSample;
}

export function subscribeToVoiceSamples(
  uid: string,
  onSamples: (samples: CloudVoiceSample[]) => void,
  onError: (error: Error) => void,
) {
  const samplesQuery = query(
    collection(firebaseDb, "users", uid, "voiceSamples"),
    orderBy("createdAt", "desc"),
  );
  return onSnapshot(
    samplesQuery,
    (snapshot) => {
      onSamples(
        snapshot.docs.map((sampleDoc) => ({
          ...(sampleDoc.data() as Omit<CloudVoiceSample, "cloudId">),
          cloudId: sampleDoc.id,
        })),
      );
    },
    onError,
  );
}

export async function downloadVoiceSample(
  sample: Pick<CloudVoiceSample, "audioBytes" | "mimeType">,
) {
  const storedBytes = sample.audioBytes.toUint8Array();
  const audioBuffer = new ArrayBuffer(storedBytes.byteLength);
  new Uint8Array(audioBuffer).set(storedBytes);
  return new Blob([audioBuffer], { type: sample.mimeType });
}

export async function deleteCloudVoiceSample(
  uid: string,
  sample: Pick<CloudVoiceSample, "cloudId">,
) {
  await deleteDoc(doc(firebaseDb, "users", uid, "voiceSamples", sample.cloudId));
}

export async function loadCloudCorrections(uid: string) {
  const snapshot = await getDoc(doc(firebaseDb, "users", uid, "profiles", "default"));
  if (!snapshot.exists()) return [];
  return (snapshot.data().corrections ?? []) as CloudCorrection[];
}

export async function saveCloudCorrections(
  uid: string,
  corrections: CloudCorrection[],
) {
  await setDoc(
    doc(firebaseDb, "users", uid, "profiles", "default"),
    { corrections, updatedAt: new Date().toISOString() },
    { merge: true },
  );
}
