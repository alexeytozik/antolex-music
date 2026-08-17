import type {
  CreatePlaybackSessionInput,
  PlaybackSessionItem,
  PlaybackSessionSource,
  Track,
} from "../types";
import type { QueueContinuationSource } from "../store/queue-continuation-store";

export type PlaybackBoundary = {
  item: PlaybackSessionItem;
  index: number;
  timelineSeconds: number;
  localSeconds: number;
  durationSeconds: number;
};

export function sortedPlaybackItems(items: PlaybackSessionItem[]) {
  return [...items].sort((left, right) => left.ordinal - right.ordinal);
}

export function findPlaybackBoundary(
  input: PlaybackSessionItem[],
  timelineSeconds: number,
): PlaybackBoundary | null {
  const items = sortedPlaybackItems(input);
  if (items.length === 0) return null;
  const time = Math.max(0, timelineSeconds);
  let low = 0;
  let high = items.length - 1;
  let match = 0;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const start = items[middle].timeline_start_ms / 1000;
    if (start <= time) {
      match = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const item = items[match];
  const timelineStart = item.timeline_start_ms / 1000;
  const durationSeconds = Math.max(0, item.duration_ms / 1000);
  return {
    item,
    index: match,
    timelineSeconds: time,
    localSeconds: Math.min(Math.max(0, time - timelineStart), durationSeconds),
    durationSeconds,
  };
}

export function timelinePositionFor(
  item: PlaybackSessionItem,
  localSeconds: number,
) {
  return (
    item.timeline_start_ms / 1000 +
    Math.min(Math.max(0, localSeconds), Math.max(0, item.duration_ms / 1000))
  );
}

export function sourceForPlaybackSession(
  shuffleEnabled: boolean,
  continuation: QueueContinuationSource | null,
  shuffleExcludedExternalID: string | null,
): PlaybackSessionSource {
  if (shuffleEnabled) {
    return {
      kind: "shuffle",
      ...(shuffleExcludedExternalID
        ? { exclude_external_id: shuffleExcludedExternalID }
        : {}),
    };
  }
  if (continuation?.kind === "likes") return { kind: "likes" };
  if (continuation?.kind === "search") {
    return { kind: "search", query: continuation.query };
  }
  return { kind: "search", query: "" };
}

export function createPlaybackSessionInput(input: {
  source: PlaybackSessionSource;
  queue: Track[];
  currentIndex: number;
  currentTime: number;
  cursor: string | null;
  page: number;
  hasMore: boolean;
}): CreatePlaybackSessionInput | null {
  if (input.currentIndex < 0 || input.currentIndex >= input.queue.length) {
    return null;
  }
  const current = input.queue[input.currentIndex];
  const historyCount = Math.min(20, input.currentIndex);
  const windowStart = input.currentIndex - historyCount;
  const windowEnd = Math.min(input.queue.length, windowStart + 100);
  const rawQueue = input.queue.slice(windowStart, windowEnd);
  const seen = new Set<string>();
  const queue = rawQueue.filter((track, index) => {
    const absoluteIndex = windowStart + index;
    if (
      track.external_id === current.external_id &&
      absoluteIndex !== input.currentIndex
    ) {
      return false;
    }
    if (seen.has(track.external_id)) return false;
    seen.add(track.external_id);
    return true;
  });
  const currentIndex = queue.findIndex(
    (track) => track.external_id === current.external_id,
  );
  const omittedLocalTail = windowEnd < input.queue.length;
  if (omittedLocalTail && input.source.kind === "shuffle") {
    return null;
  }
  const cursor = omittedLocalTail ? null : input.cursor;
  const page = omittedLocalTail
    ? Math.max(1, Math.floor(windowEnd / 20))
    : Math.max(1, input.page);

  return {
    source: input.source,
    initial_external_ids: queue.map((track) => track.external_id),
    current_external_id: current.external_id,
    current_index: currentIndex,
    position_seconds: Math.max(0, input.currentTime),
    cursor,
    page,
    // `cursor` points after the complete local queue. It must not be used when
    // the 100-item seed omitted part of that queue; the server then rebuilds
    // continuation from the source/current track instead.
    has_more: omittedLocalTail || (input.hasMore && Boolean(cursor)),
  };
}
