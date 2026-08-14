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

function dispatchKey(
  target: EventTarget,
  type: "keydown" | "keyup",
  init: KeyboardEventInit = {},
) {
  const event = new KeyboardEvent(type, {
    key: " ",
    code: "Space",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function dispatchSpace(target: EventTarget, init: KeyboardEventInit = {}) {
  const keydown = dispatchKey(target, "keydown", init);
  const keyup = dispatchKey(target, "keyup", init);
  return { keydown, keyup };
}

function markPointerNavigation(target: EventTarget) {
  target.dispatchEvent(
    new Event("pointerdown", { bubbles: true, cancelable: true }),
  );
}

function markKeyboardNavigation(target: EventTarget) {
  dispatchKey(target, "keydown", { key: "Tab", code: "Tab" });
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
  it("toggles from ordinary page content and prevents Space scrolling", () => {
    const togglePlayback = arrangeCurrentTrack();
    const container = renderShell();
    const events = dispatchSpace(container.querySelector("main")!);

    expect(events.keydown.defaultPrevented).toBe(true);
    expect(events.keyup.defaultPrevented).toBe(true);
    expect(togglePlayback).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Add link", (container: HTMLElement) => container.querySelector<HTMLElement>(".desktop-nav a[href='/add']")!],
    ["button", (container: HTMLElement) => {
      const button = document.createElement("button");
      container.querySelector("main")!.append(button);
      return button;
    }],
  ])(
    "treats Space on a pointer-focused %s as one global play/pause command",
    (_name, findTarget) => {
      const togglePlayback = arrangeCurrentTrack();
      const container = renderShell();
      const target = findTarget(container);
      markPointerNavigation(target);
      target.focus();

      const events = dispatchSpace(target);

      expect(events.keydown.defaultPrevented).toBe(true);
      expect(events.keyup.defaultPrevented).toBe(true);
      expect(togglePlayback).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves native Space activation for a button reached with Tab", () => {
    const togglePlayback = arrangeCurrentTrack();
    const container = renderShell();
    const button = document.createElement("button");
    container.querySelector("main")!.append(button);
    markKeyboardNavigation(document.body);
    button.focus();

    const events = dispatchSpace(button);

    expect(events.keydown.defaultPrevented).toBe(false);
    expect(events.keyup.defaultPrevented).toBe(false);
    expect(togglePlayback).not.toHaveBeenCalled();
  });

  it("keeps Space as global play/pause on a link reached with Tab", () => {
    const togglePlayback = arrangeCurrentTrack();
    const container = renderShell();
    const link = container.querySelector<HTMLElement>(".desktop-nav a[href='/add']")!;
    markKeyboardNavigation(document.body);
    link.focus();

    const events = dispatchSpace(link);

    expect(events.keydown.defaultPrevented).toBe(true);
    expect(events.keyup.defaultPrevented).toBe(true);
    expect(togglePlayback).toHaveBeenCalledTimes(1);
  });

  it("does not toggle repeatedly while Space is held and becomes ready after keyup", () => {
    const togglePlayback = arrangeCurrentTrack();
    const container = renderShell();
    const target = container.querySelector("main")!;

    const first = dispatchKey(target, "keydown");
    const repeated = dispatchKey(target, "keydown", { repeat: true });
    const released = dispatchKey(target, "keyup");
    const second = dispatchKey(target, "keydown");
    dispatchKey(target, "keyup");

    expect(first.defaultPrevented).toBe(true);
    expect(repeated.defaultPrevented).toBe(true);
    expect(released.defaultPrevented).toBe(true);
    expect(togglePlayback).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["text input", () => Object.assign(document.createElement("input"), { type: "text" })],
    ["search input", () => Object.assign(document.createElement("input"), { type: "search" })],
    ["email input", () => Object.assign(document.createElement("input"), { type: "email" })],
    ["one-time-code input", () => {
      const input = document.createElement("input");
      input.autocomplete = "one-time-code";
      input.inputMode = "numeric";
      return input;
    }],
    ["textarea", () => document.createElement("textarea")],
    ["select", () => document.createElement("select")],
    ["range", () => Object.assign(document.createElement("input"), { type: "range" })],
    ["contenteditable", () => {
      const editor = document.createElement("div");
      editor.setAttribute("contenteditable", "true");
      return editor;
    }],
  ])("leaves Space untouched in a %s", (_name, createTarget) => {
    const togglePlayback = arrangeCurrentTrack();
    const container = renderShell();
    const target = createTarget();
    container.querySelector("main")!.append(target);
    markPointerNavigation(target);
    target.focus();

    const events = dispatchSpace(target);

    expect(events.keydown.defaultPrevented).toBe(false);
    expect(events.keyup.defaultPrevented).toBe(false);
    expect(togglePlayback).not.toHaveBeenCalled();
  });

  it("leaves Space untouched when a user has no current track", () => {
    const togglePlayback = vi.fn();
    usePlayerStore.setState({
      togglePlayback,
      user: {
        id: "user-1",
        email: "listener@example.com",
        created_at: "2026-08-14T00:00:00Z",
      },
    });
    const container = renderShell();
    const events = dispatchSpace(container.querySelector("main")!);

    expect(events.keydown.defaultPrevented).toBe(false);
    expect(events.keyup.defaultPrevented).toBe(false);
    expect(togglePlayback).not.toHaveBeenCalled();
  });

  it("leaves Space untouched when there is no signed-in user", () => {
    usePlayerStore.getState().replaceQueue([makeTrack()], 0, true);
    const togglePlayback = vi.fn();
    usePlayerStore.setState({ togglePlayback, user: null });
    const container = renderShell();
    const events = dispatchSpace(container.querySelector("main")!);

    expect(events.keydown.defaultPrevented).toBe(false);
    expect(events.keyup.defaultPrevented).toBe(false);
    expect(togglePlayback).not.toHaveBeenCalled();
  });

  it("resets a held Space when the window loses focus", () => {
    const togglePlayback = arrangeCurrentTrack();
    const container = renderShell();
    const target = container.querySelector("main")!;

    const first = dispatchKey(target, "keydown");
    window.dispatchEvent(new Event("blur"));
    const second = dispatchKey(target, "keydown");
    dispatchKey(target, "keyup");

    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(togglePlayback).toHaveBeenCalledTimes(2);
  });
});
