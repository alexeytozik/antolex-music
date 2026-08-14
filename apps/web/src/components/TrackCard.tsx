import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { HeartIcon, PlayIcon, SpinnerIcon } from "./Icons";
import { formatDuration } from "../lib/format";
import {
  startQueueContinuation,
  stopQueueContinuation,
  type QueueContinuationSource,
} from "../store/queue-continuation-store";
import { usePlayerStore } from "../store/player-store";
import type { Track } from "../types";

type TrackQueueContinuation = {
  source: QueueContinuationSource;
  cursor: string | null;
  page: number;
  hasMore: boolean;
};

type TrackCardProps = {
  track: Track;
  queue?: Track[];
  queueIndex?: number;
  queueContinuation?: TrackQueueContinuation;
  onLikeToggled?: () => void | Promise<void>;
};

export function TrackCard({
  track,
  queue,
  queueIndex,
  queueContinuation,
  onLikeToggled,
}: TrackCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const playNow = usePlayerStore((state) => state.playNow);
  const replaceQueue = usePlayerStore((state) => state.replaceQueue);
  const toggleLike = usePlayerStore((state) => state.toggleLike);
  const isLiked = usePlayerStore((state) => state.isLiked);
  const user = usePlayerStore((state) => state.user);
  const liked = isLiked(track.external_id);

  function handlePlay() {
    if (queue && typeof queueIndex === "number") {
      replaceQueue(queue, queueIndex, true);
      if (usePlayerStore.getState().shuffleEnabled) {
        stopQueueContinuation();
        return;
      }
      const queueContextId = usePlayerStore.getState().queueContextId;
      if (queueContinuation && queueContextId) {
        startQueueContinuation({
          ...queueContinuation,
          queueContextId,
        });
      } else {
        stopQueueContinuation();
      }
    } else {
      stopQueueContinuation();
      playNow(track);
    }
  }

  async function handleLike() {
    if (!user) {
      navigate("/profile");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await toggleLike(track);
      await onLikeToggled?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update like");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="track-card">
      <button
        type="button"
        className="track-cover-button"
        onClick={handlePlay}
        aria-label={`Play ${track.title}`}
      >
        <img
          src={track.cover_url || "/cover-fallback.svg"}
          alt=""
          onError={(event) => {
            event.currentTarget.onerror = null;
            event.currentTarget.src = "/cover-fallback.svg";
          }}
        />
        <span className="cover-play"><PlayIcon className="h-5 w-5" /></span>
      </button>

      <button type="button" className="track-copy" onClick={handlePlay}>
        <strong>{track.title}</strong>
        <span>{track.artist}{track.album ? ` · ${track.album}` : ""}</span>
      </button>

      <span className="track-duration">{formatDuration(track.duration_seconds)}</span>

      <button
        type="button"
        onClick={() => void handleLike()}
        disabled={busy}
      aria-label={liked ? "Remove from liked songs" : "Add to liked songs"}
      className={`icon-button track-like ${liked ? "is-active" : ""}`}
    >
        {busy ? (
          <SpinnerIcon className="h-5 w-5 animate-spin" />
        ) : (
          <HeartIcon className={`h-5 w-5 ${liked ? "fill-current" : ""}`} />
        )}
      </button>

      <button
        type="button"
        className="icon-button desktop-track-play"
        onClick={handlePlay}
        aria-label={`Play ${track.title}`}
      >
        <PlayIcon className="h-5 w-5" />
      </button>

      {error && <p className="track-error">{error}</p>}
    </article>
  );
}
