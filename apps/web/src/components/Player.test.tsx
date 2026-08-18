import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { APIError, api } from "../lib/api";
import { requestPlaybackActivation } from "../lib/playback-activation";
import { selectCurrentItem, usePlayerStore } from "../store/player-store";
import type { Track } from "../types";
import { Player } from "./Player";
import { TrackCard } from "./TrackCard";

const hlsTestState = vi.hoisted(() => ({
  autoBuffer: true,
  loadedSources: [] as string[],
  playedSessionIDs: [] as Array<string | null>,
  startPositions: [] as Array<number | undefined>,
}));

vi.mock("hls.js", () => {
  type Handler = (...args: unknown[]) => void;
  class MockHLS {
    static isSupported() { return true; }
    static Events = {
      MEDIA_ATTACHED: "media-attached",
      MANIFEST_PARSED: "manifest-parsed",
      FRAG_BUFFERED: "frag-buffered",
      ERROR: "error",
    };
    static ErrorTypes = {
      NETWORK_ERROR: "network-error",
      MEDIA_ERROR: "media-error",
    };
    private handlers = new Map<string, Handler>();
    on(event: string, handler: Handler) { this.handlers.set(event, handler); }
    attachMedia() { this.handlers.get(MockHLS.Events.MEDIA_ATTACHED)?.(); }
    loadSource(source: string) {
      hlsTestState.loadedSources.push(source);
      this.handlers.get(MockHLS.Events.MANIFEST_PARSED)?.();
      if (hlsTestState.autoBuffer) {
        this.handlers.get(MockHLS.Events.FRAG_BUFFERED)?.();
      }
    }
    destroy() {}
    startLoad(position?: number) { hlsTestState.startPositions.push(position); }
    recoverMediaError() {}
  }
  return { default: MockHLS };
});

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
};

const mountedRoots: Root[] = [];
let playAttempts: Deferred[];

const SAFARI_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";
const CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const ANDROID_CHROME_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36";
const IPHONE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1";

function mockUserAgent(userAgent: string) {
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(userAgent);
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function track(id: string): Track {
  return {
    external_id: id,
    title: `Track ${id}`,
    artist: "Demo Artist",
    album: "Demo Album",
    cover_url: `https://example.com/${id}.jpg`,
    stream_url: `https://cdn.example.com/${id}.m4a`,
    duration_seconds: 180,
  };
}

function render(component: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);

  act(() => {
    root.render(component);
  });

  return container;
}

async function settle(attempt: Deferred) {
  await act(async () => {
    attempt.resolve();
    await attempt.promise;
  });
}

async function dispatchEnded(audio: HTMLAudioElement) {
  await act(async () => {
    audio.dispatchEvent(new Event("ended", { bubbles: true }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  playAttempts = [];
  hlsTestState.autoBuffer = true;
  hlsTestState.loadedSources.length = 0;
  hlsTestState.playedSessionIDs.length = 0;
  hlsTestState.startPositions.length = 0;

  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    hlsTestState.playedSessionIDs.push(this.dataset.playbackSessionId ?? null);
    const attempt = deferred();
    playAttempts.push(attempt);
    return attempt.promise;
  });
});

afterEach(() => {
  vi.useRealTimers();
  while (mountedRoots.length) {
    act(() => mountedRoots.pop()?.unmount());
  }
  document.body.replaceChildren();
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  vi.restoreAllMocks();
});

describe("Player media-event races", () => {
  it("does not return to playing when a stale play promise resolves after pause", async () => {
    usePlayerStore.getState().replaceQueue([track("a")], 0, true);
    render(<Player />);

    expect(playAttempts).toHaveLength(1);
    act(() => usePlayerStore.getState().togglePlayback());
    expect(usePlayerStore.getState()).toMatchObject({
      isPlaying: false,
      status: "paused",
    });

    await settle(playAttempts[0]);

    expect(usePlayerStore.getState()).toMatchObject({
      isPlaying: false,
      status: "paused",
    });
  });

  it("ignores a stale play promise after queue replacement but accepts the current one", async () => {
    usePlayerStore.getState().replaceQueue([track("old")], 0, true);
    render(<Player />);
    expect(playAttempts).toHaveLength(1);

    act(() => {
      usePlayerStore
        .getState()
        .replaceQueue([track("current"), track("next")], 0, true);
    });
    expect(playAttempts).toHaveLength(2);
    expect(selectCurrentItem(usePlayerStore.getState())?.track.external_id).toBe(
      "current",
    );
    expect(usePlayerStore.getState().status).toBe("ready");

    await settle(playAttempts[0]);

    expect(selectCurrentItem(usePlayerStore.getState())?.track.external_id).toBe(
      "current",
    );
    expect(usePlayerStore.getState().status).toBe("ready");

    await settle(playAttempts[1]);
    expect(usePlayerStore.getState()).toMatchObject({
      isPlaying: true,
      status: "playing",
    });
  });

  it("does not advance the replacement queue for an ended event from the old source", async () => {
    usePlayerStore.getState().replaceQueue([track("old")], 0, false);
    const container = render(<Player />);
    const audio = container.querySelector("audio")!;
    const oldQueueID = audio.dataset.queueId;
    expect(oldQueueID).toBeTruthy();

    act(() => {
      usePlayerStore
        .getState()
        .replaceQueue([track("current"), track("next")], 0, false);
    });
    expect(selectCurrentItem(usePlayerStore.getState())?.track.external_id).toBe(
      "current",
    );

    // An `ended` event queued by the previous media source can arrive after the
    // store already points at a replacement queue.
    audio.dataset.queueId = oldQueueID!;
    await dispatchEnded(audio);

    expect(selectCurrentItem(usePlayerStore.getState())?.track.external_id).toBe(
      "current",
    );
    expect(usePlayerStore.getState()).toMatchObject({
      currentIndex: 0,
      isPlaying: false,
      status: "paused",
    });
  });

  it("advances when ended belongs to the current media source", async () => {
    usePlayerStore
      .getState()
      .replaceQueue([track("current"), track("next")], 0, true);
    const container = render(<Player />);
    const audio = container.querySelector("audio")!;

    expect(audio.dataset.queueId).toBe(
      selectCurrentItem(usePlayerStore.getState())?.queueId,
    );
    await dispatchEnded(audio);

    expect(selectCurrentItem(usePlayerStore.getState())?.track.external_id).toBe(
      "next",
    );
    expect(usePlayerStore.getState()).toMatchObject({
      currentIndex: 1,
      isPlaying: true,
    });
  });

  it("does not advance when an ended event arrives after the user paused", async () => {
    usePlayerStore
      .getState()
      .replaceQueue([track("current"), track("next")], 0, true);
    const container = render(<Player />);
    const audio = container.querySelector("audio")!;

    act(() => usePlayerStore.getState().togglePlayback());
    await dispatchEnded(audio);

    expect(selectCurrentItem(usePlayerStore.getState())?.track.external_id).toBe(
      "current",
    );
    expect(usePlayerStore.getState()).toMatchObject({
      currentIndex: 0,
      isPlaying: false,
      status: "paused",
    });
  });

  it("keeps one HLS media source while crossing a track boundary", async () => {
    mockUserAgent(SAFARI_USER_AGENT);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    vi.spyOn(api, "createPlaybackSession").mockResolvedValue({
      id: "session-1",
      revision: 1,
      manifest_url: "/api/v1/me/playback-sessions/session-1/index.m3u8?revision=1",
      expires_at: "2099-01-01T00:00:00Z",
      start_offset_seconds: 0,
      has_more: false,
      items: [
        { ordinal: 0, track: track("a"), timeline_start_ms: 0, duration_ms: 10_000 },
        { ordinal: 1, track: track("b"), timeline_start_ms: 10_000, duration_ms: 10_000 },
      ],
    });
    usePlayerStore.getState().replaceQueue([track("a"), track("b")], 0, true);
    const container = render(<Player />);
    const audio = container.querySelector("audio")!;

    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const manifestSource = audio.getAttribute("src");
    expect(manifestSource).toContain("session-1/index.m3u8");

    audio.currentTime = 10;
    act(() => audio.dispatchEvent(new Event("timeupdate")));

    expect(selectCurrentItem(usePlayerStore.getState())?.track.external_id).toBe("b");
    expect(audio.getAttribute("src")).toBe(manifestSource);
  });

  it("reconciles the visible mobile player after background playback skips events", async () => {
    mockUserAgent(IPHONE_USER_AGENT);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    vi.spyOn(api, "createPlaybackSession").mockResolvedValue({
      id: "session-foreground-sync",
      revision: 1,
      manifest_url: "/api/v1/me/playback-sessions/session-foreground-sync/index.m3u8",
      expires_at: "2099-01-01T00:00:00Z",
      start_offset_seconds: 0,
      has_more: false,
      items: [
        { ordinal: 0, track: track("a"), timeline_start_ms: 0, duration_ms: 10_000 },
        { ordinal: 1, track: track("b"), timeline_start_ms: 10_000, duration_ms: 10_000 },
        { ordinal: 2, track: track("c"), timeline_start_ms: 20_000, duration_ms: 10_000 },
      ],
    });
    vi.spyOn(api, "getPlaybackSession").mockResolvedValue({
      id: "session-foreground-sync",
      revision: 1,
      manifest_url: "/api/v1/me/playback-sessions/session-foreground-sync/index.m3u8",
      expires_at: "2099-01-01T00:00:00Z",
      start_offset_seconds: 0,
      has_more: false,
      items: [
        { ordinal: 0, track: track("a"), timeline_start_ms: 0, duration_ms: 10_000 },
        { ordinal: 1, track: track("b"), timeline_start_ms: 10_000, duration_ms: 10_000 },
        { ordinal: 2, track: track("c"), timeline_start_ms: 20_000, duration_ms: 10_000 },
      ],
    });
    usePlayerStore.getState().replaceQueue([track("a"), track("b"), track("c")], 0, true);
    const container = render(<Player />);
    const audio = container.querySelector("audio")!;

    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(selectCurrentItem(usePlayerStore.getState())?.track.external_id).toBe("a");

    // Native HLS continued while JavaScript was frozen. No timeupdate was
    // delivered for either crossed boundary before the page returned.
    // iOS can report the pre-lock position for the first lifecycle event and
    // expose the advanced native HLS position a moment later.
    audio.currentTime = 9;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      audio.currentTime = 24;
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    expect(selectCurrentItem(usePlayerStore.getState())?.track.external_id).toBe("c");
    expect(usePlayerStore.getState()).toMatchObject({
      currentTime: 4,
      duration: 10,
      playbackTimelineTime: 24,
    });
  });

  it("preserves the restored HLS position while native media is still attaching", async () => {
    mockUserAgent(IPHONE_USER_AGENT);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    vi.spyOn(api, "createPlaybackSession").mockResolvedValue({
      id: "session-slow-native-attach",
      revision: 1,
      manifest_url: "/api/v1/me/playback-sessions/session-slow-native-attach/index.m3u8",
      expires_at: "2099-01-01T00:00:00Z",
      start_offset_seconds: 73,
      has_more: false,
      items: [
        { ordinal: 0, track: track("a"), timeline_start_ms: 0, duration_ms: 180_000 },
      ],
    });
    usePlayerStore.getState().replaceQueue([track("a")], 0, true);
    vi.useFakeTimers();
    const container = render(<Player />);
    const audio = container.querySelector("audio")!;

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(usePlayerStore.getState().playbackTimelineTime).toBe(73);

    audio.currentTime = 0;
    act(() => {
      audio.dispatchEvent(new Event("durationchange"));
      vi.advanceTimersByTime(1_500);
    });
    expect(usePlayerStore.getState()).toMatchObject({
      currentTime: 73,
      playbackTimelineTime: 73,
    });

    act(() => audio.dispatchEvent(new Event("loadedmetadata")));
    audio.currentTime = 74;
    act(() => audio.dispatchEvent(new Event("canplay")));
    expect(usePlayerStore.getState()).toMatchObject({
      currentTime: 74,
      playbackTimelineTime: 74,
    });
  });

  it("refreshes missing timeline metadata instead of pinning the UI to the old last track", async () => {
    mockUserAgent(IPHONE_USER_AGENT);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    const firstPage = {
      id: "session-growing-timeline",
      revision: 1,
      manifest_url: "/api/v1/me/playback-sessions/session-growing-timeline/index.m3u8",
      expires_at: "2099-01-01T00:00:00Z",
      start_offset_seconds: 0,
      has_more: true,
      items: [
        { ordinal: 0, track: track("a"), timeline_start_ms: 0, duration_ms: 10_000 },
      ],
    };
    vi.spyOn(api, "createPlaybackSession").mockResolvedValue(firstPage);
    vi.spyOn(api, "getPlaybackSession").mockResolvedValue({
      ...firstPage,
      items: [
        ...firstPage.items,
        { ordinal: 1, track: track("b"), timeline_start_ms: 10_000, duration_ms: 10_000 },
      ],
    });
    usePlayerStore.getState().replaceQueue([track("a")], 0, true);
    const container = render(<Player />);
    const audio = container.querySelector("audio")!;

    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    audio.currentTime = 12;
    await act(async () => {
      audio.dispatchEvent(new Event("timeupdate"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.getPlaybackSession).toHaveBeenCalledWith(
      "session-growing-timeline",
    );
    expect(selectCurrentItem(usePlayerStore.getState())?.track.external_id).toBe("b");
    expect(usePlayerStore.getState()).toMatchObject({
      currentTime: 2,
      duration: 10,
      playbackTimelineTime: 12,
    });
  });

  it("backs off while missing timeline metadata is temporarily unavailable", async () => {
    mockUserAgent(IPHONE_USER_AGENT);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    const firstPage = {
      id: "session-timeline-backoff",
      revision: 1,
      manifest_url: "/api/v1/me/playback-sessions/session-timeline-backoff/index.m3u8",
      expires_at: "2099-01-01T00:00:00Z",
      start_offset_seconds: 0,
      has_more: true,
      items: [
        { ordinal: 0, track: track("a"), timeline_start_ms: 0, duration_ms: 10_000 },
      ],
    };
    vi.spyOn(api, "createPlaybackSession").mockResolvedValue(firstPage);
    const refresh = vi.spyOn(api, "getPlaybackSession");
    refresh.mockRejectedValueOnce(new Error("temporary outage"));
    usePlayerStore.getState().replaceQueue([track("a")], 0, true);
    const container = render(<Player />);
    const audio = container.querySelector("audio")!;

    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    vi.useFakeTimers();
    audio.currentTime = 12;
    await act(async () => {
      audio.dispatchEvent(new Event("timeupdate"));
      audio.dispatchEvent(new Event("progress"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().playbackTimelineTime).toBe(12);

    refresh.mockResolvedValueOnce({
      ...firstPage,
      revision: 2,
      items: [
        ...firstPage.items,
        { ordinal: 1, track: track("b"), timeline_start_ms: 10_000, duration_ms: 10_000 },
      ],
    });
    await act(async () => {
      vi.advanceTimersByTime(2_100);
      audio.dispatchEvent(new Event("timeupdate"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(selectCurrentItem(usePlayerStore.getState())?.track.external_id).toBe("b");
    expect(usePlayerStore.getState()).toMatchObject({
      currentTime: 2,
      playbackTimelineTime: 12,
    });
  });

  it("does not let a pending refresh from an old queue block the new session", async () => {
    mockUserAgent(IPHONE_USER_AGENT);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    const sessionA = {
      id: "session-refresh-a",
      revision: 1,
      manifest_url: "/api/v1/me/playback-sessions/session-refresh-a/index.m3u8",
      expires_at: "2099-01-01T00:00:00Z",
      start_offset_seconds: 0,
      has_more: false,
      items: [
        { ordinal: 0, track: track("a"), timeline_start_ms: 0, duration_ms: 10_000 },
      ],
    };
    const sessionB = {
      ...sessionA,
      id: "session-refresh-b",
      manifest_url: "/api/v1/me/playback-sessions/session-refresh-b/index.m3u8",
      items: [
        { ordinal: 0, track: track("b"), timeline_start_ms: 0, duration_ms: 10_000 },
      ],
    };
    vi.spyOn(api, "createPlaybackSession")
      .mockResolvedValueOnce(sessionA)
      .mockResolvedValueOnce(sessionB);
    const refresh = vi.spyOn(api, "getPlaybackSession");
    refresh
      .mockReturnValueOnce(new Promise<never>(() => {}))
      .mockResolvedValueOnce(sessionB);
    vi.spyOn(api, "deletePlaybackSession").mockResolvedValue(undefined);
    usePlayerStore.getState().replaceQueue([track("a")], 0, true);
    render(<Player />);

    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() => window.dispatchEvent(new Event("focus")));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenLastCalledWith("session-refresh-a");

    act(() => usePlayerStore.getState().replaceQueue([track("b")], 0, true));
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(usePlayerStore.getState().playbackSessionId).toBe("session-refresh-b");

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith("session-refresh-b");
  });

  it("ignores a transient HLS pause and reconciles on resumed playback", async () => {
    mockUserAgent(IPHONE_USER_AGENT);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    vi.spyOn(api, "createPlaybackSession").mockResolvedValue({
      id: "session-transient-pause",
      revision: 1,
      manifest_url: "/api/v1/me/playback-sessions/session-transient-pause/index.m3u8",
      expires_at: "2099-01-01T00:00:00Z",
      start_offset_seconds: 0,
      has_more: false,
      items: [
        { ordinal: 0, track: track("a"), timeline_start_ms: 0, duration_ms: 10_000 },
        { ordinal: 1, track: track("b"), timeline_start_ms: 10_000, duration_ms: 10_000 },
      ],
    });
    usePlayerStore.getState().replaceQueue([track("a"), track("b")], 0, true);
    const container = render(<Player />);
    const audio = container.querySelector("audio")!;

    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    audio.currentTime = 12;
    act(() => {
      audio.dispatchEvent(new Event("pause"));
      audio.dispatchEvent(new Event("playing"));
    });

    expect(selectCurrentItem(usePlayerStore.getState())?.track.external_id).toBe("b");
    expect(usePlayerStore.getState()).toMatchObject({
      currentTime: 2,
      duration: 10,
      isPlaying: true,
      status: "playing",
    });
  });

  it("keeps playback intent while a hidden HLS stream is recovering", async () => {
    mockUserAgent(IPHONE_USER_AGENT);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    vi.spyOn(api, "createPlaybackSession").mockResolvedValue({
      id: "session-hidden-pause",
      revision: 1,
      manifest_url: "/api/v1/me/playback-sessions/session-hidden-pause/index.m3u8",
      expires_at: "2099-01-01T00:00:00Z",
      start_offset_seconds: 0,
      has_more: false,
      items: [
        { ordinal: 0, track: track("a"), timeline_start_ms: 0, duration_ms: 10_000 },
        { ordinal: 1, track: track("b"), timeline_start_ms: 10_000, duration_ms: 10_000 },
      ],
    });
    usePlayerStore.getState().replaceQueue([track("a"), track("b")], 0, true);
    const container = render(<Player />);
    const audio = container.querySelector("audio")!;

    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    audio.currentTime = 12;
    vi.useFakeTimers();
    act(() => {
      audio.dispatchEvent(new Event("pause"));
      audio.dispatchEvent(new Event("waiting"));
      vi.advanceTimersByTime(500);
    });

    expect(usePlayerStore.getState()).toMatchObject({
      currentTime: 2,
      isPlaying: true,
      status: "retrying",
    });

    act(() => audio.dispatchEvent(new Event("playing")));
    expect(usePlayerStore.getState()).toMatchObject({
      currentTime: 2,
      isPlaying: true,
      status: "playing",
    });
  });

  it("keeps the live position and resumes play after a late native HLS failure", async () => {
    mockUserAgent(SAFARI_USER_AGENT);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    vi.spyOn(api, "createPlaybackSession").mockResolvedValue({
      id: "session-native-fallback",
      revision: 1,
      manifest_url: "/api/v1/me/playback-sessions/session-native-fallback/index.m3u8",
      expires_at: "2099-01-01T00:00:00Z",
      start_offset_seconds: 0,
      has_more: false,
      items: [
        {
          ordinal: 0,
          track: track("a"),
          timeline_start_ms: 0,
          duration_ms: 180_000,
        },
      ],
    });
    usePlayerStore.getState().replaceQueue([track("a")], 0, true);
    const container = render(<Player />);
    const audio = container.querySelector("audio")!;

    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      audio.dispatchEvent(new Event("loadedmetadata"));
      audio.dispatchEvent(new Event("canplay"));
      await Promise.resolve();
    });
    audio.currentTime = 73;
    const attemptsBeforeRecovery = playAttempts.length;

    await act(async () => {
      audio.dispatchEvent(new Event("error"));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      audio.dispatchEvent(new Event("loadedmetadata"));
      audio.dispatchEvent(new Event("canplay"));
      await Promise.resolve();
    });

    expect(audio.currentTime).toBe(73);
    expect(usePlayerStore.getState()).toMatchObject({
      isPlaying: true,
      playbackSessionId: "session-native-fallback",
      playbackTimelineTime: 73,
    });
    expect(hlsTestState.loadedSources).toHaveLength(0);
    expect(playAttempts.length).toBeGreaterThan(attemptsBeforeRecovery);
  });

  it("falls back to progressive playback while HLS assets are incomplete", async () => {
    vi.spyOn(api, "createPlaybackSession").mockRejectedValue(
      new APIError(503, {
        code: "hls_backfill_incomplete",
        message: "HLS is still being prepared",
      }),
    );
    usePlayerStore.getState().replaceQueue([track("a")], 0, true);
    const container = render(<Player />);
    const audio = container.querySelector("audio")!;

    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(audio.src).toBe("https://cdn.example.com/a.m4a");
    expect(selectCurrentItem(usePlayerStore.getState())?.track.external_id).toBe("a");
  });

  it("recreates an expired persisted HLS session instead of getting stuck", async () => {
    mockUserAgent(SAFARI_USER_AGENT);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    vi.spyOn(api, "getPlaybackSession").mockRejectedValue(
      new APIError(410, {
        code: "playback_session_expired",
        message: "Playback session expired",
      }),
    );
    const create = vi.spyOn(api, "createPlaybackSession").mockResolvedValue({
      id: "session-fresh",
      revision: 1,
      manifest_url: "/api/v1/me/playback-sessions/session-fresh/index.m3u8",
      expires_at: "2099-01-01T00:00:00Z",
      start_offset_seconds: 3,
      has_more: false,
      items: [
        { ordinal: 0, track: track("a"), timeline_start_ms: 0, duration_ms: 10_000 },
      ],
    });
    usePlayerStore.getState().replaceQueue([track("a")], 0, false);
    const context = usePlayerStore.getState().queueContextId;
    usePlayerStore.getState().setPlaybackSession(
      "session-stale",
      context,
      3,
      { kind: "search", query: "demo" },
    );
    const container = render(<Player />);
    const audio = container.querySelector("audio")!;

    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(audio.getAttribute("src")).toContain("session-fresh/index.m3u8");
    expect(usePlayerStore.getState().playbackSessionId).toBe("session-fresh");
  });

  it("uses hls.js in Chrome even when canPlayType returns maybe", async () => {
    mockUserAgent(CHROME_USER_AGENT);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    vi.spyOn(api, "createPlaybackSession").mockResolvedValue({
      id: "session-chrome",
      revision: 1,
      manifest_url: "/api/v1/me/playback-sessions/session-chrome/index.m3u8",
      expires_at: "2099-01-01T00:00:00Z",
      start_offset_seconds: 0,
      has_more: false,
      items: [
        { ordinal: 0, track: track("a"), timeline_start_ms: 0, duration_ms: 180_000 },
      ],
    });
    usePlayerStore.getState().replaceQueue([track("a")], 0, false);
    const container = render(<Player />);
    const audio = container.querySelector("audio")!;

    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(hlsTestState.loadedSources).toContain(
      "/api/v1/me/playback-sessions/session-chrome/index.m3u8",
    );
    expect(audio.getAttribute("src")).not.toContain("session-chrome/index.m3u8");
  });

  it("uses hls.js directly on Android even when Chromium advertises native HLS", async () => {
    mockUserAgent(ANDROID_CHROME_USER_AGENT);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    vi.spyOn(api, "createPlaybackSession").mockResolvedValue({
      id: "session-android-probe",
      revision: 1,
      manifest_url: "/api/v1/me/playback-sessions/session-android-probe/index.m3u8",
      expires_at: "2099-01-01T00:00:00Z",
      start_offset_seconds: 0,
      has_more: false,
      items: [
        { ordinal: 0, track: track("a"), timeline_start_ms: 0, duration_ms: 180_000 },
      ],
    });
    usePlayerStore.getState().replaceQueue([track("a")], 0, false);
    const container = render(<Player />);
    const audio = container.querySelector("audio")!;

    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(hlsTestState.loadedSources).toContain(
      "/api/v1/me/playback-sessions/session-android-probe/index.m3u8",
    );
    expect(audio.getAttribute("src") ?? "").not.toContain(
      "session-android-probe/index.m3u8",
    );
  });

  it("starts iOS native playback inside the first explicit Play gesture", async () => {
    mockUserAgent(IPHONE_USER_AGENT);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    vi.spyOn(api, "createPlaybackSession").mockResolvedValue({
      id: "session-ios-gesture",
      revision: 1,
      manifest_url: "/api/v1/me/playback-sessions/session-ios-gesture/index.m3u8",
      expires_at: "2099-01-01T00:00:00Z",
      start_offset_seconds: 0,
      has_more: false,
      items: [
        { ordinal: 0, track: track("a"), timeline_start_ms: 0, duration_ms: 180_000 },
      ],
    });
    usePlayerStore.getState().replaceQueue([track("a")], 0, false);
    const container = render(<Player />);

    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(hlsTestState.playedSessionIDs).not.toContain("session-ios-gesture");

    act(() => {
      container.querySelector<HTMLButtonElement>(".desktop-play-main")!.click();
    });

    expect(usePlayerStore.getState().isPlaying).toBe(true);
    expect(hlsTestState.playedSessionIDs).toContain("session-ios-gesture");
  });

  it("unlocks the audio element in the original TrackCard click before HLS is ready", () => {
    mockUserAgent(IPHONE_USER_AGENT);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    vi.spyOn(api, "createPlaybackSession").mockImplementation(
      () => new Promise(() => {}),
    );
    const selectedTrack = { ...track("first-ios-track"), stream_url: undefined };
    const container = render(
      <MemoryRouter>
        <TrackCard track={selectedTrack} />
        <Player />
      </MemoryRouter>,
    );

    let attemptsBeforeTheClickReturned = 0;
    act(() => {
      container
        .querySelector<HTMLButtonElement>(".desktop-track-play")!
        .click();
      attemptsBeforeTheClickReturned = playAttempts.length;
    });

    expect(attemptsBeforeTheClickReturned).toBe(1);
    expect(hlsTestState.playedSessionIDs[0]).toBeNull();
    expect(usePlayerStore.getState()).toMatchObject({
      currentIndex: 0,
      isPlaying: true,
    });
    const audio = container.querySelector("audio")!;
    expect(audio.dataset.playbackActivation).toBe(selectedTrack.external_id);
    act(() => audio.dispatchEvent(new Event("ended")));
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it("exposes the synchronous activation bridge while Player is mounted", () => {
    const container = render(<Player />);
    const audio = container.querySelector("audio")!;

    act(() => requestPlaybackActivation("bridge-track"));

    expect(playAttempts).toHaveLength(1);
    expect(audio.dataset.playbackActivation).toBe("bridge-track");
  });

  it("waits for buffered media or canplay before starting hls.js playback", async () => {
    mockUserAgent(CHROME_USER_AGENT);
    hlsTestState.autoBuffer = false;
    vi.spyOn(api, "createPlaybackSession").mockResolvedValue({
      id: "session-canplay",
      revision: 1,
      manifest_url: "/api/v1/me/playback-sessions/session-canplay/index.m3u8",
      expires_at: "2099-01-01T00:00:00Z",
      start_offset_seconds: 0,
      has_more: false,
      items: [
        { ordinal: 0, track: track("a"), timeline_start_ms: 0, duration_ms: 180_000 },
      ],
    });
    usePlayerStore.getState().replaceQueue([track("a")], 0, true);
    const container = render(<Player />);
    const audio = container.querySelector("audio")!;

    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(hlsTestState.loadedSources).toHaveLength(1);
    expect(hlsTestState.playedSessionIDs).not.toContain("session-canplay");

    const attemptsBeforeCanPlay = playAttempts.length;
    await act(async () => {
      audio.dispatchEvent(new Event("canplay"));
      await Promise.resolve();
    });
    expect(playAttempts.length).toBeGreaterThan(attemptsBeforeCanPlay);
    expect(hlsTestState.playedSessionIDs).toContain("session-canplay");
  });

  it("recovers a persistent unsolicited HLS pause without losing play intent", async () => {
    mockUserAgent(CHROME_USER_AGENT);
    vi.spyOn(api, "createPlaybackSession").mockResolvedValue({
      id: "session-pause",
      revision: 1,
      manifest_url: "/api/v1/me/playback-sessions/session-pause/index.m3u8",
      expires_at: "2099-01-01T00:00:00Z",
      start_offset_seconds: 0,
      has_more: false,
      items: [
        { ordinal: 0, track: track("a"), timeline_start_ms: 0, duration_ms: 180_000 },
      ],
    });
    usePlayerStore.getState().replaceQueue([track("a")], 0, true);
    const container = render(<Player />);
    const audio = container.querySelector("audio")!;

    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(playAttempts.length).toBeGreaterThan(0);
    await settle(playAttempts[playAttempts.length - 1]);
    act(() => audio.dispatchEvent(new Event("playing")));

    vi.useFakeTimers();
    act(() => {
      audio.dispatchEvent(new Event("pause"));
      vi.advanceTimersByTime(400);
    });

    expect(usePlayerStore.getState()).toMatchObject({
      isPlaying: true,
      status: "retrying",
    });

    act(() => audio.dispatchEvent(new Event("playing")));
    expect(usePlayerStore.getState()).toMatchObject({
      isPlaying: true,
      status: "playing",
    });
  });

  it("does not let a stale HLS playing event undo an explicit pause", async () => {
    mockUserAgent(CHROME_USER_AGENT);
    vi.spyOn(api, "createPlaybackSession").mockResolvedValue({
      id: "session-explicit-pause",
      revision: 1,
      manifest_url: "/api/v1/me/playback-sessions/session-explicit-pause/index.m3u8",
      expires_at: "2099-01-01T00:00:00Z",
      start_offset_seconds: 0,
      has_more: false,
      items: [
        { ordinal: 0, track: track("a"), timeline_start_ms: 0, duration_ms: 180_000 },
      ],
    });
    usePlayerStore.getState().replaceQueue([track("a")], 0, true);
    const container = render(<Player />);
    const audio = container.querySelector("audio")!;

    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() => audio.dispatchEvent(new Event("playing")));
    expect(usePlayerStore.getState().isPlaying).toBe(true);

    act(() => usePlayerStore.getState().togglePlayback());
    expect(usePlayerStore.getState()).toMatchObject({
      isPlaying: false,
      status: "paused",
    });

    act(() => audio.dispatchEvent(new Event("playing")));
    expect(usePlayerStore.getState()).toMatchObject({
      isPlaying: false,
      status: "paused",
    });
  });

  it("resumes the same HLS timeline after offline, Pause, Online, then Play", async () => {
    mockUserAgent(CHROME_USER_AGENT);
    let online = true;
    vi.spyOn(window.navigator, "onLine", "get").mockImplementation(
      () => online,
    );
    vi.spyOn(api, "createPlaybackSession").mockResolvedValue({
      id: "session-offline",
      revision: 1,
      manifest_url: "/api/v1/me/playback-sessions/session-offline/index.m3u8",
      expires_at: "2099-01-01T00:00:00Z",
      start_offset_seconds: 0,
      has_more: false,
      items: [
        { ordinal: 0, track: track("a"), timeline_start_ms: 0, duration_ms: 180_000 },
      ],
    });
    usePlayerStore.getState().replaceQueue([track("a")], 0, true);
    const container = render(<Player />);
    const audio = container.querySelector("audio")!;

    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(playAttempts.length).toBeGreaterThan(0);
    await settle(playAttempts[playAttempts.length - 1]);
    audio.currentTime = 42;
    act(() => audio.dispatchEvent(new Event("playing")));

    online = false;
    act(() => audio.dispatchEvent(new Event("waiting")));
    expect(usePlayerStore.getState()).toMatchObject({
      isPlaying: true,
      status: "retrying",
      playbackSessionId: "session-offline",
      playbackTimelineTime: 42,
    });
    expect(usePlayerStore.getState().error).toContain("offline");

    act(() => {
      container.querySelector<HTMLButtonElement>(".desktop-play-main")!.click();
    });
    expect(usePlayerStore.getState()).toMatchObject({
      isPlaying: false,
      status: "paused",
      playbackTimelineTime: 42,
    });

    online = true;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(hlsTestState.startPositions).toHaveLength(0);

    act(() => {
      container.querySelector<HTMLButtonElement>(".desktop-play-main")!.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(hlsTestState.startPositions).toContain(42);

    const attemptsBeforeCanPlay = playAttempts.length;
    await act(async () => {
      audio.dispatchEvent(new Event("canplay"));
      await Promise.resolve();
    });
    expect(playAttempts.length).toBeGreaterThan(attemptsBeforeCanPlay);
    expect(usePlayerStore.getState().playbackSessionId).toBe("session-offline");
  });
});
