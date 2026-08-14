#!/usr/bin/env node
// PreToolUse guard: refuse to re-run expensive Bash commands when nothing
// has changed since the last run, and refuse state-wipe loops on the same
// path. Pairs with trace-hook.mjs — reads the same per-session JSONL file
// that hook is writing.
//
// A PreToolUse hook denies a tool call by exiting non-zero (we use exit 2)
// and writing a message to stderr. Claude Code surfaces stderr back to the
// model as feedback, so the agent sees why the call was blocked.
//
// Bypass: see README under "Runtime guard". Bypasses are restricted to
// non-hook invocations (e.g. manual testing of this script) and any
// attempt under a hook context is logged to pipeline/traces/.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { resolveTracePath, shortId } from './trace-path.mjs';
import { readStdin, safeJsonParse } from './lib/hook-io.mjs';

const OVERRIDE_VAR = 'SPECSMITH_GUARD_OVERRIDE';

// The `(?<!show-)(?:pixel|dom)-diff\.mjs` clause catches the specsmith
// design-diff scripts — pixel-diff.mjs / dom-diff.mjs and their project
// `run-*` wrappers — which are the most expensive commands in a /build cycle
// (a full-app pixel diff is ~2 min). They were NOT in this list, so an agent
// could re-run the whole diff just to re-grep its own output with no edits in
// between; an audit trace showed pixel-diff run back-to-back, 0 edits between,
// ~130s wasted (the second run only changed the trailing `| tail` to `| grep`).
// The negative lookbehind exempts `show-pixel-diff.mjs` / `show-dom-diff.mjs`,
// the cheap JSON readers the agent SHOULD be using instead — blocking those
// would push agents back toward re-running the real diff.
//
// Terminator note: earlier versions wrote the alternatives as
// `tsc(\s|$)|jest(\s|$)|vitest(\s|$)` inside a group closed by a trailing `\b`.
// That combination can NEVER match when the tool is followed by a flag: the
// alternative consumes the space, leaving `\b` to sit between " " and "-",
// which are both non-word characters, so no boundary exists. Verified against
// a real 15-hour /build trace — `npx tsc --noEmit` (49 calls) and
// `node ./node_modules/vitest/dist/cli.js run` (122 calls, the single
// most-run command of the session) both tested FALSE, so the repeat guard was
// inert for the two most expensive command classes in the entire run. Use a
// zero-width `(?![\w-])` terminator instead — it never consumes, so it cannot
// create the same trap.
//
// Bare tool names (tsc/jest/vitest/eslint/...) are anchored to a command
// position — start of the base, or just after `&&` / `;` / `|`. Without the
// anchor, `cat vitest.config.ts` would read as "expensive". Direct-binary and
// `npx` forms are collapsed onto the bare name by baseCommand() below, so the
// anchor holds for every invocation style we've seen.
const EXPENSIVE_TOOLS = 'tsc|jest|vitest|eslint|mocha|playwright test';
const EXPENSIVE_RE = new RegExp(
  [
    `(?:^|&&\\s*|;\\s*|\\|\\s*)(?:${EXPENSIVE_TOOLS})(?![\\w./-])`,
    '\\b(?:npm|pnpm) (?:run )?(?:test|lint|typecheck|build)(?![\\w-])',
    '\\byarn (?:test|lint|typecheck|build)(?![\\w-])',
    '\\bnext (?:lint|build)(?![\\w-])',
    '\\bprisma migrate(?![\\w-])',
    '\\bcargo (?:test|build)(?![\\w-])',
    '\\bgo test(?![\\w-])',
    '\\b(?:mvn|gradle)(?![\\w-])',
    '(?<!show-)(?:pixel|dom)-diff\\.mjs',
  ].join('|')
);
// The sanctioned gate wrapper — self-throttling, so Rule 1 stands down for it.
const RUN_GATE_RE = /\brun-gate\.mjs\b/;

const STATE_WIPE_RE = /\brm\s+-rf?\s+\S*(pglite|\.next|node_modules|data\/)/;
const STATE_WIPE_WINDOW_MS = 30 * 60 * 1000;
const STATE_WIPE_THRESHOLD = 2; // i.e. this would be the 3rd

// Long inline scripts in ANY interpreter. Agents reach for `python3 -c '...'`,
// `perl -e '...'`, `ruby -e '...'`, `php -r '...'` to dodge guards and to
// "just one more parse" their way through diff output instead of writing a
// proper helper script. The threshold (LONG_INLINE_CHARS) is a heuristic:
// short one-liners (`python3 -c 'import sys; print(sys.argv)'`) are fine.
// Anything that wraps into a 200-char blob of JSON-parsing or AST-walking
// belongs in a `.mjs` / `.py` / `.pl` file the user can read, version, and
// re-run. Caught in audit 2026-05-19T02-31: orchestrator pasted a 1.2 KB
// Python script as `python3 -c '...'` to read pixel-diff.json, when a
// 30-line helper script already existed for that purpose.
const LONG_INLINE_RE = /\b(python3?|node|perl|ruby|php|deno|bun)\s+(?:-[a-zA-Z]\s+)*-(?:e|c|r)\s+(["'])([\s\S]+?)\2/;
const LONG_INLINE_CHARS = 200;

// Mining the per-session trace JSONL as agent memory. Both the developer and
// evaluator agents are told, in prose, to NEVER grep / cat / tail / wc / parse
// `pipeline/traces/*.jsonl` — the trace is write-only telemetry for the human
// and `trace-summarise.mjs`, not a memory store; the durable cross-cycle facts
// belong in `pipeline/environment-facts.md`. Prose bans get ignored: an audit
// of a 3-hour /build run found 22 trace-greps in a single 90-minute window
// (`grep '"tool":"Edit"' …jsonl`, `grep '"phase":"pre"' …jsonl`, `wc -l …jsonl`)
// despite the ban shipping in v0.23. Enforce it.
const TRACE_JSONL_RE = /pipeline\/traces\/[^\s'"]*\.jsonl/;
// The only sanctioned readers of the raw trace name themselves in the command.
const TRACE_SANCTIONED_RE = /trace-summarise\.mjs|trace-path\.mjs/;

// If the command is wrapped in `node -e "..."` / `bash -c "..."` / `sh -c "..."`,
// pull the inner code out. Agents reach for these wrappers when the guard
// blocks the direct form, so we collapse the wrapped variant to the same
// base as the unwrapped one.
function unwrapShell(cmd) {
  const nodeE = cmd.match(/^\s*node(?:\s+--[^\s]+)*\s+-e\s+(["'])([\s\S]+)\1\s*$/);
  if (nodeE) {
    const inner = nodeE[2];
    // node -e wrappers typically call execSync('shell command here', ...) —
    // pull out that first string argument so we can compare it to a prior
    // direct shell invocation.
    const exec = inner.match(/(?:exec|spawn)Sync\s*\(\s*(["'`])([\s\S]+?)\1/);
    if (exec) return exec[2];
    return inner;
  }
  const shellC = cmd.match(/^\s*(?:bash|sh|zsh)\s+-c\s+(["'])([\s\S]+)\1\s*$/);
  if (shellC) return shellC[2];
  return cmd;
}

// Strip everything from the first ` | (grep|tail|head|...)` onward, any
// trailing `; echo …` / `&& echo …` epilogue, any stream redirection
// (`2>&1`, `> out.txt`, `2>/dev/null`, `>> log`), and any leading env-var
// prefix (`SKIP_ENV=1 NODE_ENV=test <cmd>`). What's left is the "base" —
// the part that actually does the work. Wrapped forms (`node -e "..."`,
// `bash -c "..."`) are unwrapped first. Redirections are stripped because
// they are not "work": `pixel-diff.mjs` and `pixel-diff.mjs 2>&1` must
// normalise to the same base, otherwise toggling `2>&1` dodges the guard.
// Collapse the many ways to invoke the same package binary onto one name, so
// repeat detection compares like with like. `npx vitest run x`,
// `node ./node_modules/vitest/dist/cli.js run x`, and
// `./node_modules/.bin/vitest run x` are the same work; before this, they were
// three different bases and a re-run in a different form was invisible to the
// guard. The audited trace used the `dist/cli.js` form 122 times.
function normaliseRunner(b) {
  // `node_modules/.bin/<tool>` → `<tool>`. Must run before the package rule,
  // whose `([\w@.-]+)` would otherwise capture `.bin` as the package name.
  b = b.replace(/(?:^|(?<=\s))(?:\S*\/)?node_modules\/\.bin\/([\w@.-]+)/g, '$1');
  // `node_modules/<pkg>/…/cli.js` or `node_modules/<pkg>/bin/<name>.js` → `<pkg>`.
  b = b.replace(
    /(?:^|(?<=\s))(?:\S*\/)?node_modules\/([\w@.-]+)\/[\w./-]*?(?:cli|bin\/[\w.-]+)\.[cm]?js/g,
    '$1'
  );
  // Runner prefixes add nothing once the binary is named.
  b = b.replace(/^(?:npx|pnpm\s+(?:exec|dlx)|yarn\s+dlx|bunx)\s+(?:--\S+\s+)*/, '');
  // Strip a leading `node` ONLY when what follows is now a bare tool name.
  // `node .claude/scripts/pixel-diff.mjs` keeps its `node` (the lookahead
  // rejects tokens containing `/`), so existing bases are unchanged.
  b = b.replace(/^node\s+(?:--\S+\s+)*(?=[\w@.-]+(?:\s|$))/, '');
  return b;
}

function baseCommand(cmd) {
  if (typeof cmd !== 'string') return '';
  let b = unwrapShell(cmd);
  b = b.replace(/^(?:\s*[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, '');
  b = normaliseRunner(b);
  b = b.replace(/\s*\|\s*(grep|rg|awk|sed|head|tail|wc|jq|tee|cut|sort|uniq|less|more)\b.*$/, '');
  b = b.replace(/\s*(;|&&)\s*echo\b.*$/, '');
  b = b.replace(/\s*\d*>>?\s*(?:&\d+|\S+)/g, '');
  return b.trim();
}

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

// Walk the trace backwards. Return:
//   - lastBaseAt: timestamp of the most recent prior PreToolUse Bash event
//                 whose base command matches `base`, or null
//   - editsBetween: count of Edit/Write PreToolUse events that occurred
//                   strictly after lastBaseAt (i.e. between then and now)
function analyseRepeat(events, base) {
  let lastBaseIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.phase !== 'pre' || e.tool !== 'Bash') continue;
    const cmd = e.input?.command;
    if (!cmd) continue;
    if (baseCommand(cmd) === base) { lastBaseIdx = i; break; }
  }
  if (lastBaseIdx === -1) return { lastBaseAt: null, editsBetween: 0 };

  let edits = 0;
  for (let i = lastBaseIdx + 1; i < events.length; i++) {
    const e = events[i];
    if (e.phase !== 'pre') continue;
    if (e.tool === 'Edit' || e.tool === 'Write') edits++;
  }
  return { lastBaseAt: events[lastBaseIdx].ts, editsBetween: edits };
}

function countRecentWipes(events, cmd) {
  // Pull the path-ish argument out of `rm -rf <path>`.
  const m = cmd.match(/rm\s+-rf?\s+(\S+)/);
  if (!m) return 0;
  const target = m[1].replace(/['"]/g, '');
  const cutoff = Date.now() - STATE_WIPE_WINDOW_MS;
  let n = 0;
  for (const e of events) {
    if (e.phase !== 'pre' || e.tool !== 'Bash') continue;
    const c = e.input?.command;
    if (typeof c !== 'string') continue;
    if (!STATE_WIPE_RE.test(c)) continue;
    if (!c.includes(target)) continue;
    const t = Date.parse(e.ts || '');
    if (Number.isNaN(t) || t < cutoff) continue;
    n++;
  }
  return n;
}

function deny(message) {
  process.stderr.write(message + '\n');
  process.exit(2);
}

function logBypassAttempt(cwd, payload, reason) {
  try {
    const dir = resolve(cwd, 'pipeline', 'traces');
    mkdirSync(dir, { recursive: true });
    const cmd = String(payload?.tool_input?.command || '').slice(0, 200).replace(/\s+/g, ' ');
    const line = `${new Date().toISOString()}\t${OVERRIDE_VAR} set in hook context (IGNORED)\treason=${reason}\tcmd=${cmd}\n`;
    writeFileSync(resolve(dir, 'guard-bypass-attempts.log'), line, { flag: 'a' });
  } catch {}
}

function main() {
  const raw = readStdin();
  if (!raw) {
    // Manual invocation with no stdin payload — honor the override env var
    // so this script remains testable from a shell. There is no agent here.
    if (process.env[OVERRIDE_VAR]) process.exit(0);
    process.exit(0);
  }
  const payload = safeJsonParse(raw);
  const isHook = !!(payload && payload.hook_event_name);

  // Bypass: SPECSMITH_GUARD_OVERRIDE=<non-empty-reason>. Honored only when
  // the script was NOT invoked as a hook (e.g. manual testing). Under a hook
  // context — which is every Claude Code Bash tool call — the override is
  // ignored and the attempt is logged. This closes the env-var bypass loop
  // that earlier versions of the guard left open.
  const override = process.env[OVERRIDE_VAR];
  if (override && !isHook) process.exit(0);
  if (override && isHook) {
    logBypassAttempt(payload.cwd || process.cwd(), payload, override);
  }

  if (!payload || payload.hook_event_name !== 'PreToolUse') process.exit(0);
  if (payload.tool_name !== 'Bash') process.exit(0);

  const cmd = payload.tool_input?.command;
  if (typeof cmd !== 'string' || !cmd.trim()) process.exit(0);

  const cwd = payload.cwd || process.cwd();
  const tracesDir = resolve(cwd, 'pipeline', 'traces');
  const sessionId = shortId(payload.session_id || '');
  const tracePath = resolveTracePath(tracesDir, sessionId, { createIfMissing: false });
  const events = readTrace(tracePath);

  // Rule 1: re-running an expensive command with no edits in between.
  //
  // `run-gate.mjs` is exempt: it already refuses to redo work, and does it
  // better than a denial can. It fingerprints the working tree and replays the
  // previous verdict when nothing changed, and a bare re-invocation re-attaches
  // to a detached run that is still in flight. Denying those calls would push
  // the agent back toward raw `npm test 2>&1 | tail`, which is the shape that
  // hides exit codes in the first place. Note the wrapped command appears
  // inside the run-gate invocation (`run-gate.mjs test -- npm test`), so
  // without this exemption EXPENSIVE_RE would match on the inner command.
  const base = baseCommand(cmd);
  if (EXPENSIVE_RE.test(base) && !RUN_GATE_RE.test(base)) {
    const { lastBaseAt, editsBetween } = analyseRepeat(events, base);
    if (lastBaseAt && editsBetween === 0) {
      const ageS = Math.max(0, Math.round((Date.now() - Date.parse(lastBaseAt)) / 1000));
      deny(
        `Refusing to re-run \`${base}\` — it ran ${ageS}s ago and no Edit/Write ` +
        `tool calls have happened since, so the output will be identical. ` +
        `You are looping.\n` +
        `\n` +
        `Do this instead:\n` +
        `  1. Open the output you already have — your scrollback, or the log from the\n` +
        `     prior run at \`pipeline/traces/last-<gate>.log\` if it went through run-gate.mjs.\n` +
        `  2. Pick ONE failure. Read it carefully.\n` +
        `  3. Edit code to fix it. Once an Edit/Write happens, the guard allows a re-run.\n` +
        `\n` +
        `Run quality gates through the wrapper so this stops happening:\n` +
        `  node .claude/scripts/run-gate.mjs <gate> -- <command>\n` +
        `It keeps the real exit code, writes the full log to a fixed path you can grep\n` +
        `for free, and replays the previous verdict when nothing has changed.\n` +
        `\n` +
        `Do NOT try to bypass this block — every variant below is detected and will also be refused:\n` +
        `  - Wrapping the command in \`node -e "…"\`, \`bash -c "…"\`, \`sh -c "…"\`, etc.\n` +
        `  - Prefixing env vars (\`SKIP_ENV_VALIDATION=1\`, \`NODE_ENV=test\`, \`CI=1\`, …)\n` +
        `  - Varying --reporter / --bail / tee filenames / output redirection\n` +
        `  - Setting any env var that claims to disable this guard — the guard ignores all such overrides in hook context and logs the attempt to \`pipeline/traces/guard-bypass-attempts.log\` for the user to see\n` +
        `\n` +
        `The guard is telling you to stop and diagnose, not to find a new way to run the same command.`
      );
    }
  }

  // Rule 2: a long inline script in any interpreter. Wrapping a 1 KB Python
  // parse into `python3 -c '...'` reaches the same "I'm doing work that
  // belongs in a helper" failure mode as the node -e bypass we already
  // unwrap above — but in a language the unwrap regex doesn't speak. Treat
  // length, not language, as the signal.
  {
    const m = cmd.match(LONG_INLINE_RE);
    if (m && m[3] && m[3].length >= LONG_INLINE_CHARS) {
      const interp = m[1];
      const inner = m[3];
      deny(
        `Refusing this command — long inline ${interp} script (${inner.length} chars).\n` +
        `\n` +
        `Inline scripts that long should be a versioned helper file, not\n` +
        `a one-shot \`${interp} -e/-c '...'\` blob. Reasons:\n` +
        `  - You can't read it back in two days when something breaks.\n` +
        `  - There's no way to test it before running it.\n` +
        `  - Subagents and humans both write more careful code into a file.\n` +
        `  - In /build runs, this pattern is how orchestrators end up doing\n` +
        `    the developer's work inline — see Constitution Principle VIII.\n` +
        `\n` +
        `Do this instead:\n` +
        `  1. Save the script to \`.claude/scripts/<name>.mjs\` (or .py / .pl /\n` +
        `     .rb depending on interpreter). If the work is ad-hoc and you\n` +
        `     don't want to keep it, put it under \`pipeline/scratch/\` —\n` +
        `     gitignored by default in specsmith projects.\n` +
        `  2. Run it with \`${interp} <path>\`. The output is identical, the\n` +
        `     intent is grep-able, and the next session can re-use it.\n` +
        `\n` +
        `For reading pixel-diff / dom-diff output specifically, the helpers\n` +
        `already exist — don't re-implement them inline:\n` +
        `  node .claude/scripts/show-pixel-diff.mjs\n` +
        `  node .claude/scripts/show-dom-diff.mjs\n` +
        `\n` +
        `If you genuinely need a long inline script (rare), split it into\n` +
        `discrete short Bash steps the user can audit one at a time.`
      );
    }
  }

  // Rule 3: reading the per-session trace JSONL directly. The trace is
  // write-only telemetry; mining it as memory (grep/cat/wc/sed/python parse)
  // is a documented anti-pattern that still happens because prose can't stop
  // it. The fact you're reaching for belongs in pipeline/environment-facts.md.
  if (TRACE_JSONL_RE.test(cmd) && !TRACE_SANCTIONED_RE.test(cmd)) {
    deny(
      `Refusing this command — it reads the per-session trace at ` +
      `\`pipeline/traces/*.jsonl\` directly.\n` +
      `\n` +
      `The trace is write-only telemetry for the human and ` +
      `\`trace-summarise.mjs\`, NOT agent memory. Grepping/cat-ing/parsing it ` +
      `to recover "what did I do earlier" is the single most common source of ` +
      `repeat-command churn in long runs.\n` +
      `\n` +
      `Do this instead:\n` +
      `  - The durable cross-cycle facts (commands that worked, ports, stale ` +
      `artifacts) belong in \`pipeline/environment-facts.md\`. Read that.\n` +
      `  - If the fact you need isn't there, it was never recorded — record it ` +
      `there now so the next cycle doesn't pay this cost either.\n` +
      `  - For a human-facing summary of the run, use ` +
      `\`node .claude/scripts/trace-summarise.mjs\` — the one sanctioned reader.\n` +
      `\n` +
      `Do NOT wrap the read in python3/node/jq or a different tool to dodge ` +
      `this block — the trace is not the right source regardless of how you ` +
      `parse it.`
    );
  }

  // Rule 4: repeated state wipes of the same path.
  if (STATE_WIPE_RE.test(cmd)) {
    const prior = countRecentWipes(events, cmd);
    if (prior >= STATE_WIPE_THRESHOLD) {
      deny(
        `Refusing this state wipe — the same path has been removed ${prior} time(s) ` +
        `in the last 30 minutes. If the same failure keeps coming back after a wipe, ` +
        `the bug isn't stale state. Read the underlying error (the dev-server log, ` +
        `the last failing test output) and fix the root cause.\n` +
        `\n` +
        `Do NOT try to bypass by wrapping the rm in \`node -e\` / \`bash -c\`, by ` +
        `targeting the same path with a different glob, or by setting an env var ` +
        `that claims to disable this guard — bypass attempts in hook context are ` +
        `logged and ignored. The guard exists because repeated wipes have ` +
        `historically masked the real bug.`
      );
    }
  }

  process.exit(0);
}

main();
