import { Link } from "react-router-dom";

import { HeartIcon, SpinnerIcon } from "../components/Icons";
import { TrackCard } from "../components/TrackCard";
import {
  useInfiniteSentinel,
  useInfiniteTrackFeed,
} from "../hooks/useInfiniteTrackFeed";
import { usePlayerStore } from "../store/player-store";

export function LikedSongsView() {
  const user = usePlayerStore((state) => state.user);
  const token = usePlayerStore((state) => state.token);
  const feed = useInfiniteTrackFeed({
    kind: "likes",
    enabled: Boolean(user),
    token,
  });
  const sentinelRef = useInfiniteSentinel(
    () => void feed.loadMore(),
    feed.hasMore && !feed.loading && !feed.error,
  );

  return (
    <section className="view-stack" aria-labelledby="liked-heading">
      <div className="view-heading">
        <div>
          <p className="eyebrow">Your collection</p>
          <h1 id="liked-heading">Liked songs</h1>
        </div>
        <span className="count-pill">{feed.totalCount}</span>
      </div>

      {!user ? (
        <div className="empty-state">
          <HeartIcon className="h-8 w-8" />
          <p>Sign in to keep your favorites together.</p>
          <Link className="primary-button" to="/profile">
            Go to profile
          </Link>
        </div>
      ) : (
        <>
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
                  source: { kind: "likes" },
                  cursor: feed.nextCursor,
                  page: feed.page,
                  hasMore: feed.hasMore,
                }}
                onLikeToggled={feed.reset}
              />
            ))}
          </div>
          {!feed.loading && !feed.error && feed.tracks.length === 0 && (
            <div className="empty-state">
              <HeartIcon className="h-8 w-8" />
              <p>Tap the heart on a song to find it here.</p>
            </div>
          )}
          <div ref={sentinelRef} className="feed-sentinel" aria-hidden="true" />
          {feed.loading && (
            <div className="feed-loading" role="status">
              <SpinnerIcon className="h-5 w-5 animate-spin" />
              Loading favorites
            </div>
          )}
          {!feed.loading && feed.hasMore && feed.tracks.length > 0 && (
            <p className="feed-progress">
              Loaded {feed.tracks.length} of {feed.totalCount} · Scroll for more
            </p>
          )}
        </>
      )}
    </section>
  );
}
