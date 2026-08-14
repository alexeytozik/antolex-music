import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";

const DEFAULT_STORAGE_KEY = "antolex-music-queue-continuation-v1";

export type QueueContinuationSource =
  | { kind: "search"; query: string }
  | { kind: "likes" }
  | { kind: "shuffle"; excludeExternalId?: string };

export type StartQueueContinuationInput = {
  source: QueueContinuationSource;
  cursor: string | null;
  page: number;
  hasMore: boolean;
  queueContextId: string;
};

type PersistedQueueContinuationState = {
  source: QueueContinuationSource | null;
  cursor: string | null;
  page: number;
  hasMore: boolean;
  queueContextId: string | null;
};

type QueueContinuationState = PersistedQueueContinuationState & {
  generation: number;
  error: string | null;
  start: (input: StartQueueContinuationInput) => void;
  stop: () => void;
  advance: (
    expectedGeneration: number,
    expectedQueueContextId: string,
    cursor: string | null,
    page: number,
    hasMore: boolean,
  ) => boolean;
  fail: (
    expectedGeneration: number,
    expectedQueueContextId: string,
    message: string,
  ) => void;
};

function createMemoryStorage(): StateStorage {
  const storage = new Map<string, string>();
  return {
    getItem: (name) => storage.get(name) ?? null,
    setItem: (name, value) => storage.set(name, value),
    removeItem: (name) => storage.delete(name),
  };
}

function resolveStorage(customStorage?: StateStorage) {
  if (customStorage) return customStorage;
  if (typeof window !== "undefined" && window.localStorage) {
    return window.localStorage;
  }
  return createMemoryStorage();
}

export function createQueueContinuationStore(
  storageKey = DEFAULT_STORAGE_KEY,
  storage?: StateStorage,
) {
  return create<QueueContinuationState>()(
    persist(
      (set) => ({
        source: null,
        cursor: null,
        page: 1,
        hasMore: false,
        queueContextId: null,
        generation: 0,
        error: null,
        start: (input) =>
          set((state) => ({
            ...input,
            page: Math.max(1, input.page),
            hasMore: input.hasMore && Boolean(input.cursor),
            generation: state.generation + 1,
            error: null,
          })),
        stop: () =>
          set((state) => ({
            source: null,
            cursor: null,
            page: 1,
            hasMore: false,
            queueContextId: null,
            generation: state.generation + 1,
            error: null,
          })),
        advance: (
          expectedGeneration,
          expectedQueueContextId,
          cursor,
          page,
          hasMore,
        ) => {
          let advanced = false;
          set((state) => {
            if (
              state.generation !== expectedGeneration ||
              state.queueContextId !== expectedQueueContextId
            ) {
              return state;
            }
            advanced = true;
            return {
              cursor,
              page,
              hasMore: hasMore && Boolean(cursor),
              error: null,
            };
          });
          return advanced;
        },
        fail: (expectedGeneration, expectedQueueContextId, message) =>
          set((state) =>
            state.generation === expectedGeneration &&
            state.queueContextId === expectedQueueContextId
              ? { error: message }
              : state,
          ),
      }),
      {
        name: storageKey,
        storage: createJSONStorage(() => resolveStorage(storage)),
        partialize: (state): PersistedQueueContinuationState => ({
          source: state.source,
          cursor: state.cursor,
          page: state.page,
          hasMore: state.hasMore,
          queueContextId: state.queueContextId,
        }),
        merge: (persistedState, currentState) => {
          const persisted = persistedState as Partial<PersistedQueueContinuationState>;
          if (
            typeof persisted.queueContextId !== "string" ||
            persisted.queueContextId.trim() === ""
          ) {
            return {
              ...currentState,
              generation: currentState.generation + 1,
            };
          }
          return {
            ...currentState,
            ...persisted,
            generation: currentState.generation + 1,
            error: null,
          };
        },
      },
    ),
  );
}

export const useQueueContinuationStore = createQueueContinuationStore();

export function startQueueContinuation(input: StartQueueContinuationInput) {
  useQueueContinuationStore.getState().start(input);
}

export function stopQueueContinuation() {
  useQueueContinuationStore.getState().stop();
}
