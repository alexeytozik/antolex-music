import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { APIError, api, putUploadPart } from "../lib/api";
import { hashFile } from "../lib/hash-file";
import {
  listPersistedUploads,
  persistUpload,
  removePersistedUploads,
} from "../lib/upload-db";
import {
  isHiddenTerminalStatus,
  reconcileSelectedFiles,
  restoreUploadQueue,
  serverUploadStatus,
  toPersistedUpload,
  type UploadQueueItem,
} from "../lib/upload-queue";
import {
  MAX_UPLOAD_FILES,
  MULTIPART_PART_SIZE,
  validateUploadFile,
} from "../lib/upload-validation";
import type { Track, UploadedPart, UploadSession } from "../types";

type UploadManagerValue = {
  items: UploadQueueItem[];
  pageError: string | null;
  ready: boolean;
  addFiles: (files: FileList | File[]) => void;
  reselectFile: (localId: string, file: File) => void;
  pause: (item: UploadQueueItem) => void;
  cancel: (item: UploadQueueItem) => Promise<void>;
  retry: (item: UploadQueueItem) => Promise<void>;
  removeItem: (localId: string) => void;
};

type ActiveUpload = {
  id: string;
  controller: AbortController;
  phase: "hashing" | "creating" | "uploading" | "completing";
};

const UploadManagerContext = createContext<UploadManagerValue | null>(null);

function throwIfUploadAborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Upload paused", "AbortError");
}

export function useUploadManager() {
  const manager = useContext(UploadManagerContext);
  if (!manager) throw new Error("useUploadManager must be used inside UploadManagerProvider");
  return manager;
}

export function UploadManagerProvider({
  children,
  enabled,
  userKey,
  onUnauthorized,
}: {
  children: ReactNode;
  enabled: boolean;
  userKey?: string;
  onUnauthorized?: () => void;
}) {
  const [items, setItems] = useState<UploadQueueItem[]>([]);
  const [pageError, setPageError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [wakeQueue, setWakeQueue] = useState(0);
  const itemsRef = useRef(items);
  const activeRef = useRef<ActiveUpload | null>(null);
  const cancelledLocalIDsRef = useRef(new Set<string>());
  const pollingGenerationRef = useRef(0);
  const runtimeGenerationRef = useRef(0);

  function replaceItems(next: UploadQueueItem[]) {
    itemsRef.current = next;
    setItems(next);
  }

  function persistItem(item: UploadQueueItem) {
    if (userKey) void persistUpload(toPersistedUpload(item, userKey));
  }

  function updateItem(localId: string, patch: Partial<UploadQueueItem>) {
    let updated: UploadQueueItem | undefined;
    const next = itemsRef.current.map((item) => {
      if (item.localId !== localId) return item;
      updated = { ...item, ...patch };
      return updated;
    });
    replaceItems(next);
    if (updated) persistItem(updated);
  }

  function removeItem(localId: string) {
    replaceItems(itemsRef.current.filter((item) => item.localId !== localId));
    if (userKey) void removePersistedUploads(userKey, [localId]);
  }

  function applySessionUpdate(item: UploadQueueItem, session: UploadSession) {
    const status = serverUploadStatus(session);
    if (isHiddenTerminalStatus(status)) {
      removeItem(item.localId);
      return;
    }
    updateItem(item.localId, {
      status,
      track: session.track,
      error: session.error,
      progress: status === "processing" ? 1 : item.progress,
    });
  }

  useEffect(() => {
    let cancelled = false;
    const generation = ++runtimeGenerationRef.current;
    activeRef.current?.controller.abort();
    activeRef.current = null;
    replaceItems([]);
    setPageError(null);
    setReady(false);
    if (!enabled || !userKey) return () => { cancelled = true; };

    void Promise.all([listPersistedUploads(userKey), api.getUploads()])
      .then(([persisted, remote]) => {
        if (cancelled) return;
        const restored = restoreUploadQueue(persisted, remote);
        replaceItems(restored.items);
        void removePersistedUploads(userKey, restored.discardedLocalIds);
        setReady(true);
      })
      .catch((reason) => {
        if (!cancelled) {
          if (reason instanceof APIError && (reason.status === 401 || reason.status === 403)) {
            onUnauthorized?.();
            return;
          }
          setPageError(reason instanceof Error ? reason.message : "Could not restore uploads");
          setReady(true);
        }
      });
    return () => {
      cancelled = true;
      if (runtimeGenerationRef.current === generation) runtimeGenerationRef.current += 1;
      activeRef.current?.controller.abort();
    };
  }, [enabled, userKey, onUnauthorized]);

  useEffect(() => {
    const hasVolatileFiles = items.some(
      (item) => !!item.file && !isHiddenTerminalStatus(item.status),
    );
    if (!hasVolatileFiles) return;
    function warnBeforeReload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warnBeforeReload);
    return () => window.removeEventListener("beforeunload", warnBeforeReload);
  }, [items]);

  const processingKey = items
    .filter((item) => item.status === "processing" && item.sessionId)
    .map((item) => `${item.localId}:${item.sessionId}`)
    .join("|");

  useEffect(() => {
    if (!processingKey) return;
    const generation = ++pollingGenerationRef.current;
    const controller = new AbortController();
    let timer: number | undefined;
    let stopped = false;

    async function pollProcessing() {
      if (stopped || generation !== pollingGenerationRef.current) return;
      const processing = itemsRef.current.filter(
        (item) => item.status === "processing" && item.sessionId,
      );
      for (const snapshot of processing) {
        if (stopped || generation !== pollingGenerationRef.current) return;
        try {
          const session = await api.getUpload(snapshot.sessionId!, controller.signal);
          if (stopped || generation !== pollingGenerationRef.current) return;
          const current = itemsRef.current.find(
            (item) => item.localId === snapshot.localId &&
              item.sessionId === snapshot.sessionId &&
              item.status === "processing",
          );
          if (current) applySessionUpdate(current, session);
        } catch (reason) {
          if (controller.signal.aborted || stopped || generation !== pollingGenerationRef.current) return;
          if (reason instanceof APIError && (reason.status === 401 || reason.status === 403)) {
            stopped = true;
            onUnauthorized?.();
            return;
          }
          if (reason instanceof APIError && reason.status === 404) {
            const current = itemsRef.current.find(
              (item) => item.localId === snapshot.localId &&
                item.sessionId === snapshot.sessionId &&
                item.status === "processing",
            );
            if (current) removeItem(current.localId);
          }
        }
      }
      if (!stopped && generation === pollingGenerationRef.current) {
        timer = window.setTimeout(() => void pollProcessing(), 4000);
      }
    }

    timer = window.setTimeout(() => void pollProcessing(), 4000);
    return () => {
      stopped = true;
      if (pollingGenerationRef.current === generation) pollingGenerationRef.current += 1;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [processingKey, onUnauthorized]);

  async function processOne(item: UploadQueueItem) {
    if (!item.file || activeRef.current) return;
    const generation = runtimeGenerationRef.current;
    const isCurrentGeneration = () => generation === runtimeGenerationRef.current;
    const controller = new AbortController();
    activeRef.current = { id: item.localId, controller, phase: "hashing" };
    try {
      updateItem(item.localId, { status: "hashing", error: undefined, progress: 0 });
      const sha256 = await hashFile(
        item.file,
        (progress) => {
          if (isCurrentGeneration()) updateItem(item.localId, { progress: progress * 0.08 });
        },
        controller.signal,
      );
      throwIfUploadAborted(controller.signal);
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
        session = await api.getUpload(item.sessionId, controller.signal);
        throwIfUploadAborted(controller.signal);
        const remoteStatus = serverUploadStatus(session);
        if (remoteStatus !== "needs_file") {
          if (isHiddenTerminalStatus(remoteStatus)) {
            removeItem(item.localId);
          } else {
            updateItem(item.localId, {
              status: remoteStatus,
              progress: remoteStatus === "processing" ? 1 : item.progress,
              file: undefined,
              track: session.track,
              error: session.error,
            });
          }
          return;
        }
      } else {
        try {
          if (activeRef.current?.controller === controller) {
            activeRef.current.phase = "creating";
          }
          session = await api.createUpload({
            file_name: item.file.name,
            size_bytes: item.file.size,
            content_type: item.file.type || "application/octet-stream",
            sha256,
          });
        } catch (reason) {
          if (reason instanceof APIError && reason.code === "duplicate_track") {
            if (cancelledLocalIDsRef.current.has(item.localId)) {
              if (isCurrentGeneration()) removeItem(item.localId);
              else if (userKey) void removePersistedUploads(userKey, [item.localId]);
            } else {
              const duplicate: UploadQueueItem = {
                ...item,
                status: "duplicate",
                progress: 1,
                duplicateTrack: reason.details?.track as Track | undefined,
                file: undefined,
              };
              if (isCurrentGeneration()) updateItem(item.localId, duplicate);
              else persistItem(duplicate);
            }
            return;
          }
          throw reason;
        }
        if (cancelledLocalIDsRef.current.has(item.localId)) {
          try {
            await api.cancelUpload(session.id);
            if (isCurrentGeneration()) removeItem(item.localId);
            else if (userKey) await removePersistedUploads(userKey, [item.localId]);
          } catch (reason) {
            const failedCancellation: UploadQueueItem = {
              ...item,
              sessionId: session.id,
              sha256,
              status: "error",
              error: reason instanceof Error ? reason.message : "Could not cancel upload",
            };
            cancelledLocalIDsRef.current.delete(item.localId);
            if (isCurrentGeneration()) {
              updateItem(item.localId, failedCancellation);
            } else {
              persistItem(failedCancellation);
            }
          }
          throw new DOMException("Upload cancelled", "AbortError");
        }
        const current = isCurrentGeneration()
          ? itemsRef.current.find((candidate) => candidate.localId === item.localId)
          : undefined;
        if (current) {
          updateItem(item.localId, { sessionId: session.id });
        } else {
          persistItem({
            ...item,
            sessionId: session.id,
            sha256,
            status: "paused",
          });
        }
        throwIfUploadAborted(controller.signal);
      }

      if (activeRef.current?.controller === controller) {
        activeRef.current.phase = "uploading";
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
        const target = await api.getUploadPartURL(session.id, partNumber, controller.signal);
        throwIfUploadAborted(controller.signal);
        const result = await putUploadPart(
          target,
          item.file.slice(start, end),
          (partLoaded) => updateItem(item.localId, {
            status: "uploading",
            progress: Math.min((uploadedBytes + partLoaded) / item.file!.size, 0.999),
          }),
          controller.signal,
        );
        throwIfUploadAborted(controller.signal);
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

      if (activeRef.current?.controller === controller) {
        activeRef.current.phase = "completing";
      }
      const completed = await api.completeUpload(
        session.id,
        Array.from(parts.values()),
      );
      if (cancelledLocalIDsRef.current.has(item.localId) || !isCurrentGeneration()) return;
      const completedStatus = serverUploadStatus(completed);
      if (isHiddenTerminalStatus(completedStatus)) {
        removeItem(item.localId);
      } else {
        updateItem(item.localId, {
          status: completedStatus,
          progress: 1,
          file: undefined,
          track: completed.track,
          error: completed.error,
        });
      }
    } catch (reason) {
      if (isCurrentGeneration() && !(reason instanceof DOMException && reason.name === "AbortError")) {
        updateItem(item.localId, {
          status: "error",
          error: reason instanceof Error ? reason.message : "Upload failed",
        });
      }
    } finally {
      if (activeRef.current?.controller === controller) activeRef.current = null;
      if (isCurrentGeneration()) setWakeQueue((value) => value + 1);
    }
  }

  useEffect(() => {
    if (!enabled || activeRef.current) return;
    const next = items.find((item) => item.status === "queued" && item.file);
    if (next) void processOne(next);
  }, [enabled, items, wakeQueue]);

  function addFiles(fileList: FileList | File[]) {
    if (!ready) return;
    const files = Array.from(fileList);
    if (files.length === 0) return;
    setPageError(null);

    const next = [...itemsRef.current];
    const reconciliation = reconcileSelectedFiles(next, files);
    for (const { itemIndex, file } of reconciliation.matches) {
      const validationError = validateUploadFile(file);
      next[itemIndex] = {
        ...next[itemIndex],
        file: validationError ? undefined : file,
        status: validationError ? "error" : "queued",
        error: validationError ?? undefined,
      };
      persistItem(next[itemIndex]);
    }

    const liveCount = next.filter(
      (item) => !["ready", "cancelled", "duplicate"].includes(item.status),
    ).length;
    if (reconciliation.unmatched.length + liveCount > MAX_UPLOAD_FILES) {
      replaceItems(next);
      setPageError(`A queue can contain up to ${MAX_UPLOAD_FILES} files. Existing files were reselected; extra files were not added.`);
      return;
    }

    for (const file of reconciliation.unmatched) {
      const validationError = validateUploadFile(file);
      const item: UploadQueueItem = {
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
      persistItem(item);
    }
    replaceItems(next);
  }

  function reselectFile(localId: string, file: File) {
    if (!ready) return;
    setPageError(null);
    const item = itemsRef.current.find((candidate) => candidate.localId === localId);
    if (!item || item.status !== "needs_file") return;
    const validationError = validateUploadFile(file);
    if (validationError) {
      updateItem(localId, { file: undefined, error: validationError });
      return;
    }
    const metadataMatches = item.fileName === file.name && item.sizeBytes === file.size;
    const canVerifyByHash = !!item.sha256 && item.sizeBytes === file.size;
    if (!metadataMatches && !canVerifyByHash) {
      updateItem(localId, {
        file: undefined,
        error: item.sha256
          ? `Select the original ${item.sizeBytes}-byte file to resume this upload.`
          : `Select “${item.fileName}” (${item.sizeBytes} bytes) to resume this upload.`,
      });
      return;
    }
    updateItem(localId, {
      file,
      status: "queued",
      error: undefined,
    });
  }

  function pause(item: UploadQueueItem) {
    if (activeRef.current?.id === item.localId) activeRef.current.controller.abort();
    updateItem(item.localId, { status: "paused" });
  }

  async function cancel(item: UploadQueueItem) {
    cancelledLocalIDsRef.current.add(item.localId);
    const active = activeRef.current?.id === item.localId ? activeRef.current : null;
    active?.controller.abort();
    if (!item.sessionId) {
      if (active?.phase === "creating") {
        updateItem(item.localId, { status: "cancelling", error: undefined });
        return;
      }
      removeItem(item.localId);
      return;
    }
    const retainedFile = itemsRef.current.find(
      (candidate) => candidate.localId === item.localId,
    )?.file ?? item.file;
    updateItem(item.localId, { status: "cancelling", error: undefined });
    try {
      await api.cancelUpload(item.sessionId);
      removeItem(item.localId);
    } catch (reason) {
      if (reason instanceof APIError && reason.code === "upload_not_found") {
        removeItem(item.localId);
      } else {
        cancelledLocalIDsRef.current.delete(item.localId);
        updateItem(item.localId, {
          status: "error",
          file: retainedFile,
          error: reason instanceof Error ? reason.message : "Could not cancel upload",
        });
      }
    }
  }

  async function retry(item: UploadQueueItem) {
    if (item.sessionId && item.status === "error" && !item.file) {
      try {
        const session = await api.retryUpload(item.sessionId);
        applySessionUpdate(item, session);
      } catch (reason) {
        updateItem(item.localId, { error: reason instanceof Error ? reason.message : "Retry failed" });
      }
      return;
    }
    updateItem(item.localId, { status: item.file ? "queued" : "needs_file", error: undefined });
  }

  return (
    <UploadManagerContext.Provider value={{
      items,
      pageError,
      ready,
      addFiles,
      reselectFile,
      pause,
      cancel,
      retry,
      removeItem,
    }}>
      {children}
    </UploadManagerContext.Provider>
  );
}
