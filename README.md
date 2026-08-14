# specsmith

A bundle of [Claude Code](https://claude.com/code) skills, agents, and scripts that drive a feature from a vague idea to verified, browser-tested code.

You install it once into a project; from then on, building a feature is a sequence of slash commands. Each command produces a checked-in artifact (`prd.md`, `plan.md`, `data-model.md`, `tasks.md`) on its own git branch — so the work is reviewable, resumable, and version-controlled like any other code change.

## The pipeline

```
  /grill-me ─→ /write-prd ─→ /plan ─→ /grill-plan ─→ /tasks ─→ /design ─→ /build
      │            │           │           │            │          │         │
 interrogate   synthesise   Technical  pressure-test  phased    HTML/CSS  developer ↔
  the idea      the PRD,     Context,   the plan:    checkbox  prototypes  evaluator
               new branch  Constitution  rows,        tasks    via designer   loop;
               + numbered     Check,     files,                ↔ critique  evaluator
                 folder      Structure,  hidden                            ticks tasks
                            Files-to-    complexity,                           off
                              touch,     failure
                            data-model    modes
                                                                               │
   ┌───────────────────────────────────────────────────────────────────────────┘
   │  a bug, a missed edge case, a deferred carryover, a "can it also…"
   ▼
/extend-spec ─→ amends prd.md (+ plan.md / data-model.md when structural)
                appends a new phase to tasks.md ─────────────→ /build again
```

Six skills shape the spec — the artifacts you read, edit, and review. Two execution skills (`/build`, `/design`) hand the work to subagents and iterate until verification passes.

**The pipeline is a loop, not a line.** `/build` stops when every task is ticked — and then you use the feature and find something. `/extend-spec` folds that finding back into the spec and appends a new phase of tasks, so `/build` finishes it through the same developer → evaluator loop that verified everything else, instead of it becoming an ad-hoc fix that leaves the spec describing a system that no longer exists. See [Extending a spec after the build](#extending-a-spec-after-the-build).

The artifacts for each feature live at `specs/NNN-<feature-slug>/` in the host project — first-class team documentation, not AI scratch.

## Requirements

- Node.js ≥ 18 (uses ESM and `fs.cpSync`)
- [Claude Code](https://claude.com/code) installed and on `PATH` (the installer uses the `claude` CLI to wire up Playwright MCP; if it's missing, the installer prints a manual snippet to add to `.mcp.json`)
- A git repository (each `/write-prd` invocation creates a new branch)

## Install

In the root of any project:

```bash
npx specsmith init
```

This:

1. Copies skills into `.claude/skills/` (one per skill, with bundled `templates/`)
2. Copies subagent definitions into `.claude/agents/`
3. Copies trace, guard, and helper scripts into `.claude/scripts/`
4. Copies reference docs into `.claude/specsmith/references/` (progressive-disclosure companions the agent files link to, kept out of `.claude/agents/` so they aren't loaded as subagent definitions)
5. Drops a starter `.claude/constitution.md` and `specs/glossary.md` (each skipped if you already have one)
6. Merges baseline `.claude/settings.json` (permissions, additional directories, trace hooks) and `.claude/launch.json` (debug configurations) — your existing entries are preserved
7. Appends a "Real Dev Loop" section to your `CLAUDE.md` (created if missing)
8. Runs `claude mcp add --scope project playwright -- npx @playwright/mcp@latest --isolated` so the evaluator and design-critique agents can drive a real browser
9. Creates `pipeline/feedback/` and `pipeline/traces/` (runtime scratch space) and seeds `pipeline/procedures.md` with a starter overlay-handling procedure
10. Writes a checksummed manifest to `.claude/specsmith/manifest.json` so subsequent `update` runs know which files have been edited locally

Useful flags:

- `--dry-run` — preview without writing
- `--force` — overwrite locally-modified files (including `constitution.md` and `glossary.md`)

### About the permissions init grants

> **Heads up:** `init` adds `Bash(*)` to your `.claude/settings.json` allowlist (alongside `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Agent`, and `mcp__playwright__*`) so the build and design loops aren't interrupted by per-command prompts during dev-server start/stop, `pkill`, `sed`/`awk` runs, test commands, migrations, etc. If your project requires tighter permissions, hand-edit `.claude/settings.json` after install — replace `Bash(*)` with specific patterns like `Bash(npm run *)`, `Bash(npx playwright *)`, `Bash(node .claude/scripts/*)` and so on. The trade-off is you'll start seeing prompts mid-loop when something the agents need wasn't allowlisted.
>
> Existing entries in `settings.json` are preserved — `init` only *adds* missing entries, it never removes yours.

## How the loop keeps itself honest

Everything below is one idea applied in different places: **an agent's claim that something works is not evidence that it works, and a rule written in prose is not a rule.**

Each mechanism here replaced a paragraph in an agent file that agents demonstrably ignored. They fall into three groups:

- **Gates the work must pass** — conventions, quality gates, structural and visual diffs. These decide whether a phase is done, instead of the implementer deciding.
- **Guards that refuse a known-bad move** mid-run — repeat commands, repeat reads, blind editing, out-of-scope edits, an orchestrator doing its subagents' work.
- **Signals that survive between cycles** — carryovers, FR-level hard fails, escalation of stale `[Med]`s, and a trace you can audit afterwards.

You can skip this section on a first read; the pipeline works without knowing any of it. Come back when you want to know why a run refused to do something.

### Per-project conventions (machine-checked)

Prose rules in agent files ("use Tailwind, no inline styles", "extract SVGs to icon components") get ignored when the developer agent has the prototype's HTML right in front of it and the prototype uses inline styles. specsmith's answer is the same one used by the runtime guard: a programmatic gate the developer must pass before handoff, not another paragraph in the agent prompt.

Opt in with:

```bash
npx specsmith init --conventions
```

This drops a starter `.claude/conventions.json` with sensible default rules. The most commonly useful ones:

| Rule | What it catches |
| --- | --- |
| `no-inline-styles` | `style={...}` in `.tsx`/`.jsx` files when `tailwind.config.*` exists |
| `svg-extract` | inline `<svg>` blocks > 200 chars outside `src/components/icons/**` |
| `data-access-pattern` | direct DB/ORM calls (`db.select/.insert/.transaction/...`, `prisma.<model>.findUnique/.create/.update/...`) anywhere outside `src/lib/**/repository.ts` or `src/db/**` — explicitly catches the "called the database from a component / route handler / job" anti-pattern |
| `i18n-strings` | multi-word user-facing strings inlined in JSX or in a11y attributes (`placeholder`, `aria-label`, `title`, `alt`, `label`) |
| `component-size-cap` | component files (in `src/components/**`, `components/**`, `app/**`) exceeding 300 lines — proxy for "this component mixes concerns; extract a hook, selector, or sub-component" |
| `one-component-per-file` | two or more `function PascalCase(…) { … return <` components in one `src/components/**/*.tsx` file — Constitution IV (Component Separation). Files named `*-helpers.tsx` / `*-primitives.tsx` are the opt-out for intentional small-component co-location |

Each rule is a JSON object with `name`, `filesGlob`, optional `excludeGlob`, optional `forbiddenPattern` (JS regex), optional `maxLines` (file size cap; one of `forbiddenPattern` or `maxLines` must be set, both is fine too), optional `patternFlags`, optional `skipIfMissing` (rule no-ops if the named glob has no matches), and `message`. Edit, add, or remove rules to fit this project's standards. The schema is documented inline in the file.

Three integration points enforce the rules:

1. **`agents/developer.md` Step 4 gate 0**: `node .claude/scripts/check-conventions.mjs` runs *first* in the quality-gate sequence, before typecheck/test/lint. Failure blocks handoff.
2. **`agents/evaluator.md` Step 3 gate 0**: same script runs as a sanity check after the developer claims done. Any violation surfaces as automatic `[High]` in the feedback (machine-checkable, no judgment).
3. **`/plan`** detects convention ambiguity at planning time. If the codebase has competing patterns (e.g. some entities use `queries.ts`, others `repository.ts`) and no rule covers it, `/plan` raises an `OQ-###` so you pick one *and* add a rule — rather than letting the next plan pick the other and the codebase drift further.

Bypass per-run with `SPECSMITH_CONVENTIONS=0` in the environment. The script also no-ops gracefully when no `conventions.json` exists, so you can install specsmith without the flag and add conventions later by hand.

#### The `pixelDiff` block (visual fidelity, opt-in dependency)

`conventions.json` also ships with a `pixelDiff` block — a separate config (not a `rules[]` entry, because the check is browser-driven, not text-scanning). When enabled (default), the evaluator runs `node .claude/scripts/pixel-diff.mjs` during Step 2b: for each `designs/<slug>.html` prototype, both the prototype and the matching route on the dev server are opened in headless Chromium at the same viewport, diffed with `pixelmatch`, and the worst-offending pixel regions are reported back as `{x, y, w, h, intensity}` so the model gets *where* the implementation deviates, not just *how much*. The diff overlay PNG goes into `pipeline/feedback/` alongside the reference and actual screenshots.

When pixel-diff fires, it **replaces** the evaluator's older manual landmark snapshot comparison — pixel-diff is a strict superset (catches missing regions *and* layout / colour / typography deviations the snapshot comparison can't see). When it's not available (deps missing, designs server not running, `enabled: false`), the evaluator falls back to the manual comparison so the design-fidelity check still runs.

The runtime deps (`playwright`, `pixelmatch`, `pngjs`) are not bundled into specsmith — host projects that want pixel-diff install them themselves:

```bash
npm i -D playwright pixelmatch pngjs && npx playwright install chromium
```

The script skips gracefully with an install hint when any are missing, so leaving `pixelDiff.enabled: true` in projects that haven't installed the deps just no-ops — no error, no broken build. Tunable knobs in the `pixelDiff` block: `viewport`, `maxDiffPct` (default 5.0 since v0.10.0 — raised from 2.0 because real Next.js/Remix apps have ~3-6% irreducible drift vs static-HTML prototypes from font hinting, computed greetings, freshness timestamps, and live data), `threshold` (pixelmatch's `0..1`, default 0.1), `gridSize` (cell size for region bucketing, default 50 px), `masks` (CSS selectors for volatile content — timestamps, animations — applied via Playwright's `screenshot({ mask })`), and `routes` (override the default `designs/<slug>.html` ↔ `/<slug>` pairing).

The script also writes a `pixel-diff.json` file in the output directory and reads it on the next invocation to detect a plateaued diff. If every route's `diff_pct` moved less than 0.5pp from the prior run, the output payload includes `"stuck": true` plus a `stuck_reason` string suggesting three remediations (raise `maxDiffPct`, add masks, or accept the baseline). The evaluator emits `<promise>BLOCKED</promise>` on a plateau (see "Build signals" below) and the build orchestrator halts cleanly rather than asking the developer for another micro-edit cycle — the failure mode the flag exists to break is "agent burns N cycles trying to push 6.5% diff under a 2% threshold by tweaking seed data".

### Build signals

The evaluator communicates with the build orchestrator through one of four states:

| Signal | Meaning | Orchestrator action |
| --- | --- | --- |
| `<promise>PERFECT</promise>` | Entire feature done — every phase passes, all FRs satisfied, score 10/10 | Stop /build; feature complete |
| `<promise>COMPLETE</promise>` | This phase passes (score ≥ threshold, no High, no carryovers, all FRs for this phase met) | Move to next phase |
| `<promise>BLOCKED</promise><reason>...</reason>` (v0.12.0+) | A user decision is required — pixel-diff plateau, constitution waiver, unresolvable FR, etc. The reason names what specifically needs deciding | Halt /build, print `<reason>` to the user, exit cleanly. Re-run /build after the human resolves the question |
| no signal | Failure the developer can fix — High issues, unresolved carryovers, unmet FR-###, score below threshold | Loop back to the developer with feedback, up to `$MAX_CYCLES` |

`BLOCKED` is mutually exclusive with the pass signals. It exists so the orchestrator doesn't have to choose between "fake-pass a phase with a known gap" or "loop forever on something the developer can't fix" — the third path is "stop and ask the human". Common triggers: pixel-diff `stuck: true`, a `OQ-###` in `prd.md` the implementation can't resolve, a constitution principle that needs an explicit waiver decision.

#### Auth-protected routes (`storageStatePath`)

Most real apps redirect anonymous requests to `/login`. Without an authenticated browser context, every `actual`-side screenshot would just be the login page — and `diff_pct` against the real prototype would spike to 80–95% for every protected route. Since v0.11.0, `pixelDiff` supports a `storageStatePath` field (or `--storage-state <path>` on the CLI, which overrides the field):

```json
"pixelDiff": {
  "enabled": true,
  "storageStatePath": "pipeline/storage-state.json",
  ...
}
```

This is a [Playwright storageState JSON](https://playwright.dev/docs/auth) (cookies + localStorage). It's applied **only to the actual-side screenshot** — the reference side (designs/*.html on the static designs server) doesn't need auth, and injecting cookies into a same-origin redirect chain that doesn't expect them causes its own problems. If the path is set but the file doesn't exist when pixel-diff runs, the script skips with a clear reason rather than silently screenshotting the login page.

#### Per-route threshold overrides (`routeOverrides`)

When one route has irreducible drift the others don't — a dense detail page with spread micro-drift, a chart-heavy view, or a complex form — loosening the global `maxDiffPct` to accommodate it gives the other routes 4-5pp of slack they don't need. Since v0.13.0, `pixelDiff.routeOverrides` lets you set a higher floor per-route while keeping the global tight:

```json
"pixelDiff": {
  "maxDiffPct": 7.0,
  "routeOverrides": {
    "/contracts/[id]/indexation": { "maxDiffPct": 11.0 }
  }
}
```

Matching is direct-first, then pattern: keys may contain `[param]` wildcards (v0.14.0+) where each `[anything]` consumes one path segment. So `/contracts/[id]/indexation` matches a wrapper-resolved `/contracts/abc-123/indexation` directly — no need for the wrapper to substitute the key into a temp conventions.json. Direct string match always wins over a pattern; among multiple matching patterns, the one with the fewest `[param]` segments wins (most literal = most specific). The output JSON tags overridden routes with `max_diff_pct_source: "routeOverride"`. Keep the override list small — every entry is a noise floor that has to be remembered when reading future diffs.

#### Auth-wrapper pattern

The typical pattern is a project-local wrapper script (e.g. `scripts/run-pixel-diff.mjs`) that:
1. Reads dev-server URL from `pipeline/dev-server-url`
2. Spins up a Playwright browser, runs the project's login flow, writes `await context.storageState({ path: 'pipeline/storage-state.json' })`
3. Spawns `node .claude/scripts/pixel-diff.mjs --storage-state pipeline/storage-state.json --out pipeline/feedback` and forwards stdout/exit

The wrapper handles the project-specific bits (credentials, login form selectors, dynamic-route ID resolution); the upstream `pixel-diff.mjs` consumes the resulting storage state. This keeps specsmith free of host-project auth specifics while making auth-protected diffs a first-class concern.

### Closing the loop between /design and /build

The pipeline is `…/plan → /tasks → /design → /build`, and `/design` runs *after* `/tasks`. That order means the designer can introduce regions the plan didn't enumerate (e.g. a summary card the planner left out) and they'd silently disappear from `/build`'s scope unless `/tasks` knows about them.

specsmith closes this loop in three places:

1. **`agents/designer.md`** writes `designs/coverage.md` listing every prototype's top-level regions with stable component names. This is the machine-readable bridge between the designer and `/tasks`.
2. **`/design`** ends with a hand-off message telling you to re-run `/tasks` before `/build`. The recommended pipeline becomes: `/plan → /tasks → /design → /tasks → /build` (the second `/tasks` runs in *merge mode*, appending tasks for newly-introduced regions and preserving any `[x]` checkmarks from the first run).
3. **`agents/developer.md` Step 4 gate 0b** requires the developer to enumerate every region from `designs/coverage.md` (or the matching `designs/<slug>.html`) and check each one off in the handoff before declaring the phase ready. Catches the missing-region failure mode at source — one targeted edit instead of a full evaluator → developer round-trip.
4. **`agents/evaluator.md` Step 2b** runs `pixel-diff.mjs` (see the `pixelDiff` block above) to diff the rendered prototype against the rendered implementation pixel-for-pixel at the same viewport, reporting the worst-offending regions as coordinates + intensity. A failed diff is automatic `[High]` severity — no editorial judgment about "section vs detail". If the diff script is unavailable (deps not installed, server not running) the evaluator falls back to a manual accessibility-tree landmark comparison so the safety net still triggers if you skipped step 2 and went straight to `/build`.
5. **`/build`** explicitly forbids deferring design-fidelity issues as "scope creep". Plan-vs-design tension is resolved by updating the plan/tasks (re-run `/tasks`), never by ignoring the design.

Together these turn "the designer added something the plan didn't list" from a silent miss into either a merged task (best case) or a phase-blocking [High] (worst case).

### Every spec ends with whole-system gates (v0.29.0+)

`/tasks` emits a final `Full verification` phase on every spec, always last and never dropped:

```markdown
## Phase 7: Full verification

- [ ] Full test suite passes — `run-gate.mjs test --wait 590 -- <full suite command>`
- [ ] Production build succeeds — `run-gate.mjs build --wait 590 -- <build command>`
- [ ] Typecheck clean across the whole repo
- [ ] Lint clean across the whole repo, zero warnings
```

Every other phase verifies a slice; this one verifies the whole thing once all the slices are in. The production build gate matters most — before v0.29.0 **nothing in the loop ever ran a production build**, so a feature could pass every phase, every browser check, and every pixel diff, and still fail `npm run build`.

`/extend-spec` re-emits this block at the end of every amendment phase, and `/build` keeps it in the last slice when a phase is large enough to be split. See [Extending a spec after the build](#extending-a-spec-after-the-build) for why they are re-emitted rather than un-ticked.

### Phase-to-phase signal

Three rules in the evaluator make sure issues don't quietly carry forward across cycles:

1. **Carryover list.** Every feedback file ends with a `## Carryovers (must fix next cycle)` checkbox section. `/build` copies it verbatim into the next cycle's developer prompt — no re-narration, no summarisation. The developer knows exactly which boxes have to be `[x]` before handoff.
2. **Unmet `FR-###` hard-fails the phase.** A numbered functional requirement is the spec author's named promise to the user. If the implementation doesn't satisfy an FR-### the phase block was supposed to cover, the phase fails regardless of overall score — fixes the failure mode where rubric averaging hides a real spec violation.
3. **Auto-promote prior `[Med]` when scope grows.** If a prior cycle flagged a cross-cutting concern (provider, layout, i18n setup, error boundary) as `[Med]` and the current phase added new consumers of it, the evaluator escalates it to `[High]` for this cycle — fixes the failure mode where a "small login-only" issue becomes load-bearing the moment 5 new client components depend on it.

### Quality gates run through `run-gate.mjs` (v0.27.0+)

Every test / typecheck / lint / conventions run in the build loop goes through one wrapper:

```bash
node .claude/scripts/run-gate.mjs test -- npx vitest run tests/unit/settlement.test.ts
```

It exists because an audited 15-hour `/build` run reported **zero errors across 1,446 Bash calls** — not a clean run, a detection failure. Agents had been taught `cmd 2>&1 | tail -60` for context hygiene; that idiom folds stderr into stdout *and* replaces the exit code with `tail`'s, and the Bash tool response carries no exit-code field, so nothing downstream could tell a failing typecheck from a passing one. 767 of those 1,446 calls (53%) were in that shape.

The wrapper fixes four things at once:

- **Preserves the real exit code**, and prints a `SPECSMITH_GATE gate=… exit=… status=…` sentinel that `trace-hook.mjs` parses — so failures show up in the trace again. Calls that still filter their own output are now tagged `unobservable`, and `trace-summarise.mjs` reports what fraction of the run it could not see rather than implying everything passed.
- **Bounds the printed output** (failure lines first, then a tail) while writing the full log to a fixed path per gate — `pipeline/traces/last-test.log`, `last-typecheck.log`, … — so you can grep it repeatedly for free.
- **Skips provably-redundant runs.** The wrapper fingerprints the working tree (`HEAD` + porcelain status + size/mtime of every dirty file, ignoring `pipeline/`); if nothing changed since this gate last ran, it replays the previous verdict instead of burning the minutes again. `--force` overrides.
- **Survives the 2-minute Bash timeout.** The gate runs *detached*. 25 full-suite invocations in that run were auto-backgrounded at the tool timeout and cost ~103 minutes of polling — 11% of the whole session. Now a slow gate returns `status=running`, and `node .claude/scripts/run-gate.mjs test` (no `--`, no command) re-attaches to the run **already in progress**. To get it in a single call, raise both budgets together: `--wait 590` plus `timeout: 600000` on the Bash call.

`guard-repeat-commands.mjs` deliberately exempts `run-gate.mjs` from its repeat rule — the wrapper's cache is a better answer than a denial, and blocking it would push agents back to the raw piped form.

### Runtime guard against agent flailing

`init` installs four `PreToolUse` guards that refuse a bad pattern mid-run rather than logging it after the fact. Every one of them started as prose in an agent file that agents then ignored — the governing rule in this repo is that a documented anti-pattern ships with a mechanism, or it is a comment rather than a control.

The first two live in `scripts/guard-repeat-commands.mjs`, on every `Bash` call:

1. **Re-running an expensive command to re-filter output.** If `npm run test/lint/typecheck/build`, `playwright test`, `prisma migrate`, `tsc`, `jest`, `vitest`, `next lint/build`, `eslint`, the design-diff scripts (`pixel-diff.mjs` / `dom-diff.mjs` and their `run-*` wrappers), `cargo`, `go test`, `mvn`, or `gradle` already ran in this session and no `Edit` or `Write` tool call happened since, the second invocation is denied with a message pointing to `tee /tmp/last-out.txt` once, then grep the file. The "base" command is matched after stripping trailing `| grep/tail/head/awk/sed/wc/jq/...` pipes **and stream redirections** (`2>&1`, `> out.txt`), so re-running with a different filter or redirect still counts as a repeat. Since v0.27.0 it also **normalises the invocation form**: `npx vitest run x`, `node ./node_modules/vitest/dist/cli.js run x`, and `./node_modules/.bin/vitest run x` all collapse to one base, so switching styles no longer resets the guard. (That mattered — a regex bug meant `npx tsc --noEmit` and the `dist/cli.js` vitest form, 171 calls between them in one audited run, were never matched at all: alternatives written as `tsc(\s|$)` inside a group closed by a trailing `\b` can never match when the tool is followed by a flag.) The cheap `show-pixel-diff.mjs` / `show-dom-diff.mjs` readers are explicitly exempt — they read the already-written JSON, so repeating them is free and is exactly what you should do instead of re-running the diff. (Added after an audit trace showed a full-app pixel-diff run twice back-to-back, 0 edits between, ~130s wasted, only to re-grep its own output — the diff scripts weren't in the expensive list.)
2. **State-wipe loops.** Three or more `rm -rf` of the same path (matching `pglite`, `.next`, `node_modules`, `data/`) within 30 minutes is denied. If the same failure persists after wiping, the bug isn't stale state.

Two more were added in v0.27.0 after a 15-hour `/build` trace was audited (5,324 events, 2,600+ tool calls):

3. **Re-reading a file already in context** (`scripts/guard-repeat-reads.mjs`, `PreToolUse` on `Read`). 318 of 514 Reads in that run — 62% — re-read a file nothing had touched since. The worst offenders were specsmith's own caches: `pipeline/run-state.md` read 24× and `pipeline/environment-facts.md` 29×, despite three separate files instructing agents to read them once (the `/build` skill even cited a prior run's 10× as the cautionary tale, and it got worse). The guard stands down whenever the content could have changed: after any edit to the file, after any Bash command naming it, for a different `offset`/`limit` window, and — critically — across subagent boundaries, since a subagent's context starts empty.
4. **Blind editing** (`scripts/guard-edit-cadence.mjs`, `PreToolUse` on the edit tools). Six consecutive edits to one file with no test, typecheck, lint, read-back, or browser check in between is refused. That run had 10 such stretches totalling 48 edits, worst case 8 in a row; `Edit` results were also its single largest context cost at 6.5 MB, more than `Read` (5.3 MB) and more than all Bash output combined (2.6 MB). Any verification resets the counter, as does moving to a different file.

**Bypassing the guard.** Set `SPECSMITH_GUARD_OVERRIDE=<reason>` (any non-empty value) in your shell BEFORE launching Claude Code if you want to disable these rules for a session. The override is honored only outside hook context (manual script invocation for testing); under a hook — which is every Claude Code Bash call — the override is **ignored** and the attempt is appended to `pipeline/traces/guard-bypass-attempts.log` for you to see. This closes the loophole earlier versions left open, where an agent could dodge the guard by exporting the env var in its bash session. To truly disable the guard for a session, remove the hook entry from `.claude/settings.json` instead of relying on the override var.

### Structural diff (`dom-diff`, v0.18.0+)

Pixel-diff has a known weakness: when two pages share the same layout but render different text/data, the pixel-level diff often falls under threshold (anti-aliasing detection + the per-pixel YIQ tolerance absorb most text-edge differences). A page titled "Betalingen" reports as 6.7% different from a prototype titled "Betalingsoverzicht" — under a 7% threshold, it passes, even though the title is wrong, the table column headers differ, and a whole sidebar region is missing.

`scripts/dom-diff.mjs` (also wired into evaluator Step 2b since v0.18.0) is the semantic complement. For each `(designs/<slug>.html, /<route>)` pair, it extracts a structured snapshot — headings (`h1`/`h2`/`h3`), table column headers, nav labels, button labels, ARIA landmarks — then **normalises dynamic content** (names, numbers, dates, UUIDs, OGMs, transaction IDs, emails, phones, addresses) to placeholders (`<NAME>`, `<NUMBER>`, `<DATE>`, …) so what's compared is the textual / structural contract, not the seed data. Currency format is intentionally preserved as `€ <NUMBER>` vs `<NUMBER> €` so the prefix-vs-suffix style mismatch surfaces.

The output is a flat list of concrete differences:

```json
{
  "verdict": "fail",
  "summary": "0/1 routes passed structural diff (5 total differences after normalisation)",
  "routes": [{
    "route": "/contracts/[id]/periods",
    "verdict": "fail",
    "difference_count": 5,
    "differences": [
      { "type": "h1-missing", "value": "Betalingsoverzicht" },
      { "type": "h1-extra", "value": "Betalingen" },
      { "type": "table-column-missing", "tableIndex": 0, "header": "TRANSACTIE" },
      { "type": "table-column-extra", "tableIndex": 0, "header": "BETAALD OP" },
      { "type": "landmark-missing", "value": "sidebar-user-chip" }
    ]
  }]
}
```

The evaluator combines this with the pixel-diff output. Each `{ type, value }` or `{ type, header }` becomes one `[High]` carryover — no PNG-eyeballing required for substantive design gaps. Pixel-diff still catches visual styling drift that doesn't change structure (colors, spacing, typography). Both must pass for the design-fidelity check to succeed.

Same dep + CLI conventions as pixel-diff: opt-in via `domDiff` config block in `.claude/conventions.json` (enabled by default after v0.18.0 init/update), per-route overrides via `routeOverrides`, `--storage-state <path>` CLI flag for auth-protected routes.

**Auth fallback (v0.20.1+).** Same pattern, different field. `domDiff.storageStatePath` falls back to `pixelDiff.storageStatePath` when null. The two tools navigate the same auth-protected routes on the same dev server; without auth, every protected route gets bounced to `/login` and dom-diff compares the login page against the prototype, failing every route identically. Leaving `domDiff.storageStatePath: null` and letting `pixelDiff.storageStatePath` drive both is the right default. Override only when dom-diff genuinely needs a different session (rare). The output JSON includes `storage_state_source: "domDiff" | "pixelDiff (fallback)" | "cli" | "none"` so the evaluator can see at a glance whether auth was applied.

**Routes resolution (v0.19.1+).** `domDiff.routes` follows a four-level priority chain: explicit CLI override → `domDiff.routes` → `pixelDiff.routes` → `discoverRoutes()` (pair each `designs/<slug>.html` with `/<slug>`). The fall-through to `pixelDiff.routes` exists because the two tools target the same prototype pairs — when filenames don't match nested route paths (e.g. `designs/settings-sharepoint.html` ↔ `/settings/sharepoint`), making the user duplicate the mapping is footgun-prone (caught in a downstream trace where every dom-diff route hit 404 and Playwright hung on the timeouts). Leave `domDiff.routes: null` and let `pixelDiff.routes` drive both; the resolved source ends up in the output JSON as `routes_source` so the evaluator can tell which list ran.

**Scoped diff (v0.20.0+).** Running pixel-diff + dom-diff against 20 routes when this cycle only touched one is wasted work. `scripts/routes-to-diff.mjs` reads `git diff --name-only` (against the merge-base with `main`) plus the prior cycle's failed routes, and emits the list of routes the evaluator actually needs to test. **Scoping is also built into the diff scripts directly** (`lib/diff-scope.mjs` is shared by all three): called with neither `--only-route` nor `--all`, pixel-diff/dom-diff self-scope through the same logic, so a thin env wrapper that calls them directly still gets change-scoping instead of silently sweeping the whole app. Pass `--all` to force a full sweep; pass `--only-route /foo` (repeatable) to honour an explicit list (skips self-scoping).

Policy: a changed `src/app/<segment>/page.*` (or `pages/<segment>.*`, or that segment's `layout|loading|error|route` file) maps to that specific route. A changed **shared component / lib / hook / util is traced through the import graph** (`lib/import-graph.mjs` walks each route's page/layout import closure, resolving relative + `tsconfig` path-alias imports and barrel re-exports) to the routes that actually render it — so a component edit re-diffs just those pages, not the whole app. Only a *hard global* change (root layout, `globals.css`, theme tokens, Tailwind/PostCSS/Next config, lockfiles) — or an import the tracer can't resolve (dynamic `import(var)`, a path outside the source roots), which degrades conservatively — falls back to `*` (test all). Prior-cycle failed routes are always included regardless of file changes — a stuck route MUST be re-verified each cycle until it passes. The output JSON gets `"scoped": true` and `"scoped_routes": [...]` (plus `"self_scoped": true` when the script scoped itself) so the evaluator can see at a glance whether it ran a partial sweep.

### Scope guard (Constitution Principle VIII)

Since v0.15.0, `scripts/guard-scope.mjs` is installed as a `PreToolUse` hook on `Edit | Write | MultiEdit | NotebookEdit`. It refuses any edit on:

- `.claude/scripts/`
- `.claude/agents/`
- `.claude/skills/`
- `.claude/specsmith/` (the manifest lives here — tampering protection)
- `templates/`

These are specsmith tooling paths. Edits to them during a feature build are out-of-scope per the new Constitution Principle VIII (Scope Discipline): every Edit/Write/Bash during a build must serve a task in the active spec's `tasks.md`, and modifying specsmith itself is by definition not a feature task. The guard catches the failure mode where a subagent drifts into "let me also fix this convention violation in `pixel-diff.mjs` while I'm at it" — which historically caused manifest tampering and silent restoration loops.

If you (the human operator) genuinely need to edit one of these paths from inside a host project — e.g. you ARE working on specsmith itself in a worktree, or you need a local patch — create `pipeline/scope-waiver.txt` with one path per line:

```bash
echo ".claude/scripts/pixel-diff.mjs" >> pipeline/scope-waiver.txt
```

The waiver is per-path; siblings stay blocked. Delete the line once the edit is done. The `SPECSMITH_SCOPE_OVERRIDE` env var (analogous to the repeat-command override) is ignored in hook context for the same reason as `SPECSMITH_GUARD_OVERRIDE` — agents don't get to dodge it.

### Orchestrator discipline (v0.19.0+)

The `/build` skill is an **orchestrator** — its job is to dispatch the developer and evaluator subagents and route between them, not to do the verification work itself. A v0.18-era audit caught the failure mode this guard prevents: the orchestrator dispatched Slice A, then while waiting started the dev server, ran pixel-diff inline, hand-wrote `pipeline/dev-server-url`, parsed the JSON with a 1.2 KB `python3 -c '...'` blob, and never invoked the evaluator. The phase checkboxes got flipped on the orchestrator's word, not the evaluator's.

Since v0.19.0, `scripts/guard-orchestrator-discipline.mjs` is installed as a `PreToolUse` hook on `Bash | Edit | Write | MultiEdit | NotebookEdit`. **Inside an active /build run** (signalled by `pipeline/run-state.md`), and **outside a dispatched subagent context** (signalled by `pipeline/dispatch-active.txt`), it refuses:

- `Bash` invocations that start a dev or designs server (`npm run dev`, `next dev`, `vite`, `npx serve designs`, `pkill -f 'next dev'`).
- `Bash` invocations of `pixel-diff.mjs`, `dom-diff.mjs`, and their project-local `run-*` wrappers.
- `Edit` / `Write` on `pipeline/dev-server-url` and `pipeline/designs-server-url` (those are owned by `start-dev-server.mjs`, which writes the *actually-bound* URL parsed from server startup output — hand-writing them creates races and silent fail chains).

**The dispatch lock manages itself (v0.27.0+).** The guard writes `pipeline/dispatch-active.txt` when it sees an `Agent` dispatch, and `trace-hook.mjs` removes it on `SubagentStop`. Neither the orchestrator nor the skill touches that file any more. Previously the `/build` skill instructed a `printf` before every Agent call and an `rm -f` after — 40 Bash calls of pure ceremony in one audited run, two extra round-trips per dispatch, and a lock the orchestrator could forget to open (whereupon the subagent's first legitimate tool call was refused and the message blamed the orchestrator). The 30-minute TTL remains as the backstop so a crashed run can't permanently disarm the guard.

To read the JSON output the evaluator already wrote, the orchestrator uses:

- `node .claude/scripts/show-pixel-diff.mjs [--routes-failed]` — formatted summary from `pipeline/feedback/pixel-diff.json`.
- `node .claude/scripts/show-dom-diff.mjs [--routes-failed]` — same for `pipeline/feedback/dom-diff.json`.
- `node .claude/scripts/ensure-servers.mjs [--designs]` — idempotent check; only starts a server if its URL marker is missing or unreachable.

These helpers are read-only and the guard explicitly permits them. As a paired defense, the existing `guard-repeat-commands.mjs` now also refuses **long inline scripts in any interpreter** (`python3 -c '...'`, `perl -e '...'`, `ruby -e '...'`, `php -r '...'`, etc.) — anything over 200 characters trips the rule with a message pointing at the helpers. A versioned helper script is grep-able, testable, and survives across sessions; a `node -e '...'` blob is none of those.

### Manifest integrity (`specsmith verify`)

```bash
npx specsmith verify
```

Three-way hash comparison: every tracked file's on-disk hash vs the SHA recorded in `manifest.json` vs the SHA in the installed npm package. Catches three drift classes:

- **`MODIFIED`** (low concern): on-disk differs from package, manifest intact — normal user edit. `update` correctly skips.
- **`STALE`** (low concern): on-disk matches package but manifest hash hasn't been refreshed since a prior version. Harmless; next `update` refreshes.
- **`TAMPERED`** ⚠ (high concern): on-disk matches manifest but BOTH differ from package — an agent or process edited a tooling file AND rewrote the manifest entry to hide it. `update` would otherwise treat this as "unmodified since install" and silently accept the corrupted state as the new baseline. This is the failure mode the scope guard above prevents going forward; `verify` is the detector for prior damage.
- **`DRIFTED`** (medium concern): all three differ — user-modified after a prior version upgrade, or a partial install. Reconcile manually.

The command exits 1 when any high-concern entries are found, with a one-line restore hint per file.

### Run the loops in an isolated environment

`Bash(*)` means a Claude Code session running in this project can execute *any* shell command the host user can run — including `git push`, reading `.env*` files, hitting your cloud provider CLIs, calling `gh` against your repos, and so on. For anything beyond a personal sandbox, run the loops in an environment with a smaller blast radius:

- **Dedicated SSH key for the agent**: generate a separate key that has push rights only to this repo, and remove the rest of your keys from `ssh-agent` while the loop runs. Limits how far an unintended `git push` can reach.
- **Docker / devcontainer**: run Claude Code inside a container with the project mounted read-write, your secrets *not* mounted, and outbound network restricted to the registries the project needs. The Playwright MCP container model handles the browser side; the agent process itself can be containerised the same way.
- **Service account on a server**: stand up a CI-style Linux user (no sudo, scoped credentials, dedicated ssh key, dedicated cloud-provider service account) and run the loops there over SSH. The agent's worst-case behaviour is bounded by what that user can do.

Whichever pattern, the rule of thumb is: assume the agent will at some point execute a command you didn't expect, and make sure that command can't reach anything you can't afford to lose.

## Edit the constitution

After install, edit `.claude/constitution.md` so it reflects this project's principles. The starter ships with seven broadly applicable principles (Test-First, Security-First, Code Quality & Complexity Control, Component Separation, Library-First, Migrations-Only, Design Fidelity); add, remove, or rewrite to fit.

`/plan` reads this file every time it generates a plan and renders one row per principle into a Constitution Check table — so vague principles produce vague checks. Be specific.

## Building a feature

```
You: /grill-me
     The customer keeps saying our checkout flow is "confusing" but won't say what.

Claude: <asks ~10 questions interactively — users, pain points, success criteria, edge cases, non-goals>

You: /write-prd
     <slug: checkout-revamp>

Claude: Allocates 003-checkout-revamp/, switches branch, writes specs/003-checkout-revamp/prd.md.

You: /plan

Claude: Inspects package.json + repo structure, reads prd.md and .claude/constitution.md,
        writes plan.md (Technical Context, Constitution Check, Project Structure,
        Files to touch) and data-model.md.

You: /grill-plan

Claude: <interrogates the plan: which constitution row is handwavy? which files-to-touch
        entry is missing? which migration looks safe but isn't? — produces punch list>

You: <hand-edits plan.md based on punch list>

You: /tasks

Claude: Writes tasks.md — phased markdown checkboxes, each implementation task paired
        with a sibling check task the evaluator runs.

You: /design     (optional, only if the feature needs visual prototypes)

Claude: Designer subagent generates HTML/CSS prototypes under designs/.
        Critique subagent scores them in a real browser. Loops until they pass.

You: /build

Claude: For each phase with unchecked tasks:
          - Developer subagent implements the phase
          - Evaluator subagent verifies via Playwright MCP, ticks off completed tasks
          - Loops until evaluator passes the phase
        Stops when every task in tasks.md is [x].
```

## Extending a spec after the build

`/build` stops when every task is ticked. Then you use the feature and find a bug, or the evaluator's last cycle deferred a carryover, or someone asks for one more thing.

Fixing that by hand is the moment the spec starts lying: the PRD describes a system that no longer matches the code, and the fix itself never passes through the developer → evaluator loop that verified everything else.

`/extend-spec` puts it back on the rails.

```
You: /extend-spec
     The surplus badge shows a negative amount when someone overpays,
     and we never specified what happens on a refund.

Claude: Runs spec-status.mjs — reports next free identifiers (FR-029, SC-012),
        next free phase number (7), the phase-4 carryover the evaluator deferred,
        and a BLOCKED verdict still sitting in build-log.md.

        Classifies each item:
          - negative surplus badge  → Defect against FR-014 (no new requirement)
          - refund behaviour        → Gap, becomes FR-029
          - deferred carryover      → Deferred, folded in

        Amends prd.md (FR-029 appended, Amendments entry recording all three),
        updates data-model.md (PaymentCredit gains refundedAt),
        appends "## Phase 8: Amendment 1 — refund handling" to tasks.md with
        fix tasks, sibling checks, regression checks for the FRs the change
        could break, and a re-emitted Full verification block (suite, build,
        typecheck, lint) so the run ends by checking the whole thing.

You: /build

Claude: Skips phases 1-7 (all ticked), starts at Phase 8.
```

Three things it will not do:

- **Implement anything.** It writes documents; `/build` does the work. Routing the fix back through the loop is the whole point.
- **Renumber an identifier.** `FR-###`/`NFR-###`/`SC-###`/`OQ-###` are append-only. `scripts/spec-status.mjs` reports the next free number for each prefix, because a collision silently repoints every task, feedback file, and carryover that cited the original.
- **Un-tick a completed feature task**, except when the amendment makes that task's definition of done wrong. A ticked feature task is the record that an evaluator verified that behaviour in a real browser — regression coverage belongs in the new phase, not in erased history. (And `/build` re-dispatches a phase when it has *any* unchecked task, so un-ticking one task in Phase 1 re-runs Phase 1's entire cycle.)

Whole-system gates are the deliberate exception, and they are re-verified on **every** amendment. `/tasks` ends every spec with a `Full verification` phase — full test suite, production build, repo-wide typecheck, repo-wide lint — and `/extend-spec` re-emits that block at the end of each amendment phase.

The distinction is what a tick means. A feature task's tick says "an evaluator watched this work in a browser", which stays true no matter what you add later. A gate's tick says "the entire codebase was in this state at one moment" — and your amendment ends that moment, because the suite that passed did not include your fix and the build that succeeded did not compile it.

They are re-emitted rather than un-ticked because `/build` walks phases in ascending order: un-ticking the earlier `Full verification` phase while the amendment sits in a later one would run the gates *before* the fix and pass on stale code. The gates have to be the last thing in the last phase. They are also cheap to repeat — one `run-gate.mjs` call each, and the wrapper replays a cached verdict when nothing has changed.

It will also tell you when **not** to extend: if the request would need its own PRD to make sense, it says so and stops, so a spec doesn't quietly grow to cover three features.

Run it **before** the next `/build`. `clean-run-artifacts.mjs` wipes `pipeline/feedback/` at the start of every run, so rebuilding first destroys the evaluator's record of what it deferred.

You can also run `node .claude/scripts/spec-status.mjs` on its own at any time — it is read-only, and it is the fastest way to see what a spec still owes you.

## Skills

| Skill | Purpose | Output |
| --- | --- | --- |
| `/grill-me` | Interrogate a fresh idea, customer feedback, bug report, or gripe | conversation; appends new domain terms to `specs/glossary.md` |
| `/write-prd` | Synthesise the conversation into a Product Requirements Document | new branch + `prd.md` |
| `/plan` | Translate the PRD into a technical plan and data model | `plan.md` + `data-model.md` |
| `/grill-plan` | Pressure-test an existing plan adversarially | conversation + punch list |
| `/tasks` | Decompose plan + data model into phased checkbox tasks | `tasks.md` |
| `/design` | Run designer ↔ critique loop until prototypes pass | HTML/CSS files in `designs/` |
| `/build` | Run developer ↔ evaluator loop until every task is checked off | implemented code, ticked `tasks.md` |
| `/extend-spec` | Fold post-build bugs, gaps, and change requests back into the spec | amended `prd.md` (+ `plan.md`/`data-model.md` when structural) + a new phase in `tasks.md` |

## Subagents

`/build` and `/design` are orchestrators — they delegate work to single-responsibility subagents that run in isolated context (the verifier never sees the implementer's reasoning):

| `subagent_type` | File | Role |
| --- | --- | --- |
| `developing-features` | `agents/developer.md` | Implements one phase; cares about clean code, tests, design fidelity |
| `evaluating-phases` | `agents/evaluator.md` | Verifies each task in a real browser via Playwright MCP; flips checkboxes only after passing |
| `designing-interfaces` | `agents/designer.md` | Generates distinctive HTML/CSS prototypes per user story |
| `critiquing-designs` | `agents/design-critique.md` | Scores prototypes against a rubric in a real browser |

The `subagent_type` values (left column) are what you pass to the Agent tool. The file basenames (`developer.md`, etc.) are not the invocation names.

## What gets installed where

In the host project after `npx specsmith init`:

```text
.claude/
├── agents/                       # subagent definitions (4 files)
├── skills/                       # one folder per skill, some with templates/
│   ├── grill-me/SKILL.md
│   ├── write-prd/{SKILL.md, templates/prd.md}
│   ├── plan/{SKILL.md, templates/{plan.md,data-model.md}}
│   ├── grill-plan/SKILL.md
│   ├── tasks/{SKILL.md, templates/tasks.md}
│   ├── design/SKILL.md
│   └── build/SKILL.md
├── scripts/                      # trace hook, guards, run-gate, spec-status, dev-server helper, etc.
├── specsmith/references/         # progressive-disclosure docs the agent files link to
├── constitution.md               # principles /plan checks against — EDIT THIS
├── settings.json                 # permissions + additional directories + trace hooks
├── launch.json                   # debug configurations
└── specsmith/manifest.json   # SHA-256 of every installed file (for `update`)

specs/                            # spec artifacts (first-class team docs)
├── glossary.md                   # ubiquitous language — seeded at install, grown by /grill-me
└── NNN-<feature-slug>/           # one folder per feature, created by /write-prd
    ├── prd.md
    ├── plan.md
    ├── data-model.md
    └── tasks.md

pipeline/                         # runtime scratch — created at install, written during /build and /design
├── feedback/                     # evaluator/critic reports per cycle
├── traces/                       # JSONL traces of build/design runs
├── procedures.md                 # cached UI flows (login, cookie consent dismissal)
├── environment-facts.md          # cached project facts (test command, dev server URL)
├── run-state.md                  # current orchestrator run context
└── build-log.md                  # progress log

.mcp.json                         # Playwright MCP server entry
```

`pipeline/procedures.md` and `pipeline/environment-facts.md` are **persistent caches** — they survive across runs and are never overwritten. The agents discover things once (login flow, dev-server port, test command) and write them here so future cycles skip the discovery step.

## Customising

- **Templates** for the file-writing skills live at `.claude/skills/<skill>/templates/<artifact>.md`. Edit them to change the structure of the PRD, plan, data-model, or tasks files. Your edits are preserved across `update` runs.
- **Subagent prompts** live at `.claude/agents/*.md`. Edit them to change how the developer or evaluator behaves. Edits are preserved across `update`.
- **Skill prompts** live at `.claude/skills/*/SKILL.md`. Edit similarly.
- **Constitution**: `.claude/constitution.md`. Never overwritten by `update`.
- **Glossary**: `specs/glossary.md` — the project's ubiquitous language. Seeded once at install, then grown by `/grill-me` and edited by the team. Never overwritten or tracked by `update` (same ownership model as the constitution).

The manifest at `.claude/specsmith/manifest.json` records the SHA-256 of every file at install time. `update` compares package version vs on-disk vs manifest to decide whether each file is safe to update or has been customised — see "Updating" below.

## Updating

```bash
npx specsmith update
```

For each tracked file:

- **already current** (on-disk matches package) → skipped
- **unmodified since install** (on-disk matches manifest) → updated to package version
- **user-modified** (on-disk differs from both) → skipped, logged for manual reconciliation
- **missing on disk** → installed fresh

The constitution, the glossary, and your `pipeline/*.md` files are never touched.

`--dry-run` previews the diff without applying. `--force` (via `init --force`) overwrites everything including the constitution and glossary — use with care.

## Troubleshooting

**`claude: command not found` during init** — Claude Code isn't installed or isn't on PATH. The installer prints a `.mcp.json` snippet you can paste manually; everything else still installs.

**Update reports every file as user-modified on Windows** — line-ending normalisation. The package ships LF; if your repo has `core.autocrlf=true` you'll see CRLF on disk and the hashes diverge. The package ships a `.gitattributes` with `* text=auto eol=lf` to prevent this on its *own* tree, but for your host project run `git config core.autocrlf input` (or `false`) before installing.

**`/plan` complains the constitution is missing** — `.claude/constitution.md` was deleted or `init` was skipped. Run `npx specsmith init` again (it will only re-add what's missing).

**Evaluator can't drive the browser** — Playwright MCP wasn't wired. Check `.mcp.json` has the `playwright` entry; if not, run `claude mcp add --scope project playwright -- npx @playwright/mcp@latest --isolated`.

**`/grill-plan` says it can't find the plan** — you're not on a feature branch. The `^\d{3}-` branch pattern is how the post-PRD skills locate the spec folder. Either `git checkout` the right branch, or tell the skill which spec folder to use when it asks.

**"Refusing to re-run…" / "Refusing to re-read…" / "Refusing this edit…"** — these are the guards, working as intended. Each denial explains which pattern it caught and what to do instead, and each stands down on its own once the situation changes (an edit happened, the file was touched, a verification ran). If a guard is wrong for your project, remove its hook entry from `.claude/settings.json` — the `SPECSMITH_GUARD_OVERRIDE` env var deliberately does **not** work from inside a hook, so an agent can't talk its way past one.

**A gate says `status=running` and returns nothing** — `run-gate.mjs` hit its `--wait` budget. The command is still running, detached. Re-attach with `node .claude/scripts/run-gate.mjs <gate>` (no `--`, no command); it waits on the run already in progress rather than starting a second one. Nothing is lost and nothing is re-run.

**A gate replays an old result instead of running** — the working tree hasn't changed since that gate last ran, so the answer cannot differ. Pass `--force` if you believe the result was environment-dependent (a flaky test, an external service).

**`/extend-spec` reports no carryovers when you expected some** — `pipeline/feedback/` is wiped at the start of every `/build` run, so a rebuild destroys the evaluator's record of what it deferred. Run `/extend-spec` before the next `/build`, not after.

## Design decisions worth knowing

- **No transcript file from `/grill-me`.** The conversation context *is* the handoff, so `/write-prd` must run in the same session as `/grill-me`. The one durable thing it writes is `specs/glossary.md`: at the end of an interview it proposes a few canonical domain terms and, on your yes, appends them — building a **ubiquitous language** the whole pipeline can share. Minimal by design (one line per concept, domain terms only). `/grill-me`, `/write-prd`, and `/plan` all read it so the conversation, PRD, and plan converge on the same words; only `/grill-me` writes to it.
- **Plan is detailed but not SpecKit-detailed.** `/plan` produces only `plan.md` + `data-model.md` — no `research.md`, `quickstart.md`, or `contracts/`. The plan template has Technical Context, Constitution Check, Project Structure, and Files-to-touch sections.
- **Tasks are not agent-bound.** Tasks have no `(dev)` / `(design)` tags. The orchestrator routes; the evaluator decides "done".
- **Numbering is stable.** `FR-###`, `NFR-###`, `SC-###`, `OQ-###` identifiers in `prd.md` are append-only — never renumber when adding items. `scripts/spec-status.mjs` reports the next free number per prefix so `/extend-spec` never guesses; a collision would silently repoint every task, feedback file, and carryover that cited the original.
- **Post-build work re-enters the pipeline; it does not bypass it.** `/extend-spec` amends the spec and appends tasks rather than fixing code directly, so the fix passes through the same developer → evaluator loop as the original build. It appends a new phase rather than re-opening old ones, because a ticked task is the record that an evaluator verified that behaviour in a real browser — regression coverage belongs in the new phase, not in erased history.
- **A documented anti-pattern ships with a mechanism, or it is a comment.** Prose bans don't hold at scale. Three separate files told agents to read `run-state.md` once; the next audited run read it 24 times, up from the 10 the instruction was written to prevent. The rules that hold are the ones promoted to a guard hook or absorbed into a helper script — which is why the guards, `run-gate.mjs`, and `spec-status.mjs` exist as code rather than as more paragraphs.
- **Each feature gets its own branch.** `/write-prd` runs `git checkout -b NNN-<slug>` off whatever branch you're on, inheriting any uncommitted changes. Multiple features in flight = multiple branches.

## License

MIT. See [LICENSE](./LICENSE).
