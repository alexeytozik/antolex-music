import { describe, expect, it } from "vitest";

import { APIError } from "./api";
import {
  PLAYBACK_RETRY_DELAYS_MS,
  classifyMediaError,
  isAbortError,
  isRetryablePlaybackRequestError,
  nextPlaybackRetry,
  playbackRetryDelay,
} from "./playback-recovery";

describe("playback recovery policy", () => {
  it("retries only media network failures", () => {
    expect(classifyMediaError({ code: 2 })).toBe("retry");
    expect(classifyMediaError({ code: 1 })).toBe("ignore");
    expect(classifyMediaError({ code: 3 })).toBe("terminal");
    expect(classifyMediaError({ code: 4 })).toBe("terminal");
    expect(classifyMediaError(null)).toBe("terminal");
  });

  it("retries fetch failures, rate limits and server failures", () => {
    expect(isRetryablePlaybackRequestError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isRetryablePlaybackRequestError(new APIError(408, { code: "request_timeout", message: "Timed out" }))).toBe(true);
    expect(isRetryablePlaybackRequestError(new APIError(429, { code: "rate_limited", message: "Wait" }))).toBe(true);
    expect(isRetryablePlaybackRequestError(new APIError(502, { code: "bad_gateway", message: "Down" }))).toBe(true);
  });

  it("does not retry authorization, missing tracks or ordinary errors", () => {
    expect(isRetryablePlaybackRequestError(new APIError(401, { code: "unauthorized", message: "Sign in" }))).toBe(false);
    expect(isRetryablePlaybackRequestError(new APIError(403, { code: "forbidden", message: "No access" }))).toBe(false);
    expect(isRetryablePlaybackRequestError(new APIError(404, { code: "not_found", message: "Missing" }))).toBe(false);
    expect(isRetryablePlaybackRequestError(new Error("Decode failed"))).toBe(false);
  });

  it("caps backoff without exhausting transient retries", () => {
    expect(playbackRetryDelay(1)).toBe(500);
    expect(playbackRetryDelay(3)).toBe(3_500);
    expect(playbackRetryDelay(6)).toBe(30_000);
    expect(playbackRetryDelay(99)).toBe(30_000);

    let attempt = 0;
    for (let index = 0; index < 100; index += 1) {
      attempt = nextPlaybackRetry(attempt).attempt;
    }
    expect(nextPlaybackRetry(attempt)).toEqual({ attempt: 6, delay: 30_000 });
  });

  it("recognizes aborted requests", () => {
    expect(isAbortError(new DOMException("Cancelled", "AbortError"))).toBe(true);
    expect(isAbortError(new TypeError("Failed to fetch"))).toBe(false);
  });
});
