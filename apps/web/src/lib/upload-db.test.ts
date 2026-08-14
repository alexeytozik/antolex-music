import { afterEach, describe, expect, it, vi } from "vitest";

import type { PersistedUpload } from "./upload-db";
import type { UploadQueueItem } from "./upload-queue";

function upload(
  localID: string,
  ownerID?: string,
): PersistedUpload {
  return {
    owner_id: ownerID,
    local_id: localID,
    file_name: `${localID}.mp3`,
    size_bytes: 1024,
    content_type: "audio/mpeg",
    last_modified: 1,
    status: "uploading",
    uploaded_bytes: 0,
    uploaded_parts: [],
    created_at: "2026-08-14T00:00:00Z",
  };
}

function fakeIndexedDBForV1Upgrade() {
  const createIndex = vi.fn();
  const getAll = vi.fn(() => {
    const request = {
      result: [] as PersistedUpload[],
      error: null,
      onsuccess: null as ((event: Event) => void) | null,
      onerror: null as ((event: Event) => void) | null,
    };
    queueMicrotask(() => request.onsuccess?.(new Event("success")));
    return request;
  });
  const store = {
    createIndex,
    indexNames: { contains: vi.fn(() => false) },
    index: vi.fn(() => ({ getAll })),
  };
  const transaction = {
    objectStore: vi.fn(() => store),
  };
  const database = {
    objectStoreNames: { contains: vi.fn(() => true) },
    transaction: vi.fn(() => transaction),
    createObjectStore: vi.fn(() => store),
    deleteObjectStore: vi.fn(),
    close: vi.fn(),
    onversionchange: null as (() => void) | null,
  };
  const open = vi.fn(() => {
    const request = {
      result: database,
      transaction,
      error: null,
      onupgradeneeded: null as ((event: { oldVersion: number }) => void) | null,
      onerror: null as ((event: Event) => void) | null,
      onsuccess: null as ((event: Event) => void) | null,
    };
    queueMicrotask(() => {
      request.onupgradeneeded?.({ oldVersion: 1 });
      request.onsuccess?.(new Event("success"));
    });
    return request;
  });
  return {
    indexedDB: { open },
    open,
    createIndex,
    createObjectStore: database.createObjectStore,
    deleteObjectStore: database.deleteObjectStore,
    getAll,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("account-scoped upload metadata", () => {
  it("keeps account A, account B, and legacy unowned rows isolated", async () => {
    const { filterPersistedUploadsForOwner } = await import("./upload-db");
    const rows = [upload("a", "user-a"), upload("b", "user-b"), upload("legacy")];

    expect(filterPersistedUploadsForOwner(rows, "user-a")).toEqual([rows[0]]);
    expect(filterPersistedUploadsForOwner(rows, "user-b")).toEqual([rows[1]]);
    expect(filterPersistedUploadsForOwner(rows, "missing-user")).toEqual([]);
  });

  it("clears ownerless v1 metadata while upgrading the database to v2", async () => {
    const fake = fakeIndexedDBForV1Upgrade();
    vi.stubGlobal("indexedDB", fake.indexedDB);
    const { listPersistedUploads } = await import("./upload-db");

    await expect(listPersistedUploads("user-a")).resolves.toEqual([]);

    expect(fake.open).toHaveBeenCalledWith("antolex-music", 2);
    expect(fake.deleteObjectStore).toHaveBeenCalledWith("upload-metadata");
    expect(fake.createObjectStore).toHaveBeenCalledWith("upload-metadata", {
      keyPath: ["owner_id", "local_id"],
    });
    expect(fake.createIndex).toHaveBeenCalledWith("owner-id", "owner_id", {
      unique: false,
    });
  });

  it("never opens IndexedDB to persist an ownerless row", async () => {
    const open = vi.fn();
    vi.stubGlobal("indexedDB", { open });
    const { persistUpload } = await import("./upload-db");

    await persistUpload(upload("legacy"));

    expect(open).not.toHaveBeenCalled();
  });

  it("serializes new queue rows with their current owner", async () => {
    const { toPersistedUpload } = await import("./upload-queue");
    const item: UploadQueueItem = {
      localId: "local-new",
      fileName: "new.mp3",
      sizeBytes: 1024,
      contentType: "audio/mpeg",
      lastModified: 1,
      status: "queued",
      progress: 0,
      uploadedParts: [],
      createdAt: "2026-08-14T00:00:00Z",
    };

    expect(toPersistedUpload(item, "user-a")).toMatchObject({
      owner_id: "user-a",
      local_id: item.localId,
    });
  });
});
