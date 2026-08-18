import type Hls from "hls.js";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { APIError, api } from "../lib/api";
import {
  createPlaybackSessionInput,
  findPlaybackBoundary,
  mergePlaybackSessionTimeline,
  playbackTimelineEnd,
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

const SESSION_REFRESH_MS = 60_000;
const MAX_HLS_RECOVERY_ATTEMPTS = 4;
const HLS_RECOVERY_DELAYS_MS = [0, 1_000, 3_000, 8_000] as const;
const HLS_STALL_RECOVERY_DELAY_MS = 8_000;
const HLS_TIMELINE_SYNC_MS = 500;
const HLS_TIMELINE_REFRESH_RETRY_MS = 2_000;
const HLS_PAUSE_RECONCILE_MS = 400;
const HLS_FOREGROUND_SYNC_DELAYS_MS = [0, 250, 1_000] as const;
const NATIVE_HLS_CANPLAY_TIMEOUT_MS = 12_000;
export const ANDROID_NATIVE_HLS_PROBE_TIMEOUT_MS = 8_000;
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

export function shouldUseNativeHLS(
  audio: Pick<HTMLAudioElement, "canPlayType">,
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
  maxTouchPoints =
    typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints,
) {
  if (
    !audio.canPlayType("application/vnd.apple.mpegurl") &&
    !audio.canPlayType("application/x-mpegURL")
  ) {
    return false;
  }

  // Every browser on iOS/iPadOS uses WebKit and must use the platform HLS
  // pipeline on versions before Managed Media Source became available. An
  // iPad requesting a desktop site identifies itself as Macintosh.
  const appleMobileWebKit =
    /iPad|iPhone|iPod/i.test(userAgent) ||
    (/Macintosh/i.test(userAgent) && maxTouchPoints > 1);
  if (appleMobileWebKit) return true;

  // Desktop Chromium can return "maybe" for HLS even when its native parser
  // cannot play the manifest. Keep native playback for actual Safari only;
  // Chrome, Edge, Firefox and Opera use the tested hls.js/MSE path.
  return (
    /AppleWebKit/i.test(userAgent) &&
    /Safari/i.test(userAgent) &&
    !/Chrome|Chromium|CriOS|Edg|EdgiOS|OPR|OPiOS|Firefox|FxiOS/i.test(
      userAgent,
    )
  );
}

export function shouldProbeNativeHLS(
  _audio: Pick<HTMLAudioElement, "canPlayType">,
  _userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
) {
  // Chromium on Android can advertise native HLS and reach `canplay`, yet
  // still treat an EVENT playlist as a live stream and jump to its final
  // item instead of honoring EXT-X-START. That makes the decoded song diverge
  // from audio.currentTime and the server timeline. Keep Android on hls.js;
  // only Apple WebKit uses the platform HLS pipeline.
  return false;
}

export function usePlaybackSessionDriver({
  audioRef,
  currentItem,
  queueContextId,
  isPlaying,
}: DriverInput) {
  const [driver, setDriver] = useState<PlaybackDriver>("progressive");
  const [ready, setReady] = useState(true);
  const readyRef = useRef(true);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [session, setSession] = useState<PlaybackSession | null>(null);
  const driverRef = useRef<PlaybackDriver>("progressive");
  const sessionRef = useRef<PlaybackSession | null>(null);
  const contextRef = useRef<string | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const refreshPromiseRef = useRef<Promise<PlaybackSession | null> | null>(
    null,
  );
  const refreshSessionIDRef = useRef<string | null>(null);
  const refreshSessionRef = useRef<() => Promise<PlaybackSession | null>>(
    async () => null,
  );
  const recoveryTimerRef = useRef<number | null>(null);
  const recoveryAttemptsRef = useRef(0);
  const recoveryPositionRef = useRef(0);
  const waitingForOnlineRef = useRef(false);
  const suppressPauseRef = useRef(false);
  const suppressPauseTimerRef = useRef<number | null>(null);
  const nativeMetadataHandlerRef = useRef<(() => void) | null>(null);
  const nativeCanPlayHandlerRef = useRef<(() => void) | null>(null);
  const nativeCanPlayTimerRef = useRef<number | null>(null);
  const nativeProbeFallbackRef = useRef<(() => void) | null>(null);
  const nativePlayPromiseRef = useRef(false);
  const pauseReconcileTimerRef = useRef<number | null>(null);
  const lastTimelineRefreshAtRef = useRef(0);
  const requestRecoveryRef = useRef<
    (message: string, stall?: boolean) => boolean
  >(() => false);
  const lastOrdinalRef = useRef<number | null>(null);
  const lastItemsSignatureRef = useRef<string | null>(null);

  const changeDriver = useCallback((next: PlaybackDriver) => {
    driverRef.current = next;
    setDriver(next);
  }, []);

  const changeReady = useCallback((next: boolean) => {
    readyRef.current = next;
    setReady(next);
  }, []);

  const clearNativeWaiters = useCallback(() => {
    const audio = audioRef.current;
    if (audio && nativeMetadataHandlerRef.current) {
      audio.removeEventListener(
        "loadedmetadata",
        nativeMetadataHandlerRef.current,
      );
    }
    if (audio && nativeCanPlayHandlerRef.current) {
      audio.removeEventListener("canplay", nativeCanPlayHandlerRef.current);
    }
    nativeMetadataHandlerRef.current = null;
    nativeCanPlayHandlerRef.current = null;
    if (nativeCanPlayTimerRef.current !== null) {
      window.clearTimeout(nativeCanPlayTimerRef.current);
      nativeCanPlayTimerRef.current = null;
    }
  }, [audioRef]);

  const clearRecovery = useCallback((resetAttempts = true) => {
    if (recoveryTimerRef.current !== null) {
      window.clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
    waitingForOnlineRef.current = false;
    if (resetAttempts) recoveryAttemptsRef.current = 0;
  }, []);

  const clearPauseReconcile = useCallback(() => {
    if (pauseReconcileTimerRef.current !== null) {
      window.clearTimeout(pauseReconcileTimerRef.current);
      pauseReconcileTimerRef.current = null;
    }
  }, []);

  const guardProgrammaticPause = useCallback(() => {
    suppressPauseRef.current = true;
    if (suppressPauseTimerRef.current !== null) {
      window.clearTimeout(suppressPauseTimerRef.current);
    }
    suppressPauseTimerRef.current = window.setTimeout(() => {
      suppressPauseTimerRef.current = null;
      suppressPauseRef.current = false;
    }, 1_500);
  }, []);

  const destroyHLS = useCallback(() => {
    clearNativeWaiters();
    hlsRef.current?.destroy();
    hlsRef.current = null;
  }, [clearNativeWaiters]);

  const fallBackToProgressive = useCallback(() => {
    const audio = audioRef.current;
    const sessionID = sessionRef.current?.id;
    guardProgrammaticPause();
    clearRecovery();
    destroyHLS();
    nativeProbeFallbackRef.current = null;
    nativePlayPromiseRef.current = false;
    clearPauseReconcile();
    sessionRef.current = null;
    setSession(null);
    contextRef.current = null;
    lastOrdinalRef.current = null;
    lastItemsSignatureRef.current = null;
    if (audio?.dataset.playbackSessionId) {
      audio.pause();
      audio.removeAttribute("src");
      delete audio.dataset.playbackSessionId;
      audio.load();
    }
    usePlayerStore.getState().clearPlaybackSession();
    changeReady(true);
    setRecoveryRequired(false);
    changeDriver("progressive");
    if (sessionID) {
      void api.deletePlaybackSession(sessionID).catch(() => {
        // Session expiry cleanup is also enforced server-side.
      });
    }
  }, [
    audioRef,
    changeDriver,
    changeReady,
    clearPauseReconcile,
    clearRecovery,
    destroyHLS,
    guardProgrammaticPause,
  ]);

  const syncTimeline = useCallback(
    (timelineSeconds?: number) => {
      const audio = audioRef.current;
      const activeSession = sessionRef.current;
      if (!audio || !activeSession) return null;
      if (
        timelineSeconds === undefined &&
        !readyRef.current &&
        (!Number.isFinite(audio.currentTime) || audio.currentTime <= 0.05)
      ) {
        return null;
      }
      const position =
        typeof timelineSeconds === "number" && Number.isFinite(timelineSeconds)
          ? timelineSeconds
          : audio.currentTime;
      if (
        activeSession.has_more &&
        position > playbackTimelineEnd(activeSession.items) + 0.25
      ) {
        const player = usePlayerStore.getState();
        if (Math.abs(player.playbackTimelineTime - position) > 0.25) {
          player.setPlaybackSession(
            activeSession.id,
            queueContextId,
            Math.max(0, position),
          );
        }
        const now = Date.now();
        if (
          now - lastTimelineRefreshAtRef.current >=
          HLS_TIMELINE_REFRESH_RETRY_MS
        ) {
          lastTimelineRefreshAtRef.current = now;
          void refreshSessionRef.current();
        }
        return null;
      }
      const boundary = findPlaybackBoundary(activeSession.items, position);
      if (!boundary) return null;

      const itemsSignature = `${activeSession.id}:${activeSession.revision}:${activeSession.items.length}`;
      const itemsChanged =
        lastOrdinalRef.current !== boundary.item.ordinal ||
        lastItemsSignatureRef.current !== itemsSignature;

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
      const items = itemsChanged
        ? sortedPlaybackItems(activeSession.items).map((item) => ({
            ordinal: item.ordinal,
            track: item.track,
          }))
        : undefined;
      player.syncPlaybackSessionTimeline({
        id: activeSession.id,
        queueContextId,
        timelineTime: position,
        currentOrdinal: boundary.item.ordinal,
        currentTime: boundary.localSeconds,
        duration: boundary.durationSeconds,
        bufferedTo: buffered,
        items,
      });
      if (itemsChanged) {
        lastOrdinalRef.current = boundary.item.ordinal;
        lastItemsSignatureRef.current = itemsSignature;
      }
      return boundary;
    },
    [audioRef, queueContextId],
  );

  const scheduleRecovery = useCallback(
    (message: string, stall = false) => {
      const audio = audioRef.current;
      const activeSession = sessionRef.current;
      if (
        !audio ||
        !activeSession ||
        driverRef.current === "progressive" ||
        !usePlayerStore.getState().isPlaying
      ) {
        return false;
      }

      if (Number.isFinite(audio.currentTime)) {
        recoveryPositionRef.current = Math.max(0, audio.currentTime);
        syncTimeline(recoveryPositionRef.current);
      }
      setRecoveryRequired(true);
      changeReady(false);
      usePlayerStore.getState().setPlaybackStatus("retrying", message);

      if (typeof navigator !== "undefined" && !navigator.onLine) {
        if (recoveryTimerRef.current !== null) {
          window.clearTimeout(recoveryTimerRef.current);
          recoveryTimerRef.current = null;
        }
        waitingForOnlineRef.current = true;
        usePlayerStore
          .getState()
          .setPlaybackStatus(
            "retrying",
            "You're offline. Playback will resume when the connection returns.",
          );
        return true;
      }

      waitingForOnlineRef.current = false;
      if (recoveryTimerRef.current !== null) return true;
      if (recoveryAttemptsRef.current >= MAX_HLS_RECOVERY_ATTEMPTS) {
        fallBackToProgressive();
        return true;
      }

      const delay = stall
        ? HLS_STALL_RECOVERY_DELAY_MS
        : HLS_RECOVERY_DELAYS_MS[recoveryAttemptsRef.current] ??
          HLS_RECOVERY_DELAYS_MS[HLS_RECOVERY_DELAYS_MS.length - 1];
      const sessionID = activeSession.id;
      recoveryTimerRef.current = window.setTimeout(() => {
        recoveryTimerRef.current = null;
        if (
          sessionRef.current?.id !== sessionID ||
          !usePlayerStore.getState().isPlaying
        ) {
          return;
        }
        if (typeof navigator !== "undefined" && !navigator.onLine) {
          requestRecoveryRef.current(message);
          return;
        }

        recoveryAttemptsRef.current += 1;
        usePlayerStore
          .getState()
          .setPlaybackStatus("retrying", "Reconnecting playback…");
        const position = recoveryPositionRef.current;
        if (driverRef.current === "hls-js") {
          guardProgrammaticPause();
          hlsRef.current?.startLoad(position);
          return;
        }
        if (driverRef.current !== "hls-native") return;

        clearNativeWaiters();
        guardProgrammaticPause();
        const onMetadata = () => {
          nativeMetadataHandlerRef.current = null;
          if (sessionRef.current?.id !== sessionID) return;
          audio.currentTime = position;
          syncTimeline(position);
        };
        const onCanPlay = () => {
          nativeCanPlayHandlerRef.current = null;
          if (sessionRef.current?.id !== sessionID) return;
          if (nativeCanPlayTimerRef.current !== null) {
            window.clearTimeout(nativeCanPlayTimerRef.current);
            nativeCanPlayTimerRef.current = null;
          }
          clearRecovery();
          setRecoveryRequired(false);
          changeReady(true);
        };
        nativeMetadataHandlerRef.current = onMetadata;
        nativeCanPlayHandlerRef.current = onCanPlay;
        audio.addEventListener("loadedmetadata", onMetadata, { once: true });
        audio.addEventListener("canplay", onCanPlay, { once: true });
        nativeCanPlayTimerRef.current = window.setTimeout(() => {
          nativeCanPlayTimerRef.current = null;
          if (sessionRef.current?.id === sessionID) {
            requestRecoveryRef.current(
              "Audio is taking longer than expected. Reconnecting playback…",
            );
          }
        }, NATIVE_HLS_CANPLAY_TIMEOUT_MS);
        audio.src = activeSession.manifest_url;
        audio.load();
      }, delay);
      return true;
    },
    [
      audioRef,
      clearNativeWaiters,
      clearRecovery,
      changeReady,
      fallBackToProgressive,
      guardProgrammaticPause,
      syncTimeline,
    ],
  );

  requestRecoveryRef.current = scheduleRecovery;

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

      clearRecovery();
      destroyHLS();
      clearPauseReconcile();
      nativeProbeFallbackRef.current = null;
      nativePlayPromiseRef.current = false;
      changeReady(false);
      setRecoveryRequired(false);
      const previousSessionID = sessionRef.current?.id;
      sessionRef.current = nextSession;
      setSession(nextSession);
      contextRef.current = queueContextId;
      lastOrdinalRef.current = null;
      lastItemsSignatureRef.current = null;
      lastTimelineRefreshAtRef.current = 0;
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
        player.syncPlaybackSessionTimeline({
          id: nextSession.id,
          queueContextId,
          timelineTime: desiredPosition,
          currentOrdinal: boundary.item.ordinal,
          currentTime: boundary.localSeconds,
          duration: boundary.durationSeconds,
          bufferedTo: 0,
          items: items.map((item) => ({
            ordinal: item.ordinal,
            track: item.track,
          })),
          source,
        });
        lastOrdinalRef.current = boundary.item.ordinal;
        lastItemsSignatureRef.current = `${nextSession.id}:${nextSession.revision}:${nextSession.items.length}`;
      }

      const seekWhenReady = (position = desiredPosition) => {
        if (sessionRef.current?.id !== nextSession.id) return;
        if (Number.isFinite(position)) audio.currentTime = position;
        syncTimeline(position);
      };

      audio.dataset.playbackSessionId = nextSession.id;
      delete audio.dataset.playbackActivation;
      delete audio.dataset.queueId;
      delete audio.dataset.streamUrl;
      delete audio.dataset.resolvedAt;
      guardProgrammaticPause();

      const attachJavaScriptHLS = (startPosition = desiredPosition) => {
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
            changeReady(false);
            const hls = new HLS({
              backBufferLength: 120,
              maxBufferLength: 600,
              maxMaxBufferLength: 600,
              enableWorker: true,
            });
            let fatalMediaRecoveries = 0;
            hlsRef.current = hls;
            hls.on(HLS.Events.MEDIA_ATTACHED, () => {
              hls.loadSource(nextSession.manifest_url);
            });
            hls.on(HLS.Events.MANIFEST_PARSED, () => {
              if (sessionRef.current?.id !== nextSession.id) return;
              seekWhenReady(startPosition);
            });
            hls.on(HLS.Events.FRAG_BUFFERED, () => {
              if (sessionRef.current?.id !== nextSession.id) return;
              fatalMediaRecoveries = 0;
              clearRecovery();
              setRecoveryRequired(false);
              changeReady(true);
            });
            hls.on(HLS.Events.ERROR, (_event, data) => {
              if (!data.fatal) return;
              if (data.type === HLS.ErrorTypes.NETWORK_ERROR) {
                requestRecoveryRef.current(
                  "Connection interrupted. Reconnecting playback…",
                );
                return;
              }
              if (data.type === HLS.ErrorTypes.MEDIA_ERROR) {
                fatalMediaRecoveries += 1;
                if (fatalMediaRecoveries > 1) {
                  fallBackToProgressive();
                  return;
                }
                recoveryPositionRef.current = Number.isFinite(audio.currentTime)
                  ? Math.max(0, audio.currentTime)
                  : recoveryPositionRef.current;
                syncTimeline(recoveryPositionRef.current);
                setRecoveryRequired(true);
                changeReady(false);
                usePlayerStore
                  .getState()
                  .setPlaybackStatus("retrying", "Recovering audio playback…");
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

      const nativeRequired = shouldUseNativeHLS(audio);
      const nativeProbe = !nativeRequired && shouldProbeNativeHLS(audio);
      if (nativeRequired || nativeProbe) {
        if (nativeProbe) {
          nativeProbeFallbackRef.current = () => {
            if (sessionRef.current?.id !== nextSession.id) return;
            nativeProbeFallbackRef.current = null;
            const livePosition = Number.isFinite(audio.currentTime)
              ? Math.max(0, audio.currentTime)
              : desiredPosition;
            clearNativeWaiters();
            guardProgrammaticPause();
            changeDriver("preparing");
            changeReady(false);
            audio.pause();
            audio.removeAttribute("src");
            audio.load();
            attachJavaScriptHLS(livePosition);
          };
        }
        changeDriver("hls-native");
        clearNativeWaiters();
        const onMetadata = () => {
          nativeMetadataHandlerRef.current = null;
          seekWhenReady();
        };
        const onCanPlay = () => {
          nativeCanPlayHandlerRef.current = null;
          if (sessionRef.current?.id !== nextSession.id) return;
          if (nativeCanPlayTimerRef.current !== null) {
            window.clearTimeout(nativeCanPlayTimerRef.current);
            nativeCanPlayTimerRef.current = null;
          }
          nativeProbeFallbackRef.current = null;
          clearRecovery();
          setRecoveryRequired(false);
          changeReady(true);
        };
        nativeMetadataHandlerRef.current = onMetadata;
        nativeCanPlayHandlerRef.current = onCanPlay;
        audio.addEventListener("loadedmetadata", onMetadata, { once: true });
        audio.addEventListener("canplay", onCanPlay, { once: true });
        nativeCanPlayTimerRef.current = window.setTimeout(() => {
          nativeCanPlayTimerRef.current = null;
          if (sessionRef.current?.id === nextSession.id) {
            if (nativeProbeFallbackRef.current) {
              nativeProbeFallbackRef.current();
            } else {
              requestRecoveryRef.current(
                "Audio is taking longer than expected. Reconnecting playback…",
              );
            }
          }
        }, nativeProbe
          ? ANDROID_NATIVE_HLS_PROBE_TIMEOUT_MS
          : NATIVE_HLS_CANPLAY_TIMEOUT_MS);
        audio.src = nextSession.manifest_url;
        audio.load();
        return;
      }

      attachJavaScriptHLS();
    },
    [
      audioRef,
      changeDriver,
      changeReady,
      clearNativeWaiters,
      clearPauseReconcile,
      clearRecovery,
      destroyHLS,
      fallBackToProgressive,
      guardProgrammaticPause,
      queueContextId,
      syncTimeline,
    ],
  );

  const refreshSession = useCallback(() => {
    const activeSession = sessionRef.current;
    if (!activeSession) return Promise.resolve(null);
    if (
      refreshPromiseRef.current &&
      refreshSessionIDRef.current === activeSession.id
    ) {
      return refreshPromiseRef.current;
    }
    const request = api
      .getPlaybackSession(activeSession.id)
      .then((incoming) => {
        const current = sessionRef.current;
        if (!current || current.id !== incoming.id) return null;
        const refreshed = mergePlaybackSessionTimeline(current, incoming);
        sessionRef.current = refreshed;
        setSession(refreshed);
        syncTimeline();
        return refreshed;
      })
      .catch(() => null)
      .finally(() => {
        if (refreshPromiseRef.current === request) {
          refreshPromiseRef.current = null;
          refreshSessionIDRef.current = null;
        }
      });
    refreshPromiseRef.current = request;
    refreshSessionIDRef.current = activeSession.id;
    return request;
  }, [syncTimeline]);

  refreshSessionRef.current = refreshSession;

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

  const sessionID = session?.id ?? null;

  useEffect(() => {
    if (!sessionID) return;
    const sessionRefreshTimer = isPlaying
      ? window.setInterval(() => {
          void refreshSession();
        }, SESSION_REFRESH_MS)
      : null;
    // Browsers may throttle this timer in the background, but when they do
    // keep JavaScript alive it also keeps Media Session metadata aligned with
    // native HLS. Foreground lifecycle bursts below cover a fully frozen page.
    const timelineSyncTimer = isPlaying
      ? window.setInterval(() => syncTimeline(), HLS_TIMELINE_SYNC_MS)
      : null;
    const foregroundTimers = new Set<number>();
    const reconcileVisibleSession = () => {
      if (document.visibilityState === "hidden") return;
      const expectedSessionID = sessionRef.current?.id;
      void refreshSession();
      for (const delay of HLS_FOREGROUND_SYNC_DELAYS_MS) {
        const timer = window.setTimeout(() => {
          foregroundTimers.delete(timer);
          if (
            document.visibilityState !== "hidden" &&
            sessionRef.current?.id === expectedSessionID
          ) {
            syncTimeline();
            if (
              delay ===
                HLS_FOREGROUND_SYNC_DELAYS_MS[
                  HLS_FOREGROUND_SYNC_DELAYS_MS.length - 1
                ] &&
              audioRef.current?.paused &&
              usePlayerStore.getState().isPlaying
            ) {
              scheduleRecovery(
                "Playback was interrupted. Resuming playback…",
              );
            }
          }
        }, delay);
        foregroundTimers.add(timer);
      }
    };
    const reconcileWhenVisible = () => {
      if (document.visibilityState !== "hidden") reconcileVisibleSession();
    };
    window.addEventListener("focus", reconcileVisibleSession);
    window.addEventListener("pageshow", reconcileVisibleSession);
    document.addEventListener("visibilitychange", reconcileWhenVisible);
    return () => {
      if (sessionRefreshTimer !== null) {
        window.clearInterval(sessionRefreshTimer);
      }
      if (timelineSyncTimer !== null) window.clearInterval(timelineSyncTimer);
      for (const timer of foregroundTimers) window.clearTimeout(timer);
      window.removeEventListener("focus", reconcileVisibleSession);
      window.removeEventListener("pageshow", reconcileVisibleSession);
      document.removeEventListener("visibilitychange", reconcileWhenVisible);
    };
  }, [
    audioRef,
    isPlaying,
    refreshSession,
    scheduleRecovery,
    sessionID,
    syncTimeline,
  ]);

  useEffect(() => {
    const resumeWhenOnline = () => {
      if (
        !waitingForOnlineRef.current ||
        !sessionRef.current ||
        !usePlayerStore.getState().isPlaying
      ) {
        return;
      }
      waitingForOnlineRef.current = false;
      scheduleRecovery("Back online. Reconnecting playback…");
    };
    window.addEventListener("online", resumeWhenOnline);
    return () => window.removeEventListener("online", resumeWhenOnline);
  }, [scheduleRecovery]);

  useEffect(() => {
    if (!isPlaying) clearRecovery();
  }, [clearRecovery, isPlaying]);

  useEffect(
    () => () => {
      requestRef.current?.abort();
      const sessionID = sessionRef.current?.id;
      sessionRef.current = null;
      nativeProbeFallbackRef.current = null;
      nativePlayPromiseRef.current = false;
      clearPauseReconcile();
      clearRecovery();
      destroyHLS();
      if (suppressPauseTimerRef.current !== null) {
        window.clearTimeout(suppressPauseTimerRef.current);
        suppressPauseTimerRef.current = null;
      }
      suppressPauseRef.current = false;
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
    [clearPauseReconcile, clearRecovery, destroyHLS],
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

  const requestNativePlay = useCallback(() => {
    const audio = audioRef.current;
    const activeSession = sessionRef.current;
    if (
      !audio ||
      !activeSession ||
      driverRef.current !== "hls-native" ||
      audio.dataset.playbackSessionId !== activeSession.id
    ) {
      return false;
    }
    if (nativePlayPromiseRef.current) return true;

    const sessionID = activeSession.id;
    nativePlayPromiseRef.current = true;
    void audio.play()
      .then(() => {
        nativePlayPromiseRef.current = false;
        if (
          sessionRef.current?.id !== sessionID ||
          !usePlayerStore.getState().isPlaying
        ) {
          return;
        }
        clearRecovery();
        setRecoveryRequired(false);
        changeReady(true);
        usePlayerStore.getState().setPlaybackStatus("playing");
      })
      .catch((reason: unknown) => {
        nativePlayPromiseRef.current = false;
        if (sessionRef.current?.id !== sessionID) return;
        if (reason instanceof DOMException && reason.name === "AbortError") {
          return;
        }
        if (reason instanceof DOMException && reason.name === "NotAllowedError") {
          clearRecovery();
          usePlayerStore
            .getState()
            .setPlaybackStatus("paused", "Tap play to continue");
          return;
        }
        scheduleRecovery("Connection lost during playback");
      });
    return true;
  }, [audioRef, changeReady, clearRecovery, scheduleRecovery]);

  const handleMediaError = useCallback(() => {
    if (driverRef.current === "progressive") return false;
    if (driverRef.current === "preparing") return true;
    if (nativeProbeFallbackRef.current) {
      nativeProbeFallbackRef.current();
      return true;
    }
    return scheduleRecovery("Unable to load audio. Reconnecting playback…");
  }, [scheduleRecovery]);

  const handlePlaybackFailure = useCallback(
    (message: string) => scheduleRecovery(message),
    [scheduleRecovery],
  );

  const handleBuffering = useCallback(
    (message: string) => scheduleRecovery(message, true),
    [scheduleRecovery],
  );

  const handleCanPlay = useCallback(() => {
    if (!sessionRef.current || driverRef.current === "progressive") return false;
    if (
      typeof navigator !== "undefined" &&
      !navigator.onLine &&
      usePlayerStore.getState().isPlaying
    ) {
      scheduleRecovery("You're offline. Waiting for the connection…");
      return true;
    }
    clearRecovery();
    changeReady(true);
    syncTimeline();
    nativeProbeFallbackRef.current = null;
    setRecoveryRequired(false);
    return true;
  }, [changeReady, clearRecovery, scheduleRecovery, syncTimeline]);

  const handlePlaying = useCallback(() => {
    if (!sessionRef.current || driverRef.current === "progressive") return false;
    clearPauseReconcile();
    if (!usePlayerStore.getState().isPlaying) return true;
    if (suppressPauseTimerRef.current !== null) {
      window.clearTimeout(suppressPauseTimerRef.current);
      suppressPauseTimerRef.current = null;
    }
    suppressPauseRef.current = false;
    clearRecovery();
    changeReady(true);
    syncTimeline();
    nativeProbeFallbackRef.current = null;
    setRecoveryRequired(false);
    usePlayerStore.getState().setPlaybackStatus("playing");
    return true;
  }, [changeReady, clearPauseReconcile, clearRecovery, syncTimeline]);

  const handlePause = useCallback(() => {
    if (!sessionRef.current || driverRef.current === "progressive") return false;
    const player = usePlayerStore.getState();
    if (
      player.isPlaying &&
      (suppressPauseRef.current ||
        recoveryTimerRef.current !== null ||
        waitingForOnlineRef.current)
    ) {
      player.setPlaybackStatus(
        "retrying",
        waitingForOnlineRef.current
          ? "You're offline. Playback will resume when the connection returns."
          : "Reconnecting playback…",
      );
      return true;
    }
    if (!player.isPlaying) {
      clearPauseReconcile();
      return false;
    }
    clearPauseReconcile();
    pauseReconcileTimerRef.current = window.setTimeout(() => {
      pauseReconcileTimerRef.current = null;
      const audio = audioRef.current;
      const current = usePlayerStore.getState();
      if (
        sessionRef.current &&
        driverRef.current !== "progressive" &&
        current.isPlaying &&
        audio?.paused
      ) {
        syncTimeline();
        if (
          suppressPauseRef.current ||
          recoveryTimerRef.current !== null ||
          waitingForOnlineRef.current ||
          document.visibilityState === "hidden"
        ) {
          current.setPlaybackStatus(
            "retrying",
            waitingForOnlineRef.current
              ? "You're offline. Playback will resume when the connection returns."
              : "Playback was interrupted. Waiting to resume…",
          );
          return;
        }
        scheduleRecovery(
          "Playback was interrupted. Reconnecting playback…",
          true,
        );
      }
    }, HLS_PAUSE_RECONCILE_MS);
    return true;
  }, [audioRef, clearPauseReconcile, scheduleRecovery, syncTimeline]);

  const handleEnded = useCallback(() => {
    if (!sessionRef.current) return false;
    const player = usePlayerStore.getState();
    if (player.isPlaying) player.togglePlayback();
    return true;
  }, []);

  return {
    driver,
    ready,
    recoveryRequired,
    session,
    isHLS: driver === "hls-native" || driver === "hls-js",
    blocksProgressive: driver === "hls-native" || driver === "hls-js",
    syncTimeline,
    seekLocal,
    nextTrack,
    previousTrack,
    requestNativePlay,
    handleMediaError,
    handlePlaybackFailure,
    handleBuffering,
    handleCanPlay,
    handlePlaying,
    handlePause,
    handleEnded,
  };
}
