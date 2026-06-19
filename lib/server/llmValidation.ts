// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2025  Philipp Emanuel Weidmann <pew@worldwidemann.com>

// Pure, framework-free validation helpers for the LLM proxy route.
// Kept separate from the Next.js route handler so they can be unit tested
// in isolation (the route module imports `next/server`, which is not
// available in the Vitest node environment).

const ALLOWED_SCHEMES = ["http:", "https:"];
const BLOCKED_HOSTS = ["169.254.169.254", "metadata.google.internal"];

/**
 * Validates the user-supplied LLM API URL to prevent SSRF attacks against
 * cloud metadata endpoints and non-HTTP schemes.
 * Returns an error string when the URL is rejected, or null when it is allowed.
 */
export function validateApiUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Invalid URL format";
  }

  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
    return "Only HTTP and HTTPS URLs are allowed";
  }

  const hostname = parsed.hostname.toLowerCase();
  for (const blocked of BLOCKED_HOSTS) {
    if (hostname === blocked || hostname.endsWith(`.${blocked}`)) {
      return `URL hostname "${hostname}" is not allowed`;
    }
  }

  return null;
}

interface LLMRequestBody {
  apiUrl: string;
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  [key: string]: unknown;
}

/**
 * Validates the shape of the proxied LLM request body.
 * Accepts `unknown` because this is untrusted input straight off the wire.
 * Returns an error string when the body is rejected, or null when it is allowed.
 */
export function validateRequestBody(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    return "Request body must be an object";
  }

  const b = body as LLMRequestBody;

  if (!b.model || typeof b.model !== "string") {
    return "Model is required";
  }

  if (!Array.isArray(b.messages)) {
    return "Messages must be an array";
  }

  for (const msg of b.messages) {
    if (!msg || typeof msg !== "object" || typeof msg.role !== "string" || typeof msg.content !== "string") {
      return "Messages must contain role and content strings";
    }
  }

  return null;
}
