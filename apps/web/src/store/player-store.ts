import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";

import { APIError, api } from "../lib/api";
import {
  SEARCH_CURSOR_STORAGE_VERSION,
  startQueueContinuation,
  stopQueueContinuation,
  useQueueContinuationStore,
  type QueueContinuationSource,
} from "./queue-continuation-store";
import type { PlaybackSessionSource, Track, User } from "../types";

const DEFAULT_PLAYER_STORAGE_KEY = "antolex-music-player-v2";
const PREVIOUS_PLAYER_STORAGE_KEY = "antolex-music-player-v1";
const LEGACY_PLAYER_STORAGE_KEY = "tozikron-player";
const STREAM_TTL_MS = 10 * 60 * 1000;
const PREVIOUS_RESTART_THRESHOLD_SECONDS = 3;
const LEGACY_COVER_CACHE_VERSION = "g1";
const SHUFFLE_STATE_VERSION = 1;
const QUEUE_HISTORY_LIMIT = 40;
const QUEUE_FUTURE_PERSIST_LIMIT = 80;
const SHUFFLE_RETRY_MAX_DELAY_MS = 30_000;

export type PlaybackStatus =
  | "idle"
  | "resolving"
  | "retrying"
  | "ready"
  | "playing"
  | "paused"
  | "error";
export type ResolveStatus = "idle" | "loading" | "ready" | "error";

export type QueueItem = {
  queueId: string;
  track: Track;
  resolvedStreamUrl: string | null;
  resolvedAt: number | null;
  resolveStatus: ResolveStatus;
  resolveError: string | null;
  retryCount: number;
};

type PersistedQueueItem = {
  queueId: string;
  track: Track;
};

type PersistedPlayerState = {
  token: string | null;
  user: User | null;
  sessionExpiresAt: string | null;
  volume: number;
  muted: boolean;
  shuffleEnabled: boolean;
  shuffleStateVersion: number;
  shuffleCursor: string | null;
  shuffleExcludedExternalID: string | null;
  shuffleCycleComplete: boolean;
  shuffleCycleHasTracks: boolean;
  queueContextId: string;
  queueTruncated: boolean;
  preShuffleQueue: PersistedQueueItem[];
  preShuffleContinuation: SavedQueueContinuation | null;
  queue: PersistedQueueItem[];
  currentIndex: number;
  currentTime: number;
  playbackSessionId: string | null;
  playbackSessionQueueContextId: string | null;
  playbackTimelineTime: number;
  playbackSessionSource: PlaybackSessionSource | null;
};

type QueueInput = Track | Track[];

type SavedQueueContinuation = {
  source: QueueContinuationSource;
  cursor: string | null;
  page: number;
  hasMore: boolean;
  searchCursorVersion?: number;
};

type PlayerState = {
  token: string | null;
  user: User | null;
  sessionExpiresAt: string | null;
  likedExternalIDs: string[];
  queue: QueueItem[];
  currentIndex: number;
  history: number[];
  status: PlaybackStatus;
  isPlaying: boolean;
  volume: number;
  muted: boolean;
  shuffleEnabled: boolean;
  shuffleCursor: string | null;
  shuffleExcludedExternalID: string | null;
  shuffleCycleComplete: boolean;
  shuffleCycleHasTracks: boolean;
  shuffleLoading: boolean;
  shuffleRequestId: number;
  queueContextId: string;
  pendingAdvanceQueueContextId: string | null;
  preShuffleQueue: QueueItem[];
  preShuffleContinuation: SavedQueueContinuation | null;
  currentTime: number;
  duration: number;
  bufferedTo: number;
  seekTarget: number | null;
  error: string | null;
  playbackSessionId: string | null;
  playbackSessionQueueContextId: string | null;
  playbackTimelineTime: number;
  playbackSessionSource: PlaybackSessionSource | null;
  activeRequestId: number;
  setSession: (
    token: string | null | undefined,
    user: User,
    sessionExpiresAt: string,
  ) => void;
  clearSession: () => void;
  replaceQueue: (
    tracks: Track[],
    startIndex?: number,
    autoplay?: boolean,
  ) => void;
  playNow: (track: Track, sourceContext?: string) => void;
  enqueueNext: (input: QueueInput) => void;
  appendToQueue: (input: QueueInput) => void;
  playAt: (index: number, autoplay?: boolean) => void;
  togglePlayback: () => void;
  next: () => Promise<boolean>;
  previous: () => void;
  clearQueue: () => void;
  setVolume: (value: number) => void;
  setMuted: (value: boolean) => void;
  setShuffleEnabled: (value: boolean) => void;
  prefetchShuffle: () => Promise<boolean>;
  cancelPendingAdvance: (
    expectedQueueContextId: string,
    error?: string | null,
  ) => void;
  seek: (seconds: number) => void;
  clearSeekRequest: () => void;
  beginRetryCurrentTrack: () => boolean;
  resolveCurrentTrack: (force?: boolean) => Promise<Track | null>;
  hydrateResolvedTrack: (queueId: string, resolvedTrack: Track) => void;
  setPlaybackStatus: (status: PlaybackStatus, error?: string | null) => void;
  setPlaybackProgress: (
    currentTime: number,
    duration: number,
    bufferedTo: number,
  ) => void;
  setPlaybackSession: (
    id: string,
    queueContextId: string,
    timelineTime: number,
    source?: PlaybackSessionSource | null,
  ) => void;
  clearPlaybackSession: () => void;
  syncPlaybackSessionTimeline: (snapshot: {
    id: string;
    queueContextId: string;
    timelineTime: number;
    currentOrdinal: number;
    currentTime: number;
    duration: number;
    bufferedTo: number;
    items?: Array<{ ordinal: number; track: Track }>;
    source?: PlaybackSessionSource | null;
  }) => void;
  handleTrackEnded: () => void;
  handlePlaybackError: (message: string) => void;
  setLikedExternalIDs: (externalIDs: string[]) => void;
  loadLikes: () => Promise<void>;
  toggleLike: (track: Track) => Promise<void>;
  isLiked: (externalId: string) => boolean;
};

function createQueueId() {
  return (
    globalThis.crypto?.randomUUID?.() ?? `queue-${Date.now()}-${Math.random()}`
  );
}

function createQueueContextId() {
  return `context-${createQueueId()}`;
}

function normalizeTracks(input: QueueInput) {
  return Array.isArray(input) ? input : [input];
}

function createQueueItem(track: Track): QueueItem {
  const resolvedStreamUrl = track.stream_url ?? null;
  return {
    queueId: createQueueId(),
    track,
    resolvedStreamUrl,
    resolvedAt: resolvedStreamUrl ? Date.now() : null,
    resolveStatus: resolvedStreamUrl ? "ready" : "idle",
    resolveError: null,
    retryCount: 0,
  };
}

function migrateLegacyCoverURL(coverURL: string) {
  if (
    !coverURL.includes("?") &&
    /^\/api\/v1\/tracks\/[^/]+\/cover$/.test(coverURL)
  ) {
    return `${coverURL}?v=${LEGACY_COVER_CACHE_VERSION}`;
  }
  return coverURL;
}

function hydratePersistedQueueItem(item: PersistedQueueItem): QueueItem {
  return {
    queueId: item.queueId,
    track: {
      ...item.track,
      cover_url: migrateLegacyCoverURL(item.track.cover_url),
    },
    resolvedStreamUrl: null,
    resolvedAt: null,
    resolveStatus: "idle",
    resolveError: null,
    retryCount: 0,
  };
}

function isTrackLike(value: unknown): value is Track {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<Track>;
  return (
    typeof candidate.external_id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.artist === "string" &&
    typeof candidate.cover_url === "string"
  );
}

function normalizeUser(user: User): User {
  return {
    id: user.id,
    email: user.email,
    active: user.active,
    is_admin: user.is_admin,
    access_status: user.access_status,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

function sanitizePersistedQueue(input: unknown): QueueItem[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const candidate = entry as Partial<PersistedQueueItem> & Partial<Track>;
      const track = isTrackLike(candidate.track)
        ? candidate.track
        : isTrackLike(candidate)
          ? candidate
          : null;

      if (!track) {
        return null;
      }

      return hydratePersistedQueueItem({
        queueId:
          typeof candidate.queueId === "string" &&
          candidate.queueId.trim() !== ""
            ? candidate.queueId
            : createQueueId(),
        track,
      });
    })
    .filter((item): item is QueueItem => item !== null);
}

function sanitizeSavedQueueContinuation(
  input: unknown,
): SavedQueueContinuation | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Partial<SavedQueueContinuation>;
  const source = candidate.source;
  if (
    !source ||
    (source.kind !== "likes" &&
      !(source.kind === "search" && typeof source.query === "string"))
  ) {
    return null;
  }
  if (
    source.kind === "search" &&
    candidate.searchCursorVersion !== SEARCH_CURSOR_STORAGE_VERSION
  ) {
    return null;
  }
  return {
    source,
    cursor: typeof candidate.cursor === "string" ? candidate.cursor : null,
    page:
      typeof candidate.page === "number" && Number.isFinite(candidate.page)
        ? Math.max(1, Math.floor(candidate.page))
        : 1,
    hasMore: candidate.hasMore === true,
    searchCursorVersion:
      source.kind === "search" ? SEARCH_CURSOR_STORAGE_VERSION : undefined,
  };
}

function clampIndex(index: number, length: number) {
  if (length === 0) {
    return -1;
  }
  return Math.min(Math.max(index, 0), length - 1);
}

function compactConsumedQueue(
  queue: QueueItem[],
  currentIndex: number,
  history: number[],
) {
  const keepFrom = Math.max(0, currentIndex - QUEUE_HISTORY_LIMIT);
  if (keepFrom === 0) return { queue, currentIndex, history };
  return {
    queue: queue.slice(keepFrom),
    currentIndex: currentIndex - keepFrom,
    history: history
      .filter((index) => index >= keepFrom)
      .map((index) => index - keepFrom),
  };
}

function compactQueueForPersistence(
  queue: QueueItem[],
  currentIndex: number,
  history: number[],
) {
  const keepFrom = Math.max(0, currentIndex - QUEUE_HISTORY_LIMIT);
  const keepThrough = Math.min(
    queue.length,
    Math.max(0, currentIndex + 1) + QUEUE_FUTURE_PERSIST_LIMIT,
  );
  return {
    queue: queue.slice(keepFrom, keepThrough),
    currentIndex: currentIndex >= 0 ? currentIndex - keepFrom : -1,
    history: history
      .filter((index) => index >= keepFrom && index < keepThrough)
      .map((index) => index - keepFrom),
    truncated: keepThrough < queue.length,
  };
}

function isSessionExpired(sessionExpiresAt: string | null) {
  if (!sessionExpiresAt) {
    return false;
  }

  const expiresAt = Date.parse(sessionExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function toSessionExpiredError() {
  return new Error("Session expired. Request a new sign-in code.");
}

export function isQueueItemStreamFresh(item: QueueItem) {
  return (
    !!item.resolvedStreamUrl &&
    item.resolvedAt !== null &&
    Date.now() - item.resolvedAt < STREAM_TTL_MS
  );
}

function prepareQueueItemForPlayback(item: QueueItem): QueueItem {
  const hasFreshStream = isQueueItemStreamFresh(item);
  return {
    ...item,
    retryCount: 0,
    resolveStatus: hasFreshStream ? "ready" : "idle",
    resolveError: null,
  };
}

function computeManualNextIndex(state: PlayerState) {
  if (state.queue.length === 0 || state.currentIndex < 0) {
    return null;
  }

  const nextIndex = state.currentIndex + 1;
  if (nextIndex < state.queue.length) {
    return nextIndex;
  }

  return null;
}

function canWaitForQueueContinuation(state: PlayerState) {
  if (state.shuffleEnabled || state.currentIndex < 0) return false;
  const continuation = useQueueContinuationStore.getState();
  return (
    continuation.source !== null &&
    continuation.source.kind !== "shuffle" &&
    continuation.queueContextId === state.queueContextId &&
    continuation.hasMore &&
    Boolean(continuation.cursor)
  );
}

function isRetryableShuffleContinuationError(reason: unknown) {
  if (reason instanceof TypeError) return true;
  if (!reason || typeof reason !== "object" || !("status" in reason)) {
    return false;
  }
  const status = (reason as { status?: unknown }).status;
  return (
    typeof status === "number" &&
    (status === 408 || status === 429 || status >= 500)
  );
}

function shuffleContinuationRetryDelay(attempt: number) {
  return Math.min(
    500 * 2 ** Math.min(Math.max(0, attempt - 1), 6),
    SHUFFLE_RETRY_MAX_DELAY_MS,
  );
}

function computeHasPrevious(state: PlayerState) {
  if (state.currentIndex < 0) {
    return false;
  }

  return (
    state.currentTime > PREVIOUS_RESTART_THRESHOLD_SECONDS ||
    state.history.length > 0 ||
    state.currentIndex > 0
  );
}

function moveToIndex(
  state: PlayerState,
  nextIndex: number,
  autoplay: boolean,
  history: number[] = state.history,
): Partial<PlayerState> {
  const queue = state.queue.map((entry, index) =>
    index === nextIndex ? prepareQueueItemForPlayback(entry) : entry,
  );
  const nextItem = queue[nextIndex];
  return {
    queue,
    currentIndex: nextIndex,
    history,
    isPlaying: autoplay,
    status: nextItem
      ? autoplay
        ? isQueueItemStreamFresh(nextItem)
          ? "ready"
          : "resolving"
        : "paused"
      : "idle",
    currentTime: 0,
    duration: nextItem?.track.duration_seconds ?? 0,
    bufferedTo: 0,
    seekTarget: null,
    error: null,
    pendingAdvanceQueueContextId: null,
  };
}

function mergeResolvedTrack(item: QueueItem, resolvedTrack: Track): QueueItem {
  return {
    ...item,
    track: {
      ...item.track,
      ...resolvedTrack,
      stream_url: resolvedTrack.stream_url ?? item.track.stream_url,
    },
    resolvedStreamUrl: resolvedTrack.stream_url ?? item.resolvedStreamUrl,
    resolvedAt: resolvedTrack.stream_url ? Date.now() : item.resolvedAt,
    resolveStatus: resolvedTrack.stream_url ? "ready" : "error",
    resolveError: resolvedTrack.stream_url
      ? null
      : "Resolved track is missing a stream URL",
    retryCount: item.retryCount,
  };
}

export function selectCurrentItem(state: PlayerState) {
  if (state.currentIndex < 0) {
    return null;
  }
  return state.queue[state.currentIndex] ?? null;
}

export function selectCurrentTrack(state: PlayerState) {
  const item = selectCurrentItem(state);
  if (!item) {
    return null;
  }

  return {
    ...item.track,
    stream_url: isQueueItemStreamFresh(item)
      ? (item.resolvedStreamUrl ?? item.track.stream_url)
      : undefined,
  };
}

export function selectHasNext(state: PlayerState) {
  if (state.shuffleEnabled && state.currentIndex >= 0) {
    if (state.currentIndex + 1 < state.queue.length) return true;
    if (state.shuffleLoading) return true;
    if (!state.shuffleCycleComplete) return true;
    return state.shuffleCycleHasTracks;
  }
  return (
    computeManualNextIndex(state) !== null ||
    canWaitForQueueContinuation(state)
  );
}

export function selectHasPrevious(state: PlayerState) {
  return computeHasPrevious(state);
}

function createMemoryStorage(): StateStorage {
  const storage = new Map<string, string>();
  return {
    getItem: (name) => storage.get(name) ?? null,
    setItem: (name, value) => {
      storage.set(name, value);
    },
    removeItem: (name) => {
      storage.delete(name);
    },
  };
}

function resolveStorage(customStorage?: StateStorage) {
  if (customStorage) {
    return customStorage;
  }

  if (typeof window !== "undefined" && window.localStorage) {
    return window.localStorage;
  }

  return createMemoryStorage();
}

export function createPlayerStore(
  storageKey = DEFAULT_PLAYER_STORAGE_KEY,
  storage?: StateStorage,
) {
  let shuffleRequestPromise: Promise<boolean> | null = null;
  let shuffleRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let shuffleOnlineRetry: (() => void) | null = null;
  let shuffleRetryAttempt = 0;

  const clearShuffleRetryWaiters = () => {
    if (shuffleRetryTimer !== null) {
      clearTimeout(shuffleRetryTimer);
      shuffleRetryTimer = null;
    }
    if (shuffleOnlineRetry && typeof window !== "undefined") {
      window.removeEventListener("online", shuffleOnlineRetry);
      shuffleOnlineRetry = null;
    }
  };

  const resetShuffleRetry = () => {
    clearShuffleRetryWaiters();
    shuffleRetryAttempt = 0;
  };

  const scheduleShuffleRetry = (expectedQueueContextId: string) => {
    clearShuffleRetryWaiters();
    const retry = () => {
      clearShuffleRetryWaiters();
      const state = getStoreState();
      if (
        !state.shuffleEnabled ||
        state.queueContextId !== expectedQueueContextId ||
        state.pendingAdvanceQueueContextId !== expectedQueueContextId
      ) {
        shuffleRetryAttempt = 0;
        return;
      }
      void state.prefetchShuffle();
    };

    if (
      typeof window !== "undefined" &&
      typeof navigator !== "undefined" &&
      navigator.onLine === false
    ) {
      shuffleOnlineRetry = () => {
        setTimeout(retry, 0);
      };
      window.addEventListener("online", shuffleOnlineRetry, { once: true });
      return;
    }

    shuffleRetryAttempt += 1;
    shuffleRetryTimer = setTimeout(
      retry,
      shuffleContinuationRetryDelay(shuffleRetryAttempt),
    );
  };

  let getStoreState: () => PlayerState = () => {
    throw new Error("Player store has not initialized");
  };
  const store = create<PlayerState>()(
    persist(
      (set, get) => ({
        token: null,
        user: null,
        sessionExpiresAt: null,
        likedExternalIDs: [],
        queue: [],
        currentIndex: -1,
        history: [],
        status: "idle",
        isPlaying: false,
        volume: 0.8,
        muted: false,
        shuffleEnabled: false,
        shuffleCursor: null,
        shuffleExcludedExternalID: null,
        shuffleCycleComplete: false,
        shuffleCycleHasTracks: false,
        shuffleLoading: false,
        shuffleRequestId: 0,
        queueContextId: createQueueContextId(),
        pendingAdvanceQueueContextId: null,
        preShuffleQueue: [],
        preShuffleContinuation: null,
        currentTime: 0,
        duration: 0,
        bufferedTo: 0,
        seekTarget: null,
        error: null,
        playbackSessionId: null,
        playbackSessionQueueContextId: null,
        playbackTimelineTime: 0,
        playbackSessionSource: null,
        activeRequestId: 0,
        setSession: (_token, user, sessionExpiresAt) =>
          set({ token: null, user: normalizeUser(user), sessionExpiresAt }),
        clearSession: () => {
          resetShuffleRetry();
          shuffleRequestPromise = null;
          stopQueueContinuation();
          set((state) => ({
            token: null,
            user: null,
            sessionExpiresAt: null,
            likedExternalIDs: [],
            isPlaying: false,
            status: state.queue.length ? "paused" : "idle",
            pendingAdvanceQueueContextId: null,
            shuffleLoading: false,
            shuffleRequestId: state.shuffleRequestId + 1,
            playbackSessionId: null,
            playbackSessionQueueContextId: null,
            playbackTimelineTime: 0,
            playbackSessionSource: null,
          }));
        },
        replaceQueue: (tracks, startIndex = 0, autoplay = true) => {
          resetShuffleRetry();
          const queue = tracks.map(createQueueItem);
          const currentIndex = clampIndex(startIndex, queue.length);
          const currentItem = currentIndex >= 0 ? queue[currentIndex] : null;
          if (get().shuffleEnabled) shuffleRequestPromise = null;

          set((state) => ({
            queue:
              state.shuffleEnabled && currentItem ? [currentItem] : queue,
            currentIndex:
              state.shuffleEnabled && currentItem ? 0 : currentIndex,
            history: [],
            isPlaying: autoplay && currentItem !== null,
            status: currentItem
              ? autoplay
                ? isQueueItemStreamFresh(currentItem)
                  ? "ready"
                  : "resolving"
                : "paused"
              : "idle",
            currentTime: 0,
            duration: currentItem?.track.duration_seconds ?? 0,
            bufferedTo: 0,
            seekTarget: null,
            error: null,
            shuffleCursor: null,
            shuffleExcludedExternalID:
              state.shuffleEnabled && currentItem
                ? currentItem.track.external_id
                : null,
            shuffleCycleComplete: false,
            shuffleCycleHasTracks: false,
            shuffleLoading: false,
            shuffleRequestId: state.shuffleRequestId + 1,
            queueContextId: createQueueContextId(),
            pendingAdvanceQueueContextId: null,
            preShuffleQueue:
              state.shuffleEnabled && currentItem
                ? queue
                : state.preShuffleQueue,
            preShuffleContinuation:
              state.shuffleEnabled
                ? null
                : state.preShuffleContinuation,
            playbackSessionId: null,
            playbackSessionQueueContextId: null,
            playbackTimelineTime: 0,
            playbackSessionSource: null,
          }));

          if (get().shuffleEnabled && currentItem) {
            void get().prefetchShuffle();
          }
        },
        playNow: (track) => {
          get().replaceQueue([track], 0, true);
        },
        enqueueNext: (input) => {
          const items = normalizeTracks(input).map(createQueueItem);
          set((state) => {
            if (state.queue.length === 0 || state.currentIndex < 0) {
              const nextQueue = [...state.queue, ...items];
              return {
                queue: nextQueue,
                currentIndex: state.currentIndex >= 0 ? state.currentIndex : 0,
                status: state.currentIndex >= 0 ? state.status : "paused",
                duration: nextQueue[0]?.track.duration_seconds ?? 0,
              };
            }

            const insertAt = state.currentIndex + 1;
            return {
              queue: [
                ...state.queue.slice(0, insertAt),
                ...items,
                ...state.queue.slice(insertAt),
              ],
            };
          });
        },
        appendToQueue: (input) => {
          const items = normalizeTracks(input).map(createQueueItem);
          set((state) => {
            if (state.shuffleEnabled) {
              return {};
            }
            const compacted = compactConsumedQueue(
              state.queue,
              state.currentIndex,
              state.history,
            );
            const queue = [...compacted.queue, ...items];
            if (state.currentIndex >= 0) {
              if (
                state.pendingAdvanceQueueContextId === state.queueContextId &&
                items.length > 0
              ) {
                return moveToIndex(
                  {
                    ...state,
                    queue,
                    currentIndex: compacted.currentIndex,
                    history: compacted.history,
                  },
                  compacted.currentIndex + 1,
                  true,
                  compacted.history,
                );
              }
              return {
                queue,
                currentIndex: compacted.currentIndex,
                history: compacted.history,
              };
            }

            return {
              queue,
              currentIndex: 0,
              status: "paused",
              duration: queue[0]?.track.duration_seconds ?? 0,
            };
          });
        },
        playAt: (index, autoplay = true) => {
          resetShuffleRetry();
          set((state) => {
            const nextIndex = clampIndex(index, state.queue.length);
            if (nextIndex < 0) {
              return {};
            }
            return moveToIndex(state, nextIndex, autoplay);
          });
        },
        togglePlayback: () => {
          resetShuffleRetry();
          set((state) => {
            const currentItem = selectCurrentItem(state);
            if (!currentItem) {
              return {};
            }

            const isPlaying = !state.isPlaying;
            return {
              isPlaying,
              status: isPlaying
                ? isQueueItemStreamFresh(currentItem)
                  ? "ready"
                  : "resolving"
                : "paused",
              error: null,
              pendingAdvanceQueueContextId: null,
            };
          });
        },
        next: async () => {
          let snapshot = get();
          let nextIndex = computeManualNextIndex(snapshot);
          if (nextIndex !== null) {
            set((state) => {
              const index = computeManualNextIndex(state);
              if (index === null) return {};
              const history = state.shuffleEnabled
                ? [...state.history, state.currentIndex]
                : state.history;
              return moveToIndex(state, index, true, history);
            });
            return true;
          }

          if (!snapshot.shuffleEnabled || snapshot.currentIndex < 0) {
            if (canWaitForQueueContinuation(snapshot)) {
              set({
                pendingAdvanceQueueContextId: snapshot.queueContextId,
                isPlaying: true,
                status: "retrying",
                error: null,
              });
              return true;
            }
            set({
              isPlaying: false,
              status: snapshot.queue.length > 0 ? "paused" : "idle",
            });
            return false;
          }

          if (snapshot.shuffleCycleComplete) {
            if (!snapshot.shuffleCycleHasTracks) {
              set({ isPlaying: false, status: "paused" });
              return false;
            }

            const currentItem = selectCurrentItem(snapshot);
            if (!currentItem) return false;
            shuffleRequestPromise = null;
            set((state) => ({
              queue: [currentItem],
              currentIndex: 0,
              history: [],
              shuffleCursor: null,
              shuffleExcludedExternalID: currentItem.track.external_id,
              shuffleCycleComplete: false,
              shuffleCycleHasTracks: false,
              shuffleLoading: false,
              shuffleRequestId: state.shuffleRequestId + 1,
              error: null,
            }));
          }

          snapshot = get();
          const waitingItem = selectCurrentItem(snapshot);
          if (!waitingItem) return false;
          const expectedQueueContextId = snapshot.queueContextId;
          const expectedQueueId = waitingItem.queueId;
          set({
            pendingAdvanceQueueContextId: expectedQueueContextId,
            isPlaying: true,
            status: "retrying",
            error: null,
          });

          await get().prefetchShuffle();
          snapshot = get();
          if (
            !snapshot.shuffleEnabled ||
            snapshot.queueContextId !== expectedQueueContextId
          ) {
            return false;
          }
          if (selectCurrentItem(snapshot)?.queueId !== expectedQueueId) {
            return true;
          }
          if (
            snapshot.pendingAdvanceQueueContextId !== expectedQueueContextId
          ) {
            return false;
          }
          nextIndex = computeManualNextIndex(snapshot);
          if (nextIndex === null) {
            if (
              snapshot.shuffleCycleComplete &&
              !snapshot.shuffleCycleHasTracks
            ) {
              get().cancelPendingAdvance(expectedQueueContextId);
              return false;
            }
            return true;
          }

          resetShuffleRetry();
          set((state) => {
            const index = computeManualNextIndex(state);
            if (index === null) return {};
            return moveToIndex(
              state,
              index,
              true,
              [...state.history, state.currentIndex],
            );
          });
          return true;
        },
        previous: () => {
          resetShuffleRetry();
          set((state) => {
            if (state.currentIndex < 0) {
              return {};
            }

            if (state.currentTime > PREVIOUS_RESTART_THRESHOLD_SECONDS) {
              return {
                seekTarget: 0,
                currentTime: 0,
                status: state.isPlaying ? "ready" : "paused",
                error: null,
                pendingAdvanceQueueContextId: null,
              };
            }

            if (state.shuffleEnabled && state.history.length > 0) {
              const previousIndex = state.history[state.history.length - 1];
              const history = state.history.slice(0, -1);
              return moveToIndex(state, previousIndex, true, history);
            }

            const previousIndex =
              state.currentIndex > 0 ? state.currentIndex - 1 : null;

            if (previousIndex === null) {
              return {
                seekTarget: 0,
                currentTime: 0,
                status: state.isPlaying ? "ready" : "paused",
                error: null,
                pendingAdvanceQueueContextId: null,
              };
            }

            return moveToIndex(state, previousIndex, true);
          });
        },
        clearQueue: () => {
          resetShuffleRetry();
          set((state) => ({
            queue: [],
            currentIndex: -1,
            history: [],
            status: "idle",
            isPlaying: false,
            currentTime: 0,
            duration: 0,
            bufferedTo: 0,
            seekTarget: null,
            error: null,
            shuffleCursor: null,
            shuffleExcludedExternalID: null,
            shuffleCycleComplete: false,
            shuffleCycleHasTracks: false,
            shuffleLoading: false,
            shuffleRequestId: state.shuffleRequestId + 1,
            queueContextId: createQueueContextId(),
            pendingAdvanceQueueContextId: null,
            preShuffleQueue: [],
            preShuffleContinuation: null,
            playbackSessionId: null,
            playbackSessionQueueContextId: null,
            playbackTimelineTime: 0,
            playbackSessionSource: null,
          }));
        },
        setVolume: (value) => set({ volume: Math.min(Math.max(value, 0), 1) }),
        setMuted: (value) => set({ muted: value }),
        setShuffleEnabled: (value) => {
          const snapshot = get();
          if (snapshot.shuffleEnabled === value) return;
          resetShuffleRetry();
          shuffleRequestPromise = null;

          if (!value) {
            const currentItem = selectCurrentItem(snapshot);
            const savedQueue = snapshot.preShuffleQueue;
            const savedContinuation = snapshot.preShuffleContinuation;
            const savedCurrentIndex = currentItem
              ? savedQueue.findIndex(
                  (item) =>
                    item.track.external_id ===
                    currentItem.track.external_id,
                )
              : -1;
            const restoredQueue = currentItem
              ? savedCurrentIndex >= 0
                ? savedQueue.map((item, index) =>
                    index === savedCurrentIndex ? currentItem : item,
                  )
                : [
                    currentItem,
                    ...savedQueue.filter(
                      (item) =>
                        item.track.external_id !==
                        currentItem.track.external_id,
                    ),
                  ]
              : savedQueue;
            const restoredIndex = currentItem
              ? savedCurrentIndex >= 0
                ? savedCurrentIndex
                : 0
              : clampIndex(0, restoredQueue.length);
            const restoredQueueContextId = createQueueContextId();
            set((state) => ({
              shuffleEnabled: false,
              queue:
                restoredQueue.length > 0
                  ? restoredQueue
                  : state.queue,
              currentIndex:
                restoredQueue.length > 0
                  ? restoredIndex
                  : state.currentIndex,
              history: [],
              shuffleCursor: null,
              shuffleExcludedExternalID: null,
              shuffleCycleComplete: false,
              shuffleCycleHasTracks: false,
              shuffleLoading: false,
              shuffleRequestId: state.shuffleRequestId + 1,
              queueContextId: restoredQueueContextId,
              pendingAdvanceQueueContextId: null,
              preShuffleQueue: [],
              preShuffleContinuation: null,
              playbackSessionId: null,
              playbackSessionQueueContextId: null,
              playbackTimelineTime: 0,
              playbackSessionSource: null,
            }));
            if (savedContinuation && restoredQueue.length > 0) {
              startQueueContinuation({
                ...savedContinuation,
                queueContextId: restoredQueueContextId,
              });
            }
            return;
          }

          const currentItem = selectCurrentItem(snapshot);
          const continuation = useQueueContinuationStore.getState();
          const compacted = compactConsumedQueue(
            snapshot.queue,
            snapshot.currentIndex,
            snapshot.history,
          );
          const savedContinuation =
            continuation.source &&
            continuation.source.kind !== "shuffle" &&
            continuation.queueContextId === snapshot.queueContextId
              ? {
                  source: continuation.source,
                  cursor: continuation.cursor,
                  page: continuation.page,
                  hasMore: continuation.hasMore,
                  searchCursorVersion:
                    continuation.source.kind === "search"
                      ? SEARCH_CURSOR_STORAGE_VERSION
                      : undefined,
                }
              : null;
          stopQueueContinuation();
          set((state) => ({
            shuffleEnabled: true,
            queue: currentItem ? [currentItem] : [],
            currentIndex: currentItem ? 0 : -1,
            history: [],
            shuffleCursor: null,
            shuffleExcludedExternalID:
              currentItem?.track.external_id ?? null,
            shuffleCycleComplete: false,
            shuffleCycleHasTracks: false,
            shuffleLoading: false,
            shuffleRequestId: state.shuffleRequestId + 1,
            queueContextId: createQueueContextId(),
            pendingAdvanceQueueContextId: null,
            preShuffleQueue: compacted.queue,
            preShuffleContinuation: savedContinuation,
            error: null,
            playbackSessionId: null,
            playbackSessionQueueContextId: null,
            playbackTimelineTime: 0,
            playbackSessionSource: null,
          }));
          if (currentItem) void get().prefetchShuffle();
        },
        prefetchShuffle: async () => {
          if (shuffleRequestPromise) return shuffleRequestPromise;

          const snapshot = get();
          const currentItem = selectCurrentItem(snapshot);
          if (
            !snapshot.shuffleEnabled ||
            !currentItem ||
            snapshot.shuffleCycleComplete
          ) {
            return false;
          }

          const excluded =
            snapshot.shuffleExcludedExternalID ??
            currentItem.track.external_id;
          const requestId = snapshot.shuffleRequestId + 1;
          set({
            shuffleLoading: true,
            shuffleRequestId: requestId,
            shuffleExcludedExternalID: excluded,
            error: null,
          });

          const request = (async () => {
            try {
              const response = await api.shuffleWithCursor(
                1,
                snapshot.shuffleCursor,
                excluded,
              );
              const latest = get();
              if (
                !latest.shuffleEnabled ||
                latest.shuffleRequestId !== requestId ||
                latest.shuffleExcludedExternalID !== excluded
              ) {
                return false;
              }

              const existing = new Set(
                latest.queue.map((item) => item.track.external_id),
              );
              const incoming = (response.results ?? [])
                .filter((track) => {
                  if (existing.has(track.external_id)) return false;
                  existing.add(track.external_id);
                  return true;
                })
                .map(createQueueItem);

              const compacted = compactConsumedQueue(
                latest.queue,
                latest.currentIndex,
                latest.history,
              );

              const nextCursor = response.next_cursor ?? null;
              const cycleComplete =
                response.cycle_complete ||
                response.has_next === false ||
                !nextCursor;
              const nextState: Partial<PlayerState> = {
                queue: [...compacted.queue, ...incoming],
                currentIndex: compacted.currentIndex,
                history: compacted.history,
                shuffleCursor: nextCursor,
                shuffleCycleComplete: cycleComplete,
                shuffleCycleHasTracks:
                  latest.shuffleCycleHasTracks || incoming.length > 0,
                shuffleLoading: false,
                error: null,
              };
              const shouldAdvance =
                latest.pendingAdvanceQueueContextId ===
                  latest.queueContextId &&
                compacted.currentIndex === compacted.queue.length - 1 &&
                incoming.length > 0;
              if (shouldAdvance) {
                resetShuffleRetry();
                set({
                  ...nextState,
                  ...moveToIndex(
                    { ...latest, ...nextState } as PlayerState,
                    compacted.currentIndex + 1,
                    true,
                    [...compacted.history, compacted.currentIndex],
                  ),
                });
              } else {
                set(nextState);
                if (
                  latest.pendingAdvanceQueueContextId ===
                  latest.queueContextId
                ) {
                  if (cycleComplete) {
                    resetShuffleRetry();
                    get().cancelPendingAdvance(latest.queueContextId);
                  } else {
                    scheduleShuffleRetry(latest.queueContextId);
                  }
                } else {
                  resetShuffleRetry();
                }
              }
              return incoming.length > 0;
            } catch (reason) {
              const latest = get();
              if (latest.shuffleRequestId === requestId) {
                const message =
                  reason instanceof Error
                    ? reason.message
                    : "Could not continue shuffle";
                const retryable =
                  isRetryableShuffleContinuationError(reason);
                set({
                  shuffleLoading: false,
                  error: message,
                });
                if (
                  latest.pendingAdvanceQueueContextId ===
                  latest.queueContextId
                ) {
                  if (retryable) {
                    scheduleShuffleRetry(latest.queueContextId);
                  } else {
                    resetShuffleRetry();
                    get().cancelPendingAdvance(latest.queueContextId, message);
                  }
                }
              }
              return false;
            }
          })();

          shuffleRequestPromise = request;
          void request.finally(() => {
            if (shuffleRequestPromise === request) {
              shuffleRequestPromise = null;
            }
          });
          return request;
        },
        cancelPendingAdvance: (expectedQueueContextId, error = null) => {
          resetShuffleRetry();
          set((state) =>
            state.pendingAdvanceQueueContextId === expectedQueueContextId
              ? {
                  pendingAdvanceQueueContextId: null,
                  isPlaying: false,
                  status: "paused",
                  currentTime: state.duration,
                  error,
                }
              : {},
          );
        },
        seek: (seconds) => set({ seekTarget: Math.max(seconds, 0) }),
        clearSeekRequest: () => set({ seekTarget: null }),
        beginRetryCurrentTrack: () => {
          let started = false;
          set((state) => {
            const currentItem = selectCurrentItem(state);
            if (!currentItem || currentItem.retryCount >= 1) {
              return {};
            }

            started = true;
            return {
              status: "retrying",
              error: null,
              queue: state.queue.map((item, index) =>
                index === state.currentIndex
                  ? {
                      ...item,
                      retryCount: item.retryCount + 1,
                      resolveError: null,
                    }
                  : item,
              ),
            };
          });
          return started;
        },
        resolveCurrentTrack: async (force = false) => {
          const snapshot = get();
          const currentItem = selectCurrentItem(snapshot);
          if (!currentItem) {
            return null;
          }

          if (!force && isQueueItemStreamFresh(currentItem)) {
            return selectCurrentTrack(get());
          }

          if (currentItem.resolveStatus === "loading") {
            return selectCurrentTrack(get());
          }

          const requestId = snapshot.activeRequestId + 1;
          const queueId = currentItem.queueId;

          set((state) => ({
            activeRequestId: requestId,
            status:
              state.currentIndex >= 0 &&
              state.queue[state.currentIndex]?.queueId === queueId
                ? force
                  ? "retrying"
                  : "resolving"
                : state.status,
            error: null,
            queue: state.queue.map((item) =>
              item.queueId === queueId
                ? {
                    ...item,
                    resolveStatus: "loading",
                    resolveError: null,
                  }
                : item,
            ),
          }));

          try {
            const resolvedTrack = await api.resolveTrack(
              currentItem.track.external_id,
            );
            const latest = get();
            if (latest.activeRequestId !== requestId) {
              return selectCurrentTrack(latest);
            }

            latest.hydrateResolvedTrack(queueId, resolvedTrack);
            return selectCurrentTrack(get());
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : "Failed to resolve stream URL";
            const latest = get();
            if (latest.activeRequestId !== requestId) {
              return selectCurrentTrack(latest);
            }

            set((state) => ({
              status:
                state.currentIndex >= 0 &&
                state.queue[state.currentIndex]?.queueId === queueId
                  ? "error"
                  : state.status,
              error: message,
              isPlaying: false,
              queue: state.queue.map((item) =>
                item.queueId === queueId
                  ? {
                      ...item,
                      resolveStatus: "error",
                      resolveError: message,
                    }
                  : item,
              ),
            }));
            throw error;
          }
        },
        hydrateResolvedTrack: (queueId, resolvedTrack) =>
          set((state) => {
            const queue = state.queue.map((item) =>
              item.queueId === queueId
                ? mergeResolvedTrack(item, resolvedTrack)
                : item,
            );
            const currentItem = selectCurrentItem({
              ...state,
              queue,
            });

            return {
              queue,
              status: currentItem
                ? state.isPlaying
                  ? isQueueItemStreamFresh(currentItem)
                    ? "ready"
                    : "error"
                  : "paused"
                : state.status,
              duration: currentItem?.track.duration_seconds ?? state.duration,
              error: currentItem?.resolvedStreamUrl ? null : state.error,
            };
          }),
        setPlaybackStatus: (status, error = null) =>
          set((state) => ({
            status,
            error: error ?? (status === "error" ? state.error : null),
            isPlaying:
              status === "playing"
                ? true
                : status === "paused"
                  ? false
                  : state.isPlaying,
          })),
        setPlaybackProgress: (currentTime, duration, bufferedTo) =>
          set({
            currentTime,
            duration: Number.isFinite(duration) ? duration : 0,
            bufferedTo: Number.isFinite(bufferedTo) ? bufferedTo : 0,
          }),
        setPlaybackSession: (id, queueContextId, timelineTime, source) =>
          set((state) => ({
            playbackSessionId: id,
            playbackSessionQueueContextId: queueContextId,
            playbackTimelineTime: Math.max(0, timelineTime),
            playbackSessionSource:
              source === undefined ? state.playbackSessionSource : source,
          })),
        clearPlaybackSession: () =>
          set({
            playbackSessionId: null,
            playbackSessionQueueContextId: null,
            playbackTimelineTime: 0,
            playbackSessionSource: null,
          }),
        syncPlaybackSessionTimeline: (snapshot) =>
          set((state) => {
            const existingByQueueID = new Map(
              state.queue.map((item) => [item.queueId, item] as const),
            );
            const queue = snapshot.items
              ? snapshot.items.map(({ ordinal, track }) => {
                  const queueId = `playback-${ordinal}-${track.external_id}`;
                  const existing = existingByQueueID.get(queueId);
                  return existing
                    ? {
                        ...existing,
                        track: { ...existing.track, ...track },
                      }
                    : { ...createQueueItem(track), queueId };
                })
              : state.queue;
            const currentQueueIDPrefix = `playback-${snapshot.currentOrdinal}-`;
            const currentIndex = queue.findIndex((item) =>
              item.queueId.startsWith(currentQueueIDPrefix),
            );
            if (currentIndex < 0) return {};
            return {
              queue,
              currentIndex,
              currentTime: Math.max(0, snapshot.currentTime),
              duration: Number.isFinite(snapshot.duration)
                ? Math.max(0, snapshot.duration)
                : 0,
              bufferedTo: Number.isFinite(snapshot.bufferedTo)
                ? Math.max(0, snapshot.bufferedTo)
                : 0,
              seekTarget: null,
              playbackSessionId: snapshot.id,
              playbackSessionQueueContextId: snapshot.queueContextId,
              playbackTimelineTime: Math.max(0, snapshot.timelineTime),
              playbackSessionSource:
                snapshot.source === undefined
                  ? state.playbackSessionSource
                  : snapshot.source,
              error: null,
              pendingAdvanceQueueContextId: null,
            };
          }),
        handleTrackEnded: () => {
          const endedQueueContextId = get().queueContextId;
          const endedQueueId = selectCurrentItem(get())?.queueId;
          void get().next().then((advanced) => {
            if (!advanced) {
              set((state) =>
                state.queueContextId === endedQueueContextId &&
                selectCurrentItem(state)?.queueId === endedQueueId
                  ? {
                      isPlaying: false,
                      status: "paused",
                      currentTime: state.duration,
                    }
                  : {},
              );
            }
          });
        },
        handlePlaybackError: (message) =>
          set((state) => ({
            status: "error",
            isPlaying: false,
            error: message,
            pendingAdvanceQueueContextId: null,
            queue: state.queue.map((item, index) =>
              index === state.currentIndex
                ? {
                    ...item,
                    resolveStatus: "error",
                    resolveError: message,
                  }
                : item,
            ),
          })),
        setLikedExternalIDs: (likedExternalIDs) => set({ likedExternalIDs }),
        loadLikes: async () => {
          const { token, user } = get();
          if (!user) {
            set({ likedExternalIDs: [] });
            return;
          }

          try {
            const likedExternalIDs = await api.getLikedIDs(token);
            set({ likedExternalIDs });
          } catch (error) {
            if (error instanceof APIError && error.code === "unauthorized") {
              get().clearSession();
              throw toSessionExpiredError();
            }
            throw error;
          }
        },
        toggleLike: async (track) => {
          const { token, user } = get();
          if (!user) {
            throw new Error("Sign in from your profile to save tracks");
          }

          const alreadyLiked = get().likedExternalIDs.includes(
            track.external_id,
          );

          if (alreadyLiked) {
            try {
              await api.removeLike(token, track.external_id);
            } catch (error) {
              if (error instanceof APIError && error.code === "unauthorized") {
                get().clearSession();
                throw toSessionExpiredError();
              }
              throw error;
            }
            set((state) => ({
              likedExternalIDs: state.likedExternalIDs.filter(
                (externalId) => externalId !== track.external_id,
              ),
            }));
            return;
          }

          try {
            await api.addLike(token, track);
          } catch (error) {
            if (error instanceof APIError && error.code === "unauthorized") {
              get().clearSession();
              throw toSessionExpiredError();
            }
            throw error;
          }
          set((state) => ({
            likedExternalIDs: Array.from(
              new Set([...state.likedExternalIDs, track.external_id]),
            ),
          }));
        },
        isLiked: (externalId) => get().likedExternalIDs.includes(externalId),
      }),
      {
        name: storageKey,
        storage: createJSONStorage(() => resolveStorage(storage)),
        partialize: (state): PersistedPlayerState => {
          const compacted = compactQueueForPersistence(
            state.queue,
            state.currentIndex,
            state.history,
          );
          const persistItems = (items: QueueItem[]) =>
            items.map((item) => ({
              queueId: item.queueId,
              track: {
                ...item.track,
                stream_url: undefined,
              },
            }));
          const preShufflePersistLimit =
            QUEUE_HISTORY_LIMIT + 1 + QUEUE_FUTURE_PERSIST_LIMIT;
          const preShuffleQueueTruncated =
            state.preShuffleQueue.length > preShufflePersistLimit;
          return {
            token: state.token,
            user: state.user,
            sessionExpiresAt: state.sessionExpiresAt,
            volume: state.volume,
            muted: state.muted,
            shuffleEnabled: state.shuffleEnabled,
            shuffleStateVersion: SHUFFLE_STATE_VERSION,
            shuffleCursor: state.shuffleCursor,
            shuffleExcludedExternalID: state.shuffleExcludedExternalID,
            shuffleCycleComplete: state.shuffleCycleComplete,
            shuffleCycleHasTracks: state.shuffleCycleHasTracks,
            queueContextId: state.queueContextId,
            queueTruncated: compacted.truncated,
            preShuffleQueue: persistItems(
              state.preShuffleQueue.slice(0, preShufflePersistLimit),
            ),
            preShuffleContinuation: preShuffleQueueTruncated
              ? null
              : state.preShuffleContinuation,
            queue: persistItems(compacted.queue),
            currentIndex: compacted.currentIndex,
            currentTime: state.currentTime,
            playbackSessionId: state.playbackSessionId,
            playbackSessionQueueContextId:
              state.playbackSessionQueueContextId,
            playbackTimelineTime: state.playbackTimelineTime,
            playbackSessionSource: state.playbackSessionSource,
          };
        },
        merge: (persistedState, currentState) => {
          const persisted = persistedState as Partial<PersistedPlayerState>;
          const queue = sanitizePersistedQueue(persisted.queue);
          const preShuffleQueue = sanitizePersistedQueue(
            persisted.preShuffleQueue,
          );
          const currentIndex = clampIndex(
            persisted.currentIndex ?? -1,
            queue.length,
          );
          const shuffleEnabled = persisted.shuffleEnabled === true;
          const hasPersistedShuffleCycle =
            persisted.shuffleStateVersion === SHUFFLE_STATE_VERSION;
          const legacyShuffleItem =
            shuffleEnabled && !hasPersistedShuffleCycle && currentIndex >= 0
              ? queue[currentIndex]
              : null;
          const hydratedQueue = legacyShuffleItem
            ? [legacyShuffleItem]
            : queue;
          const hydratedIndex = legacyShuffleItem ? 0 : currentIndex;
          const sessionExpiresAt =
            persisted.sessionExpiresAt ?? currentState.sessionExpiresAt;
          const hasValidSession =
            !!persisted.user &&
            !isSessionExpired(sessionExpiresAt);
          const hydratedQueueContextId =
            typeof persisted.queueContextId === "string" &&
            persisted.queueContextId !== "" &&
            persisted.queueTruncated !== true
              ? persisted.queueContextId
              : createQueueContextId();

          return {
            ...currentState,
            token: hasValidSession
              ? (persisted.token ?? currentState.token)
              : null,
            user: hasValidSession
              ? normalizeUser(persisted.user ?? currentState.user!)
              : null,
            sessionExpiresAt: hasValidSession ? sessionExpiresAt : null,
            volume: persisted.volume ?? currentState.volume,
            muted: persisted.muted ?? currentState.muted,
            shuffleEnabled,
            shuffleCursor:
              shuffleEnabled && hasPersistedShuffleCycle &&
              typeof persisted.shuffleCursor === "string"
                ? persisted.shuffleCursor
                : null,
            shuffleExcludedExternalID: shuffleEnabled
              ? typeof persisted.shuffleExcludedExternalID === "string"
                ? persisted.shuffleExcludedExternalID
                : hydratedQueue[hydratedIndex]?.track.external_id ?? null
              : null,
            shuffleCycleComplete:
              shuffleEnabled &&
              hasPersistedShuffleCycle &&
              persisted.shuffleCycleComplete === true,
            shuffleCycleHasTracks:
              shuffleEnabled &&
              hasPersistedShuffleCycle &&
              persisted.shuffleCycleHasTracks === true,
            shuffleLoading: false,
            shuffleRequestId: 0,
            queueContextId: hydratedQueueContextId,
            pendingAdvanceQueueContextId: null,
            preShuffleQueue: shuffleEnabled ? preShuffleQueue : [],
            preShuffleContinuation: shuffleEnabled
              ? sanitizeSavedQueueContinuation(
                  persisted.preShuffleContinuation,
                )
              : null,
            queue:
              hydratedQueue.length > 0
                ? hydratedQueue
                : currentState.queue,
            currentIndex: hydratedIndex,
            history: [],
            status: hydratedIndex >= 0 ? "paused" : "idle",
            isPlaying: false,
            currentTime: persisted.currentTime ?? 0,
            duration:
              (hydratedQueue.length > 0
                ? hydratedQueue[hydratedIndex]?.track?.duration_seconds
                : undefined) ?? 0,
            bufferedTo: 0,
            seekTarget:
              hydratedIndex >= 0 && (persisted.currentTime ?? 0) > 0
                ? (persisted.currentTime ?? 0)
                : null,
            error: null,
            activeRequestId: 0,
            playbackSessionId:
              typeof persisted.playbackSessionId === "string"
                ? persisted.playbackSessionId
                : null,
            playbackSessionQueueContextId:
              typeof persisted.playbackSessionId === "string"
                ? persisted.queueTruncated === true
                  ? hydratedQueueContextId
                  : typeof persisted.playbackSessionQueueContextId === "string"
                  ? persisted.playbackSessionQueueContextId
                  : typeof persisted.queueContextId === "string"
                    ? persisted.queueContextId
                    : hydratedQueueContextId
                : null,
            playbackTimelineTime:
              typeof persisted.playbackTimelineTime === "number" &&
              Number.isFinite(persisted.playbackTimelineTime)
                ? Math.max(0, persisted.playbackTimelineTime)
                : 0,
            playbackSessionSource:
              persisted.playbackSessionSource?.kind === "likes"
                ? { kind: "likes" }
                : persisted.playbackSessionSource?.kind === "shuffle"
                  ? {
                      kind: "shuffle",
                      ...(typeof persisted.playbackSessionSource
                        .exclude_external_id === "string"
                        ? {
                            exclude_external_id:
                              persisted.playbackSessionSource
                                .exclude_external_id,
                          }
                        : {}),
                    }
                  : persisted.playbackSessionSource?.kind === "search" &&
                      typeof persisted.playbackSessionSource.query === "string"
                    ? {
                        kind: "search",
                        query: persisted.playbackSessionSource.query,
                      }
                    : null,
          };
        },
      },
    ),
  );
  getStoreState = store.getState;
  return store;
}

function migrateLegacyPlayerStorage() {
  if (typeof window === "undefined") return;
  try {
    const previous =
      window.localStorage.getItem(PREVIOUS_PLAYER_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_PLAYER_STORAGE_KEY);
    if (!window.localStorage.getItem(DEFAULT_PLAYER_STORAGE_KEY) && previous) {
      window.localStorage.setItem(
        DEFAULT_PLAYER_STORAGE_KEY,
        previous,
      );
    }
  } catch {
    // Storage can be unavailable in private browsing; the player still works in memory.
  }
}

export function removeLegacyPlayerStorage() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LEGACY_PLAYER_STORAGE_KEY);
  } catch {
    // Ignore unavailable storage.
  }
}

migrateLegacyPlayerStorage();
export const usePlayerStore = createPlayerStore();
