import { current, isDraft } from "immer";
import * as z from "zod/v4";
import type { Prompt } from "./prompts";
import { getState } from "./state";

// JSON Schema keywords that llama.cpp's json-schema-to-grammar turns into large
// repetition rule sets. With a big bound (e.g. maxLength: 2000) the generated
// grammar exceeds llama.cpp's sane-repetition threshold and the server silently
// falls back to *unconstrained* generation (llama.cpp issue #21228). These are
// value-range constraints, not structural ones, and Zod still validates them on
// the parsed result, so it is safe (and necessary) to drop them from the schema
// used purely for grammar guidance.
const GRAMMAR_UNFRIENDLY_KEYS = new Set(["minLength", "maxLength", "pattern"]);

/**
 * Returns a deep copy of a JSON Schema node with the constraint keywords removed
 * that would make llama.cpp abandon grammar enforcement. Structural keywords
 * (type, enum, properties, required, items, additionalProperties, const, ...) are
 * preserved so the model is still forced into the correct shape.
 */
export function stripGrammarUnfriendlyConstraints(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripGrammarUnfriendlyConstraints);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (GRAMMAR_UNFRIENDLY_KEYS.has(key)) continue;
      out[key] = stripGrammarUnfriendlyConstraints(value);
    }
    return out;
  }
  return node;
}

export type TokenCallback = (token: string, count: number) => void;

export interface Backend {
  getNarration(prompt: Prompt, onToken?: TokenCallback): Promise<string>;

  getObject<Schema extends z.ZodType, Type extends z.infer<Schema>>(
    prompt: Prompt,
    schema: Schema,
    onToken?: TokenCallback,
  ): Promise<Type>;

  abort(): void;

  isAbortError(error: unknown): boolean;
}

export interface DefaultBackendSettings {
  apiUrl: string;
  apiKey: string;
  model: string;
  generationParams: Record<string, unknown>;
  narrationParams: Record<string, unknown>;
}

export class DefaultBackend implements Backend {
  controller = new AbortController();

  getSettings(): DefaultBackendSettings {
    return getState();
  }

  async *getResponseStream(prompt: Prompt, params: Record<string, unknown> = {}): AsyncGenerator<string> {
    try {
      const settings = this.getSettings();

      const requestPayload = {
        apiUrl: settings.apiUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        stream: true,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        max_tokens: 4096,
        max_completion_tokens: 4096,
        ...params,
      };

      const response = await fetch("/api/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
        signal: this.controller.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: "Request failed" }));
        throw new Error(
          typeof errorData.error === "string" ? errorData.error : `Request failed with status ${response.status}`,
        );
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") return;

          try {
            const parsed = JSON.parse(data);
            if (parsed.choices && parsed.choices.length > 0) {
              const content = parsed.choices[0].delta?.content;
              if (content) {
                yield content;
              }
              if (parsed.choices[0].finish_reason) {
                return;
              }
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }

      if (this.controller.signal.aborted) {
        throw new DOMException("The user aborted a request.", "AbortError");
      }
    } finally {
      this.controller = new AbortController();
    }
  }

  async getResponse(prompt: Prompt, params: Record<string, unknown> = {}, onToken?: TokenCallback): Promise<string> {
    const state = getState();

    if (state.logPrompts) {
      console.log(prompt.user);
    }

    if (state.logParams) {
      console.log(isDraft(params) ? current(params) : params);
    }

    let response = "";
    let count = 0;

    if (onToken) {
      onToken("", 0);
    }

    for await (const token of this.getResponseStream(prompt, params)) {
      response += token;
      count++;

      if (onToken) {
        onToken(token, count);
      }
    }

    if (state.logResponses) {
      console.log(response);
    }

    return response;
  }

  async getNarration(prompt: Prompt, onToken?: TokenCallback): Promise<string> {
    return await this.getResponse(prompt, this.getSettings().narrationParams, onToken);
  }

  async getObject<Schema extends z.ZodType, Type extends z.infer<Schema>>(
    prompt: Prompt,
    schema: Schema,
    onToken?: TokenCallback,
  ): Promise<Type> {
    const response = await this.getResponse(
      prompt,
      {
        ...this.getSettings().generationParams,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "schema",
            strict: true,
            // Strip length/pattern constraints: large bounds make llama.cpp's
            // grammar generator silently give up and run unconstrained (#21228).
            // Structural shape (types, enums, required keys) is preserved, and the
            // full schema is still validated against the response below.
            schema: stripGrammarUnfriendlyConstraints(z.toJSONSchema(schema)),
          },
        },
      },
      onToken,
    );

    // Some llama.cpp builds silently ignore `response_format` for object schemas
    // and fall back to unconstrained generation (see llama.cpp issues #11988/#21228).
    // That yields malformed/empty JSON here. Detect it explicitly and surface the
    // actual response so the failure is diagnosable instead of a cryptic Zod error.
    let parsed: unknown;
    try {
      parsed = JSON.parse(response);
    } catch {
      throw new Error(
        `The model did not return valid JSON. The server may not be enforcing structured output. Got: "${previewResponse(response)}"`,
      );
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `The model's response did not match the expected schema. The server may not be enforcing structured output (JSON-schema constraints). Got: "${previewResponse(response)}"`,
      );
    }
    return result.data as Type;
  }

  abort(): void {
    this.controller.abort();
  }

  isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
  }
}

// Truncate a model response for inclusion in error messages so a runaway
// generation never produces a multi-megabyte error string.
function previewResponse(response: string): string {
  const trimmed = response.trim();
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

const defaultBackend = new DefaultBackend();

export function getBackend(): Backend {
  const state = getState();
  return Object.hasOwn(state.backends, state.activeBackend) ? state.backends[state.activeBackend] : defaultBackend;
}
