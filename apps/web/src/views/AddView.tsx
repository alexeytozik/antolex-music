import { useRef, type InputHTMLAttributes } from "react";

import {
  CloseIcon,
  FolderIcon,
  PauseIcon,
  PlusIcon,
  RetryIcon,
  SpinnerIcon,
  UploadIcon,
} from "../components/Icons";
import { useUploadManager } from "../components/UploadManager";
import { formatFileSize } from "../lib/upload-validation";
import type { UploadQueueItem } from "../lib/upload-queue";

const AUDIO_ACCEPT = ".mp3,.m4a,.aac,.flac,.ogg,.wav";

export function AddView() {
  const {
    items,
    pageError,
    ready,
    addFiles,
    reselectFile,
    pause,
    cancel,
    retry,
    removeItem,
  } = useUploadManager();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const reselectInputRef = useRef<HTMLInputElement | null>(null);
  const reselectTargetRef = useRef<string | null>(null);
  const needsFileCount = items.filter((item) => item.status === "needs_file").length;

  function chooseReplacement(item: UploadQueueItem) {
    reselectTargetRef.current = item.localId;
    reselectInputRef.current?.click();
  }

  return (
    <section className="view-stack" aria-labelledby="add-heading">
      <div className="view-heading">
        <div><p className="eyebrow">Your library</p><h1 id="add-heading">Add music</h1></div>
      </div>

      <div className="upload-picker" aria-busy={!ready}>
        <UploadIcon className="h-8 w-8" />
        {needsFileCount > 0 ? (
          <div>
            <strong>Resume {needsFileCount} waiting {needsFileCount === 1 ? "file" : "files"}</strong>
            <p>Reselect the original batch and matching uploads will continue.</p>
          </div>
        ) : (
          <div><strong>Choose music from this device</strong><p>Up to 50 files · 50 MB each</p></div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={AUDIO_ACCEPT}
          hidden
          disabled={!ready}
          onChange={(event) => {
            if (event.target.files) addFiles(event.target.files);
            event.currentTarget.value = "";
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          accept={AUDIO_ACCEPT}
          hidden
          disabled={!ready}
          onChange={(event) => {
            if (event.target.files) addFiles(event.target.files);
            event.currentTarget.value = "";
          }}
          {...({ webkitdirectory: "" } as InputHTMLAttributes<HTMLInputElement>)}
        />
        <input
          ref={reselectInputRef}
          type="file"
          accept={AUDIO_ACCEPT}
          hidden
          disabled={!ready}
          onChange={(event) => {
            const targetId = reselectTargetRef.current;
            const file = event.target.files?.[0];
            if (targetId && file) reselectFile(targetId, file);
            reselectTargetRef.current = null;
            event.currentTarget.value = "";
          }}
        />
        <div className="upload-actions">
          <button className="primary-button" type="button" disabled={!ready} onClick={() => fileInputRef.current?.click()}>
            <PlusIcon className="h-5 w-5" /> {needsFileCount > 0 ? "Reselect batch" : "Select files"}
          </button>
          <button className="secondary-button desktop-only" type="button" disabled={!ready} onClick={() => folderInputRef.current?.click()}>
            <FolderIcon className="h-5 w-5" /> {needsFileCount > 0 ? "Reselect folder" : "Select folder"}
          </button>
        </div>
      </div>

      {pageError && <p className="notice notice-error">{pageError}</p>}
      <div className="upload-list">
        {items.map((item) => (
          <article key={item.localId} className="upload-row">
            <div className={`upload-state state-${item.status}`}>
              {item.status === "hashing" || item.status === "uploading" || item.status === "processing" || item.status === "cancelling" ? <SpinnerIcon className="h-5 w-5 animate-spin" /> : <UploadIcon className="h-5 w-5" />}
            </div>
            <div className="upload-copy">
              <strong>{item.fileName}</strong>
              <span>{formatFileSize(item.sizeBytes)} · {item.status.replace("_", " ")}</span>
              {item.error && <p className="upload-error">{item.error}</p>}
              {item.status === "duplicate" && <p className="upload-duplicate">Already in library{item.duplicateTrack ? ` as “${item.duplicateTrack.title}”` : ""}.</p>}
              {["hashing", "uploading"].includes(item.status) && <div className="upload-progress"><span style={{ width: `${Math.round(item.progress * 100)}%` }} /></div>}
            </div>
            <div className="upload-row-actions">
              {(item.status === "hashing" || item.status === "uploading") && <button className="icon-button" type="button" onClick={() => pause(item)} aria-label="Pause"><PauseIcon className="h-5 w-5" /></button>}
              {(item.status === "paused" || item.status === "error") && <button className="icon-button" type="button" onClick={() => void retry(item)} aria-label="Retry"><RetryIcon className="h-5 w-5" /></button>}
              {item.status === "needs_file" && <button className="secondary-button compact" type="button" onClick={() => chooseReplacement(item)}>Reselect this file</button>}
              {item.status === "duplicate" && <button className="icon-button" type="button" onClick={() => removeItem(item.localId)} aria-label="Dismiss duplicate"><CloseIcon className="h-5 w-5" /></button>}
              {["queued", "needs_file", "hashing", "uploading", "paused", "error"].includes(item.status) && <button className="icon-button danger" type="button" onClick={() => void cancel(item)} aria-label="Cancel and remove"><CloseIcon className="h-5 w-5" /></button>}
            </div>
          </article>
        ))}
      </div>
      {!ready && <div className="empty-state"><SpinnerIcon className="h-8 w-8 animate-spin" /><p>Restoring upload queue…</p></div>}
      {ready && items.length === 0 && <div className="empty-state"><UploadIcon className="h-8 w-8" /><p>Your upload queue will appear here.</p></div>}
    </section>
  );
}
