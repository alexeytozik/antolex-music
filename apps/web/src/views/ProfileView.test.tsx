import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { APIError, api } from "../lib/api";
import { usePlayerStore } from "../store/player-store";
import { ProfileView } from "./ProfileView";

const mountedRoots: Root[] = [];

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function renderCodeStep() {
  vi.spyOn(api, "requestCode").mockResolvedValue();
  const container = document.createElement("div");
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <ProfileView />
      </MemoryRouter>,
    );
  });

  const email = container.querySelector<HTMLInputElement>('input[type="email"]')!;
  await act(async () => setInputValue(email, "new@example.com"));
  await act(async () => {
    container.querySelector<HTMLFormElement>("form")!.requestSubmit();
  });
  const firstDigit = container.querySelector<HTMLInputElement>('[aria-label="Code digit 1"]')!;
  await act(async () => setInputValue(firstDigit, "123456"));
  return container;
}

afterEach(() => {
  while (mountedRoots.length) {
    act(() => mountedRoots.pop()?.unmount());
  }
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  vi.restoreAllMocks();
});

describe("ProfileView access approval", () => {
  it("returns a pending user to the email step with next-step guidance", async () => {
    vi.spyOn(api, "verifyCode").mockRejectedValue(
      new APIError(403, {
        code: "access_pending",
        message: "Waiting for approval",
      }),
    );
    const container = await renderCodeStep();

    await act(async () => {
      container.querySelector<HTMLFormElement>("form")!.requestSubmit();
    });

    expect(container.querySelector('input[type="email"]')).not.toBeNull();
    expect(container.textContent).toContain("Approval requested");
    expect(container.textContent).toContain("request a new code");
    expect(usePlayerStore.getState().user).toBeNull();
  });

  it("keeps a blocked user signed out and shows an explicit error", async () => {
    vi.spyOn(api, "verifyCode").mockRejectedValue(
      new APIError(403, {
        code: "access_blocked",
        message: "Blocked",
      }),
    );
    const container = await renderCodeStep();

    await act(async () => {
      container.querySelector<HTMLFormElement>("form")!.requestSubmit();
    });

    expect(container.textContent).toContain("blocked by the owner");
    expect(container.querySelector('[aria-label="Code digit 1"]')).not.toBeNull();
    expect(usePlayerStore.getState().user).toBeNull();
  });
});
