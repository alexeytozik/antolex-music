const INTERACTIVE_TARGET_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='button']",
  "[role='checkbox']",
  "[role='combobox']",
  "[role='link']",
  "[role='menuitem']",
  "[role='option']",
  "[role='radio']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='switch']",
  "[role='tab']",
  "[role='textbox']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function isGlobalPlaybackShortcut(event: KeyboardEvent) {
  const isSpace =
    event.code === "Space" || event.key === " " || event.key === "Spacebar";
  if (
    !isSpace ||
    event.defaultPrevented ||
    event.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return false;
  }

  const path = event.composedPath();
  const elements = path.length ? path : [event.target];
  return !elements.some(
    (target) =>
      target instanceof Element &&
      (target.matches(INTERACTIVE_TARGET_SELECTOR) ||
        Boolean(target.closest(INTERACTIVE_TARGET_SELECTOR))),
  );
}
