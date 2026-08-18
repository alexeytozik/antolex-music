import { describe, expect, it, vi } from "vitest";

import {
  shouldProbeNativeHLS,
  shouldUseNativeHLS,
} from "./use-playback-session-driver";

function audioWithNativeHLS(answer: CanPlayTypeResult = "maybe") {
  return {
    canPlayType: vi.fn(() => answer),
  } as Pick<HTMLAudioElement, "canPlayType">;
}

describe("shouldUseNativeHLS", () => {
  it("uses native HLS in desktop Safari", () => {
    expect(
      shouldUseNativeHLS(
        audioWithNativeHLS(),
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
          "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
        0,
      ),
    ).toBe(true);
  });

  it.each([
    [
      "Chrome",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    ],
    [
      "Edge",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
    ],
    [
      "Firefox",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) " +
        "Gecko/20100101 Firefox/129.0",
    ],
  ])("does not trust canPlayType in desktop %s", (_browser, userAgent) => {
    expect(shouldUseNativeHLS(audioWithNativeHLS(), userAgent, 0)).toBe(false);
  });

  it("uses native HLS for every iOS WebKit browser", () => {
    expect(
      shouldUseNativeHLS(
        audioWithNativeHLS(),
        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) " +
          "AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0 Mobile/15E148 Safari/604.1",
        5,
      ),
    ).toBe(true);
  });

  it("recognizes an iPad requesting the desktop site", () => {
    expect(
      shouldUseNativeHLS(
        audioWithNativeHLS(),
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) " +
          "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        5,
      ),
    ).toBe(true);
  });

  it("does not select native HLS when WebKit reports no support", () => {
    expect(
      shouldUseNativeHLS(
        audioWithNativeHLS(""),
        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) " +
          "AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
        5,
      ),
    ).toBe(false);
  });

  it("does not trust advertised native HLS on Android Chromium", () => {
    const androidChrome =
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36";
    expect(shouldUseNativeHLS(audioWithNativeHLS(), androidChrome, 5)).toBe(false);
    expect(shouldProbeNativeHLS(audioWithNativeHLS(), androidChrome)).toBe(false);
    expect(shouldProbeNativeHLS(audioWithNativeHLS(""), androidChrome)).toBe(false);
  });
});
