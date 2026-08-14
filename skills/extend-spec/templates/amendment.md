<!--
Two blocks. The first appends to prd.md; the second appends to tasks.md.
Copy the headings verbatim — `/build` and phase-block.mjs match on
`## Phase N:`, and spec-status.mjs matches on `## Amendments`.
-->

# Block 1 — append to `prd.md`

Create the `## Amendments` section on the first amendment; append a new `###`
entry on every round after that. It goes at the very end of the PRD, after
Open questions.

```markdown
## Amendments

### Amendment <M> — <YYYY-MM-DD> — <short title>

**Trigger**: <what surfaced this — "evaluator carryover, phase 4 cycle 2",
"BLOCKED verdict on pixel-diff plateau", "user report: surplus badge shows a
negative amount", "gap found while using the feature">

**Kind**: Defect | Gap | Change | Deferred   <!-- one per item if mixed -->

**Changes**:
- Added `FR-###`: <one line>
- Amended `FR-###`: <what it said before → what it says now, and why>
- Resolved `OQ-###`: <the answer>
- Added `SC-###`: <one line>

**Plan impact**: <"none — fix is inside src/lib/x.ts, already in Files to
touch" | "Files to touch: +src/lib/settlement/refund.ts" | "data-model.md:
PaymentCredit gains refundedAt">

**Tasks**: Phase <N> — <count> unchecked
```

<!--
A Defect adds no FR. Cite the FR that was violated in the Changes list:
`- Defect against FR-014: outstandingCents returned a negative value on
surplus; no requirement change.`
-->

---

# Block 2 — append to `tasks.md`

Append as the LAST phase. `N` is the next free phase number from
`spec-status.mjs` — never renumber, never insert in the middle.

```markdown
## Phase <N>: Amendment <M> — <short title>

<One sentence: what this phase closes, and what triggered it.>

### Fixes

- [ ] <Verb-led fix task> (fixes FR-###)
- [ ] Verify <what the evaluator checks in the browser to confirm the fix>

### Regression checks

<!--
One per previously-passing behaviour this amendment could break. Derive them
from the files the fix touches: anything else that imports the same module,
renders the same route, or asserts the same requirement. This is what makes a
rebuild trustworthy instead of hopeful.
-->

- [ ] Verify <existing behaviour> still holds on <route/module> (FR-###)

### Coverage

<!-- One per new SC-###. Drop this sub-section if the amendment added none. -->

- [ ] Cover SC-### with <assertion / Playwright check>
```

<!--
Sub-headings use `###` on purpose. phase-block.mjs ends a phase block at the
next `## ` heading, so a `##` sub-heading here would truncate the phase and
/build would dispatch only part of it.
-->
