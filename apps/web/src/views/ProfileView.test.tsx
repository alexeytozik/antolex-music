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
  const container = await renderEmailStep();

  const email = container.querySelector<HTMLInputElement>('input[type="email"]')!;
  await act(async () => setInputValue(email, "new@example.com"));
  await act(async () => {
    container.querySelector<HTMLFormElement>("form")!.requestSubmit();
  });
  const firstDigit = container.querySelector<HTMLInputElement>('[aria-label="Code digit 1"]')!;
  await act(async () => setInputValue(firstDigit, "123456"));
  return container;
}

async function renderEmailStep() {
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
  it("explains the approval flow before a first-time user requests a code", async () => {
    const container = await renderEmailStep();

    expect(container.textContent).toContain("First time here?");
    expect(container.textContent).toContain("owner must approve your account");
    expect(container.textContent).toContain("6-digit code");
  });

  it("shows a dedicated approval state with next-step guidance", async () => {
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

    expect(container.querySelector('input[type="email"]')).toBeNull();
    expect(container.textContent).toContain("Approval requested");
    expect(container.textContent).toContain("owner needs to approve");
    expect(container.textContent).toContain("After approval");
    expect(container.querySelector<HTMLButtonElement>(".auth-submit")).toBeNull();
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

    expect(container.textContent).toContain("disabled by the owner");
    expect(container.textContent).toContain("contact the owner");
    expect(container.querySelector('input[type="email"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".auth-submit")).toBeNull();
    expect(usePlayerStore.getState().user).toBeNull();
  });
});

describe("ProfileView friendly errors", () => {
  it("uses the server retry countdown and lets the user enter the previous code", async () => {
    vi.spyOn(api, "requestCode").mockRejectedValue(
      new APIError(429, {
        code: "code_rate_limited",
        message: "Please wait before requesting another code",
        details: { retry_after_seconds: 37 },
      }),
    );
    const container = await renderEmailStep();
    const email = container.querySelector<HTMLInputElement>('input[type="email"]')!;
    await act(async () => setInputValue(email, "new@example.com"));

    await act(async () => {
      container.querySelector<HTMLFormElement>("form")!.requestSubmit();
    });

    expect(container.textContent).toContain("A code was sent recently");
    expect(container.textContent).toContain("Resend in 37s");
    expect(container.querySelector('[aria-label="Code digit 1"]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".resend-button")?.disabled).toBe(true);
    expect(container.textContent).not.toContain("Please wait before requesting another code");
  });

  it("turns an invalid or expired code into actionable guidance", async () => {
    vi.spyOn(api, "verifyCode").mockRejectedValue(
      new APIError(401, {
        code: "invalid_code",
        message: "Verification code is invalid or expired",
      }),
    );
    const container = await renderCodeStep();

    await act(async () => {
      container.querySelector<HTMLFormElement>("form")!.requestSubmit();
    });

    expect(container.textContent).toContain("incorrect or has expired");
    expect(container.textContent).toContain("request a new one");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Code digit 1"]')?.value).toBe("");
  });

  it("explains what to do after too many incorrect attempts", async () => {
    vi.spyOn(api, "verifyCode").mockRejectedValue(
      new APIError(429, {
        code: "too_many_code_attempts",
        message: "Too many verification attempts",
        details: { retry_after_seconds: 23 },
      }),
    );
    const container = await renderCodeStep();

    await act(async () => {
      container.querySelector<HTMLFormElement>("form")!.requestSubmit();
    });

    expect(container.textContent).toContain("Too many incorrect attempts");
    expect(container.textContent).toContain("Request a new code");
    expect(container.textContent).toContain("Resend in 23s");
  });

  it("turns an email service failure into a safe retry message", async () => {
    vi.spyOn(api, "requestCode").mockRejectedValue(
      new APIError(503, {
        code: "email_unavailable",
        message: "smtp connection refused at mail.internal:587",
      }),
    );
    const container = await renderEmailStep();
    const email = container.querySelector<HTMLInputElement>('input[type="email"]')!;
    await act(async () => setInputValue(email, "new@example.com"));

    await act(async () => {
      container.querySelector<HTMLFormElement>("form")!.requestSubmit();
    });

    expect(container.textContent).toContain("couldn’t send the code right now");
    expect(container.textContent).not.toContain("smtp connection refused");
  });

  it("does not expose a raw network error", async () => {
    vi.spyOn(api, "requestCode").mockRejectedValue(new TypeError("Failed to fetch"));
    const container = await renderEmailStep();
    const email = container.querySelector<HTMLInputElement>('input[type="email"]')!;
    await act(async () => setInputValue(email, "new@example.com"));

    await act(async () => {
      container.querySelector<HTMLFormElement>("form")!.requestSubmit();
    });

    expect(container.textContent).toContain("Check your internet connection");
    expect(container.textContent).not.toContain("Failed to fetch");
  });
});
