// Pure helpers for routes-to-diff.mjs. No I/O — every function takes
// plain data in and returns plain data out, so the test suite imports
// from here directly.
//
// Design: the evaluator wants to know "which routes do I need to re-diff
// for this cycle's changes?" The answer is a list, or the literal "*"
// meaning "test everything". We map every changed file to one of:
//   - a specific route (e.g. src/app/dashboard/page.tsx → /dashboard)
//   - "*" (global change: theme tokens, root layout, lib helpers, etc.)
// Union over all changed files. If ANY file resolves to "*", the whole
// scope is "*" — that's the safe conservative behaviour.
//
// A separate input is the prior-cycle failures: routes that failed in
// the previous pixel-diff.json or dom-diff.json. Those MUST be re-tested
// even if no related file changed (otherwise a stuck route silently
// drops out of coverage). The CLI merges both inputs.

const STAR = '*';

// Patterns whose change forces a "test all" verdict. These are global
// to any rendered route — there's no useful way to scope them.
const GLOBAL_PATTERNS = [
  // Root layout / globals.css / theme tokens — any rendered route depends.
  /^(?:src\/)?app\/layout\.(?:tsx|jsx|ts|js)$/,
  /^(?:src\/)?app\/globals\.css$/,
  /^(?:src\/)?app\/global\.css$/,
  // Tailwind / PostCSS / build configs.
  /^tailwind\.config\.(?:js|cjs|mjs|ts)$/,
  /^postcss\.config\.(?:js|cjs|mjs|ts)$/,
  /^next\.config\.(?:js|cjs|mjs|ts)$/,
  // package.json / lockfiles — dependency changes can affect anything.
  /^package(?:-lock)?\.json$/,
  /^pnpm-lock\.yaml$/,
  /^yarn\.lock$/,
];

// Shared-code patterns: not necessarily global, but we can't cheaply
// trace which routes use them. Conservative: treat as global. A future
// version could grep importers; for now the safe fallback wins.
const SHARED_CODE_PATTERNS = [
  /^src\/components\//,
  /^src\/lib\//,
  /^src\/hooks\//,
  /^src\/utils\//,
  /^components\//,
  /^lib\//,
  /^hooks\//,
  /^utils\//,
];

// App-dir route file (Next.js App Router): src/app/dashboard/page.tsx
// → /dashboard. Captures the segments BETWEEN `app/` and `/page.*`.
// Route groups `(group)` and parallel routes `@slot` are stripped from
// the URL — they're filesystem-only constructs. Parametric `[id]`
// segments are preserved verbatim so they can be matched by the
// pixelDiff.routeOverrides `[param]` wildcards.
const APP_ROUTE_RE = /^(?:src\/)?app\/(?:(.+)\/)?page\.(?:tsx|jsx|ts|js|mdx)$/;
// Pages-dir (Next.js classic): src/pages/dashboard.tsx → /dashboard.
// pages/index.tsx → /. pages/foo/bar.tsx → /foo/bar.
const PAGES_ROUTE_RE = /^(?:src\/)?pages\/(.*?)\.(?:tsx|jsx|ts|js|mdx)$/;
// route.ts / route.js (App Router API routes) — not relevant to visual
// diff, ignore by mapping to no route. Caller treats "no entries" as
// "this file doesn't affect the rendered output we diff against".

function segmentsToRoute(segments) {
  // Drop route groups `(marketing)` and parallel-route slots `@modal`.
  const visible = segments
    .split('/')
    .filter((s) => s && !s.startsWith('(') && !s.startsWith('@'));
  if (visible.length === 0) return '/';
  return '/' + visible.join('/');
}

// Pure: classify a changed file into one of four kinds, the richer signal
// behind mapFileToRoute. The CLI uses this to tell a *traceable shared*
// change (a component/hook/util whose importers we can follow to a small
// set of routes) apart from a *hard global* change (root layout, theme
// tokens, build config) that genuinely forces a full sweep.
//
// Returns one of:
//   { kind: 'route',      route: '/foo' }  — affects exactly that route
//   { kind: 'global' }                     — hard test-all; nothing to trace
//   { kind: 'shared',     file }           — shared code; trace its importers
//   { kind: 'irrelevant' }                 — docs/tests/scratch; contributes nothing
export function classifyFile(filePath) {
  if (typeof filePath !== 'string' || !filePath) return { kind: 'irrelevant' };
  // Normalise leading ./ and stray slashes.
  const f = filePath.replace(/^\.\//, '').replace(/^\/+/, '');

  // Irrelevant kinds.
  if (/\.test\.(?:tsx|jsx|ts|js)$/.test(f)) return { kind: 'irrelevant' };
  if (/\.stories\.(?:tsx|jsx|ts|js)$/.test(f)) return { kind: 'irrelevant' };
  if (f.startsWith('tests/') || f.startsWith('test/') || f.startsWith('__tests__/')) return { kind: 'irrelevant' };
  if (f.startsWith('specs/') || f.startsWith('docs/') || f.startsWith('pipeline/')) return { kind: 'irrelevant' };
  if (f.startsWith('.claude/') || f.startsWith('designs/')) return { kind: 'irrelevant' };
  if (f.endsWith('.md') || f.endsWith('.mdx')) {
    // .mdx as content can be a Next.js page — fall through to the route REs.
    if (!f.endsWith('.mdx')) return { kind: 'irrelevant' };
  }

  // Global / build-config patterns — no useful per-route scope.
  for (const re of GLOBAL_PATTERNS) {
    if (re.test(f)) return { kind: 'global' };
  }

  // App-router page file → exact route. The captured group is undefined
  // when matching the root `app/page.tsx`, in which case the route is `/`.
  const appMatch = f.match(APP_ROUTE_RE);
  if (appMatch) return { kind: 'route', route: segmentsToRoute(appMatch[1] || '') };

  // Pages-router file → exact route.
  const pagesMatch = f.match(PAGES_ROUTE_RE);
  if (pagesMatch) {
    const segments = pagesMatch[1];
    // pages/index → /, pages/foo/index → /foo
    const cleaned = segments.replace(/\/?index$/, '') || '';
    return { kind: 'route', route: cleaned ? '/' + cleaned : '/' };
  }

  // App-router layout / template / loading / error files: scope to the
  // segments they live under. A `src/app/(marketing)/dashboard/layout.tsx`
  // change affects /dashboard (and its children), not the whole app.
  const APP_SUBFILE_RE = /^(?:src\/)?app\/(.*?)\/(layout|template|loading|error|not-found)\.(?:tsx|jsx|ts|js)$/;
  const subMatch = f.match(APP_SUBFILE_RE);
  if (subMatch) return { kind: 'route', route: segmentsToRoute(subMatch[1]) };

  // Route handlers (route.ts) don't render — but they back data. Conservative:
  // scope to the parent route, not "*", since a data-fetch change tends to
  // show in one route's UI.
  const APP_ROUTE_HANDLER_RE = /^(?:src\/)?app\/(.*?)\/route\.(?:ts|js)$/;
  const handlerMatch = f.match(APP_ROUTE_HANDLER_RE);
  if (handlerMatch) return { kind: 'route', route: segmentsToRoute(handlerMatch[1]) };

  // Shared code (components/lib/hooks/utils) — not pinned to one route, but
  // its importers CAN be traced to the routes that render it. Hand back the
  // normalised path so the caller can feed the import-graph tracer.
  for (const re of SHARED_CODE_PATTERNS) {
    if (re.test(f)) return { kind: 'shared', file: f };
  }

  // Anything else under src/, app/ or pages/ that we don't recognise —
  // treat as shared/traceable rather than a hard global. If the tracer can't
  // place it, it degrades to test-all anyway.
  if (f.startsWith('src/') || f.startsWith('app/') || f.startsWith('pages/')) {
    return { kind: 'shared', file: f };
  }

  // Other top-level files: env, github actions, eslint configs, README,
  // etc. Don't affect the rendered output.
  return { kind: 'irrelevant' };
}

// Pure: given a single changed file path, return one of:
//   - { route: '/foo' }      — that file affects exactly one route
//   - { route: '*' }         — global / shared change; force "test all"
//   - null                   — file is irrelevant (route.ts handler,
//                              .md doc, test, etc.) — contributes nothing
// This is the path-only API: it has no project tree to trace importers
// against, so shared code conservatively collapses to "*". The CLI uses
// classifyFile + the import-graph tracer for the narrower answer.
export function mapFileToRoute(filePath) {
  const c = classifyFile(filePath);
  if (c.kind === 'route') return { route: c.route };
  if (c.kind === 'global' || c.kind === 'shared') return { route: STAR };
  return null;
}

// Pure: given a list of changed file paths, return the union of affected
// routes. Returns the literal `['*']` if any file resolves to "*".
export function mapFilesToRoutes(files) {
  if (!Array.isArray(files)) return [];
  const out = new Set();
  for (const f of files) {
    const r = mapFileToRoute(f);
    if (!r) continue;
    if (r.route === STAR) return [STAR];
    out.add(r.route);
  }
  return Array.from(out).sort();
}

// Pure: given prior pixel-diff.json and dom-diff.json payloads (either
// can be null), return the set of routes that failed in the prior cycle.
// These are added to the test scope regardless of file changes — a route
// that was failing last cycle MUST be re-verified even if nothing
// related changed, otherwise it silently drops out of coverage.
export function priorFailedRoutes(pixelPayload, domPayload) {
  const out = new Set();
  for (const payload of [pixelPayload, domPayload]) {
    if (!payload || !Array.isArray(payload.routes)) continue;
    for (const r of payload.routes) {
      if (r && r.verdict === 'fail' && typeof r.route === 'string') {
        out.add(r.route);
      }
    }
  }
  return Array.from(out).sort();
}

// Pure: merge file-derived routes and prior-failure routes. Returns
// either ['*'] (test all) or a deduped sorted list of explicit routes.
export function mergeScope(fileRoutes, failedRoutes) {
  if (Array.isArray(fileRoutes) && fileRoutes.includes(STAR)) return [STAR];
  const out = new Set();
  for (const r of fileRoutes || []) out.add(r);
  for (const r of failedRoutes || []) out.add(r);
  return Array.from(out).sort();
}
