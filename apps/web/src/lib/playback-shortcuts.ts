const VALUE_EDITING_TARGET_SELECTOR = [
  "input",
  "select",
  "textarea",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='checkbox']",
  "[role='combobox']",
  "[role='option']",
  "[role='radio']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='switch']",
  "[role='textbox']",
].join(",");

const NATIVE_SPACE_TARGET_SELECTOR = [
  "button",
  "summary",
  "audio[controls]",
  "video[controls]",
  "[role='button']",
  "[role='menuitem']",
  "[role='tab']",
].join(",");

export function isSpaceKey(event: KeyboardEvent) {
  return event.code === "Space" || event.key === " " || event.key === "Spacebar";
}

function eventPathContains(event: KeyboardEvent, selector: string) {
  const path = event.composedPath();
  const elements = path.length ? path : [event.target];
  return elements.some(
    (target) =>
      target instanceof Element &&
      (target.matches(selector) || Boolean(target.closest(selector))),
  );
}

export function isGlobalPlaybackShortcut(
  event: KeyboardEvent,
  keyboardNavigation = false,
) {
  if (
    !isSpaceKey(event) ||
    event.defaultPrevented ||
    event.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return false;
  }

  if (eventPathContains(event, VALUE_EDITING_TARGET_SELECTOR)) return false;
  return !(
    keyboardNavigation &&
    eventPathContains(event, NATIVE_SPACE_TARGET_SELECTOR)
  );
}
