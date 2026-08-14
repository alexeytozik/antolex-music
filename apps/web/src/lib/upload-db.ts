import type { UploadedPart } from "../types";

const DB_NAME = "antolex-music";
const STORE_NAME = "upload-metadata";
const OWNER_INDEX = "owner-id";
const DB_VERSION = 2;
let databasePromise: Promise<IDBDatabase> | null = null;

export type PersistedUpload = {
  owner_id?: string;
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
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      let store: IDBObjectStore;
      if (event.oldVersion < 2) {
        // Version 1 did not record an owner. Recreate the metadata-only store
        // with an owner-scoped key instead of exposing its rows to any account.
        if (request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.deleteObjectStore(STORE_NAME);
        }
        store = request.result.createObjectStore(STORE_NAME, {
          keyPath: ["owner_id", "local_id"],
        });
      } else {
        store = request.transaction!.objectStore(STORE_NAME);
      }
      if (!store.indexNames.contains(OWNER_INDEX)) {
        store.createIndex(OWNER_INDEX, "owner_id", { unique: false });
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

export function filterPersistedUploadsForOwner(
  uploads: PersistedUpload[],
  ownerID: string,
) {
  return uploads.filter((upload) => upload.owner_id === ownerID);
}

export async function listPersistedUploads(ownerID: string): Promise<PersistedUpload[]> {
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const request = db
        .transaction(STORE_NAME)
        .objectStore(STORE_NAME)
        .index(OWNER_INDEX)
        .getAll(ownerID);
      request.onsuccess = () => resolve(
        filterPersistedUploadsForOwner(request.result as PersistedUpload[], ownerID),
      );
      request.onerror = () => reject(request.error);
    });
  } catch {
    return [];
  }
}

export async function persistUpload(upload: PersistedUpload) {
  if (!upload.owner_id) return;
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

export async function removePersistedUploads(ownerID: string, localIds: string[]) {
  if (localIds.length === 0) return;
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      for (const localId of new Set(localIds)) {
        store.delete([ownerID, localId]);
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch {
    // The visible queue still stays clean when IndexedDB is unavailable.
  }
}
