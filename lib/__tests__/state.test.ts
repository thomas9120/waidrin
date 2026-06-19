// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import * as schemas from "@/lib/schemas";
import { initialState } from "@/lib/state";

// initialState is the seed for every fresh game and the default that persisted
// stores rehydrate onto. It MUST stay valid against schemas.State — otherwise
// the app crashes on import. This is the safety net for the genre work: when
// new fields are added to the schema, this test fails loudly until initialState
// is updated to match.

describe("initialState", () => {
  it("is valid against schemas.State (re-parses cleanly)", () => {
    expect(() => schemas.State.parse(initialState)).not.toThrow();
  });

  it("starts on the welcome view with empty game data", () => {
    expect(initialState.view).toBe("welcome");
    expect(initialState.locations).toEqual([]);
    expect(initialState.characters).toEqual([]);
    expect(initialState.events).toEqual([]);
    expect(initialState.actions).toEqual([]);
  });

  it("never carries a default API key", () => {
    // SECURITY contract: the seed state (and therefore anything persisted)
    // must not contain a credential. See state.ts partialize().
    expect(initialState.apiKey).toBe("");
  });

  it("uses sensible defaults for connection and content settings", () => {
    expect(initialState.contextLength).toBe(16384);
    expect(initialState.inputLength).toBe(16384);
    expect(initialState.updateInterval).toBe(200);
    expect(initialState.sexualContentLevel).toBe("regular");
    expect(initialState.violentContentLevel).toBe("regular");
  });
});
