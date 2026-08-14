#!/usr/bin/env node
// Tests for lib/installer.mjs + lib/manifest.mjs + lib/utils.mjs#buildInstallPlan
// — the `npx specsmith init` path, which is what downstream users actually run
// and which had no test coverage at all.
//
// The install plan is dynamic (it walks agents/, skills/, scripts/,
// references/), so these tests assert the CONTRACT rather than a file list:
// every planned file is installed, the manifest checksums match what landed
// on disk, and re-running init changes nothing.
//
// Run with: `node tests/installer.test.mjs` or `npm test`.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { install } from '../lib/installer.mjs';
import { generateManifest, MANIFEST_PATH } from '../lib/manifest.mjs';
import { buildInstallPlan, PACKAGE_ROOT } from '../lib/utils.mjs';

let failures = 0;

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
  else { console.log(`ok   ${msg}`); }
}

// install() narrates to stdout; silence it so test output stays readable.
async function quiet(fn) {
  const realLog = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = realLog; }
}

function makeProject() {
  return mkdtempSync(join(tmpdir(), 'specsmith-init-'));
}

const OPTS = { dryRun: false, force: false, conventions: false };

// ── Case 1: every file in the install plan actually lands on disk ──
// The plan is built by walking the package; the installer filters it by
// destination prefix. A new top-level category with no matching filter would
// be planned and silently never copied — which is exactly what happened when
// references/ was introduced.
{
  const root = makeProject();
  await quiet(() => install(root, OPTS));

  const plan = buildInstallPlan();
  const missing = plan.filter((item) => !existsSync(join(root, item.dest)));
  assert(plan.length > 0, `install plan is non-empty (${plan.length} files)`);
  assert(
    missing.length === 0,
    missing.length === 0
      ? 'every planned file is installed'
      : `every planned file is installed — missing: ${missing.map((m) => m.dest).join(', ')}`
  );
  rmSync(root, { recursive: true, force: true });
}

// ── Case 2: installed content is byte-identical to the package source ──
{
  const root = makeProject();
  await quiet(() => install(root, OPTS));

  const plan = buildInstallPlan();
  const differing = plan.filter((item) => {
    const src = readFileSync(join(PACKAGE_ROOT, item.src));
    const dst = readFileSync(join(root, item.dest));
    return !src.equals(dst);
  });
  assert(differing.length === 0, 'installed files are byte-identical to the package source');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 3: reference docs go to .claude/specsmith/, NOT .claude/agents/ ──
// Everything under .claude/agents/ is loaded as a subagent definition, so a
// frontmatter-less reference doc there would register as a broken agent.
{
  const root = makeProject();
  await quiet(() => install(root, OPTS));

  const agentFiles = readdirSync(join(root, '.claude', 'agents'));
  assert(
    agentFiles.every((f) => f.endsWith('.md')),
    'only .md files land in .claude/agents/'
  );
  assert(
    !agentFiles.includes('references'),
    'reference docs are NOT placed under .claude/agents/'
  );

  const refDir = join(root, '.claude', 'specsmith', 'references');
  assert(existsSync(refDir), 'reference docs install under .claude/specsmith/references/');
  assert(readdirSync(refDir).length > 0, 'at least one reference doc shipped');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 4: the manifest checksums match the bytes actually on disk ──
// `update` decides "user-modified vs upgradable" from these hashes; if they
// were computed from the wrong bytes it would silently clobber user edits.
{
  const root = makeProject();
  await quiet(() => install(root, OPTS));
  await quiet(() => generateManifest(root, { dryRun: false }));

  const manifest = JSON.parse(readFileSync(join(root, MANIFEST_PATH), 'utf8'));
  assert(manifest.package === 'specsmith', 'manifest records the package name');
  assert(typeof manifest.version === 'string' && manifest.version.length > 0, 'manifest records a version');

  const entries = Object.entries(manifest.files);
  assert(entries.length > 0, `manifest tracks the installed files (${entries.length})`);

  const bad = entries.filter(([dest, hash]) => {
    const full = join(root, dest);
    if (!existsSync(full)) return true;
    return createHash('sha256').update(readFileSync(full)).digest('hex') !== hash;
  });
  assert(bad.length === 0, 'every manifest checksum matches the file on disk');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 5: user-owned seed files are NOT tracked in the manifest ──
// The constitution and glossary are seeded once and owned by the team; if
// `update` tracked them it would offer to overwrite their content.
{
  const root = makeProject();
  await quiet(() => install(root, OPTS));
  await quiet(() => generateManifest(root, { dryRun: false }));
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST_PATH), 'utf8'));

  assert(
    existsSync(join(root, '.claude', 'constitution.md')),
    'the constitution starter is installed'
  );
  assert(
    !(join('.claude', 'constitution.md') in manifest.files),
    'the constitution is NOT manifest-tracked (user-owned)'
  );
  assert(
    existsSync(join(root, 'specs', 'glossary.md')),
    'the glossary starter is installed'
  );
  assert(
    !(join('specs', 'glossary.md') in manifest.files),
    'the glossary is NOT manifest-tracked (user-owned)'
  );
  rmSync(root, { recursive: true, force: true });
}

// ── Case 6: init is idempotent — a second run changes nothing ──
{
  const root = makeProject();
  await quiet(() => install(root, OPTS));
  await quiet(() => generateManifest(root, { dryRun: false }));
  const first = JSON.parse(readFileSync(join(root, MANIFEST_PATH), 'utf8')).files;

  await quiet(() => install(root, OPTS));
  await quiet(() => generateManifest(root, { dryRun: false }));
  const second = JSON.parse(readFileSync(join(root, MANIFEST_PATH), 'utf8')).files;

  assert(
    JSON.stringify(first) === JSON.stringify(second),
    'a second init produces an identical manifest'
  );
  rmSync(root, { recursive: true, force: true });
}

// ── Case 7: init does not overwrite a user-edited constitution ──
{
  const root = makeProject();
  await quiet(() => install(root, OPTS));
  const constitution = join(root, '.claude', 'constitution.md');
  writeFileSync(constitution, '# Our own rules\n');

  await quiet(() => install(root, OPTS));
  assert(
    readFileSync(constitution, 'utf8') === '# Our own rules\n',
    'a user-edited constitution survives a re-run of init'
  );
  rmSync(root, { recursive: true, force: true });
}

// ── Case 8: --dry-run writes nothing at all ──
{
  const root = makeProject();
  mkdirSync(join(root, '.claude'), { recursive: true });
  await quiet(() => install(root, { ...OPTS, dryRun: true }));

  assert(
    !existsSync(join(root, '.claude', 'agents')),
    'dry-run installs no agents'
  );
  assert(
    !existsSync(join(root, '.claude', 'settings.json')),
    'dry-run writes no settings.json'
  );
  rmSync(root, { recursive: true, force: true });
}

// ── Case 9: the hook scripts the settings reference are actually installed ──
// A hook wired in settings.json but missing on disk fails silently on every
// tool call.
{
  const root = makeProject();
  await quiet(() => install(root, OPTS));
  const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));

  const commands = Object.values(settings.hooks || {})
    .flat()
    .flatMap((g) => (g.hooks || []).map((h) => h.command));

  const missing = [];
  for (const cmd of new Set(commands)) {
    const m = cmd.match(/\.claude\/(scripts\/[\w./-]+)/);
    if (!m) continue;
    if (!existsSync(join(root, '.claude', m[1]))) missing.push(m[1]);
  }
  assert(
    missing.length === 0,
    missing.length === 0
      ? 'every hook script referenced by settings.json is installed'
      : `every hook script referenced by settings.json is installed — missing: ${missing.join(', ')}`
  );
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
