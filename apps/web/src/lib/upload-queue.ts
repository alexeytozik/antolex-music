import type { PersistedUpload } from "./upload-db";
import type { Track, UploadedPart, UploadSession } from "../types";

export type LocalUploadStatus =
  | "queued"
  | "needs_file"
  | "hashing"
  | "duplicate"
  | "uploading"
  | "paused"
  | "processing"
  | "ready"
  | "error"
  | "cancelling"
  | "cancelled";

export type UploadQueueItem = {
  localId: string;
  sessionId?: string;
  fileName: string;
  sizeBytes: number;
  contentType: string;
  lastModified: number;
  sha256?: string;
  status: LocalUploadStatus;
  progress: number;
  uploadedParts: UploadedPart[];
  file?: File;
  track?: Track;
  duplicateTrack?: Track;
  error?: string;
  createdAt: string;
};

export function isHiddenTerminalStatus(status: string) {
  return status === "ready" || status === "cancelled";
}

export function serverUploadStatus(session: UploadSession): LocalUploadStatus {
  if (session.status === "pending" || session.status === "uploading" || session.status === "paused") {
    return "needs_file";
  }
  return session.status === "deleting" ? "cancelled" : session.status;
}

export function toPersistedUpload(item: UploadQueueItem): PersistedUpload {
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

function fromPersistedUpload(item: PersistedUpload): UploadQueueItem {
  let status: LocalUploadStatus = "needs_file";
  if (item.status === "processing" || item.status === "error" || item.status === "duplicate") {
    status = item.status;
  }
  return {
    localId: item.local_id,
    sessionId: item.session_id,
    fileName: item.file_name,
    sizeBytes: item.size_bytes,
    contentType: item.content_type,
    lastModified: item.last_modified,
    sha256: item.sha256,
    status,
    progress: item.size_bytes ? item.uploaded_bytes / item.size_bytes : 0,
    uploadedParts: item.uploaded_parts ?? [],
    error: item.error,
    createdAt: item.created_at,
  };
}

export function restoreUploadQueue(persisted: PersistedUpload[], remote: UploadSession[]) {
  const operationalRemote = remote.filter((session) => !isHiddenTerminalStatus(session.status));
  const remoteByID = new Map(operationalRemote.map((session) => [session.id, session]));
  const discardedLocalIds: string[] = [];
  const restored: UploadQueueItem[] = [];

  for (const stored of persisted) {
    if (isHiddenTerminalStatus(stored.status) || (stored.session_id && !remoteByID.has(stored.session_id))) {
      discardedLocalIds.push(stored.local_id);
      continue;
    }
    restored.push(fromPersistedUpload(stored));
  }

  for (const session of operationalRemote) {
    const index = restored.findIndex((item) => item.sessionId === session.id);
    const existing = index >= 0 ? restored[index] : undefined;
    const merged: UploadQueueItem = {
      localId: existing?.localId ?? crypto.randomUUID(),
      sessionId: session.id,
      fileName: session.file_name,
      sizeBytes: session.size_bytes,
      contentType: session.content_type,
      lastModified: existing?.lastModified ?? 0,
      sha256: session.sha256,
      status: serverUploadStatus(session),
      progress: session.status === "processing" ? 1 : existing?.progress ?? 0,
      uploadedParts: session.uploaded_parts ?? existing?.uploadedParts ?? [],
      track: session.track,
      error: session.error,
      createdAt: session.created_at ?? existing?.createdAt ?? new Date().toISOString(),
    };
    if (index >= 0) restored[index] = merged;
    else restored.push(merged);
  }

  restored.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { items: restored, discardedLocalIds };
}
