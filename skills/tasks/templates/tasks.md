# Tasks: <Feature name>

**Plan**: [plan.md](plan.md)
**Data model**: [data-model.md](data-model.md)

<!--
Drop any phase below that the plan does not need.
For each implementation task, include a sibling check task the evaluator
verifies. No agent tags — the orchestrator routes; the evaluator decides done.
-->

## Phase 1: Foundation

- [ ] <Verb-led task — scaffolding, deps, config, env vars, base layout>
- [ ] <Sibling check — what the evaluator verifies>

## Phase 2: Persistence

- [ ] <task — migration, schema, seed, repository helper>
- [ ] <check — e.g. "Verify migration runs cleanly on empty DB and schema matches data-model.md">

## Phase 3: API

- [ ] <task — route handler, contract, validation>
- [ ] <check>

## Phase 4: UI

- [ ] <task — component, page, styling>
- [ ] <check>

## Phase 5: Integration

- [ ] <task — worker, external provider, job, webhook>
- [ ] <check>

## Phase 6: Hardening

- [ ] <task — error path, observability, performance, accessibility, i18n>
- [ ] <check — e.g. "Cover SC-001 with Playwright assertion">

## Phase 7: Full verification

<!--
ALWAYS LAST, and never dropped. Every other phase verifies a slice; this one
verifies the whole thing after all the slices are in.

These are different in kind from the tasks above. A feature task records a
behaviour an evaluator confirmed in a browser — it stays [x] forever, because
that behaviour was genuinely verified. A gate here asserts a property of the
ENTIRE codebase at one moment, so it goes stale as soon as anything changes.
That is why /extend-spec re-emits this block at the end of every amendment
phase rather than trusting the earlier tick.

Use the commands recorded in pipeline/environment-facts.md. Drop a gate the
project genuinely does not have (a library with no build step); do not drop
one merely because it is slow.
-->

- [ ] Full test suite passes — `node .claude/scripts/run-gate.mjs test --wait 590 -- <full suite command>`
- [ ] Production build succeeds — `node .claude/scripts/run-gate.mjs build --wait 590 -- <build command>`
- [ ] Typecheck clean across the whole repo — `node .claude/scripts/run-gate.mjs typecheck -- <typecheck command>`
- [ ] Lint clean across the whole repo, zero warnings — `node .claude/scripts/run-gate.mjs lint -- <lint command>`
- [ ] Verify every `SC-###` in prd.md has a passing check somewhere in this task list
