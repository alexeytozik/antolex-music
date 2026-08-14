const HASH_CHUNK_SIZE = 4 * 1024 * 1024;

export function hashFile(
  file: File,
  onProgress: (progress: number) => void,
  signal: AbortSignal,
) {
  return new Promise<string>((resolve, reject) => {
    const worker = new Worker(new URL("../workers/hash.worker.ts", import.meta.url), {
      type: "module",
      name: "antolex-file-hash",
    });
    const id = crypto.randomUUID();

    const cleanUp = () => {
      signal.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      cleanUp();
      reject(new DOMException("Hashing paused", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    worker.onerror = (event) => {
      cleanUp();
      reject(new Error(event.message || "Hash worker failed"));
    };
    worker.onmessage = (
      event: MessageEvent<
        | { id: string; type: "progress"; loaded: number; total: number }
        | { id: string; type: "complete"; sha256: string }
        | { id: string; type: "error"; message: string }
      >,
    ) => {
      if (event.data.id !== id) return;
      if (event.data.type === "progress") {
        onProgress(event.data.total ? event.data.loaded / event.data.total : 0);
      } else if (event.data.type === "complete") {
        cleanUp();
        resolve(event.data.sha256);
      } else {
        cleanUp();
        reject(new Error(event.data.message));
      }
    };
    worker.postMessage({ id, file, chunkSize: HASH_CHUNK_SIZE });
  });
}
