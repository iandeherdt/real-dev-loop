#!/usr/bin/env node
// Tests for scripts/trace-summarise.mjs.
//
// The fixture is distilled from a real 15-hour /build run (all 60 stop
// markers, plus a sample of tool calls). That run is what exposed the
// accounting bug these tests lock down: the digest summed
// `cache_read_input_tokens` across every stop marker and reported
// 19,509,503 for a session whose largest single sample was 400,177 — an ~50x
// overstatement that made the digest useless for cost reasoning. 11 of the 60
// markers also carried byte-identical duplicate payloads, because
// readUsageFromTranscript() resolves `transcript_path` to the SESSION
// transcript and re-reads whatever message was last.
//
// Run with: `node tests/trace-summarise.test.mjs` or `npm test`.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'scripts', 'trace-summarise.mjs');
const FIXTURE = join(HERE, 'fixtures', 'build-run-2026-08-13.jsonl');

let failures = 0;

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
  else { console.log(`ok   ${msg}`); }
}

function summarise(path) {
  const r = spawnSync('node', [SCRIPT, path], { encoding: 'utf8' });
  return r.stdout;
}

const out = summarise(FIXTURE);

// ── Token accounting ──
{
  assert(
    !/cache_read=1950\d{4}/.test(out) && !/cache_read=\d{8,}/.test(out),
    'no absurd summed cache_read figure is reported'
  );
  assert(
    /peak cache_read:\s*400177/.test(out),
    'the peak cache_read is reported from the samples (400177)'
  );
  assert(
    /not a billing total/.test(out),
    'the token section states that these are samples, not a billing total'
  );
  assert(
    /not additive across markers/.test(out),
    'the digest explains why cache_read is not summed'
  );
}

// ── Duplicate suppression ──
{
  assert(
    /Stop markers: 60/.test(out),
    'all 60 stop markers are counted'
  );
  assert(
    /11 repeated sample\(s\) suppressed/.test(out),
    'the 11 byte-identical duplicate usage payloads are suppressed'
  );
}

// ── Backgrounded-call reporting ──
{
  assert(
    /auto-backgrounded at the tool timeout/.test(out),
    'unpaired calls are attributed to the tool timeout, not just "interrupted"'
  );
}

// ── Blind-spot reporting on a new-format trace ──
// `unobservable` is set by trace-hook.mjs when a Bash command filtered its own
// output and did not go through run-gate.mjs. A run with zero detected errors
// is otherwise ambiguous: perfect, or simply unobservable.
{
  const dir = mkdtempSync(join(tmpdir(), 'trace-sum-'));
  const path = join(dir, 'trace.jsonl');
  const evt = (o) => JSON.stringify({ ts: '2026-08-14T00:00:00.000Z', session: 'abcd1234', event: 'tool_call', ...o });
  writeFileSync(path, [
    evt({ phase: 'pre', tool: 'Bash', input: { command: 'npx tsc --noEmit 2>&1 | tail -60' } }),
    evt({ phase: 'post', tool: 'Bash', output: { len: 10, error: false, unobservable: true, body: 'x' } }),
    evt({ phase: 'pre', tool: 'Bash', input: { command: 'git status' } }),
    evt({ phase: 'post', tool: 'Bash', output: { len: 5, error: false, body: 'y' } }),
    JSON.stringify({ ts: '2026-08-14T00:01:00.000Z', session: 'abcd1234', event: 'prompt', prompt: 'fix the failing test' }),
  ].join('\n') + '\n');

  const o = summarise(path);
  assert(/Blind spots:/.test(o), 'unobservable calls are reported as blind spots');
  assert(/1 of 2 tool results \(50%\)/.test(o), 'the blind-spot ratio is computed correctly');
  assert(/run-gate\.mjs/.test(o), 'the blind-spot section points at the gate wrapper');
  assert(/User prompts \(1\)/.test(o), 'user prompts are listed');
  assert(/fix the failing test/.test(o), 'the prompt text is shown');
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
