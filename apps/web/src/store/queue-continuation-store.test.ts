import { describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";

import {
  createQueueContinuationStore,
  QUEUE_CONTINUATION_STORAGE_KEY,
} from "./queue-continuation-store";

function createTestStorage(): StateStorage {
  const storage = new Map<string, string>();
  return {
    getItem: (name) => storage.get(name) ?? null,
    setItem: (name, value) => {
      storage.set(name, value);
    },
    removeItem: (name) => storage.delete(name),
  };
}

describe("queue continuation store", () => {
  it("does not restore a search cursor saved under the v1 key", () => {
    const storage = createTestStorage();
    storage.setItem(
      "antolex-music-queue-continuation-v1",
      JSON.stringify({
        state: {
          source: { kind: "search", query: "rammstein" },
          cursor: "legacy-search-cursor",
          page: 2,
          hasMore: true,
          queueContextId: "queue-context-1",
        },
        version: 0,
      }),
    );

    const store = createQueueContinuationStore(
      QUEUE_CONTINUATION_STORAGE_KEY,
      storage,
    );

    expect(store.getState()).toMatchObject({
      source: null,
      cursor: null,
      page: 1,
      hasMore: false,
      queueContextId: null,
    });
  });

  it("keeps the cursor and source that belong to the active queue", () => {
    const store = createQueueContinuationStore(
      `queue-continuation-${crypto.randomUUID()}`,
      createTestStorage(),
    );

    store.getState().start({
      source: { kind: "search", query: "rammstein" },
      cursor: "cursor-20",
      page: 1,
      hasMore: true,
      queueContextId: "queue-context-1",
    });

    expect(store.getState()).toMatchObject({
      source: { kind: "search", query: "rammstein" },
      cursor: "cursor-20",
      page: 1,
      hasMore: true,
      queueContextId: "queue-context-1",
    });
  });

  it("ignores a late page from a queue that has already been replaced", () => {
    const store = createQueueContinuationStore(
      `queue-continuation-${crypto.randomUUID()}`,
      createTestStorage(),
    );
    store.getState().start({
      source: { kind: "search", query: "first" },
      cursor: "cursor-first",
      page: 1,
      hasMore: true,
      queueContextId: "queue-context-1",
    });
    const staleGeneration = store.getState().generation;

    store.getState().start({
      source: { kind: "search", query: "second" },
      cursor: "cursor-second",
      page: 1,
      hasMore: true,
      queueContextId: "queue-context-2",
    });

    expect(
      store
        .getState()
        .advance(staleGeneration, "queue-context-1", "stale-next", 2, true),
    ).toBe(false);
    expect(store.getState().cursor).toBe("cursor-second");
    expect(store.getState().queueContextId).toBe("queue-context-2");
  });

  it("stops continuation when the server has no usable cursor", () => {
    const store = createQueueContinuationStore(
      `queue-continuation-${crypto.randomUUID()}`,
      createTestStorage(),
    );
    store.getState().start({
      source: { kind: "likes" },
      cursor: null,
      page: 1,
      hasMore: true,
      queueContextId: "queue-context-1",
    });

    expect(store.getState().hasMore).toBe(false);
  });
});
