import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { selectCurrentItem, usePlayerStore } from "../store/player-store";
import type { Track } from "../types";
import { Player } from "./Player";

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
});
