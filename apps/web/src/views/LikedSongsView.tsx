import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { HeartIcon, SearchIcon, UserIcon } from "../components/Icons";
import { PaginationControls } from "../components/PaginationControls";
import { TrackCard } from "../components/TrackCard";
import { api } from "../lib/api";
import { usePlayerStore } from "../store/player-store";
import type { LikesResponse } from "../types";

function PlaceholderRows() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-4 rounded-3xl border border-white/8 bg-white/[0.03] px-4 py-3"
        >
          <div className="h-12 w-12 shrink-0 rounded-2xl bg-white/[0.06]" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3 w-32 rounded-full bg-white/[0.06]" />
            <div className="h-3 w-20 rounded-full bg-white/[0.04]" />
          </div>
          <div className="h-10 w-10 shrink-0 rounded-full border border-white/[0.06]" />
        </div>
      ))}
    </div>
  );
}

export function LikedSongsView() {
  const user = usePlayerStore((state) => state.user);
  const token = usePlayerStore((state) => state.token);
  const loadLikes = usePlayerStore((state) => state.loadLikes);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageCursors, setPageCursors] = useState<Record<number, string | null>>(
    {
      1: null,
    },
  );
  const [response, setResponse] = useState<LikesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const pageCursor = pageCursors[page] ?? null;

  useEffect(() => {
    setPageCursors({ 1: null });
  }, [token, user]);

  useEffect(() => {
    if (!user || !token) {
      return;
    }

    let cancelled = false;

    async function loadLikedIDs() {
      try {
        await loadLikes();
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load liked songs",
          );
        }
      }
    }

    void loadLikedIDs();
    return () => {
      cancelled = true;
    };
  }, [loadLikes, refreshNonce, token, user]);

  useEffect(() => {
    const authToken = token;
    if (!user || !authToken) {
      setResponse(null);
      setError(null);
      return;
    }

    let cancelled = false;

    async function loadPage() {
      const tokenToUse = authToken;
      if (!tokenToUse) {
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const result = await api.getLikesWithCursor(
          tokenToUse,
          page,
          pageCursor,
        );
        if (cancelled) {
          return;
        }
        if (result.total_pages > 0 && page > result.total_pages) {
          setPage(result.total_pages);
          return;
        }
        if (result.total_pages === 0 && page !== 1) {
          setPage(1);
          return;
        }
        setPageCursors((current) => {
          const next = { ...current, [page]: pageCursor };
          if (result.next_cursor) {
            next[page + 1] = result.next_cursor;
          }
          return next;
        });
        setResponse(result);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load liked songs",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadPage();
    return () => {
      cancelled = true;
    };
  }, [page, pageCursor, refreshNonce, token, user]);

  const likedSongs = response?.results ?? [];
  const totalCount = response?.total_count ?? 0;
  const totalPages = response?.total_pages ?? 0;

  if (!user) {
    return (
      <div className="w-full space-y-5">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/5 text-emerald-300">
            <HeartIcon className="h-7 w-7" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-zinc-50">Liked Songs</h2>
            <p className="text-xs text-zinc-500">0 tracks</p>
          </div>
        </div>

        <div className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-5">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-zinc-400">Sign in to save tracks.</p>
            <Link
              to="/profile"
              className="inline-flex items-center gap-2 rounded-full border border-white/12 px-4 py-2 text-sm text-zinc-50 transition hover:border-emerald-300 hover:text-emerald-300"
            >
              <UserIcon className="h-6 w-6" />
              <span>Profile</span>
            </Link>
          </div>
        </div>

        <PlaceholderRows />
      </div>
    );
  }

  return (
    <div className="w-full space-y-5">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/5 text-emerald-300">
          <HeartIcon className="h-7 w-7" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-zinc-50">Liked Songs</h2>
          <p className="text-xs text-zinc-500">
            {totalCount} {totalCount === 1 ? "track" : "tracks"}
          </p>
        </div>
      </div>

      {error && <p className="text-sm text-rose-300">{error}</p>}
      {loading && (
        <p className="text-sm text-zinc-400">Loading liked songs...</p>
      )}

      {likedSongs.length === 0 ? (
        <div className="space-y-4">
          <div className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-5">
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-zinc-400">No saved tracks yet.</p>
              <Link
                to="/"
                className="inline-flex items-center gap-2 rounded-full border border-white/12 px-4 py-2 text-sm text-zinc-50 transition hover:border-emerald-300 hover:text-emerald-300"
              >
                <SearchIcon className="h-6 w-6" />
                <span>Search</span>
              </Link>
            </div>
          </div>

          <PlaceholderRows />
        </div>
      ) : (
        <div className="space-y-3">
          {response && (
            <p className="px-1 text-xs text-zinc-500">
              {`Page ${response.page} of ${Math.max(response.total_pages, 1)} · ${totalCount} track${
                totalCount === 1 ? "" : "s"
              }`}
            </p>
          )}
          {likedSongs.map((track, index) => (
            <TrackCard
              key={track.external_id}
              track={track}
              queue={likedSongs}
              queueIndex={index}
              onLikeToggled={() => {
                setRefreshNonce((value) => value + 1);
              }}
            />
          ))}
          <PaginationControls
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
          />
        </div>
      )}
    </div>
  );
}
