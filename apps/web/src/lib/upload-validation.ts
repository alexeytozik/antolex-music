export const MAX_UPLOAD_FILES = 50;
export const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;
export const MULTIPART_PART_SIZE = 8 * 1024 * 1024;

const SUPPORTED_EXTENSIONS = new Set([
  "mp3",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "wav",
]);

export function validateUploadFile(file: Pick<File, "name" | "size">) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    return "Use MP3, M4A, AAC, FLAC, OGG or WAV";
  }
  if (file.size <= 0) return "The file is empty";
  if (file.size > MAX_UPLOAD_SIZE) return "The file is larger than 50 MB";
  return null;
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}
