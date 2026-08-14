import { APIError } from "./api";

export const PLAYBACK_RETRY_DELAYS_MS = [
  500,
  1_500,
  3_500,
  7_000,
  15_000,
  30_000,
] as const;

export type MediaRecoveryDecision = "ignore" | "retry" | "terminal";

export function classifyMediaError(
  error: Pick<MediaError, "code"> | null,
): MediaRecoveryDecision {
  switch (error?.code) {
    case 1: // MEDIA_ERR_ABORTED
      return "ignore";
    case 2: // MEDIA_ERR_NETWORK
      return "retry";
    case 3: // MEDIA_ERR_DECODE
    case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
    default:
      return "terminal";
  }
}

export function isAbortError(error: unknown) {
  return (
    error instanceof DOMException
      ? error.name === "AbortError"
      : error instanceof Error && error.name === "AbortError"
  );
}

export function isRetryablePlaybackRequestError(error: unknown) {
  if (error instanceof APIError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }

  // Browser fetch rejects with TypeError when the request could not reach the server.
  return error instanceof TypeError;
}

export function playbackRetryDelay(attempt: number) {
  const index = Math.min(
    Math.max(Math.floor(attempt) - 1, 0),
    PLAYBACK_RETRY_DELAYS_MS.length - 1,
  );
  return PLAYBACK_RETRY_DELAYS_MS[index];
}

export function nextPlaybackRetry(attempt: number) {
  const nextAttempt = Math.min(
    Math.max(Math.floor(attempt), 0) + 1,
    PLAYBACK_RETRY_DELAYS_MS.length,
  );
  return {
    attempt: nextAttempt,
    delay: playbackRetryDelay(nextAttempt),
  };
}

export function playbackErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : fallback;
}
