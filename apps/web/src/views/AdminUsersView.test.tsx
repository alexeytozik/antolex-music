import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../lib/api";
import type { AccessStatus, AdminUser } from "../types";
import { AdminUsersView } from "./AdminUsersView";

const mountedRoots: Root[] = [];

const readyHLSBackfill = {
  summary: {
    ready_tracks: 12,
    hls_ready: 12,
    preparing: 0,
    failed: 0,
    missing: 0,
    complete: true,
  },
  failures: [],
};

function makeUser(
  id: string,
  access_status: AccessStatus,
  overrides: Partial<AdminUser> = {},
): AdminUser {
  return {
    id,
    email: `${id}@example.com`,
    access_status,
    is_admin: false,
    created_at: "2026-08-14T00:00:00Z",
    ...overrides,
  };
}

async function renderView() {
  const container = document.createElement("div");
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(<AdminUsersView />);
  });
  return container;
}

afterEach(() => {
  while (mountedRoots.length) {
    act(() => mountedRoots.pop()?.unmount());
  }
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(api, "getAdminHLSBackfill").mockResolvedValue(readyHLSBackfill);
});

describe("AdminUsersView", () => {
  it("shows access states and applies an approval returned by the API", async () => {
    const pending = makeUser("pending-user", "pending");
    const owner = makeUser("owner", "active", {
      email: "owner@example.com",
      is_admin: true,
    });
    vi.spyOn(api, "getAdminUsers").mockResolvedValue({
      results: [pending, owner, makeUser("blocked-user", "blocked")],
    });
    const update = vi.spyOn(api, "updateAdminUserStatus").mockResolvedValue({
      ...pending,
      access_status: "active",
      updated_at: "2026-08-15T00:00:00Z",
    });

    const container = await renderView();

    expect(container.textContent).toContain("Pending");
    expect(container.textContent).toContain("Blocked");
    expect(container.textContent).toContain("Owner");
    expect(container.textContent).toContain("Protected account");

    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Approve pending-user@example.com"]',
      )!.click();
    });

    expect(update).toHaveBeenCalledWith("pending-user", "active");
    expect(container.querySelector('[aria-label="Approve pending-user@example.com"]')).toBeNull();
    expect(container.querySelector('[aria-label="Block pending-user@example.com"]')).not.toBeNull();
  });

  it("loads and deduplicates the next cursor page", async () => {
    const first = makeUser("first", "active");
    const second = makeUser("second", "pending");
    const list = vi.spyOn(api, "getAdminUsers")
      .mockResolvedValueOnce({ results: [first], next_cursor: "next-page" })
      .mockResolvedValueOnce({ results: [first, second] });

    const container = await renderView();

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".admin-load-more")!.click();
    });

    expect(list).toHaveBeenNthCalledWith(2, "next-page", expect.any(AbortSignal));
    expect(container.querySelectorAll(".admin-user-row")).toHaveLength(2);
    expect(container.textContent).toContain("second@example.com");
    expect(container.textContent).toContain("All users loaded.");
  });

  it("keeps a row actionable and displays the API error when an update fails", async () => {
    const active = makeUser("active-user", "active");
    vi.spyOn(api, "getAdminUsers").mockResolvedValue({ results: [active] });
    vi.spyOn(api, "updateAdminUserStatus").mockRejectedValue(new Error("Access update failed"));

    const container = await renderView();

    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Block active-user@example.com"]',
      )!.click();
    });

    expect(container.textContent).toContain("Access update failed");
    expect(container.querySelector<HTMLButtonElement>(
      '[aria-label="Block active-user@example.com"]',
    )!.disabled).toBe(false);
  });

  it("shows terminal HLS failures and queues an owner retry", async () => {
    vi.spyOn(api, "getAdminUsers").mockResolvedValue({ results: [] });
    const loadHLS = vi.mocked(api.getAdminHLSBackfill);
    loadHLS
      .mockReset()
      .mockResolvedValueOnce({
        summary: {
          ready_tracks: 12,
          hls_ready: 10,
          preparing: 1,
          failed: 1,
          missing: 0,
          complete: false,
        },
        failures: [{
          track_id: "failed-track",
          external_id: "failed-external-track",
          title: "Broken song",
          artist: "Test artist",
          attempts: 6,
          error: "ffmpeg packaging failed",
          failed_at: "2026-08-18T10:00:00Z",
        }],
      })
      .mockResolvedValueOnce(readyHLSBackfill);
    const retryHLS = vi.spyOn(api, "retryAdminHLSBackfill").mockResolvedValue({
      track_id: "failed-track",
      status: "pending",
      message: "HLS preparation is queued.",
    });

    const container = await renderView();

    expect(container.textContent).toContain("Broken song");
    expect(container.textContent).toContain("Preparation stopped after 6 attempts.");
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.querySelector("details")?.textContent).toContain("ffmpeg packaging failed");

    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Retry HLS preparation for Broken song"]',
      )!.click();
    });

    expect(retryHLS).toHaveBeenCalledWith("failed-track");
    expect(loadHLS).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain(
      "All tracks are ready for continuous background playback.",
    );
    expect(container.textContent).not.toContain("Broken song");
  });

  it("keeps an HLS failure actionable when retrying fails", async () => {
    vi.spyOn(api, "getAdminUsers").mockResolvedValue({ results: [] });
    vi.mocked(api.getAdminHLSBackfill).mockResolvedValue({
      summary: {
        ready_tracks: 1,
        hls_ready: 0,
        preparing: 0,
        failed: 1,
        missing: 0,
        complete: false,
      },
      failures: [{
        track_id: "failed-track",
        external_id: "failed-external-track",
        title: "Broken song",
        artist: "Test artist",
        attempts: 6,
        error: "ffmpeg packaging failed",
        failed_at: "2026-08-18T10:00:00Z",
      }],
    });
    vi.spyOn(api, "retryAdminHLSBackfill").mockRejectedValue(
      new Error("The worker is temporarily unavailable."),
    );

    const container = await renderView();
    const retry = container.querySelector<HTMLButtonElement>(
      '[aria-label="Retry HLS preparation for Broken song"]',
    )!;

    await act(async () => retry.click());

    expect(container.textContent).toContain("The worker is temporarily unavailable.");
    expect(retry.disabled).toBe(false);
  });
});
