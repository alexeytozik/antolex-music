import type {
  APIErrorPayload,
  APIErrorResponse,
  AuthSession,
  LikesResponse,
  SearchResponse,
  Track,
  UploadTrackResponse,
  User,
} from "../types";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080/api/v1";

type EmailPayload = {
  email: string;
};

type VerifyCodePayload = {
  email: string;
  code: string;
};

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
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as APIErrorResponse;
  return (
    !!candidate.error &&
    typeof candidate.error.code === "string" &&
    typeof candidate.error.message === "string"
  );
}

async function request<T>(
  path: string,
  init?: RequestInit & { token?: string },
): Promise<T> {
  const headers = new Headers(init?.headers);
  const isFormDataBody =
    typeof FormData !== "undefined" && init?.body instanceof FormData;
  if (!isFormDataBody) {
    headers.set("Content-Type", "application/json");
  }
  if (init?.token) {
    headers.set("Authorization", `Bearer ${init.token}`);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const payload = (await response.json()) as unknown;
      if (isAPIErrorResponse(payload)) {
        throw new APIError(response.status, payload.error);
      }
    }

    const message = await response.text();
    throw new Error(message || "Request failed");
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export const api = {
  requestCode(payload: EmailPayload) {
    return request<void>("/auth/request-code", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  verifyCode(payload: VerifyCodePayload) {
    return request<AuthSession>("/auth/verify-code", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  getProfile(token: string) {
    return request<User>("/me", { token });
  },
  search(query: string, page = 1) {
    return api.searchWithCursor(query, page, null);
  },
  searchWithCursor(query: string, page = 1, cursor: string | null = null) {
    const params = new URLSearchParams({ q: query, page: String(page) });
    if (cursor) {
      params.set("cursor", cursor);
    }
    return request<SearchResponse>(`/search?${params.toString()}`);
  },
  resolveTrack(externalId: string) {
    return request<Track>(`/tracks/${externalId}/stream`);
  },
  uploadTrack(
    token: string,
    file: File,
    payload?: { title?: string; artist?: string; duration_seconds?: number },
  ) {
    const formData = new FormData();
    formData.append("file", file);
    if (payload?.title) {
      formData.append("title", payload.title);
    }
    if (payload?.artist) {
      formData.append("artist", payload.artist);
    }
    if (typeof payload?.duration_seconds === "number") {
      formData.append("duration_seconds", String(payload.duration_seconds));
    }

    return request<UploadTrackResponse>("/me/library/uploads", {
      method: "POST",
      token,
      body: formData,
    });
  },
  getLikes(token: string, page = 1) {
    return api.getLikesWithCursor(token, page, null);
  },
  getLikesWithCursor(token: string, page = 1, cursor: string | null = null) {
    const params = new URLSearchParams({ page: String(page) });
    if (cursor) {
      params.set("cursor", cursor);
    }
    return request<LikesResponse>(`/me/likes?${params.toString()}`, { token });
  },
  getLikedIDs(token: string) {
    return request<string[]>("/me/likes/ids", { token });
  },
  addLike(token: string, track: Track) {
    return request<void>("/me/likes", {
      method: "POST",
      token,
      body: JSON.stringify(track),
    });
  },
  removeLike(token: string, externalId: string) {
    return request<void>(`/me/likes/${externalId}`, {
      method: "DELETE",
      token,
    });
  },
};
