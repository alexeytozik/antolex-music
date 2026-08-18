import type {
  AccessStatus,
  AdminHLSBackfillResponse,
  AdminHLSRetryResponse,
  AdminUser,
  AdminUsersResponse,
  APIErrorPayload,
  APIErrorResponse,
  AuthSession,
  CreatePlaybackSessionInput,
  LikesResponse,
  PlaybackSession,
  SearchResponse,
  ShuffleResponse,
  Track,
  UploadListResponse,
  UploadPartURL,
  UploadSession,
  UploadSessionEnvelope,
  UploadedPart,
  User,
} from "../types";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080/api/v1";

export const SESSION_INVALIDATED_EVENT = "antolex:session-invalidated";

type RequestOptions = RequestInit & { token?: string | null };

export class APIError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;

  constructor(status: number, payload: APIErrorPayload) {
    super(payload.message);
    this.name = "APIError";
    this.code = payload.code;
    this.status = status;
    this.details = payload.details;
  }
}

function isAPIErrorResponse(value: unknown): value is APIErrorResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as APIErrorResponse;
  return (
    !!candidate.error &&
    typeof candidate.error.code === "string" &&
    typeof candidate.error.message === "string"
  );
}

function notifyInvalidSession(status: number, code: string) {
  const accessRevoked =
    status === 403 && (code === "access_pending" || code === "access_blocked");
  if (status !== 401 && !accessRevoked) return;
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(SESSION_INVALIDATED_EVENT, { detail: { status, code } }),
  );
}

function fallbackResponseMessage(status: number) {
  if (status === 401) return "Your session has expired. Sign in again.";
  if (status === 403) return "You don’t have access to this action.";
  if (status === 404) return "This item is no longer available.";
  if (status === 408) return "The request took too long. Please try again.";
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  if (status >= 500) {
    return "ANTOLEX is temporarily unavailable. Please try again in a moment.";
  }
  return "We couldn’t complete that request. Please try again.";
}

async function request<T>(path: string, init: RequestOptions = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const isFormData =
    typeof FormData !== "undefined" && init.body instanceof FormData;
  if (init.body && !isFormData && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const payload = (await response.json()) as unknown;
      if (isAPIErrorResponse(payload)) {
        notifyInvalidSession(response.status, payload.error.code);
        throw new APIError(response.status, payload.error);
      }
    }
    const code = response.status === 401 ? "unauthorized" : "request_failed";
    notifyInvalidSession(response.status, code);
    throw new APIError(response.status, {
      code,
      message: fallbackResponseMessage(response.status),
    });
  }

  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return undefined as T;
  return (await response.json()) as T;
}

function unwrapUpload(payload: UploadSessionEnvelope): UploadSession {
  if ("upload" in payload) return payload.upload;
  if ("session" in payload) return payload.session;
  return payload;
}

function unwrapUploads(payload: UploadListResponse) {
  if (Array.isArray(payload)) return { results: payload, nextCursor: undefined };
  if ("uploads" in payload) {
    return { results: payload.uploads, nextCursor: payload.next_cursor };
  }
  return { results: payload.results, nextCursor: payload.next_cursor };
}

export const api = {
  requestCode(payload: { email: string }) {
    return request<void>("/auth/request-code", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  verifyCode(payload: { email: string; code: string }) {
    return request<AuthSession>("/auth/verify-code", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  exchangeLegacyToken(token: string) {
    return request<AuthSession>("/auth/exchange", { method: "POST", token });
  },
  logout() {
    return request<void>("/auth/logout", { method: "POST" });
  },
  getProfile(token?: string | null) {
    return request<User>("/me", { token });
  },
  getAdminUsers(cursor: string | null = null, signal?: AbortSignal) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return request<AdminUsersResponse>(`/admin/users${query}`, { signal });
  },
  updateAdminUserStatus(id: string, status: Extract<AccessStatus, "active" | "blocked">) {
    return request<AdminUser>(`/admin/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
  },
  getAdminHLSBackfill(signal?: AbortSignal) {
    return request<AdminHLSBackfillResponse>("/admin/hls-backfill", { signal });
  },
  retryAdminHLSBackfill(trackId: string) {
    return request<AdminHLSRetryResponse>(
      `/admin/hls-backfill/${encodeURIComponent(trackId)}/retry`,
      { method: "POST" },
    );
  },
  searchWithCursor(
    query: string,
    page = 1,
    cursor: string | null = null,
    signal?: AbortSignal,
  ) {
    const params = new URLSearchParams({
      q: query,
      page: String(page),
    });
    if (cursor) params.set("cursor", cursor);
    return request<SearchResponse>(`/search?${params.toString()}`, { signal });
  },
  shuffleWithCursor(
    page = 1,
    cursor: string | null = null,
    excludeExternalId?: string,
    signal?: AbortSignal,
  ) {
    const params = new URLSearchParams({ page: String(page) });
    if (cursor) params.set("cursor", cursor);
    if (excludeExternalId) params.set("exclude", excludeExternalId);
    return request<ShuffleResponse>(`/shuffle?${params.toString()}`, { signal });
  },
  resolveTrack(externalId: string, signal?: AbortSignal) {
    return request<Track>(`/tracks/${encodeURIComponent(externalId)}/stream`, {
      signal,
    });
  },
  getLikesWithCursor(
    token: string | null | undefined,
    page = 1,
    cursor: string | null = null,
    signal?: AbortSignal,
  ) {
    const params = new URLSearchParams({
      page: String(page),
    });
    if (cursor) params.set("cursor", cursor);
    return request<LikesResponse>(`/me/likes?${params.toString()}`, {
      token,
      signal,
    });
  },
  getLikedIDs(token?: string | null) {
    return request<string[]>("/me/likes/ids", { token });
  },
  addLike(token: string | null | undefined, track: Track) {
    return request<void>("/me/likes", {
      method: "POST",
      token,
      body: JSON.stringify(track),
    });
  },
  removeLike(token: string | null | undefined, externalId: string) {
    return request<void>(`/me/likes/${encodeURIComponent(externalId)}`, {
      method: "DELETE",
      token,
    });
  },
  createPlaybackSession(payload: CreatePlaybackSessionInput, signal?: AbortSignal) {
    return request<PlaybackSession>("/me/playback-sessions", {
      method: "POST",
      body: JSON.stringify(payload),
      signal,
    });
  },
  getPlaybackSession(id: string, signal?: AbortSignal) {
    return request<PlaybackSession>(
      `/me/playback-sessions/${encodeURIComponent(id)}`,
      { signal },
    );
  },
  deletePlaybackSession(id: string) {
    return request<void>(
      `/me/playback-sessions/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  },
  async createUpload(payload: {
    file_name: string;
    size_bytes: number;
    content_type: string;
    sha256: string;
  }, signal?: AbortSignal) {
    return unwrapUpload(
      await request<UploadSessionEnvelope>("/me/uploads", {
        method: "POST",
        body: JSON.stringify(payload),
        signal,
      }),
    );
  },
  async getUploads() {
    const uploads: UploadSession[] = [];
    let cursor: string | undefined;
    do {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const page = unwrapUploads(
        await request<UploadListResponse>(`/me/uploads${query}`),
      );
      uploads.push(...page.results);
      cursor = page.nextCursor;
    } while (cursor);
    return uploads;
  },
  async getUpload(id: string, signal?: AbortSignal) {
    return unwrapUpload(
      await request<UploadSessionEnvelope>(
        `/me/uploads/${encodeURIComponent(id)}`,
        { signal },
      ),
    );
  },
  getUploadPartURL(id: string, partNumber: number, signal?: AbortSignal) {
    return request<UploadPartURL>(
      `/me/uploads/${encodeURIComponent(id)}/parts/${partNumber}`,
      { method: "POST", signal },
    );
  },
  async completeUpload(id: string, parts: UploadedPart[], signal?: AbortSignal) {
    return unwrapUpload(
      await request<UploadSessionEnvelope>(
        `/me/uploads/${encodeURIComponent(id)}/complete`,
        { method: "POST", body: JSON.stringify({ parts }), signal },
      ),
    );
  },
  cancelUpload(id: string) {
    return request<void>(`/me/uploads/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
  async retryUpload(id: string) {
    return unwrapUpload(
      await request<UploadSessionEnvelope>(
        `/me/uploads/${encodeURIComponent(id)}/retry`,
        { method: "POST" },
      ),
    );
  },
};

export function putUploadPart(
  target: UploadPartURL,
  blob: Blob,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
): Promise<{ etag: string }> {
  const url = target.upload_url ?? target.url;
  if (!url) return Promise.reject(new Error("Upload URL is missing"));
  if (signal.aborted) {
    return Promise.reject(new DOMException("Upload paused", "AbortError"));
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    xhr.open("PUT", url);
    Object.entries(target.headers ?? {}).forEach(([name, value]) => {
      xhr.setRequestHeader(name, value);
    });
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onerror = () => {
      cleanup();
      reject(new Error("Network error while uploading"));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException("Upload paused", "AbortError"));
    };
    xhr.onload = () => {
      cleanup();
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Object storage returned ${xhr.status}`));
        return;
      }
      const etag = xhr.getResponseHeader("ETag")?.replaceAll('"', "") ?? "";
      if (!etag) {
        reject(new Error("Object storage did not return an ETag"));
        return;
      }
      resolve({ etag });
    };
    xhr.send(blob);
  });
}
