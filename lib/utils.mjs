import {
  existsSync,
  mkdirSync,
  copyFileSync,
  cpSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// All installable source files live at the package root (agents/, skills/,
// scripts/, templates/, launch.json). Everything is copied into .claude/
// (or merged into project files) by the installer.
const __dirname = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(__dirname, '..');

/**
 * SHA-256 hex digest of a string or Buffer. Shared by the manifest generator,
 * the updater's package-vs-disk diff, and the verifier so the three never
 * drift. `createHash().update()` accepts both string and Buffer.
 */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

// Logging helpers
export const log = {
  info:    (msg) => console.log(`  INFO: ${msg}`),
  success: (msg) => console.log(`  ✓ ${msg}`),
  skip:    (msg) => console.log(`  → ${msg}`),
  dry:     (msg) => console.log(`  [dry-run] Would install: ${msg}`),
  warn:    (msg) => console.log(`  ⚠ ${msg}`),
  error:   (msg) => console.error(`  ERROR: ${msg}`),
};

/**
 * Copy a single file from src (absolute) to destRelative (relative to projectRoot).
 * Returns 'installed' | 'skipped' | 'dry-run'.
 */
export function installFile(src, destRelative, projectRoot, { dryRun, force }) {
  const dest = join(projectRoot, destRelative);

  if (dryRun) {
    log.dry(destRelative);
    return 'dry-run';
  }

  if (existsSync(dest) && !force) {
    log.skip(`${destRelative} (already exists, use --force to overwrite)`);
    return 'skipped';
  }

  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  log.success(destRelative);
  return 'installed';
}

/**
 * Recursively copy a source directory to destRelative (relative to projectRoot).
 * Used for skills (which bundle templates/) and other multi-file artifacts.
 * If the destination dir exists and !force, skip the whole directory.
 */
export function installDir(src, destRelative, projectRoot, { dryRun, force }) {
  const dest = join(projectRoot, destRelative);

  if (dryRun) {
    log.dry(`${destRelative}/ (recursive)`);
    return 'dry-run';
  }

  if (existsSync(dest) && !force) {
    log.skip(`${destRelative}/ (already exists, use --force to overwrite)`);
    return 'skipped';
  }

  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  log.success(`${destRelative}/`);
  return 'installed';
}

/**
 * List entries in a package directory matching a predicate.
 * Returns sorted names (so manifests are stable across installs).
 * Always skips dotfiles (e.g. .DS_Store) to avoid leaking junk into host
 * projects.
 */
function listDir(name, predicate) {
  const dir = join(PACKAGE_ROOT, name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => !entry.startsWith('.') && predicate(join(dir, entry), entry))
    .sort();
}

export function listAgents() {
  return listDir('agents', (p, name) => statSync(p).isFile() && name.endsWith('.md'));
}

export function listSkills() {
  return listDir('skills', (p) => statSync(p).isDirectory());
}

export function listScripts() {
  return listDir('scripts', (p, name) => statSync(p).isFile() && name.endsWith('.mjs'));
}

/**
 * Walk a directory and yield every file's path relative to PACKAGE_ROOT.
 * Skips dotfiles and dot-directories so junk (e.g. .DS_Store) never
 * propagates into host projects.
 */
function* walkFiles(absDir) {
  for (const entry of readdirSync(absDir)) {
    if (entry.startsWith('.')) continue;
    const full = join(absDir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walkFiles(full);
    } else if (stat.isFile()) {
      yield relative(PACKAGE_ROOT, full);
    }
  }
}

/**
 * Build a flat install plan: every file we ship maps to a destination path
 * relative to projectRoot. Used by the installer (to copy), manifest
 * generator (to checksum), and updater (to diff).
 *
 * Skill directories are walked recursively so bundled templates and other
 * sibling files (e.g. skills/plan/templates/plan.md) are tracked.
 */
export function buildInstallPlan() {
  const plan = [];

  for (const name of listAgents()) {
    plan.push({
      kind: 'file',
      src: join('agents', name),
      dest: join('.claude', 'agents', name),
    });
  }

  for (const skill of listSkills()) {
    const dir = join(PACKAGE_ROOT, 'skills', skill);
    for (const rel of walkFiles(dir)) {
      // rel is e.g. "skills/plan/templates/plan.md"
      plan.push({
        kind: 'file',
        src: rel,
        dest: join('.claude', rel),
      });
    }
  }

  // Walk references/ recursively. These are progressive-disclosure documents
  // that agent files link to by path instead of inlining — the pattern
  // CLAUDE.md already mandates for skill templates.
  //
  // They install under `.claude/specsmith/`, deliberately NOT under
  // `.claude/agents/`: everything in that directory is a subagent definition,
  // and a reference doc dropped there would be picked up as a (frontmatter-
  // less) agent. `listAgents()` is also non-recursive, so they would not ship
  // at all from `agents/references/`.
  const refsDir = join(PACKAGE_ROOT, 'references');
  if (existsSync(refsDir)) {
    for (const rel of walkFiles(refsDir)) {
      // rel is e.g. "references/coding-pitfalls.md"
      plan.push({
        kind: 'file',
        src: rel,
        dest: join('.claude', 'specsmith', rel),
      });
    }
  }

  // Walk scripts/ recursively so nested helpers like scripts/lib/*.mjs ship.
  const scriptsDir = join(PACKAGE_ROOT, 'scripts');
  if (existsSync(scriptsDir)) {
    for (const rel of walkFiles(scriptsDir)) {
      // rel is e.g. "scripts/lib/trace-path.mjs"
      if (!rel.endsWith('.mjs')) continue;
      plan.push({
        kind: 'file',
        src: rel,
        dest: join('.claude', rel),
      });
    }
  }

  return plan;
}
