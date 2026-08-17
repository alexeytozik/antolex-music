import { useEffect, useRef, useState } from "react";

import { APIError, api } from "../lib/api";
import {
  stopQueueContinuation,
  useQueueContinuationStore,
  type QueueContinuationSource,
} from "../store/queue-continuation-store";
import { usePlayerStore } from "../store/player-store";
import type { Track } from "../types";

export const QUEUE_PREFETCH_DISTANCE = 5;
export const QUEUE_RETRY_MAX_DELAY_MS = 30_000;

type ContinuationResponse = {
  results: Track[];
  next_cursor?: string;
  has_next: boolean;
};

export function shouldPrefetchQueue(
  queueLength: number,
  currentIndex: number,
  hasMore: boolean,
) {
  return (
    hasMore &&
    queueLength > 0 &&
    currentIndex >= 0 &&
    queueLength - currentIndex <= QUEUE_PREFETCH_DISTANCE
  );
}

export function queueContinuationRetryDelay(attempt: number) {
  return Math.min(
    1_000 * 2 ** Math.min(Math.max(0, attempt - 1), 5),
    QUEUE_RETRY_MAX_DELAY_MS,
  );
}

export function shouldRetryQueueContinuation(reason: unknown) {
  if (reason instanceof DOMException && reason.name === "AbortError") {
    return false;
  }
  if (!(reason instanceof APIError)) return true;
  return reason.status === 408 || reason.status === 429 || reason.status >= 500;
}

export function uniqueContinuationTracks(
  existingExternalIds: Iterable<string>,
  incoming: Track[],
) {
  const seen = new Set(existingExternalIds);
  return incoming.filter((track) => {
    if (seen.has(track.external_id)) return false;
    seen.add(track.external_id);
    return true;
  });
}

export function fetchQueueContinuationPage(
  source: QueueContinuationSource,
  page: number,
  cursor: string,
  signal: AbortSignal,
): Promise<ContinuationResponse> {
  switch (source.kind) {
    case "search":
      return api.searchWithCursor(source.query, page, cursor, signal);
    case "likes":
      return api.getLikesWithCursor(null, page, cursor, signal);
    case "shuffle":
      return api.shuffleWithCursor(
        page,
        cursor,
        source.excludeExternalId,
        signal,
      );
  }
}

export function QueueContinuation() {
  const [retryNonce, setRetryNonce] = useState(0);
  const source = useQueueContinuationStore((state) => state.source);
  const cursor = useQueueContinuationStore((state) => state.cursor);
  const page = useQueueContinuationStore((state) => state.page);
  const hasMore = useQueueContinuationStore((state) => state.hasMore);
  const queueContextId = useQueueContinuationStore(
    (state) => state.queueContextId,
  );
  const generation = useQueueContinuationStore((state) => state.generation);
  const queueLength = usePlayerStore((state) => state.queue.length);
  const playerQueueContextId = usePlayerStore((state) => state.queueContextId);
  const currentIndex = usePlayerStore((state) => state.currentIndex);
  const shuffleEnabled = usePlayerStore((state) => state.shuffleEnabled);
  const playbackSessionId = usePlayerStore(
    (state) => state.playbackSessionId,
  );
  const playbackSessionQueueContextId = usePlayerStore(
    (state) => state.playbackSessionQueueContextId,
  );
  const requestInFlightRef = useRef(false);
  const requestSequenceRef = useRef(0);
  const retryAttemptRef = useRef(0);

  useEffect(() => {
    retryAttemptRef.current = 0;
  }, [generation]);

  useEffect(() => {
    if (!source || !queueContextId) return;

    if (
      playbackSessionId &&
      playbackSessionQueueContextId === playerQueueContextId
    ) {
      return;
    }

    if (shuffleEnabled && source.kind !== "shuffle") {
      stopQueueContinuation();
      return;
    }

    if (playerQueueContextId !== queueContextId) {
      stopQueueContinuation();
      return;
    }

    if (
      !cursor ||
      requestInFlightRef.current ||
      !shouldPrefetchQueue(queueLength, currentIndex, hasMore)
    ) {
      return;
    }

    const controller = new AbortController();
    const expectedGeneration = generation;
    const expectedQueueContextId = queueContextId;
    const nextPage = page + 1;
    const requestSequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestSequence;
    requestInFlightRef.current = true;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let onlineRetry: (() => void) | null = null;

    void fetchQueueContinuationPage(
      source,
      nextPage,
      cursor,
      controller.signal,
    )
      .then((response) => {
        if (controller.signal.aborted) return;

        const continuation = useQueueContinuationStore.getState();
        const player = usePlayerStore.getState();
        if (
          continuation.generation !== expectedGeneration ||
          continuation.queueContextId !== expectedQueueContextId ||
          player.queueContextId !== expectedQueueContextId
        ) {
          return;
        }

        const tracks = uniqueContinuationTracks(
          player.queue.map((item) => item.track.external_id),
          response.results ?? [],
        );
        if (tracks.length > 0) player.appendToQueue(tracks);
        retryAttemptRef.current = 0;

        const nextCursor = response.next_cursor ?? null;
        const continues =
          Boolean(nextCursor) && response.has_next !== false;
        const advanced = continuation.advance(
          expectedGeneration,
          expectedQueueContextId,
          nextCursor,
          nextPage,
          continues,
        );
        if (advanced && tracks.length === 0 && !continues) {
          player.cancelPendingAdvance(expectedQueueContextId);
        }
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        useQueueContinuationStore.getState().fail(
          expectedGeneration,
          expectedQueueContextId,
          reason instanceof Error
            ? reason.message
            : "Could not continue the queue",
        );

        if (!shouldRetryQueueContinuation(reason)) {
          stopQueueContinuation();
          usePlayerStore
            .getState()
            .cancelPendingAdvance(
              expectedQueueContextId,
              reason instanceof Error
                ? reason.message
                : "Could not continue the queue",
            );
          return;
        }
        const retryAttempt = retryAttemptRef.current + 1;
        retryAttemptRef.current = retryAttempt;
        const retry = () => {
          const continuation = useQueueContinuationStore.getState();
          if (
            continuation.generation === expectedGeneration &&
            continuation.queueContextId === expectedQueueContextId
          ) {
            setRetryNonce((value) => value + 1);
          }
        };
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          onlineRetry = retry;
          window.addEventListener("online", onlineRetry, { once: true });
        } else {
          retryTimeout = setTimeout(
            retry,
            queueContinuationRetryDelay(retryAttempt),
          );
        }
      })
      .finally(() => {
        if (requestSequenceRef.current === requestSequence) {
          requestInFlightRef.current = false;
        }
      });

    return () => {
      controller.abort();
      if (requestSequenceRef.current === requestSequence) {
        requestInFlightRef.current = false;
      }
      if (retryTimeout) clearTimeout(retryTimeout);
      if (onlineRetry) window.removeEventListener("online", onlineRetry);
    };
  }, [
    queueContextId,
    currentIndex,
    cursor,
    generation,
    hasMore,
    page,
    playerQueueContextId,
    queueLength,
    retryNonce,
    source,
    shuffleEnabled,
    playbackSessionId,
    playbackSessionQueueContextId,
  ]);

  return null;
}
