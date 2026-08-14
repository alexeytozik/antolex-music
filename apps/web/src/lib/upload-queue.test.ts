import { describe, expect, it, vi } from "vitest";

import type { PersistedUpload } from "./upload-db";
import {
  reconcileSelectedFiles,
  restoreUploadQueue,
  type UploadQueueItem,
} from "./upload-queue";
import type { UploadSession } from "../types";

function persisted(localId: string, status: string, sessionId?: string): PersistedUpload {
  return {
    local_id: localId,
    session_id: sessionId,
    file_name: `${localId}.mp3`,
    size_bytes: 1024,
    content_type: "audio/mpeg",
    last_modified: 1,
    status,
    uploaded_bytes: status === "ready" ? 1024 : 0,
    uploaded_parts: [],
    created_at: "2026-08-14T00:00:00Z",
  };
}

function remote(id: string, status: UploadSession["status"]): UploadSession {
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

function queueItem(
  localId: string,
  overrides: Partial<UploadQueueItem> = {},
): UploadQueueItem {
  return {
    localId,
    fileName: `${localId}.mp3`,
    sizeBytes: 1024,
    contentType: "audio/mpeg",
    lastModified: 1,
    status: "needs_file",
    progress: 0,
    uploadedParts: [],
    createdAt: "2026-08-14T00:00:00Z",
    ...overrides,
  };
}

function selectedFile(
  name: string,
  size = 1024,
  lastModified = 1,
) {
  return new File([new Uint8Array(size)], name, {
    type: "audio/mpeg",
    lastModified,
  });
}

describe("upload queue restoration", () => {
  it("discards ten thousand completed rows instead of rendering them", () => {
    const history = Array.from({ length: 10_000 }, (_, index) => persisted(`ready-${index}`, "ready", `session-${index}`));
    const result = restoreUploadQueue(history, []);
    expect(result.items).toEqual([]);
    expect(result.discardedLocalIds).toHaveLength(10_000);
  });

  it("keeps actionable local problems and drops stale server-backed rows", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "new-local-id" });
    const result = restoreUploadQueue([
      persisted("duplicate", "duplicate"),
      persisted("local-error", "error"),
      persisted("stale-processing", "processing", "missing-session"),
    ], [remote("remote-error", "error"), remote("remote-processing", "processing")]);
    expect(result.items.map((item) => item.status).sort()).toEqual(["duplicate", "error", "error", "processing"]);
    expect(result.discardedLocalIds).toEqual(["stale-processing"]);
    vi.unstubAllGlobals();
  });

  it("ignores terminal rows returned by an older API during rollout", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "new-local-id" });
    const result = restoreUploadQueue([
      persisted("was-processing", "processing", "ready"),
    ], [remote("ready", "ready"), remote("cancelled", "cancelled")]);
    expect(result.items).toEqual([]);
    expect(result.discardedLocalIds).toEqual(["was-processing"]);
    vi.unstubAllGlobals();
  });
});

describe("reselected upload reconciliation", () => {
  it("matches a complete 50-file batch to 50 needs-file rows", () => {
    const items = Array.from({ length: 50 }, (_, index) =>
      queueItem(`track-${index}`),
    );
    const files = items.map((item) =>
      selectedFile(item.fileName, item.sizeBytes, item.lastModified),
    );

    const result = reconcileSelectedFiles(items, files);

    expect(result.matches).toHaveLength(50);
    expect(result.unmatched).toEqual([]);
    expect(new Set(result.matches.map(({ itemIndex }) => itemIndex)).size).toBe(50);
    expect(result.matches.map(({ file }) => file)).toEqual(files);
  });

  it("reserves each needs-file row at most once", () => {
    const items = [queueItem("song")];
    const first = selectedFile("song.mp3");
    const second = selectedFile("song.mp3");

    const result = reconcileSelectedFiles(items, [first, second]);

    expect(result.matches).toEqual([{ itemIndex: 0, file: first }]);
    expect(result.unmatched).toEqual([second]);
  });

  it("uses last-modified time to disambiguate equal names and sizes", () => {
    const items = [
      queueItem("older", {
        fileName: "same.mp3",
        lastModified: 10,
      }),
      queueItem("newer", {
        fileName: "same.mp3",
        lastModified: 20,
      }),
    ];
    const file = selectedFile("same.mp3", 1024, 20);

    const result = reconcileSelectedFiles(items, [file]);

    expect(result.matches).toEqual([{ itemIndex: 1, file }]);
    expect(result.unmatched).toEqual([]);
  });

  it("does not guess when multiple rows are compatible but none is exact", () => {
    const items = [
      queueItem("first", {
        fileName: "same.mp3",
        lastModified: 10,
      }),
      queueItem("second", {
        fileName: "same.mp3",
        lastModified: 20,
      }),
    ];
    const file = selectedFile("same.mp3", 1024, 30);

    const result = reconcileSelectedFiles(items, [file]);

    expect(result.matches).toEqual([]);
    expect(result.unmatched).toEqual([file]);
  });

  it("falls back to the only compatible row when last-modified changed", () => {
    const items = [
      queueItem("song", {
        fileName: "renamed-date.mp3",
        lastModified: 10,
      }),
    ];
    const file = selectedFile("renamed-date.mp3", 1024, 20);

    const result = reconcileSelectedFiles(items, [file]);

    expect(result.matches).toEqual([{ itemIndex: 0, file }]);
    expect(result.unmatched).toEqual([]);
  });

  it("never matches a file to a non-needs-file row", () => {
    const items = [queueItem("song", { status: "processing" })];
    const file = selectedFile("song.mp3");

    const result = reconcileSelectedFiles(items, [file]);

    expect(result.matches).toEqual([]);
    expect(result.unmatched).toEqual([file]);
  });
});
