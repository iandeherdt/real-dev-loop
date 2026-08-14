#!/usr/bin/env node
// Claude Code hook handler for specsmith.
// Reads one hook event from stdin and appends one JSONL line to a per-run
// trace file under pipeline/traces/. Intentionally tiny — must not slow
// down tool calls.

import { readFileSync, existsSync, appendFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { shortId, resolveTracePath } from './trace-path.mjs';

const MAX_INPUT_BYTES = 2048;
const TAIL_BYTES = 512;

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function truncate(s, max) {
  if (typeof s !== 'string') s = String(s);
  if (s.length <= max) return s;
  return s.slice(0, max) + `…[+${s.length - max}b]`;
}

// Strip Claude Code's autolink rendering: `[foo.sh](http://foo.sh)` → `foo.sh`.
// The hook payload contains the rendered (autolinked) form, not the literal
// command bytes that bash received. We match only Claude Code's specific
// shape: bracket text is the entire host of the URL (no path segments).
// Legitimate markdown links like `[docs](https://example.com/docs)` have
// distinct bracket text and URL — those stay untouched.
function unmangleAutolinks(s) {
  if (typeof s !== 'string') return s;
  return s.replace(
    /\[([^\]\n]+)\]\(https?:\/\/\1\)/g,
    '$1'
  );
}

// Keep small payloads, summarise big ones. Never log full file contents.
function summariseInput(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return toolInput ?? null;
  // Special-case Bash: keep the command verbatim, truncate description.
  if (toolName === 'Bash' && typeof toolInput.command === 'string') {
    return {
      command: truncate(unmangleAutolinks(toolInput.command), MAX_INPUT_BYTES),
      description: typeof toolInput.description === 'string'
        ? truncate(unmangleAutolinks(toolInput.description), 200)
        : undefined,
      run_in_background: toolInput.run_in_background || undefined,
    };
  }
  // Generic: stringify and truncate.
  const json = JSON.stringify(toolInput);
  if (json.length <= MAX_INPUT_BYTES) return toolInput;
  return { _truncated: true, preview: truncate(json, MAX_INPUT_BYTES) };
}

// A command whose real result is hidden from us: piping to a line filter
// replaces the exit code with the filter's (always 0) and `2>&1` folds stderr
// into stdout, so every structured signal below goes quiet. An audited
// 15-hour run had 767 of 1,446 Bash calls in this shape and the trace
// reported ZERO errors for the whole session. We can't recover the exit code
// after the fact, but we CAN mark the call as unobservable so the digest
// reports how much of the run it could not see.
const FILTER_PIPE_RE = /\|\s*(?:grep|rg|awk|sed|head|tail|wc|jq|cut|sort|uniq)\b/;

// run-gate.mjs prints this on its last line precisely so the real exit code
// survives any amount of piping. It is the one reliable failure signal for
// wrapped quality gates.
const GATE_SENTINEL_RE = /SPECSMITH_GATE\b[^\n]*?\bexit=(\d+)/;

function responseText(toolResponse) {
  if (toolResponse == null) return '';
  if (typeof toolResponse === 'string') return toolResponse;
  if (typeof toolResponse === 'object') {
    try { return JSON.stringify(toolResponse); } catch { return String(toolResponse); }
  }
  return String(toolResponse);
}

function looksLikeError(toolResponse) {
  // Trust only structured signals. Lexical sniffing on body text was tried
  // in v1.3.0 and produced too many false positives — any source file that
  // contained the word "error" (NextResponse error responses, error-handling
  // code, etc.) flagged on a normal Read, drowning real failures in noise.
  //
  // The SPECSMITH_GATE sentinel is the one exception: it is not a lexical
  // guess, it is a value run-gate.mjs emits for exactly this purpose.
  const m = GATE_SENTINEL_RE.exec(responseText(toolResponse));
  if (m) return m[1] !== '0';

  if (!toolResponse || typeof toolResponse !== 'object') return false;
  if (toolResponse.is_error === true) return true;
  if (typeof toolResponse.stderr === 'string' && toolResponse.stderr.trim()) return true;
  if (typeof toolResponse.error === 'string' && toolResponse.error.trim()) return true;
  if (typeof toolResponse.exit_code === 'number' && toolResponse.exit_code !== 0) return true;
  return false;
}

// True when the tool call's success/failure cannot be determined from its
// response — a Bash command that filtered its own output and did not go
// through run-gate.mjs.
function isUnobservable(toolName, toolInput, toolResponse) {
  if (toolName !== 'Bash') return false;
  const cmd = toolInput?.command;
  if (typeof cmd !== 'string') return false;
  if (!FILTER_PIPE_RE.test(cmd)) return false;
  return !GATE_SENTINEL_RE.test(responseText(toolResponse));
}

function summariseOutput(toolResponse, toolName, toolInput) {
  if (toolResponse == null) return null;
  let text = unmangleAutolinks(responseText(toolResponse));
  const len = text.length;
  const error = looksLikeError(toolResponse);
  const unobservable = isUnobservable(toolName, toolInput, toolResponse) || undefined;
  if (len <= TAIL_BYTES * 2 + 32) {
    return { len, error, unobservable, body: text };
  }
  return {
    len,
    error,
    unobservable,
    head: text.slice(0, TAIL_BYTES),
    tail: text.slice(len - TAIL_BYTES),
  };
}

// Walk back through transcript JSONL to find the most recent message with
// a `usage` field. Returns null on any failure — token usage is best-effort.
function readUsageFromTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }
  // Parse from the bottom up. Transcripts can be large; split + reverse is
  // simpler than reverse-streaming and the cost only hits at SubagentStop/Stop.
  const lines = raw.split('\n');
  let model = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const obj = safeJsonParse(line);
    if (!obj) continue;
    // Claude Code transcript shapes vary; try a few common locations.
    const usage =
      obj?.message?.usage ||
      obj?.usage ||
      obj?.response?.usage ||
      null;
    const m =
      obj?.message?.model ||
      obj?.model ||
      null;
    if (m && !model) model = m;
    if (usage) return { model, usage };
  }
  return null;
}

// Best-effort removal of the dispatch sentinel when a subagent finishes.
// Never throws — losing the lock file is harmless (the guard re-arms), and a
// hook that crashes would surface noise on every subagent return.
function closeDispatchLock(cwd) {
  try {
    rmSync(join(cwd, 'pipeline', 'dispatch-active.txt'), { force: true });
  } catch {}
}

function buildEvent(payload) {
  const ts = new Date().toISOString();
  const sessionFull = payload.session_id || '';
  const session = shortId(sessionFull);
  const base = { ts, session, hook: payload.hook_event_name };

  switch (payload.hook_event_name) {
    case 'PreToolUse':
      return {
        ...base,
        event: 'tool_call',
        phase: 'pre',
        tool: payload.tool_name,
        input: summariseInput(payload.tool_name, payload.tool_input),
      };
    case 'PostToolUse':
      return {
        ...base,
        event: 'tool_call',
        phase: 'post',
        tool: payload.tool_name,
        output: summariseOutput(payload.tool_response, payload.tool_name, payload.tool_input),
      };
    case 'SubagentStop': {
      // Closing half of the self-managing dispatch lock that
      // guard-orchestrator-discipline.mjs opens on an Agent dispatch. The
      // /build skill used to instruct an explicit `rm -f` here; doing it in
      // the hook removes a round-trip per dispatch and removes the failure
      // mode where the orchestrator left a lock open and silently disarmed
      // the guard for the rest of the run.
      closeDispatchLock(payload.cwd || process.cwd());
      const u = readUsageFromTranscript(payload.transcript_path);
      return {
        ...base,
        event: 'subagent_end',
        model: u?.model || null,
        usage: u?.usage || null,
      };
    }
    case 'Stop': {
      const u = readUsageFromTranscript(payload.transcript_path);
      return {
        ...base,
        event: 'session_end',
        model: u?.model || null,
        usage: u?.usage || null,
      };
    }
    case 'UserPromptSubmit':
      return {
        ...base,
        event: 'prompt',
        prompt: typeof payload.prompt === 'string'
          ? truncate(payload.prompt, 400)
          : null,
      };
    default:
      return { ...base, event: 'other' };
  }
}

function main() {
  const raw = readStdin();
  if (!raw) process.exit(0);
  const payload = safeJsonParse(raw);
  if (!payload || typeof payload !== 'object') process.exit(0);

  const cwd = payload.cwd || process.cwd();
  const tracesDir = resolve(cwd, 'pipeline', 'traces');
  const sessionId = shortId(payload.session_id || '');

  const tracePath = resolveTracePath(tracesDir, sessionId);
  if (!tracePath) process.exit(0);

  const event = buildEvent(payload);
  try {
    appendFileSync(tracePath, JSON.stringify(event) + '\n');
  } catch (err) {
    // Best-effort: write to a fallback under $HOME so we don't lose the
    // event entirely if the project tree is read-only or the path failed.
    try {
      const fallback = join(homedir(), '.specsmith-trace.jsonl');
      appendFileSync(fallback, JSON.stringify({ ...event, _fallback: true, error: String(err) }) + '\n');
    } catch {}
  }
  // Hook stdout/stderr is surfaced to the user — keep silent.
  process.exit(0);
}

main();
