import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '../lib/api';
import { createPlayerStore } from './player-store';
import type { Track } from '../types';
import type { StateStorage } from 'zustand/middleware';

vi.mock('../lib/api', () => ({
  api: {
    login: vi.fn(),
    register: vi.fn(),
    search: vi.fn(),
    resolveTrack: vi.fn(),
    getLikes: vi.fn(),
    addLike: vi.fn(),
    removeLike: vi.fn(),
  },
}));

function makeTrack(index: number, overrides: Partial<Track> = {}): Track {
  return {
    external_id: `track-${index}`,
    title: `Track ${index}`,
    artist: 'Demo Artist',
    cover_url: `https://example.com/${index}.jpg`,
    duration_seconds: 180 + index,
    ...overrides,
  };
}

function createTestStorage(): StateStorage {
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

function createPreloadedStorage(
  key: string,
  state: unknown,
): StateStorage {
  const storage = createTestStorage();
  storage.setItem(
    key,
    JSON.stringify({
      state,
      version: 0,
    }),
  );
  return storage;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('player store queue session', () => {
  it('replaces the queue and advances to the next track', () => {
    const store = createPlayerStore(`test-player-${crypto.randomUUID()}`, createTestStorage());
    const tracks = [
      makeTrack(1, { stream_url: 'https://cdn.example.com/1.mp3' }),
      makeTrack(2, { stream_url: 'https://cdn.example.com/2.mp3' }),
    ];

    store.getState().replaceQueue(tracks, 0, true);
    expect(store.getState().currentIndex).toBe(0);
    expect(store.getState().isPlaying).toBe(true);

    store.getState().next();
    expect(store.getState().currentIndex).toBe(1);
    expect(store.getState().queue[1]?.track.external_id).toBe('track-2');
  });

  it('restarts the current track when previous is pressed after progress threshold', () => {
    const store = createPlayerStore(`test-player-${crypto.randomUUID()}`, createTestStorage());
    const tracks = [
      makeTrack(1, { stream_url: 'https://cdn.example.com/1.mp3' }),
      makeTrack(2, { stream_url: 'https://cdn.example.com/2.mp3' }),
    ];

    store.getState().replaceQueue(tracks, 1, true);
    store.getState().setPlaybackProgress(12, 181, 25);

    store.getState().previous();

    expect(store.getState().currentIndex).toBe(1);
    expect(store.getState().seekTarget).toBe(0);
  });

  it('resolves a fresh stream url for the current queue item', async () => {
    const store = createPlayerStore(`test-player-${crypto.randomUUID()}`, createTestStorage());
    const unresolvedTrack = makeTrack(3);

    vi.mocked(api.resolveTrack).mockResolvedValue({
      ...unresolvedTrack,
      stream_url: 'https://cdn.example.com/resolved.mp3',
    });

    store.getState().replaceQueue([unresolvedTrack], 0, true);
    const resolved = await store.getState().resolveCurrentTrack();

    expect(api.resolveTrack).toHaveBeenCalledWith('track-3');
    expect(resolved?.stream_url).toBe('https://cdn.example.com/resolved.mp3');
    expect(store.getState().queue[0]?.resolvedStreamUrl).toBe(
      'https://cdn.example.com/resolved.mp3',
    );
    expect(store.getState().queue[0]?.resolveStatus).toBe('ready');
  });

  it('refreshes a stale stream url before playback continues', async () => {
    const store = createPlayerStore(`test-player-${crypto.randomUUID()}`, createTestStorage());
    const staleTrack = makeTrack(4, { stream_url: 'https://cdn.example.com/stale.mp3' });

    vi.mocked(api.resolveTrack).mockResolvedValue({
      ...staleTrack,
      stream_url: 'https://cdn.example.com/fresh.mp3',
    });

    store.getState().replaceQueue([staleTrack], 0, true);
    store.setState((state) => ({
      queue: state.queue.map((item, index) =>
        index === 0
          ? {
              ...item,
              resolvedAt: Date.now() - 11 * 60 * 1000,
            }
          : item,
      ),
    }));

    const resolved = await store.getState().resolveCurrentTrack();

    expect(api.resolveTrack).toHaveBeenCalledWith('track-4');
    expect(resolved?.stream_url).toBe('https://cdn.example.com/fresh.mp3');
  });

  it('allows only one automatic retry per active queue item', () => {
    const store = createPlayerStore(`test-player-${crypto.randomUUID()}`, createTestStorage());
    const unresolvedTrack = makeTrack(5);

    store.getState().replaceQueue([unresolvedTrack], 0, true);

    expect(store.getState().beginRetryCurrentTrack()).toBe(true);
    expect(store.getState().status).toBe('retrying');
    expect(store.getState().queue[0]?.retryCount).toBe(1);

    expect(store.getState().beginRetryCurrentTrack()).toBe(false);
    expect(store.getState().queue[0]?.retryCount).toBe(1);
  });

  it('resets retry budget after moving to another queue item', () => {
    const store = createPlayerStore(`test-player-${crypto.randomUUID()}`, createTestStorage());
    const tracks = [makeTrack(6), makeTrack(7)];

    store.getState().replaceQueue(tracks, 0, true);
    expect(store.getState().beginRetryCurrentTrack()).toBe(true);

    store.getState().next();

    expect(store.getState().currentIndex).toBe(1);
    expect(store.getState().queue[1]?.retryCount).toBe(0);
    expect(store.getState().beginRetryCurrentTrack()).toBe(true);
  });

  it('moves the active item into an error state when resolve fails', async () => {
    const store = createPlayerStore(`test-player-${crypto.randomUUID()}`, createTestStorage());
    const unresolvedTrack = makeTrack(8);

    vi.mocked(api.resolveTrack).mockRejectedValue(new Error('stream expired'));

    store.getState().replaceQueue([unresolvedTrack], 0, true);

    await expect(store.getState().resolveCurrentTrack()).rejects.toThrow('stream expired');
    expect(store.getState().status).toBe('error');
    expect(store.getState().isPlaying).toBe(false);
    expect(store.getState().queue[0]?.resolveStatus).toBe('error');
    expect(store.getState().queue[0]?.resolveError).toBe('stream expired');
  });

  it('ignores malformed persisted queue items during hydration', () => {
    const storageKey = `test-player-${crypto.randomUUID()}`;
    const storage = createPreloadedStorage(storageKey, {
      queue: [{ queueId: 'bad-1' }],
      currentIndex: 0,
      volume: 0.4,
      muted: false,
      repeatMode: 'off',
      shuffleEnabled: false,
    });

    const store = createPlayerStore(storageKey, storage);

    expect(store.getState().queue).toEqual([]);
    expect(store.getState().currentIndex).toBe(-1);
    expect(store.getState().status).toBe('idle');
    expect(store.getState().volume).toBe(0.4);
  });

  it('hydrates legacy persisted queues that stored tracks directly', () => {
    const storageKey = `test-player-${crypto.randomUUID()}`;
    const track = makeTrack(9);
    const storage = createPreloadedStorage(storageKey, {
      queue: [track],
      currentIndex: 0,
      volume: 0.8,
      muted: false,
      repeatMode: 'off',
      shuffleEnabled: false,
    });

    const store = createPlayerStore(storageKey, storage);

    expect(store.getState().queue).toHaveLength(1);
    expect(store.getState().queue[0]?.track.external_id).toBe(track.external_id);
    expect(store.getState().currentIndex).toBe(0);
    expect(store.getState().status).toBe('paused');
  });
});
