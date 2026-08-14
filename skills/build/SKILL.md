---
name: build
description: Run the dev/eval loop for an implementation. Reads the active spec branch's tasks.md, picks the next phase with unchecked items, delegates implementation to the developing-features subagent and verification to the evaluating-phases subagent, and iterates until every task in every phase is checked. Use after /tasks has produced specs/NNN-<slug>/tasks.md.
---

# Build

Implement every phase from the active spec branch's `tasks.md`. Each phase loops through developer → evaluator until the evaluator passes.

## Configuration

Model assignment per subagent. Change these to control cost/quality tradeoffs:

| Subagent              | Model                              | Rationale |
|-----------------------|------------------------------------|-----------|
| developing-features   | $DEVELOPER_MODEL (default: sonnet) | Heavy code generation — sonnet balances speed and quality |
| evaluating-phases     | $EVALUATOR_MODEL (default: sonnet) | Browser verification — sonnet balances thoroughness and token cost |

Override by setting these variables before invoking `/build`, or edit the defaults above.

## Prerequisites

Resolve the active spec branch first: list the `specs/` directory and pick the highest-numbered (latest) `NNN-<slug>` subfolder — that is `<latest-branch>`. All spec paths below use this root.

Verify these exist:
- `specs/<latest-branch>/prd.md`
- `specs/<latest-branch>/plan.md`
- `specs/<latest-branch>/data-model.md`
- `specs/<latest-branch>/tasks.md`

If any are missing, tell the user to run the upstream skills first (`/write-prd`, `/plan`, `/tasks`).

## Run state cache (write once at the start of the run)

Before the first phase, write `pipeline/run-state.md` so subagents do not re-discover what you already resolved. Overwrite any existing file:

```markdown
# Run State

**Run type**: build
**Started**: <current ISO timestamp>
**Spec branch**: specs/<latest-branch>
**Phase count**: <total phases in tasks.md>
**Has designs/**: yes | no
**Constitution path**: .claude/constitution.md

**Working tree at run start** (output of `git status --porcelain`):
```
<paste the bash output verbatim>
```
```

Run `git status --porcelain` once at startup and embed the output in the block above. This snapshot kills the most common waste pattern: the orchestrator re-querying git repeatedly throughout a phase ("did I commit this yet?", "which files am I touching?", "what's untracked?"). After the snapshot is written, refer back to it rather than re-running git status. Re-query only when you yourself have committed something (i.e. the tree state actually changed).

Update the per-phase detail at the start of each phase (append or rewrite the **Phase in progress** block):

```markdown
**Phase in progress**: Phase <N> — Cycle <C>
**Phase name**: <e.g. Persistence>
```

Subagents will read this file before any other discovery. Do not list `specs/` or otherwise re-validate facts that already live here.

### Orchestrator: keep state files in working memory, don't re-read between cycles

You (the build orchestrator) read `pipeline/run-state.md` and `pipeline/environment-facts.md` ONCE at the start of the run, then hold their contents in working memory for the rest of the /build session. Re-reading them at the top of every phase / cycle is pure waste — they are short, you already have them, and the only deltas come from:

- the per-phase "Phase in progress" block you write yourself (you know what you wrote)
- environment-facts corrections the developer subagent may log in their commit message ("Corrected environment-facts.md: <what>") — if you see such a message in the subagent return, re-read `environment-facts.md` then; otherwise do not

A previous /build run re-read `run-state.md` 10× and `environment-facts.md` 9× across one session (~72 KB of duplicate context). Stop after the first read; trust your context.

## Clean previous run artifacts (run once, before the first phase)

`pipeline/feedback/` and `pipeline/traces/` are per-run scratch space. Stale phase feedback files, screenshots, and JSONL traces from earlier builds are noise once a new run starts — they confuse the orchestrator when it scans for already-completed work, and they bloat trace digests with content from prior features. Run the cleanup helper once, before the first phase:

```bash
node .claude/scripts/clean-run-artifacts.mjs
```

The script wipes `pipeline/feedback/` and `pipeline/traces/` and leaves the persistent caches untouched (`build-log.md`, `environment-facts.md`, `procedures.md`, and `run-state.md` — the last is overwritten by the next orchestrator step anyway). Pass `--dry-run` to preview without touching the disk.

If the user has a reason to preserve a prior run's feedback, they should copy `pipeline/feedback/` somewhere safe before invoking `/build`.

## Process

Walk `specs/<latest-branch>/tasks.md` in order. For each phase that contains at least one unchecked `- [ ]` item, run the loop below. Phases whose items are all `- [x]` are skipped.

Per phase, max cycles: $MAX_CYCLES (default 5).

### Step 0 — Extract the phase block

Before invoking the developer or evaluator, extract just the lines for the phase in scope. Pass this as a fenced markdown block in both subagent prompts so neither has to re-read the full `tasks.md` every cycle — `tasks.md` typically runs 20–30 KB on a non-trivial feature, and re-reading it in both subagents on every cycle is pure waste.

```bash
PHASE_NUM=2  # the phase number in scope (reused by later steps)
node .claude/scripts/phase-block.mjs specs/<latest-branch>/tasks.md "$PHASE_NUM"
```

The output is the phase heading plus every `- [ ]` / `- [x]` task line under it, ending where the next `## ` heading starts. Hold this output as the **phase block**.

**Always use the script — do not hand-roll the extraction with `awk`/`grep`.** The script exists precisely because the inline awk it replaced was repeatedly retyped and mangled by the orchestrator (e.g. dropping the `$0` before `~`), which threw a syntax error and silently produced an empty block — indistinguishable from "no work to do". The script anchors on `## Phase N:` so Phase 5 never matches Phase 50, and exits non-zero (with a message on stderr) if phase N isn't found, so a typo'd phase number fails loudly instead of silently returning nothing.

### Step 0b — Slice large phases before dispatch

Count unchecked `- [ ]` tasks in the phase block with the same script:

```bash
UNCHECKED=$(node .claude/scripts/phase-block.mjs specs/<latest-branch>/tasks.md "$PHASE_NUM" --count)
```

If `UNCHECKED > $SLICE_THRESHOLD` (default `8`), do NOT dispatch the whole phase as one developer call. Single subagents stall on large phases — they run out of attention partway through, the orchestrator pays for a half-completed run, and the work has to be redone in slices anyway (this is exactly what happened in Phase 2 of `006-property-compliance-and-finance`, where a 13-file dispatch had to be split into 3 retroactively).

Instead, split the phase block into sequential developer dispatches:

1. **Group tasks into natural sub-sections** of ~4–6 unchecked tasks each. Prefer boundaries that match the work — all migrations together, all new repository files together, all schema work together, all route handlers together. Don't split a task and its sibling check across slices.
2. **Dispatch each slice as its own `developing-features` Agent call**, in order. Each call gets fresh context, so slice B's developer won't have slice A's working memory — that's fine, they'll see slice A's edits in `git diff HEAD` and on disk.
3. **Wait for each slice to return** before dispatching the next. The Agent tool blocks until the subagent finishes, so serial dispatch is automatic — don't try to parallelise slices, they share files.
4. **Pass the slice as the phase block** in the developer prompt, with a header line naming it (e.g. `### Slice A of 3: migrations`) so the developer knows it's a subset and won't panic about the missing tasks.
5. **After the last slice returns, proceed to Step 1b → Step 2 as normal**. The evaluator runs ONCE at the end against the **full** phase block, not per slice — slicing is a developer-side mitigation, the phase still has to pass as a whole.

If a slice fails (developer reports a blocker), stop and report; do not push on to the next slice. The phase-level retry loop (cycles 1..N) will pick the whole phase up again, and the orchestrator can re-slice differently next cycle if needed.

Skip this step when `UNCHECKED <= $SLICE_THRESHOLD`. The threshold is tunable per-project by setting `$SLICE_THRESHOLD` before invoking `/build`.

### Dispatch lock lifecycle (every Agent call)

Inside an active /build run the **`guard-orchestrator-discipline.mjs`** hook (installed by default since v0.19.0) refuses Bash invocations of dev/designs servers, `pixel-diff.mjs`, `dom-diff.mjs`, and the `run-*` wrappers from the orchestrator. It also refuses Edit/Write on `pipeline/dev-server-url` and `pipeline/designs-server-url`. The hook recognises a subagent context via a sentinel file: **`pipeline/dispatch-active.txt`**.

**The lock manages itself — you do nothing.** The guard opens `pipeline/dispatch-active.txt` when it sees your `Agent` dispatch, and the trace hook removes it on `SubagentStop`. Do NOT write or delete that file by hand.

Earlier versions asked the orchestrator to `printf` the sentinel before every Agent call and `rm -f` it after. That was 40 Bash calls of pure ceremony in one audited run — two extra round-trips per dispatch — and it could be forgotten, in which case the subagent's first legitimate tool call was refused and the message blamed the orchestrator. The hooks see every dispatch and every return anyway, so they own it now.

The lock still has a 30-minute TTL inside the guard, as the backstop for a crashed run.

You may run **read-only** helpers without opening the lock:

- `node .claude/scripts/show-pixel-diff.mjs` — prints the verdict, failed routes, and top regions from `pipeline/feedback/pixel-diff.json`.
- `node .claude/scripts/show-dom-diff.mjs` — same for `pipeline/feedback/dom-diff.json`.
- `node .claude/scripts/ensure-servers.mjs [--designs]` — idempotent check; only starts a server if its URL marker is missing or unreachable. Calling this from the orchestrator is fine — it's a check, not a re-run.

Do **not** wrap your own `node -e '...'` / `python3 -c '...'` / `perl -e '...'` to extract one field from the JSON. The long-inline-script guard (extended in v0.19.0) refuses interpreter-agnostic blobs over 200 characters with a message pointing here. Use the helpers.

### Step 1 — Developer

Call the Agent tool with `subagent_type: "developing-features"` and `model: "sonnet"`. The prompt MUST include:
- Phase number, phase name, cycle number, spec branch
- The **contents** of `pipeline/run-state.md` and `pipeline/environment-facts.md`, pasted inline as fenced markdown blocks (see below)
- The phase block extracted in Step 0, as a fenced markdown block
- On retries: the path to the prior cycle's feedback file
- On retries: the **Carryovers list** copied verbatim from the prior cycle's feedback file, embedded as a fenced markdown block

#### Paste the caches, don't point at them

Paste the two cache files inline, exactly as you already do for the phase block:

```
## Run state (do not re-read pipeline/run-state.md)
```
[contents of pipeline/run-state.md]
```

## Environment facts (do not re-read pipeline/environment-facts.md)
```
[contents of pipeline/environment-facts.md]
```
```

You hold both files in working memory already, so this costs you nothing and removes the subagent's reason to open them at all. Pointing at a path instead does not work: three separate files told agents to read these once and trust their context, and the run that followed read `run-state.md` 24 times and `environment-facts.md` 29 times — worse than the 10x/9x the instruction was written to prevent. The `guard-repeat-reads.mjs` hook now refuses the redundant reads outright; pasting the contents means the subagent never needs to try.

The subagent still *writes* to `environment-facts.md` when it corrects or discovers a fact — only the read is eliminated. If a subagent reports a correction, re-read the file once before the next dispatch so the block you paste stays accurate.

#### Carryover extraction (retries only)

The evaluator writes a `## Carryovers (must fix next cycle)` section in every feedback file. On a retry, extract that block and paste it directly into the developer prompt — do not re-narrate it, do not summarise, do not reorder. The list is the operational contract:

```bash
PRIOR_FEEDBACK="pipeline/feedback/phase-${PHASE_NUM}-cycle-$((CYCLE - 1)).md"
awk '
  /^## Carryovers \(must fix next cycle\)/ { in_block = 1; next }
  in_block && /^## / { in_block = 0 }
  in_block
' "$PRIOR_FEEDBACK"
```

Embed the result in the developer prompt as:

```
## Carryovers from Phase [N] Cycle [C-1] (must fix BEFORE new tasks)

```
[paste carryover block here]
```

Fix every box above before any new phase task. Each box must be checked when you hand off — the next evaluator cycle will reject the phase if any are still open.
```

If the carryover block is empty (`_None — phase passes._`) but the orchestrator still scheduled a retry (e.g. score below threshold without High issues — uncommon but possible), fall back to passing the full feedback file path and let the developer infer.

### Step 1b — Verify environment facts gate

After the developer subagent returns and **before** invoking the evaluator, run:

```bash
node .claude/scripts/verify-environment-facts.mjs
```

This catches orphan dev-server processes the developer's `pkill` may have missed (commonly `next dev`, but the same pattern shows up with Vite, Remix, etc.) and wrong DB-path recordings in `pipeline/environment-facts.md`. **If it exits non-zero, do NOT invoke the evaluator** — log the failure and loop back to Step 1 with feedback to the developer. The developer should also have run this script in their own Step 4, but doing it here is defense in depth.

### Step 2 — Evaluator

Call the Agent tool with `subagent_type: "evaluating-phases"` and `model: "sonnet"`. The prompt should include the phase context AND the phase block — the agent file handles everything else:

```
Evaluate Phase [N] (<phase name>), Cycle [C].
Spec branch: specs/<latest-branch>/
Procedures (login etc.): pipeline/procedures.md
Write feedback to: pipeline/feedback/phase-[N]-cycle-[C].md

Phase block (do not re-read tasks.md):
```
[paste the phase block here]
```

Run state (do not re-read pipeline/run-state.md):
```
[paste the contents of pipeline/run-state.md here]
```

Environment facts (do not re-read pipeline/environment-facts.md):
```
[paste the contents of pipeline/environment-facts.md here]
```
```

Do NOT add ToolSearch commands, browser rules, scoring rubrics, or verification steps to the prompt. The evaluator agent file has all of that.

### Step 3 — Check results

Read the evaluator's feedback file and output:

1. **Check for `<promise>BLOCKED</promise>` FIRST.** If present, extract the `<reason>...</reason>` body. Halt the entire build loop — do NOT invoke the next phase, do NOT retry, do NOT mark the current phase complete. Append a BLOCKED entry to `pipeline/build-log.md` (see Logging below) and print to the user:
   ```
   Build halted at Phase [N] Cycle [C] — BLOCKED.

   Reason: <reason body verbatim>

   The build cannot proceed without your input. See pipeline/feedback/phase-[N]-cycle-[C].md for full context, then re-invoke /build after the decision is made (e.g. tune `pixelDiff.maxDiffPct`, defer a route in `pixelDiff.routes`, update `prd.md` with an FR-###, etc.).
   ```
   Then exit /build cleanly. The user is in the driver's seat.

2. **Otherwise check for `<promise>COMPLETE</promise>` or `<promise>PERFECT</promise>` signals.**
3. **Also read the feedback file** — do NOT just check the signal:
   - If there are any **[High]** severity issues, the phase does NOT pass regardless of score. Loop back to Step 1.
   - If **Unresolved Issues** from a prior cycle are still listed, the phase does NOT pass. Loop back to Step 1.
4. PASS (signal present, no High issues, no unresolved carry-overs) → log success, move to next phase.
5. FAIL → log failure with specific issues, loop back to Step 1.

`BLOCKED` is checked first because it is mutually exclusive with all other outcomes — an evaluator that emits both `BLOCKED` and `COMPLETE` is malformed, and the BLOCKED state should win to keep the human in the loop.

## Logging

Append to `pipeline/build-log.md`:

```
Phase [N] — Cycle [C] — [Timestamp]

Developer: completed
Evaluator: PASS/FAIL/BLOCKED — Score X.X/10
High issues: [list any High severity items, or "none"]
Unresolved from prior: [list any, or "none"]
Verdict: [PASS — moving to next phase / FAIL — retrying with feedback / BLOCKED — <reason> — build halted, awaiting user]
```

## Failure handling

- After max cycles, write unresolved issues to `pipeline/build-log.md`
- Report to the user what's blocking and which issues could not be resolved
- **`BLOCKED` is not a failure** — it is a deliberate halt for a user decision (see Step 3). Do NOT count a BLOCKED cycle toward `$MAX_CYCLES`, and do NOT re-dispatch the developer on the same phase after a BLOCKED. The /build skill exits; the user re-runs /build after the decision is made.

When you halt — BLOCKED, max cycles exhausted, or a design-fidelity gap that needs `tasks.md` updated — point the user at `/extend-spec`:

> `/extend-spec` records the decision in `prd.md` and appends the remaining work as a new phase, so the next `/build` resumes through the normal loop instead of being fixed by hand.

This matters most right here, because `clean-run-artifacts.mjs` wipes `pipeline/feedback/` at the start of the *next* /build run. The evaluator's carryovers and the BLOCKED reason only exist until then — extending before rebuilding is what preserves them.

## Rules

- **Never implement or evaluate yourself — always delegate.** This is Constitution Principle VIII (Scope Discipline) at the orchestrator level. Once you dispatch a developer or evaluator via the `Agent` tool, your scope is "wait for the return, then route the next step" — not "do the work inline while waiting". Concretely: between an `Agent` dispatch and its return, your ONLY allowed tool calls are read-only ones (Read the dispatched return, Read the feedback file the evaluator just wrote, status snapshots that don't mutate state). If you find yourself reaching for `Edit` / `Write` / `Bash` on source files mid-dispatch, stop. That's the developer's job, not yours. A real failure mode caught in the wild: orchestrator dispatched Slice A, then did Slices A-F's work itself inline, never invoked the evaluator, and committed checkboxes flipped without verification. Don't be that orchestrator.
- **Never run pixel-diff, dom-diff, or the dev/designs servers yourself.** The orchestrator-discipline guard (installed by default since v0.19.0) refuses those Bash calls outside the dispatch lock. The evaluator runs them — its outputs land on disk at `pipeline/feedback/pixel-diff.json` and `pipeline/feedback/dom-diff.json`. To read them, use `node .claude/scripts/show-pixel-diff.mjs` and `node .claude/scripts/show-dom-diff.mjs`. To check whether a server is up, use `node .claude/scripts/ensure-servers.mjs`. Don't re-implement these checks inline.
- **Do not edit specsmith tooling paths.** Edits to `.claude/scripts/`, `.claude/agents/`, `.claude/skills/`, `.claude/specsmith/`, or `templates/` are out-of-scope for a feature build per Constitution Principle VIII. The `guard-scope.mjs` hook (installed by default since v0.15.0) will refuse such edits with a clear message. If you need to change specsmith itself, that is a separate spec in the specsmith repository, not a side effect of this build.
- **Pre-existing convention violations are carryovers, not immediate work.** If `check-conventions.mjs` flags a file that was already over its line cap on `HEAD` (i.e. before this branch existed), record it in the carryover list of the current cycle's feedback file. Do NOT spend the current phase paging through the file and splitting it — that's a separate refactor spec.
- Each subagent gets fresh context automatically
- Pass `subagent_type` to the Agent tool: `"developing-features"` for developer, `"evaluating-phases"` for evaluator
- Keep the evaluator prompt minimal — only phase context. The agent file handles browser tools, rules, and scoring
- Pass the full feedback file path to the developer on retries
- A phase with unresolved High-severity issues NEVER passes, even if the score is above threshold
- If the evaluator's feedback has zero screenshots or says browser tools were unavailable, treat it as invalid and retry

## Design-fidelity issues are NEVER scope creep

This rule exists because of a real failure mode (Phase 4 of `002-landlord-dashboard`, 2026-05-15): the cycle-1 evaluator flagged a missing prototype region (a Portefeuille summary card present in `designs/dashboard.html` but absent from the implementation), and the orchestrator told the cycle-2 developer "do NOT add it — plan.md only enumerates 6 cards, this is scope creep." The phase then passed at 9.0/10 with the visual gap intact.

That was wrong. The prototype is the contract per the constitution's Design Fidelity principle. When `plan.md` and `designs/*.html` disagree about scope, the design wins for visual structure.

When you write the cycle-N+1 developer prompt:

- **NEVER** add an "explicitly out of scope" / "do NOT add" instruction for any item the evaluator flagged as a **design-fidelity gap** (missing prototype region, layout mismatch, structurally absent section). These are, by definition, in scope — the prototype defined the scope at `/design` time.
- If the evaluator flagged a missing region but the corresponding task is not in `tasks.md`, you have two options:
  1. **Preferred**: stop the loop, print "Design fidelity gap detected — `tasks.md` is missing tasks for prototype region(s) [...]. Re-run `/tasks` to merge in the missing regions, then re-invoke `/build`." Then exit without invoking another developer cycle. The user re-runs `/tasks` (which will merge in the orphan regions from `designs/coverage.md`) and re-invokes `/build`, which then continues the phase with the merged scope.
  2. **Acceptable** (when the gap is one or two items and re-running `/tasks` would be heavyweight): include the missing region in the next cycle's fix list AND in the same turn append the corresponding task(s) to `tasks.md` yourself with the Edit tool, so the evaluator's bookkeeping stays accurate.

The wrong move is the third option — telling the developer "don't bother, it's scope creep". Plan-vs-design tension is real, but it is resolved by updating the plan/tasks, not by ignoring the design.

The constitution's Design Fidelity principle is the tiebreaker, not `plan.md`'s files-to-touch table.
