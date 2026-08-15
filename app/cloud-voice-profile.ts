import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  setDoc,
} from "firebase/firestore";
import {
  deleteObject,
  getBlob,
  ref,
  uploadBytes,
} from "firebase/storage";
import { firebaseDb, firebaseStorage } from "./firebase";

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
  source: "guided" | "correction";
  heard?: string;
  durationMs?: number;
  storagePath: string;
  synced: true;
};

type UploadableSample = Omit<CloudVoiceSample, "cloudId" | "storagePath" | "synced"> & {
  cloudId?: string;
  blob: Blob;
};

export async function uploadVoiceSample(uid: string, sample: UploadableSample) {
  const cloudId = sample.cloudId ?? crypto.randomUUID();
  const extension = sample.mimeType.includes("ogg") ? "ogg" : "webm";
  const storagePath = `users/${uid}/voice-samples/${cloudId}.${extension}`;

  await uploadBytes(ref(firebaseStorage, storagePath), sample.blob, {
    contentType: sample.mimeType,
    customMetadata: { ownerUid: uid },
  });

  const cloudSample: CloudVoiceSample = {
    cloudId,
    phrase: sample.phrase,
    mimeType: sample.mimeType,
    createdAt: sample.createdAt,
    source: sample.source,
    storagePath,
    synced: true,
    ...(sample.heard ? { heard: sample.heard } : {}),
    ...(sample.durationMs ? { durationMs: sample.durationMs } : {}),
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

export async function downloadVoiceSample(storagePath: string) {
  return getBlob(ref(firebaseStorage, storagePath));
}

export async function deleteCloudVoiceSample(
  uid: string,
  sample: Pick<CloudVoiceSample, "cloudId" | "storagePath">,
) {
  await Promise.all([
    deleteDoc(doc(firebaseDb, "users", uid, "voiceSamples", sample.cloudId)),
    deleteObject(ref(firebaseStorage, sample.storagePath)),
  ]);
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
