#!/usr/bin/env node
// Tests for scripts/guard-repeat-reads.mjs.
//
// The guard must catch the measured waste (62% of Reads in an audited run
// were re-reads of unchanged files) WITHOUT breaking the pipeline. Most of
// these cases are about the second half: a subagent reading a file for the
// first time in its own context, or a file something may have rewritten,
// must always be allowed through.
//
// Run with: `node tests/guard-repeat-reads.test.mjs` or `npm test`.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'guard-repeat-reads.mjs');

let failures = 0;

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
  else { console.log(`ok   ${msg}`); }
}

function makeCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'guard-reads-'));
  mkdirSync(join(cwd, 'pipeline', 'traces'), { recursive: true });
  return cwd;
}

function writeTrace(cwd, sessionId, events) {
  const path = join(cwd, 'pipeline', 'traces', `2026-05-14T20-00-00-${sessionId}.jsonl`);
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(cwd, 'pipeline', 'traces', `.session-${sessionId}.path`), path);
  return path;
}

function runHook(cwd, sessionId, toolInput, env = {}) {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: toolInput,
      session_id: sessionId,
      cwd,
    }),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function pre(ts, tool, input) {
  return { ts, session: 'abcd1234', hook: 'PreToolUse', event: 'tool_call', phase: 'pre', tool, input };
}

const FACTS = '/proj/pipeline/environment-facts.md';

// ── Case 1: re-reading an unchanged file → DENY ──
// environment-facts.md was read 29 times in one audited session.
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', [pre('2026-05-14T20:30:00.000Z', 'Read', { file_path: FACTS })]);
  const r = runHook(cwd, 'abcd1234', { file_path: FACTS });
  assert(r.status === 2, 'denies re-reading an unchanged file already in context');
  assert(/already read it/.test(r.stderr), 'denial names the earlier read');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 2: first read of a file → ALLOW ──
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', []);
  const r = runHook(cwd, 'abcd1234', { file_path: FACTS });
  assert(r.status === 0, 'allows the first read of a file');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 3: re-read after an Edit to that file → ALLOW ──
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', [
    pre('2026-05-14T20:30:00.000Z', 'Read', { file_path: FACTS }),
    pre('2026-05-14T20:31:00.000Z', 'Edit', { file_path: FACTS }),
  ]);
  const r = runHook(cwd, 'abcd1234', { file_path: FACTS });
  assert(r.status === 0, 'allows a re-read after the file was edited');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 4: re-read after a Bash command naming the file → ALLOW ──
// A script, `git checkout`, or codegen step may have rewritten it.
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', [
    pre('2026-05-14T20:30:00.000Z', 'Read', { file_path: FACTS }),
    pre('2026-05-14T20:31:00.000Z', 'Bash', { command: 'node .claude/scripts/verify-environment-facts.mjs' }),
  ]);
  const r = runHook(cwd, 'abcd1234', { file_path: FACTS });
  assert(r.status === 0, 'allows a re-read after a Bash command naming the file');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 5: a subagent's first read is NOT blocked by the orchestrator's ──
// The trace spans the whole session; a subagent starts with fresh context, so
// a file the orchestrator read earlier is genuinely new to it. Getting this
// wrong would break every dispatch.
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', [
    pre('2026-05-14T20:30:00.000Z', 'Read', { file_path: FACTS }),
    { ts: '2026-05-14T20:35:00.000Z', session: 'abcd1234', event: 'subagent_end' },
  ]);
  const r = runHook(cwd, 'abcd1234', { file_path: FACTS });
  assert(r.status === 0, 'allows a read after a subagent boundary (fresh context)');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 6: a read after a user prompt → ALLOW ──
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', [
    pre('2026-05-14T20:30:00.000Z', 'Read', { file_path: FACTS }),
    { ts: '2026-05-14T20:35:00.000Z', session: 'abcd1234', event: 'prompt', prompt: 'check the facts file again' },
  ]);
  const r = runHook(cwd, 'abcd1234', { file_path: FACTS });
  assert(r.status === 0, 'allows a read after the human intervened');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 7: a different offset/limit window → ALLOW ──
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', [
    pre('2026-05-14T20:30:00.000Z', 'Read', { file_path: '/proj/big.ts', offset: 1, limit: 100 }),
  ]);
  const r = runHook(cwd, 'abcd1234', { file_path: '/proj/big.ts', offset: 200, limit: 100 });
  assert(r.status === 0, 'allows reading a different slice of the same file');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 8: the identical window → DENY ──
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', [
    pre('2026-05-14T20:30:00.000Z', 'Read', { file_path: '/proj/big.ts', offset: 1, limit: 100 }),
  ]);
  const r = runHook(cwd, 'abcd1234', { file_path: '/proj/big.ts', offset: 1, limit: 100 });
  assert(r.status === 2, 'denies re-reading the identical slice');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 9: a different file → ALLOW ──
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', [pre('2026-05-14T20:30:00.000Z', 'Read', { file_path: FACTS })]);
  const r = runHook(cwd, 'abcd1234', { file_path: '/proj/pipeline/run-state.md' });
  assert(r.status === 0, 'allows reading a different file');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 10: non-Read tools pass straight through ──
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', []);
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      session_id: 'abcd1234',
      cwd,
    }),
    encoding: 'utf8',
  });
  assert(r.status === 0, 'ignores non-Read tool calls');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 11: no trace yet → ALLOW (fresh session) ──
{
  const cwd = makeCwd();
  const r = runHook(cwd, 'nosuchse', { file_path: FACTS });
  assert(r.status === 0, 'allows reads when no trace exists yet');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 12: the env-var override does NOT work in hook context ──
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', [pre('2026-05-14T20:30:00.000Z', 'Read', { file_path: FACTS })]);
  const r = runHook(cwd, 'abcd1234', { file_path: FACTS }, { SPECSMITH_GUARD_OVERRIDE: 'let me through' });
  assert(r.status === 2, 'SPECSMITH_GUARD_OVERRIDE does not bypass when running as a hook');
  rmSync(cwd, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
