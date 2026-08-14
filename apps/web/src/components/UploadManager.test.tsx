import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  Link,
  MemoryRouter,
  Route,
  Routes,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { APIError, api, putUploadPart } from "../lib/api";
import { hashFile } from "../lib/hash-file";
import {
  listPersistedUploads,
  persistUpload,
  removePersistedUploads,
  type PersistedUpload,
} from "../lib/upload-db";
import {
  UploadManagerProvider,
  useUploadManager,
} from "./UploadManager";
import type { UploadPartURL, UploadSession } from "../types";

vi.mock("../lib/hash-file", () => ({ hashFile: vi.fn() }));
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, putUploadPart: vi.fn() };
});
vi.mock("../lib/upload-db", () => ({
  listPersistedUploads: vi.fn(),
  persistUpload: vi.fn(async () => undefined),
  removePersistedUploads: vi.fn(async () => undefined),
}));

type UploadManager = ReturnType<typeof useUploadManager>;

const mountedRoots: Root[] = [];
let manager: UploadManager | null = null;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function persistedUpload(
  index: number,
  overrides: Partial<PersistedUpload> = {},
): PersistedUpload {
  return {
    owner_id: "listener@example.com",
    local_id: `local-${index}`,
    file_name: `track-${index}.mp3`,
    size_bytes: 1024,
    content_type: "audio/mpeg",
    last_modified: index + 1,
    status: "uploading",
    uploaded_bytes: 0,
    uploaded_parts: [],
    created_at: new Date(Date.UTC(2026, 7, 14, 0, 0, index)).toISOString(),
    ...overrides,
  };
}

function selectedFile(row: PersistedUpload) {
  return new File([new Uint8Array(row.size_bytes)], row.file_name, {
    type: row.content_type,
    lastModified: row.last_modified,
  });
}

function uploadSession(
  id: string,
  status: UploadSession["status"] = "processing",
): UploadSession {
  return {
    id,
    file_name: `${id}.mp3`,
    size_bytes: 1024,
    content_type: "audio/mpeg",
    sha256: "a".repeat(64),
    status,
    part_size: 8 * 1024 * 1024,
    uploaded_parts: [],
    created_at: "2026-08-14T00:00:00Z",
  };
}

function CaptureManager({ label = "manager" }: { label?: string }) {
  manager = useUploadManager();
  return (
    <div data-label={label} data-ready={String(manager.ready)}>
      {manager.items.map((item) => (
        <span key={item.localId} data-local-id={item.localId}>
          {item.status}
        </span>
      ))}
    </div>
  );
}

function renderProvider(
  children = <CaptureManager />,
  options: { userKey?: string; onUnauthorized?: () => void } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  act(() => {
    root.render(
      <UploadManagerProvider
        enabled
        userKey={options.userKey ?? "listener@example.com"}
        onUnauthorized={options.onUnauthorized}
      >
        {children}
      </UploadManagerProvider>,
    );
  });
  return container;
}

function renderProviderFor(
  root: Root,
  userKey: string,
  options: { enabled?: boolean; onUnauthorized?: () => void } = {},
) {
  root.render(
    <UploadManagerProvider
      enabled={options.enabled ?? true}
      userKey={userKey}
      onUnauthorized={options.onUnauthorized}
    >
      <CaptureManager />
    </UploadManagerProvider>,
  );
}

async function waitUntilReady() {
  await act(async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await Promise.resolve();
      if (manager?.ready) return;
    }
  });
  expect(manager?.ready).toBe(true);
}

beforeEach(() => {
  manager = null;
  vi.mocked(listPersistedUploads).mockResolvedValue([]);
  vi.spyOn(api, "getUploads").mockResolvedValue([]);
  vi.mocked(putUploadPart).mockResolvedValue({ etag: "part-etag" });
  vi.mocked(hashFile).mockImplementation(
    (_file, _onProgress, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Hashing paused", "AbortError")),
        { once: true },
      );
    }),
  );
});

afterEach(() => {
  while (mountedRoots.length) {
    act(() => mountedRoots.pop()?.unmount());
  }
  document.body.replaceChildren();
  manager = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("UploadManager recovery", () => {
  it("accepts all 50 original files when a full 50-row queue needs reselecting", async () => {
    const persisted = Array.from({ length: 50 }, (_, index) =>
      persistedUpload(index),
    );
    vi.mocked(listPersistedUploads).mockResolvedValue(persisted);
    renderProvider();
    await waitUntilReady();

    const files = persisted.map(selectedFile);
    act(() => manager!.addFiles(files));

    expect(manager!.items).toHaveLength(50);
    expect(manager!.pageError).toBeNull();
    expect(manager!.items.every((item) => item.file instanceof File)).toBe(true);
    expect(new Set(manager!.items.map((item) => item.localId)).size).toBe(50);
    expect(manager!.items.map((item) => item.file)).toEqual(
      manager!.items.map((item) =>
        files.find((file) => file.name === item.fileName),
      ),
    );
  });

  it("does not report restoration ready until local and remote state are merged", async () => {
    const local = deferred<PersistedUpload[]>();
    const remote = deferred<UploadSession[]>();
    vi.mocked(listPersistedUploads).mockReturnValue(local.promise);
    vi.mocked(api.getUploads).mockReturnValue(remote.promise);

    renderProvider();
    expect(manager!.ready).toBe(false);
    expect(manager!.items).toEqual([]);

    await act(async () => {
      local.resolve([persistedUpload(1)]);
      await Promise.resolve();
    });
    expect(manager!.ready).toBe(false);
    expect(manager!.items).toEqual([]);

    await act(async () => {
      remote.resolve([]);
      await local.promise;
      await remote.promise;
      await Promise.resolve();
    });
    expect(manager!.ready).toBe(true);
    expect(manager!.items).toHaveLength(1);
    expect(manager!.items[0].status).toBe("needs_file");
  });

  it("counts only unmatched files against the 50-row capacity", async () => {
    const persisted = Array.from({ length: 49 }, (_, index) =>
      persistedUpload(index),
    );
    vi.mocked(listPersistedUploads).mockResolvedValue(persisted);
    renderProvider();
    await waitUntilReady();

    const originalFiles = persisted.map(selectedFile);
    const newFile = new File([new Uint8Array(1024)], "new-track.mp3", {
      type: "audio/mpeg",
      lastModified: 100,
    });
    act(() => manager!.addFiles([...originalFiles, newFile]));

    expect(manager!.items).toHaveLength(50);
    expect(manager!.pageError).toBeNull();
    expect(manager!.items.some((item) => item.file === newFile)).toBe(true);

    const overflow = new File([new Uint8Array(1024)], "overflow.mp3", {
      type: "audio/mpeg",
      lastModified: 101,
    });
    act(() => manager!.addFiles([overflow]));

    expect(manager!.items).toHaveLength(50);
    expect(manager!.items.some((item) => item.file === overflow)).toBe(false);
    expect(manager!.pageError).toContain("up to 50 files");
  });

  it("reselects only the requested row when metadata is otherwise ambiguous", async () => {
    const persisted = [
      persistedUpload(1, {
        file_name: "same.mp3",
        last_modified: 10,
      }),
      persistedUpload(2, {
        file_name: "same.mp3",
        last_modified: 20,
      }),
    ];
    vi.mocked(listPersistedUploads).mockResolvedValue(persisted);
    renderProvider();
    await waitUntilReady();

    const targetID = "local-1";
    const wrongFile = new File([new Uint8Array(1024)], "other.mp3", {
      type: "audio/mpeg",
      lastModified: 30,
    });
    act(() => manager!.reselectFile(targetID, wrongFile));

    let target = manager!.items.find((item) => item.localId === targetID)!;
    let other = manager!.items.find((item) => item.localId !== targetID)!;
    expect(target.file).toBeUndefined();
    expect(target.status).toBe("needs_file");
    expect(target.error).toContain("same.mp3");
    expect(other.file).toBeUndefined();
    expect(other.status).toBe("needs_file");

    const file = new File([new Uint8Array(1024)], "same.mp3", {
      type: "audio/mpeg",
      lastModified: 30,
    });
    act(() => manager!.reselectFile(targetID, file));

    target = manager!.items.find((item) => item.localId === targetID)!;
    other = manager!.items.find((item) => item.localId !== targetID)!;
    expect(target.file).toBe(file);
    expect(["queued", "hashing"]).toContain(target.status);
    expect(other.status).toBe("needs_file");
    expect(other.file).toBeUndefined();
  });

  it("keeps the selected File and active work when the Add route unmounts", async () => {
    let hashingSignal: AbortSignal | undefined;
    vi.mocked(hashFile).mockImplementation(
      (_file, _onProgress, signal) => new Promise((_resolve, reject) => {
        hashingSignal = signal;
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Hashing paused", "AbortError")),
          { once: true },
        );
      }),
    );

    const container = renderProvider(
      <MemoryRouter initialEntries={["/add"]}>
        <nav>
          <Link to="/search">Search</Link>
          <Link to="/add">Add</Link>
        </nav>
        <Routes>
          <Route path="/add" element={<CaptureManager label="add" />} />
          <Route path="/search" element={<p>Search route</p>} />
        </Routes>
      </MemoryRouter>,
    );
    await waitUntilReady();

    const file = new File([new Uint8Array(1024)], "route-safe.mp3", {
      type: "audio/mpeg",
      lastModified: 10,
    });
    act(() => manager!.addFiles([file]));
    await act(async () => { await Promise.resolve(); });
    expect(hashFile).toHaveBeenCalledTimes(1);
    expect(manager!.items[0].file).toBe(file);
    expect(hashingSignal?.aborted).toBe(false);

    act(() => {
      container.querySelector<HTMLAnchorElement>('a[href="/search"]')!.click();
    });
    expect(container.textContent).toContain("Search route");
    expect(hashingSignal?.aborted).toBe(false);

    act(() => {
      container.querySelector<HTMLAnchorElement>('a[href="/add"]')!.click();
    });
    expect(container.querySelector('[data-label="add"]')).not.toBeNull();
    expect(manager!.items[0].file).toBe(file);
    expect(manager!.items[0].status).toBe("hashing");
    expect(hashFile).toHaveBeenCalledTimes(1);
  });

  it("warns before reload whenever a nonterminal queue row retains a File", async () => {
    const persisted = persistedUpload(1, { file_name: "volatile.mp3" });
    vi.mocked(listPersistedUploads).mockResolvedValue([persisted]);
    renderProvider();
    await waitUntilReady();

    const needsFileEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(needsFileEvent);
    expect(manager!.items[0].status).toBe("needs_file");
    expect(needsFileEvent.defaultPrevented).toBe(false);

    const file = selectedFile(persisted);
    act(() => manager!.addFiles([file]));
    const activeEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(activeEvent);
    expect(activeEvent.defaultPrevented).toBe(true);

    act(() => manager!.pause(manager!.items[0]));
    await act(async () => { await Promise.resolve(); });
    const pausedEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(pausedEvent);
    expect(pausedEvent.defaultPrevented).toBe(true);
  });

  it("aborts active work and clears volatile queue state when the user changes", async () => {
    let hashingSignal: AbortSignal | undefined;
    vi.mocked(hashFile).mockImplementation(
      (_file, _onProgress, signal) => new Promise((_resolve, reject) => {
        hashingSignal = signal;
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Hashing paused", "AbortError")),
          { once: true },
        );
      }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    const renderForUser = (userKey: string, enabled = true) => {
      root.render(
        <UploadManagerProvider enabled={enabled} userKey={userKey}>
          <CaptureManager />
        </UploadManagerProvider>,
      );
    };

    act(() => renderForUser("user-a"));
    await waitUntilReady();
    const file = new File([new Uint8Array(1024)], "private-to-a.mp3", {
      type: "audio/mpeg",
      lastModified: 10,
    });
    act(() => manager!.addFiles([file]));
    await act(async () => { await Promise.resolve(); });
    expect(manager!.items[0].file).toBe(file);
    expect(hashingSignal?.aborted).toBe(false);

    act(() => renderForUser("user-b"));
    expect(hashingSignal?.aborted).toBe(true);
    await waitUntilReady();
    expect(manager!.items).toEqual([]);

    act(() => renderForUser("user-b", false));
    expect(manager!.items).toEqual([]);
    expect(manager!.ready).toBe(false);
  });

  it("does not start a PUT when paused while a part URL is still pending", async () => {
    const partURL = deferred<UploadPartURL>();
    vi.mocked(hashFile).mockResolvedValue("a".repeat(64));
    vi.spyOn(api, "createUpload").mockResolvedValue({
      id: "session-1",
      file_name: "pause-before-put.mp3",
      size_bytes: 1024,
      content_type: "audio/mpeg",
      sha256: "a".repeat(64),
      status: "uploading",
      part_size: 8 * 1024 * 1024,
      uploaded_parts: [],
      created_at: "2026-08-14T00:00:00Z",
    });
    vi.spyOn(api, "getUploadPartURL").mockReturnValue(partURL.promise);
    renderProvider();
    await waitUntilReady();

    const file = new File([new Uint8Array(1024)], "pause-before-put.mp3", {
      type: "audio/mpeg",
      lastModified: 10,
    });
    act(() => manager!.addFiles([file]));
    await act(async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await Promise.resolve();
        if (vi.mocked(api.getUploadPartURL).mock.calls.length > 0) break;
      }
    });
    expect(api.getUploadPartURL).toHaveBeenCalledTimes(1);

    act(() => manager!.pause(manager!.items[0]));
    expect(manager!.items[0].status).toBe("paused");

    await act(async () => {
      partURL.resolve({
        part_number: 1,
        upload_url: "https://r2.example.test/part",
      });
      await partURL.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(putUploadPart).not.toHaveBeenCalled();
    expect(manager!.items[0].status).toBe("paused");
  });

  it("keeps a late-created session resumable when paused during createUpload", async () => {
    const createUpload = deferred<UploadSession>();
    const session = {
      ...uploadSession("created-after-pause", "uploading"),
      file_name: "created-after-pause.mp3",
    };
    vi.mocked(hashFile).mockResolvedValue(session.sha256);
    vi.spyOn(api, "createUpload").mockReturnValue(createUpload.promise);
    renderProvider();
    await waitUntilReady();

    const file = new File([new Uint8Array(1024)], session.file_name, {
      type: "audio/mpeg",
      lastModified: 10,
    });
    act(() => manager!.addFiles([file]));
    await act(async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await Promise.resolve();
        if (vi.mocked(api.createUpload).mock.calls.length > 0) break;
      }
    });
    expect(api.createUpload).toHaveBeenCalledTimes(1);

    act(() => manager!.pause(manager!.items[0]));
    await act(async () => {
      createUpload.resolve(session);
      await createUpload.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(manager!.items[0]).toMatchObject({
      sessionId: session.id,
      status: "paused",
      file,
    });
    expect(putUploadPart).not.toHaveBeenCalled();
    expect(vi.mocked(persistUpload).mock.calls.some(
      ([upload]) => upload.session_id === session.id && upload.owner_id === "listener@example.com",
    )).toBe(true);
  });

  it("applies an authoritative processing response when paused during completeUpload", async () => {
    const session = {
      ...uploadSession("completing-session", "uploading"),
      file_name: "completing-session.mp3",
    };
    const completion = deferred<UploadSession>();
    vi.mocked(hashFile).mockResolvedValue(session.sha256);
    vi.spyOn(api, "createUpload").mockResolvedValue(session);
    vi.spyOn(api, "getUploadPartURL").mockResolvedValue({
      part_number: 1,
      upload_url: "https://r2.example.test/completing-part",
    });
    vi.spyOn(api, "completeUpload").mockReturnValue(completion.promise);
    renderProvider();
    await waitUntilReady();

    const file = new File([new Uint8Array(1024)], session.file_name, {
      type: "audio/mpeg",
      lastModified: 10,
    });
    act(() => manager!.addFiles([file]));
    await act(async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await Promise.resolve();
        if (vi.mocked(api.completeUpload).mock.calls.length > 0) break;
      }
    });
    expect(api.completeUpload).toHaveBeenCalledTimes(1);

    act(() => manager!.pause(manager!.items[0]));
    expect(manager!.items[0].status).toBe("paused");
    await act(async () => {
      completion.resolve({ ...session, status: "processing" });
      await completion.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(manager!.items[0]).toMatchObject({
      sessionId: session.id,
      status: "processing",
      progress: 1,
    });
    expect(manager!.items[0].file).toBeUndefined();
  });

  it("accepts a renamed same-size reselect only when SHA-256 can verify it", async () => {
    const rows = [
      persistedUpload(1, { sha256: "a".repeat(64) }),
      persistedUpload(2, { sha256: undefined }),
    ];
    vi.mocked(listPersistedUploads).mockResolvedValue(rows);
    renderProvider();
    await waitUntilReady();

    const verifiable = new File([new Uint8Array(1024)], "renamed.mp3", {
      type: "audio/mpeg",
      lastModified: 10,
    });
    const unverifiable = new File([new Uint8Array(1024)], "also-renamed.mp3", {
      type: "audio/mpeg",
      lastModified: 20,
    });
    act(() => {
      manager!.reselectFile(rows[0].local_id, verifiable);
      manager!.reselectFile(rows[1].local_id, unverifiable);
    });

    const hashed = manager!.items.find((item) => item.localId === rows[0].local_id)!;
    const unhashed = manager!.items.find((item) => item.localId === rows[1].local_id)!;
    expect(hashed.file).toBe(verifiable);
    expect(["queued", "hashing"]).toContain(hashed.status);
    expect(unhashed.file).toBeUndefined();
    expect(unhashed.status).toBe("needs_file");
    expect(unhashed.error).toContain(rows[1].file_name);
  });

  it("loads and persists queue metadata under the active account only", async () => {
    const rows = [
      persistedUpload(1, { owner_id: "user-a", local_id: "only-a" }),
      persistedUpload(2, { owner_id: "user-b", local_id: "only-b" }),
    ];
    vi.mocked(listPersistedUploads).mockImplementation(async (ownerID) =>
      rows.filter((row) => row.owner_id === ownerID),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);

    act(() => renderProviderFor(root, "user-a"));
    await waitUntilReady();
    expect(manager!.items.map((item) => item.localId)).toEqual(["only-a"]);
    expect(listPersistedUploads).toHaveBeenLastCalledWith("user-a");

    const file = new File([new Uint8Array(1024)], "owned-by-a.mp3", {
      type: "audio/mpeg",
      lastModified: 10,
    });
    act(() => manager!.addFiles([file]));
    expect(vi.mocked(persistUpload).mock.calls.some(
      ([upload]) => upload.owner_id === "user-a" && upload.file_name === file.name,
    )).toBe(true);

    act(() => renderProviderFor(root, "user-b"));
    await waitUntilReady();
    expect(manager!.items.map((item) => item.localId)).toEqual(["only-b"]);
    expect(manager!.items.every((item) => item.file !== file)).toBe(true);
    expect(listPersistedUploads).toHaveBeenLastCalledWith("user-b");
  });

  it("retains the File after a failed cancel and retries through normal resume", async () => {
    const session = {
      ...uploadSession("cancel-session", "uploading"),
      file_name: "cancel-safe.mp3",
    };
    const persisted = persistedUpload(1, {
      session_id: session.id,
      file_name: session.file_name,
      sha256: session.sha256,
    });
    vi.mocked(listPersistedUploads).mockResolvedValue([persisted]);
    vi.mocked(api.getUploads).mockResolvedValue([session]);
    vi.spyOn(api, "cancelUpload").mockRejectedValue(new Error("Network offline"));
    const getUpload = vi.spyOn(api, "getUpload").mockResolvedValue(session);
    const retryUpload = vi.spyOn(api, "retryUpload");
    vi.spyOn(api, "getUploadPartURL").mockReturnValue(new Promise(() => undefined));
    renderProvider();
    await waitUntilReady();

    const file = selectedFile(persisted);
    act(() => manager!.reselectFile(persisted.local_id, file));
    await act(async () => { await Promise.resolve(); });
    expect(manager!.items[0].file).toBe(file);

    await act(async () => {
      await manager!.cancel(manager!.items[0]);
      await Promise.resolve();
    });
    expect(manager!.items[0]).toMatchObject({
      status: "error",
      file,
      error: "Network offline",
    });
    const failedCancelEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(failedCancelEvent);
    expect(failedCancelEvent.defaultPrevented).toBe(true);

    vi.mocked(hashFile).mockResolvedValue(session.sha256);
    await act(async () => {
      await manager!.retry(manager!.items[0]);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await Promise.resolve();
        if (getUpload.mock.calls.length > 0) break;
      }
    });
    expect(retryUpload).not.toHaveBeenCalled();
    expect(getUpload).toHaveBeenCalledWith(session.id, expect.any(AbortSignal));
    expect(manager!.items[0].file).toBe(file);
    expect(["queued", "hashing", "uploading"]).toContain(manager!.items[0].status);
  });

  it("keeps processing polling single-flight while a request is pending", async () => {
    vi.useFakeTimers();
    const session = uploadSession("processing-single-flight");
    vi.mocked(listPersistedUploads).mockResolvedValue([
      persistedUpload(1, {
        session_id: session.id,
        file_name: session.file_name,
        status: "processing",
      }),
    ]);
    vi.mocked(api.getUploads).mockResolvedValue([session]);
    const firstPoll = deferred<UploadSession>();
    const getUpload = vi.spyOn(api, "getUpload")
      .mockReturnValueOnce(firstPoll.promise)
      .mockResolvedValue(session);
    renderProvider();
    await waitUntilReady();

    act(() => vi.advanceTimersByTime(4000));
    expect(getUpload).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(12_000));
    expect(getUpload).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstPoll.resolve(session);
      await firstPoll.promise;
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(3999));
    expect(getUpload).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    expect(getUpload).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale processing response after the account changes", async () => {
    vi.useFakeTimers();
    const sessionA = uploadSession("processing-a");
    const sessionB = uploadSession("processing-b");
    vi.mocked(listPersistedUploads).mockImplementation(async (ownerID) => [
      persistedUpload(1, {
        owner_id: ownerID,
        local_id: "same-local-id",
        session_id: ownerID === "user-a" ? sessionA.id : sessionB.id,
        file_name: ownerID === "user-a" ? sessionA.file_name : sessionB.file_name,
        status: "processing",
      }),
    ]);
    vi.mocked(api.getUploads)
      .mockResolvedValueOnce([sessionA])
      .mockResolvedValueOnce([sessionB]);
    const oldPoll = deferred<UploadSession>();
    const getUpload = vi.spyOn(api, "getUpload").mockImplementation((id) =>
      id === sessionA.id ? oldPoll.promise : Promise.resolve(sessionB),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);

    act(() => renderProviderFor(root, "user-a"));
    await waitUntilReady();
    act(() => vi.advanceTimersByTime(4000));
    expect(getUpload).toHaveBeenCalledWith(sessionA.id, expect.any(AbortSignal));
    const oldSignal = getUpload.mock.calls[0][1]!;

    act(() => renderProviderFor(root, "user-b"));
    await waitUntilReady();
    expect(oldSignal.aborted).toBe(true);
    expect(manager!.items[0].sessionId).toBe(sessionB.id);

    await act(async () => {
      oldPoll.resolve({ ...sessionA, status: "ready" });
      await oldPoll.promise;
      await Promise.resolve();
    });
    expect(manager!.items).toHaveLength(1);
    expect(manager!.items[0]).toMatchObject({
      localId: "same-local-id",
      sessionId: sessionB.id,
      status: "processing",
    });
  });

  it.each([401, 403])(
    "ends processing polling and signs out on HTTP %s",
    async (status) => {
      vi.useFakeTimers();
      const session = uploadSession(`processing-auth-${status}`);
      vi.mocked(listPersistedUploads).mockResolvedValue([
        persistedUpload(status, {
          session_id: session.id,
          file_name: session.file_name,
          status: "processing",
        }),
      ]);
      vi.mocked(api.getUploads).mockResolvedValue([session]);
      const onUnauthorized = vi.fn();
      const getUpload = vi.spyOn(api, "getUpload").mockRejectedValue(
        new APIError(status, {
          code: status === 401 ? "unauthorized" : "forbidden",
          message: "Session expired",
        }),
      );
      renderProvider(<CaptureManager />, { onUnauthorized });
      await waitUntilReady();

      await act(async () => {
        vi.advanceTimersByTime(4000);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(12_000));
      expect(getUpload).toHaveBeenCalledTimes(1);
    },
  );

  it("removes a processing row when the server returns 404", async () => {
    vi.useFakeTimers();
    const session = uploadSession("processing-gone");
    const persisted = persistedUpload(1, {
      session_id: session.id,
      file_name: session.file_name,
      status: "processing",
    });
    vi.mocked(listPersistedUploads).mockResolvedValue([persisted]);
    vi.mocked(api.getUploads).mockResolvedValue([session]);
    vi.spyOn(api, "getUpload").mockRejectedValue(
      new APIError(404, {
        code: "upload_not_found",
        message: "Upload not found",
      }),
    );
    renderProvider();
    await waitUntilReady();

    await act(async () => {
      vi.advanceTimersByTime(4000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(manager!.items).toEqual([]);
    expect(removePersistedUploads).toHaveBeenCalledWith(
      "listener@example.com",
      [persisted.local_id],
    );
  });

  it("restores durable metadata as needs-file after a full reload", async () => {
    const persisted = persistedUpload(1, {
      sha256: "a".repeat(64),
      uploaded_bytes: 512,
    });
    vi.mocked(listPersistedUploads).mockResolvedValue([persisted]);

    renderProvider();
    await waitUntilReady();

    expect(manager!.items).toHaveLength(1);
    expect(manager!.items[0]).toMatchObject({
      localId: persisted.local_id,
      status: "needs_file",
      progress: 0.5,
      sha256: persisted.sha256,
    });
    expect(manager!.items[0].file).toBeUndefined();
    expect(hashFile).not.toHaveBeenCalled();
  });
});
