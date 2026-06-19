# Sci-Fi (Space Opera) Genre — Implementation Plan

Status: **Planned, not started.** Art assets are the blocker; implementation begins after art is ready.

## Context

Waidrin ships with three genres advertised on the genre-select screen, but only
Fantasy is wired up. Sci-Fi and Reality are disabled. This plan adds **Sci-Fi**
in a **Space Opera** tone ("spaceships and aliens", per the existing card copy),
using an architecture that makes **Reality** nearly free to add afterward.

This document is self-contained — come back to it anytime. Also read `AGENTS.md`
first if you haven't; in particular the **GOTCHA: llama.cpp silently abandons
JSON-schema constraints on large bounds** section — the architecture below is
designed around it.

## Where "fantasy" is currently hardcoded

There is **no `genre` field in `State`** today. `GenreSelect.tsx` has a
RadioCards with `defaultValue="fantasy"` that writes nothing to state; the
engine's `genre → character` transition is a pure passthrough. So "fantasy" is
baked into 5 places:

| File | What's hardcoded |
|---|---|
| `lib/schemas.ts` | `Race = human/elf/dwarf`, `LocationType = tavern/market/road` |
| `lib/prompts.ts` | `makePrompt` system line ("fantasy role-playing game"); every prompt says "fantasy"; `generateWorldPrompt` mentions elves/dwarves/wizards |
| `views/CharacterSelect.tsx` | Human/Elf/Dwarf cards; image paths `male-human` etc. |
| `views/ScenarioSetup.tsx` | `/images/fantasy.png` world image |
| `lib/state.ts` | `initialState.protagonist.race = "human"` |

Adding Sci-Fi is fundamentally a **parameterization** problem, not a
feature-building problem.

## Architecture: a genre registry

The only place genre-specific vocabulary lives should be a single module,
`lib/genres.ts`. Everything else reads from it.

### 1. Add a `Genre` concept to state

- `schemas.ts`: `Genre = z.enum(["fantasy", "scifi", "reality"])`; add
  `genre: Genre` to `State`.
- `GenreSelect.tsx`: actually write the selection to `state.genre` (currently
  writes nothing).

### 2. `lib/genres.ts` — single genre registry

```ts
export const GENRES = {
  fantasy: { races: ["human","elf","dwarf"],
             locationTypes: ["tavern","market","road"],
             systemFlavor: "a text-based fantasy role-playing game",
             /* …prompt fragments, image keys… */ },
  scifi:   { /* …space opera values… */ },
} as const satisfies Record<string, GenreConfig>;
```

Every genre-specific string (system flavor, world-building hints, race/location
labels) lives here.

### 3. Loosen *rest* schemas, keep *generation* schemas strict

**Critical given the llama.cpp grammar fix.** Split the two concerns:

- **Persisted/at-rest** (`schemas.Character`, `schemas.Location`): loosen
  `Race` and `LocationType` to a plain nonempty `Text`. Any genre's values are
  valid at rest; existing fantasy saves still parse.
- **At generation time** (`engine.ts`): build the enum dynamically per call —
  `z.enum(GENRES[state.genre].races)` — and pass it to `getObject`. The grammar
  forces the model into the correct enum *for the chosen genre*.

Why dynamic-per-call and not a big cross-genre union enum? A union would bloat
the generated grammar — exactly the failure mode in `AGENTS.md`. The dynamic
pattern is already proven in the codebase: `accompanyingCharacters` does
`z.enum(state.characters.map((c) => c.name))` today.

### 4. `prompts.ts` genre-aware

`makePrompt` reads the genre's `systemFlavor`; world/protagonist/location/
character prompts pull vocabulary from the registry. No fantasy-specific prose
remains as a literal.

### 5. UI reads the registry

`CharacterSelect` renders races from `GENRES[genre].races`; `ScenarioSetup`
swaps the world image by genre.

## Content decisions — **Space Opera** (proposed defaults, edit freely)

These drive everything else. Lock these before slice 3.

- **Sub-genre / tone:** ✅ Space opera (decided).
- **Races (proposed):** `human`, `android`, `alien` — 3 to match the 3-column
  card layout and stay grammar-cheap. Alternatives: `cyborg`, `ai`.
- **Location types (proposed):** `space-station`, `market`, `starship`.
  Alternatives for a grittier feel: `outpost`, `bar`, `colony`.
- **System flavor (proposed):** `"a text-based space-opera role-playing game"`.
- **World-building hints (proposed):** interstellar civilization, FTL travel,
  multiple sentient species, interstellar trade/politics — to replace the
  "populated by humans, elves, and dwarves" line in `generateWorldPrompt`.

## 🎨 Art asset checklist (current focus)

Currently in `public/images/`: `fantasy.png`, `reality.png`, `scifi.png`
(genre card art already exists), plus `{male|female}-{human|elf|dwarf}.png`.

Space opera needs equivalents. Naming **must** match what the UI builds:

- **World image:** `scifi.png` (used by `ScenarioSetup` for the world card).
  *(Already present per `GenreSelect` art — confirm it's final-quality, not just
  a card thumbnail.)*
- **Character portraits** (one per `{gender}-{race}` combo, matching the
  `${gender}-${race}.png` pattern in `CharacterSelect`/`ScenarioSetup`):
  - [ ] `male-human.png`
  - [ ] `female-human.png`
  - [ ] `male-android.png`
  - [ ] `female-android.png`
  - [ ] `male-alien.png`
  - [ ] `female-alien.png`
  - *(adjust race names to whatever the final race list is)*
- **Genre card thumbnails** (for `GenreSelect`): `scifi.png` — already present,
  confirm it's disabled-card-appropriate.
- **Location-type art** (one per location type, matching the
  `/images/${locationType}.png` pattern in
  `components/LocationChangeEventView.tsx`). Fantasy has `tavern.png`,
  `market.png`, `road.png` — space opera needs equivalents for its location
  types (e.g. `space-station.png`, `market.png`, `starship.png`).
  - [ ] `space-station.png` (or first location type)
  - [ ] `starship.png` (or second)
  - [ ] *(third — `market.png` may be reusable if it's genre-neutral)*
  - [ ] If `market.png` reads as fantasy-medieval, produce a sci-fi market too.

Until these land, slices 3–4 can proceed with placeholder/blank images; the UI
will render broken `<img>` tags harmlessly. Don't block implementation on art
beyond slice 4's polish.

## Build sequence (each slice independently testable)

- [ ] **Slice 1 — Foundation (no behavior change):**
  add `Genre` to schema + state + write it from `GenreSelect`; create
  `lib/genres.ts`; refactor `prompts.ts` to read from the registry. Fantasy
  behaves exactly as before. → unit-testable in `prompts.test.ts`,
  `state.test.ts`.
- [ ] **Slice 2 — Schema split:** loosen `Race`/`LocationType` at rest; build
  per-genre generation enums in `engine.ts`. Fantasy still works end-to-end.
  → test that fantasy generation still constrains correctly; verify against the
  live llama.cpp server.
- [ ] **Slice 3 — Sci-Fi data:** fill in the `scifi` registry entry from the
  content decisions above; enable the `GenreSelect` card (remove `disabled`).
  No UI changes beyond what slices 1–2 already parameterized.
- [ ] **Slice 4 — UI polish:** `CharacterSelect`/`ScenarioSetup` driven by
  registry; wire sci-fi images from the art checklist above.
- [ ] **Slice 5 — Verify:** run the full
  `connection → genre(scifi) → character → scenario → chat` flow against the
  llama.cpp server; extend tests (`prompts.test.ts`, `state.test.ts`,
  `fixtures.ts`).

## Risks / things to watch

- **Grammar enforcement (see `AGENTS.md` GOTCHA):** keep generation enums small
  and static per genre; never let genre vocabulary bloat `z.toJSONSchema`
  output. `getObject` already strips `minLength`/`maxLength`/`pattern`, but keep
  enums as enums, not string patterns.
- **Save-state migration:** existing persisted `state` in a user's
  `localStorage` has no `genre` field. Add a `migrate`/`merge` in the persist
  config (`lib/state.ts`) to default `genre: "fantasy"` for old saves —
  otherwise `State.parse` throws on load.
- **`fixtures.ts` & `initialState`:** `state.test.ts` is a safety net that will
  fail until every new required field is added — let it guide you.
- **`RawCharacter`** is defined in `engine.ts` (not `schemas.ts`); the per-genre
  generation schema should be built there or in a helper, to keep the persisted
  schema genre-agnostic.
- **Reality (future):** once this ships, adding Reality is "fill in a third
  registry entry + art" — slices 1, 2, and most of 4 are reusable.

## Out of scope (for now)

- Per-genre tropes (the `hiddenDestiny`/`betrayal`/etc. switches in
  `ScenarioSetup` stay shared across genres unless a genre-specific trope is
  requested).
- Per-genre content-level defaults.
- New event types or engine steps — the state machine is genre-agnostic.
