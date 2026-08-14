import { afterEach, describe, expect, it } from "vitest";

import {
  isGlobalPlaybackShortcut,
  isSpaceKey,
} from "./playback-shortcuts";

function keyboardEvent(
  target: EventTarget,
  init: KeyboardEventInit = {},
  type = "keydown",
) {
  const event = new KeyboardEvent(type, {
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

describe("isSpaceKey", () => {
  it.each([
    ["standard key", { key: " ", code: "Space" }],
    ["physical code", { key: "Unidentified", code: "Space" }],
    ["legacy key", { key: "Spacebar", code: "" }],
  ])("recognizes Space from the %s", (_name, init) => {
    expect(isSpaceKey(keyboardEvent(document.body, init))).toBe(true);
  });

  it("rejects other keys", () => {
    expect(
      isSpaceKey(
        keyboardEvent(document.body, { key: "Enter", code: "Enter" }),
      ),
    ).toBe(false);
  });
});

describe("isGlobalPlaybackShortcut", () => {
  it("accepts Space in ordinary page content in either navigation mode", () => {
    const content = document.createElement("div");
    document.body.append(content);

    expect(isGlobalPlaybackShortcut(keyboardEvent(content), false)).toBe(true);
    expect(isGlobalPlaybackShortcut(keyboardEvent(content), true)).toBe(true);
  });

  it("accepts repeated Space so the owner can keep preventing page scroll", () => {
    expect(
      isGlobalPlaybackShortcut(
        keyboardEvent(document.body, { repeat: true }),
        false,
      ),
    ).toBe(true);
  });

  it.each([
    ["button", "button"],
    ["button role", "div"],
  ])(
    "uses Space globally on a pointer-focused %s, but preserves keyboard activation",
    (name, tagName) => {
      const element = document.createElement(tagName);
      if (name === "button role") element.setAttribute("role", "button");
      document.body.append(element);

      expect(isGlobalPlaybackShortcut(keyboardEvent(element), false)).toBe(true);
      expect(isGlobalPlaybackShortcut(keyboardEvent(element), true)).toBe(false);
    },
  );

  it("keeps Space global on links because Space is not their native activation key", () => {
    const link = document.createElement("a");
    link.href = "/add";
    document.body.append(link);

    expect(isGlobalPlaybackShortcut(keyboardEvent(link), false)).toBe(true);
    expect(isGlobalPlaybackShortcut(keyboardEvent(link), true)).toBe(true);
  });

  it("applies the focused-control rule when the event starts on a nested icon", () => {
    const button = document.createElement("button");
    const icon = document.createElement("svg");
    button.append(icon);
    document.body.append(button);

    expect(isGlobalPlaybackShortcut(keyboardEvent(icon), false)).toBe(true);
    expect(isGlobalPlaybackShortcut(keyboardEvent(icon), true)).toBe(false);
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
  ])("never steals Space from a %s", (_name, createElement) => {
    const element = createElement();
    document.body.append(element);

    expect(isGlobalPlaybackShortcut(keyboardEvent(element), false)).toBe(false);
    expect(isGlobalPlaybackShortcut(keyboardEvent(element), true)).toBe(false);
  });

  it("never steals Space from editable content or one of its children", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const child = document.createElement("span");
    editor.append(child);
    document.body.append(editor);

    expect(isGlobalPlaybackShortcut(keyboardEvent(child), false)).toBe(false);
    expect(isGlobalPlaybackShortcut(keyboardEvent(child), true)).toBe(false);
  });

  it.each([
    ["Alt", { altKey: true }],
    ["Control", { ctrlKey: true }],
    ["Meta", { metaKey: true }],
    ["Shift", { shiftKey: true }],
    ["composition", { isComposing: true }],
  ])("ignores modified and composing Space events (%s)", (_name, init) => {
    expect(
      isGlobalPlaybackShortcut(keyboardEvent(document.body, init), false),
    ).toBe(false);
  });

  it("ignores an event already handled by another component", () => {
    const event = keyboardEvent(document.body);
    event.preventDefault();

    expect(isGlobalPlaybackShortcut(event, false)).toBe(false);
  });
});
