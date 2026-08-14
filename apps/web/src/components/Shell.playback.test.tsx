import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { usePlayerStore } from "../store/player-store";
import type { Track } from "../types";
import { Shell } from "./Shell";

vi.mock("./Player", () => ({ Player: () => null }));

const mountedRoots: Root[] = [];

function makeTrack(): Track {
  return {
    external_id: "current-track",
    title: "Current Track",
    artist: "Demo Artist",
    cover_url: "https://example.com/current.jpg",
    stream_url: "https://cdn.example.com/current.m4a",
    duration_seconds: 180,
  };
}

function renderShell() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);

  act(() => {
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

function dispatchSpace(target: EventTarget, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: " ",
    code: "Space",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function arrangeCurrentTrack() {
  usePlayerStore.getState().replaceQueue([makeTrack()], 0, true);
  const togglePlayback = vi.fn();
  usePlayerStore.setState({
    togglePlayback,
    user: {
      id: "user-1",
      email: "listener@example.com",
      created_at: "2026-08-14T00:00:00Z",
    },
  });
  return togglePlayback;
}

afterEach(() => {
  while (mountedRoots.length) {
    act(() => mountedRoots.pop()?.unmount());
  }
  document.body.replaceChildren();
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  vi.restoreAllMocks();
});

describe("Shell playback keyboard shortcut", () => {
  it("toggles the current track and prevents page scrolling on Space", () => {
    const togglePlayback = arrangeCurrentTrack();
    const container = renderShell();
    const event = dispatchSpace(container.querySelector("main")!);

    expect(event.defaultPrevented).toBe(true);
    expect(togglePlayback).toHaveBeenCalledTimes(1);
  });

  it("does not toggle repeatedly while Space is held, but still prevents scrolling", () => {
    const togglePlayback = arrangeCurrentTrack();
    const container = renderShell();
    const event = dispatchSpace(container.querySelector("main")!, { repeat: true });

    expect(event.defaultPrevented).toBe(true);
    expect(togglePlayback).not.toHaveBeenCalled();
  });

  it("leaves Space untouched inside a text input", () => {
    const togglePlayback = arrangeCurrentTrack();
    const container = renderShell();
    const input = document.createElement("input");
    container.querySelector("main")!.append(input);
    const event = dispatchSpace(input);

    expect(event.defaultPrevented).toBe(false);
    expect(togglePlayback).not.toHaveBeenCalled();
  });

  it("does nothing when no track has been selected", () => {
    const togglePlayback = vi.fn();
    usePlayerStore.setState({ togglePlayback });
    const container = renderShell();
    const event = dispatchSpace(container.querySelector("main")!);

    expect(event.defaultPrevented).toBe(false);
    expect(togglePlayback).not.toHaveBeenCalled();
  });
});
