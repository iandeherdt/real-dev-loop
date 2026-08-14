#!/usr/bin/env node
// Tests for scripts/spec-status.mjs — the state reader `/extend-spec` runs
// before amending anything.
//
// Two of its outputs are correctness-critical rather than cosmetic:
// the next free FR/NFR/SC/OQ number (identifiers are append-only; a collision
// silently repoints every task and carryover that cited the original), and the
// next free phase number (phase-block.mjs anchors on `## Phase N:`, so a
// duplicate breaks /build's dispatch).
//
// Run with: `node tests/spec-status.test.mjs` or `npm test`.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'spec-status.mjs');
const SPEC = 'specs/038-partial-payment-linking';

let failures = 0;

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
  else { console.log(`ok   ${msg}`); }
}

function makeProject({ prd, tasks, feedback = {}, buildLog } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'spec-status-'));
  mkdirSync(join(root, SPEC), { recursive: true });
  if (prd !== undefined) writeFileSync(join(root, SPEC, 'prd.md'), prd);
  if (tasks !== undefined) writeFileSync(join(root, SPEC, 'tasks.md'), tasks);
  if (Object.keys(feedback).length) {
    mkdirSync(join(root, 'pipeline', 'feedback'), { recursive: true });
    for (const [name, body] of Object.entries(feedback)) {
      writeFileSync(join(root, 'pipeline', 'feedback', name), body);
    }
  }
  if (buildLog !== undefined) {
    mkdirSync(join(root, 'pipeline'), { recursive: true });
    writeFileSync(join(root, 'pipeline', 'build-log.md'), buildLog);
  }
  return root;
}

function run(root, args = [SPEC]) {
  return spawnSync('node', [SCRIPT, ...args], { cwd: root, encoding: 'utf8' });
}

function runJson(root) {
  const r = run(root, [SPEC, '--json']);
  return JSON.parse(r.stdout);
}

const PRD = `# PRD: Partial payment linking

## Functional requirements
- **FR-001**: Credit a payment to a period.
- **FR-014**: Show outstanding cents.
- **FR-028**: Sort results by created_at DESC.

## Non-functional requirements
- **NFR-005**: Page loads under 400ms.

## Success criteria
- **SC-011**: 95% of partial payments link in one click.

## Open questions
- **OQ-002**: Should surplus roll forward? **Resolved**: yes.
- **OQ-003**: What happens on refund?
`;

const TASKS = `# Tasks

## Phase 1: Foundation
- [x] Create settlement.ts
- [x] Verify settlement rules

## Phase 4: UI
- [x] Build PeriodsTimeline
- [ ] Add unlink control

## Notes
- [ ] this bullet is not inside a phase
`;

// ── Identifiers ──
{
  const root = makeProject({ prd: PRD, tasks: TASKS });
  const r = runJson(root);
  assert(r.nextIds.FR === 'FR-029', 'next FR follows the highest used (FR-028 → FR-029)');
  assert(r.nextIds.NFR === 'NFR-006', 'NFR is counted separately from FR');
  assert(r.nextIds.SC === 'SC-012', 'next SC follows the highest used');
  assert(r.nextIds.OQ === 'OQ-004', 'next OQ follows the highest used');
  rmSync(root, { recursive: true, force: true });
}

// ── NFR must not be swallowed by the FR pattern ──
// `\b(FR|NFR)\b` alternation order matters: FR-first would match the "FR" tail
// of "NFR-005" and report a bogus FR high-water mark.
{
  const root = makeProject({ prd: '## Functional requirements\n- **NFR-090**: x\n', tasks: TASKS });
  const r = runJson(root);
  assert(r.nextIds.FR === 'FR-001', 'an NFR does not raise the FR high-water mark');
  assert(r.nextIds.NFR === 'NFR-091', 'the NFR high-water mark is read correctly');
  rmSync(root, { recursive: true, force: true });
}

// ── Phases ──
{
  const root = makeProject({ prd: PRD, tasks: TASKS });
  const r = runJson(root);
  assert(r.nextPhase === 5, 'next phase follows the HIGHEST number, not the count (1,4 → 5)');
  assert(r.phases.length === 2, 'only `## Phase N:` headings are counted as phases');
  assert(
    r.phases.find((p) => p.num === 4).open === 1,
    'unchecked tasks are counted per phase'
  );
  assert(
    r.openTasks.length === 1 && r.openTasks[0].phase === 4,
    'a bullet outside any phase is not reported as an open task'
  );
  rmSync(root, { recursive: true, force: true });
}

// ── Empty tasks.md ──
{
  const root = makeProject({ prd: PRD, tasks: '# Tasks\n' });
  const r = runJson(root);
  assert(r.nextPhase === 1, 'a tasks.md with no phases reports phase 1 as next');
  rmSync(root, { recursive: true, force: true });
}

// ── Missing tasks.md ──
{
  const root = makeProject({ prd: PRD });
  const r = run(root);
  assert(r.status === 0, 'a missing tasks.md is reported, not fatal');
  assert(/tasks\.md: MISSING/.test(r.stdout), 'the report names the missing tasks.md');
  rmSync(root, { recursive: true, force: true });
}

// ── Open questions ──
{
  const root = makeProject({ prd: PRD, tasks: TASKS });
  const r = runJson(root);
  assert(r.openQuestions.length === 1, 'only unresolved open questions are listed');
  assert(/OQ-003/.test(r.openQuestions[0]), 'the unresolved OQ-003 is the one reported');
  assert(
    !r.openQuestions.some((q) => /OQ-002/.test(q)),
    'an OQ marked **Resolved** is excluded'
  );
  rmSync(root, { recursive: true, force: true });
}

// ── Carryovers: only the latest cycle per phase ──
{
  const root = makeProject({
    prd: PRD,
    tasks: TASKS,
    feedback: {
      'phase-4-cycle-1.md': '## Carryovers (must fix next cycle)\n- [ ] **[High]** superseded by cycle 2\n',
      'phase-4-cycle-2.md':
        '## Carryovers (must fix next cycle)\n' +
        '- [ ] **[High]** src/PeriodsTimeline.tsx — surplus badge missing\n' +
        '- [x] **[Low]** already fixed\n' +
        '## What Worked Well\n- [ ] not a carryover\n',
    },
  });
  const r = runJson(root);
  assert(r.carryovers.length === 1, 'only the highest cycle per phase is read');
  assert(r.carryovers[0].cycle === 2, 'cycle 2 supersedes cycle 1');
  assert(r.carryovers[0].items.length === 1, 'ticked carryovers and later sections are excluded');
  assert(/surplus badge missing/.test(r.carryovers[0].items[0]), 'the open carryover text is captured');
  rmSync(root, { recursive: true, force: true });
}

// ── Carryovers: absent feedback warns about the wipe ──
// clean-run-artifacts.mjs empties pipeline/feedback/ at the start of every
// /build, so "no carryovers" can mean "already rebuilt", not "clean run".
{
  const root = makeProject({ prd: PRD, tasks: TASKS });
  const r = run(root);
  assert(/Unresolved carryovers: none found/.test(r.stdout), 'absent feedback is stated plainly');
  assert(
    /wiped at the start of every \/build run/.test(r.stdout),
    'the report warns that a rebuild destroys the evidence'
  );
  rmSync(root, { recursive: true, force: true });
}

// ── Build log: last verdict per phase, including BLOCKED ──
{
  const root = makeProject({
    prd: PRD,
    tasks: TASKS,
    buildLog:
      'Phase 4 — Cycle 1 — 2026-08-14T04:25Z\nVerdict: FAIL — retrying with feedback\n\n' +
      'Phase 4 — Cycle 2 — 2026-08-14T05:05Z\nVerdict: PASS — moving to next phase\n\n' +
      'Phase 6 — Cycle 1 — 2026-08-14T06:58Z\nVerdict: BLOCKED — pixel-diff plateau — awaiting user\n',
  });
  const r = runJson(root);
  assert(r.buildLog.length === 2, 'one entry per phase, not per cycle');
  assert(
    r.buildLog.find((e) => e.phase === 4).verdict.startsWith('PASS'),
    'the latest cycle wins for a phase'
  );
  assert(
    /BLOCKED/.test(r.buildLog.find((e) => e.phase === 6).verdict),
    'a BLOCKED verdict is surfaced'
  );
  rmSync(root, { recursive: true, force: true });
}

// ── Failure modes ──
{
  const root = makeProject({});
  const r = run(root);
  assert(r.status === 1, 'a spec folder without prd.md exits non-zero');
  assert(/prd\.md not found/.test(r.stderr), 'the error names the missing prd.md');
  rmSync(root, { recursive: true, force: true });
}
{
  const root = makeProject({ prd: PRD });
  const r = run(root, []); // no folder, and the temp dir is not a feature branch
  assert(r.status === 1, 'an unresolvable spec folder exits non-zero');
  assert(/could not resolve a spec folder/.test(r.stderr), 'the error explains how to recover');
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
