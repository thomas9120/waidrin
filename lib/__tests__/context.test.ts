// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { convertLocationChangeEventToText, getApproximateTokenCount, getContext } from "@/lib/context";
import { character, location, locationChangeEvent, makeState, narrationEvent } from "./fixtures";

describe("getApproximateTokenCount", () => {
  // ceil(length / 3). Locking this down matters because every budget decision
  // in getContext() is derived from it; changing the estimate silently shifts
  // how much history reaches the model.
  it("estimates tokens as ceil(length / 3)", () => {
    expect(getApproximateTokenCount("")).toBe(0);
    expect(getApproximateTokenCount("ab")).toBe(1); // ceil(2/3)
    expect(getApproximateTokenCount("abc")).toBe(1); // ceil(3/3)
    expect(getApproximateTokenCount("abcdef")).toBe(2); // ceil(6/3)
    expect(getApproximateTokenCount("abcdefg")).toBe(3); // ceil(7/3)
  });
});

describe("convertLocationChangeEventToText", () => {
  it("renders protagonist, location, and present cast in the documented format", () => {
    const state = makeState({
      protagonist: { ...character("Hero", "The protagonist"), locationIndex: 1 },
      locations: [location("Nowhere"), location("Tavern", "Cozy and warm")],
      characters: [character("Bob", "A bard"), character("Sue", "A guard")],
    });

    const text = convertLocationChangeEventToText(locationChangeEvent(1, [0, 1]), state);

    // These literal markers are part of the prompt contract the model relies on.
    expect(text).toContain("LOCATION CHANGE");
    expect(text).toContain("Hero is entering Tavern. Cozy and warm");
    expect(text).toContain("The following characters are present at Tavern:");
    expect(text).toContain("Bob: A bard");
    expect(text).toContain("Sue: A guard");
    // Present characters are separated by a blank line.
    expect(text).toContain("A bard\n\nSue: A guard");
    // The scene delimiter fence is present at both ends.
    expect(text.startsWith("-----")).toBe(true);
    expect(text.trim().endsWith("-----")).toBe(true);
  });
});

describe("getContext", () => {
  it("returns an empty string when there are no narration or location_change events", () => {
    const state = makeState({ events: [] });
    expect(getContext(state, 1000)).toBe("");
  });

  it("ignores action and character_introduction events when assembling context", () => {
    // Protects the contract that only narration/location_change feed the model.
    const state = makeState({
      locations: [location("Tavern")],
      characters: [character("Bob")],
      events: [
        locationChangeEvent(0, [0]),
        { type: "action", action: "SECRET_ACTION_TEXT" },
        { type: "character_introduction", characterIndex: 0 },
        narrationEvent("VISIBLE_NARRATION_TEXT"),
      ],
    });

    const context = getContext(state, 100000);

    expect(context).toContain("VISIBLE_NARRATION_TEXT");
    expect(context).not.toContain("SECRET_ACTION_TEXT");
  });

  it("returns the full text of all scenes when everything fits the budget", () => {
    const state = makeState({
      locations: [location("Tavern"), location("Market")],
      characters: [character("Bob")],
      events: [
        locationChangeEvent(0, [0]),
        narrationEvent("SCENE_ONE_NARRATION"),
        locationChangeEvent(1, [], "SCENE_ONE_SUMMARY"),
        narrationEvent("SCENE_TWO_NARRATION"),
      ],
    });

    const context = getContext(state, 100000);

    expect(context).toContain("SCENE_ONE_NARRATION");
    expect(context).toContain("SCENE_TWO_NARRATION");
    // Summaries are only used as a fallback, so they must NOT appear when full
    // text fits. Asserting this catches a regression that always summarizes.
    expect(context).not.toContain("SCENE_ONE_SUMMARY");
  });

  it("replaces the oldest scene with its summary when full text exceeds the budget", () => {
    const state = makeState({
      locations: [location("Tavern"), location("Market")],
      characters: [character("Bob")],
      events: [
        locationChangeEvent(0, [0]),
        narrationEvent("SCENE_ONE_NARRATION"),
        locationChangeEvent(1, [], "SCENE_ONE_SUMMARY"),
        narrationEvent("SCENE_TWO_NARRATION"),
      ],
    });

    // Budget that fits summary + scene two, but not scene one's full text.
    const summaryTokens = getApproximateTokenCount("SCENE_ONE_SUMMARY");
    const sceneTwoTokens = getApproximateTokenCount(
      `${convertLocationChangeEventToText(locationChangeEvent(1, []), state)}\n\nSCENE_TWO_NARRATION`,
    );
    const budget = summaryTokens + sceneTwoTokens;

    const context = getContext(state, budget);

    // Oldest scene is summarized away; the latest scene keeps full text.
    expect(context).toContain("SCENE_ONE_SUMMARY");
    expect(context).not.toContain("SCENE_ONE_NARRATION");
    expect(context).toContain("SCENE_TWO_NARRATION");
  });

  it("drops the oldest scene entirely when it has no summary and cannot fit", () => {
    const state = makeState({
      locations: [location("Tavern"), location("Market")],
      characters: [character("Bob")],
      events: [
        locationChangeEvent(0, [0]),
        narrationEvent("SCENE_ONE_NARRATION"),
        // No summary stored -> the oldest scene cannot be summarized, only dropped.
        locationChangeEvent(1, []),
        narrationEvent("SCENE_TWO_NARRATION"),
      ],
    });

    const sceneTwoTokens = getApproximateTokenCount(
      `${convertLocationChangeEventToText(locationChangeEvent(1, []), state)}\n\nSCENE_TWO_NARRATION`,
    );

    // Budget exactly fits only the latest scene.
    const context = getContext(state, sceneTwoTokens);

    expect(context).toContain("SCENE_TWO_NARRATION");
    expect(context).not.toContain("SCENE_ONE_NARRATION");
    expect(context).not.toContain("LOCATION CHANGE\n\nHero is entering Tavern"); // scene one's location
  });

  it("never summarizes or drops the latest scene", () => {
    // Only one scene, but a tiny budget: the latest scene must be preserved as-is
    // rather than silently truncated.
    const state = makeState({
      locations: [location("Tavern")],
      characters: [character("Bob")],
      events: [locationChangeEvent(0, [0]), narrationEvent("ONLY_NARRATION")],
    });

    const context = getContext(state, 100000);

    expect(context).toContain("ONLY_NARRATION");
  });

  it("throws when even the single current scene cannot fit the budget", () => {
    const state = makeState({
      locations: [location("Tavern")],
      characters: [character("Bob")],
      events: [locationChangeEvent(0, [0]), narrationEvent("ONLY_NARRATION")],
    });

    // This is the contract callers depend on: a too-small budget is a loud
    // failure rather than an empty or partial prompt.
    expect(() => getContext(state, 1)).toThrow("Unable to fit context within token budget even after summarization");
  });
});
