#!/usr/bin/env node
// Report the current state of a spec folder: which identifiers are taken,
// which phases still have unchecked work, what the last /build run left
// unresolved, and which open questions are still open.
//
// `/extend-spec` calls this before amending anything. Without it the skill
// would hand-roll a pile of grep/awk over prd.md, tasks.md, build-log.md and
// pipeline/feedback/*.md — the exact pattern that produced silently-empty
// output when an inline awk got mangled (see the header of phase-block.mjs).
//
// Two things here are correctness-critical rather than convenience:
//
//   - **Next free identifier.** `FR-###` / `NFR-###` / `SC-###` / `OQ-###` are
//     append-only and must never be renumbered (CLAUDE.md, "Numbering is
//     stable"). Guessing the next number by eye is how a spec ends up with two
//     FR-014s, and every downstream reference — tasks, feedback, carryovers —
//     silently points at the wrong one.
//   - **Next free phase number.** `phase-block.mjs` anchors on `## Phase N:`,
//     so a duplicate or skipped number breaks /build's dispatch.
//
// Usage:
//   node .claude/scripts/spec-status.mjs [<spec-folder>] [--json]
//
// With no folder, derives it from the current git branch (the `NNN-<slug>`
// convention every pipeline skill uses).
//
// Exit codes:
//   0  report printed
//   1  spec folder could not be resolved or has no prd.md

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const ID_PREFIXES = ['FR', 'NFR', 'SC', 'OQ'];
const PHASE_RE = /^##\s+Phase\s+(\d+)\s*:\s*(.*)$/;

function fail(msg) {
  process.stderr.write(`spec-status: ${msg}\n`);
  process.exit(1);
}

function read(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

// ── Spec folder resolution ───────────────────────────────────────────────

function branchSpecFolder(cwd) {
  let branch;
  try {
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
  if (!/^\d{3}-/.test(branch)) return null;
  const candidate = join('specs', branch);
  return existsSync(resolve(cwd, candidate)) ? candidate : null;
}

// ── Identifiers ──────────────────────────────────────────────────────────

// Highest number used per prefix, across the whole PRD — not just the
// definition sections, so a requirement referenced from Edge cases or a
// success criterion still counts as taken.
function highestIds(prd) {
  const out = {};
  for (const p of ID_PREFIXES) out[p] = 0;
  if (!prd) return out;
  const re = /\b(NFR|FR|SC|OQ)-(\d+)\b/g;
  let m;
  while ((m = re.exec(prd)) !== null) {
    const n = Number.parseInt(m[2], 10);
    if (Number.isFinite(n) && n > out[m[1]]) out[m[1]] = n;
  }
  return out;
}

function pad(n) {
  return String(n).padStart(3, '0');
}

// ── Open questions ───────────────────────────────────────────────────────

// An OQ counts as resolved when its line is a ticked checkbox or says
// "Resolved". Everything else in the Open questions section is still open —
// and /plan refuses to run while any remain.
function openQuestions(prd) {
  if (!prd) return [];
  const lines = prd.split('\n');
  const start = lines.findIndex((l) => /^##\s+Open questions\s*$/i.test(l));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^##\s/.test(l)) break;
    if (!/OQ-\d+/.test(l)) continue;
    if (/^-\s*\[x\]/i.test(l.trim()) || /\bresolved\b/i.test(l)) continue;
    out.push(l.trim());
  }
  return out;
}

// ── Phases ───────────────────────────────────────────────────────────────

function phases(tasks) {
  if (!tasks) return [];
  const out = [];
  let cur = null;
  for (const line of tasks.split('\n')) {
    const m = PHASE_RE.exec(line);
    if (m) {
      cur = { num: Number.parseInt(m[1], 10), name: m[2].trim(), done: 0, open: 0, openTasks: [] };
      out.push(cur);
      continue;
    }
    if (/^##\s/.test(line)) { cur = null; continue; }
    if (!cur) continue;
    if (/^- \[x\]/i.test(line)) cur.done++;
    else if (/^- \[ \]/.test(line)) { cur.open++; cur.openTasks.push(line.trim()); }
  }
  return out;
}

// ── Last build run ───────────────────────────────────────────────────────

// Carryovers from the highest cycle of each phase's feedback file. These are
// the evaluator's operational contract with the next developer cycle; if the
// build ended with any still unticked, they are exactly the work /extend-spec
// should fold into the amendment.
function carryovers(cwd) {
  const dir = resolve(cwd, 'pipeline', 'feedback');
  if (!existsSync(dir)) return [];
  let files;
  try { files = readdirSync(dir); } catch { return []; }

  const latest = new Map(); // phase -> {cycle, file}
  for (const f of files) {
    const m = /^phase-(\d+)-cycle-(\d+)\.md$/.exec(f);
    if (!m) continue;
    const phase = Number.parseInt(m[1], 10);
    const cycle = Number.parseInt(m[2], 10);
    const prev = latest.get(phase);
    if (!prev || cycle > prev.cycle) latest.set(phase, { cycle, file: f });
  }

  const out = [];
  for (const [phase, { cycle, file }] of [...latest.entries()].sort((a, b) => a[0] - b[0])) {
    const text = read(join(dir, file));
    if (!text) continue;
    const lines = text.split('\n');
    const start = lines.findIndex((l) => /^##\s+Carryovers\b/i.test(l));
    if (start === -1) continue;
    const items = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) break;
      if (/^- \[ \]/.test(lines[i].trim())) items.push(lines[i].trim());
    }
    if (items.length) out.push({ phase, cycle, file: `pipeline/feedback/${file}`, items });
  }
  return out;
}

// Last recorded verdict per phase, plus any BLOCKED reason.
function buildLog(cwd) {
  const text = read(resolve(cwd, 'pipeline', 'build-log.md'));
  if (!text) return [];
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const h = /^Phase\s+(\d+)\s+—\s+Cycle\s+(\d+)/.exec(line.trim());
    if (h) {
      cur = { phase: Number.parseInt(h[1], 10), cycle: Number.parseInt(h[2], 10), verdict: null };
      out.push(cur);
      continue;
    }
    if (cur && /^Verdict:/i.test(line.trim())) cur.verdict = line.trim().replace(/^Verdict:\s*/i, '');
  }
  // Keep only the highest cycle per phase.
  const byPhase = new Map();
  for (const e of out) {
    const prev = byPhase.get(e.phase);
    if (!prev || e.cycle > prev.cycle) byPhase.set(e.phase, e);
  }
  return [...byPhase.values()].sort((a, b) => a.phase - b.phase);
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const positional = args.filter((a) => !a.startsWith('--'));
  const cwd = process.cwd();

  const folder = positional[0] || branchSpecFolder(cwd);
  if (!folder) {
    fail(
      'could not resolve a spec folder. Pass one explicitly ' +
      '(`spec-status.mjs specs/012-my-feature`) or check out the feature branch.'
    );
  }
  const root = resolve(cwd, folder);
  const prd = read(join(root, 'prd.md'));
  if (prd === null) fail(`${folder}/prd.md not found`);

  const tasks = read(join(root, 'tasks.md'));
  const ph = phases(tasks);
  const ids = highestIds(prd);
  const oq = openQuestions(prd);
  const carry = carryovers(cwd);
  const log = buildLog(cwd);

  const nextPhase = ph.length ? Math.max(...ph.map((p) => p.num)) + 1 : 1;
  const totalOpen = ph.reduce((a, p) => a + p.open, 0);

  const report = {
    spec: folder,
    hasTasks: tasks !== null,
    nextIds: Object.fromEntries(ID_PREFIXES.map((p) => [p, `${p}-${pad(ids[p] + 1)}`])),
    nextPhase,
    phases: ph.map(({ openTasks, ...rest }) => rest),
    openTasks: ph.flatMap((p) => p.openTasks.map((t) => ({ phase: p.num, task: t }))),
    openQuestions: oq,
    carryovers: carry,
    buildLog: log,
  };

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  const w = (s = '') => process.stdout.write(s + '\n');

  w(`Spec: ${folder}`);
  w();
  w('Next free identifiers (append-only — never renumber existing ones):');
  w('  ' + ID_PREFIXES.map((p) => report.nextIds[p]).join('   '));
  w();

  if (!report.hasTasks) {
    w('tasks.md: MISSING — run /tasks before extending.');
  } else if (!ph.length) {
    w('tasks.md: present but contains no `## Phase N:` headings.');
  } else {
    w(`Phases: ${ph.length}   (next free phase number: ${nextPhase})`);
    for (const p of ph) {
      const total = p.done + p.open;
      const flag = p.open ? `  ${p.open} UNCHECKED` : '';
      w(`  Phase ${p.num}: ${p.name}`.padEnd(44) + `${p.done}/${total} done${flag}`);
    }
    w();
    w(totalOpen ? `Unchecked tasks: ${totalOpen}` : 'Unchecked tasks: none — every phase is complete.');
    for (const { phase, task } of report.openTasks) w(`  [Phase ${phase}] ${task}`);
  }

  if (log.length) {
    w();
    w('Last verdict per phase (pipeline/build-log.md):');
    for (const e of log) w(`  Phase ${e.phase} (cycle ${e.cycle}): ${e.verdict || '(no verdict line)'}`);
  }

  if (carry.length) {
    w();
    w('Unresolved carryovers from the last build:');
    for (const c of carry) {
      w(`  ${c.file} (phase ${c.phase}, cycle ${c.cycle}):`);
      for (const i of c.items) w(`    ${i}`);
    }
  } else {
    w();
    w('Unresolved carryovers: none found.');
    w('  (pipeline/feedback/ is wiped at the start of every /build run — if a build');
    w('   has already re-run since, the evidence is gone. Extend before rebuilding.)');
  }

  if (oq.length) {
    w();
    w('Open questions still unresolved in prd.md (these block /plan):');
    for (const q of oq) w(`  ${q}`);
  }
}

main();
