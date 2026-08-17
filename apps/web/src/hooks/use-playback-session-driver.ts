import type Hls from "hls.js";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { APIError, api } from "../lib/api";
import {
  createPlaybackSessionInput,
  findPlaybackBoundary,
  sortedPlaybackItems,
  sourceForPlaybackSession,
  timelinePositionFor,
} from "../lib/playback-session";
import { usePlayerStore, type QueueItem } from "../store/player-store";
import { useQueueContinuationStore } from "../store/queue-continuation-store";
import type { PlaybackSession, PlaybackSessionSource } from "../types";

export type PlaybackDriver =
  | "progressive"
  | "preparing"
  | "hls-native"
  | "hls-js";

type DriverInput = {
  audioRef: RefObject<HTMLAudioElement | null>;
  currentItem: QueueItem | null;
  queueContextId: string;
  isPlaying: boolean;
};

const NATIVE_HLS_START_TIMEOUT_MS = 8_000;
const SESSION_REFRESH_MS = 60_000;
const MAX_FATAL_NETWORK_RECOVERIES = 2;
const MAX_FATAL_MEDIA_RECOVERIES = 1;
// Production keeps this disabled for the first rollout so the migration and
// worker can finish and verify the CMAF backfill before clients request HLS.
// Vite development and tests stay enabled unless the flag is explicitly false.
const HLS_PLAYBACK_ENABLED =
  import.meta.env.VITE_HLS_PLAYBACK_ENABLED !== "false";

let hlsModulePromise: Promise<typeof import("hls.js")> | null = null;

function loadHLSModule() {
  hlsModulePromise ??= import("hls.js");
  return hlsModulePromise;
}

function canUseNativeHLS(audio: HTMLAudioElement) {
  return Boolean(
    audio.canPlayType("application/vnd.apple.mpegurl") ||
      audio.canPlayType("application/x-mpegURL"),
  );
}

export function usePlaybackSessionDriver({
  audioRef,
  currentItem,
  queueContextId,
  isPlaying,
}: DriverInput) {
  const [driver, setDriver] = useState<PlaybackDriver>("progressive");
  const [session, setSession] = useState<PlaybackSession | null>(null);
  const driverRef = useRef<PlaybackDriver>("progressive");
  const sessionRef = useRef<PlaybackSession | null>(null);
  const contextRef = useRef<string | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const nativeTimerRef = useRef<number | null>(null);
  const hlsFallbackRef = useRef<(() => void) | null>(null);
  const lastOrdinalRef = useRef<number | null>(null);
  const lastItemsSignatureRef = useRef<string | null>(null);

  const changeDriver = useCallback((next: PlaybackDriver) => {
    driverRef.current = next;
    setDriver(next);
  }, []);

  const destroyHLS = useCallback(() => {
    if (nativeTimerRef.current !== null) {
      window.clearTimeout(nativeTimerRef.current);
      nativeTimerRef.current = null;
    }
    hlsRef.current?.destroy();
    hlsRef.current = null;
  }, []);

  const fallBackToProgressive = useCallback(() => {
    const audio = audioRef.current;
    const sessionID = sessionRef.current?.id;
    destroyHLS();
    sessionRef.current = null;
    setSession(null);
    contextRef.current = null;
    lastOrdinalRef.current = null;
    lastItemsSignatureRef.current = null;
    hlsFallbackRef.current = null;
    if (audio?.dataset.playbackSessionId) {
      audio.pause();
      audio.removeAttribute("src");
      delete audio.dataset.playbackSessionId;
      audio.load();
    }
    usePlayerStore.getState().clearPlaybackSession();
    changeDriver("progressive");
    if (sessionID) {
      void api.deletePlaybackSession(sessionID).catch(() => {
        // Session expiry cleanup is also enforced server-side.
      });
    }
  }, [audioRef, changeDriver, destroyHLS]);

  const syncTimeline = useCallback(
    (timelineSeconds?: number) => {
      const audio = audioRef.current;
      const activeSession = sessionRef.current;
      if (!audio || !activeSession) return null;
      const position =
        typeof timelineSeconds === "number" && Number.isFinite(timelineSeconds)
          ? timelineSeconds
          : audio.currentTime;
      const boundary = findPlaybackBoundary(activeSession.items, position);
      if (!boundary) return null;

      const itemsSignature = `${activeSession.id}:${activeSession.revision}:${activeSession.items.length}`;
      if (
        lastOrdinalRef.current !== boundary.item.ordinal ||
        lastItemsSignatureRef.current !== itemsSignature
      ) {
        lastOrdinalRef.current = boundary.item.ordinal;
        lastItemsSignatureRef.current = itemsSignature;
        const items = sortedPlaybackItems(activeSession.items);
        usePlayerStore.getState().syncPlaybackSessionQueue(
          items.map((item) => ({ ordinal: item.ordinal, track: item.track })),
          boundary.item.ordinal,
          boundary.localSeconds,
          position,
        );
      }

      const itemStart = boundary.item.timeline_start_ms / 1000;
      let buffered = boundary.localSeconds;
      for (let index = 0; index < audio.buffered.length; index += 1) {
        if (
          audio.buffered.start(index) <= position &&
          audio.buffered.end(index) >= position
        ) {
          buffered = Math.min(
            boundary.durationSeconds,
            Math.max(0, audio.buffered.end(index) - itemStart),
          );
          break;
        }
      }
      const player = usePlayerStore.getState();
      player.setPlaybackProgress(
        boundary.localSeconds,
        boundary.durationSeconds,
        buffered,
      );
      player.setPlaybackSession(activeSession.id, queueContextId, position);
      return boundary;
    },
    [audioRef, queueContextId],
  );

  const attachSession = useCallback(
    (
      nextSession: PlaybackSession,
      initialPosition?: number,
      source?: PlaybackSessionSource | null,
    ) => {
      const audio = audioRef.current;
      if (!audio || nextSession.items.length === 0) {
        fallBackToProgressive();
        return;
      }

      destroyHLS();
      const previousSessionID = sessionRef.current?.id;
      sessionRef.current = nextSession;
      setSession(nextSession);
      contextRef.current = queueContextId;
      lastOrdinalRef.current = null;
      lastItemsSignatureRef.current = null;
      if (previousSessionID && previousSessionID !== nextSession.id) {
        void api.deletePlaybackSession(previousSessionID).catch(() => {
          // The server will remove an unreachable session after its idle TTL.
        });
      }

      const player = usePlayerStore.getState();
      const desiredPosition = Math.max(
        0,
        initialPosition ??
          (player.playbackSessionId === nextSession.id
            ? player.playbackTimelineTime
            : nextSession.start_offset_seconds),
      );
      const boundary = findPlaybackBoundary(nextSession.items, desiredPosition);
      if (boundary) {
        const items = sortedPlaybackItems(nextSession.items);
        player.syncPlaybackSessionQueue(
          items.map((item) => ({ ordinal: item.ordinal, track: item.track })),
          boundary.item.ordinal,
          boundary.localSeconds,
          desiredPosition,
        );
        lastOrdinalRef.current = boundary.item.ordinal;
        lastItemsSignatureRef.current = `${nextSession.id}:${nextSession.revision}:${nextSession.items.length}`;
      }
      player.setPlaybackSession(
        nextSession.id,
        queueContextId,
        desiredPosition,
        source,
      );

      const seekWhenReady = () => {
        if (!sessionRef.current || sessionRef.current.id !== nextSession.id) return;
        if (Number.isFinite(desiredPosition)) audio.currentTime = desiredPosition;
        syncTimeline(desiredPosition);
      };

      audio.dataset.playbackSessionId = nextSession.id;
      delete audio.dataset.queueId;
      delete audio.dataset.streamUrl;
      delete audio.dataset.resolvedAt;

      const attachJavaScriptHLS = (
        resumePosition: number,
        resumePlayback: boolean,
      ) => {
        const hlsPosition = Number.isFinite(resumePosition)
          ? Math.max(0, resumePosition)
          : desiredPosition;
        const resumeWhenReady = () => {
          if (sessionRef.current?.id !== nextSession.id) return;
          audio.currentTime = hlsPosition;
          syncTimeline(hlsPosition);
          if (!resumePlayback || !usePlayerStore.getState().isPlaying) return;
          void audio.play()
            .then(() => {
              if (
                sessionRef.current?.id === nextSession.id &&
                usePlayerStore.getState().isPlaying
              ) {
                usePlayerStore.getState().setPlaybackStatus("playing");
              }
            })
            .catch((reason: unknown) => {
              if (
                reason instanceof DOMException &&
                reason.name === "NotAllowedError"
              ) {
                usePlayerStore
                  .getState()
                  .setPlaybackStatus("paused", "Tap play to continue");
              }
            });
        };
        void loadHLSModule()
          .then(({ default: HLS }) => {
            if (sessionRef.current?.id !== nextSession.id) return;
            if (!HLS.isSupported()) {
              fallBackToProgressive();
              return;
            }
            destroyHLS();
            audio.dataset.playbackSessionId = nextSession.id;
            changeDriver("hls-js");
            const hls = new HLS({
              backBufferLength: 120,
              maxBufferLength: 600,
              maxMaxBufferLength: 600,
              enableWorker: true,
            });
            let fatalNetworkRecoveries = 0;
            let fatalMediaRecoveries = 0;
            hlsRef.current = hls;
            hls.on(HLS.Events.MEDIA_ATTACHED, () => {
              hls.loadSource(nextSession.manifest_url);
            });
            hls.on(HLS.Events.MANIFEST_PARSED, resumeWhenReady);
            hls.on(HLS.Events.FRAG_BUFFERED, () => {
              fatalNetworkRecoveries = 0;
              fatalMediaRecoveries = 0;
            });
            hls.on(HLS.Events.ERROR, (_event, data) => {
              if (!data.fatal) return;
              if (data.type === HLS.ErrorTypes.NETWORK_ERROR) {
                fatalNetworkRecoveries += 1;
                if (fatalNetworkRecoveries > MAX_FATAL_NETWORK_RECOVERIES) {
                  fallBackToProgressive();
                  return;
                }
                hls.startLoad();
                return;
              }
              if (data.type === HLS.ErrorTypes.MEDIA_ERROR) {
                fatalMediaRecoveries += 1;
                if (fatalMediaRecoveries > MAX_FATAL_MEDIA_RECOVERIES) {
                  fallBackToProgressive();
                  return;
                }
                hls.recoverMediaError();
                return;
              }
              fallBackToProgressive();
            });
            hls.attachMedia(audio);
          })
          .catch(() => {
            if (sessionRef.current?.id === nextSession.id) {
              fallBackToProgressive();
            }
          });
      };
      hlsFallbackRef.current = () => {
        const resumePosition = audio.currentTime;
        const resumePlayback = usePlayerStore.getState().isPlaying;
        attachJavaScriptHLS(resumePosition, resumePlayback);
      };

      if (canUseNativeHLS(audio)) {
        changeDriver("hls-native");
        audio.src = nextSession.manifest_url;
        audio.load();
        audio.addEventListener("loadedmetadata", seekWhenReady, { once: true });
        nativeTimerRef.current = window.setTimeout(() => {
          nativeTimerRef.current = null;
          if (audio.readyState > 0 || driverRef.current !== "hls-native") return;
          attachJavaScriptHLS(
            desiredPosition,
            usePlayerStore.getState().isPlaying,
          );
        }, NATIVE_HLS_START_TIMEOUT_MS);
        return;
      }

      attachJavaScriptHLS(
        desiredPosition,
        usePlayerStore.getState().isPlaying,
      );
    },
    [
      audioRef,
      changeDriver,
      destroyHLS,
      fallBackToProgressive,
      queueContextId,
      syncTimeline,
    ],
  );

  const refreshSession = useCallback(async () => {
    const activeSession = sessionRef.current;
    if (!activeSession) return null;
    try {
      const refreshed = await api.getPlaybackSession(activeSession.id);
      if (sessionRef.current?.id !== refreshed.id) return null;
      sessionRef.current = refreshed;
      setSession(refreshed);
      syncTimeline();
      return refreshed;
    } catch {
      return null;
    }
  }, [syncTimeline]);

  useEffect(() => {
    if (!HLS_PLAYBACK_ENABLED) {
      if (
        driverRef.current !== "progressive" ||
        sessionRef.current !== null
      ) {
        fallBackToProgressive();
      }
      return;
    }
    if (!currentItem) {
      fallBackToProgressive();
      return;
    }
    if (
      contextRef.current === queueContextId &&
      sessionRef.current &&
      driverRef.current !== "progressive"
    ) {
      return;
    }

    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    changeDriver("preparing");

    void (async () => {
      const player = usePlayerStore.getState();
      try {
        const continuation = useQueueContinuationStore.getState();
        const continuationMatches =
          continuation.queueContextId === queueContextId
            ? continuation
            : null;
        let sessionSource =
          player.playbackSessionSource ??
          sourceForPlaybackSession(
            player.shuffleEnabled,
            continuationMatches?.source ?? null,
            player.shuffleExcludedExternalID,
          );
        const createSession = async () => {
          const payload = createPlaybackSessionInput({
            source: sessionSource,
            queue: player.queue.map((item) => item.track),
            currentIndex: player.currentIndex,
            currentTime: player.currentTime,
            cursor: player.shuffleEnabled
              ? player.shuffleCursor
              : continuationMatches?.cursor ?? null,
            page: continuationMatches?.page ?? 1,
            hasMore: player.shuffleEnabled
              ? !player.shuffleCycleComplete
              : continuationMatches?.hasMore ?? false,
          });
          if (!payload) throw new Error("Playback queue cannot start an HLS session");
          return api.createPlaybackSession(payload, controller.signal);
        };
        let response: PlaybackSession;
        if (
          player.playbackSessionId &&
          player.playbackSessionQueueContextId === queueContextId
        ) {
          try {
            response = await api.getPlaybackSession(
              player.playbackSessionId,
              controller.signal,
            );
          } catch (reason) {
            if (
              !(reason instanceof APIError) ||
              (reason.status !== 404 && reason.status !== 410)
            ) {
              throw reason;
            }
            player.clearPlaybackSession();
            response = await createSession();
          }
        } else {
          sessionSource = sourceForPlaybackSession(
            player.shuffleEnabled,
            continuationMatches?.source ?? null,
            player.shuffleExcludedExternalID,
          );
          response = await createSession();
        }
        if (controller.signal.aborted) return;
        attachSession(response, undefined, sessionSource);
      } catch (reason) {
        if (controller.signal.aborted) return;
        if (
          reason instanceof APIError &&
          reason.code !== "hls_backfill_incomplete" &&
          reason.status !== 404
        ) {
          // Playback must remain available while HLS is being rolled out or
          // during a short session API outage.
        }
        fallBackToProgressive();
      } finally {
        if (requestRef.current === controller) requestRef.current = null;
      }
    })();

    return () => controller.abort();
  }, [
    attachSession,
    changeDriver,
    currentItem?.queueId,
    fallBackToProgressive,
    queueContextId,
  ]);

  useEffect(() => {
    if (!session || !isPlaying) return;
    const timer = window.setInterval(() => {
      void refreshSession();
    }, SESSION_REFRESH_MS);
    const refreshVisibleSession = () => {
      if (document.visibilityState === "visible") {
        syncTimeline();
        void refreshSession();
      }
    };
    window.addEventListener("pageshow", refreshVisibleSession);
    document.addEventListener("visibilitychange", refreshVisibleSession);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pageshow", refreshVisibleSession);
      document.removeEventListener("visibilitychange", refreshVisibleSession);
    };
  }, [isPlaying, refreshSession, session, syncTimeline]);

  useEffect(
    () => () => {
      requestRef.current?.abort();
      const sessionID = sessionRef.current?.id;
      sessionRef.current = null;
      destroyHLS();
      if (
        sessionID &&
        typeof document !== "undefined" &&
        document.visibilityState === "visible"
      ) {
        void api.deletePlaybackSession(sessionID).catch(() => {
          // A browser reload keeps the resumable server session; ordinary
          // visible unmount/sign-out closes it eagerly.
        });
      }
    },
    [destroyHLS],
  );

  const seekLocal = useCallback(
    (localSeconds: number) => {
      const audio = audioRef.current;
      const activeSession = sessionRef.current;
      if (!audio || !activeSession) return false;
      const boundary = findPlaybackBoundary(activeSession.items, audio.currentTime);
      if (!boundary) return false;
      audio.currentTime = timelinePositionFor(boundary.item, localSeconds);
      syncTimeline(audio.currentTime);
      return true;
    },
    [audioRef, syncTimeline],
  );

  const nextTrack = useCallback(async () => {
    const audio = audioRef.current;
    let activeSession = sessionRef.current;
    if (!audio || !activeSession) return false;
    let items = sortedPlaybackItems(activeSession.items);
    let boundary = findPlaybackBoundary(items, audio.currentTime);
    if (!boundary) return false;
    if (boundary.index + 1 >= items.length && activeSession.has_more) {
      activeSession = (await refreshSession()) ?? activeSession;
      items = sortedPlaybackItems(activeSession.items);
      boundary = findPlaybackBoundary(items, audio.currentTime);
      if (!boundary) return false;
    }
    const next = items[boundary.index + 1];
    if (!next) return false;
    audio.currentTime = next.timeline_start_ms / 1000;
    syncTimeline(audio.currentTime);
    return true;
  }, [audioRef, refreshSession, syncTimeline]);

  const previousTrack = useCallback(() => {
    const audio = audioRef.current;
    const activeSession = sessionRef.current;
    if (!audio || !activeSession) return false;
    const items = sortedPlaybackItems(activeSession.items);
    const boundary = findPlaybackBoundary(items, audio.currentTime);
    if (!boundary) return false;
    const target =
      boundary.localSeconds > 3 || boundary.index === 0
        ? boundary.item
        : items[boundary.index - 1];
    audio.currentTime = target.timeline_start_ms / 1000;
    syncTimeline(audio.currentTime);
    return true;
  }, [audioRef, syncTimeline]);

  const handleMediaError = useCallback(() => {
    if (driverRef.current === "progressive") return false;
    if (driverRef.current === "hls-native" && hlsFallbackRef.current) {
      hlsFallbackRef.current();
      return true;
    }
    fallBackToProgressive();
    return true;
  }, [fallBackToProgressive]);

  const handleEnded = useCallback(() => {
    if (!sessionRef.current) return false;
    const player = usePlayerStore.getState();
    if (player.isPlaying) player.togglePlayback();
    return true;
  }, []);

  return {
    driver,
    session,
    isHLS: driver === "hls-native" || driver === "hls-js",
    blocksProgressive: driver !== "progressive",
    syncTimeline,
    seekLocal,
    nextTrack,
    previousTrack,
    handleMediaError,
    handleEnded,
  };
}
