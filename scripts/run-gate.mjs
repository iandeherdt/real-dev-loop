#!/usr/bin/env node
// Run a quality gate (test / typecheck / lint / conventions / e2e) with the
// discipline the agents were previously asked to remember in prose.
//
// Three problems this solves, all measured in a 15-hour /build trace:
//
// 1. INVISIBLE FAILURES. Agents were taught `cmd 2>&1 | tail -60` for context
//    hygiene. That idiom folds stderr into stdout AND replaces the exit code
//    with `tail`'s, and the Bash tool_response carries no exit-code field. The
//    result: 1,446 Bash calls, 767 of them piped to a filter, and the trace
//    reported ZERO errors for the entire run. A failing typecheck and a
//    passing one were indistinguishable. This wrapper preserves the real exit
//    code and prints a machine-readable sentinel that trace-hook.mjs parses.
//
// 2. THE 2-MINUTE TIMEOUT STALL. 25 full-suite runs exceeded the Bash tool's
//    120s timeout, got auto-backgrounded, and cost ~103 minutes of polling —
//    11% of the session. The child here is DETACHED, so it survives this
//    script being killed at the tool timeout; a follow-up call re-attaches to
//    the same run instead of starting a new one. No work is ever lost, and
//    the suite is never accidentally run twice concurrently.
//
// 3. REDUNDANT RE-RUNS. If no source file changed since this gate last ran,
//    re-running it cannot produce a different answer. The cached verdict is
//    replayed instead (override with --force).
//
// Usage:
//   node .claude/scripts/run-gate.mjs <gate> -- <command...>
//   node .claude/scripts/run-gate.mjs <gate> --status
//
//   <gate>  a short name: test, typecheck, lint, conventions, e2e, …
//           It only names the log file and the cache slot; any gate name works.
//
// Options:
//   --wait <sec>   how long to block before handing back a "still running"
//                  ticket (default 100 — comfortably under the 120s Bash tool
//                  timeout). Pass a larger value together with a larger Bash
//                  `timeout` parameter to get the result in a single call:
//                  `--wait 590` with `timeout: 600000`.
//   --force        ignore the unchanged-source cache and run anyway.
//   --status       report on the current/last run without starting anything.
//   --max-lines N  cap the printed summary (default 60).
//
// Exit code is the wrapped command's own exit code, so callers need no pipe.
// While a run is still in flight the exit code is 0 with status=running —
// "not finished" is not "failed".

import { spawn } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, openSync, closeSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const DEFAULT_WAIT_S = 100;
const DEFAULT_MAX_LINES = 60;
const POLL_MS = 250;
const TAIL_LINES = 20;

// Lines worth surfacing first when a gate fails. Deliberately broad — this is
// a triage filter, not a parser; the full output is always on disk.
const FAILURE_RE = /(^|\s)(FAIL\b|✕|✗|✖|×\s|error TS\d+|Error:|ERROR\b|AssertionError|Expected\b.*Received|failed\b|✘)/;

function usage(code) {
  process.stderr.write(
    'Usage: run-gate.mjs <gate> -- <command...>\n' +
    '       run-gate.mjs <gate> --status\n' +
    '\n' +
    'Options: --wait <sec>  --force  --status  --max-lines <n>\n'
  );
  process.exit(code);
}

function parseArgs(argv) {
  const out = { gate: null, cmd: null, wait: DEFAULT_WAIT_S, force: false, status: false, maxLines: DEFAULT_MAX_LINES };
  const sep = argv.indexOf('--');
  const head = sep === -1 ? argv : argv.slice(0, sep);
  if (sep !== -1) out.cmd = argv.slice(sep + 1).join(' ').trim();

  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (a === '--force') out.force = true;
    else if (a === '--status') out.status = true;
    else if (a === '--wait') out.wait = Number(head[++i]);
    else if (a === '--max-lines') out.maxLines = Number(head[++i]);
    else if (a === '--help' || a === '-h') usage(0);
    else if (a.startsWith('-')) usage(1);
    else if (!out.gate) out.gate = a;
    else usage(1);
  }
  if (!out.gate) usage(1);
  if (!Number.isFinite(out.wait) || out.wait <= 0) out.wait = DEFAULT_WAIT_S;
  if (!Number.isFinite(out.maxLines) || out.maxLines <= 0) out.maxLines = DEFAULT_MAX_LINES;
  if (!/^[\w.:-]+$/.test(out.gate)) {
    process.stderr.write(`run-gate: invalid gate name ${JSON.stringify(out.gate)}\n`);
    process.exit(1);
  }
  return out;
}

// ── Paths ────────────────────────────────────────────────────────────────

function paths(cwd, gate) {
  const dir = resolve(cwd, 'pipeline', 'traces');
  const log = join(dir, `last-${gate}.log`);
  return {
    dir,
    log,
    // Always report the log as a repo-relative path — it goes into agent
    // context, where an absolute /home/... path is noise.
    logRel: log.startsWith(cwd + '/') ? log.slice(cwd.length + 1) : log,
    done: join(dir, `.gate-${gate}.done`),
    meta: join(dir, `.gate-${gate}.meta.json`),
    spawnErr: join(dir, `.gate-${gate}.spawn.err`),
    state: join(dir, 'gate-state.json'),
  };
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

// ── Source fingerprint ───────────────────────────────────────────────────

// A cheap, complete-enough signature of the working tree: the committed SHA
// plus the porcelain status plus size+mtime of everything dirty or untracked.
// Any Edit/Write moves it. Returns null outside a git repo (no short-circuit).
function sourceFingerprint(cwd) {
  let head, porcelain;
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    porcelain = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
  // `pipeline/` is specsmith's own scratch space — logs, feedback, traces,
  // and this script's own output. Including it would make every run
  // invalidate its own cache (the log written by run N changes the tree that
  // run N+1 fingerprints), so the short-circuit could never fire. Host
  // projects usually gitignore `pipeline/`, but the cache must not depend on
  // the host having done that.
  const relevant = porcelain
    .split('\n')
    .filter((l) => l.trim() && !l.slice(3).trim().replace(/^"|"$/g, '').startsWith('pipeline/'));

  const h = createHash('sha256').update(head).update('\n').update(relevant.join('\n'));
  for (const line of relevant) {
    const p = line.slice(3).trim().replace(/^"|"$/g, '');
    if (!p) continue;
    // Rename entries read `old -> new`; fingerprint the destination.
    const file = p.includes(' -> ') ? p.split(' -> ').pop() : p;
    try {
      const st = statSync(resolve(cwd, file));
      if (st.isFile()) h.update(`${file}:${st.size}:${st.mtimeMs}\n`);
    } catch { /* deleted between status and stat — porcelain already covers it */ }
  }
  return h.digest('hex');
}

// ── Output summarisation ─────────────────────────────────────────────────

function summarise(logPath, maxLines) {
  if (!existsSync(logPath)) return '(no output captured)';
  let text;
  try { text = readFileSync(logPath, 'utf8'); } catch { return '(log unreadable)'; }
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text.trimEnd();

  const failures = [];
  for (const l of lines) {
    if (FAILURE_RE.test(l)) failures.push(l);
    if (failures.length >= maxLines - TAIL_LINES) break;
  }
  const tail = lines.slice(-TAIL_LINES);
  const parts = [];
  if (failures.length) {
    parts.push(`── failure lines (${failures.length} shown) ──`, ...failures);
  }
  parts.push(`── last ${TAIL_LINES} lines of ${lines.length} ──`, ...tail);
  return parts.join('\n').trimEnd();
}

function sentinel(fields) {
  const body = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ');
  return `SPECSMITH_GATE ${body}`;
}

// ── Run lifecycle ────────────────────────────────────────────────────────

function isRunning(meta) {
  if (!meta || !meta.pid) return false;
  try { process.kill(meta.pid, 0); return true; } catch { return false; }
}

// Spawn the gate command fully detached, redirecting all output to the log and
// recording the real exit code in the `.done` file. `$?` after the redirected
// command is the command's own status — a pipe would have masked it, which is
// the exact bug this wrapper exists to prevent.
function startRun(p, gate, cmd, cwd) {
  mkdirSync(p.dir, { recursive: true });
  rmSync(p.done, { force: true });
  // The command runs in a SUBSHELL, not a `{ ...; }` group. A gate command
  // ending in `exit N` (common in wrapper scripts) would otherwise terminate
  // the outer shell too, and the `printf "$?"` that records the exit code
  // would never run — leaving the gate permanently "running".
  const shell = `( ${cmd} ) > ${JSON.stringify(p.log)} 2>&1 ; printf '%s' "$?" > ${JSON.stringify(p.done)}`;
  const out = openSync(p.spawnErr, 'a');
  const child = spawn('/bin/sh', ['-c', shell], {
    cwd,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  closeSync(out);
  const meta = { pid: child.pid, cmd, startedAt: Date.now() };
  writeFileSync(p.meta, JSON.stringify(meta));
  return meta;
}

function waitForDone(p, waitS) {
  const deadline = Date.now() + waitS * 1000;
  // Busy-wait with a coarse poll. Atomics.wait on a shared buffer gives us a
  // real sleep without pulling in a dependency or spinning the CPU.
  const sab = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (existsSync(p.done)) return readFileSync(p.done, 'utf8').trim();
    Atomics.wait(sab, 0, 0, POLL_MS);
  }
  return existsSync(p.done) ? readFileSync(p.done, 'utf8').trim() : null;
}

function reportFinished(p, gate, cmd, exitRaw, maxLines, extra = {}) {
  const exit = Number.parseInt(exitRaw, 10);
  const code = Number.isFinite(exit) ? exit : 1;
  const meta = readJson(p.meta, {});
  const durS = meta.startedAt ? Math.round((Date.now() - meta.startedAt) / 1000) : null;

  process.stdout.write(summarise(p.log, maxLines) + '\n');
  process.stdout.write(
    sentinel({
      gate,
      exit: code,
      status: code === 0 ? 'pass' : 'fail',
      ...(durS !== null ? { duration_s: durS } : {}),
      log: p.logRel,
      ...extra,
    }) + '\n'
  );
  return code;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const p = paths(cwd, args.gate);
  mkdirSync(p.dir, { recursive: true });

  const meta = readJson(p.meta, null);

  // ── --status: report, never start ──────────────────────────────────────
  if (args.status) {
    if (existsSync(p.done)) {
      process.exit(reportFinished(p, args.gate, meta?.cmd, readFileSync(p.done, 'utf8').trim(), args.maxLines));
    }
    if (isRunning(meta)) {
      process.stdout.write(sentinel({ gate: args.gate, status: 'running', pid: meta.pid, log: p.logRel }) + '\n');
      process.exit(0);
    }
    process.stdout.write(sentinel({ gate: args.gate, status: 'none' }) + '\n');
    process.exit(0);
  }

  // ── Re-attach to a run already in flight ───────────────────────────────
  // A second call for the same gate never starts a duplicate: it waits on the
  // detached child that is already doing the work.
  if (isRunning(meta) && !existsSync(p.done)) {
    const exitRaw = waitForDone(p, args.wait);
    if (exitRaw === null) {
      process.stdout.write(
        sentinel({ gate: args.gate, status: 'running', pid: meta.pid, log: p.logRel }) + '\n' +
        `Still running after ${args.wait}s — the child is detached and unaffected by this call ending.\n` +
        `Re-attach (do NOT start a new run): node .claude/scripts/run-gate.mjs ${args.gate}\n`
      );
      process.exit(0);
    }
    process.exit(reportFinished(p, args.gate, meta?.cmd, exitRaw, args.maxLines, { resumed: 'true' }));
  }

  if (!args.cmd) {
    // No command and nothing in flight — replay the last verdict if we have
    // one, so a bare re-invocation is informative rather than an error.
    if (existsSync(p.done)) {
      process.exit(reportFinished(p, args.gate, meta?.cmd, readFileSync(p.done, 'utf8').trim(), args.maxLines, { replayed: 'true' }));
    }
    process.stderr.write(`run-gate: no command given and no prior run for gate "${args.gate}".\n`);
    usage(1);
  }

  // ── Unchanged-source short-circuit ─────────────────────────────────────
  const fp = sourceFingerprint(cwd);
  const state = readJson(p.state, {});
  const slot = `${args.gate}:${createHash('sha256').update(args.cmd).digest('hex').slice(0, 12)}`;
  const cached = state[slot];

  if (!args.force && fp && cached && cached.fingerprint === fp) {
    process.stdout.write(summarise(p.log, args.maxLines) + '\n');
    process.stdout.write(
      sentinel({
        gate: args.gate,
        exit: cached.exit,
        status: cached.exit === 0 ? 'pass' : 'fail',
        cached: 'true',
        log: p.logRel,
      }) + '\n' +
      `No source file has changed since this gate last ran, so the result cannot differ.\n` +
      `Edit code, or pass --force if you believe the run was environment-dependent.\n`
    );
    process.exit(cached.exit);
  }

  // ── Start ──────────────────────────────────────────────────────────────
  const started = startRun(p, args.gate, args.cmd, cwd);
  const exitRaw = waitForDone(p, args.wait);

  if (exitRaw === null) {
    process.stdout.write(
      sentinel({ gate: args.gate, status: 'running', pid: started.pid, log: p.logRel }) + '\n' +
      `Started and still running after ${args.wait}s. The child is DETACHED — it keeps\n` +
      `running regardless of this call returning, so nothing is lost and nothing is\n` +
      `re-run. Re-attach with:\n` +
      `  node .claude/scripts/run-gate.mjs ${args.gate}\n` +
      `To get the result in one call next time, raise both budgets together:\n` +
      `  --wait 590 on this script, and timeout: 600000 on the Bash tool call.\n`
    );
    process.exit(0);
  }

  const code = reportFinished(p, args.gate, args.cmd, exitRaw, args.maxLines);
  if (fp) {
    state[slot] = { fingerprint: fp, exit: code, cmd: args.cmd, at: new Date().toISOString() };
    try { writeFileSync(p.state, JSON.stringify(state, null, 2) + '\n'); } catch { /* cache is best-effort */ }
  }
  process.exit(code);
}

main();
