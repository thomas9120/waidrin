# AGENTS.md

Guidance for AI agents (and humans) working on the Waidrin codebase.
Read this first.

## What this is

Waidrin is a purpose-built role-playing game engine powered by an LLM. The core
engine is **headless**: an asynchronous, fully typed, fully validating state
machine (`lib/engine.ts`) that uses constrained JSON-schema generation to create
locations/characters as the story progresses and tracks them as structured
narrative events (not chat messages). It ships with a co-evolving Next.js + React
frontend.

- Runtime: Next.js 15 (App Router, Turbopack dev), React 19, TypeScript (strict).
- State: Zustand + Immer, persisted to `localStorage` via the `persist`
  middleware (see `lib/state.ts`). The `apiKey` is deliberately never persisted.
- Validation / constrained output: Zod v4 (`zod/v4`). Schemas live in
  `lib/schemas.ts`; prompt builders live in `lib/prompts.ts`; context
  compression lives in `lib/context.ts`.
- LLM backend: talks to a local **llama.cpp** server's OpenAI-compatible
  endpoint through a thin Next.js proxy at `app/api/llm/route.ts`.

## Common commands

```bash
npm ci --ignore-scripts   # install (the bundled .npmrc disables lifecycle scripts)
npm run dev               # next dev --turbopack (what you want while working)
npm run build             # production build
npm run start             # serve the production build
npm run lint              # biome check .  (CI runs `biome ci .`)
npm run test              # vitest (watch)
npm run test:run          # vitest run (CI; single shot)
```

`npm run test:run` is the focused, fast feedback loop (~2s, pure unit tests).

## CI

`.github/workflows/code-quality.yml` runs two jobs on every push/PR:
`quality` (Biome) and `test` (Vitest). **Both must pass.** Before pushing, run:

```bash
npx biome ci . && npm run test:run && npx tsc --noEmit
```

## Architecture map

```
app/
  page.tsx                 Top-level client component; drives view state machine + overlays
  api/llm/route.ts         SSRF-hardened proxy to the llama.cpp server
  plugins/route.ts         Lists plugin manifests (rate-limited, traversal-safe)
  plugins/[...path]/route.ts Serves plugin .js files (rate-limited, traversal-safe)
lib/
  engine.ts                The state machine: next()/back()/reset()/abort()
  backend.ts               DefaultBackend: streaming + getObject() (constrained JSON)
  schemas.ts               All Zod schemas (State, Character, Location, Event, ...)
  prompts.ts               Prompt builders (world, protagonist, narrate, actions, ...)
  context.ts               Token-budget context compression (3-step fallback)
  state.ts                 Zustand+Immer store, persist, setAsync mutex, initialState
  sanitize.ts              Prompt-injection / XSS / secret-redaction sanitizers (single source of truth)
  server/
    llmValidation.ts       Pure SSRF + body validators (extracted for testability)
    rateLimit.ts           In-memory per-IP rate limiter for plugin routes
views/, components/        React UI (Welcome → Connection → Genre → Character → Scenario → Chat)
plugins/demo-plugin/       Example plugin (manifest.json + main.js)
```

State machine views: `welcome → connection → genre → character → scenario → chat`.
`lib/engine.ts` `next()` advances one step at a time and validates state with
`schemas.State.parse()` both before and after each step.

## Testing conventions

- **Framework:** Vitest, node environment. Config: `vitest.config.ts`,
  setup: `vitest.setup.ts` (shims `localStorage` for the persist middleware).
- **Location:** `lib/__tests__/*.test.ts`. Pure unit tests only — no browser,
  no Next.js server, no real network.
- **Fixtures:** `lib/__tests__/fixtures.ts` provides `makeState()` (clones the
  real `initialState` + overrides, so fixtures stay schema-valid as fields are
  added) plus `character()`, `location()`, `locationChangeEvent()`,
  `narrationEvent()`.
- **Style:** name tests by behavior and failure condition, not implementation.
  Prefer spying/mocking over real I/O. See `backend.test.ts` for the pattern of
  spying on `getResponse` to test `getObject` without fetch/streaming.
- **Path alias:** use `@/...` in both source and tests (Vite alias mirrors
  tsconfig).

When you add a field to `lib/schemas.ts`, the `state.test.ts` suite will fail
until `initialState` is updated — that's intentional (it's the safety net).

## GOTCHA: llama.cpp silently abandons JSON-schema constraints on large bounds

This bit us. It will bite again if forgotten. Read carefully.

### Symptom

The model returns **valid JSON of the wrong shape** — a wrapper key like
`{ "protagonist": { ... } }`, capitalized enum values (`"Human"`, `"Male"`),
and extra fields (`age`, `class`, `attributes`) — even though a strict
`json_schema` was sent. `schemas.State.parse()` then throws a Zod error that
surfaces (truncated) to the user. The connection-check step passes fine because
it uses a length-free literal schema, so the failure only appears several steps
later during world/character generation.

### Root cause

`lib/schemas.ts` wraps nearly every string field with length bounds:
`Name = Text.max(100)`, `Description = Text.max(2000)` (used for `biography`,
location/character descriptions, etc.). When Zod serializes these into the
JSON schema passed to llama.cpp, a constraint like `maxLength: 2000` makes
llama.cpp's json-schema-to-grammar compiler emit ~2000 repetition rules. That
**exceeds the server's sane-repetition threshold**, and llama.cpp **silently
falls back to unconstrained generation** instead of erroring. See llama.cpp
issue [#21228](https://github.com/ggml-org/llama.cpp/issues/21228) (also
# 11988, #24097, #14218 for related `response_format` quirks).

This is **not** an old-build bug, **not** the `--jinja` flag, and **not** the
request format. It reproduces on a current build (verified on build 9631,
Gemma-4-26B). It is **schema-specific**: small/enum-only schemas enforce fine;
any schema with a large `maxLength` silently fails.

### Reproduction (against a running llama.cpp server)

The decisive bisect: send waidrin's `RawCharacter` schema with vs. without the
length constraints, 3× at temperature 0. **With** bounds → 0/3 enforced
(model returns `{protagonist:{...}}`). **Without** bounds → 3/3 enforced
(correct `{name, gender, race, biography}`).

### The fix (do not undo this)

`lib/backend.ts` defines `stripGrammarUnfriendlyConstraints()`, which removes
`minLength`, `maxLength`, and `pattern` from the JSON schema used **only for
grammar guidance** before it is sent in `response_format`. Structural keywords
(`type`, `enum`, `properties`, `required`, `items`, `additionalProperties`,
`const`) are preserved, so the model is still forced into the right shape and
enum values. The **full Zod schema (with bounds) still validates the parsed
response** in `getObject`, so length constraints are still enforced — just
cheaply and reliably on our side rather than in the grammar.

If you ever change how `getObject` builds `response_format`, **keep calling
`stripGrammarUnfriendlyConstraints(z.toJSONSchema(schema))`**. And
`backend.test.ts` has a contract test that fails if `maxLength`/`minLength`
leak into the payload — keep it.

### Adding new object schemas (e.g. new genres)

It is fine to keep using `Text.max(N)` / `.min(N)` / `.regex()` on Zod schemas
for validation. They will be stripped for grammar guidance automatically. Just
do **not** hand a raw `z.toJSONSchema(schema)` straight to the server anywhere
outside `getObject` without stripping first.

## Other notes

- **`lib/sanitize.ts` is the single source of truth** for all sanitization
  (prompt-injection, XSS, secret redaction). The API route and tests import from
  here — don't re-implement copies inline.
- **Error messages from `getObject`** are shown to users. They deliberately
  include a truncated preview of the actual model response so silent constraint
  failures are diagnosable. Keep that behavior.
- The plugin system loads and executes remote-ish JS in the browser; the route
  handlers and `page.tsx` validate manifests and confirm untrusted plugins with
  the user. Don't weaken the path-traversal or confirmation checks in
  `app/plugins/**/route.ts` or `app/page.tsx`.
- `.npmrc` disables dependency lifecycle scripts; keep `--ignore-scripts` in
  install instructions unless you have reviewed a package's install hook.
