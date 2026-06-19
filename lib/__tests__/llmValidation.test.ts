// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { validateApiUrl, validateRequestBody } from "@/lib/server/llmValidation";

// validateApiUrl is the SSRF guard for the LLM proxy. A regression here lets a
// client pivot to cloud metadata endpoints, so we lock down each rejection rule.

describe("validateApiUrl", () => {
  it("accepts well-formed HTTP and HTTPS URLs", () => {
    expect(validateApiUrl("http://localhost:8080/v1/")).toBeNull();
    expect(validateApiUrl("https://example.com/api")).toBeNull();
  });

  it("rejects malformed URLs", () => {
    expect(validateApiUrl("not a url")).toBe("Invalid URL format");
    expect(validateApiUrl("")).toBe("Invalid URL format");
  });

  it("rejects non-HTTP schemes", () => {
    expect(validateApiUrl("file:///etc/passwd")).toBe("Only HTTP and HTTPS URLs are allowed");
    expect(validateApiUrl("ftp://example.com")).toBe("Only HTTP and HTTPS URLs are allowed");
  });

  it("blocks the AWS/GCP metadata endpoints exactly", () => {
    expect(validateApiUrl("http://169.254.169.254/latest/meta-data")).toMatch(/not allowed/);
    expect(validateApiUrl("http://metadata.google.internal")).toMatch(/not allowed/);
  });

  it("blocks subdomains of the metadata endpoints", () => {
    // foo.metadata.google.internal is the real subdomain SSRF vector and is rejected by the list.
    expect(validateApiUrl("http://foo.metadata.google.internal")).toMatch(/not allowed/);
    // A dotted-quad that looks like a subdomain of the metadata IP is also rejected,
    // but by the URL parser (it is not a valid hostname) rather than the SSRF list.
    expect(validateApiUrl("http://anything.169.254.169.254")).not.toBeNull();
  });
});

describe("validateRequestBody", () => {
  const validBody = {
    apiUrl: "http://localhost:8080/v1/",
    apiKey: "k",
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  };

  it("accepts a complete, well-typed body", () => {
    expect(validateRequestBody(validBody)).toBeNull();
  });

  it("rejects non-object bodies", () => {
    expect(validateRequestBody(null)).toBe("Request body must be an object");
    expect(validateRequestBody("string")).toBe("Request body must be an object");
  });

  it("requires a string model", () => {
    expect(validateRequestBody({ ...validBody, model: "" })).toBe("Model is required");
    expect(validateRequestBody({ ...validBody, model: 5 })).toBe("Model is required");
  });

  it("requires messages to be an array", () => {
    expect(validateRequestBody({ ...validBody, messages: "nope" })).toBe("Messages must be an array");
  });

  it("requires each message to have string role and content", () => {
    expect(validateRequestBody({ ...validBody, messages: [{ role: "user" }] })).toBe(
      "Messages must contain role and content strings",
    );
    expect(validateRequestBody({ ...validBody, messages: [{ content: "hi" }] })).toBe(
      "Messages must contain role and content strings",
    );
  });
});
