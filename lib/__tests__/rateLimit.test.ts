// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimited } from "@/lib/server/rateLimit";

// rateLimited() protects the plugin routes from a single client exhausting the
// server. We pin down the boundary (60 allowed, 61st blocked), the window reset,
// and which header is used to identify the client.

const WINDOW_MS = 60_000;

function requestWith(headers: Record<string, string>): Request {
  return new Request("https://example.test/plugins", { headers });
}

describe("rateLimited", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows the first request from a client", () => {
    expect(rateLimited(requestWith({ "x-forwarded-for": "10.0.0.1" }))).toBeNull();
  });

  it("allows up to 60 requests within the window and blocks the 61st", () => {
    const req = requestWith({ "x-forwarded-for": "10.0.0.2" });

    for (let i = 0; i < 60; i++) {
      expect(rateLimited(req)).toBeNull();
    }

    const blocked = rateLimited(req);
    expect(blocked).not.toBeNull();
    expect(blocked?.status).toBe(429);
    // 429s must carry a JSON body so the frontend can surface it cleanly.
    expect(blocked?.headers.get("content-type")).toBe("application/json");
  });

  it("resets the counter after the window elapses", () => {
    const req = requestWith({ "x-forwarded-for": "10.0.0.3" });

    // Burn the entire budget.
    for (let i = 0; i < 60; i++) {
      rateLimited(req);
    }
    expect(rateLimited(req)?.status).toBe(429);

    // Move just past the window; the next request opens a fresh window.
    vi.advanceTimersByTime(WINDOW_MS + 1);
    expect(rateLimited(req)).toBeNull();
  });

  it("keys on the first IP in x-forwarded-for (trimmed)", () => {
    // Two distinct first IPs must be tracked independently.
    const primary = requestWith({ "x-forwarded-for": "10.0.0.4, 10.0.0.9" });
    for (let i = 0; i < 60; i++) rateLimited(primary);
    expect(rateLimited(primary)?.status).toBe(429);

    // A different client (different first IP) is still within its own budget.
    expect(rateLimited(requestWith({ "x-forwarded-for": "10.0.0.5, 10.0.0.9" }))).toBeNull();
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    const req = requestWith({ "x-real-ip": "10.0.0.6" });
    for (let i = 0; i < 60; i++) {
      expect(rateLimited(req)).toBeNull();
    }
    expect(rateLimited(req)?.status).toBe(429);
  });
});
