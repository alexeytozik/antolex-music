import { afterEach, describe, expect, it, vi } from "vitest";

import { SESSION_INVALIDATED_EVENT, api } from "./api";

function errorResponse(status: number, code: string) {
  return new Response(JSON.stringify({ error: { code, message: code } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("API session invalidation", () => {
  it("notifies on unauthorized or revoked access, but not admin_required", async () => {
    const invalidated = vi.fn();
    window.addEventListener(SESSION_INVALIDATED_EVENT, invalidated);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errorResponse(401, "unauthorized"))
      .mockResolvedValueOnce(errorResponse(403, "access_pending"))
      .mockResolvedValueOnce(errorResponse(403, "access_blocked"))
      .mockResolvedValueOnce(errorResponse(403, "admin_required"));
    vi.stubGlobal("fetch", fetchMock);

    for (const code of ["unauthorized", "access_pending", "access_blocked", "admin_required"]) {
      await expect(api.getProfile()).rejects.toMatchObject({ code });
    }

    expect(invalidated).toHaveBeenCalledTimes(3);
    window.removeEventListener(SESSION_INVALIDATED_EVENT, invalidated);
  });

  it("does not expose an HTML proxy error to the interface", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html><h1>502 Bad Gateway</h1></html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    await expect(api.requestCode({ email: "person@example.com" })).rejects.toMatchObject({
      code: "request_failed",
      message: "ANTOLEX is temporarily unavailable. Please try again in a moment.",
    });
  });
});
