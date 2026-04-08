import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
} from 'react';

import {
  NextIcon,
  PauseIcon,
  PlayIcon,
  PreviousIcon,
  ShuffleIcon,
  SpinnerIcon,
  VolumeIcon,
  VolumeOffIcon,
} from './Icons';
import { formatDuration } from '../lib/format';
import {
  isQueueItemStreamFresh,
  selectCurrentItem,
  selectHasNext,
  selectHasPrevious,
  usePlayerStore,
} from '../store/player-store';

function getBufferedTo(audio: HTMLAudioElement) {
  if (audio.buffered.length === 0) {
    return 0;
  }

  return audio.buffered.end(audio.buffered.length - 1);
}

function shouldIgnoreSpacebarToggle(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  if (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    target.isContentEditable
  ) {
    return true;
  }

  return false;
}

export function Player() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const volumeIndicatorTimeoutRef = useRef<number | null>(null);
  const [showVolumePercent, setShowVolumePercent] = useState(false);
  const [hoverPreview, setHoverPreview] = useState<{
    active: boolean;
    percent: number;
    time: number;
  }>({
    active: false,
    percent: 0,
    time: 0,
  });

  const currentItem = usePlayerStore(selectCurrentItem);
  const hasNext = usePlayerStore(selectHasNext);
  const hasPrevious = usePlayerStore(selectHasPrevious);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const status = usePlayerStore((state) => state.status);
  const volume = usePlayerStore((state) => state.volume);
  const muted = usePlayerStore((state) => state.muted);
  const currentTime = usePlayerStore((state) => state.currentTime);
  const duration = usePlayerStore((state) => state.duration);
  const seekTarget = usePlayerStore((state) => state.seekTarget);
  const bufferedTo = usePlayerStore((state) => state.bufferedTo);
  const shuffleEnabled = usePlayerStore((state) => state.shuffleEnabled);
  const error = usePlayerStore((state) => state.error);
  const togglePlayback = usePlayerStore((state) => state.togglePlayback);
  const next = usePlayerStore((state) => state.next);
  const previous = usePlayerStore((state) => state.previous);
  const setVolume = usePlayerStore((state) => state.setVolume);
  const setMuted = usePlayerStore((state) => state.setMuted);
  const setShuffleEnabled = usePlayerStore((state) => state.setShuffleEnabled);
  const seek = usePlayerStore((state) => state.seek);
  const clearSeekRequest = usePlayerStore((state) => state.clearSeekRequest);
  const beginRetryCurrentTrack = usePlayerStore((state) => state.beginRetryCurrentTrack);
  const resolveCurrentTrack = usePlayerStore((state) => state.resolveCurrentTrack);
  const setPlaybackStatus = usePlayerStore((state) => state.setPlaybackStatus);
  const setPlaybackProgress = usePlayerStore((state) => state.setPlaybackProgress);
  const handleTrackEnded = usePlayerStore((state) => state.handleTrackEnded);
  const handlePlaybackError = usePlayerStore((state) => state.handlePlaybackError);

  const currentTrack = useMemo(() => {
    if (!currentItem) {
      return null;
    }

    return {
      ...currentItem.track,
      stream_url: isQueueItemStreamFresh(currentItem)
        ? currentItem.resolvedStreamUrl ?? currentItem.track.stream_url
        : undefined,
    };
  }, [currentItem]);

  const displayDuration = duration || currentTrack?.duration_seconds || 0;
  const progressValue = displayDuration > 0 ? Math.min(currentTime, displayDuration) : 0;
  const bufferPercent =
    displayDuration > 0 ? Math.min((bufferedTo / displayDuration) * 100, 100) : 0;
  const progressPercent =
    displayDuration > 0 ? Math.min((progressValue / displayDuration) * 100, 100) : 0;
  const volumePercent = Math.round(volume * 100);

  const showLoadingState = useMemo(
    () => status === 'resolving' || status === 'retrying',
    [status],
  );

  useEffect(() => {
    return () => {
      if (volumeIndicatorTimeoutRef.current !== null) {
        window.clearTimeout(volumeIndicatorTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    function onWindowKeyDown(event: KeyboardEvent) {
      if (
        event.code !== 'Space' ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        shouldIgnoreSpacebarToggle(event.target) ||
        !currentTrack
      ) {
        return;
      }

      event.preventDefault();
      togglePlayback();
    }

    window.addEventListener('keydown', onWindowKeyDown);
    return () => window.removeEventListener('keydown', onWindowKeyDown);
  }, [currentTrack, togglePlayback]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    audio.volume = volume;
  }, [volume]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    audio.muted = muted;
  }, [muted]);

  useEffect(() => {
    if (!currentItem) {
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
      return;
    }

    if (currentItem.resolveStatus === 'loading') {
      return;
    }

    if (isQueueItemStreamFresh(currentItem) && currentItem.resolveStatus === 'ready') {
      return;
    }

    if (!isPlaying && status !== 'resolving' && status !== 'retrying') {
      return;
    }

    if (currentItem.resolveStatus === 'error' && status === 'error') {
      return;
    }

    void resolveCurrentTrack().catch((resolveError) => {
      const message =
        resolveError instanceof Error ? resolveError.message : 'Failed to resolve track';
      handlePlaybackError(message);
    });
  }, [currentItem, handlePlaybackError, isPlaying, resolveCurrentTrack, status]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    if (!currentItem) {
      return;
    }

    const streamUrl = currentTrack?.stream_url;
    if (!streamUrl) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      audio.dataset.queueId = currentItem.queueId;
      setPlaybackProgress(0, currentTrack?.duration_seconds ?? 0, 0);
      return;
    }

    if (audio.dataset.queueId === currentItem.queueId && audio.src === streamUrl) {
      return;
    }

    audio.dataset.queueId = currentItem.queueId;
    audio.src = streamUrl;
    audio.load();
    setPlaybackProgress(0, currentTrack?.duration_seconds ?? 0, 0);
  }, [currentItem, currentTrack, setPlaybackProgress]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentTrack?.stream_url) {
      return;
    }

    if (isPlaying) {
      void audio.play().then(
        () => setPlaybackStatus('playing'),
        (playError: unknown) => {
          const message =
            playError instanceof Error ? playError.message : 'Playback was blocked';
          setPlaybackStatus('paused', message);
        },
      );
      return;
    }

    audio.pause();
    setPlaybackStatus('paused');
  }, [currentItem, isPlaying, setPlaybackStatus]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || seekTarget === null) {
      return;
    }

    const nextTime =
      Number.isFinite(audio.duration) && audio.duration > 0
        ? Math.min(seekTarget, audio.duration)
        : seekTarget;
    audio.currentTime = Math.max(0, nextTime);
    clearSeekRequest();

    if (isPlaying) {
      void audio.play().catch(() => {
        setPlaybackStatus('paused');
      });
    }
  }, [clearSeekRequest, isPlaying, seekTarget, setPlaybackStatus]);

  function onLoadedMetadata() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    setPlaybackProgress(
      audio.currentTime,
      Number.isFinite(audio.duration) ? audio.duration : currentTrack?.duration_seconds ?? 0,
      getBufferedTo(audio),
    );
  }

  function onTimeUpdate() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    setPlaybackProgress(
      audio.currentTime,
      Number.isFinite(audio.duration) ? audio.duration : currentTrack?.duration_seconds ?? 0,
      getBufferedTo(audio),
    );
  }

  function onProgress() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    setPlaybackProgress(
      audio.currentTime,
      Number.isFinite(audio.duration) ? audio.duration : currentTrack?.duration_seconds ?? 0,
      getBufferedTo(audio),
    );
  }

  function onEnded() {
    handleTrackEnded();
  }

  function onAudioError() {
    const audio = audioRef.current;
    const audioMessage = audio?.error?.message || currentItem?.resolveError || error;
    const message = audioMessage || 'Unable to play this track';

    if (beginRetryCurrentTrack()) {
      void resolveCurrentTrack(true).catch((resolveError) => {
        const retryMessage =
          resolveError instanceof Error ? resolveError.message : message;
        handlePlaybackError(retryMessage);
      });
      return;
    }

    handlePlaybackError(message);
  }

  function revealVolumePercent() {
    setShowVolumePercent(true);

    if (volumeIndicatorTimeoutRef.current !== null) {
      window.clearTimeout(volumeIndicatorTimeoutRef.current);
    }

    volumeIndicatorTimeoutRef.current = window.setTimeout(() => {
      setShowVolumePercent(false);
    }, 1400);
  }

  function handleToggleMuted() {
    setMuted(!muted);
    revealVolumePercent();
  }

  function handleVolumeChange(event: ChangeEvent<HTMLInputElement>) {
    setVolume(Number(event.target.value));
    revealVolumePercent();
  }

  function updateHoverPreview(event: MouseEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    if (displayDuration <= 0) {
      setHoverPreview((current) =>
        current.active ? { active: false, percent: 0, time: 0 } : current,
      );
      return;
    }

    const bounds = input.getBoundingClientRect();
    const offsetX = Math.min(Math.max(event.clientX - bounds.left, 0), bounds.width);
    const percent = bounds.width > 0 ? (offsetX / bounds.width) * 100 : 0;
    const time = (percent / 100) * displayDuration;

    setHoverPreview({
      active: true,
      percent,
      time,
    });
  }

  function clearHoverPreview() {
    setHoverPreview((current) =>
      current.active ? { active: false, percent: 0, time: 0 } : current,
    );
  }

  return (
    <footer className="sticky bottom-0 z-20 border-t border-white/10 bg-zinc-950/95 backdrop-blur">
      <audio
        ref={audioRef}
        preload="none"
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={onTimeUpdate}
        onProgress={onProgress}
        onEnded={onEnded}
        onError={onAudioError}
      />

      <div className="mx-auto grid max-w-6xl gap-4 px-4 py-3">
        <div className="grid gap-4 md:grid-cols-[1.4fr_auto_240px] md:items-center">
          <div className="flex min-w-0 items-center gap-3">
            {currentTrack ? (
              <>
                <img
                  src={currentTrack.cover_url}
                  alt={currentTrack.title}
                  className="h-14 w-14 rounded-2xl object-cover"
                  onError={(event) => {
                    event.currentTarget.onerror = null;
                    event.currentTarget.src = '/cover-fallback.svg';
                  }}
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-semibold text-zinc-50">
                      {currentTrack.title}
                    </p>
                    {showLoadingState && (
                      <SpinnerIcon className="h-5 w-5 animate-spin text-zinc-500" />
                    )}
                  </div>
                  <p className="truncate text-xs text-zinc-400">
                    {currentTrack.artist}
                  </p>
                </div>
              </>
            ) : (
              <div className="rounded-2xl border border-dashed border-white/10 px-4 py-3 text-sm text-zinc-500">
                Search and play a track to start a listening session.
              </div>
            )}
          </div>

          <div className="flex items-center justify-center gap-2.5">
            <button
              type="button"
              onClick={() => setShuffleEnabled(!shuffleEnabled)}
              aria-label="Shuffle"
              title="Shuffle"
              className={`flex h-12 w-12 items-center justify-center rounded-full transition ${
                shuffleEnabled
                  ? 'bg-emerald-400 text-zinc-950'
                  : 'bg-white/6 text-zinc-300 hover:bg-white/10'
              }`}
            >
              <ShuffleIcon className="h-6 w-6" />
            </button>
            <button
              type="button"
              onClick={previous}
              disabled={!hasPrevious}
              aria-label="Previous track"
              title="Previous track"
              className="flex h-12 w-12 items-center justify-center rounded-full border border-white/10 text-zinc-50 transition hover:border-emerald-300 hover:text-emerald-300 disabled:cursor-not-allowed disabled:border-white/5 disabled:text-zinc-600"
            >
              <PreviousIcon className="h-6 w-6" />
            </button>
            <button
              type="button"
              onClick={togglePlayback}
              disabled={!currentTrack}
              aria-label={isPlaying ? 'Pause' : 'Play'}
              title={isPlaying ? 'Pause' : 'Play'}
              className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-400 text-zinc-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
            >
              {isPlaying ? (
                <PauseIcon className="h-6 w-6" />
              ) : (
                <PlayIcon className="h-6 w-6" />
              )}
            </button>
            <button
              type="button"
              onClick={next}
              disabled={!hasNext}
              aria-label="Next track"
              title="Next track"
              className="flex h-12 w-12 items-center justify-center rounded-full border border-white/10 text-zinc-50 transition hover:border-emerald-300 hover:text-emerald-300 disabled:cursor-not-allowed disabled:border-white/5 disabled:text-zinc-600"
            >
              <NextIcon className="h-6 w-6" />
            </button>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={handleToggleMuted}
              aria-label={muted ? 'Unmute' : 'Mute'}
              title={muted ? 'Unmute' : 'Mute'}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-zinc-300 transition hover:text-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
            >
              {muted ? (
                <VolumeOffIcon className="h-6 w-6" />
              ) : (
                <VolumeIcon className="h-6 w-6" />
              )}
            </button>
            <span
              className={`w-9 shrink-0 text-right text-[11px] tabular-nums text-zinc-500 transition-opacity ${
                showVolumePercent ? 'opacity-100' : 'opacity-0'
              }`}
            >
              {volumePercent}%
            </span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={handleVolumeChange}
              className="w-full accent-emerald-400"
            />
          </div>
        </div>

        <div className="space-y-2">
          <div className="relative -my-3 py-3">
            {hoverPreview.active && displayDuration > 0 && (
              <div
                data-testid="progress-hover-preview"
                aria-hidden="true"
                className="pointer-events-none absolute bottom-full z-10 mb-2 -translate-x-1/2 rounded-xl bg-zinc-800 px-2 py-1 text-[11px] font-medium text-zinc-100 shadow-lg shadow-black/25"
                style={{ left: `${hoverPreview.percent}%` }}
              >
                {formatDuration(Math.floor(hoverPreview.time))}
              </div>
            )}
            <div className="relative h-2 overflow-hidden rounded-full bg-white/8">
              {hoverPreview.active && displayDuration > 0 && (
                <div
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 bg-white/12"
                  style={{ width: `${hoverPreview.percent}%` }}
                />
              )}
              <div
                className="absolute inset-y-0 left-0 bg-white/15"
                style={{ width: `${bufferPercent}%` }}
              />
              <div
                className="absolute inset-y-0 left-0 bg-emerald-400"
                style={{ width: `${progressPercent}%` }}
              />
              {hoverPreview.active && displayDuration > 0 && (
                <div
                  data-testid="progress-hover-thumb"
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 z-10 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/30 bg-emerald-300 shadow-[0_0_0_4px_rgba(16,185,129,0.15)]"
                  style={{ left: `${hoverPreview.percent}%` }}
                />
              )}
            </div>
            <input
              type="range"
              min="0"
              max={displayDuration || 0}
              step="1"
              value={progressValue}
              onChange={(event) => seek(Number(event.target.value))}
              onMouseMove={updateHoverPreview}
              onMouseLeave={clearHoverPreview}
              disabled={!currentTrack || displayDuration <= 0}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
            />
          </div>

          <div className="flex items-center justify-between text-xs text-zinc-500">
            <span>{formatDuration(Math.floor(progressValue))}</span>
            <span>{currentTrack ? formatDuration(Math.floor(displayDuration)) : '--:--'}</span>
          </div>

          {error && <p className="text-xs text-rose-300">{error}</p>}
        </div>
      </div>
    </footer>
  );
}
