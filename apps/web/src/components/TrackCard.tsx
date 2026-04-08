import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { HeartIcon, PlayIcon, SpinnerIcon } from "./Icons";
import { formatDuration } from "../lib/format";
import { usePlayerStore } from "../store/player-store";
import type { Track } from "../types";

type TrackCardProps = {
  track: Track;
  queue?: Track[];
  queueIndex?: number;
  onLikeToggled?: () => void | Promise<void>;
};

export function TrackCard({
  track,
  queue,
  queueIndex,
  onLikeToggled,
}: TrackCardProps) {
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const playNow = usePlayerStore((state) => state.playNow);
  const replaceQueue = usePlayerStore((state) => state.replaceQueue);
  const toggleLike = usePlayerStore((state) => state.toggleLike);
  const isLiked = usePlayerStore((state) => state.isLiked);
  const user = usePlayerStore((state) => state.user);

  const liked = isLiked(track.external_id);

  async function handlePlay() {
    setBusy(true);
    try {
      if (queue && typeof queueIndex === "number") {
        replaceQueue(queue, queueIndex, true);
        return;
      }

      playNow(track);
    } finally {
      setBusy(false);
    }
  }

  async function handleLike() {
    if (!user) {
      navigate("/profile");
      return;
    }

    setBusy(true);
    try {
      await toggleLike(track);
      await onLikeToggled?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="group flex items-center gap-4 rounded-3xl border border-white/8 bg-white/5 p-4 transition hover:border-white/15 hover:bg-white/[0.08]">
      <img
        src={track.cover_url}
        alt={track.title}
        className="h-16 w-16 rounded-2xl object-cover"
        onError={(event) => {
          event.currentTarget.onerror = null;
          event.currentTarget.src = "/cover-fallback.svg";
        }}
      />

      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold text-zinc-50">
          {track.title}
        </h3>
        <p className="truncate text-sm text-zinc-400">{track.artist}</p>
      </div>

      <span className="hidden text-sm text-zinc-500 md:block">
        {formatDuration(track.duration_seconds)}
      </span>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleLike}
          disabled={busy}
          aria-label={liked ? "Remove from liked songs" : "Add to liked songs"}
          title={liked ? "Remove from liked songs" : "Add to liked songs"}
          className={`flex h-12 w-12 items-center justify-center rounded-full transition ${
            liked
              ? "bg-emerald-400 text-zinc-950"
              : "bg-white/6 text-zinc-200 hover:bg-white/12"
          } disabled:cursor-not-allowed disabled:bg-zinc-900 disabled:text-zinc-500`}
        >
          <HeartIcon className={`h-6 w-6 ${liked ? "fill-current" : ""}`} />
        </button>
        <button
          type="button"
          onClick={handlePlay}
          disabled={busy}
          aria-label="Play track"
          title="Play track"
          className="flex h-12 w-12 items-center justify-center rounded-full border border-white/12 text-zinc-50 transition hover:border-emerald-300 hover:text-emerald-300 disabled:cursor-not-allowed disabled:border-white/5 disabled:text-zinc-600"
        >
          {busy ? (
            <SpinnerIcon className="h-6 w-6 animate-spin" />
          ) : (
            <PlayIcon className="h-6 w-6" />
          )}
        </button>
      </div>
    </article>
  );
}
