import { describe, expect, it } from "vitest";

import {
  formatFileSize,
  MAX_UPLOAD_SIZE,
  validateUploadFile,
} from "./upload-validation";

describe("upload validation", () => {
  it.each(["song.mp3", "song.M4A", "song.aac", "song.flac", "song.ogg", "song.wav"])(
    "accepts %s",
    (name) => expect(validateUploadFile({ name, size: 1024 })).toBeNull(),
  );

  it("rejects unsupported files", () => {
    expect(validateUploadFile({ name: "archive.zip", size: 1024 })).toMatch(/MP3/);
  });

  it("accepts a file at the 50 MB limit", () => {
    expect(
      validateUploadFile({ name: "limit.flac", size: MAX_UPLOAD_SIZE }),
    ).toBeNull();
  });

  it("rejects files above 50 MB", () => {
    expect(
      validateUploadFile({ name: "huge.flac", size: MAX_UPLOAD_SIZE + 1 }),
    ).toBe("The file is larger than 50 MB");
  });

  it("formats sizes for the upload list", () => {
    expect(formatFileSize(8 * 1024 * 1024)).toBe("8.0 MB");
  });
});
