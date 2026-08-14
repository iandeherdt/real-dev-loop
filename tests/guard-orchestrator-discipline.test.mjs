#!/usr/bin/env node
// Smoke test for scripts/guard-orchestrator-discipline.mjs.
// Spawns the hook with synthetic PreToolUse payloads and asserts exit codes.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'guard-orchestrator-discipline.mjs'
);

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
  else { console.log(`ok   ${msg}`); }
}

function makeCwd({ buildRun = true, dispatchActive = false } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'orch-test-'));
  mkdirSync(join(cwd, 'pipeline'), { recursive: true });
  if (buildRun) writeFileSync(join(cwd, 'pipeline', 'run-state.md'), '# Run State\n');
  if (dispatchActive) {
    writeFileSync(
      join(cwd, 'pipeline', 'dispatch-active.txt'),
      `${new Date().toISOString()} developing-features\n`
    );
  }
  return cwd;
}

function runBash(cwd, command) {
  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    cwd,
  };
  return spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env },
    encoding: 'utf8',
  });
}

function runEdit(cwd, filePath) {
  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: filePath },
    cwd,
  };
  return spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env },
    encoding: 'utf8',
  });
}

// ── Case 1: outside /build run → noop ──
{
  const cwd = makeCwd({ buildRun: false });
  const r = runBash(cwd, 'node .claude/scripts/pixel-diff.mjs --out pipeline/feedback');
  assert(r.status === 0, 'allows pixel-diff outside a build run');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 2: inside /build, no dispatch lock → pixel-diff REFUSED ──
{
  const cwd = makeCwd();
  const r = runBash(cwd, 'node .claude/scripts/pixel-diff.mjs --out pipeline/feedback');
  assert(r.status === 2, 'refuses pixel-diff from orchestrator (no dispatch lock)');
  assert(/Scope Discipline/.test(r.stderr), 'stderr cites Constitution Principle VIII');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 3: inside /build, dispatch lock OPEN → pixel-diff allowed ──
{
  const cwd = makeCwd({ dispatchActive: true });
  const r = runBash(cwd, 'node .claude/scripts/pixel-diff.mjs --out pipeline/feedback');
  assert(r.status === 0, 'allows pixel-diff when dispatch lock is open (subagent context)');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 4: inside /build, no lock → dom-diff REFUSED ──
{
  const cwd = makeCwd();
  const r = runBash(cwd, 'node .claude/scripts/dom-diff.mjs --out pipeline/feedback');
  assert(r.status === 2, 'refuses dom-diff from orchestrator');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 5: inside /build, no lock → npm run dev REFUSED ──
{
  const cwd = makeCwd();
  const r = runBash(cwd, 'npm run dev');
  assert(r.status === 2, 'refuses npm run dev from orchestrator');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 6: inside /build, no lock → next dev REFUSED ──
{
  const cwd = makeCwd();
  const r = runBash(cwd, 'next dev');
  assert(r.status === 2, 'refuses bare next dev from orchestrator');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 7: inside /build, no lock → npx serve designs REFUSED ──
{
  const cwd = makeCwd();
  const r = runBash(cwd, 'npx serve designs -l 3100');
  assert(r.status === 2, 'refuses npx serve designs from orchestrator');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 8: inside /build, no lock → pkill -f next dev REFUSED ──
{
  const cwd = makeCwd();
  const r = runBash(cwd, "pkill -f 'next dev'");
  assert(r.status === 2, 'refuses pkill -f "next dev" from orchestrator');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 9: inside /build, no lock → run-pixel-diff wrapper REFUSED ──
{
  const cwd = makeCwd();
  const r = runBash(cwd, 'node scripts/run-pixel-diff.mjs');
  assert(r.status === 2, 'refuses run-pixel-diff wrapper from orchestrator');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 10: inside /build, no lock → benign Bash command ALLOWED ──
{
  const cwd = makeCwd();
  const r = runBash(cwd, 'git status --porcelain');
  assert(r.status === 0, 'allows git status from orchestrator');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 11: inside /build, no lock → show-pixel-diff helper ALLOWED ──
{
  const cwd = makeCwd();
  const r = runBash(cwd, 'node .claude/scripts/show-pixel-diff.mjs');
  assert(r.status === 0, 'allows show-pixel-diff helper from orchestrator');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 12: inside /build, no lock → ensure-servers helper ALLOWED ──
{
  const cwd = makeCwd();
  const r = runBash(cwd, 'node .claude/scripts/ensure-servers.mjs');
  assert(r.status === 0, 'allows ensure-servers helper from orchestrator');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 13: inside /build, no lock → Edit pipeline/dev-server-url REFUSED ──
{
  const cwd = makeCwd();
  const r = runEdit(cwd, join(cwd, 'pipeline', 'dev-server-url'));
  assert(r.status === 2, 'refuses Edit on pipeline/dev-server-url');
  assert(/start-dev-server\.mjs/.test(r.stderr), 'stderr names start-dev-server.mjs as owner');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 14: inside /build, no lock → Edit pipeline/designs-server-url REFUSED ──
{
  const cwd = makeCwd();
  const r = runEdit(cwd, join(cwd, 'pipeline', 'designs-server-url'));
  assert(r.status === 2, 'refuses Edit on pipeline/designs-server-url');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 15: inside /build, lock open → Edit pipeline/dev-server-url ALLOWED ──
// (The start-dev-server.mjs subagent helper writes the URL file. While
// not currently a subagent action, the lock means we trust the caller.)
{
  const cwd = makeCwd({ dispatchActive: true });
  const r = runEdit(cwd, join(cwd, 'pipeline', 'dev-server-url'));
  assert(r.status === 0, 'allows Edit on dev-server-url when dispatch lock is open');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 16: inside /build, no lock → Edit normal source file ALLOWED ──
// (Scope guard catches .claude/* edits; orchestrator-discipline only cares
// about the URL marker files.)
{
  const cwd = makeCwd();
  const r = runEdit(cwd, join(cwd, 'src', 'page.tsx'));
  assert(r.status === 0, 'allows Edit on src/page.tsx (out of orchestrator-discipline scope)');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 17: stale dispatch lock (>30 min) → treated as closed ──
{
  const cwd = makeCwd({ dispatchActive: true });
  // Backdate the lock file 31 minutes.
  const lockPath = join(cwd, 'pipeline', 'dispatch-active.txt');
  const t = Date.now() - 31 * 60 * 1000;
  // Use utimesSync via fs
  const { utimesSync } = await import('node:fs');
  utimesSync(lockPath, new Date(t), new Date(t));
  const r = runBash(cwd, 'node .claude/scripts/pixel-diff.mjs --out pipeline/feedback');
  assert(r.status === 2, 'stale dispatch lock (>30 min) does NOT allow forbidden commands');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 18: empty stdin → noop ──
{
  const r = spawnSync('node', [HOOK], { input: '', encoding: 'utf8' });
  assert(r.status === 0, 'noops when no stdin payload');
}

// ── Case 19: non-PreToolUse event → noop ──
{
  const cwd = makeCwd();
  const payload = {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'node .claude/scripts/pixel-diff.mjs' },
    cwd,
  };
  const r = spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
  assert(r.status === 0, 'noops on PostToolUse');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 20: unprotected tool (Read) → noop ──
{
  const cwd = makeCwd();
  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: join(cwd, 'pipeline', 'dev-server-url') },
    cwd,
  };
  const r = spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
  assert(r.status === 0, 'noops on Read tool');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Self-managing dispatch lock ──
// The orchestrator used to `printf` the sentinel before every Agent call and
// `rm -f` it after: 40 Bash calls of ceremony in one audited run, and a lock
// it could forget to open. The guard now opens it on dispatch; trace-hook.mjs
// closes it on SubagentStop.

function runAgent(cwd, subagentType = 'developing-features') {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { subagent_type: subagentType, prompt: 'do the thing' },
      cwd,
    }),
    encoding: 'utf8',
  });
}

// ── Case: an Agent dispatch opens the lock and is itself allowed ──
{
  const cwd = makeCwd();
  const lock = join(cwd, 'pipeline', 'dispatch-active.txt');
  assert(!existsSync(lock), 'no dispatch lock before the Agent call');

  const r = runAgent(cwd);
  assert(r.status === 0, 'the Agent dispatch itself is never blocked');
  assert(existsSync(lock), 'the guard opens the dispatch lock on an Agent call');
  assert(
    /developing-features/.test(readFileSync(lock, 'utf8')),
    'the lock records which subagent type was dispatched'
  );

  // …and the dispatched subagent may now do its job.
  assert(runBash(cwd, 'npm run dev').status === 0, 'a subagent may start the dev server once dispatched');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case: trace-hook closes the lock on SubagentStop, re-arming the guard ──
{
  const TRACE_HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'trace-hook.mjs');
  const cwd = makeCwd();
  mkdirSync(join(cwd, 'pipeline', 'traces'), { recursive: true });
  const lock = join(cwd, 'pipeline', 'dispatch-active.txt');

  runAgent(cwd);
  assert(existsSync(lock), 'lock open while the subagent runs');

  spawnSync('node', [TRACE_HOOK], {
    input: JSON.stringify({ hook_event_name: 'SubagentStop', session_id: 'abcd1234', cwd }),
    encoding: 'utf8',
  });
  assert(!existsSync(lock), 'trace-hook removes the lock on SubagentStop');
  assert(
    runBash(cwd, 'npm run dev').status === 2,
    'the orchestrator is bound by the guard again after the subagent returns'
  );
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case: outside a /build run, an Agent call opens no lock ──
{
  const cwd = makeCwd({ buildRun: false });
  runAgent(cwd);
  assert(
    !existsSync(join(cwd, 'pipeline', 'dispatch-active.txt')),
    'no lock is created outside an active /build run'
  );
  rmSync(cwd, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
