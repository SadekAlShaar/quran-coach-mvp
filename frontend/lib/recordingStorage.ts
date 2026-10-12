const DB_NAME = "quran-coach";
const DB_VERSION = 1;
const STORE_NAME = "last-recordings";

type StoredRecording = {
  id: string;
  profile: string;
  surahNo: number;
  ayahNo: number;
  mimeType: string;
  createdAt: string;
  data: ArrayBuffer;
};

export type LastRecording = {
  blob: Blob;
  createdAt: string;
};

function recordingId(profile: string, surahNo: number, ayahNo: number) {
  return `${profile}:${surahNo}:${ayahNo}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open recording database."));
  });
}

export async function saveLastRecording(
  profile: string,
  surahNo: number,
  ayahNo: number,
  blob: Blob
): Promise<string> {
  const db = await openDb();
  const createdAt = new Date().toISOString();
  const data = await blob.arrayBuffer();

  const value: StoredRecording = {
    id: recordingId(profile, surahNo, ayahNo),
    profile,
    surahNo,
    ayahNo,
    mimeType: blob.type || "audio/webm",
    createdAt,
    data,
  };

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value); // put replaces the previous recording for this exact ayah/profile.
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not save recording."));
    tx.onabort = () => reject(tx.error ?? new Error("Recording save was aborted."));
  });

  db.close();
  return createdAt;
}

export async function getLastRecording(
  profile: string,
  surahNo: number,
  ayahNo: number
): Promise<LastRecording | null> {
  const db = await openDb();

  const result = await new Promise<StoredRecording | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(recordingId(profile, surahNo, ayahNo));
    request.onsuccess = () => resolve(request.result as StoredRecording | undefined);
    request.onerror = () => reject(request.error ?? new Error("Could not read recording."));
  });

  db.close();
  if (!result) return null;

  return {
    blob: new Blob([result.data], { type: result.mimeType }),
    createdAt: result.createdAt,
  };
}

export async function deleteLastRecording(
  profile: string,
  surahNo: number,
  ayahNo: number
): Promise<void> {
  const db = await openDb();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(recordingId(profile, surahNo, ayahNo));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not delete recording."));
    tx.onabort = () => reject(tx.error ?? new Error("Recording delete was aborted."));
  });

  db.close();
}
