// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod/v4";
import { DefaultBackend, stripGrammarUnfriendlyConstraints } from "@/lib/backend";

// getObject() is the single chokepoint where every constrained-generation
// result is parsed. Because llama.cpp can silently ignore object schemas
// (issues #11988/#21228), the parse MUST fail with a clear, diagnosable
// error rather than a cryptic Zod issue array. We spy on getResponse so the
// streaming/fetch machinery is bypassed and we can feed exact responses.

const schema = z.object({ name: z.string(), kind: z.enum(["alpha", "beta", "gamma"]) });
const prompt = { system: "s", user: "u" };

describe("DefaultBackend.getObject error reporting", () => {
  let backend: DefaultBackend;

  beforeEach(() => {
    backend = new DefaultBackend();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the parsed object when the response matches the schema", async () => {
    vi.spyOn(backend, "getResponse").mockResolvedValue('{"name":"Aria","kind":"beta"}');
    await expect(backend.getObject(prompt, schema)).resolves.toEqual({ name: "Aria", kind: "beta" });
  });

  it("throws a clear, human-readable error when the model returns {}", async () => {
    // The original symptom: silent constraint collapse yields an empty object,
    // which produced a truncated, unreadable Zod issue array.
    vi.spyOn(backend, "getResponse").mockResolvedValue("{}");
    await expect(backend.getObject(prompt, schema)).rejects.toThrow(/did not match the expected schema/);
    await expect(backend.getObject(prompt, schema)).rejects.toThrow(/structured output/i);
    await expect(backend.getObject(prompt, schema)).rejects.toThrow(/Got: "{}"/);
  });

  it("throws a clear error (not raw Zod) when the response is a wrong-shaped object", async () => {
    vi.spyOn(backend, "getResponse").mockResolvedValue('{"character":{"name":"Aria","kind":"beta"}}');
    await expect(backend.getObject(prompt, schema)).rejects.toThrow(/did not match the expected schema/);
  });

  it("throws a clear error when the response is not valid JSON at all", async () => {
    vi.spyOn(backend, "getResponse").mockResolvedValue("not json, just prose");
    await expect(backend.getObject(prompt, schema)).rejects.toThrow(/did not return valid JSON/);
    await expect(backend.getObject(prompt, schema)).rejects.toThrow(/Got: "not json, just prose"/);
  });

  it("truncates a very long response in the error message", async () => {
    vi.spyOn(backend, "getResponse").mockResolvedValue(`{"wrong":"${"x".repeat(1000)}"}`);
    await expect(backend.getObject(prompt, schema)).rejects.toThrow(/did not match the expected schema/);
    // The preview is capped; a 1000-char body must not appear in full.
    await expect(backend.getObject(prompt, schema)).rejects.not.toThrow(`x`.repeat(1000));
  });
});

// stripGrammarUnfriendlyConstraints removes the length/pattern keywords that make
// llama.cpp silently abandon grammar enforcement (issue #21228). Reproduced live:
// RawCharacter with min/maxLength = 0/3 enforced; without = 3/3 enforced.
describe("stripGrammarUnfriendlyConstraints", () => {
  it("removes minLength, maxLength, and pattern recursively", () => {
    const input = {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 100 },
        bio: { type: "string", maxLength: 2000, pattern: "^[a-z]+$" },
      },
      required: ["name", "bio"],
      additionalProperties: false,
    };
    expect(stripGrammarUnfriendlyConstraints(input)).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        bio: { type: "string" },
      },
      required: ["name", "bio"],
      additionalProperties: false,
    });
  });

  it("preserves structural keywords: enum, required, items, additionalProperties, const", () => {
    const input = {
      type: "object",
      properties: {
        gender: { type: "string", enum: ["male", "female"] },
      },
      required: ["gender"],
      additionalProperties: false,
    };
    expect(stripGrammarUnfriendlyConstraints(input)).toEqual(input);
  });

  it("descends into nested objects and arrays", () => {
    const input = {
      type: "array",
      items: { type: "string", maxLength: 5 },
    };
    expect(stripGrammarUnfriendlyConstraints(input)).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  it("does not mutate the input", () => {
    const input = { type: "string", maxLength: 100 };
    stripGrammarUnfriendlyConstraints(input);
    expect(input).toEqual({ type: "string", maxLength: 100 });
  });
});

describe("DefaultBackend.getObject grammar-friendly payload", () => {
  let backend: DefaultBackend;
  beforeEach(() => {
    backend = new DefaultBackend();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("strips length constraints from the response_format schema sent to the server", async () => {
    // Mirrors waidrin's real Character schema (Name.max(100), Description.max(2000)).
    const heavy = z.object({
      name: z.string().min(1).max(100),
      biography: z.string().min(1).max(2000),
      gender: z.enum(["male", "female"]),
    });
    const spy = vi.spyOn(backend, "getResponse").mockResolvedValue('{"name":"A","biography":"B","gender":"male"}');

    await backend.getObject(prompt, heavy);

    const sentParams = spy.mock.calls[0][1] as {
      response_format?: { json_schema?: { schema?: Record<string, unknown> } };
    };
    const schemaNode = sentParams.response_format?.json_schema?.schema;
    expect(JSON.stringify(schemaNode)).not.toContain("maxLength");
    expect(JSON.stringify(schemaNode)).not.toContain("minLength");
    // Enum and required survive so the model is still structurally constrained.
    expect(JSON.stringify(schemaNode)).toContain('"male"');
    expect(JSON.stringify(schemaNode)).toContain('"required"');
  });
});
