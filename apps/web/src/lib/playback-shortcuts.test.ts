import { afterEach, describe, expect, it } from "vitest";

import { isGlobalPlaybackShortcut } from "./playback-shortcuts";

function keyboardEvent(
  target: EventTarget,
  init: KeyboardEventInit = {},
) {
  const event = new KeyboardEvent("keydown", {
    key: " ",
    code: "Space",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  Object.defineProperty(event, "target", { value: target });
  return event;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("isGlobalPlaybackShortcut", () => {
  it("accepts one unmodified Space press in non-interactive page content", () => {
    const content = document.createElement("div");
    document.body.append(content);

    expect(isGlobalPlaybackShortcut(keyboardEvent(content))).toBe(true);
  });

  it("accepts repeated Space so the owner can keep preventing page scroll", () => {
    const content = document.createElement("div");
    document.body.append(content);

    expect(
      isGlobalPlaybackShortcut(keyboardEvent(content, { repeat: true })),
    ).toBe(true);
  });

  it.each([
    ["input", "input"],
    ["textarea", "textarea"],
    ["select", "select"],
    ["button", "button"],
    ["link", "a"],
  ])("does not steal Space from a focused %s", (_name, tagName) => {
    const element = document.createElement(tagName);
    if (element instanceof HTMLAnchorElement) element.href = "/liked";
    document.body.append(element);

    expect(isGlobalPlaybackShortcut(keyboardEvent(element))).toBe(false);
  });

  it("does not steal Space from an icon nested inside an interactive control", () => {
    const button = document.createElement("button");
    const icon = document.createElement("svg");
    button.append(icon);
    document.body.append(button);

    expect(isGlobalPlaybackShortcut(keyboardEvent(icon))).toBe(false);
  });

  it("does not steal Space from editable content", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const child = document.createElement("span");
    editor.append(child);
    document.body.append(editor);

    expect(isGlobalPlaybackShortcut(keyboardEvent(child))).toBe(false);
  });

  it.each([
    ["Alt", { altKey: true }],
    ["Control", { ctrlKey: true }],
    ["Meta", { metaKey: true }],
    ["Shift", { shiftKey: true }],
    ["composition", { isComposing: true }],
  ])("ignores modified and composing Space events (%s)", (_name, init) => {
    const content = document.createElement("div");
    document.body.append(content);

    expect(isGlobalPlaybackShortcut(keyboardEvent(content, init))).toBe(false);
  });

  it("ignores keys other than Space", () => {
    expect(
      isGlobalPlaybackShortcut(
        keyboardEvent(document.body, { key: "Enter", code: "Enter" }),
      ),
    ).toBe(false);
  });

  it("ignores an event already handled by another component", () => {
    const event = keyboardEvent(document.body);
    event.preventDefault();

    expect(isGlobalPlaybackShortcut(event)).toBe(false);
  });
});
