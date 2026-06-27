// I/O wrapper around import-graph-lib.mjs. Reads the project's source tree
// and tsconfig path aliases, then calls the pure tracer to answer "which
// routes do these changed shared files reach?". Kept separate from the pure
// lib so the tracer stays unit-testable with a synthetic file map.
//
// Everything here is best-effort and defensive: any read/parse failure
// degrades to { routes: [], incomplete: true }, which the caller reads as
// "can't trust the graph, fall back to test-all". A crash here must never
// take down routes-to-diff / pixel-diff / dom-diff.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { traceRoutes, normalisePath } from '../import-graph-lib.mjs';
import { mapFileToRoute } from '../routes-to-diff-lib.mjs';

// Directories that hold renderable source. We only walk these — never
// node_modules, build output, or the pipeline/designs/specs scratch dirs.
const SOURCE_ROOTS = ['src', 'app', 'pages', 'components', 'lib', 'hooks', 'utils'];
const SKIP_DIRS = new Set([
  'node_modules', '.next', '.git', 'dist', 'build', 'out', 'coverage',
  '.turbo', '.vercel', 'designs', 'specs', 'pipeline', 'tests', '__tests__',
]);
const SOURCE_EXT_RE = /\.(?:tsx|ts|jsx|js|mjs|cjs|mdx)$/;
// Route-root files whose import closure defines what a route renders.
const ROOT_FILE_RE =
  /^(?:src\/)?(?:app\/(?:.+\/)?(?:page|layout|template|loading|error|not-found)\.(?:tsx|jsx|ts|js|mdx)|pages\/(?!api\/).+\.(?:tsx|jsx|ts|js|mdx))$/;

// Strip // and /* */ comments and trailing commas so tsconfig JSONC parses.
function parseJsonc(text) {
  const noComments = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const noTrailingCommas = noComments.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(noTrailingCommas);
}

// Read tsconfig/jsconfig path aliases into the [{ prefix, targets }] shape the
// pure resolver expects. baseUrl is folded into each target so the targets are
// repo-relative. Returns [] when there's no config or no `paths`.
export function loadAliases(cwd) {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const p = join(cwd, name);
    if (!existsSync(p)) continue;
    let cfg;
    try { cfg = parseJsonc(readFileSync(p, 'utf8')); } catch { return []; }
    const co = cfg?.compilerOptions || {};
    const baseUrl = (co.baseUrl || '.').replace(/^\.\/?/, '');
    const paths = co.paths || {};
    const aliases = [];
    for (const [prefix, targets] of Object.entries(paths)) {
      if (!Array.isArray(targets)) continue;
      const rebased = targets.map((t) => normalisePath(baseUrl ? `${baseUrl}/${t}` : t));
      aliases.push({ prefix, targets: rebased });
    }
    return aliases;
  }
  return [];
}

// Recursively collect repo-relative source-file paths under a directory.
function walk(dir, cwd, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ent.name.startsWith('.') && ent.name !== '.') continue;
    if (SKIP_DIRS.has(ent.name)) continue;
    const abs = join(dir, ent.name);
    let isDir = ent.isDirectory();
    if (ent.isSymbolicLink && ent.isSymbolicLink()) {
      try { isDir = statSync(abs).isDirectory(); } catch { continue; }
    }
    if (isDir) walk(abs, cwd, out);
    else if (SOURCE_EXT_RE.test(ent.name)) out.push(normalisePath(relative(cwd, abs)));
  }
}

// Build the Map<repoRelPath, source> over all source roots that exist.
export function collectSourceFiles(cwd) {
  const paths = [];
  for (const root of SOURCE_ROOTS) {
    const abs = join(cwd, root);
    if (existsSync(abs)) walk(abs, cwd, paths);
  }
  const fileMap = new Map();
  for (const rel of paths) {
    try { fileMap.set(rel, readFileSync(join(cwd, rel), 'utf8')); } catch {}
  }
  return fileMap;
}

// From the collected files, pick the route-root files and resolve each to its
// route via the shared path→route mapper. A root layout maps to '*' (it backs
// every route); nested layouts/pages map to their segment.
export function discoverRouteRoots(fileMap) {
  const roots = [];
  for (const file of fileMap.keys()) {
    if (!ROOT_FILE_RE.test(file)) continue;
    const mapped = mapFileToRoute(file);
    if (mapped && typeof mapped.route === 'string') {
      roots.push({ file, route: mapped.route });
    }
  }
  return roots;
}

// Top-level entry: trace the given changed shared files to the routes that
// render them. Returns { routes, incomplete }. Defensive — any failure or an
// empty/rootless project degrades to incomplete so the caller tests all.
export function traceSharedFiles(cwd, changedSharedFiles) {
  if (!changedSharedFiles || !changedSharedFiles.length) {
    return { routes: [], incomplete: false };
  }
  try {
    const fileMap = collectSourceFiles(cwd);
    if (!fileMap.size) return { routes: [], incomplete: true };
    const roots = discoverRouteRoots(fileMap);
    if (!roots.length) return { routes: [], incomplete: true };
    const aliases = loadAliases(cwd);
    return traceRoutes({ fileMap, aliases, roots, changed: changedSharedFiles });
  } catch {
    return { routes: [], incomplete: true };
  }
}
