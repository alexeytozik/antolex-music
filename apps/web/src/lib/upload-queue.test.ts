import { describe, expect, it, vi } from "vitest";

import type { PersistedUpload } from "./upload-db";
import { restoreUploadQueue } from "./upload-queue";
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
