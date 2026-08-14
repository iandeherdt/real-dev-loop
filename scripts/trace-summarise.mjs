#!/usr/bin/env node
// Read one or more pipeline trace JSONL files and print a digest:
// tool-call frequency, repeat-call flailing, cycle markers, token totals.

import { readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: trace-summarise.mjs <trace.jsonl> [more.jsonl ...]

Prints a digest of pipeline trace JSONL files.

Sections:
  - Tool-call frequency (per session)
  - Suspected flails (same tool + similar args, 5+ times in a row)
  - Cycle markers (subagent_end events)
  - Token usage per session
`);
  process.exit(args.length ? 0 : 1);
}

function parseLines(path) {
  if (!existsSync(path)) {
    console.error(`skip: ${path} does not exist`);
    return [];
  }
  const raw = readFileSync(path, 'utf8');
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Skip malformed line — could be a partially-flushed write.
    }
  }
  return events;
}

function fingerprint(event) {
  // A short canonical signature for repeat-call detection. We hash the
  // first slice of the most identifying field per tool.
  const t = event.tool || '';
  const i = event.input || {};
  if (t === 'Bash') return `Bash:${(i.command || '').slice(0, 80)}`;
  if (t === 'Read') return `Read:${(i.file_path || '').slice(0, 120)}`;
  if (t === 'Edit') return `Edit:${(i.file_path || '').slice(0, 120)}`;
  if (t === 'Write') return `Write:${(i.file_path || '').slice(0, 120)}`;
  if (t === 'Grep') return `Grep:${(i.pattern || '').slice(0, 80)}`;
  if (t === 'Glob') return `Glob:${(i.pattern || '').slice(0, 80)}`;
  // Generic — JSON of inputs, capped.
  let json;
  try { json = JSON.stringify(i); } catch { json = ''; }
  return `${t}:${json.slice(0, 120)}`;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function summarise(allEvents) {
  // Group events by session.
  const bySession = new Map();
  for (const e of allEvents) {
    if (!e.session) continue;
    if (!bySession.has(e.session)) bySession.set(e.session, []);
    bySession.get(e.session).push(e);
  }

  for (const [session, events] of bySession) {
    const start = events[0]?.ts || '?';
    const end = events[events.length - 1]?.ts || '?';
    console.log('');
    console.log('='.repeat(70));
    console.log(`Session ${session}   ${start} → ${end}   (${events.length} events)`);
    console.log('='.repeat(70));

    // Tool frequency: use max(pre, post) per tool — every call should fire
    // both phases, but interrupted calls miss the post and stale post events
    // can outlive their pre.
    const preFreq = new Map();
    const postFreq = new Map();
    const errors = new Map();
    for (const e of events) {
      if (e.event !== 'tool_call') continue;
      if (e.phase === 'pre') {
        preFreq.set(e.tool, (preFreq.get(e.tool) || 0) + 1);
      } else if (e.phase === 'post') {
        postFreq.set(e.tool, (postFreq.get(e.tool) || 0) + 1);
        if (e.output?.error) {
          errors.set(e.tool, (errors.get(e.tool) || 0) + 1);
        }
      }
    }
    const allTools = new Set([...preFreq.keys(), ...postFreq.keys()]);
    const freq = new Map();
    let pendingTotal = 0;
    for (const tool of allTools) {
      const p = preFreq.get(tool) || 0;
      const q = postFreq.get(tool) || 0;
      freq.set(tool, Math.max(p, q));
      if (p > q) pendingTotal += p - q;
    }

    console.log('');
    console.log('Tool calls:');
    const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    for (const [tool, n] of sorted) {
      const errs = errors.get(tool) || 0;
      const errPart = errs ? `  (${errs} error${errs === 1 ? '' : 's'})` : '';
      console.log(`  ${pad(tool, 32)} ${pad(n, 5)}${errPart}`);
    }
    if (pendingTotal > 0) {
      console.log(
        `  (${pendingTotal} call(s) without a post event — auto-backgrounded at the tool ` +
        `timeout, interrupted, or still in flight)`
      );
      console.log(
        '  Long gates should go through `run-gate.mjs`: it detaches the child, so a call ' +
        'that\n  hits the timeout can be re-attached instead of re-run.'
      );
    }

    // Repeat-call flailing detection: 5+ consecutive same-fingerprint calls.
    const runs = [];
    let lastFp = null;
    let runStart = -1;
    let runLen = 0;
    const preEvents = events.filter((e) => e.event === 'tool_call' && e.phase === 'pre');
    for (let i = 0; i < preEvents.length; i++) {
      const fp = fingerprint(preEvents[i]);
      if (fp === lastFp) {
        runLen++;
      } else {
        if (runLen >= 5) {
          runs.push({ fp: lastFp, count: runLen, startIdx: runStart, startTs: preEvents[runStart].ts });
        }
        lastFp = fp;
        runStart = i;
        runLen = 1;
      }
    }
    if (runLen >= 5) {
      runs.push({ fp: lastFp, count: runLen, startIdx: runStart, startTs: preEvents[runStart].ts });
    }
    if (runs.length) {
      console.log('');
      console.log('Suspected flails:');
      for (const r of runs) {
        console.log(`  ${r.count}× ${r.fp}   (starting ${r.startTs})`);
      }
    }

    // Unobservable calls — commands whose success/failure the trace could not
    // determine because they filtered their own output (see trace-hook.mjs).
    // Without this section a run with zero detected errors is ambiguous:
    // it either went perfectly or was simply not observable. Say which.
    const posts = events.filter((e) => e.event === 'tool_call' && e.phase === 'post');
    const unobservable = posts.filter((e) => e.output?.unobservable).length;
    if (unobservable > 0) {
      const totalErrs = [...errors.values()].reduce((a, b) => a + b, 0);
      const pct = Math.round((unobservable / posts.length) * 100);
      console.log('');
      console.log('Blind spots:');
      console.log(
        `  ${unobservable} of ${posts.length} tool results (${pct}%) could not be checked for failure —`
      );
      console.log(
        '  the command piped its output to a filter, which discards the exit code.'
      );
      console.log(
        `  ${totalErrs} error(s) were detected; an unknown number went unseen in the ${unobservable} above.`
      );
      console.log(
        '  Route quality gates through `run-gate.mjs` — it preserves the exit code'
      );
      console.log('  and emits a SPECSMITH_GATE sentinel the trace can read.');
    }

    // User interventions. Only present once UserPromptSubmit is wired (it was
    // missing from the installed hook set until v0.27.0), and the single most
    // useful thing when reconstructing why a long run went the way it did.
    const prompts = events.filter((e) => e.event === 'prompt');
    if (prompts.length) {
      console.log('');
      console.log(`User prompts (${prompts.length}):`);
      for (const p of prompts) {
        const text = (p.prompt || '').replace(/\s+/g, ' ').slice(0, 100);
        console.log(`  ${p.ts}  ${text}`);
      }
    }

    // Cycle markers — subagent_end / session_end events with token usage.
    //
    // Consecutive markers frequently carry byte-identical usage payloads:
    // `transcript_path` at SubagentStop points at the SESSION transcript, so
    // readUsageFromTranscript() re-reads whatever message was last rather than
    // the subagent's own final message. Collapse those repeats — printing the
    // same sample 11 times (as one audited run did) reads like activity.
    const stops = events.filter((e) => e.event === 'subagent_end' || e.event === 'session_end');
    const samples = [];
    let dupes = 0;
    let prevKey = null;
    for (const s of stops) {
      const key = JSON.stringify(s.usage || null);
      if (key !== 'null' && key === prevKey) { dupes++; continue; }
      prevKey = key;
      samples.push(s);
    }

    if (stops.length) {
      console.log('');
      console.log(
        `Stop markers: ${stops.length}` + (dupes ? `  (${dupes} repeated sample(s) suppressed)` : '')
      );
      for (const s of samples) {
        const u = s.usage || {};
        const inTok = u.input_tokens ?? '?';
        const outTok = u.output_tokens ?? '?';
        const cacheR = u.cache_read_input_tokens ?? 0;
        const cacheW = u.cache_creation_input_tokens ?? 0;
        const m = s.model || '?';
        console.log(
          `  ${s.event}  model=${m}  in=${inTok}  out=${outTok}  cache_r=${cacheR}  cache_w=${cacheW}  ts=${s.ts}`
        );
      }
    }

    // Token usage.
    //
    // These are SAMPLES of one request's usage taken at each stop marker, not
    // a complete per-request series, and cache_read/cache_write grow with the
    // conversation. Summing them across markers is meaningless — an audited
    // run reported cache_read=19,509,503 for a session whose largest single
    // sample was 400,177, an ~50x overstatement that made the digest useless
    // for cost reasoning. Report what the samples actually support.
    if (samples.length) {
      const val = (s, k) => (s.usage || {})[k] || 0;
      const last = samples[samples.length - 1];
      const peakR = Math.max(...samples.map((s) => val(s, 'cache_read_input_tokens')));
      const outSum = samples.reduce((a, s) => a + val(s, 'output_tokens'), 0);
      console.log('');
      console.log('Token usage (sampled at stop markers — not a billing total):');
      console.log(
        `  last sample:      in=${val(last, 'input_tokens')}  out=${val(last, 'output_tokens')}` +
        `  cache_read=${val(last, 'cache_read_input_tokens')}  cache_write=${val(last, 'cache_creation_input_tokens')}`
      );
      console.log(`  peak cache_read:  ${peakR}   (largest context carried in one request)`);
      console.log(`  output tokens across ${samples.length} distinct sample(s): ${outSum}`);
      console.log(
        '  cache_read/cache_write are per-request values that grow with the conversation;'
      );
      console.log('  they are not additive across markers, so no total is shown for them.');
    }
  }
}

const events = [];
for (const path of args) {
  events.push(...parseLines(path));
}
events.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
summarise(events);
