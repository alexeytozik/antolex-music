/// <reference lib="webworker" />

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

type HashRequest = { id: string; file: File; chunkSize: number };

self.onmessage = async (event: MessageEvent<HashRequest>) => {
  const { id, file, chunkSize } = event.data;
  try {
    const hash = sha256.create();
    let loaded = 0;
    while (loaded < file.size) {
      const end = Math.min(loaded + chunkSize, file.size);
      hash.update(new Uint8Array(await file.slice(loaded, end).arrayBuffer()));
      loaded = end;
      self.postMessage({ id, type: "progress", loaded, total: file.size });
    }
    self.postMessage({ id, type: "complete", sha256: bytesToHex(hash.digest()) });
  } catch (error) {
    self.postMessage({
      id,
      type: "error",
      message: error instanceof Error ? error.message : "Could not hash file",
    });
  }
};

export {};
