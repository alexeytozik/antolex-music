import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";

import { APIError, api } from "../lib/api";
import type { Track, User } from "../types";

const DEFAULT_PLAYER_STORAGE_KEY = "tozikron-player";
const STREAM_TTL_MS = 10 * 60 * 1000;
const PREVIOUS_RESTART_THRESHOLD_SECONDS = 3;

export type RepeatMode = "off" | "all" | "one";
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
  repeatMode: RepeatMode;
  shuffleEnabled: boolean;
  queue: PersistedQueueItem[];
  currentIndex: number;
};

type QueueInput = Track | Track[];

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
  repeatMode: RepeatMode;
  shuffleEnabled: boolean;
  currentTime: number;
  duration: number;
  bufferedTo: number;
  seekTarget: number | null;
  error: string | null;
  activeRequestId: number;
  setSession: (token: string, user: User, sessionExpiresAt: string) => void;
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
  next: () => void;
  previous: () => void;
  clearQueue: () => void;
  setVolume: (value: number) => void;
  setMuted: (value: boolean) => void;
  setRepeatMode: (mode: RepeatMode) => void;
  setShuffleEnabled: (value: boolean) => void;
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

function hydratePersistedQueueItem(item: PersistedQueueItem): QueueItem {
  return {
    queueId: item.queueId,
    track: item.track,
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

function clampIndex(index: number, length: number) {
  if (length === 0) {
    return -1;
  }
  return Math.min(Math.max(index, 0), length - 1);
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

  if (state.shuffleEnabled && state.queue.length > 1) {
    const candidates = state.queue
      .map((_, index) => index)
      .filter((index) => index !== state.currentIndex);
    return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
  }

  const nextIndex = state.currentIndex + 1;
  if (nextIndex < state.queue.length) {
    return nextIndex;
  }

  return null;
}

function computeEndedNextIndex(state: PlayerState) {
  return computeManualNextIndex(state);
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
  return computeManualNextIndex(state) !== null;
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
  return create<PlayerState>()(
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
        repeatMode: "off",
        shuffleEnabled: false,
        currentTime: 0,
        duration: 0,
        bufferedTo: 0,
        seekTarget: null,
        error: null,
        activeRequestId: 0,
        setSession: (token, user, sessionExpiresAt) =>
          set({ token, user, sessionExpiresAt }),
        clearSession: () =>
          set({
            token: null,
            user: null,
            sessionExpiresAt: null,
            likedExternalIDs: [],
          }),
        replaceQueue: (tracks, startIndex = 0, autoplay = true) => {
          const queue = tracks.map(createQueueItem);
          const currentIndex = clampIndex(startIndex, queue.length);
          const currentItem = currentIndex >= 0 ? queue[currentIndex] : null;

          set({
            queue,
            currentIndex,
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
          });
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
            const queue = [...state.queue, ...items];
            if (state.currentIndex >= 0) {
              return { queue };
            }

            return {
              queue,
              currentIndex: 0,
              status: "paused",
              duration: queue[0]?.track.duration_seconds ?? 0,
            };
          });
        },
        playAt: (index, autoplay = true) =>
          set((state) => {
            const nextIndex = clampIndex(index, state.queue.length);
            if (nextIndex < 0) {
              return {};
            }
            return moveToIndex(state, nextIndex, autoplay);
          }),
        togglePlayback: () =>
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
            };
          }),
        next: () =>
          set((state) => {
            const nextIndex = computeManualNextIndex(state);
            if (nextIndex === null) {
              return {
                isPlaying: false,
                status: state.queue.length > 0 ? "paused" : "idle",
              };
            }

            const history = state.shuffleEnabled
              ? [...state.history, state.currentIndex]
              : state.history;

            return moveToIndex(state, nextIndex, true, history);
          }),
        previous: () =>
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
              };
            }

            return moveToIndex(state, previousIndex, true);
          }),
        clearQueue: () =>
          set({
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
          }),
        setVolume: (value) => set({ volume: Math.min(Math.max(value, 0), 1) }),
        setMuted: (value) => set({ muted: value }),
        setRepeatMode: (mode) => set({ repeatMode: mode }),
        setShuffleEnabled: (value) => set({ shuffleEnabled: value }),
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
        handleTrackEnded: () =>
          set((state) => {
            const nextIndex = computeEndedNextIndex(state);
            if (nextIndex === null) {
              return {
                isPlaying: false,
                status: "paused",
                currentTime: state.duration,
              };
            }

            if (nextIndex === state.currentIndex) {
              return moveToIndex(state, nextIndex, true, state.history);
            }

            const history = state.shuffleEnabled
              ? [...state.history, state.currentIndex]
              : state.history;
            return moveToIndex(state, nextIndex, true, history);
          }),
        handlePlaybackError: (message) =>
          set((state) => ({
            status: "error",
            isPlaying: false,
            error: message,
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
          const token = get().token;
          if (!token) {
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
          const token = get().token;
          if (!token) {
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
        partialize: (state): PersistedPlayerState => ({
          token: state.token,
          user: state.user,
          sessionExpiresAt: state.sessionExpiresAt,
          volume: state.volume,
          muted: state.muted,
          repeatMode: state.repeatMode,
          shuffleEnabled: state.shuffleEnabled,
          queue: state.queue.map((item) => ({
            queueId: item.queueId,
            track: {
              ...item.track,
              stream_url: undefined,
            },
          })),
          currentIndex: state.currentIndex,
        }),
        merge: (persistedState, currentState) => {
          const persisted = persistedState as Partial<PersistedPlayerState>;
          const queue = sanitizePersistedQueue(persisted.queue);
          const currentIndex = clampIndex(
            persisted.currentIndex ?? -1,
            queue.length,
          );
          const sessionExpiresAt =
            persisted.sessionExpiresAt ?? currentState.sessionExpiresAt;
          const hasValidSession =
            !!persisted.token &&
            !!persisted.user &&
            !isSessionExpired(sessionExpiresAt);

          return {
            ...currentState,
            token: hasValidSession
              ? (persisted.token ?? currentState.token)
              : null,
            user: hasValidSession
              ? (persisted.user ?? currentState.user)
              : null,
            sessionExpiresAt: hasValidSession ? sessionExpiresAt : null,
            volume: persisted.volume ?? currentState.volume,
            muted: persisted.muted ?? currentState.muted,
            repeatMode: persisted.repeatMode ?? currentState.repeatMode,
            shuffleEnabled:
              persisted.shuffleEnabled ?? currentState.shuffleEnabled,
            queue: queue.length > 0 ? queue : currentState.queue,
            currentIndex,
            history: [],
            status: currentIndex >= 0 ? "paused" : "idle",
            isPlaying: false,
            currentTime: 0,
            duration:
              (queue.length > 0
                ? queue[currentIndex]?.track?.duration_seconds
                : undefined) ?? 0,
            bufferedTo: 0,
            seekTarget: null,
            error: null,
            activeRequestId: 0,
          };
        },
      },
    ),
  );
}

export const usePlayerStore = createPlayerStore();
