// Pure import-graph helpers. No I/O: every function takes plain data in
// (a preloaded map of file → source, an alias table, a list of route
// roots) and returns plain data out. The I/O wrapper that reads files and
// parses tsconfig lives in lib/import-graph.mjs; the test suite imports
// THIS module directly with a synthetic in-memory file map.
//
// Purpose: answer "which rendered routes does a changed shared file (a
// component / hook / util) actually reach?" so routes-to-diff can scope
// the design-diff to those routes instead of conservatively diffing the
// whole app. The walk starts at route-root files (page/layout/...) and
// follows local imports transitively; a changed file maps to every root
// whose import closure contains it.
//
// Safety bias: when the graph cannot be trusted (a changed file isn't a
// known node, or a reachable file has an import we can't resolve to a
// local file), the tracer reports `incomplete: true`. The caller treats
// that as "fall back to test-all" — over-reporting incompleteness only
// costs extra diffing (today's behaviour), while under-reporting would
// silently drop a route from coverage.

// Source extensions we resolve, in priority order. A bare `./foo` import is
// tried as `./foo.<ext>` then `./foo/index.<ext>`.
const RESOLVE_EXTS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.mdx', '.json'];

// Strip line and block comments so commented-out imports don't pollute the
// specifier scan. Intentionally simple: it can mangle comment-like text
// inside string literals, but the only consumer is the import regex below,
// which tolerates the occasional false negative (a missed edge just makes
// the graph more conservative, never less).
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Extract the module specifiers a source file imports. Covers:
//   import x from 'spec'   |  import 'spec'   |  export … from 'spec'
//   import('spec')         |  require('spec')
// Returns { specifiers: string[], dynamicNonLiteral: boolean }. The flag is
// set when a dynamic import/require is called with a non-string-literal
// argument (e.g. `import(path)`) — the edge exists but we can't follow it,
// so the caller should treat the closure as incomplete.
export function parseImportSpecifiers(src) {
  if (typeof src !== 'string' || !src) return { specifiers: [], dynamicNonLiteral: false };
  const clean = stripComments(src);
  const specifiers = [];
  // Static `import …/export … from 'x'` and side-effect `import 'x'`.
  const staticRe = /(?:^|[\s;])(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g;
  const sideEffectRe = /(?:^|[\s;])import\s*['"]([^'"]+)['"]/g;
  // Dynamic import()/require() with a string literal.
  const dynamicRe = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  // Dynamic import()/require() with anything that is NOT an opening quote.
  const dynamicNonLiteralRe = /\b(?:import|require)\s*\(\s*(?!['"])/g;
  let m;
  while ((m = staticRe.exec(clean))) specifiers.push(m[1]);
  while ((m = sideEffectRe.exec(clean))) specifiers.push(m[1]);
  while ((m = dynamicRe.exec(clean))) specifiers.push(m[1]);
  const dynamicNonLiteral = dynamicNonLiteralRe.test(clean);
  return { specifiers, dynamicNonLiteral };
}

// Normalise a path to repo-relative POSIX form without a leading `./`.
export function normalisePath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

// Join + collapse `.`/`..` segments for a POSIX-style relative path. Used to
// resolve `../foo` against the importing file's directory.
function posixJoin(fromDir, rel) {
  const parts = (fromDir ? fromDir.split('/') : []).concat(rel.split('/'));
  const out = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

// Try a base path against the known file set: exact, then with each source
// extension, then as a directory barrel (base/index.<ext>). Returns the
// matched node path or null.
function tryResolveBase(base, fileSet) {
  if (fileSet.has(base)) return base;
  for (const ext of RESOLVE_EXTS) {
    if (fileSet.has(base + ext)) return base + ext;
  }
  for (const ext of RESOLVE_EXTS) {
    if (fileSet.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
  }
  return null;
}

// Expand a tsconfig-style alias specifier (e.g. `@/components/Card`) into the
// candidate base paths it could map to, using the alias table. Each alias is
// { prefix, targets } where prefix may end in `/*` and targets may contain
// `*`. Returns an array of repo-relative base paths (no extension).
function aliasCandidates(spec, aliases) {
  const out = [];
  for (const { prefix, targets } of aliases || []) {
    if (prefix.endsWith('/*')) {
      const head = prefix.slice(0, -1); // keep trailing '/'
      if (!spec.startsWith(head)) continue;
      const rest = spec.slice(head.length);
      for (const t of targets) out.push(normalisePath(t.replace(/\*/g, rest)));
    } else if (prefix === spec) {
      for (const t of targets) out.push(normalisePath(t.replace(/\*/g, '')));
    }
  }
  return out;
}

// Resolve a single import specifier from `fromFile` to a node in `fileSet`.
// Returns { node } when it resolves to a known local file, { external: true }
// for bare/package specifiers we intentionally don't follow, or
// { unresolved: true } when a relative/alias specifier SHOULD have resolved
// to a local file but didn't (a missing or mistyped path, or a file outside
// the scanned source roots).
export function resolveSpecifier(spec, fromFile, aliases, fileSet) {
  if (!spec) return { external: true };
  const fromDir = normalisePath(fromFile).split('/').slice(0, -1).join('/');

  // Relative import → resolve against the importing file's directory.
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const base = posixJoin(fromDir, spec);
    const node = tryResolveBase(base, fileSet);
    return node ? { node } : { unresolved: true };
  }

  // Alias import → try every tsconfig path mapping.
  const candidates = aliasCandidates(spec, aliases);
  if (candidates.length) {
    for (const base of candidates) {
      const node = tryResolveBase(base, fileSet);
      if (node) return { node };
    }
    return { unresolved: true };
  }

  // Bare specifier (react, next/link, lodash, …) — external dependency we
  // don't traverse. Not a gap in our graph, so not "unresolved".
  return { external: true };
}

// Build a forward adjacency map (file → resolved local import nodes) over the
// whole fileMap, recording which files carry an edge we couldn't follow.
// Returns { adjacency: Map, unresolvedFiles: Set }.
function buildAdjacency(fileMap, aliases) {
  const fileSet = new Set(fileMap.keys());
  const adjacency = new Map();
  const unresolvedFiles = new Set();
  for (const [file, src] of fileMap) {
    const { specifiers, dynamicNonLiteral } = parseImportSpecifiers(src);
    const edges = [];
    let unresolved = dynamicNonLiteral;
    for (const spec of specifiers) {
      const r = resolveSpecifier(spec, file, aliases, fileSet);
      if (r.node) edges.push(r.node);
      else if (r.unresolved) unresolved = true;
    }
    adjacency.set(file, edges);
    if (unresolved) unresolvedFiles.add(file);
  }
  return { adjacency, unresolvedFiles };
}

// BFS the import closure of a single root file over the adjacency map.
function reachableFrom(root, adjacency) {
  const seen = new Set([root]);
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    for (const next of adjacency.get(cur) || []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

// Trace which route roots reach the changed files.
//
//   fileMap : Map<repoRelPath, source>  — every scanned source file
//   aliases : [{ prefix, targets }]     — tsconfig path mappings
//   roots   : [{ file, route }]         — route-root files and their routes
//   changed : string[]                  — the shared files to trace
//
// Returns { routes: string[] (sorted, deduped), incomplete: boolean }.
// `incomplete` is set (→ caller falls back to test-all) when any changed
// file is not a known node, or any file reachable from a root carries an
// import edge we couldn't resolve.
export function traceRoutes({ fileMap, aliases, roots, changed }) {
  const changedSet = new Set((changed || []).map(normalisePath));
  if (!changedSet.size) return { routes: [], incomplete: false };

  // A changed file we never scanned (outside source roots, deleted, etc.)
  // can't be placed in the graph → can't be trusted → test-all.
  for (const c of changedSet) {
    if (!fileMap.has(c)) return { routes: [], incomplete: true };
  }

  const { adjacency, unresolvedFiles } = buildAdjacency(fileMap, aliases);
  const routes = new Set();
  const reachableUnion = new Set();
  for (const { file, route } of roots || []) {
    const node = normalisePath(file);
    if (!fileMap.has(node)) continue;
    const reach = reachableFrom(node, adjacency);
    for (const f of reach) reachableUnion.add(f);
    for (const c of changedSet) {
      if (reach.has(c)) { routes.add(route); break; }
    }
  }

  // If any file we actually walked has an unfollowable edge, the closures
  // above may be missing routes — degrade to test-all.
  let incomplete = false;
  for (const f of reachableUnion) {
    if (unresolvedFiles.has(f)) { incomplete = true; break; }
  }

  return { routes: Array.from(routes).sort(), incomplete };
}
