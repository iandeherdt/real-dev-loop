---
name: extend-spec
description: Folds post-build bugs, gaps, and change requests back into an existing spec instead of fixing them ad hoc. Amends prd.md with new append-only requirements, updates plan.md and data-model.md where the change is structural, and appends a new phase of unchecked tasks (fixes plus regression checks) to tasks.md so /build can pick the work up and finish it through the normal developer/evaluator loop. Use after a build completes or halts and something is wrong, missing, or newly requested.
---

# Extend spec

A feature is built, and then reality arrives: a bug, a missed edge case, a carryover the evaluator deferred, a "can it also…" from the user. Fixing those by hand leaves the spec describing a system that no longer matches the code, and the fix itself never passes through the developer → evaluator loop that verified everything else.

This skill puts that work back on the rails. It amends the spec, then appends tasks so `/build` finishes the job the way it was supposed to be finished.

## Extend, or start a new spec?

Decide this first — it is the only irreversible choice here.

**Extend** when the work is about the feature that was just built:
- a bug in its behaviour
- a requirement that was implied but never written down
- an edge case the PRD missed
- an unresolved carryover, a `BLOCKED` verdict, or a phase that hit max cycles
- a small capability that only makes sense as part of this feature

**Start a new spec** (`/grill-me` → `/write-prd`) when the request introduces a capability that stands on its own — a new user-facing surface, a new persona, a new domain concept. Extending a spec until it covers three features makes every future `/build` re-read a document that is mostly irrelevant to the phase in scope.

The test: *if this shipped separately, would it need its own PRD to make sense?* If yes, it is a new spec. Say so and stop; do not extend.

## Resolve the spec folder

Determine `specs/NNN-<feature-slug>/` by parsing the current git branch name. The branch should match `^\d{3}-` (created by `/write-prd`); the folder name is the branch name verbatim. If the current branch does not match that pattern, ask the user which spec folder to operate in.

Do **not** create a branch. `/extend-spec` amends in place on the feature branch, exactly like `/plan` and `/tasks`.

## Step 1 — Gather what is actually open

Run the status helper first. It resolves the append-only identifiers, the next free phase number, and everything the last build left behind:

```bash
node .claude/scripts/spec-status.mjs
```

It reports:
- **Next free `FR-###` / `NFR-###` / `SC-###` / `OQ-###`** — use these verbatim. Identifiers are append-only; renumbering an existing one silently invalidates every task, feedback file, and carryover that referenced it.
- **Next free phase number** — `phase-block.mjs` anchors on `## Phase N:`, so a duplicate or skipped number breaks `/build`'s dispatch.
- **Unchecked tasks per phase** — work `/build` would already pick up.
- **Unresolved carryovers** from the last cycle of each phase's feedback file.
- **Last verdict per phase** from `pipeline/build-log.md`, including any `BLOCKED` reason.
- **Open questions** still unresolved in `prd.md`.

**Run this before the next `/build`.** `clean-run-artifacts.mjs` wipes `pipeline/feedback/` and `pipeline/traces/` at the start of every run, so a rebuild destroys the evaluator's record of what it deferred. If the helper reports no carryovers and you expected some, that is probably why — ask the user rather than assuming the build was clean.

Then collect the rest of the input:
- The user's description of the problem, in this conversation.
- Any bug report, failing test, or screenshot they provide.
- `specs/glossary.md` — read it so the amendment uses the project's existing words. Do not coin a synonym for a concept it already names. (This skill only reads the glossary; `/grill-me` grows it.)

## Step 2 — Classify each item

Sort every item into one of four kinds. The kind decides which documents change:

| Kind | What it means | prd.md | plan.md / data-model.md | tasks.md |
| --- | --- | --- | --- | --- |
| **Defect** | Built code does not satisfy an existing `FR-###` | no new FR — cite the existing one | only if the fix is structural | fix task + check |
| **Gap** | Requirement was always implied, never written | new `FR-###` / `NFR-###` | if it adds files or entities | task + check |
| **Change** | Requirement itself is now different | amend the existing FR **in place**, note it in Amendments | usually yes | task + check + regression checks |
| **Deferred** | Known carryover or `BLOCKED` decision | usually none | rarely | task + check |

A **Defect** does not earn a new requirement. Writing `FR-031: the badge should not crash` turns a bug into a feature and inflates the spec. Cite the FR that was already violated.

A **Change** is the only kind that edits existing prose in place. When you amend an `FR-###`, keep its number and rewrite its body — that is what "append-only numbering" protects: the identifier is stable, the text may evolve.

If an item is genuinely ambiguous, ask the user. Do not guess between Defect and Change — they produce different amendments.

## Step 3 — Amend `prd.md`

Read `templates/amendment.md` (sibling to this file), then:

1. **Add new requirements to their existing sections.** A new functional requirement goes at the end of `## Functional requirements` as `- **FR-029**: …`, using the number the helper reported. Do not create a separate "new requirements" section — future readers should see one flat, numbered list.
2. **Amend changed requirements in place**, keeping the identifier.
3. **Append an `## Amendments` section** at the end of the file (create it if absent) with one entry per amendment round, following the template. This is the audit trail: what changed, why, what it came from, and which identifiers it touched.
4. **Resolve open questions you are answering.** If this round settles an `OQ-###`, append `**Resolved**: <answer>` to that line rather than deleting it — `/plan` treats a bare OQ as a blocker, and the resolution is worth keeping.
5. **Update `**Status**`** if the PRD carries one.

Never renumber. Never delete a requirement — if something is dropped, amend its text to say so and record it in Amendments.

## Step 4 — Amend `plan.md` and `data-model.md`

Only when the change is structural. Skip this step entirely for a defect whose fix lives inside a file the plan already lists.

Update when the amendment:
- adds or removes a file → update the **Files to touch** table (this table is `/tasks`' contract; an unlisted file produces no task)
- adds, removes, or reshapes an entity, column, index, or state transition → update `data-model.md`
- changes a constitution answer → update the **Constitution Check** row and flag any new waiver prominently
- introduces a new dependency → update **Technical Context**

Mark amended rows so a reviewer can see what moved: append `(amended <YYYY-MM-DD>)` to the row's notes cell.

If the amendment turns out to be large enough that the plan needs restructuring rather than patching, stop and tell the user to re-run `/plan` — it will regenerate `plan.md` and `data-model.md` from the amended PRD, which is cleaner than a dozen patches.

## Step 5 — Append a new phase to `tasks.md`

Append **one new phase** at the end, numbered with the next free number from Step 1. Never insert a phase in the middle: `/build` walks phases in order, and renumbering breaks `phase-block.mjs`.

The heading must be exactly `## Phase N: Amendment M — <short title>` — the `## Phase N:` prefix is what `/build` and `phase-block.mjs` match on. `###` sub-headings inside the phase are safe; another `##` heading would end the block early.

Use the structure in `templates/amendment.md`. The phase has four parts:

1. **Fixes** — one task per item, verb-led, each with a sibling check task, exactly as `/tasks` writes them. Cite the identifier the task serves: `(FR-029)` or `(fixes FR-014)`.
2. **Regression checks** — for every previously-passing behaviour this amendment could plausibly break, add a `- [ ] Verify …` task naming the `FR-###` and the route or module. Derive them from the files the fix touches: anything else that reads the same module, renders the same route, or asserts the same requirement.
3. **Coverage check** — one `- [ ] Verify …` per new `SC-###`, matching `/tasks`' coverage discipline.
4. **Full verification** — re-emit the whole-system gate block verbatim, so the run ends by checking the entire thing, not just the amendment.

### Re-emit the full verification block — always

Copy the gates from the spec's existing `## Phase N: Full verification` phase into the end of your new amendment phase (the block is in `templates/amendment.md` if the spec predates it):

- full test suite
- production build
- repo-wide typecheck
- repo-wide lint

This is not optional and it is not duplication to be tidied away. Those gates assert a property of the **entire codebase at one moment**. The moment your amendment lands, the earlier tick is describing a codebase that no longer exists — the suite that passed did not include your fix, and the build that succeeded did not compile it.

Re-emitting them here rather than un-ticking the original phase is what keeps the ordering right. `/build` walks phases in ascending order, so un-ticking Phase 7 while the amendment sits in Phase 8 would run the full verification **before** the fix and pass on stale code. The gates have to be the last thing in the last phase, which means they belong inside the amendment phase.

They are also cheap to repeat compared to everything else here: each is one `run-gate.mjs` call, and the wrapper replays a cached verdict when nothing has changed since it last ran.

Keep the phase to a size a single developer dispatch can hold. If it exceeds ~8 unchecked tasks, `/build` will slice it automatically (`$SLICE_THRESHOLD`), which is fine — but if it exceeds ~15, split it into two amendment phases along a natural boundary instead.

### Re-opening a completed task

Two kinds of ticked task, two different answers. The distinction is what the tick *means*.

**Whole-system gates** — the full suite, the production build, repo-wide typecheck and lint. A tick here means "the entire codebase was in this state at one moment". Your amendment ends that moment, so the tick is stale by construction. These get re-verified on every amendment — handled by re-emitting the Full verification block at the end of the new phase, per the section above. Do not un-tick the original phase; that runs them too early.

**Feature-behaviour tasks** — "Verify the unlink control removes the credit". A tick here means an evaluator drove a browser and watched it work. That remains true regardless of what you add later. Default: **do not un-tick**. Add a regression check in the new phase instead, which re-verifies the behaviour *after* the fix lands and leaves the original record intact.

Un-check a feature-behaviour `- [x]` only when the amendment makes the original task's *definition of done* wrong — the task as written would now be verified differently. In that case:

- Flip `[x]` → `[ ]` and amend the task text to the new definition in the same edit.
- Append ` (re-opened by Amendment M — <one-line reason>)` so the history survives.
- Tell the user in your summary, and say which phase it re-opens.

Be deliberate: `/build` re-dispatches a phase when it has **any** unchecked task, so un-ticking one task in Phase 1 makes the next run re-execute Phase 1's whole developer/evaluator cycle. That is sometimes exactly right and sometimes an hour wasted. Prefer the new phase unless the old task is genuinely wrong.

## Step 6 — Report

Print:

1. The files you amended, with paths.
2. Every identifier you added or amended (`FR-029`, `SC-012`, …) and, for amendments, what changed.
3. The new phase number, its title, and its unchecked task count.
4. Any task you re-opened, with the phase it re-opens and why.
5. Any item you classified as needing its own spec, with the reason.
6. The next step, verbatim:
   > Run `/build` to implement the amendment. It will skip every completed phase and start at Phase N.

If the amendment changed the plan structurally, add that `/grill-plan` can pressure-test the amended plan before `/build`.

## Discipline

- **Identifiers are append-only.** Take the next number from `spec-status.mjs`; never re-use, never renumber, never delete.
- **The new phase goes last.** Order in `tasks.md` is execution order.
- **Every fix task gets a check task.** An amendment with no verification is exactly the ad-hoc fix this skill exists to replace.
- **Do not implement anything.** This skill writes documents. `/build` does the work — that is the entire point of routing the fix back through the pipeline.
- **Do not touch `pipeline/`.** Feedback files and the build log are the evaluator's and orchestrator's records; read them, never edit them.
