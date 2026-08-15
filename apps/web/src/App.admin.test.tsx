import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { AdminRoute, SessionInvalidationListener } from "./App";
import { SESSION_INVALIDATED_EVENT } from "./lib/api";
import { usePlayerStore } from "./store/player-store";

const mountedRoots: Root[] = [];

function renderAdminRoute() {
  const container = document.createElement("div");
  const root = createRoot(container);
  mountedRoots.push(root);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={["/admin"]}>
        <Routes>
          <Route path="/" element={<div>Library home</div>} />
          <Route path="/profile" element={<div>Sign in</div>} />
          <Route
            path="/admin"
            element={<AdminRoute ready><div>Admin users</div></AdminRoute>}
          />
        </Routes>
      </MemoryRouter>,
    );
  });
  return container;
}

afterEach(() => {
  while (mountedRoots.length) {
    act(() => mountedRoots.pop()?.unmount());
  }
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
});

describe("AdminRoute", () => {
  it("redirects a signed-in non-admin to the library", () => {
    usePlayerStore.setState({
      user: {
        id: "listener-1",
        email: "listener@example.com",
        is_admin: false,
        access_status: "active",
        created_at: "2026-08-14T00:00:00Z",
      },
    });

    const container = renderAdminRoute();

    expect(container.textContent).toBe("Library home");
  });

  it("renders the admin page for the owner", () => {
    usePlayerStore.setState({
      user: {
        id: "owner-1",
        email: "owner@example.com",
        is_admin: true,
        access_status: "active",
        created_at: "2026-08-14T00:00:00Z",
      },
    });

    const container = renderAdminRoute();

    expect(container.textContent).toBe("Admin users");
  });

  it("clears the current session when the API reports invalidation", () => {
    usePlayerStore.setState({
      user: {
        id: "listener-1",
        email: "listener@example.com",
        access_status: "active",
        created_at: "2026-08-14T00:00:00Z",
      },
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    mountedRoots.push(root);
    act(() => root.render(<SessionInvalidationListener />));

    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT));
    });

    expect(usePlayerStore.getState().user).toBeNull();
  });
});
