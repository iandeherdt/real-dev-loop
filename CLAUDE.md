# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

`specsmith` is an installable **npm package** of Claude Code skills, agents, and scripts that implement an end-to-end development workflow. It is tooling for doing software work *with* Claude Code, not an application being shipped to end users.

`npx specsmith init` is implemented (entry point at `bin/cli.mjs`). It copies everything in this repo's `agents/`, `skills/`, `scripts/`, and `templates/` into the host project's `.claude/`, merges a baseline `.claude/settings.json` (permissions, additional directories, trace hooks) and `.claude/launch.json`, drops a starter `.claude/constitution.md`, appends a "Real Dev Loop" section to the host's `CLAUDE.md`, wires the Playwright MCP server (via `claude mcp add`), and writes a checksummed manifest at `.claude/specsmith/manifest.json`. `npx specsmith update` re-syncs files that haven't been edited locally; user-modified files are skipped (manifest tracks the difference).

Public surface that is a **stable contract** for downstream projects:
- skill names (`/grill-me`, `/write-prd`, `/plan`, `/grill-plan`, `/tasks`, `/build`, `/design`)
- the `specs/NNN-<feature-slug>/` artifact layout in host projects
- the `specs/glossary.md` project glossary location
- the `.claude/constitution.md` location
- the `.claude/specsmith/manifest.json` location

Internal refactors of `lib/` are fine; renaming any of the above is a breaking change.

## Pipeline

The skills implement a five-stage pipeline. Each feature gets its own git branch and numbered folder.

- **Folder layout (per feature):** `specs/NNN-<feature-slug>/` at the repo root, where `NNN` is allocated sequentially (`001`, `002`, …) by `/write-prd`. Lives at the repo root (not under `.claude/`) so the artifacts are first-class team documentation, not AI scratch.
- **Branch:** `NNN-<feature-slug>` (matches the folder name). Created by `/write-prd` off whatever branch the user is currently on, inheriting any uncommitted changes. `/plan`, `/grill-plan`, and `/tasks` each derive the spec folder by parsing the current branch name — they never create branches of their own.
- **Constitution:** stays at `.claude/constitution.md` (project policy / AI tooling config; not per-feature).
- **Glossary:** `specs/glossary.md` — the project's cross-feature ubiquitous language. Seeded by `init`, grown by `/grill-me`, read by it on every run. Project-wide, not per-feature, so it lives alongside the numbered folders rather than inside one.

| Stage | Skill | Input | Output |
| --- | --- | --- | --- |
| 1. Interrogate the idea | `/grill-me` | a prompt, customer feedback, bug, or gripe; `specs/glossary.md` | conversation; appends new canonical terms to `specs/glossary.md` |
| 2. Capture requirements | `/write-prd` | the live conversation context; `specs/glossary.md` | new branch `NNN-<slug>` + `specs/NNN-<slug>/prd.md` |
| 3. Plan | `/plan` | `prd.md` + `.claude/constitution.md` + `specs/glossary.md` | `plan.md` + `data-model.md` |
| 4. Pressure-test the plan (optional) | `/grill-plan` | `plan.md` + `data-model.md` + `prd.md` + `.claude/constitution.md` | conversation + punch list (no file) |
| 5. Decompose | `/tasks` | `plan.md` + `data-model.md` + `prd.md` | `tasks.md` |
| 6. Build loop | `/build` | `tasks.md` + `plan.md` + `data-model.md` | implemented code; ticks `tasks.md` |
| 7. Design loop | `/design` | `tasks.md` + design-relevant spec | HTML/CSS prototypes under `designs/` |

`/build` and `/design` are orchestration skills that delegate to subagents — `developing-features` + `evaluating-phases` for code, `designing-interfaces` + `critiquing-designs` for prototypes (these are the `subagent_type` values; the agent files themselves are `agents/developer.md`, `agents/evaluator.md`, etc.). The evaluator (Playwright-MCP-driven) is what flips `[ ]` → `[x]` in `tasks.md`; never mark a task done on the implementer's word alone.

`/grill-me` and `/grill-plan` are deliberately separate skills with different dimensions of inquiry — `/grill-me` interrogates *what* to build; `/grill-plan` interrogates *how* it will be built.

## Key design decisions

- **No transcript file from `/grill-me`.** It is a chat skill; the conversation context *is* the handoff. `/write-prd` must therefore run in the same session as `/grill-me` (or a session where the requirements have otherwise been discussed in detail). The one exception is `specs/glossary.md`: grill-me does not dump the transcript, but at the end of an interview it proposes (and on the user's yes, appends) a few canonical domain terms. That file is the durable cross-feature artifact; the transcript is not.
- **Glossary is the project's ubiquitous language.** `specs/glossary.md` is created by `init` (seeded once, never overwritten or `update`-tracked — same ownership model as the constitution). `/grill-me`, `/write-prd`, and `/plan` all *read* it so the conversation, PRD, and plan converge on the same words; only `/grill-me` *writes* to it, growing it one terse entry at a time (and only on the user's confirmation). Minimal by design: domain concepts only, one line each. Kept project-wide (not per-feature) so the whole pipeline shares one vocabulary.
- **Plan is detailed but not SpecKit-detailed.** `/plan` produces only `plan.md` (Technical Context, Constitution Check, Project Structure, Files-to-touch) and `data-model.md`. It does **not** generate `research.md`, `quickstart.md`, or `contracts/`.
- **Constitution lives per-project.** `.claude/constitution.md` is created by `init`, edited by the team, and read by `/plan` to render the compliance table. The skill never invents a constitution.
- **Tasks are not agent-bound.** No `(dev)` / `(design)` tags on tasks. The orchestrator routes; the evaluator verifies.
- **Numbering is stable.** `FR-###`, `NFR-###`, `SC-###`, `OQ-###` identifiers in `prd.md` are append-only — never renumber when adding items.

## Repo layout

```text
.
├── bin/cli.mjs            # entry point: `npx specsmith <init|update>`
├── lib/
│   ├── installer.mjs      # init logic
│   ├── update.mjs         # selective update (manifest-aware)
│   ├── manifest.mjs       # SHA-256 manifest at .claude/specsmith/manifest.json
│   ├── merge.mjs          # launch.json / settings.json / CLAUDE.md mergers
│   └── utils.mjs          # PACKAGE_ROOT, install plan walker, log helpers
├── agents/                # Claude Code subagent definitions (.md files)
├── skills/                # one folder per skill; some bundle templates/
├── scripts/               # trace-hook, guards, run-gate, env-facts, dev-server — installed to .claude/scripts/
├── references/            # progressive-disclosure docs agent files link to — installed to .claude/specsmith/references/
├── templates/             # constitution.md + glossary.md starters + claude-md-section.md
├── launch.json            # debug configurations merged into host's .claude/launch.json
├── package.json
├── CLAUDE.md              # this file
└── LICENSE
```

The install plan is **dynamic**: `lib/utils.mjs#buildInstallPlan` walks `agents/`, `skills/`, and `scripts/` and emits one entry per file. Adding a new skill or agent requires *no installer changes* — drop it in the right folder and `init` picks it up on the next run. Same for `update`'s diff and `manifest.mjs`'s checksum tracking.

## Conventions for new skills/agents/scripts

- **Skills** live under `skills/<name>/SKILL.md` with YAML frontmatter (`name`, `description`). Follow [Anthropic's skill best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices): third-person descriptions, body under 500 lines, forward slashes, consistent terminology.
- **Templates** for skills live under `skills/<name>/templates/<artifact>.md`. SKILL.md should *reference* the template ("Read `templates/foo.md`, then…") rather than inline it. This keeps SKILL.md short, lets templates be edited independently, and follows the progressive-disclosure pattern.
- **Agents** are single `.md` files under `agents/` with subagent frontmatter (`name`, `description`). Single-responsibility, scoped tool allowlists.
- **Scripts** are `.mjs` files under `scripts/`. Prefer adding a script over hardcoding shell into a skill or agent prompt. They install to `.claude/scripts/` and are invoked from there (e.g. `node .claude/scripts/trace-summarise.mjs`).
- **References** are `.md` files under `references/`, installed to `.claude/specsmith/references/`. They hold progressive-disclosure content that an agent file links to by path rather than inlining — technique catalogues, language pitfalls, worked examples. They must NOT live under `agents/`: everything in `.claude/agents/` is loaded as a subagent definition, and `listAgents()` is non-recursive so they would not ship at all.
- **Every documented anti-pattern ships with a mechanism, or it is a comment rather than a control.** Prose bans do not hold at scale: three files told agents to read `run-state.md` once and the next audited run read it 24 times, up from the 10 the instruction was written to prevent. The bans that hold are the ones promoted to a guard hook or absorbed into a helper script (`TRACE_JSONL_RE`, `run-gate.mjs`, `guard-repeat-reads.mjs`). When adding an anti-pattern to an agent file, add its enforcement in the same change.
- **Top-level package files** (`launch.json`, `templates/constitution.md`, `templates/claude-md-section.md`) are merged into the host project, not copied verbatim — see `lib/merge.mjs`.
- The PRD → plan → data-model → tasks artifacts produced by the pipeline are durable working documents during a project. Treat them as state, not scratch.

## Common commands

- `node bin/cli.mjs --help` — print CLI help locally without npm install
- `node bin/cli.mjs init --dry-run` — preview an install against the current directory
- `node bin/cli.mjs update --dry-run` — preview what an update would change
- `npm test` — run the test suite (plain `node` test files under `tests/`, one per guard hook / diff script)

There is no build or lint step — the CLI is plain ESM, no transpilation.
