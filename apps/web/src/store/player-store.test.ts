import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '../lib/api';
import { createPlayerStore, selectHasNext } from './player-store';
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
    shuffleWithCursor: vi.fn(),
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
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('player store queue session', () => {
  it('keeps owner access fields when a session is stored', () => {
    const store = createPlayerStore(`test-player-${crypto.randomUUID()}`, createTestStorage());

    store.getState().setSession(null, {
      id: 'owner-1',
      email: 'owner@example.com',
      is_admin: true,
      access_status: 'active',
      created_at: '2026-08-14T00:00:00Z',
      updated_at: '2026-08-15T00:00:00Z',
    }, '2026-09-13T00:00:00Z');

    expect(store.getState().user).toMatchObject({
      is_admin: true,
      access_status: 'active',
      updated_at: '2026-08-15T00:00:00Z',
    });
  });

  it('drops an unversioned persisted search continuation', () => {
    const storageKey = `test-player-${crypto.randomUUID()}`;
    const persistedTrack = makeTrack(1);
    const storage = createPreloadedStorage(storageKey, {
      shuffleEnabled: true,
      shuffleStateVersion: 1,
      queueContextId: 'queue-context-1',
      queue: [{ queueId: 'queue-item-1', track: persistedTrack }],
      currentIndex: 0,
      currentTime: 0,
      preShuffleQueue: [{ queueId: 'queue-item-1', track: persistedTrack }],
      preShuffleContinuation: {
        source: { kind: 'search', query: 'rammstein' },
        cursor: 'legacy-search-cursor',
        page: 2,
        hasMore: true,
      },
    });

    const store = createPlayerStore(storageKey, storage);

    expect(store.getState().preShuffleContinuation).toBeNull();
  });

  it('keeps a persisted likes continuation unchanged', () => {
    const storageKey = `test-player-${crypto.randomUUID()}`;
    const persistedTrack = makeTrack(1);
    const storage = createPreloadedStorage(storageKey, {
      shuffleEnabled: true,
      shuffleStateVersion: 1,
      queueContextId: 'queue-context-1',
      queue: [{ queueId: 'queue-item-1', track: persistedTrack }],
      currentIndex: 0,
      currentTime: 0,
      preShuffleQueue: [{ queueId: 'queue-item-1', track: persistedTrack }],
      preShuffleContinuation: {
        source: { kind: 'likes' },
        cursor: 'likes-cursor',
        page: 2,
        hasMore: true,
      },
    });

    const store = createPlayerStore(storageKey, storage);

    expect(store.getState().preShuffleContinuation).toEqual({
      source: { kind: 'likes' },
      cursor: 'likes-cursor',
      page: 2,
      hasMore: true,
    });
  });

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

  it('pauses playback on sign out without losing the current queue or position', () => {
    const store = createPlayerStore(`test-player-${crypto.randomUUID()}`, createTestStorage());
    store.getState().setSession(null, {
      id: 'user-1',
      email: 'listener@example.com',
      created_at: '2026-08-14T00:00:00Z',
    }, '2026-09-13T00:00:00Z');
    store.getState().replaceQueue([makeTrack(1)], 0, true);
    store.getState().setPlaybackProgress(42, 181, 60);
    store.setState({ shuffleLoading: true });
    const shuffleRequestId = store.getState().shuffleRequestId;

    store.getState().clearSession();

    expect(store.getState()).toMatchObject({
      user: null,
      isPlaying: false,
      status: 'paused',
      currentIndex: 0,
      currentTime: 42,
      shuffleLoading: false,
      shuffleRequestId: shuffleRequestId + 1,
    });
    expect(store.getState().queue[0]?.track.external_id).toBe('track-1');
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
    const track = makeTrack(9, {
      cover_url: '/api/v1/tracks/track-9/cover',
    });
    const storage = createPreloadedStorage(storageKey, {
      queue: [track],
      currentIndex: 0,
      volume: 0.8,
      muted: false,
      shuffleEnabled: false,
    });

    const store = createPlayerStore(storageKey, storage);

    expect(store.getState().queue).toHaveLength(1);
    expect(store.getState().queue[0]?.track.external_id).toBe(track.external_id);
    expect(store.getState().queue[0]?.track.cover_url).toBe(
      '/api/v1/tracks/track-9/cover?v=g1',
    );
    expect(store.getState().currentIndex).toBe(0);
    expect(store.getState().status).toBe('paused');
  });

  it('restores the saved playback position for the active track', () => {
    const storageKey = `test-player-${crypto.randomUUID()}`;
    const track = makeTrack(10);
    const storage = createPreloadedStorage(storageKey, {
      queue: [track],
      currentIndex: 0,
      currentTime: 47,
      volume: 0.8,
      muted: false,
      shuffleEnabled: true,
    });

    const store = createPlayerStore(storageKey, storage);

    expect(store.getState().currentTime).toBe(47);
    expect(store.getState().seekTarget).toBe(47);
    expect(store.getState().shuffleEnabled).toBe(true);
    expect(store.getState().queue).toHaveLength(1);
    expect(store.getState().currentIndex).toBe(0);
  });

  it('restores a signed shuffle cursor and buffered tracks after reload', () => {
    const storageKey = `test-player-${crypto.randomUUID()}`;
    const storage = createPreloadedStorage(storageKey, {
      queue: [makeTrack(11), makeTrack(12)],
      currentIndex: 1,
      currentTime: 15,
      volume: 0.8,
      muted: false,
      shuffleEnabled: true,
      shuffleStateVersion: 1,
      shuffleCursor: 'signed-cursor',
      shuffleExcludedExternalID: 'track-11',
      shuffleCycleComplete: false,
      shuffleCycleHasTracks: true,
    });

    const store = createPlayerStore(storageKey, storage);

    expect(store.getState().queue).toHaveLength(2);
    expect(store.getState().currentIndex).toBe(1);
    expect(store.getState().shuffleCursor).toBe('signed-cursor');
    expect(store.getState().shuffleExcludedExternalID).toBe('track-11');
    expect(store.getState().shuffleCycleHasTracks).toBe(true);
    expect(store.getState().shuffleLoading).toBe(false);
  });

  it('keeps persisted player state bounded for a ten-thousand-track queue', async () => {
    const storageKey = `test-player-${crypto.randomUUID()}`;
    const storage = createTestStorage();
    const store = createPlayerStore(storageKey, storage);
    const tracks = Array.from({ length: 10_000 }, (_, index) =>
      makeTrack(index + 1),
    );

    store.getState().replaceQueue(tracks, 5_000, false);
    const originalQueueContextId = store.getState().queueContextId;
    store.getState().setPlaybackProgress(75, 180, 90);
    store.getState().setPlaybackSession(
      'session-long-queue',
      originalQueueContextId,
      75,
      { kind: 'search', query: 'long queue' },
    );

    const raw = await storage.getItem(storageKey);
    expect(typeof raw).toBe('string');
    const persisted = JSON.parse(raw as string) as {
      state: {
        queue: Array<{ track: Track }>;
        currentIndex: number;
        queueTruncated: boolean;
      };
    };
    expect(persisted.state.queue).toHaveLength(121);
    expect(persisted.state.currentIndex).toBe(40);
    expect(persisted.state.queueTruncated).toBe(true);
    expect(persisted.state.queue[40]?.track.external_id).toBe('track-5001');
    expect((raw as string).length).toBeLessThan(100_000);

    const restored = createPlayerStore(storageKey, storage);
    expect(restored.getState().queueContextId).not.toBe(originalQueueContextId);
    expect(restored.getState().queue).toHaveLength(121);
    expect(restored.getState().currentIndex).toBe(40);
    expect(restored.getState().playbackSessionId).toBe('session-long-queue');
    expect(restored.getState().playbackSessionQueueContextId).toBe(
      restored.getState().queueContextId,
    );
    expect(restored.getState().playbackTimelineTime).toBe(75);
  });

  it('keeps repeated shuffle tracks distinct by playback ordinal', () => {
    const store = createPlayerStore(
      `test-player-${crypto.randomUUID()}`,
      createTestStorage(),
    );
    const repeated = makeTrack(31);
    const middle = makeTrack(32);
    const queueContextId = store.getState().queueContextId;

    store.getState().syncPlaybackSessionTimeline({
      id: 'session-repeat',
      queueContextId,
      timelineTime: 21,
      currentOrdinal: 2,
      currentTime: 1,
      duration: 10,
      bufferedTo: 3,
      items: [
        { ordinal: 0, track: repeated },
        { ordinal: 1, track: middle },
        { ordinal: 2, track: repeated },
      ],
      source: { kind: 'shuffle' },
    });

    expect(store.getState().queue.map(({ queueId }) => queueId)).toEqual([
      `playback-0-${repeated.external_id}`,
      `playback-1-${middle.external_id}`,
      `playback-2-${repeated.external_id}`,
    ]);
    expect(store.getState()).toMatchObject({
      currentIndex: 2,
      currentTime: 1,
      duration: 10,
      bufferedTo: 3,
      playbackTimelineTime: 21,
    });
  });

  it('enables global shuffle without restarting the current track', async () => {
    const store = createPlayerStore(`test-player-${crypto.randomUUID()}`, createTestStorage());
    const tracks = [
      makeTrack(20, { stream_url: 'https://cdn.example.com/20.mp3' }),
      makeTrack(21, { stream_url: 'https://cdn.example.com/21.mp3' }),
      makeTrack(22, { stream_url: 'https://cdn.example.com/22.mp3' }),
    ];
    vi.mocked(api.shuffleWithCursor).mockResolvedValue({
      results: [makeTrack(23)],
      has_next: false,
      cycle_complete: true,
    });

    store.getState().replaceQueue(tracks, 1, true);
    store.getState().setPlaybackProgress(47, 201, 80);
    const activeQueueId = store.getState().queue[1]?.queueId;

    store.getState().setShuffleEnabled(true);

    expect(store.getState().queue[0]?.queueId).toBe(activeQueueId);
    expect(store.getState().queue[0]?.track.external_id).toBe('track-21');
    expect(store.getState().currentIndex).toBe(0);
    expect(store.getState().currentTime).toBe(47);
    expect(store.getState().duration).toBe(201);
    expect(store.getState().isPlaying).toBe(true);
    await store.getState().prefetchShuffle();
    expect(api.shuffleWithCursor).toHaveBeenCalledWith(
      1,
      null,
      'track-21',
    );
  });

  it('walks the whole shuffle cycle without repeats and starts a new cycle', async () => {
    const store = createPlayerStore(`test-player-${crypto.randomUUID()}`, createTestStorage());
    vi.mocked(api.shuffleWithCursor)
      .mockResolvedValueOnce({
        results: [makeTrack(31), makeTrack(32)],
        has_next: true,
        next_cursor: 'cursor-1',
        cycle_complete: false,
      })
      .mockResolvedValueOnce({
        results: [makeTrack(33)],
        has_next: false,
        cycle_complete: true,
      })
      .mockResolvedValueOnce({
        results: [makeTrack(31)],
        has_next: false,
        cycle_complete: true,
      });

    store.getState().replaceQueue([makeTrack(30)], 0, true);
    store.getState().setShuffleEnabled(true);
    await store.getState().prefetchShuffle();

    const played = [store.getState().queue[store.getState().currentIndex]?.track.external_id];
    await store.getState().next();
    played.push(store.getState().queue[store.getState().currentIndex]?.track.external_id);
    await store.getState().next();
    played.push(store.getState().queue[store.getState().currentIndex]?.track.external_id);
    await store.getState().next();
    played.push(store.getState().queue[store.getState().currentIndex]?.track.external_id);

    expect(played).toEqual(['track-30', 'track-31', 'track-32', 'track-33']);
    expect(new Set(played).size).toBe(played.length);
    expect(api.shuffleWithCursor).toHaveBeenNthCalledWith(
      2,
      1,
      'cursor-1',
      'track-30',
    );

    await store.getState().next();
    expect(store.getState().queue[store.getState().currentIndex]?.track.external_id).toBe('track-31');
    expect(api.shuffleWithCursor).toHaveBeenNthCalledWith(
      3,
      1,
      null,
      'track-33',
    );
  });

  it('stops shuffle cleanly when the current track is the whole library', async () => {
    const store = createPlayerStore(`test-player-${crypto.randomUUID()}`, createTestStorage());
    vi.mocked(api.shuffleWithCursor).mockResolvedValue({
      results: [],
      has_next: false,
      cycle_complete: true,
    });

    store.getState().replaceQueue([makeTrack(40)], 0, true);
    store.getState().setShuffleEnabled(true);
    await store.getState().prefetchShuffle();

    expect(selectHasNext(store.getState())).toBe(false);
    await expect(store.getState().next()).resolves.toBe(false);
    expect(store.getState().queue).toHaveLength(1);
    expect(api.shuffleWithCursor).toHaveBeenCalledTimes(1);
  });

  it('disabling shuffle invalidates continuation without resetting playback', async () => {
    const store = createPlayerStore(`test-player-${crypto.randomUUID()}`, createTestStorage());
    let resolvePage: ((value: {
      results: Track[];
      has_next: boolean;
      next_cursor?: string;
      cycle_complete: boolean;
    }) => void) | undefined;
    vi.mocked(api.shuffleWithCursor).mockReturnValue(
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );

    store.getState().replaceQueue(
      [makeTrack(49), makeTrack(50), makeTrack(51)],
      1,
      true,
    );
    store.getState().setPlaybackProgress(33, 230, 60);
    store.getState().setShuffleEnabled(true);
    store.getState().setShuffleEnabled(false);
    resolvePage?.({
      results: [makeTrack(52)],
      has_next: true,
      next_cursor: 'stale-cursor',
      cycle_complete: false,
    });
    await Promise.resolve();

    expect(store.getState().shuffleEnabled).toBe(false);
    expect(store.getState().shuffleCursor).toBeNull();
    expect(store.getState().shuffleLoading).toBe(false);
    expect(store.getState().currentTime).toBe(33);
    expect(store.getState().isPlaying).toBe(true);
    expect(store.getState().currentIndex).toBe(1);
    expect(store.getState().queue.map((item) => item.track.external_id)).toEqual([
      'track-49',
      'track-50',
      'track-51',
    ]);
  });

  it('retries a transient shuffle-tail failure and resumes on the appended track', async () => {
    vi.useFakeTimers();
    const store = createPlayerStore(`test-player-${crypto.randomUUID()}`, createTestStorage());
    const unavailable = Object.assign(new Error('Temporarily unavailable'), {
      status: 503,
    });
    vi.mocked(api.shuffleWithCursor)
      .mockResolvedValueOnce({
        results: [makeTrack(61)],
        has_next: true,
        next_cursor: 'cursor-61',
        cycle_complete: false,
      })
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValueOnce({
        results: [makeTrack(62)],
        has_next: false,
        cycle_complete: true,
      });

    store.getState().replaceQueue([makeTrack(60)], 0, true);
    store.getState().setShuffleEnabled(true);
    await store.getState().prefetchShuffle();
    await store.getState().next();
    expect(store.getState().queue[store.getState().currentIndex]?.track.external_id).toBe('track-61');

    await expect(store.getState().next()).resolves.toBe(true);
    expect(store.getState()).toMatchObject({
      isPlaying: true,
      status: 'retrying',
      pendingAdvanceQueueContextId: store.getState().queueContextId,
    });
    expect(api.shuffleWithCursor).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(500);

    expect(api.shuffleWithCursor).toHaveBeenCalledTimes(3);
    expect(store.getState().queue[store.getState().currentIndex]?.track.external_id).toBe('track-62');
    expect(store.getState().isPlaying).toBe(true);
    expect(store.getState().pendingAdvanceQueueContextId).toBeNull();
  });

  it('cancels a pending shuffle retry when playback is paused', async () => {
    vi.useFakeTimers();
    const store = createPlayerStore(`test-player-${crypto.randomUUID()}`, createTestStorage());
    vi.mocked(api.shuffleWithCursor)
      .mockResolvedValueOnce({
        results: [makeTrack(71)],
        has_next: true,
        next_cursor: 'cursor-71',
        cycle_complete: false,
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('Temporarily unavailable'), { status: 503 }),
      );

    store.getState().replaceQueue([makeTrack(70)], 0, true);
    store.getState().setShuffleEnabled(true);
    await store.getState().prefetchShuffle();
    await store.getState().next();
    await store.getState().next();

    store.getState().togglePlayback();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(api.shuffleWithCursor).toHaveBeenCalledTimes(2);
    expect(store.getState().queue[store.getState().currentIndex]?.track.external_id).toBe('track-71');
    expect(store.getState().isPlaying).toBe(false);
    expect(store.getState().pendingAdvanceQueueContextId).toBeNull();
  });

  it('does not let a pending shuffle retry affect a replacement queue', async () => {
    vi.useFakeTimers();
    const store = createPlayerStore(`test-player-${crypto.randomUUID()}`, createTestStorage());
    vi.mocked(api.shuffleWithCursor)
      .mockResolvedValueOnce({
        results: [makeTrack(81)],
        has_next: true,
        next_cursor: 'cursor-81',
        cycle_complete: false,
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('Temporarily unavailable'), { status: 503 }),
      )
      .mockResolvedValueOnce({
        results: [],
        has_next: false,
        cycle_complete: true,
      });

    store.getState().replaceQueue([makeTrack(80)], 0, true);
    store.getState().setShuffleEnabled(true);
    await store.getState().prefetchShuffle();
    await store.getState().next();
    await store.getState().next();

    store.getState().replaceQueue([makeTrack(82)], 0, true);
    await store.getState().prefetchShuffle();
    expect(api.shuffleWithCursor).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(api.shuffleWithCursor).toHaveBeenCalledTimes(3);
    expect(api.shuffleWithCursor).toHaveBeenNthCalledWith(3, 1, null, 'track-82');
    expect(store.getState().queue).toHaveLength(1);
    expect(store.getState().queue[store.getState().currentIndex]?.track.external_id).toBe('track-82');
    expect(store.getState().isPlaying).toBe(true);
    expect(store.getState().pendingAdvanceQueueContextId).toBeNull();
  });
});
