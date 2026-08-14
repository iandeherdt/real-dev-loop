#!/usr/bin/env node
// PreToolUse guard: prevents the /build orchestrator from re-doing the
// developer's / evaluator's work inline. Enforces "orchestrator-only-
// orchestrates" — a corollary of Constitution Principle VIII (Scope
// Discipline).
//
// Forbidden when /build is running AND no subagent is currently dispatched:
//   - Bash invocations of dev/designs server commands (next dev, npm run
//     dev, serve designs, pkill -f next dev) — that's the dev-server's job
//   - Bash invocations of pixel-diff/dom-diff (or their project-local
//     wrappers run-pixel-diff.mjs / run-dom-diff.mjs) — that's the
//     evaluator's job
//   - Edit/Write to pipeline/dev-server-url or pipeline/designs-server-url
//     — only start-dev-server.mjs should own those files
//
// "Subagent is currently dispatched" is signalled by the existence of a
// recent `pipeline/dispatch-active.txt` sentinel. The /build skill writes
// it before each Agent call and deletes it after the agent returns. If
// the orchestrator forgets to write it, the subagent's first forbidden
// tool call gets blocked and the orchestrator sees a clear "you didn't
// open the dispatch lock" message — fast feedback, no silent corruption.
//
// Out of scope: this hook ONLY fires when `pipeline/run-state.md` exists
// (i.e. inside a /build run). Manual sessions where a human is iterating
// on the dev server directly are not blocked.

import { existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { readStdin, safeJsonParse, toRelPosix } from './lib/hook-io.mjs';

const RUN_STATE_FILE = 'pipeline/run-state.md';
const DISPATCH_LOCK_FILE = 'pipeline/dispatch-active.txt';
const DISPATCH_LOCK_TTL_MS = 30 * 60 * 1000; // 30 minutes — long enough for slow subagents, short enough to expire stale locks
const PROTECTED_TOOLS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Opening the lock is now this hook's job, not the orchestrator's. The skill
// used to instruct a `printf … > dispatch-active.txt` before every Agent call
// and an `rm -f` after — 40 Bash calls of pure ceremony in one audited run,
// two extra round-trips per dispatch, and a lock the orchestrator could
// simply forget to open (whereupon the subagent's first legitimate tool call
// was refused and blamed on the orchestrator). The hook sees every Agent
// dispatch anyway, so it can do this itself and cannot forget.
// trace-hook.mjs clears the lock on SubagentStop; the TTL remains the
// backstop for a crashed run.
function openDispatchLock(cwd, payload) {
  const path = resolve(cwd, DISPATCH_LOCK_FILE);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const type = payload.tool_input?.subagent_type || 'subagent';
    writeFileSync(path, `${new Date().toISOString()} ${type}\n`);
  } catch {
    // Best-effort. A failure here degrades to the old behaviour: the
    // subagent's first protected call is refused with a clear message.
  }
}

// Bash commands the orchestrator must not run directly. Subagents (developer
// + evaluator) ARE allowed to run these — that's their job. We only block
// when the dispatch lock is closed.
const FORBIDDEN_BASH_PATTERNS = [
  { re: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?dev\b/, hint: 'starting a dev server' },
  { re: /\bnext\s+dev\b/, hint: 'starting Next.js dev server' },
  { re: /\bvite(\s+--|\s+dev)?(\s|$)/, hint: 'starting a Vite dev server' },
  { re: /\bnpx\s+serve\s+designs\b/, hint: 'starting the designs server' },
  { re: /\bpkill\s+-f\s+["']?(next\s+dev|serve\s+designs|vite)/, hint: 'killing the dev/designs server' },
  { re: /[\/.]pixel-diff\.mjs\b/, hint: 'running pixel-diff directly' },
  { re: /[\/.]dom-diff\.mjs\b/, hint: 'running dom-diff directly' },
  { re: /[\/.]run-pixel-diff\.mjs\b/, hint: 'running the pixel-diff wrapper directly' },
  { re: /[\/.]run-dom-diff\.mjs\b/, hint: 'running the dom-diff wrapper directly' },
];

// Edit/Write paths the orchestrator must not touch. URL files belong to
// start-dev-server.mjs; faking them with `echo > url` or `Write` is what
// led to the silent-fail chain in the 2026-05-19 02:31 trace.
const FORBIDDEN_PATH_PREFIXES = [
  'pipeline/dev-server-url',
  'pipeline/designs-server-url',
];

function extractTargetPath(payload) {
  const tool = payload.tool_name;
  const input = payload.tool_input || {};
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
    return input.file_path || input.notebook_path || null;
  }
  if (tool === 'MultiEdit') return input.file_path || null;
  return null;
}

function isInBuildRun(cwd) {
  return existsSync(resolve(cwd, RUN_STATE_FILE));
}

function dispatchLockOpen(cwd) {
  const path = resolve(cwd, DISPATCH_LOCK_FILE);
  if (!existsSync(path)) return false;
  try {
    const age = Date.now() - statSync(path).mtimeMs;
    return age < DISPATCH_LOCK_TTL_MS;
  } catch {
    return false;
  }
}

function deny(message) {
  process.stderr.write(message + '\n');
  process.exit(2);
}

function checkBashCommand(payload, cwd) {
  const cmd = payload.tool_input?.command;
  if (typeof cmd !== 'string') return;
  for (const { re, hint } of FORBIDDEN_BASH_PATTERNS) {
    if (!re.test(cmd)) continue;
    deny(
      `Refusing this command — ${hint} from the orchestrator is out of scope.\n` +
      `\n` +
      `In a /build run the dev/designs servers and the pixel-diff / dom-diff\n` +
      `tools are the developer's and evaluator's responsibility. Re-running\n` +
      `them from the orchestrator after a subagent has already verified is\n` +
      `the failure mode this guard catches — see Constitution Principle VIII\n` +
      `(Scope Discipline) and the orchestrator-only-orchestrates rule in\n` +
      `skills/build/SKILL.md.\n` +
      `\n` +
      `If you need to inspect the diff output, use the helpers:\n` +
      `  node .claude/scripts/show-pixel-diff.mjs        # prints pixel-diff verdict + per-route summary\n` +
      `  node .claude/scripts/show-dom-diff.mjs          # prints dom-diff verdict + differences list\n` +
      `  node .claude/scripts/ensure-servers.mjs         # idempotent server check (no force-restart)\n` +
      `\n` +
      `If you're a subagent and you're seeing this, the orchestrator forgot\n` +
      `to open the dispatch lock before dispatching you. The orchestrator\n` +
      `must write \`${DISPATCH_LOCK_FILE}\` immediately before invoking the\n` +
      `Agent tool, and delete it after the agent returns. See skills/build/SKILL.md.\n` +
      `\n` +
      `If you're a human operator running an experiment outside of a /build\n` +
      `run, delete \`${RUN_STATE_FILE}\` first — this guard only fires inside\n` +
      `an active build cycle.`
    );
  }
}

function checkEditTarget(payload, cwd) {
  const target = extractTargetPath(payload);
  if (!target) return;
  const rel = toRelPosix(cwd, target);
  if (!rel) return;
  const hit = FORBIDDEN_PATH_PREFIXES.find((p) => rel === p || rel.startsWith(p + '/'));
  if (!hit) return;
  deny(
    `Refusing Edit/Write on \`${rel}\` — this file is owned by start-dev-server.mjs.\n` +
    `\n` +
    `URL marker files (\`pipeline/dev-server-url\`, \`pipeline/designs-server-url\`)\n` +
    `MUST only be written by \`.claude/scripts/start-dev-server.mjs\`, which parses\n` +
    `the actual bound URL from the server's startup output. Hand-writing these\n` +
    `with \`echo > …\` or Write/Edit creates silent failure modes:\n` +
    `  - You can pass curl the URL while the server isn't actually up (race).\n` +
    `  - A later \`pkill\` won't match the right PID because nothing started it.\n` +
    `  - start-dev-server.mjs's "is this server already up?" check is bypassed.\n` +
    `\n` +
    `Instead, run the idempotent helper:\n` +
    `  node .claude/scripts/ensure-servers.mjs\n` +
    `It checks the URL files, curls each URL, and only starts what's actually\n` +
    `missing. Safe to call from any subagent that needs a known-up dev server.`
  );
}

function main() {
  const raw = readStdin();
  if (!raw) process.exit(0);
  const payload = safeJsonParse(raw);
  if (!payload || payload.hook_event_name !== 'PreToolUse') process.exit(0);

  const cwd = payload.cwd || process.cwd();

  // An Agent dispatch opens the lock automatically, then passes through.
  if (payload.tool_name === 'Agent') {
    if (isInBuildRun(cwd)) openDispatchLock(cwd, payload);
    process.exit(0);
  }

  if (!PROTECTED_TOOLS.has(payload.tool_name)) process.exit(0);

  // Only enforce inside an active /build run. Manual experimentation
  // outside a build run is allowed.
  if (!isInBuildRun(cwd)) process.exit(0);

  // Subagent currently dispatched? Let it work.
  if (dispatchLockOpen(cwd)) process.exit(0);

  if (payload.tool_name === 'Bash') {
    checkBashCommand(payload, cwd);
  } else {
    checkEditTarget(payload, cwd);
  }
}

main();
