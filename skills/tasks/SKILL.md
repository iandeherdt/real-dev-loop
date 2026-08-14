---
name: tasks
description: Generates a phased implementation task list (tasks.md) from plan.md and data-model.md. Use after /plan when ready to break the plan into individually-checkable units of work. Tasks are not bound to specific agents — the evaluator agent verifies each task when it is marked done. Produces specs/NNN-<feature-slug>/tasks.md with phases, each containing markdown checkbox items for implementation work and explicit verification checks.
---

# Write tasks

Decompose the plan into a sequenced, checkable task list.

## Resolve the spec folder

Determine `specs/NNN-<feature-slug>/` by parsing the current git branch name. The branch should match `^\d{3}-` (created by `/write-prd`); the folder name is the branch name verbatim. If the current branch does not match that pattern, ask the user which spec folder to operate in.

## Inputs

Read in this order:

1. `specs/NNN-<feature-slug>/plan.md`
2. `specs/NNN-<feature-slug>/data-model.md`
3. `specs/NNN-<feature-slug>/prd.md` (for cross-checking SC-### coverage)
4. `designs/coverage.md` if it exists (only relevant in merge mode — see below)

If `plan.md` or `data-model.md` is missing, stop and tell the user to run `/plan` first.

## Output

Write `specs/NNN-<feature-slug>/tasks.md` in the same spec folder. Two execution modes:

- **Fresh mode**: `tasks.md` does not exist → generate from scratch using the template.
- **Merge mode**: `tasks.md` already exists AND `designs/coverage.md` exists → run the merge procedure below; do NOT regenerate from scratch.
- **Ambiguous**: `tasks.md` exists but `designs/coverage.md` does not → ask the user whether to overwrite (`/tasks --force` semantics) or stop.

Do **not** create a new branch — `/tasks` runs on the existing feature branch.

## Merge mode

The typical pipeline runs `/tasks` twice: once after `/plan` (fresh, before `/design`), and again after `/design` (merge, to add tasks for regions the designer introduced beyond what the plan enumerated). The merge step is what closes the loop between design and implementation — without it, regions in the prototype that aren't in `plan.md` get silently dropped from the implementation pipeline.

Procedure:

1. **Read `designs/coverage.md`.** Each `## designs/<file>.html` section lists top-level regions as bullets like `` - `<ComponentName>` — <purpose> ``. Collect every `<ComponentName>` (the part inside backticks).
2. **Read existing `tasks.md`.** For each component name from step 1, search the entire `tasks.md` for a substring match (case-sensitive). A match means an existing task already covers it (whether `[ ]` or `[x]`).
3. **Identify orphans.** Component names from coverage.md with NO match in tasks.md are orphan regions — they have no implementation task and would silently disappear from `/build`'s scope.
4. **Append orphan tasks.** For each orphan, append two lines to the most appropriate phase (default: the UI phase). Use the Edit tool — read the file, find the phase header, insert before the next phase header (or at end of file if it's the last phase). Format:
   ```markdown
   - [ ] Implement `<ComponentName>` for designs/<file>.html — <purpose from coverage.md>
   - [ ] Verify `<ComponentName>` renders to match designs/<file>.html (Playwright structural diff vs prototype)
   ```
5. **Preserve existing checkmarks.** Never flip `[x]` to `[ ]`. Never remove existing tasks even if the prototype no longer references them — the evaluator caught the implementation; removing tasks would lose history.
6. **Print a summary.** "Merged N orphan regions from designs/coverage.md into tasks.md: ComponentA, ComponentB, …" If N=0, print "All design regions already covered by existing tasks." so the user knows the merge ran and was a no-op.

Stop without modifying anything if:
- `designs/coverage.md` is malformed (no `## designs/` sections, or a section has no bullets) — tell the user the designer's coverage report is broken
- A `<ComponentName>` collides with a substring in an unrelated task (very rare; flag the ambiguity for the user to resolve manually)

## Phases

Default phases — use these unless the plan obviously calls for something different:

1. **Foundation** — scaffolding, deps, config, env vars, base layout
2. **Persistence** — migrations, schema, seed data, repository helpers
3. **API** — route handlers, contracts, validation
4. **UI** — components, pages, styling
5. **Integration** — workers, external providers, jobs, webhooks
6. **Hardening** — error paths, observability, performance, accessibility, i18n
7. **Full verification** — whole-system gates: full test suite, production build, repo-wide typecheck, repo-wide lint

Drop phases that do not apply. Add a phase only when a self-contained area of the plan does not fit any of the above.

**Phase 7 is the exception: always emit it, always last.** Every other phase verifies a slice of the work; this one verifies the whole thing once all the slices are in. Without it a feature can pass every phase and still fail `npm run build`, because nothing else in the loop ever runs a production build.

Its tasks are different in kind from the rest, which is why they live in their own phase rather than being sprinkled through Hardening. A feature task records a behaviour the evaluator confirmed in a browser, and stays `[x]` forever. A gate in Phase 7 asserts a property of the entire codebase at one moment, so it goes stale the instant anything changes — `/extend-spec` re-emits the whole block at the end of every amendment phase rather than trusting the earlier tick.

## Task rules

- Each task is one checkable item: `- [ ] <verb-led description>`
- Verb-led: "Add", "Create", "Wire", "Implement", "Cover with Playwright", "Verify"
- One task = one unit of work an evaluator can verify in one pass
- **No agent tags**. Tasks are not pre-assigned to design / develop / critique / eval agents — the orchestrator decides at runtime, and the evaluator decides when each task is "done"
- For each implementation task, include a sibling **check** task that the evaluator can use to confirm completion. Examples:
  - Implementation: `- [ ] Add Drizzle schema for ContactEmail`
  - Check: `- [ ] Verify migration runs cleanly on empty DB and schema matches data-model.md`
- Reference plan.md sections by name when context is needed: `(see plan.md → "Files to touch" → src/lib/auth/config.ts)`

## Template

Use `templates/tasks.md` (sibling to this file) as the structure. Read it first, then write `tasks.md` by:

1. Copying every applicable phase heading verbatim
2. Dropping phases the plan does not need
3. Replacing each `<task>` / `<check>` placeholder with concrete `- [ ]` lines
4. Adding more `- [ ]` lines per phase as the plan and data model require

## Marking tasks done

Tasks are completed by editing this file: change `[ ]` to `[x]`. The **evaluator agent** does this, and only after verifying the implementation against `plan.md` and `data-model.md`. Do not mark a task `[x]` based on the implementer's word alone.

## Coverage discipline

Cross-check before finalizing:

- Every file in `plan.md`'s "Files to touch" table maps to at least one task. Orphan files = missing tasks.
- Every entity in `data-model.md` maps to at least one Persistence-phase task.
- Every `SC-###` in `prd.md` maps to at least one Hardening-phase verification task.
- The final Full verification phase exists and is the highest-numbered phase in the file.
- Every "Pass with waiver" row in the constitution table maps to a Hardening-phase task that documents or mitigates the waiver.

## After writing

Print:
1. The path to `tasks.md`
2. Total task count per phase
3. Any orphans found during the coverage check (files-to-touch, entities, or SCs that did not produce a task) so the user can fix the gap before kicking off design or build
