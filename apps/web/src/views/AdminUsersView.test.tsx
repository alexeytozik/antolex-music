import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../lib/api";
import type { AccessStatus, AdminUser } from "../types";
import { AdminUsersView } from "./AdminUsersView";

const mountedRoots: Root[] = [];

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
});
