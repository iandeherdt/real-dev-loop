#!/usr/bin/env node
// PreToolUse guard: refuse an unbroken run of edits to the SAME file with no
// verification in between, and require a gate run before continuing.
//
// The pattern this catches, from an audited 15-hour /build run: 10 separate
// runs of 4+ consecutive Edits to one file with no test, typecheck, or lint
// call anywhere between them — 48 edits in total, worst case 8 in a row on
// `PeriodsTimeline.tsx`. Editing blind is also the single largest context
// cost in the loop: Edit results totalled 6.5 MB in that session, more than
// Read (5.3 MB) and more than every Bash output combined (2.6 MB). Each blind
// edit adds a full diff to context and buys no information about whether the
// previous one worked.
//
// The remedy is cheap and always available — run the relevant gate:
//   node .claude/scripts/run-gate.mjs typecheck -- <typecheck command>
// so the threshold is set where a genuine multi-part edit still fits under it.
//
// Anything that could tell you whether the edits work resets the counter: a
// test/typecheck/lint/build run, a Read of the file, a browser check, or
// simply moving on to a different file.
//
// Bypass: SPECSMITH_GUARD_OVERRIDE, honoured only outside hook context and
// logged when attempted under one — same policy as the other guards.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { resolveTracePath, shortId } from './trace-path.mjs';
import { readStdin, safeJsonParse } from './lib/hook-io.mjs';

const OVERRIDE_VAR = 'SPECSMITH_GUARD_OVERRIDE';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// This edit would be the Nth in a row on the same file. 6 leaves room for a
// legitimate multi-hunk change (the audited runs of 4 and 5 pass; the run of
// 8 does not) while still stopping a genuine blind-editing spiral.
const RUN_THRESHOLD = 6;

// Commands that tell you whether the edits actually work.
const VERIFY_RE = /\b(run-gate\.mjs|vitest|jest|mocha|tsc|eslint|playwright|pytest|go test|cargo (test|build)|npm (run )?(test|lint|typecheck|build)|pnpm (run )?(test|lint|typecheck|build)|yarn (test|lint|typecheck|build)|check-conventions|curl)\b/;

function readTrace(tracePath) {
  if (!tracePath || !existsSync(tracePath)) return [];
  let raw;
  try { raw = readFileSync(tracePath, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const e = safeJsonParse(line);
    if (e) out.push(e);
  }
  return out;
}

// Count consecutive prior edits to `filePath`, walking backwards and stopping
// at anything that counts as verification or as attention moving elsewhere.
function consecutiveEdits(events, filePath) {
  let n = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];

    // A fresh context starts a fresh cadence.
    if (e.event === 'subagent_end' || e.event === 'session_end' || e.event === 'prompt') break;
    if (e.phase !== 'pre') continue;

    if (e.tool === 'Bash') {
      if (VERIFY_RE.test(e.input?.command || '')) break; // verified — reset
      continue;                                          // unrelated shell work
    }
    // Re-reading the file, or looking at the browser, is also information.
    if (e.tool === 'Read' || String(e.tool).startsWith('mcp__playwright__')) break;

    if (EDIT_TOOLS.has(e.tool)) {
      if (e.input?.file_path !== filePath) break; // moved to another file
      n++;
      continue;
    }
  }
  return n;
}

function logBypassAttempt(cwd, payload, reason) {
  try {
    const dir = resolve(cwd, 'pipeline', 'traces');
    mkdirSync(dir, { recursive: true });
    const f = String(payload?.tool_input?.file_path || '').slice(0, 200);
    const line = `${new Date().toISOString()}\t${OVERRIDE_VAR} set in hook context (IGNORED)\treason=${reason}\tedit=${f}\n`;
    writeFileSync(resolve(dir, 'guard-bypass-attempts.log'), line, { flag: 'a' });
  } catch {}
}

function main() {
  const raw = readStdin();
  if (!raw) process.exit(0);
  const payload = safeJsonParse(raw);
  const isHook = !!(payload && payload.hook_event_name);

  const override = process.env[OVERRIDE_VAR];
  if (override && !isHook) process.exit(0);
  if (override && isHook) logBypassAttempt(payload.cwd || process.cwd(), payload, override);

  if (!payload || payload.hook_event_name !== 'PreToolUse') process.exit(0);
  if (!EDIT_TOOLS.has(payload.tool_name)) process.exit(0);

  const filePath = payload.tool_input?.file_path;
  if (typeof filePath !== 'string' || !filePath.trim()) process.exit(0);

  const cwd = payload.cwd || process.cwd();
  const tracesDir = resolve(cwd, 'pipeline', 'traces');
  const tracePath = resolveTracePath(tracesDir, shortId(payload.session_id || ''), { createIfMissing: false });
  const prior = consecutiveEdits(readTrace(tracePath), filePath);

  if (prior + 1 < RUN_THRESHOLD) process.exit(0);

  const rel = filePath.startsWith(cwd + '/') ? filePath.slice(cwd.length + 1) : filePath;
  process.stderr.write(
    `Refusing this edit — it would be edit #${prior + 1} in a row on \`${basename(rel)}\` ` +
    `with no verification in between.\n` +
    `\n` +
    `You are editing blind. After ${prior} consecutive edits you still have no evidence ` +
    `that any of them work, and each one adds a full diff to context for zero information ` +
    `(Edit results were the largest single context cost in an audited /build run, at 6.5 MB).\n` +
    `\n` +
    `Run one verification, then continue — the guard resets immediately:\n` +
    `  node .claude/scripts/run-gate.mjs typecheck -- <typecheck command>\n` +
    `  node .claude/scripts/run-gate.mjs test -- <test command> <path>\n` +
    `\n` +
    `Reading \`${rel}\` back, or checking the page in the browser, also resets it — ` +
    `anything that tells you whether the edits landed. So does moving to a different file.\n` +
    `\n` +
    `If the change genuinely needs more than ${RUN_THRESHOLD} hunks, make the remaining ones ` +
    `after a verification run; you will want to know the first ${prior} were right before ` +
    `building further on them.`
  );
  process.exit(2);
}

main();
