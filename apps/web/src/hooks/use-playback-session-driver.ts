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

const SESSION_REFRESH_MS = 60_000;
const MAX_HLS_RECOVERY_ATTEMPTS = 4;
const HLS_RECOVERY_DELAYS_MS = [0, 1_000, 3_000, 8_000] as const;
const HLS_STALL_RECOVERY_DELAY_MS = 8_000;
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
  audio: Pick<HTMLAudioElement, "canPlayType">,
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
) {
  if (!/Android/i.test(userAgent) || /Firefox|FxiOS/i.test(userAgent)) {
    return false;
  }
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
  const [ready, setReady] = useState(true);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [session, setSession] = useState<PlaybackSession | null>(null);
  const driverRef = useRef<PlaybackDriver>("progressive");
  const sessionRef = useRef<PlaybackSession | null>(null);
  const contextRef = useRef<string | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const requestRef = useRef<AbortController | null>(null);
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
  const requestRecoveryRef = useRef<
    (message: string, stall?: boolean) => boolean
  >(() => false);
  const lastOrdinalRef = useRef<number | null>(null);
  const lastItemsSignatureRef = useRef<string | null>(null);

  const changeDriver = useCallback((next: PlaybackDriver) => {
    driverRef.current = next;
    setDriver(next);
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
    setReady(true);
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
    clearRecovery,
    destroyHLS,
    guardProgrammaticPause,
  ]);

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
      setReady(false);
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
          setReady(true);
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
      nativeProbeFallbackRef.current = null;
      nativePlayPromiseRef.current = false;
      setReady(false);
      setRecoveryRequired(false);
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
            setReady(false);
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
              setReady(true);
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
                setReady(false);
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
            setReady(false);
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
          setReady(true);
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
      clearNativeWaiters,
      clearRecovery,
      destroyHLS,
      fallBackToProgressive,
      guardProgrammaticPause,
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
    if (!session) return;
    const timer = isPlaying
      ? window.setInterval(() => {
          void refreshSession();
        }, SESSION_REFRESH_MS)
      : null;
    const refreshVisibleSession = () => {
      if (document.visibilityState === "visible") {
        syncTimeline();
        void refreshSession();
      }
    };
    window.addEventListener("pageshow", refreshVisibleSession);
    document.addEventListener("visibilitychange", refreshVisibleSession);
    return () => {
      if (timer !== null) window.clearInterval(timer);
      window.removeEventListener("pageshow", refreshVisibleSession);
      document.removeEventListener("visibilitychange", refreshVisibleSession);
    };
  }, [isPlaying, refreshSession, session, syncTimeline]);

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
    [clearRecovery, destroyHLS],
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
        setReady(true);
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
  }, [audioRef, clearRecovery, scheduleRecovery]);

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
    nativeProbeFallbackRef.current = null;
    setRecoveryRequired(false);
    setReady(true);
    return true;
  }, [clearRecovery, scheduleRecovery]);

  const handlePlaying = useCallback(() => {
    if (!sessionRef.current || driverRef.current === "progressive") return false;
    if (suppressPauseTimerRef.current !== null) {
      window.clearTimeout(suppressPauseTimerRef.current);
      suppressPauseTimerRef.current = null;
    }
    suppressPauseRef.current = false;
    clearRecovery();
    nativeProbeFallbackRef.current = null;
    setRecoveryRequired(false);
    setReady(true);
    return true;
  }, [clearRecovery]);

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
    return false;
  }, []);

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
