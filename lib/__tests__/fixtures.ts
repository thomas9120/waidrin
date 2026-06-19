// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared test fixtures for the headless engine unit tests.

import { initialState, type LocationChangeEvent, type NarrationEvent, type State } from "@/lib/state";

/**
 * Build a schema-valid `State` by cloning the real `initialState` and applying
 * top-level overrides. Use this instead of hand-writing a full State object:
 * as fields are added to schemas.State (e.g. for new genres), every fixture
 * stays valid automatically.
 */
export function makeState(overrides: Partial<State> = {}): State {
  return { ...structuredClone(initialState), ...overrides };
}

/** A minimal, deterministic location used by context/prompt fixtures. */
export function location(name: string, description = `${name} description`) {
  return { name, type: "tavern" as const, description };
}

/** A minimal, deterministic character used by context/prompt fixtures. */
export function character(name: string, biography = `${name} biography`) {
  return { name, gender: "female" as const, race: "elf" as const, biography, locationIndex: 0 };
}

/**
 * A location_change event. By convention the engine stores the *previous*
 * scene's summary on the location_change that begins the next scene.
 */
export function locationChangeEvent(
  locationIndex: number,
  presentCharacterIndices: number[],
  summary?: string,
): LocationChangeEvent {
  return {
    type: "location_change",
    locationIndex,
    presentCharacterIndices,
    summary,
  };
}

export function narrationEvent(text: string, locationIndex = 0): NarrationEvent {
  return {
    type: "narration",
    text,
    locationIndex,
    referencedCharacterIndices: [],
  };
}
