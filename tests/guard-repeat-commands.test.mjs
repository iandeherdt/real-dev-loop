#!/usr/bin/env node
// Smoke test for scripts/guard-repeat-commands.mjs.
// Spawns the hook with synthetic PreToolUse payloads and asserts exit codes.
// Run with: `node tests/guard-repeat-commands.test.mjs` or `npm test`.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'guard-repeat-commands.mjs');

let failures = 0;

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
  else { console.log(`ok   ${msg}`); }
}

function makeCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'guard-test-'));
  mkdirSync(join(cwd, 'pipeline', 'traces'), { recursive: true });
  return cwd;
}

function writeTrace(cwd, sessionId, events) {
  const stamp = '2026-05-14T20-00-00';
  const path = join(cwd, 'pipeline', 'traces', `${stamp}-${sessionId}.jsonl`);
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(cwd, 'pipeline', 'traces', `.session-${sessionId}.path`), path);
  return path;
}

function runHook(cwd, sessionId, command, env = {}) {
  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    session_id: sessionId,
    cwd,
  };
  return spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function evt(ts, tool, extra = {}) {
  return { ts, session: 'abcd1234', hook: 'PreToolUse', event: 'tool_call', phase: 'pre', tool, ...extra };
}

// ── Case 1: same expensive command, no edits between → DENY (exit 2) ──
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', [
    evt('2026-05-14T20:30:00.000Z', 'Bash', { input: { command: 'npm run typecheck 2>&1 | tail -20' } }),
    evt('2026-05-14T20:30:30.000Z', 'Read', { input: { file_path: '/foo.ts' } }),
  ]);
  const r = runHook(cwd, 'abcd1234', 'npm run typecheck 2>&1 | tail -50');
  assert(r.status === 2, 'denies re-run of npm run typecheck with no edits between');
  assert(/Refusing to re-run/.test(r.stderr), 'stderr contains denial message');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 2: same expensive command, with Edit between → ALLOW ──
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', [
    evt('2026-05-14T20:30:00.000Z', 'Bash', { input: { command: 'npm run typecheck' } }),
    evt('2026-05-14T20:30:30.000Z', 'Edit', { input: { file_path: '/foo.ts' } }),
  ]);
  const r = runHook(cwd, 'abcd1234', 'npm run typecheck 2>&1 | tail -50');
  assert(r.status === 0, 'allows re-run after an Edit');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 3: cheap command (ls) repeated → ALLOW ──
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', [
    evt('2026-05-14T20:30:00.000Z', 'Bash', { input: { command: 'ls /foo' } }),
  ]);
  const r = runHook(cwd, 'abcd1234', 'ls /foo');
  assert(r.status === 0, 'allows repeated cheap commands');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 4: state-wipe loop (3rd rm -rf data/pglite in 30min) → DENY ──
{
  const cwd = makeCwd();
  const now = new Date();
  const t = (offsetMin) => new Date(now.getTime() - offsetMin * 60000).toISOString();
  writeTrace(cwd, 'abcd1234', [
    evt(t(20), 'Bash', { input: { command: 'rm -rf /tmp/data/pglite' } }),
    evt(t(10), 'Bash', { input: { command: 'rm -rf /tmp/data/pglite' } }),
  ]);
  const r = runHook(cwd, 'abcd1234', 'rm -rf /tmp/data/pglite && echo cleaned');
  assert(r.status === 2, 'denies 3rd rm -rf data/pglite within 30min');
  assert(/state wipe/i.test(r.stderr), 'stderr explains the wipe rule');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 5: single state wipe → ALLOW ──
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', []);
  const r = runHook(cwd, 'abcd1234', 'rm -rf /tmp/data/pglite');
  assert(r.status === 0, 'allows a single rm -rf');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 6: SPECSMITH_GUARD_OVERRIDE is IGNORED in hook context ──
// The old env-var bypass (SPECSMITH_GUARD=0) was renamed AND scoped to
// non-hook contexts in v0.9.0 — agents kept using the bypass to dodge
// blocks. Under a hook payload, the override is logged and ignored.
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', [
    evt('2026-05-14T20:30:00.000Z', 'Bash', { input: { command: 'npm run typecheck' } }),
  ]);
  const r = runHook(cwd, 'abcd1234', 'npm run typecheck', { SPECSMITH_GUARD_OVERRIDE: 'agent-trying-to-dodge' });
  assert(r.status === 2, 'SPECSMITH_GUARD_OVERRIDE does NOT bypass when running as a hook');
  // Old var name no longer honored at all.
  const r2 = runHook(cwd, 'abcd1234', 'npm run typecheck', { SPECSMITH_GUARD: '0' });
  assert(r2.status === 2, 'old SPECSMITH_GUARD=0 var is no longer recognised');
  // Bypass attempt was logged.
  const logPath = join(cwd, 'pipeline', 'traces', 'guard-bypass-attempts.log');
  assert(existsSync(logPath), 'bypass attempt is logged to pipeline/traces/guard-bypass-attempts.log');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 7: empty trace (first invocation in session) → ALLOW ──
{
  const cwd = makeCwd();
  const r = runHook(cwd, 'fresh001', 'npm run typecheck');
  assert(r.status === 0, 'allows the first invocation in a fresh session');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 8: same expensive base with different tail/head pipes → DENY ──
// This is the exact pattern from the failing trace.
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', [
    evt('2026-05-14T20:30:00.000Z', 'Bash', { input: { command: 'npm run lint 2>&1 | grep "Error:"' } }),
  ]);
  const r = runHook(cwd, 'abcd1234', 'npm run lint 2>&1 | grep -B3 "curly"');
  assert(r.status === 2, 'denies re-grep of same lint output (base command matches)');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 9: long inline python3 -c script → DENY ──
// Caught in audit 2026-05-19T02-31: orchestrator pasted a 1.2 KB python3 -c
// blob to read pixel-diff.json. The unwrap regex doesn't speak Python, so
// we need the length-based rule.
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', []);
  // A 250-char inner script — over the 200-char threshold.
  const inner = 'import json,sys;d=json.load(open("pipeline/feedback/pixel-diff.json"));' +
                'print(d["verdict"]);' +
                'print("|".join([r["route"] for r in d["routes"] if r["verdict"]=="fail"]));' +
                'sys.exit(0 if d["verdict"]!="fail" else 1)';
  const r = runHook(cwd, 'abcd1234', `python3 -c '${inner}'`);
  assert(r.status === 2, 'denies long inline python3 -c script');
  assert(/show-pixel-diff/.test(r.stderr), 'stderr points at show-pixel-diff helper');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 10: short inline python3 -c (< 200 chars) → ALLOW ──
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', []);
  const r = runHook(cwd, 'abcd1234', `python3 -c 'import sys; print(sys.argv)'`);
  assert(r.status === 0, 'allows short python3 -c one-liners');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 11: long inline perl -e script → DENY ──
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', []);
  const inner = 'use JSON;my$d=decode_json(do{local$/;open my$f,"pipeline/feedback/dom-diff.json";<$f>});' +
                'print$d->{verdict},"\\n";for my$r(@{$d->{routes}}){print$r->{route}," ",$r->{verdict},"\\n" if $r->{verdict} eq "fail"}';
  const r = runHook(cwd, 'abcd1234', `perl -e '${inner}'`);
  assert(r.status === 2, 'denies long inline perl -e script');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 12: long inline ruby -e script → DENY ──
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', []);
  const inner = 'require "json"; ' +
                'data = JSON.parse(File.read("pipeline/feedback/pixel-diff.json")); ' +
                'puts data.fetch("verdict"); ' +
                'data.fetch("routes").each { |r| puts r.fetch("route") + " " + r.fetch("verdict") if r.fetch("verdict") == "fail" }; ' +
                'exit (data.fetch("verdict") == "fail" ? 1 : 0)';
  const r = runHook(cwd, 'abcd1234', `ruby -e '${inner}'`);
  assert(r.status === 2, 'denies long inline ruby -e script');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 13: long inline php -r script → DENY ──
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', []);
  const inner = '$data = json_decode(file_get_contents("pipeline/feedback/pixel-diff.json"), true); ' +
                'echo $data["verdict"]; ' +
                'foreach ($data["routes"] as $r) { ' +
                '  if ($r["verdict"] === "fail") { echo $r["route"] . " " . $r["verdict"]; } ' +
                '} ' +
                'exit($data["verdict"] === "fail" ? 1 : 0);';
  const r = runHook(cwd, 'abcd1234', `php -r '${inner}'`);
  assert(r.status === 2, 'denies long inline php -r script');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 14: grepping the trace JSONL as memory → DENY ──
// Audit 2026-06-15: a 90-min window had 22 trace-greps (`grep '"tool":"Edit"'
// …jsonl`, `grep '"phase":"pre"' …jsonl`, `wc -l …jsonl`) despite the prose ban.
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', []);
  const r = runHook(cwd, 'abcd1234', `grep '"tool":"Edit"' /home/x/pipeline/traces/2026-06-15T00-49-35-bcd56d70.jsonl`);
  assert(r.status === 2, 'denies grepping pipeline/traces/*.jsonl');
  assert(/environment-facts/.test(r.stderr), 'stderr points at environment-facts.md');
  const r2 = runHook(cwd, 'abcd1234', 'wc -l pipeline/traces/foo.jsonl');
  assert(r2.status === 2, 'denies wc -l on the trace jsonl');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 15: sanctioned trace reader is ALLOWED ──
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', []);
  const r = runHook(cwd, 'abcd1234', 'node .claude/scripts/trace-summarise.mjs pipeline/traces/foo.jsonl');
  assert(r.status === 0, 'allows trace-summarise.mjs even though it names the jsonl path');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 16: re-run pixel-diff.mjs, no edits between → DENY ──
// The design-diff scripts are the most expensive commands in a /build cycle
// but were missing from EXPENSIVE_RE, so re-running one to re-grep its output
// sailed through. (Audit: pixel-diff run twice back-to-back, 0 edits, ~130s.)
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', [
    evt('2026-05-14T20:30:00.000Z', 'Bash', { input: { command: 'node .claude/scripts/pixel-diff.mjs --out pipeline/feedback' } }),
  ]);
  const r = runHook(cwd, 'abcd1234', 'node .claude/scripts/pixel-diff.mjs --out pipeline/feedback 2>&1 | tail -60');
  assert(r.status === 2, 'denies re-run of pixel-diff.mjs with no edits between');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 17: re-run a run-pixel-diff.mjs wrapper, different pipe → DENY ──
// The exact pattern from the failing trace: same diff, `| tail` then `| grep`.
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', [
    evt('2026-05-14T20:30:00.000Z', 'Bash', { input: { command: 'node --env-file=.env.local scripts/run-pixel-diff.mjs --out pipeline/feedback 2>&1 | tail -60' } }),
  ]);
  const r = runHook(cwd, 'abcd1234', 'node --env-file=.env.local scripts/run-pixel-diff.mjs --out pipeline/feedback 2>&1 | grep -E \'"verdict"|"stuck"\'');
  assert(r.status === 2, 'denies re-grep of run-pixel-diff.mjs wrapper output (base matches)');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 18: dom-diff.mjs re-run after an Edit → ALLOW ──
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', [
    evt('2026-05-14T20:30:00.000Z', 'Bash', { input: { command: 'node .claude/scripts/dom-diff.mjs --out pipeline/feedback' } }),
    evt('2026-05-14T20:30:30.000Z', 'Edit', { input: { file_path: '/page.tsx' } }),
  ]);
  const r = runHook(cwd, 'abcd1234', 'node .claude/scripts/dom-diff.mjs --out pipeline/feedback');
  assert(r.status === 0, 'allows dom-diff.mjs re-run after an Edit');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 19: show-pixel-diff.mjs is the cheap reader → ALLOW even if repeated ──
// Blocking the helper would push agents back to re-running the real diff —
// the opposite of what we want. The negative lookbehind exempts it.
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', [
    evt('2026-05-14T20:30:00.000Z', 'Bash', { input: { command: 'node .claude/scripts/show-pixel-diff.mjs' } }),
  ]);
  const r = runHook(cwd, 'abcd1234', 'node .claude/scripts/show-pixel-diff.mjs --routes-failed');
  assert(r.status === 0, 'allows repeated show-pixel-diff.mjs (cheap JSON reader, not the diff)');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 20: cheap sibling scripts are NOT treated as expensive → ALLOW ──
// pixel-diff-lib.mjs (pure helpers) and routes-to-diff.mjs (git + graph scan)
// are cheap; only the actual pixel-diff.mjs/dom-diff.mjs runs are guarded.
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', [
    evt('2026-05-14T20:30:00.000Z', 'Bash', { input: { command: 'node .claude/scripts/routes-to-diff.mjs' } }),
  ]);
  const r = runHook(cwd, 'abcd1234', 'node .claude/scripts/routes-to-diff.mjs --verbose');
  assert(r.status === 0, 'allows repeated routes-to-diff.mjs (cheap scope computation)');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 21: next lint re-run, no edits between → DENY ──
{
  const cwd = makeCwd();
  writeTrace(cwd, 'abcd1234', [
    evt('2026-05-14T20:30:00.000Z', 'Bash', { input: { command: 'npx next lint --file app/page.tsx' } }),
  ]);
  const r = runHook(cwd, 'abcd1234', 'npx next lint --file app/page.tsx 2>&1 | tail -20');
  assert(r.status === 2, 'denies re-run of next lint with no edits between');
  rmSync(cwd, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
