#!/usr/bin/env node
// PreToolUse guard: refuse to re-Read a file that is already in the current
// agent's context and cannot have changed since it was read.
//
// Why this exists as code rather than prose: `skills/build/SKILL.md`,
// `agents/developer.md`, and `agents/evaluator.md` all instruct agents to read
// `pipeline/run-state.md` and `pipeline/environment-facts.md` once and then
// trust their context. The SKILL even cites a prior run's 10x/9x re-read as
// the cautionary tale. In the run audited afterwards those files were read
// 24x and 29x — the documented fix made it worse, because it was
// documentation. Across that session 318 of 514 Read calls (62%) re-read a
// file already read.
//
// Pairs with trace-hook.mjs — reads the same per-session JSONL that hook writes.
//
// Conservative by construction. A wrongly-denied Read is far more disruptive
// than a duplicate one, so the guard stands down whenever it cannot prove the
// content is unchanged AND already in context:
//
//   - Context boundary. The trace is per-SESSION and covers the orchestrator
//     and every subagent. A subagent starts with fresh context, so a file the
//     orchestrator read earlier is genuinely new to it. Only reads since the
//     most recent subagent boundary (or user prompt) count as "in context".
//   - Any Edit/Write/NotebookEdit to that path since the read → allowed.
//   - Any Bash command since the read that mentions the file → allowed
//     (a script, `git checkout`, or a codegen step may have rewritten it).
//   - A different offset/limit window → allowed; that's new content.
//
// Bypass: SPECSMITH_GUARD_OVERRIDE, honoured only outside hook context and
// logged when attempted under one — same policy as guard-repeat-commands.mjs.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { resolveTracePath, shortId } from './trace-path.mjs';
import { readStdin, safeJsonParse } from './lib/hook-io.mjs';

const OVERRIDE_VAR = 'SPECSMITH_GUARD_OVERRIDE';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

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

// Index of the first event belonging to the current agent's context. A
// subagent_end means a fresh context began after it; a user prompt means the
// human intervened and may legitimately want a re-read.
function contextStart(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === 'subagent_end' || e.event === 'session_end' || e.event === 'prompt') {
      return i + 1;
    }
  }
  return 0;
}

function sameWindow(a, b) {
  const norm = (x) => `${x?.offset ?? ''}:${x?.limit ?? ''}`;
  return norm(a) === norm(b);
}

// Returns the timestamp of a prior, still-valid read of `filePath`, or null.
function priorValidRead(events, filePath, input) {
  const start = contextStart(events);
  const name = basename(filePath);
  // Match on the extension-less stem so a helper that rewrites the file counts
  // even when it doesn't name it exactly — `verify-environment-facts.mjs`
  // must invalidate a read of `environment-facts.md`. Short stems are too
  // collision-prone to use this way, so those fall back to the full basename.
  const stem = name.replace(/\.[^.]+$/, '');
  const needle = stem.length >= 4 ? stem : name;

  for (let i = events.length - 1; i >= start; i--) {
    const e = events[i];
    if (e.phase !== 'pre') continue;

    // Anything that could have rewritten the file invalidates earlier reads.
    if (EDIT_TOOLS.has(e.tool) && e.input?.file_path === filePath) return null;
    if (e.tool === 'Bash') {
      const cmd = e.input?.command;
      // Deliberately loose: a bare stem match is enough to stand down.
      if (typeof cmd === 'string' && (cmd.includes(filePath) || cmd.includes(needle))) return null;
    }

    if (e.tool === 'Read' && e.input?.file_path === filePath) {
      if (!sameWindow(e.input, input)) return null; // different slice of the file
      return e.ts || 'earlier';
    }
  }
  return null;
}

function deny(message) {
  process.stderr.write(message + '\n');
  process.exit(2);
}

function logBypassAttempt(cwd, payload, reason) {
  try {
    const dir = resolve(cwd, 'pipeline', 'traces');
    mkdirSync(dir, { recursive: true });
    const f = String(payload?.tool_input?.file_path || '').slice(0, 200);
    const line = `${new Date().toISOString()}\t${OVERRIDE_VAR} set in hook context (IGNORED)\treason=${reason}\tread=${f}\n`;
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
  if (payload.tool_name !== 'Read') process.exit(0);

  const filePath = payload.tool_input?.file_path;
  if (typeof filePath !== 'string' || !filePath.trim()) process.exit(0);

  const cwd = payload.cwd || process.cwd();
  const tracesDir = resolve(cwd, 'pipeline', 'traces');
  const sessionId = shortId(payload.session_id || '');
  const tracePath = resolveTracePath(tracesDir, sessionId, { createIfMissing: false });
  const events = readTrace(tracePath);

  const priorTs = priorValidRead(events, filePath, payload.tool_input);
  if (!priorTs) process.exit(0);

  const rel = filePath.startsWith(cwd + '/') ? filePath.slice(cwd.length + 1) : filePath;
  deny(
    `Refusing to re-read \`${rel}\` — you already read it at ${priorTs}, and nothing has ` +
    `edited it since. The contents are already in your context.\n` +
    `\n` +
    `Scroll back to that read instead. Re-reading an unchanged file adds a full copy of ` +
    `it to the conversation for zero new information — in an audited /build run, 62% of ` +
    `all Read calls were re-reads of unchanged files.\n` +
    `\n` +
    `This guard stands down automatically when the file could have changed:\n` +
    `  - after any Edit/Write to it\n` +
    `  - after any Bash command that names it (script, git checkout, codegen)\n` +
    `  - when you request a different offset/limit window\n` +
    `  - for a subagent reading it for the first time in its own context\n` +
    `\n` +
    `If you are hunting for a fact you think you saw earlier: durable cross-cycle facts ` +
    `belong in \`pipeline/environment-facts.md\`. If it is not there, it was never ` +
    `recorded — record it there now rather than re-reading files to reconstruct it.`
  );
}

main();
