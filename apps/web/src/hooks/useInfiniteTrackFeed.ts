import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import type { LikesResponse, SearchResponse, Track } from "../types";

type FeedOptions =
  | { kind: "search"; query: string; enabled?: boolean; token?: string | null }
  | { kind: "likes"; query?: never; enabled: boolean; token?: string | null };

function appendUnique(previous: Track[], incoming: Track[]) {
  const ids = new Set(previous.map((track) => track.external_id));
  return [
    ...previous,
    ...incoming.filter((track) => {
      if (ids.has(track.external_id)) return false;
      ids.add(track.external_id);
      return true;
    }),
  ];
}

function isAbortError(reason: unknown) {
  return reason instanceof DOMException && reason.name === "AbortError";
}

export function useInfiniteTrackFeed(options: FeedOptions) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [refreshKey, setRefreshKey] = useState(0);
  const cursorRef = useRef<string | null>(null);
  const pageRef = useRef(1);
  const loadingRef = useRef(false);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const kind = options.kind;
  const query = options.kind === "search" ? options.query : "";
  const token = options.token;
  const enabled = options.enabled ?? true;

  const fetchPage = useCallback(
    (
      page: number,
      cursor: string | null,
      signal: AbortSignal,
    ): Promise<SearchResponse | LikesResponse> =>
      kind === "search"
        ? api.searchWithCursor(query.trim(), page, cursor, signal)
        : api.getLikesWithCursor(token, page, cursor, signal),
    [kind, query, token],
  );

  const requestPage = useCallback(
    async (
      page: number,
      cursor: string | null,
      append: boolean,
      generation: number,
    ) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      loadingRef.current = true;
      setLoading(true);
      setError(null);

      try {
        const response = await fetchPage(page, cursor, controller.signal);
        if (generation !== generationRef.current) return;

        const results = response.results ?? [];
        setTracks((current) =>
          append ? appendUnique(current, results) : results,
        );
        setTotalCount(response.total_count ?? results.length);
        cursorRef.current = response.next_cursor ?? null;
        pageRef.current = page;
        setNextCursor(response.next_cursor ?? null);
        setPage(page);
        setHasMore(Boolean(response.next_cursor) || Boolean(response.has_next));
      } catch (reason) {
        if (generation === generationRef.current && !isAbortError(reason)) {
          setError(
            reason instanceof Error ? reason.message : "Could not load music",
          );
        }
      } finally {
        if (generation === generationRef.current) {
          setLoading(false);
          loadingRef.current = false;
        }
      }
    },
    [fetchPage],
  );

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    controllerRef.current?.abort();
    cursorRef.current = null;
    pageRef.current = 1;
    loadingRef.current = false;
    setTracks([]);
    setTotalCount(0);
    setHasMore(true);
    setNextCursor(null);
    setPage(1);
    setLoading(false);
    setError(null);

    if (enabled) void requestPage(1, null, false, generation);
    return () => controllerRef.current?.abort();
  }, [enabled, kind, query, refreshKey, requestPage, token]);

  const loadMore = useCallback(() => {
    if (
      !enabled ||
      loadingRef.current ||
      !hasMore ||
      !cursorRef.current
    ) {
      return;
    }
    void requestPage(
      pageRef.current + 1,
      cursorRef.current,
      true,
      generationRef.current,
    );
  }, [enabled, hasMore, requestPage]);

  const reset = useCallback(() => {
    generationRef.current += 1;
    controllerRef.current?.abort();
    loadingRef.current = false;
    setRefreshKey((current) => current + 1);
  }, []);

  return {
    tracks,
    totalCount,
    loading,
    error,
    hasMore,
    nextCursor,
    page,
    loadMore,
    reset,
    retry: reset,
  };
}

export function useInfiniteSentinel(
  onVisible: () => void,
  enabled: boolean,
) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || !enabled) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onVisible();
      },
      { rootMargin: "500px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, onVisible]);
  return ref;
}
