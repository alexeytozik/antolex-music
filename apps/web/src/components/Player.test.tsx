import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { APIError, api } from "../lib/api";
import { selectCurrentItem, usePlayerStore } from "../store/player-store";
import type { Track } from "../types";
import { Player } from "./Player";

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
    loadSource() { this.handlers.get(MockHLS.Events.MANIFEST_PARSED)?.(); }
    destroy() {}
    startLoad() {}
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

  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => {
    const attempt = deferred();
    playAttempts.push(attempt);
    return attempt.promise;
  });
});

afterEach(() => {
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

  it("keeps the live position and resumes play after a late native HLS failure", async () => {
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
    });
    audio.currentTime = 73;
    const attemptsBeforeFallback = playAttempts.length;

    await act(async () => {
      audio.dispatchEvent(new Event("error"));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(audio.currentTime).toBe(73);
    expect(usePlayerStore.getState()).toMatchObject({
      isPlaying: true,
      playbackSessionId: "session-native-fallback",
      playbackTimelineTime: 73,
    });
    expect(playAttempts.length).toBeGreaterThan(attemptsBeforeFallback);
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
});
