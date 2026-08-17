import { describe, expect, it } from "vitest";

import type { PlaybackSessionItem, Track } from "../types";
import {
  createPlaybackSessionInput,
  findPlaybackBoundary,
  timelinePositionFor,
} from "./playback-session";

function track(id: string): Track {
  return {
    external_id: id,
    title: id,
    artist: "Artist",
    cover_url: "",
    duration_seconds: 10,
  };
}

function item(ordinal: number, start: number, duration = 10): PlaybackSessionItem {
  return {
    ordinal,
    track: track(String(ordinal)),
    timeline_start_ms: start * 1000,
    duration_ms: duration * 1000,
  };
}

describe("playback session timeline", () => {
  it("maps an exact boundary to the following track", () => {
    const result = findPlaybackBoundary([item(0, 0), item(1, 10)], 10);
    expect(result?.item.ordinal).toBe(1);
    expect(result?.localSeconds).toBe(0);
  });

  it("clamps positions at both ends", () => {
    expect(findPlaybackBoundary([item(0, 5)], 0)?.localSeconds).toBe(0);
    expect(findPlaybackBoundary([item(0, 5)], 30)?.localSeconds).toBe(10);
    expect(timelinePositionFor(item(0, 5), 30)).toBe(15);
  });

  it("builds a validated seed and caps it at 100 tracks", () => {
    const queue = Array.from({ length: 120 }, (_, index) => track(String(index)));
    const result = createPlaybackSessionInput({
      source: { kind: "search", query: "" },
      queue,
      currentIndex: 80,
      currentTime: 4,
      cursor: "next",
      page: 4,
      hasMore: true,
    });
    expect(result?.initial_external_ids).toHaveLength(60);
    expect(result).toMatchObject({
      current_external_id: "80",
      current_index: 20,
      position_seconds: 4,
      cursor: "next",
      page: 4,
      has_more: true,
    });
  });

  it("does not reuse an end cursor when a long local tail was omitted", () => {
    const queue = Array.from({ length: 10_000 }, (_, index) => track(String(index)));
    const result = createPlaybackSessionInput({
      source: { kind: "search", query: "" },
      queue,
      currentIndex: 5_000,
      currentTime: 0,
      cursor: "cursor-after-10000",
      page: 500,
      hasMore: true,
    });
    expect(result?.initial_external_ids).toHaveLength(100);
    expect(result?.current_index).toBe(20);
    expect(result?.cursor).toBeNull();
    expect(result?.has_more).toBe(true);
    expect(result?.page).toBe(254);
  });

  it("continues an oversized search from the last included local page", () => {
    const queue = Array.from({ length: 200 }, (_, index) => track(String(index)));
    const result = createPlaybackSessionInput({
      source: { kind: "search", query: "metal" },
      queue,
      currentIndex: 60,
      currentTime: 0,
      cursor: "cursor-after-200",
      page: 10,
      hasMore: true,
    });
    expect(result?.initial_external_ids.at(0)).toBe("40");
    expect(result?.initial_external_ids.at(-1)).toBe("139");
    expect(result).toMatchObject({ cursor: null, page: 7, has_more: true });
  });

  it("uses progressive playback for an oversized opaque shuffle seed", () => {
    const queue = Array.from({ length: 200 }, (_, index) => track(String(index)));
    expect(
      createPlaybackSessionInput({
        source: { kind: "shuffle" },
        queue,
        currentIndex: 60,
        currentTime: 0,
        cursor: "opaque-shuffle-cursor",
        page: 1,
        hasMore: true,
      }),
    ).toBeNull();
  });
});
