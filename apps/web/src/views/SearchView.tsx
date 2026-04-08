import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { PaginationControls } from "../components/PaginationControls";
import { SearchIcon, SpinnerIcon, UploadIcon } from "../components/Icons";
import { TrackCard } from "../components/TrackCard";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { api } from "../lib/api";
import { usePlayerStore } from "../store/player-store";
import type { SearchResponse, Track } from "../types";

function dedupeTracks(tracks: Track[]) {
  const seen = new Set<string>();
  return tracks.filter((track) => {
    if (seen.has(track.external_id)) {
      return false;
    }
    seen.add(track.external_id);
    return true;
  });
}

export function SearchView() {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageCursors, setPageCursors] = useState<Record<number, string | null>>(
    {
      1: null,
    },
  );
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [libraryMessage, setLibraryMessage] = useState<string | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [recentUploads, setRecentUploads] = useState<Track[]>([]);

  const token = usePlayerStore((state) => state.token);
  const user = usePlayerStore((state) => state.user);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const debouncedQuery = useDebouncedValue(query, 350);
  const pageCursor = pageCursors[page] ?? null;
  const results = response?.results ?? [];
  const totalCount = response?.total_count ?? 0;
  const totalPages = response?.total_pages ?? 0;
  const showSearchingState = loading && response === null && !error;

  useEffect(() => {
    setPageCursors({ 1: null });
  }, [debouncedQuery]);

  useEffect(() => {
    let cancelled = false;

    async function runSearch() {
      setLoading(true);
      setError(null);
      try {
        const result = await api.searchWithCursor(
          debouncedQuery.trim(),
          page,
          pageCursor,
        );
        if (!cancelled) {
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
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Search failed");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void runSearch();
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, page, pageCursor, refreshNonce]);

  function queueRecentUploads(nextTracks: Track[]) {
    setRecentUploads((previous) =>
      dedupeTracks([...nextTracks, ...previous]).slice(0, 4),
    );
  }

  async function refreshSearch() {
    setRefreshNonce((value) => value + 1);
  }

  async function handleFiles(input: FileList | File[]) {
    if (!token) {
      setLibraryError("Sign in to upload music.");
      return;
    }

    const files = Array.from(input);
    if (files.length === 0) {
      return;
    }

    setUploading(true);
    setLibraryError(null);
    setLibraryMessage(null);

    const uploadedTracks: Track[] = [];
    for (const file of files) {
      try {
        const response = await api.uploadTrack(token, file);
        uploadedTracks.push(response.track);
      } catch (err) {
        setLibraryError(
          err instanceof Error ? err.message : `Failed to upload ${file.name}`,
        );
      }
    }

    if (uploadedTracks.length > 0) {
      queueRecentUploads(uploadedTracks);
      setPage(1);
      setPageCursors({ 1: null });
      setLibraryMessage(
        uploadedTracks.length === 1
          ? "Track uploaded."
          : `${uploadedTracks.length} tracks uploaded.`,
      );
      await refreshSearch();
    }

    setUploading(false);
  }

  useEffect(() => {
    if (!token) {
      return;
    }

    const isLiveCatalogView = debouncedQuery.trim() === "" && page === 1;
    if (!isLiveCatalogView) {
      return;
    }

    let cancelled = false;

    const run = async () => {
      if (cancelled || document.visibilityState !== "visible") {
        return;
      }
      await refreshSearch();
    };

    void run();

    const interval = window.setInterval(() => {
      void run();
    }, 15000);

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void run();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onVisibilityChange);
    };
  }, [debouncedQuery, page, token]);

  return (
    <div className="w-full space-y-6">
      <div className="space-y-3 rounded-[2rem] border border-white/10 bg-black/25 p-4 shadow-2xl shadow-black/20">
        <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-zinc-950/70 px-4 py-3">
          <SearchIcon className="h-7 w-7 text-zinc-500" />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
              setPageCursors({ 1: null });
            }}
            placeholder="Search for songs or artists..."
            className="w-full bg-transparent text-base text-zinc-50 outline-none placeholder:text-zinc-500"
          />
        </div>

        <div
          onDrop={(event) => {
            event.preventDefault();
            void handleFiles(event.dataTransfer.files);
          }}
          onDragOver={(event) => event.preventDefault()}
          className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] px-4 py-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-0.5">
              <p className="text-sm text-zinc-200">
                {user ? "Add music" : "Sign in to add music"}
              </p>
              {user && (
                <p className="text-xs text-zinc-500">Drop files or upload.</p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {user ? (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".mp3,.wav,.flac,.ogg,.m4a,.aac,audio/*"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      if (event.target.files) {
                        void handleFiles(event.target.files);
                        event.target.value = "";
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    className="inline-flex h-11 items-center gap-2 rounded-full border border-white/12 px-4 text-sm text-zinc-50 transition hover:border-emerald-300 hover:text-emerald-300 disabled:cursor-not-allowed disabled:border-white/5 disabled:text-zinc-600"
                  >
                    {uploading ? (
                      <SpinnerIcon className="h-5 w-5 animate-spin" />
                    ) : (
                      <UploadIcon className="h-5 w-5" />
                    )}
                    <span>{uploading ? "Uploading" : "Upload"}</span>
                  </button>
                </>
              ) : (
                <Link
                  to="/profile"
                  className="inline-flex h-11 items-center gap-2 rounded-full border border-white/12 px-4 text-sm text-zinc-50 transition hover:border-emerald-300 hover:text-emerald-300"
                >
                  <UploadIcon className="h-5 w-5" />
                  <span>Profile</span>
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>

      {(libraryMessage || libraryError) && (
        <div className="space-y-2">
          {libraryMessage && (
            <p className="text-sm text-emerald-300">{libraryMessage}</p>
          )}
          {libraryError && (
            <p className="text-sm text-rose-300">{libraryError}</p>
          )}
        </div>
      )}

      {recentUploads.length > 0 && (
        <div className="space-y-3">
          <p className="px-1 text-xs text-zinc-500">Just added</p>
          {recentUploads.map((track, index) => (
            <TrackCard
              key={track.external_id}
              track={track}
              queue={recentUploads}
              queueIndex={index}
            />
          ))}
        </div>
      )}

      <div className="space-y-3">
        {!loading && !error && totalCount > 0 && response && (
          <p className="px-1 text-xs text-zinc-500">
            {`Page ${response.page} of ${Math.max(response.total_pages, 1)} · ${totalCount} track${
              totalCount === 1 ? "" : "s"
            }`}
          </p>
        )}
        {showSearchingState && (
          <p className="text-sm text-zinc-400">Searching...</p>
        )}
        {error && <p className="text-sm text-rose-300">{error}</p>}
        {!showSearchingState && !error && results.length === 0 && (
          <div className="flex items-center justify-center rounded-[2rem] border border-white/10 bg-white/5 p-10 text-zinc-500">
            <SearchIcon className="h-7 w-7" />
          </div>
        )}
        {results.map((track, index) => (
          <TrackCard
            key={track.external_id}
            track={track}
            queue={results}
            queueIndex={index}
          />
        ))}
        {!showSearchingState && !error && totalPages > 1 && (
          <PaginationControls
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
          />
        )}
      </div>
    </div>
  );
}
