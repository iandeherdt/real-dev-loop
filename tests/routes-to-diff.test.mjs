// Tests the pure helpers in routes-to-diff-lib.mjs. The git-diff side of
// the CLI script is left for the user's smoke test — it shells out to
// git, which doesn't make for a deterministic unit test.

import assert from 'node:assert';
import {
  classifyFile,
  mapFileToRoute,
  mapFilesToRoutes,
  priorFailedRoutes,
  mergeScope,
} from '../scripts/routes-to-diff-lib.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
    passed++;
  } catch (err) {
    console.log(`FAIL ${name}`);
    console.log(`     ${err.message}`);
    failed++;
  }
}

// ─── mapFileToRoute: app-router pages ─────────────────────────────────

test('mapFileToRoute: src/app/dashboard/page.tsx → /dashboard', () => {
  assert.deepStrictEqual(mapFileToRoute('src/app/dashboard/page.tsx'), { route: '/dashboard' });
});

test('mapFileToRoute: app/dashboard/page.tsx (no src/) → /dashboard', () => {
  assert.deepStrictEqual(mapFileToRoute('app/dashboard/page.tsx'), { route: '/dashboard' });
});

test('mapFileToRoute: nested route src/app/contracts/[id]/periods/page.tsx → /contracts/[id]/periods', () => {
  assert.deepStrictEqual(
    mapFileToRoute('src/app/contracts/[id]/periods/page.tsx'),
    { route: '/contracts/[id]/periods' }
  );
});

test('mapFileToRoute: route group (marketing)/about → /about (group stripped)', () => {
  assert.deepStrictEqual(
    mapFileToRoute('src/app/(marketing)/about/page.tsx'),
    { route: '/about' }
  );
});

test('mapFileToRoute: parallel slot @modal stripped from URL', () => {
  assert.deepStrictEqual(
    mapFileToRoute('src/app/dashboard/@modal/login/page.tsx'),
    { route: '/dashboard/login' }
  );
});

test('mapFileToRoute: app/page.tsx (root) → /', () => {
  assert.deepStrictEqual(mapFileToRoute('app/page.tsx'), { route: '/' });
});

// ─── mapFileToRoute: app-router subfiles ──────────────────────────────

test('mapFileToRoute: app/dashboard/layout.tsx → /dashboard (scoped)', () => {
  assert.deepStrictEqual(mapFileToRoute('app/dashboard/layout.tsx'), { route: '/dashboard' });
});

test('mapFileToRoute: app/dashboard/loading.tsx → /dashboard', () => {
  assert.deepStrictEqual(mapFileToRoute('app/dashboard/loading.tsx'), { route: '/dashboard' });
});

test('mapFileToRoute: app/dashboard/error.tsx → /dashboard', () => {
  assert.deepStrictEqual(mapFileToRoute('app/dashboard/error.tsx'), { route: '/dashboard' });
});

test('mapFileToRoute: app/api/foo/route.ts → /api/foo', () => {
  assert.deepStrictEqual(mapFileToRoute('app/api/foo/route.ts'), { route: '/api/foo' });
});

// ─── mapFileToRoute: global / shared / build configs ──────────────────

test('mapFileToRoute: app/layout.tsx (ROOT) → *', () => {
  assert.deepStrictEqual(mapFileToRoute('app/layout.tsx'), { route: '*' });
});

test('mapFileToRoute: src/app/globals.css → *', () => {
  assert.deepStrictEqual(mapFileToRoute('src/app/globals.css'), { route: '*' });
});

test('mapFileToRoute: tailwind.config.ts → *', () => {
  assert.deepStrictEqual(mapFileToRoute('tailwind.config.ts'), { route: '*' });
});

test('mapFileToRoute: next.config.mjs → *', () => {
  assert.deepStrictEqual(mapFileToRoute('next.config.mjs'), { route: '*' });
});

test('mapFileToRoute: package.json → *', () => {
  assert.deepStrictEqual(mapFileToRoute('package.json'), { route: '*' });
});

test('mapFileToRoute: src/components/Card.tsx → * (shared, conservative)', () => {
  assert.deepStrictEqual(mapFileToRoute('src/components/Card.tsx'), { route: '*' });
});

test('mapFileToRoute: src/lib/format.ts → *', () => {
  assert.deepStrictEqual(mapFileToRoute('src/lib/format.ts'), { route: '*' });
});

test('mapFileToRoute: src/hooks/useThing.ts → *', () => {
  assert.deepStrictEqual(mapFileToRoute('src/hooks/useThing.ts'), { route: '*' });
});

// ─── mapFileToRoute: pages-router ─────────────────────────────────────

test('mapFileToRoute: pages/dashboard.tsx → /dashboard', () => {
  assert.deepStrictEqual(mapFileToRoute('pages/dashboard.tsx'), { route: '/dashboard' });
});

test('mapFileToRoute: pages/index.tsx → /', () => {
  assert.deepStrictEqual(mapFileToRoute('pages/index.tsx'), { route: '/' });
});

test('mapFileToRoute: pages/foo/bar.tsx → /foo/bar', () => {
  assert.deepStrictEqual(mapFileToRoute('pages/foo/bar.tsx'), { route: '/foo/bar' });
});

test('mapFileToRoute: pages/foo/index.tsx → /foo', () => {
  assert.deepStrictEqual(mapFileToRoute('pages/foo/index.tsx'), { route: '/foo' });
});

// ─── mapFileToRoute: irrelevant files ─────────────────────────────────

test('mapFileToRoute: src/app/dashboard/page.test.tsx → null (test)', () => {
  assert.strictEqual(mapFileToRoute('src/app/dashboard/page.test.tsx'), null);
});

test('mapFileToRoute: Card.stories.tsx → null', () => {
  assert.strictEqual(mapFileToRoute('src/components/Card.stories.tsx'), null);
});

test('mapFileToRoute: tests/unit/foo.test.ts → null', () => {
  assert.strictEqual(mapFileToRoute('tests/unit/foo.test.ts'), null);
});

test('mapFileToRoute: README.md → null', () => {
  assert.strictEqual(mapFileToRoute('README.md'), null);
});

test('mapFileToRoute: specs/001-foo/prd.md → null', () => {
  assert.strictEqual(mapFileToRoute('specs/001-foo/prd.md'), null);
});

test('mapFileToRoute: pipeline/feedback/foo.json → null', () => {
  assert.strictEqual(mapFileToRoute('pipeline/feedback/foo.json'), null);
});

test('mapFileToRoute: .claude/conventions.json → null (tooling, not rendered output)', () => {
  assert.strictEqual(mapFileToRoute('.claude/conventions.json'), null);
});

test('mapFileToRoute: designs/dashboard.html → null (prototype, not impl)', () => {
  assert.strictEqual(mapFileToRoute('designs/dashboard.html'), null);
});

test('mapFileToRoute: empty / non-string → null', () => {
  assert.strictEqual(mapFileToRoute(''), null);
  assert.strictEqual(mapFileToRoute(null), null);
  assert.strictEqual(mapFileToRoute(undefined), null);
});

// ─── classifyFile: the richer kind behind mapFileToRoute ──────────────

test('classifyFile: page → kind route', () => {
  assert.deepStrictEqual(classifyFile('src/app/dashboard/page.tsx'), { kind: 'route', route: '/dashboard' });
});

test('classifyFile: root layout → kind global (no trace)', () => {
  assert.deepStrictEqual(classifyFile('app/layout.tsx'), { kind: 'global' });
});

test('classifyFile: tailwind config → kind global', () => {
  assert.deepStrictEqual(classifyFile('tailwind.config.ts'), { kind: 'global' });
});

test('classifyFile: component → kind shared (traceable), carries path', () => {
  assert.deepStrictEqual(classifyFile('src/components/Card.tsx'), { kind: 'shared', file: 'src/components/Card.tsx' });
});

test('classifyFile: lib helper → kind shared', () => {
  assert.deepStrictEqual(classifyFile('src/lib/format.ts'), { kind: 'shared', file: 'src/lib/format.ts' });
});

test('classifyFile: unknown src/ file → kind shared (traceable, not hard global)', () => {
  assert.deepStrictEqual(classifyFile('src/widgets/thing.ts'), { kind: 'shared', file: 'src/widgets/thing.ts' });
});

test('classifyFile: doc → kind irrelevant', () => {
  assert.deepStrictEqual(classifyFile('README.md'), { kind: 'irrelevant' });
});

test('classifyFile: empty / non-string → kind irrelevant', () => {
  assert.deepStrictEqual(classifyFile(''), { kind: 'irrelevant' });
  assert.deepStrictEqual(classifyFile(null), { kind: 'irrelevant' });
});

// ─── mapFilesToRoutes ─────────────────────────────────────────────────

test('mapFilesToRoutes: empty input → []', () => {
  assert.deepStrictEqual(mapFilesToRoutes([]), []);
});

test('mapFilesToRoutes: only-page changes → deduped sorted routes', () => {
  const r = mapFilesToRoutes([
    'src/app/dashboard/page.tsx',
    'src/app/login/page.tsx',
    'src/app/dashboard/loading.tsx',
  ]);
  assert.deepStrictEqual(r, ['/dashboard', '/login']);
});

test('mapFilesToRoutes: one shared-code change → forces [*]', () => {
  const r = mapFilesToRoutes([
    'src/app/dashboard/page.tsx',
    'src/components/Card.tsx',
  ]);
  assert.deepStrictEqual(r, ['*']);
});

test('mapFilesToRoutes: one global change → forces [*]', () => {
  const r = mapFilesToRoutes([
    'src/app/dashboard/page.tsx',
    'tailwind.config.ts',
  ]);
  assert.deepStrictEqual(r, ['*']);
});

test('mapFilesToRoutes: all irrelevant files → []', () => {
  const r = mapFilesToRoutes(['README.md', 'docs/foo.md', 'tests/x.test.ts']);
  assert.deepStrictEqual(r, []);
});

// ─── priorFailedRoutes ────────────────────────────────────────────────

test('priorFailedRoutes: both payloads null → []', () => {
  assert.deepStrictEqual(priorFailedRoutes(null, null), []);
});

test('priorFailedRoutes: pixel-diff routes with one fail → that route', () => {
  const pixel = {
    verdict: 'fail',
    routes: [
      { route: '/dashboard', verdict: 'pass' },
      { route: '/login', verdict: 'fail' },
    ],
  };
  assert.deepStrictEqual(priorFailedRoutes(pixel, null), ['/login']);
});

test('priorFailedRoutes: union of pixel and dom failures, deduped', () => {
  const pixel = { routes: [{ route: '/a', verdict: 'fail' }] };
  const dom   = { routes: [{ route: '/a', verdict: 'fail' }, { route: '/b', verdict: 'fail' }] };
  assert.deepStrictEqual(priorFailedRoutes(pixel, dom), ['/a', '/b']);
});

test('priorFailedRoutes: ignores skip/pass routes', () => {
  const pixel = { routes: [{ route: '/a', verdict: 'pass' }, { route: '/b', verdict: 'skip' }] };
  assert.deepStrictEqual(priorFailedRoutes(pixel, null), []);
});

test('priorFailedRoutes: malformed payload returns []', () => {
  assert.deepStrictEqual(priorFailedRoutes({}, { routes: 'not-an-array' }), []);
});

// ─── mergeScope ───────────────────────────────────────────────────────

test('mergeScope: fileRoutes contains * → result is [*]', () => {
  assert.deepStrictEqual(mergeScope(['*'], ['/keep']), ['*']);
});

test('mergeScope: union of file + prior, deduped sorted', () => {
  assert.deepStrictEqual(
    mergeScope(['/dashboard', '/login'], ['/login', '/old-failing']),
    ['/dashboard', '/login', '/old-failing']
  );
});

test('mergeScope: both empty → []', () => {
  assert.deepStrictEqual(mergeScope([], []), []);
});

test('mergeScope: only file routes (no prior) → file routes', () => {
  assert.deepStrictEqual(mergeScope(['/a'], []), ['/a']);
});

test('mergeScope: only prior routes (no file changes) → prior routes', () => {
  assert.deepStrictEqual(mergeScope([], ['/a', '/b']), ['/a', '/b']);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
