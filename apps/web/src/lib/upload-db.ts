import type { UploadedPart } from "../types";

const DB_NAME = "antolex-music";
const STORE_NAME = "upload-metadata";
let databasePromise: Promise<IDBDatabase> | null = null;

export type PersistedUpload = {
  local_id: string;
  session_id?: string;
  file_name: string;
  size_bytes: number;
  content_type: string;
  last_modified: number;
  sha256?: string;
  status: string;
  uploaded_bytes: number;
  uploaded_parts: UploadedPart[];
  error?: string;
  created_at: string;
};

function openDatabase() {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "local_id" });
      }
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open upload storage"));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
  });
  databasePromise.catch(() => {
    databasePromise = null;
  });
  return databasePromise;
}

export async function listPersistedUploads(): Promise<PersistedUpload[]> {
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result as PersistedUpload[]);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return [];
  }
}

export async function persistUpload(upload: PersistedUpload) {
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const request = db
        .transaction(STORE_NAME, "readwrite")
        .objectStore(STORE_NAME)
        .put(upload);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // Uploading still works when private browsing blocks IndexedDB.
  }
}
