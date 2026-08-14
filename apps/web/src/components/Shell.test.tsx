import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../lib/api";
import { usePlayerStore } from "../store/player-store";
import { Shell } from "./Shell";

vi.mock("./Player", () => ({ Player: () => null }));

const mountedRoots: Root[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function renderShell() {
  const container = document.createElement("div");
  const root = createRoot(container);
  mountedRoots.push(root);
  flushSync(() => {
    root.render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<div>Library</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  });
  return container;
}

afterEach(() => {
  while (mountedRoots.length) mountedRoots.pop()?.unmount();
  usePlayerStore.setState({
    user: null,
    token: null,
    sessionExpiresAt: null,
    queue: [],
    currentIndex: -1,
  });
  vi.restoreAllMocks();
});

describe("Shell navigation", () => {
  it("shows exactly the three library destinations for a signed-in user", () => {
    usePlayerStore.setState({
      user: {
        id: "user-1",
        email: "listener@example.com",
        created_at: "2026-08-14T00:00:00Z",
      },
    });

    const container = renderShell();
    const bottomLinks = Array.from(container.querySelectorAll(".bottom-nav a"));

    expect(container.querySelector('[aria-label="Signed in as listener@example.com. Sign out"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Signed in");
    expect(container.textContent).toContain("Sign out");
    expect(bottomLinks.map((link) => link.textContent)).toEqual(["Search", "Liked", "Add"]);
    expect(container.querySelector('[href="/profile"]')).toBeNull();
    expect(container.textContent).not.toContain("Profile");
  });

  it("keeps authentication in the header for a guest", () => {
    const container = renderShell();

    expect(container.querySelector('[href="/profile"][aria-label="Sign in"]')).not.toBeNull();
    expect(container.textContent).toContain("Sign in");
    expect(container.querySelector('[aria-label="Main navigation"]')).toBeNull();
  });

  it("clears the local session before the remote logout request settles", async () => {
    const logout = deferred<void>();
    vi.spyOn(api, "logout").mockReturnValue(logout.promise);
    usePlayerStore.setState({
      user: {
        id: "user-1",
        email: "listener@example.com",
        created_at: "2026-08-14T00:00:00Z",
      },
    });
    const container = renderShell();

    flushSync(() => {
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Signed in as listener@example.com. Sign out"]',
      )!.click();
    });

    expect(api.logout).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().user).toBeNull();
    expect(container.querySelector('[href="/profile"][aria-label="Sign in"]')).not.toBeNull();

    await act(async () => {
      logout.resolve();
      await logout.promise;
    });
  });
});
