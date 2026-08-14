import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { usePlayerStore } from "../store/player-store";
import { Shell } from "./Shell";

vi.mock("./Player", () => ({ Player: () => null }));

const mountedRoots: Root[] = [];

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
});
