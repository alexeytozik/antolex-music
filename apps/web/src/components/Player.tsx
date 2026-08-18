import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  ChevronDownIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PreviousIcon,
  ShuffleIcon,
  SpinnerIcon,
  VolumeIcon,
  VolumeOffIcon,
} from "./Icons";
import { api } from "../lib/api";
import { formatDuration } from "../lib/format";
import { registerPlaybackActivationHandler } from "../lib/playback-activation";
import { usePlaybackSessionDriver } from "../hooks/use-playback-session-driver";
import {
  classifyMediaError,
  isAbortError,
  isRetryablePlaybackRequestError,
  nextPlaybackRetry,
  playbackErrorMessage,
} from "../lib/playback-recovery";
import {
  isQueueItemStreamFresh,
  selectCurrentItem,
  selectHasNext,
  selectHasPrevious,
  usePlayerStore,
} from "../store/player-store";
import { useQueueContinuationStore } from "../store/queue-continuation-store";

const SILENT_PLAYBACK_ACTIVATION_SOURCE =
  "data:audio/wav;base64,UklGRtYBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgATElTVBoAAABJTkZPSVNGVA4AAABMYXZmNjIuMTIuMTAyAGRhdGGQAQAAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

function bufferedTo(audio: HTMLAudioElement) {
  return audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0;
}

type PlaybackRecovery = {
  queueId: string;
  externalId: string;
  attempts: number;
  position: number;
  message: string;
};

export function Player() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackActivatedRef = useRef(false);
  const retryTimerRef = useRef<number | null>(null);
  const onlineHandlerRef = useRef<(() => void) | null>(null);
  const resolveAbortRef = useRef<AbortController | null>(null);
  const recoveryRef = useRef<PlaybackRecovery | null>(null);
  const mountedRef = useRef(false);
  const lastPositionRef = useRef(0);
  const expandedOpenerRef = useRef<HTMLElement | null>(null);
  const fullPlayRef = useRef<HTMLButtonElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const currentItem = usePlayerStore(selectCurrentItem);
  const hasPlayerNext = usePlayerStore(selectHasNext);
  const playerQueueContextId = usePlayerStore((state) => state.queueContextId);
  const hasContinuationNext = useQueueContinuationStore(
    (continuation) =>
      continuation.source !== null &&
      continuation.source.kind !== "shuffle" &&
      continuation.queueContextId === playerQueueContextId &&
      continuation.hasMore &&
      Boolean(continuation.cursor),
  );
  const progressiveHasNext = hasPlayerNext || hasContinuationNext;
  const progressiveHasPrevious = usePlayerStore(selectHasPrevious);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const status = usePlayerStore((state) => state.status);
  const queueLength = usePlayerStore((state) => state.queue.length);
  const currentIndex = usePlayerStore((state) => state.currentIndex);
  const currentTime = usePlayerStore((state) => state.currentTime);
  const duration = usePlayerStore((state) => state.duration);
  const bufferedUntil = usePlayerStore((state) => state.bufferedTo);
  const volume = usePlayerStore((state) => state.volume);
  const muted = usePlayerStore((state) => state.muted);
  const shuffle = usePlayerStore((state) => state.shuffleEnabled);
  const seekTarget = usePlayerStore((state) => state.seekTarget);
  const error = usePlayerStore((state) => state.error);
  const togglePlayback = usePlayerStore((state) => state.togglePlayback);
  const next = usePlayerStore((state) => state.next);
  const previous = usePlayerStore((state) => state.previous);
  const seek = usePlayerStore((state) => state.seek);
  const clearSeekRequest = usePlayerStore((state) => state.clearSeekRequest);
  const setVolume = usePlayerStore((state) => state.setVolume);
  const setMuted = usePlayerStore((state) => state.setMuted);
  const setShuffle = usePlayerStore((state) => state.setShuffleEnabled);
  const prefetchShuffle = usePlayerStore((state) => state.prefetchShuffle);
  const hydrateResolvedTrack = usePlayerStore((state) => state.hydrateResolvedTrack);
  const setPlaybackStatus = usePlayerStore((state) => state.setPlaybackStatus);
  const setProgress = usePlayerStore((state) => state.setPlaybackProgress);
  const trackEnded = usePlayerStore((state) => state.handleTrackEnded);
  const playbackError = usePlayerStore((state) => state.handlePlaybackError);

  const sessionDriver = usePlaybackSessionDriver({
    audioRef,
    currentItem,
    queueContextId: playerQueueContextId,
    isPlaying,
  });

  useLayoutEffect(
    () =>
      registerPlaybackActivationHandler((externalID) => {
        const audio = audioRef.current;
        if (!audio) return;

        const player = usePlayerStore.getState();
        const item = selectCurrentItem(player);
        const belongsToRequestedTrack =
          item?.track.external_id === externalID &&
          (audio.dataset.queueId === item.queueId ||
            (Boolean(player.playbackSessionId) &&
              audio.dataset.playbackSessionId === player.playbackSessionId));

        if (belongsToRequestedTrack && audio.getAttribute("src")) {
          playbackActivatedRef.current = true;
          void audio.play().catch(() => {
            // The regular player path reports a useful error after the store
            // receives the same play intent.
          });
          return;
        }
        if (playbackActivatedRef.current) return;

        audio.dataset.playbackActivation = externalID;
        delete audio.dataset.queueId;
        delete audio.dataset.playbackSessionId;
        delete audio.dataset.streamUrl;
        delete audio.dataset.resolvedAt;
        audio.src = SILENT_PLAYBACK_ACTIVATION_SOURCE;
        audio.load();
        playbackActivatedRef.current = true;
        void audio.play().catch(() => {
          if (audio.dataset.playbackActivation === externalID) {
            playbackActivatedRef.current = false;
          }
        });
      }),
    [],
  );
  const hasNext = sessionDriver.isHLS
    ? Boolean(
        sessionDriver.session?.has_more || currentIndex + 1 < queueLength,
      )
    : progressiveHasNext;
  const hasPrevious = sessionDriver.isHLS
    ? currentTime > 3 || currentIndex > 0
    : progressiveHasPrevious;

  const track = useMemo(() => currentItem ? {
    ...currentItem.track,
    stream_url: isQueueItemStreamFresh(currentItem)
      ? currentItem.resolvedStreamUrl ?? currentItem.track.stream_url
      : undefined,
  } : null, [currentItem]);
  const displayDuration = duration || track?.duration_seconds || 0;
  const progress = displayDuration ? Math.min(currentTime, displayDuration) : 0;
  const progressPercent = displayDuration ? Math.min((progress / displayDuration) * 100, 100) : 0;
  const bufferedPercent = displayDuration ? Math.min((bufferedUntil / displayDuration) * 100, 100) : 0;
  function clearRetryWaiters() {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (onlineHandlerRef.current) {
      window.removeEventListener("online", onlineHandlerRef.current);
      onlineHandlerRef.current = null;
    }
  }

  function cancelRecovery() {
    clearRetryWaiters();
    resolveAbortRef.current?.abort();
    resolveAbortRef.current = null;
    recoveryRef.current = null;
  }

  function openExpandedPlayer() {
    expandedOpenerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setExpanded(true);
  }

  function closeExpandedPlayer() {
    setExpanded(false);
    window.requestAnimationFrame(() => expandedOpenerRef.current?.focus());
  }

  function isCurrentRecovery(recovery: PlaybackRecovery) {
    const liveItem = selectCurrentItem(usePlayerStore.getState());
    return (
      mountedRef.current &&
      liveItem?.queueId === recovery.queueId
    );
  }

  function hasPlaybackIntent() {
    return usePlayerStore.getState().isPlaying;
  }

  function finishRecovery(message: string) {
    cancelRecovery();
    playbackError(message);
  }

  function waitUntilOnline(recovery: PlaybackRecovery) {
    clearRetryWaiters();
    setPlaybackStatus("retrying");

    const resume = () => {
      if (onlineHandlerRef.current === resume) {
        window.removeEventListener("online", resume);
        onlineHandlerRef.current = null;
      }
      if (!isCurrentRecovery(recovery) || !hasPlaybackIntent()) return;
      scheduleRecovery(recovery, true);
    };

    onlineHandlerRef.current = resume;
    window.addEventListener("online", resume);
    // Avoid missing an online event that raced with listener registration.
    if (navigator.onLine !== false) window.queueMicrotask(resume);
  }

  function scheduleRecovery(recovery: PlaybackRecovery, immediate = false) {
    if (!isCurrentRecovery(recovery) || !hasPlaybackIntent()) {
      cancelRecovery();
      return;
    }

    clearRetryWaiters();
    recoveryRef.current = recovery;
    setPlaybackStatus("retrying");

    if (navigator.onLine === false) {
      waitUntilOnline(recovery);
      return;
    }

    const nextRetry = nextPlaybackRetry(recovery.attempts);
    const delay = immediate ? 0 : nextRetry.delay;
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      if (!isCurrentRecovery(recovery) || !hasPlaybackIntent()) return;
      if (navigator.onLine === false) {
        waitUntilOnline(recovery);
        return;
      }

      recovery.attempts = nextRetry.attempt;
      void requestFreshStream(recovery, true);
    }, delay);
  }

  async function requestFreshStream(
    recovery: PlaybackRecovery,
    isRecoveryAttempt: boolean,
  ) {
    if (
      resolveAbortRef.current ||
      !isCurrentRecovery(recovery) ||
      !hasPlaybackIntent()
    ) {
      return;
    }

    setPlaybackStatus(isRecoveryAttempt ? "retrying" : "resolving");
    const controller = new AbortController();
    resolveAbortRef.current = controller;

    try {
      const resolvedTrack = await api.resolveTrack(
        recovery.externalId,
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        !isCurrentRecovery(recovery) ||
        !hasPlaybackIntent()
      ) {
        return;
      }
      if (!resolvedTrack.stream_url) {
        throw new Error("Resolved track is missing a stream URL");
      }

      hydrateResolvedTrack(recovery.queueId, resolvedTrack);
      if (recovery.position > 0) seek(recovery.position);
    } catch (reason) {
      if (isAbortError(reason) || !isCurrentRecovery(recovery)) return;

      if (isRetryablePlaybackRequestError(reason)) {
        const activeRecovery =
          recoveryRef.current?.queueId === recovery.queueId
            ? recoveryRef.current
            : recovery;
        activeRecovery.message = playbackErrorMessage(
          reason,
          "Connection lost while loading this track",
        );
        recoveryRef.current = activeRecovery;
        scheduleRecovery(activeRecovery);
        return;
      }

      finishRecovery(
        playbackErrorMessage(reason, "Could not load this track"),
      );
    } finally {
      if (resolveAbortRef.current === controller) {
        resolveAbortRef.current = null;
      }
    }
  }

  function beginNetworkRecovery(message: string) {
    const item = selectCurrentItem(usePlayerStore.getState());
    const audio = audioRef.current;
    if (!item || !hasPlaybackIntent()) return;
    if (audio?.dataset.queueId && audio.dataset.queueId !== item.queueId) return;

    const audioPosition = audio?.currentTime;
    const position =
      typeof audioPosition === "number" && Number.isFinite(audioPosition)
        ? audioPosition
        : Math.max(lastPositionRef.current, usePlayerStore.getState().currentTime);
    const recovery =
      recoveryRef.current?.queueId === item.queueId
        ? recoveryRef.current
        : {
            queueId: item.queueId,
            externalId: item.track.external_id,
            attempts: 0,
            position,
            message,
          };

    recovery.position = position;
    recovery.message = message;
    recoveryRef.current = recovery;
    resolveAbortRef.current?.abort();
    resolveAbortRef.current = null;
    if (position > 0) seek(position);
    scheduleRecovery(recovery);
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelRecovery();
    };
  }, []);

  useEffect(() => {
    lastPositionRef.current = currentTime;
    return () => cancelRecovery();
  }, [currentItem?.queueId]);

  useEffect(() => {
    if (isPlaying) return;
    if (recoveryRef.current || resolveAbortRef.current) {
      cancelRecovery();
    }
  }, [isPlaying]);

  useEffect(() => {
    if (sessionDriver.isHLS) return;
    if (!shuffle || currentIndex < 0 || queueLength - currentIndex > 3) return;
    void prefetchShuffle();
    const resumeShuffle = () => { void prefetchShuffle(); };
    window.addEventListener("online", resumeShuffle);
    return () => window.removeEventListener("online", resumeShuffle);
  }, [currentIndex, prefetchShuffle, queueLength, sessionDriver.isHLS, shuffle]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) { audio.volume = volume; audio.muted = muted; }
  }, [muted, volume]);

  useEffect(() => {
    if (!expanded) return;
    fullPlayRef.current?.focus();
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeExpandedPlayer();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [expanded]);

  useEffect(() => {
    if (sessionDriver.blocksProgressive) return;
    if (!currentItem || currentItem.resolveStatus === "loading") return;
    if (isQueueItemStreamFresh(currentItem) && currentItem.resolveStatus === "ready") return;
    if (!isPlaying || recoveryRef.current || resolveAbortRef.current) return;

    void requestFreshStream(
      {
        queueId: currentItem.queueId,
        externalId: currentItem.track.external_id,
        attempts: 0,
        position: currentTime,
        message: "Connection lost while loading this track",
      },
      status === "retrying",
    );
  }, [
    currentItem,
    currentTime,
    isPlaying,
    sessionDriver.blocksProgressive,
    status,
  ]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (sessionDriver.blocksProgressive) return;
    if (!currentItem || !track?.stream_url) {
      audio.pause();
      if (!currentItem) {
        audio.removeAttribute("src");
        delete audio.dataset.queueId;
        delete audio.dataset.streamUrl;
        delete audio.dataset.resolvedAt;
        audio.load();
      }
      return;
    }
    const resolvedAt = String(currentItem.resolvedAt ?? "");
    if (
      audio.dataset.queueId !== currentItem.queueId ||
      audio.dataset.streamUrl !== track.stream_url ||
      audio.dataset.resolvedAt !== resolvedAt
    ) {
      audio.dataset.queueId = currentItem.queueId;
      audio.dataset.streamUrl = track.stream_url;
      audio.dataset.resolvedAt = resolvedAt;
      delete audio.dataset.playbackActivation;
      audio.src = track.stream_url;
      audio.load();
    }
  }, [currentItem, sessionDriver.blocksProgressive, track?.stream_url]);

  useEffect(() => {
    const audio = audioRef.current;
    const hlsSessionID = sessionDriver.session?.id;
    if (
      sessionDriver.blocksProgressive &&
      (!sessionDriver.isHLS || !sessionDriver.ready)
    ) {
      if (isPlaying && sessionDriver.recoveryRequired) {
        sessionDriver.handlePlaybackFailure("Reconnecting playback…");
      } else if (isPlaying) {
        sessionDriver.requestNativePlay();
      }
      return;
    }
    if (!sessionDriver.isHLS && audio?.dataset.playbackSessionId) {
      return;
    }
    if (
      !audio ||
      (sessionDriver.isHLS
        ? !hlsSessionID || audio.dataset.playbackSessionId !== hlsSessionID
        : !track?.stream_url)
    ) {
      return;
    }
    const requestedQueueId = currentItem?.queueId;
    if (isPlaying) {
      void audio.play().then(() => {
        const player = usePlayerStore.getState();
        if (
          (sessionDriver.isHLS
            ? audio.dataset.playbackSessionId !== hlsSessionID
            : selectCurrentItem(player)?.queueId !== requestedQueueId) ||
          !player.isPlaying
        ) {
          return;
        }
        setPlaybackStatus("playing");
      }).catch((reason) => {
        const player = usePlayerStore.getState();
        if (
          (sessionDriver.isHLS
            ? audio.dataset.playbackSessionId !== hlsSessionID
            : selectCurrentItem(player)?.queueId !== requestedQueueId) ||
          !player.isPlaying ||
          isAbortError(reason)
        ) {
          return;
        }
        if (reason instanceof DOMException && reason.name === "NotAllowedError") {
          cancelRecovery();
          setPlaybackStatus("paused", "Tap play to continue");
          return;
        }
        if (sessionDriver.isHLS && isRetryablePlaybackRequestError(reason)) {
          sessionDriver.handlePlaybackFailure(
            playbackErrorMessage(reason, "Connection lost during playback"),
          );
          return;
        }
        if (isRetryablePlaybackRequestError(reason)) {
          beginNetworkRecovery(
            playbackErrorMessage(reason, "Connection lost during playback"),
          );
          return;
        }
        finishRecovery(playbackErrorMessage(reason, "Unable to play this track"));
      });
    } else {
      audio.pause();
      setPlaybackStatus("paused");
    }
  }, [
    currentItem?.queueId,
    currentItem?.resolvedAt,
    isPlaying,
    sessionDriver.blocksProgressive,
    sessionDriver.handlePlaybackFailure,
    sessionDriver.isHLS,
    sessionDriver.ready,
    sessionDriver.recoveryRequired,
    sessionDriver.requestNativePlay,
    sessionDriver.session?.id,
    setPlaybackStatus,
    track?.stream_url,
  ]);

  useEffect(() => {
    const audio = audioRef.current;
    if (sessionDriver.isHLS) return;
    if (!audio || seekTarget === null || audio.readyState < 1) return;
    audio.currentTime = Math.min(seekTarget, Number.isFinite(audio.duration) ? audio.duration : seekTarget);
    clearSeekRequest();
  }, [clearSeekRequest, seekTarget, sessionDriver.isHLS, status]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !track) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album ?? "ANTOLEX Music",
      artwork: track.cover_url ? [{ src: track.cover_url }] : undefined,
    });
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ["play", () => {
        if (!usePlayerStore.getState().isPlaying) {
          togglePlayback();
          if (!sessionDriver.recoveryRequired) {
            sessionDriver.requestNativePlay();
          }
        } else if (audioRef.current?.paused && sessionDriver.isHLS) {
          sessionDriver.handlePlaybackFailure("Reconnecting playback…");
        }
      }],
      ["pause", () => { if (usePlayerStore.getState().isPlaying) togglePlayback(); }],
      ["previoustrack", () => { previousTrack(); }],
      ["nexttrack", () => { void nextTrack(); }],
      ["seekto", (details) => { if (typeof details.seekTime === "number") seekTrack(details.seekTime); }],
      ["seekbackward", (details) => seekTrack(Math.max(0, usePlayerStore.getState().currentTime - (details.seekOffset ?? 10)))],
      ["seekforward", (details) => seekTrack(Math.min(usePlayerStore.getState().duration, usePlayerStore.getState().currentTime + (details.seekOffset ?? 10)))],
    ];
    handlers.forEach(([action, handler]) => { try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* Unsupported action. */ } });
    return () => handlers.forEach(([action]) => { try { navigator.mediaSession.setActionHandler(action, null); } catch { /* Unsupported action. */ } });
  }, [sessionDriver.handlePlaybackFailure, sessionDriver.isHLS, sessionDriver.recoveryRequired, sessionDriver.requestNativePlay, togglePlayback, track]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState =
      isPlaying && status === "playing" ? "playing" : "paused";
    if (displayDuration > 0 && Number.isFinite(displayDuration) && currentTime <= displayDuration) {
      try { navigator.mediaSession.setPositionState({ duration: displayDuration, playbackRate: 1, position: Math.max(0, currentTime) }); } catch { /* Metadata may not be ready yet. */ }
    }
  }, [currentTime, displayDuration, isPlaying, status]);

  function updateProgress() {
    if (audioRef.current?.dataset.playbackActivation) return;
    if (sessionDriver.isHLS) {
      sessionDriver.syncTimeline();
      return;
    }
    const audio = audioRef.current;
    const item = selectCurrentItem(usePlayerStore.getState());
    if (!audio || !item || audio.dataset.queueId !== item.queueId) return;
    if (Number.isFinite(audio.currentTime)) {
      lastPositionRef.current = audio.currentTime;
    }
    setProgress(audio.currentTime, Number.isFinite(audio.duration) ? audio.duration : track?.duration_seconds ?? 0, bufferedTo(audio));
  }
  function loaded() {
    const audio = audioRef.current;
    if (audio?.dataset.playbackActivation) return;
    if (sessionDriver.isHLS) {
      // Native HLS briefly reports 0 while it attaches the manifest. The
      // driver restores the aggregate position from its metadata listener;
      // do not overwrite that saved position with this transitional value.
      if (sessionDriver.ready) sessionDriver.syncTimeline();
      return;
    }
    const item = selectCurrentItem(usePlayerStore.getState());
    if (!audio || !item || audio.dataset.queueId !== item.queueId) return;
    if (seekTarget !== null) { audio.currentTime = Math.min(seekTarget, audio.duration); clearSeekRequest(); }
    updateProgress();
  }
  function onPlaying() {
    const audio = audioRef.current;
    if (audio?.dataset.playbackActivation) {
      playbackActivatedRef.current = true;
      return;
    }
    const player = usePlayerStore.getState();
    const item = selectCurrentItem(player);
    if (!audio || !item) return;
    if (
      sessionDriver.isHLS
        ? audio.dataset.playbackSessionId !== sessionDriver.session?.id
        : audio.dataset.queueId !== item.queueId
    ) {
      return;
    }
    sessionDriver.handlePlaying();
    if (!usePlayerStore.getState().isPlaying) {
      audio.pause();
      return;
    }
    cancelRecovery();
    setPlaybackStatus("playing");
  }
  function onPause() {
    if (audioRef.current?.dataset.playbackActivation) return;
    if (sessionDriver.handlePause()) return;
    const audio = audioRef.current;
    const player = usePlayerStore.getState();
    const item = selectCurrentItem(player);
    if (!audio || !item) return;
    // Assigning a new progressive source emits `pause` while the element is
    // empty. That is a source transition, not a user or system pause.
    if (!sessionDriver.isHLS && audio.readyState === HTMLMediaElement.HAVE_NOTHING) {
      return;
    }
    const belongsToCurrentSource = sessionDriver.isHLS
      ? audio.dataset.playbackSessionId === sessionDriver.session?.id
      : audio.dataset.queueId === item.queueId;
    if (belongsToCurrentSource && player.isPlaying) {
      setPlaybackStatus("paused");
    }
  }
  function onWaiting() {
    if (audioRef.current?.dataset.playbackActivation) return;
    sessionDriver.handleBuffering("Buffering audio…");
  }
  function onStalled() {
    if (audioRef.current?.dataset.playbackActivation) return;
    sessionDriver.handleBuffering(
      "The connection was interrupted. Reconnecting playback…",
    );
  }
  function onCanPlay() {
    if (audioRef.current?.dataset.playbackActivation) return;
    sessionDriver.handleCanPlay();
  }
  function onError() {
    if (audioRef.current?.dataset.playbackActivation) return;
    if (sessionDriver.handleMediaError()) return;
    const audio = audioRef.current;
    const item = selectCurrentItem(usePlayerStore.getState());
    if (!audio || !item || audio.dataset.queueId !== item.queueId) return;

    const message = audio.error?.message || "Unable to play this track";
    const decision = classifyMediaError(audio.error);
    if (decision === "ignore") return;
    if (decision === "retry") {
      beginNetworkRecovery(message);
      return;
    }
    finishRecovery(message);
  }
  function onEnded() {
    if (audioRef.current?.dataset.playbackActivation) return;
    if (sessionDriver.handleEnded()) return;
    const audio = audioRef.current;
    const player = usePlayerStore.getState();
    const item = selectCurrentItem(player);
    if (
      !audio ||
      !item ||
      audio.dataset.queueId !== item.queueId ||
      !player.isPlaying
    ) {
      return;
    }
    trackEnded();
  }
  function seekTrack(seconds: number) {
    if (sessionDriver.isHLS) {
      sessionDriver.seekLocal(seconds);
      return;
    }
    seek(seconds);
  }
  async function nextTrack() {
    if (sessionDriver.isHLS) {
      await sessionDriver.nextTrack();
      return;
    }
    await next();
  }
  function previousTrack() {
    if (sessionDriver.isHLS) {
      sessionDriver.previousTrack();
      return;
    }
    previous();
  }
  function changeVolume(value: number) {
    setVolume(value);
    if (muted) setMuted(false);
  }
  function togglePlaybackFromControl() {
    const starting = !usePlayerStore.getState().isPlaying;
    togglePlayback();
    if (starting && !sessionDriver.recoveryRequired) {
      sessionDriver.requestNativePlay();
    }
  }

  return (
    <>
      <audio ref={audioRef} preload="auto" onLoadedMetadata={loaded} onLoadedData={loaded} onDurationChange={updateProgress} onCanPlay={onCanPlay} onPlaying={onPlaying} onPause={onPause} onWaiting={onWaiting} onStalled={onStalled} onTimeUpdate={updateProgress} onProgress={updateProgress} onSeeking={updateProgress} onSeeked={updateProgress} onEnded={onEnded} onError={onError} />
      <div className="mobile-player-ui">
        {track && (
          <div className="mini-player">
            <button type="button" className="mini-track" onClick={openExpandedPlayer}>
              <img src={track.cover_url || "/cover-fallback.svg"} alt="" onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = "/cover-fallback.svg"; }} />
              <span><strong>{track.title}</strong><small>{track.artist}</small></span>
              {(status === "resolving" || status === "retrying") && <SpinnerIcon className="h-5 w-5 animate-spin" />}
            </button>
            <button className="player-button" type="button" onClick={togglePlaybackFromControl} aria-label={isPlaying ? "Pause" : "Play"} aria-keyshortcuts="Space">{isPlaying ? <PauseIcon className="h-6 w-6" /> : <PlayIcon className="h-6 w-6" />}</button>
            <button className="player-button mobile-next" type="button" onClick={() => { void nextTrack(); }} disabled={!hasNext} aria-label="Next track"><NextIcon className="h-6 w-6" /></button>
            <div className="mini-progress"><span style={{ width: `${progressPercent}%` }} /></div>
          </div>
        )}

        {expanded && track && (
          <section className="full-player" role="dialog" aria-modal="true" aria-label="Now playing">
            <header><button className="icon-button" type="button" onClick={closeExpandedPlayer}><ChevronDownIcon className="h-6 w-6" /><span className="sr-only">Close player</span></button><strong>Now playing</strong><span /></header>
            <div className="full-player-content">
              <img className="full-cover" src={track.cover_url || "/cover-fallback.svg"} alt="" onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = "/cover-fallback.svg"; }} />
              <div className="full-track-copy"><h2>{track.title}</h2><p>{track.artist}{track.album ? ` · ${track.album}` : ""}</p></div>
              <div className="full-scrubber"><input aria-label="Track position" type="range" min="0" max={displayDuration || 0} step="1" value={progress} onChange={(event) => seekTrack(Number(event.target.value))} /><div><span>{formatDuration(Math.floor(progress))}</span><span>{formatDuration(Math.floor(displayDuration))}</span></div></div>
              <div className="full-controls">
                <button className={`player-button ${shuffle ? "active" : ""}`} type="button" onClick={() => setShuffle(!shuffle)} aria-label="Shuffle" aria-pressed={shuffle}><ShuffleIcon className="h-6 w-6" /></button>
                <button className="player-button" type="button" onClick={previousTrack} disabled={!hasPrevious} aria-label="Previous"><PreviousIcon className="h-7 w-7" /></button>
                <button ref={fullPlayRef} className="play-main" type="button" onClick={togglePlaybackFromControl} aria-label={isPlaying ? "Pause" : "Play"} aria-keyshortcuts="Space">{isPlaying ? <PauseIcon className="h-8 w-8" /> : <PlayIcon className="h-8 w-8" />}</button>
                <button className="player-button" type="button" onClick={() => { void nextTrack(); }} disabled={!hasNext} aria-label="Next"><NextIcon className="h-7 w-7" /></button>
                <span className="control-spacer" />
              </div>
              <label className="volume-control"><VolumeIcon className="h-5 w-5" /><span className="sr-only">Volume</span><input type="range" min="0" max="1" step="0.01" value={volume} onChange={(event) => changeVolume(Number(event.target.value))} /></label>
              {error && <p className="notice notice-error" role="alert">{error}</p>}
            </div>
          </section>
        )}
      </div>

      <footer className="desktop-player" aria-label="Music player">
        <div className="desktop-player-inner">
          <div className="desktop-player-main">
            <div className="desktop-player-track">
              <img src={track?.cover_url || "/cover-fallback.svg"} alt="" onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = "/cover-fallback.svg"; }} />
              <span>
                <strong>{track?.title ?? "Choose a track"}</strong>
                <small>{track?.artist ?? "ANTOLEX Music"}</small>
              </span>
              {(status === "resolving" || status === "retrying") && <SpinnerIcon className="h-5 w-5 animate-spin" />}
            </div>

            <div className="desktop-player-controls">
              <button className={`player-button ${shuffle ? "active" : ""}`} type="button" onClick={() => setShuffle(!shuffle)} disabled={!track} aria-label="Shuffle" aria-pressed={shuffle}><ShuffleIcon className="h-6 w-6" /></button>
              <button className="player-button outlined" type="button" onClick={previousTrack} disabled={!hasPrevious} aria-label="Previous"><PreviousIcon className="h-6 w-6" /></button>
              <button className="play-main desktop-play-main" type="button" onClick={togglePlaybackFromControl} disabled={!track} aria-label={isPlaying ? "Pause" : "Play"} aria-keyshortcuts="Space">{isPlaying ? <PauseIcon className="h-7 w-7" /> : <PlayIcon className="h-7 w-7" />}</button>
              <button className="player-button outlined" type="button" onClick={() => { void nextTrack(); }} disabled={!hasNext} aria-label="Next"><NextIcon className="h-6 w-6" /></button>
            </div>

            <div className="desktop-volume">
              <button className="player-button" type="button" onClick={() => setMuted(!muted)} aria-label={muted ? "Unmute" : "Mute"}>{muted ? <VolumeOffIcon className="h-6 w-6" /> : <VolumeIcon className="h-6 w-6" />}</button>
              <input aria-label="Volume" type="range" min="0" max="1" step="0.01" value={volume} onChange={(event) => changeVolume(Number(event.target.value))} />
            </div>
          </div>

          <div className="desktop-scrubber">
            <div className="desktop-progress-rail">
              <span className="desktop-progress-buffer" style={{ width: `${bufferedPercent}%` }} />
              <span className="desktop-progress-played" style={{ width: `${progressPercent}%` }} />
              <input aria-label="Track position" type="range" min="0" max={displayDuration || 0} step="1" value={progress} disabled={!track || displayDuration <= 0} onChange={(event) => seekTrack(Number(event.target.value))} />
            </div>
            <div><span>{formatDuration(Math.floor(progress))}</span><span>{track ? formatDuration(Math.floor(displayDuration)) : "--:--"}</span></div>
          </div>
          {error && <p className="desktop-player-error" role="alert">{error}</p>}
        </div>
      </footer>
    </>
  );
}
