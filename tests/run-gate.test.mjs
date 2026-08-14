#!/usr/bin/env node
// Tests for scripts/run-gate.mjs — the quality-gate wrapper.
//
// The behaviours asserted here are the ones a 15-hour /build trace showed the
// loop getting wrong: exit codes destroyed by `| tail`, full suites re-run
// after the 2-minute tool timeout backgrounded them, and identical gates
// re-run with no source change in between.
//
// Run with: `node tests/run-gate.test.mjs` or `npm test`.

import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'run-gate.mjs');

let failures = 0;

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
  else { console.log(`ok   ${msg}`); }
}

// run-gate short-circuits on an unchanged working tree, which needs a repo.
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'run-gate-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(root, 'src.txt'), 'v1\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return root;
}

function gate(root, args) {
  return spawnSync('node', [SCRIPT, ...args], { cwd: root, encoding: 'utf8' });
}

function sentinelOf(stdout) {
  const line = stdout.split('\n').find((l) => l.startsWith('SPECSMITH_GATE '));
  if (!line) return null;
  return Object.fromEntries(
    line.slice('SPECSMITH_GATE '.length).trim().split(/\s+/).map((kv) => kv.split('='))
  );
}

// ── Case 1: a passing gate exits 0 and says so ──
{
  const root = makeRepo();
  const r = gate(root, ['test', '--wait', '15', '--', 'echo ok']);
  const s = sentinelOf(r.stdout);
  assert(r.status === 0, 'passing gate exits 0');
  assert(s && s.exit === '0' && s.status === 'pass', 'passing gate emits exit=0 status=pass');
  assert(/ok/.test(r.stdout), 'passing gate echoes the command output');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 2: a failing gate preserves the REAL exit code ──
// This is the core defect: `tsc 2>&1 | tail -60` reports the exit code of
// `tail`, i.e. 0, so 1,446 Bash calls produced zero detected errors.
{
  const root = makeRepo();
  const r = gate(root, ['typecheck', '--wait', '15', '--', 'echo "src/x.ts(3,1): error TS2304"; exit 2']);
  const s = sentinelOf(r.stdout);
  assert(r.status === 2, 'failing gate exits with the command\'s own code (2)');
  assert(s && s.exit === '2' && s.status === 'fail', 'failing gate emits exit=2 status=fail');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 3: a command ending in `exit N` still records its code ──
// A `{ ...; }` group would let `exit` kill the recording shell, leaving the
// gate permanently "running". The command must run in a subshell.
{
  const root = makeRepo();
  const r = gate(root, ['lint', '--wait', '15', '--', 'echo done; exit 7']);
  const s = sentinelOf(r.stdout);
  assert(s && s.status !== 'running', 'a command ending in `exit N` completes rather than hanging');
  assert(r.status === 7, 'exit code 7 propagates through the subshell wrapper');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 4: full output lands on a fixed, predictable log path ──
{
  const root = makeRepo();
  gate(root, ['test', '--wait', '15', '--', 'echo line-one; echo line-two']);
  const log = join(root, 'pipeline', 'traces', 'last-test.log');
  assert(existsSync(log), 'output is teed to pipeline/traces/last-<gate>.log');
  assert(/line-one[\s\S]*line-two/.test(readFileSync(log, 'utf8')), 'the log holds the full output');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 5: re-running with no source change replays the cached verdict ──
{
  const root = makeRepo();
  const cmd = 'echo run; date +%s%N >> /dev/null';
  const first = gate(root, ['test', '--wait', '15', '--', cmd]);
  const second = gate(root, ['test', '--wait', '15', '--', cmd]);
  const s = sentinelOf(second.stdout);
  assert(sentinelOf(first.stdout).cached === undefined, 'first run is not cached');
  assert(s && s.cached === 'true', 'second run with an unchanged tree replays the cached verdict');
  assert(second.status === first.status, 'the cached replay carries the same exit code');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 6: editing a file invalidates the cache ──
{
  const root = makeRepo();
  const cmd = 'echo run';
  gate(root, ['test', '--wait', '15', '--', cmd]);
  appendFileSync(join(root, 'src.txt'), 'v2\n');
  const r = gate(root, ['test', '--wait', '15', '--', cmd]);
  assert(sentinelOf(r.stdout).cached === undefined, 'an edit to a tracked file re-runs the gate');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 7: an untracked new file also invalidates the cache ──
{
  const root = makeRepo();
  const cmd = 'echo run';
  gate(root, ['test', '--wait', '15', '--', cmd]);
  writeFileSync(join(root, 'brand-new.ts'), 'export const x = 1;\n');
  const r = gate(root, ['test', '--wait', '15', '--', cmd]);
  assert(sentinelOf(r.stdout).cached === undefined, 'a new untracked file re-runs the gate');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 8: --force ignores the cache ──
{
  const root = makeRepo();
  const cmd = 'echo run';
  gate(root, ['test', '--wait', '15', '--', cmd]);
  const r = gate(root, ['test', '--wait', '15', '--force', '--', cmd]);
  assert(sentinelOf(r.stdout).cached === undefined, '--force bypasses the unchanged-tree cache');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 9: exceeding --wait hands back a ticket, and the child survives ──
// The 2-minute-timeout stall cost ~103 minutes across 25 runs. A detached
// child means the follow-up call waits on the SAME run rather than starting
// a second one.
{
  const root = makeRepo();
  const marker = join(root, 'ran.count');
  const cmd = `sleep 4; echo x >> ${JSON.stringify(marker)}; echo suite-finished`;

  const started = gate(root, ['slow', '--wait', '1', '--', cmd]);
  const s1 = sentinelOf(started.stdout);
  assert(s1 && s1.status === 'running', 'a gate slower than --wait reports status=running');
  assert(started.status === 0, 'a still-running gate exits 0 — "not finished" is not "failed"');

  const resumed = gate(root, ['slow', '--wait', '30']);
  const s2 = sentinelOf(resumed.stdout);
  assert(s2 && s2.status === 'pass' && s2.resumed === 'true', 're-attaching returns the finished verdict');
  assert(/suite-finished/.test(resumed.stdout), 're-attach shows the output of the original run');
  assert(
    readFileSync(marker, 'utf8').trim().split('\n').length === 1,
    'the command ran exactly ONCE across the start and the re-attach'
  );
  rmSync(root, { recursive: true, force: true });
}

// ── Case 10: --status reports without starting anything ──
{
  const root = makeRepo();
  const r = gate(root, ['never-run', '--status']);
  assert(sentinelOf(r.stdout).status === 'none', '--status on an unknown gate reports status=none');
  assert(!existsSync(join(root, 'pipeline', 'traces', 'last-never-run.log')), '--status starts nothing');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 11: long output is summarised, not dumped ──
{
  const root = makeRepo();
  const cmd = 'for i in $(seq 1 400); do echo "line $i"; done; echo "FAIL something broke"; exit 1';
  const r = gate(root, ['test', '--wait', '20', '--max-lines', '40', '--', cmd]);
  const printed = r.stdout.split('\n').length;
  assert(printed < 120, `long output is bounded (printed ${printed} lines, not 400+)`);
  assert(/FAIL something broke/.test(r.stdout), 'the failure line survives summarisation');
  assert(
    readFileSync(join(root, 'pipeline', 'traces', 'last-test.log'), 'utf8').split('\n').length > 400,
    'the full output is still on disk'
  );
  rmSync(root, { recursive: true, force: true });
}

// ── Case 12: a bad gate name is rejected rather than used as a path ──
{
  const root = makeRepo();
  const r = gate(root, ['../../etc/passwd', '--', 'echo hi']);
  assert(r.status === 1, 'a gate name with path separators is refused');
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
