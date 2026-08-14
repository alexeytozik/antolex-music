import { useState } from "react";

import { SearchIcon, SpinnerIcon } from "../components/Icons";
import { TrackCard } from "../components/TrackCard";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import {
  useInfiniteSentinel,
  useInfiniteTrackFeed,
} from "../hooks/useInfiniteTrackFeed";

export function SearchView() {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const feed = useInfiniteTrackFeed({
    kind: "search",
    query: debouncedQuery,
  });
  const sentinelRef = useInfiniteSentinel(
    () => void feed.loadMore(),
    feed.hasMore && !feed.loading && !feed.error,
  );

  return (
    <section className="view-stack" aria-label="Music library">
      <div className="catalog-tools">
        <label className="search-field">
          <SearchIcon className="h-6 w-6" />
          <span className="sr-only">Search music</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Songs, artists or albums"
            autoComplete="off"
          />
        </label>
      </div>

      {feed.error && (
        <div className="feed-error">
          <p className="notice notice-error">{feed.error}</p>
          <button className="secondary-button compact" type="button" onClick={feed.retry}>
            Retry
          </button>
        </div>
      )}

      <div className="track-list">
        {feed.tracks.map((track, index) => (
          <TrackCard
            key={track.external_id}
            track={track}
            queue={feed.tracks}
            queueIndex={index}
            queueContinuation={{
              source: { kind: "search", query: debouncedQuery.trim() },
              cursor: feed.nextCursor,
              page: feed.page,
              hasMore: feed.hasMore,
            }}
          />
        ))}
      </div>

      {!feed.loading && !feed.error && feed.tracks.length === 0 && (
        <div className="empty-state">
          <SearchIcon className="h-8 w-8" />
          <p>{query.trim() ? "No matches yet" : "Your library is empty"}</p>
        </div>
      )}

      <div ref={sentinelRef} className="feed-sentinel" aria-hidden="true" />
      {feed.loading && (
        <div className="feed-loading" role="status">
          <SpinnerIcon className="h-5 w-5 animate-spin" />
          Loading music
        </div>
      )}
      {!feed.loading && feed.hasMore && feed.tracks.length > 0 && (
        <p className="feed-progress">
          Loaded {feed.tracks.length} of {feed.totalCount} · Scroll for more
        </p>
      )}
      {!feed.hasMore && feed.tracks.length > 0 && (
        <p className="feed-end">That’s the whole library.</p>
      )}
    </section>
  );
}
