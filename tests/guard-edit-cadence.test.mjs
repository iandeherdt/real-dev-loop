#!/usr/bin/env node
// Tests for scripts/guard-edit-cadence.mjs.
//
// Catches the blind-editing spiral (an audited run had 10 stretches of 4+
// consecutive edits to one file with no verification between them, worst case
// 8 in a row) while leaving ordinary multi-hunk editing alone.
//
// Run with: `node tests/guard-edit-cadence.test.mjs` or `npm test`.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'guard-edit-cadence.mjs');
const FILE = '/proj/src/components/PeriodsTimeline.tsx';

let failures = 0;

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
  else { console.log(`ok   ${msg}`); }
}

function makeCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'cadence-'));
  mkdirSync(join(cwd, 'pipeline', 'traces'), { recursive: true });
  return cwd;
}

function writeTrace(cwd, events) {
  const path = join(cwd, 'pipeline', 'traces', '2026-05-14T20-00-00-abcd1234.jsonl');
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(cwd, 'pipeline', 'traces', '.session-abcd1234.path'), path);
}

function pre(tool, input) {
  return { ts: '2026-05-14T20:30:00.000Z', session: 'abcd1234', event: 'tool_call', phase: 'pre', tool, input };
}

const edit = (f = FILE) => pre('Edit', { file_path: f });

function runHook(cwd, filePath = FILE) {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: filePath },
      session_id: 'abcd1234',
      cwd,
    }),
    encoding: 'utf8',
  });
}

// ── Case 1: an ordinary multi-hunk edit run is allowed ──
{
  const cwd = makeCwd();
  writeTrace(cwd, [edit(), edit(), edit(), edit()]); // this would be #5
  assert(runHook(cwd).status === 0, 'allows a 5th consecutive edit (ordinary multi-hunk change)');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 2: the 6th consecutive edit with no verification → DENY ──
{
  const cwd = makeCwd();
  writeTrace(cwd, [edit(), edit(), edit(), edit(), edit()]); // this would be #6
  const r = runHook(cwd);
  assert(r.status === 2, 'denies the 6th consecutive blind edit to one file');
  assert(/no verification in between/.test(r.stderr), 'denial explains the cadence rule');
  assert(/run-gate\.mjs/.test(r.stderr), 'denial points at the gate wrapper as the remedy');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 3: a test run resets the counter ──
{
  const cwd = makeCwd();
  writeTrace(cwd, [
    edit(), edit(), edit(),
    pre('Bash', { command: 'node .claude/scripts/run-gate.mjs test -- npx vitest run tests/x.test.ts' }),
    edit(), edit(),
  ]);
  assert(runHook(cwd).status === 0, 'a gate run resets the cadence counter');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 4: a typecheck resets the counter ──
{
  const cwd = makeCwd();
  writeTrace(cwd, [
    edit(), edit(), edit(), edit(), edit(),
    pre('Bash', { command: 'npx tsc --noEmit' }),
  ]);
  assert(runHook(cwd).status === 0, 'a typecheck resets the cadence counter');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 5: reading the file back resets the counter ──
{
  const cwd = makeCwd();
  writeTrace(cwd, [
    edit(), edit(), edit(), edit(), edit(),
    pre('Read', { file_path: FILE }),
  ]);
  assert(runHook(cwd).status === 0, 'reading the file back resets the cadence counter');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 6: a browser check resets the counter ──
{
  const cwd = makeCwd();
  writeTrace(cwd, [
    edit(), edit(), edit(), edit(), edit(),
    pre('mcp__playwright__browser_snapshot', {}),
  ]);
  assert(runHook(cwd).status === 0, 'a browser check resets the cadence counter');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 7: edits spread across files are not a spiral ──
{
  const cwd = makeCwd();
  writeTrace(cwd, [
    edit(), edit(), edit(), edit(), edit(),
    edit('/proj/src/other.ts'),
  ]);
  assert(runHook(cwd).status === 0, 'switching files resets the cadence counter');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 8: unrelated Bash work does NOT reset the counter ──
// `git status` tells you nothing about whether the edits work.
{
  const cwd = makeCwd();
  writeTrace(cwd, [
    edit(), edit(), edit(), edit(), edit(),
    pre('Bash', { command: 'git status --porcelain' }),
  ]);
  assert(runHook(cwd).status === 2, 'a non-verifying Bash command does not reset the counter');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 9: a subagent boundary resets the counter ──
{
  const cwd = makeCwd();
  writeTrace(cwd, [
    edit(), edit(), edit(), edit(), edit(),
    { ts: '2026-05-14T20:40:00.000Z', session: 'abcd1234', event: 'subagent_end' },
  ]);
  assert(runHook(cwd).status === 0, 'a fresh subagent context resets the cadence counter');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 10: no trace yet → ALLOW ──
{
  const cwd = makeCwd();
  assert(runHook(cwd).status === 0, 'allows edits when no trace exists yet');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 11: the env-var override does NOT work in hook context ──
{
  const cwd = makeCwd();
  writeTrace(cwd, [edit(), edit(), edit(), edit(), edit()]);
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: FILE },
      session_id: 'abcd1234',
      cwd,
    }),
    env: { ...process.env, SPECSMITH_GUARD_OVERRIDE: 'let me through' },
    encoding: 'utf8',
  });
  assert(r.status === 2, 'SPECSMITH_GUARD_OVERRIDE does not bypass when running as a hook');
  rmSync(cwd, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
