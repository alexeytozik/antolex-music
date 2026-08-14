import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";

import {
  CheckIcon,
  CloseIcon,
  FolderIcon,
  PauseIcon,
  PlusIcon,
  RetryIcon,
  SpinnerIcon,
  UploadIcon,
} from "../components/Icons";
import { APIError, api, putUploadPart } from "../lib/api";
import { hashFile } from "../lib/hash-file";
import {
  listPersistedUploads,
  persistUpload,
  type PersistedUpload,
} from "../lib/upload-db";
import {
  formatFileSize,
  MAX_UPLOAD_FILES,
  MULTIPART_PART_SIZE,
  validateUploadFile,
} from "../lib/upload-validation";
import type { Track, UploadedPart, UploadSession } from "../types";

type LocalStatus =
  | "queued"
  | "needs_file"
  | "hashing"
  | "duplicate"
  | "uploading"
  | "paused"
  | "processing"
  | "ready"
  | "error"
  | "cancelled";

type UploadItem = {
  localId: string;
  sessionId?: string;
  fileName: string;
  sizeBytes: number;
  contentType: string;
  lastModified: number;
  sha256?: string;
  status: LocalStatus;
  progress: number;
  uploadedParts: UploadedPart[];
  file?: File;
  track?: Track;
  duplicateTrack?: Track;
  error?: string;
  createdAt: string;
};

function statusWithoutFile(status: string): LocalStatus {
  if (status === "processing" || status === "ready" || status === "error" || status === "cancelled") {
    return status;
  }
  return "needs_file";
}

function toPersisted(item: UploadItem): PersistedUpload {
  return {
    local_id: item.localId,
    session_id: item.sessionId,
    file_name: item.fileName,
    size_bytes: item.sizeBytes,
    content_type: item.contentType,
    last_modified: item.lastModified,
    sha256: item.sha256,
    status: item.status,
    uploaded_bytes: Math.round(item.progress * item.sizeBytes),
    uploaded_parts: item.uploadedParts,
    error: item.error,
    created_at: item.createdAt,
  };
}

function fromPersisted(item: PersistedUpload): UploadItem {
  return {
    localId: item.local_id,
    sessionId: item.session_id,
    fileName: item.file_name,
    sizeBytes: item.size_bytes,
    contentType: item.content_type,
    lastModified: item.last_modified,
    sha256: item.sha256,
    status: statusWithoutFile(item.status),
    progress: item.size_bytes ? item.uploaded_bytes / item.size_bytes : 0,
    uploadedParts: item.uploaded_parts ?? [],
    error: item.error,
    createdAt: item.created_at,
  };
}

function serverStatus(session: UploadSession): LocalStatus {
  if (session.status === "pending" || session.status === "uploading" || session.status === "paused") {
    return "needs_file";
  }
  return session.status === "deleting" ? "cancelled" : session.status;
}

export function AddView() {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [pageError, setPageError] = useState<string | null>(null);
  const [wakeQueue, setWakeQueue] = useState(0);
  const itemsRef = useRef(items);
  const activeRef = useRef<{ id: string; controller: AbortController } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  function replaceItems(next: UploadItem[]) {
    itemsRef.current = next;
    setItems(next);
  }

  function updateItem(localId: string, patch: Partial<UploadItem>) {
    let updated: UploadItem | undefined;
    const next = itemsRef.current.map((item) => {
      if (item.localId !== localId) return item;
      updated = { ...item, ...patch };
      return updated;
    });
    replaceItems(next);
    if (updated) void persistUpload(toPersisted(updated));
  }

  useEffect(() => {
    let cancelled = false;
    void Promise.all([listPersistedUploads(), api.getUploads()])
      .then(([persisted, remote]) => {
        if (cancelled) return;
        const restored = persisted.map(fromPersisted);
        for (const session of remote) {
          const index = restored.findIndex((item) => item.sessionId === session.id);
          const existing = index >= 0 ? restored[index] : undefined;
          const merged: UploadItem = {
            localId: existing?.localId ?? crypto.randomUUID(),
            sessionId: session.id,
            fileName: session.file_name,
            sizeBytes: session.size_bytes,
            contentType: session.content_type,
            lastModified: existing?.lastModified ?? 0,
            sha256: session.sha256,
            status: serverStatus(session),
            progress: session.status === "ready" || session.status === "processing" ? 1 : existing?.progress ?? 0,
            uploadedParts: session.uploaded_parts ?? existing?.uploadedParts ?? [],
            track: session.track,
            error: session.error,
            createdAt: session.created_at ?? existing?.createdAt ?? new Date().toISOString(),
          };
          if (index >= 0) restored[index] = merged;
          else restored.push(merged);
        }
        restored.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        replaceItems(restored);
      })
      .catch((reason) => {
        if (!cancelled) {
          setPageError(reason instanceof Error ? reason.message : "Could not restore uploads");
        }
      });
    return () => {
      cancelled = true;
      activeRef.current?.controller.abort();
    };
  }, []);

  useEffect(() => {
    const processing = items.filter((item) => item.status === "processing" && item.sessionId);
    if (processing.length === 0) return;
    const timer = window.setInterval(() => {
      for (const item of processing) {
        void api.getUpload(item.sessionId!).then((session) => {
          updateItem(item.localId, {
            status: serverStatus(session),
            track: session.track,
            error: session.error,
            progress: 1,
          });
        }).catch(() => undefined);
      }
    }, 4000);
    return () => window.clearInterval(timer);
  }, [items]);

  async function processOne(item: UploadItem) {
    if (!item.file || activeRef.current) return;
    const controller = new AbortController();
    activeRef.current = { id: item.localId, controller };
    try {
      updateItem(item.localId, { status: "hashing", error: undefined, progress: 0 });
      const sha256 = await hashFile(
        item.file,
        (progress) => updateItem(item.localId, { progress: progress * 0.08 }),
        controller.signal,
      );
      if (item.sha256 && item.sha256 !== sha256) {
        updateItem(item.localId, {
          status: "needs_file",
          file: undefined,
          progress: 0,
          error: "This is not the same file. Select the original file to resume.",
        });
        return;
      }
      updateItem(item.localId, { sha256 });

      let session: UploadSession;
      if (item.sessionId) {
        session = await api.getUpload(item.sessionId);
      } else {
        try {
          session = await api.createUpload({
            file_name: item.file.name,
            size_bytes: item.file.size,
            content_type: item.file.type || "application/octet-stream",
            sha256,
          });
        } catch (reason) {
          if (reason instanceof APIError && reason.code === "duplicate_track") {
            updateItem(item.localId, {
              status: "duplicate",
              progress: 1,
              duplicateTrack: reason.details?.track as Track | undefined,
              file: undefined,
            });
            return;
          }
          throw reason;
        }
        updateItem(item.localId, { sessionId: session.id });
      }

      const partSize = session.part_size || MULTIPART_PART_SIZE;
      const totalParts = Math.ceil(item.file.size / partSize);
      const parts = new Map<number, UploadedPart>();
      [...(session.uploaded_parts ?? []), ...item.uploadedParts].forEach((part) => {
        parts.set(part.part_number, part);
      });
      let uploadedBytes = Array.from(parts.values()).reduce(
        (sum, part) => sum + (part.size_bytes ?? Math.min(partSize, item.file!.size - (part.part_number - 1) * partSize)),
        0,
      );

      updateItem(item.localId, { status: "uploading", progress: uploadedBytes / item.file.size });
      for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
        if (parts.has(partNumber)) continue;
        const start = (partNumber - 1) * partSize;
        const end = Math.min(start + partSize, item.file.size);
        const target = await api.getUploadPartURL(session.id, partNumber);
        const result = await putUploadPart(
          target,
          item.file.slice(start, end),
          (partLoaded) => updateItem(item.localId, {
            status: "uploading",
            progress: Math.min((uploadedBytes + partLoaded) / item.file!.size, 0.999),
          }),
          controller.signal,
        );
        const completedPart = {
          part_number: partNumber,
          etag: result.etag,
          size_bytes: end - start,
        };
        parts.set(partNumber, completedPart);
        uploadedBytes += end - start;
        updateItem(item.localId, {
          uploadedParts: Array.from(parts.values()),
          progress: uploadedBytes / item.file.size,
        });
      }

      const completed = await api.completeUpload(session.id, Array.from(parts.values()));
      updateItem(item.localId, {
        status: serverStatus(completed),
        progress: 1,
        file: undefined,
        track: completed.track,
        error: completed.error,
      });
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === "AbortError")) {
        updateItem(item.localId, {
          status: "error",
          error: reason instanceof Error ? reason.message : "Upload failed",
        });
      }
    } finally {
      activeRef.current = null;
      setWakeQueue((value) => value + 1);
    }
  }

  useEffect(() => {
    if (activeRef.current) return;
    const next = items.find((item) => item.status === "queued" && item.file);
    if (next) void processOne(next);
  }, [items, wakeQueue]);

  function addFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    if (files.length === 0) return;
    setPageError(null);
    const liveCount = itemsRef.current.filter((item) => !["ready", "cancelled", "duplicate"].includes(item.status)).length;
    if (files.length + liveCount > MAX_UPLOAD_FILES) {
      setPageError(`A queue can contain up to ${MAX_UPLOAD_FILES} files.`);
      return;
    }

    const next = [...itemsRef.current];
    for (const file of files) {
      const validationError = validateUploadFile(file);
      const exactResumableIndex = next.findIndex(
        (item) =>
          item.status === "needs_file" &&
          item.fileName === file.name &&
          item.sizeBytes === file.size &&
          item.lastModified === file.lastModified,
      );
      const compatibleResumable = next
        .map((item, index) => ({ item, index }))
        .filter(({ item }) =>
          item.status === "needs_file" &&
          item.fileName === file.name &&
          item.sizeBytes === file.size,
        );
      const resumableIndex = exactResumableIndex >= 0
        ? exactResumableIndex
        : compatibleResumable.length === 1
          ? compatibleResumable[0].index
          : -1;
      if (resumableIndex >= 0 && !validationError) {
        next[resumableIndex] = { ...next[resumableIndex], file, status: "queued", error: undefined };
        void persistUpload(toPersisted(next[resumableIndex]));
        continue;
      }

      const item: UploadItem = {
        localId: crypto.randomUUID(),
        fileName: file.name,
        sizeBytes: file.size,
        contentType: file.type || "application/octet-stream",
        lastModified: file.lastModified,
        status: validationError ? "error" : "queued",
        progress: 0,
        uploadedParts: [],
        file: validationError ? undefined : file,
        error: validationError ?? undefined,
        createdAt: new Date().toISOString(),
      };
      next.unshift(item);
      void persistUpload(toPersisted(item));
    }
    replaceItems(next);
  }

  function pause(item: UploadItem) {
    if (activeRef.current?.id === item.localId) activeRef.current.controller.abort();
    updateItem(item.localId, { status: "paused" });
  }

  async function cancel(item: UploadItem) {
    if (activeRef.current?.id === item.localId) activeRef.current.controller.abort();
    updateItem(item.localId, { status: "cancelled", file: undefined });
    if (item.sessionId) {
      try {
        await api.cancelUpload(item.sessionId);
      } catch (reason) {
        updateItem(item.localId, {
          status: "error",
          error: reason instanceof Error ? reason.message : "Could not cancel upload",
        });
      }
    }
  }

  async function retry(item: UploadItem) {
    if (item.sessionId && item.status === "error" && !item.file) {
      try {
        const session = await api.retryUpload(item.sessionId);
        updateItem(item.localId, { status: serverStatus(session), error: undefined });
      } catch (reason) {
        updateItem(item.localId, { error: reason instanceof Error ? reason.message : "Retry failed" });
      }
      return;
    }
    updateItem(item.localId, { status: item.file ? "queued" : "needs_file", error: undefined });
  }

  return (
    <section className="view-stack" aria-labelledby="add-heading">
      <div className="view-heading">
        <div><p className="eyebrow">Your library</p><h1 id="add-heading">Add music</h1></div>
        <span className="count-pill">{items.length}</span>
      </div>

      <div className="upload-picker">
        <UploadIcon className="h-8 w-8" />
        <div><strong>Choose music from this device</strong><p>Up to 50 files · 50 MB each</p></div>
        <input ref={fileInputRef} type="file" multiple accept=".mp3,.m4a,.aac,.flac,.ogg,.wav" hidden onChange={(event) => {
          if (event.target.files) addFiles(event.target.files);
          event.currentTarget.value = "";
        }} />
        <input ref={folderInputRef} type="file" multiple accept=".mp3,.m4a,.aac,.flac,.ogg,.wav" hidden onChange={(event) => {
          if (event.target.files) addFiles(event.target.files);
          event.currentTarget.value = "";
        }} {...({ webkitdirectory: "" } as InputHTMLAttributes<HTMLInputElement>)} />
        <div className="upload-actions">
          <button className="primary-button" type="button" onClick={() => fileInputRef.current?.click()}><PlusIcon className="h-5 w-5" /> Select files</button>
          <button className="secondary-button desktop-only" type="button" onClick={() => {
            folderInputRef.current?.click();
          }}><FolderIcon className="h-5 w-5" /> Select folder</button>
        </div>
      </div>

      {pageError && <p className="notice notice-error">{pageError}</p>}
      <div className="upload-list">
        {items.map((item) => (
          <article key={item.localId} className="upload-row">
            <div className={`upload-state state-${item.status}`}>
              {item.status === "ready" ? <CheckIcon className="h-5 w-5" /> : item.status === "hashing" || item.status === "uploading" || item.status === "processing" ? <SpinnerIcon className="h-5 w-5 animate-spin" /> : <UploadIcon className="h-5 w-5" />}
            </div>
            <div className="upload-copy">
              <strong>{item.fileName}</strong>
              <span>{formatFileSize(item.sizeBytes)} · {item.status.replace("_", " ")}</span>
              {item.error && <p className="upload-error">{item.error}</p>}
              {item.status === "duplicate" && <p className="upload-duplicate">Already in library{item.duplicateTrack ? ` as “${item.duplicateTrack.title}”` : ""}.</p>}
              {["hashing", "uploading"].includes(item.status) && <div className="upload-progress"><span style={{ width: `${Math.round(item.progress * 100)}%` }} /></div>}
            </div>
            <div className="upload-row-actions">
              {(item.status === "hashing" || item.status === "uploading") && <button className="icon-button" type="button" onClick={() => pause(item)} aria-label="Pause"><PauseIcon className="h-5 w-5" /></button>}
              {(item.status === "paused" || item.status === "error") && <button className="icon-button" type="button" onClick={() => void retry(item)} aria-label="Retry"><RetryIcon className="h-5 w-5" /></button>}
              {item.status === "needs_file" && <button className="secondary-button compact" type="button" onClick={() => fileInputRef.current?.click()}>Reselect</button>}
              {!(["ready", "cancelled", "duplicate"].includes(item.status)) && <button className="icon-button danger" type="button" onClick={() => void cancel(item)} aria-label="Cancel"><CloseIcon className="h-5 w-5" /></button>}
            </div>
          </article>
        ))}
      </div>
      {items.length === 0 && <div className="empty-state"><UploadIcon className="h-8 w-8" /><p>Your upload queue will appear here.</p></div>}
    </section>
  );
}
