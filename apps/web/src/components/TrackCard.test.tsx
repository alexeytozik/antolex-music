import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { usePlayerStore } from "../store/player-store";
import type { Track } from "../types";
import { TrackCard } from "./TrackCard";

const mountedRoots: Root[] = [];

function makeTrack(index: number): Track {
  return {
    external_id: `track-${index}`,
    title: `Track ${index}`,
    artist: "Demo Artist",
    album: "Demo Album",
    cover_url: `https://example.com/${index}.jpg`,
    stream_url: `https://cdn.example.com/${index}.m4a`,
    duration_seconds: 180 + index,
  };
}

function render(component: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);

  act(() => {
    root.render(<MemoryRouter>{component}</MemoryRouter>);
  });

  return container;
}

function click(element: Element | null) {
  if (!element) throw new Error("Expected element to exist");
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function arrangePlayer(currentTrack: Track, isPlaying: boolean) {
  usePlayerStore.getState().replaceQueue([currentTrack], 0, isPlaying);
  usePlayerStore.setState({
    isPlaying,
    status: isPlaying ? "playing" : "paused",
    currentTime: 42,
  });

  const originalReplaceQueue = usePlayerStore.getState().replaceQueue;
  const originalTogglePlayback = usePlayerStore.getState().togglePlayback;
  const replaceQueue = vi.fn(originalReplaceQueue);
  const togglePlayback = vi.fn(originalTogglePlayback);
  usePlayerStore.setState({ replaceQueue, togglePlayback });

  return { replaceQueue, togglePlayback };
}

afterEach(() => {
  while (mountedRoots.length) mountedRoots.pop()?.unmount();
  document.body.replaceChildren();
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  vi.restoreAllMocks();
});

describe("TrackCard playback controls", () => {
  it("pauses the current playing track without replacing or restarting its queue", () => {
    const currentTrack = makeTrack(1);
    const nextTrack = makeTrack(2);
    const { replaceQueue, togglePlayback } = arrangePlayer(currentTrack, true);
    const before = usePlayerStore.getState();
    const queueID = before.queue[before.currentIndex]?.queueId;
    const queueContextID = before.queueContextId;
    const container = render(
      <TrackCard track={currentTrack} queue={[currentTrack, nextTrack]} queueIndex={0} />,
    );
    const playButton = container.querySelector(".desktop-track-play");

    expect(playButton?.getAttribute("aria-label")).toBe("Pause Track 1");
    click(playButton);

    expect(togglePlayback).toHaveBeenCalledTimes(1);
    expect(replaceQueue).not.toHaveBeenCalled();
    expect(usePlayerStore.getState()).toMatchObject({
      currentTime: 42,
      currentIndex: 0,
      queueContextId: queueContextID,
      isPlaying: false,
      status: "paused",
    });
    expect(usePlayerStore.getState().queue[0]?.queueId).toBe(queueID);
  });

  it("resumes the current paused track without replacing or restarting its queue", () => {
    const currentTrack = makeTrack(1);
    const nextTrack = makeTrack(2);
    const { replaceQueue, togglePlayback } = arrangePlayer(currentTrack, false);
    const before = usePlayerStore.getState();
    const queueID = before.queue[before.currentIndex]?.queueId;
    const queueContextID = before.queueContextId;
    const container = render(
      <TrackCard track={currentTrack} queue={[currentTrack, nextTrack]} queueIndex={0} />,
    );
    const playButton = container.querySelector(".desktop-track-play");

    expect(playButton?.getAttribute("aria-label")).toBe("Play Track 1");
    click(playButton);

    expect(togglePlayback).toHaveBeenCalledTimes(1);
    expect(replaceQueue).not.toHaveBeenCalled();
    expect(usePlayerStore.getState()).toMatchObject({
      currentTime: 42,
      currentIndex: 0,
      queueContextId: queueContextID,
      isPlaying: true,
    });
    expect(usePlayerStore.getState().queue[0]?.queueId).toBe(queueID);
  });

  it("replaces the queue and starts playback when another track is selected", () => {
    const currentTrack = makeTrack(1);
    const selectedTrack = makeTrack(2);
    const tailTrack = makeTrack(3);
    const displayedQueue = [selectedTrack, tailTrack];
    const { replaceQueue, togglePlayback } = arrangePlayer(currentTrack, true);
    const container = render(
      <TrackCard track={selectedTrack} queue={displayedQueue} queueIndex={0} />,
    );
    const playButton = container.querySelector(".desktop-track-play");

    expect(playButton?.getAttribute("aria-label")).toBe("Play Track 2");
    click(playButton);

    expect(togglePlayback).not.toHaveBeenCalled();
    expect(replaceQueue).toHaveBeenCalledTimes(1);
    expect(replaceQueue).toHaveBeenCalledWith(displayedQueue, 0, true);
    expect(usePlayerStore.getState()).toMatchObject({
      currentIndex: 0,
      currentTime: 0,
      isPlaying: true,
    });
    expect(
      selectCurrentTrackID(),
    ).toBe(selectedTrack.external_id);
  });
});

function selectCurrentTrackID() {
  const state = usePlayerStore.getState();
  return state.queue[state.currentIndex]?.track.external_id;
}
