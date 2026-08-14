import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  QueueContinuation,
  QUEUE_PREFETCH_DISTANCE,
  QUEUE_RETRY_MAX_DELAY_MS,
  queueContinuationRetryDelay,
  shouldPrefetchQueue,
  uniqueContinuationTracks,
} from "./QueueContinuation";
import { APIError, api } from "../lib/api";
import {
  startQueueContinuation,
  stopQueueContinuation,
} from "../store/queue-continuation-store";
import { selectHasNext, usePlayerStore } from "../store/player-store";
import type { SearchResponse, Track } from "../types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: ReturnType<typeof createRoot>[] = [];

function track(externalId: string): Track {
  return {
    external_id: externalId,
    title: externalId,
    artist: "Artist",
    cover_url: "/cover.svg",
    duration_seconds: 180,
  };
}

function searchPage(
  page: number,
  results: Track[],
  nextCursor?: string,
): SearchResponse {
  return {
    query: "",
    source: "library",
    cached: false,
    results,
    page,
    page_size: 20,
    total_count: 120,
    total_pages: 6,
    has_prev: page > 1,
    has_next: Boolean(nextCursor),
    next_cursor: nextCursor,
  };
}

async function flushContinuation() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mountContinuation() {
  const container = document.createElement("div");
  const root = createRoot(container);
  mountedRoots.push(root);
  act(() => root.render(createElement(QueueContinuation)));
}

afterEach(() => {
  vi.useRealTimers();
  while (mountedRoots.length > 0) {
    act(() => mountedRoots.pop()?.unmount());
  }
  stopQueueContinuation();
  usePlayerStore.getState().clearQueue();
  vi.restoreAllMocks();
});

describe("queue continuation", () => {
  it("prefetches five tracks before the current page ends", () => {
    expect(shouldPrefetchQueue(20, 14, true)).toBe(false);
    expect(
      shouldPrefetchQueue(20, 20 - QUEUE_PREFETCH_DISTANCE, true),
    ).toBe(true);
    expect(shouldPrefetchQueue(20, 19, false)).toBe(false);
  });

  it("appends only new track ids while preserving server order", () => {
    const result = uniqueContinuationTracks(
      ["track-1", "track-2"],
      [track("track-2"), track("track-3"), track("track-3"), track("track-4")],
    );

    expect(result.map((item) => item.external_id)).toEqual([
      "track-3",
      "track-4",
    ]);
  });

  it("backs off transient continuation failures without unbounded waits", () => {
    expect(queueContinuationRetryDelay(1)).toBe(1_000);
    expect(queueContinuationRetryDelay(2)).toBe(2_000);
    expect(queueContinuationRetryDelay(99)).toBe(QUEUE_RETRY_MAX_DELAY_MS);
  });

  it("loads and appends the next cursor page before playback reaches the end", async () => {
    const initialTracks = Array.from({ length: 20 }, (_, index) =>
      track(`track-${index + 1}`),
    );
    usePlayerStore.getState().replaceQueue(initialTracks, 15, false);
    startQueueContinuation({
      source: { kind: "search", query: "reise" },
      cursor: "cursor-20",
      page: 1,
      hasMore: true,
      queueContextId: usePlayerStore.getState().queueContextId,
    });
    const search = vi.spyOn(api, "searchWithCursor").mockResolvedValue({
      query: "reise",
      source: "library",
      cached: false,
      results: [track("track-20"), track("track-21"), track("track-22")],
      page: 2,
      page_size: 20,
      total_count: 40,
      total_pages: 2,
      has_prev: true,
      has_next: false,
    });

    const container = document.createElement("div");
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => {
      root.render(createElement(QueueContinuation));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(search).toHaveBeenCalledWith(
      "reise",
      2,
      "cursor-20",
      expect.any(AbortSignal),
    );
    expect(
      usePlayerStore
        .getState()
        .queue.map((item) => item.track.external_id)
        .slice(-3),
    ).toEqual(["track-20", "track-21", "track-22"]);
    expect(usePlayerStore.getState().queue).toHaveLength(22);
  });

  it("retries a transient page failure and keeps the queue moving", async () => {
    vi.useFakeTimers();
    const initialTracks = Array.from({ length: 20 }, (_, index) =>
      track(`track-${index + 1}`),
    );
    usePlayerStore.getState().replaceQueue(initialTracks, 15, false);
    startQueueContinuation({
      source: { kind: "search", query: "reise" },
      cursor: "cursor-20",
      page: 1,
      hasMore: true,
      queueContextId: usePlayerStore.getState().queueContextId,
    });
    const search = vi
      .spyOn(api, "searchWithCursor")
      .mockRejectedValueOnce(
        new APIError(503, {
          code: "temporarily_unavailable",
          message: "Temporarily unavailable",
        }),
      )
      .mockResolvedValueOnce({
        query: "reise",
        source: "library",
        cached: false,
        results: [track("track-21")],
        page: 2,
        page_size: 20,
        total_count: 21,
        total_pages: 2,
        has_prev: true,
        has_next: false,
      });

    const container = document.createElement("div");
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => {
      root.render(createElement(QueueContinuation));
      await Promise.resolve();
    });
    expect(search).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(search).toHaveBeenCalledTimes(2);
    expect(
      usePlayerStore.getState().queue.at(-1)?.track.external_id,
    ).toBe("track-21");
  });

  it("continues past one hundred tracks while keeping consumed history bounded", async () => {
    const initialTracks = Array.from({ length: 20 }, (_, index) =>
      track(`track-${index + 1}`),
    );
    usePlayerStore.getState().replaceQueue(initialTracks, 15, false);
    const queueContextId = usePlayerStore.getState().queueContextId;
    startQueueContinuation({
      source: { kind: "search", query: "" },
      cursor: "cursor-20",
      page: 1,
      hasMore: true,
      queueContextId,
    });
    const search = vi
      .spyOn(api, "searchWithCursor")
      .mockImplementation(async (_query, page) => {
        const pageNumber = page ?? 1;
        const first = (pageNumber - 1) * 20 + 1;
        const results = Array.from({ length: 20 }, (_, index) =>
          track(`track-${first + index}`),
        );
        return searchPage(
          pageNumber,
          results,
          pageNumber < 6 ? `cursor-${pageNumber * 20}` : undefined,
        );
      });

    mountContinuation();
    await flushContinuation();
    for (let page = 3; page <= 6; page += 1) {
      await act(async () => {
        const queueLength = usePlayerStore.getState().queue.length;
        usePlayerStore.setState({ currentIndex: queueLength - 5 });
      });
      await flushContinuation();
    }

    const state = usePlayerStore.getState();
    expect(search).toHaveBeenCalledTimes(5);
    expect(state.queue).toHaveLength(65);
    expect(state.queue[0]?.track.external_id).toBe("track-56");
    expect(state.queue.at(-1)?.track.external_id).toBe("track-120");
    expect(state.queueContextId).toBe(queueContextId);
  });

  it("automatically advances when a delayed page arrives after the track ended", async () => {
    const initialTracks = Array.from({ length: 20 }, (_, index) =>
      track(`track-${index + 1}`),
    );
    usePlayerStore.getState().replaceQueue(initialTracks, 19, true);
    const queueContextId = usePlayerStore.getState().queueContextId;
    startQueueContinuation({
      source: { kind: "search", query: "" },
      cursor: "cursor-20",
      page: 1,
      hasMore: true,
      queueContextId,
    });
    let resolvePage!: (response: SearchResponse) => void;
    vi.spyOn(api, "searchWithCursor").mockReturnValue(
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );

    mountContinuation();
    expect(selectHasNext(usePlayerStore.getState())).toBe(true);
    await act(async () => {
      usePlayerStore.getState().handleTrackEnded();
      await Promise.resolve();
    });
    expect(usePlayerStore.getState()).toMatchObject({
      currentIndex: 19,
      isPlaying: true,
      status: "retrying",
      pendingAdvanceQueueContextId: queueContextId,
    });

    resolvePage(searchPage(2, [track("track-21")]));
    await flushContinuation();

    const state = usePlayerStore.getState();
    expect(state.queue[state.currentIndex]?.track.external_id).toBe("track-21");
    expect(state.isPlaying).toBe(true);
    expect(state.pendingAdvanceQueueContextId).toBeNull();
  });

  it("does not auto-advance after the user pauses while waiting", async () => {
    const initialTracks = Array.from({ length: 20 }, (_, index) =>
      track(`track-${index + 1}`),
    );
    usePlayerStore.getState().replaceQueue(initialTracks, 19, true);
    const queueContextId = usePlayerStore.getState().queueContextId;
    startQueueContinuation({
      source: { kind: "search", query: "" },
      cursor: "cursor-20",
      page: 1,
      hasMore: true,
      queueContextId,
    });
    let resolvePage!: (response: SearchResponse) => void;
    vi.spyOn(api, "searchWithCursor").mockReturnValue(
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );

    mountContinuation();
    await act(async () => {
      usePlayerStore.getState().handleTrackEnded();
      await Promise.resolve();
      usePlayerStore.getState().togglePlayback();
    });
    resolvePage(searchPage(2, [track("track-21")]));
    await flushContinuation();

    const state = usePlayerStore.getState();
    expect(state.queue[state.currentIndex]?.track.external_id).toBe("track-20");
    expect(state.isPlaying).toBe(false);
    expect(state.pendingAdvanceQueueContextId).toBeNull();
  });

  it("does not append or auto-play a stale page after the queue was replaced", async () => {
    const initialTracks = Array.from({ length: 20 }, (_, index) =>
      track(`track-${index + 1}`),
    );
    usePlayerStore.getState().replaceQueue(initialTracks, 19, true);
    const queueContextId = usePlayerStore.getState().queueContextId;
    startQueueContinuation({
      source: { kind: "search", query: "" },
      cursor: "cursor-20",
      page: 1,
      hasMore: true,
      queueContextId,
    });
    let resolvePage!: (response: SearchResponse) => void;
    vi.spyOn(api, "searchWithCursor").mockReturnValue(
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );

    mountContinuation();
    await act(async () => {
      usePlayerStore.getState().handleTrackEnded();
      await Promise.resolve();
      usePlayerStore.getState().replaceQueue([track("replacement")], 0, true);
    });
    resolvePage(searchPage(2, [track("track-21")]));
    await flushContinuation();

    const state = usePlayerStore.getState();
    expect(state.queue.map((item) => item.track.external_id)).toEqual([
      "replacement",
    ]);
    expect(state.queue[state.currentIndex]?.track.external_id).toBe(
      "replacement",
    );
    expect(state.pendingAdvanceQueueContextId).toBeNull();
  });

  it("stops waiting when the final page contains only a duplicate", async () => {
    const initialTracks = Array.from({ length: 20 }, (_, index) =>
      track(`track-${index + 1}`),
    );
    usePlayerStore.getState().replaceQueue(initialTracks, 19, true);
    const queueContextId = usePlayerStore.getState().queueContextId;
    startQueueContinuation({
      source: { kind: "search", query: "" },
      cursor: "cursor-20",
      page: 1,
      hasMore: true,
      queueContextId,
    });
    let resolvePage!: (response: SearchResponse) => void;
    vi.spyOn(api, "searchWithCursor").mockReturnValue(
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );

    mountContinuation();
    await act(async () => {
      usePlayerStore.getState().handleTrackEnded();
      await Promise.resolve();
    });
    resolvePage(searchPage(2, [track("track-20")]));
    await flushContinuation();

    expect(usePlayerStore.getState()).toMatchObject({
      currentIndex: 19,
      isPlaying: false,
      status: "paused",
      pendingAdvanceQueueContextId: null,
    });
  });

  it("stops waiting after a terminal continuation error", async () => {
    const initialTracks = Array.from({ length: 20 }, (_, index) =>
      track(`track-${index + 1}`),
    );
    usePlayerStore.getState().replaceQueue(initialTracks, 19, true);
    const queueContextId = usePlayerStore.getState().queueContextId;
    startQueueContinuation({
      source: { kind: "search", query: "" },
      cursor: "cursor-20",
      page: 1,
      hasMore: true,
      queueContextId,
    });
    let rejectPage!: (reason: unknown) => void;
    vi.spyOn(api, "searchWithCursor").mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectPage = reject;
      }),
    );

    mountContinuation();
    await act(async () => {
      usePlayerStore.getState().handleTrackEnded();
      await Promise.resolve();
    });
    rejectPage(
      new APIError(400, {
        code: "invalid_cursor",
        message: "The queue cursor is invalid",
      }),
    );
    await flushContinuation();

    expect(usePlayerStore.getState()).toMatchObject({
      isPlaying: false,
      status: "paused",
      error: "The queue cursor is invalid",
      pendingAdvanceQueueContextId: null,
    });
    expect(selectHasNext(usePlayerStore.getState())).toBe(false);
  });
});
