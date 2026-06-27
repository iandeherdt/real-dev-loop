// Tests the pure import-graph helpers. The I/O wrapper (lib/import-graph.mjs)
// is left for the user's smoke test — it walks the filesystem and reads
// tsconfig, which doesn't make for a deterministic unit test. Here we feed a
// synthetic in-memory file map and assert the trace.

import assert from 'node:assert';
import {
  parseImportSpecifiers,
  resolveSpecifier,
  normalisePath,
  traceRoutes,
} from '../scripts/import-graph-lib.mjs';

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

// ─── parseImportSpecifiers ────────────────────────────────────────────

test('parseImportSpecifiers: static default + named imports', () => {
  const { specifiers } = parseImportSpecifiers(
    `import React from 'react';\nimport { Card } from './Card';`
  );
  assert.deepStrictEqual(specifiers.sort(), ['./Card', 'react']);
});

test('parseImportSpecifiers: export … from (barrel re-export)', () => {
  const { specifiers } = parseImportSpecifiers(`export { Card } from './Card';\nexport * from './Button';`);
  assert.deepStrictEqual(specifiers.sort(), ['./Button', './Card']);
});

test('parseImportSpecifiers: side-effect import', () => {
  const { specifiers } = parseImportSpecifiers(`import './globals.css';`);
  assert.deepStrictEqual(specifiers, ['./globals.css']);
});

test('parseImportSpecifiers: dynamic import with literal', () => {
  const { specifiers, dynamicNonLiteral } = parseImportSpecifiers(`const m = await import('./Lazy');`);
  assert.deepStrictEqual(specifiers, ['./Lazy']);
  assert.strictEqual(dynamicNonLiteral, false);
});

test('parseImportSpecifiers: dynamic import with non-literal sets flag', () => {
  const { dynamicNonLiteral } = parseImportSpecifiers(`const m = await import(path);`);
  assert.strictEqual(dynamicNonLiteral, true);
});

test('parseImportSpecifiers: commented-out import is ignored', () => {
  const { specifiers } = parseImportSpecifiers(`// import { Old } from './Old';\nimport { New } from './New';`);
  assert.deepStrictEqual(specifiers, ['./New']);
});

test('parseImportSpecifiers: non-string input → empty', () => {
  assert.deepStrictEqual(parseImportSpecifiers(null), { specifiers: [], dynamicNonLiteral: false });
});

// ─── resolveSpecifier ─────────────────────────────────────────────────

const fileSet = new Set([
  'src/app/dashboard/page.tsx',
  'src/components/Card.tsx',
  'src/components/index.ts',
  'src/lib/format.ts',
]);

test('resolveSpecifier: relative with implicit extension', () => {
  const r = resolveSpecifier('../../components/Card', 'src/app/dashboard/page.tsx', [], fileSet);
  assert.deepStrictEqual(r, { node: 'src/components/Card.tsx' });
});

test('resolveSpecifier: relative barrel directory → index', () => {
  const r = resolveSpecifier('../../components', 'src/app/dashboard/page.tsx', [], fileSet);
  assert.deepStrictEqual(r, { node: 'src/components/index.ts' });
});

test('resolveSpecifier: alias @/ → src/', () => {
  const aliases = [{ prefix: '@/*', targets: ['src/*'] }];
  const r = resolveSpecifier('@/lib/format', 'src/app/dashboard/page.tsx', aliases, fileSet);
  assert.deepStrictEqual(r, { node: 'src/lib/format.ts' });
});

test('resolveSpecifier: bare package → external', () => {
  const r = resolveSpecifier('react', 'src/components/Card.tsx', [], fileSet);
  assert.deepStrictEqual(r, { external: true });
});

test('resolveSpecifier: missing relative → unresolved', () => {
  const r = resolveSpecifier('./Nope', 'src/components/Card.tsx', [], fileSet);
  assert.deepStrictEqual(r, { unresolved: true });
});

test('resolveSpecifier: alias that maps nowhere → unresolved', () => {
  const aliases = [{ prefix: '@/*', targets: ['src/*'] }];
  const r = resolveSpecifier('@/lib/missing', 'src/app/dashboard/page.tsx', aliases, fileSet);
  assert.deepStrictEqual(r, { unresolved: true });
});

// ─── traceRoutes ──────────────────────────────────────────────────────

function mapOf(obj) {
  return new Map(Object.entries(obj));
}

const ALIASES = [{ prefix: '@/*', targets: ['src/*'] }];

test('traceRoutes: component imported by one page → that route', () => {
  const fileMap = mapOf({
    'src/app/dashboard/page.tsx': `import { Card } from '@/components/Card';`,
    'src/app/settings/page.tsx': `import { Toggle } from '@/components/Toggle';`,
    'src/components/Card.tsx': `export const Card = () => null;`,
    'src/components/Toggle.tsx': `export const Toggle = () => null;`,
  });
  const roots = [
    { file: 'src/app/dashboard/page.tsx', route: '/dashboard' },
    { file: 'src/app/settings/page.tsx', route: '/settings' },
  ];
  const r = traceRoutes({ fileMap, aliases: ALIASES, roots, changed: ['src/components/Card.tsx'] });
  assert.deepStrictEqual(r, { routes: ['/dashboard'], incomplete: false });
});

test('traceRoutes: component imported by two pages → both routes', () => {
  const fileMap = mapOf({
    'src/app/dashboard/page.tsx': `import { Card } from '@/components/Card';`,
    'src/app/settings/page.tsx': `import { Card } from '@/components/Card';`,
    'src/components/Card.tsx': `export const Card = () => null;`,
  });
  const roots = [
    { file: 'src/app/dashboard/page.tsx', route: '/dashboard' },
    { file: 'src/app/settings/page.tsx', route: '/settings' },
  ];
  const r = traceRoutes({ fileMap, aliases: ALIASES, roots, changed: ['src/components/Card.tsx'] });
  assert.deepStrictEqual(r, { routes: ['/dashboard', '/settings'], incomplete: false });
});

test('traceRoutes: transitive import through a mid component', () => {
  const fileMap = mapOf({
    'src/app/dashboard/page.tsx': `import { Panel } from '@/components/Panel';`,
    'src/components/Panel.tsx': `import { Badge } from './Badge';`,
    'src/components/Badge.tsx': `export const Badge = () => null;`,
  });
  const roots = [{ file: 'src/app/dashboard/page.tsx', route: '/dashboard' }];
  const r = traceRoutes({ fileMap, aliases: ALIASES, roots, changed: ['src/components/Badge.tsx'] });
  assert.deepStrictEqual(r, { routes: ['/dashboard'], incomplete: false });
});

test('traceRoutes: barrel re-export connects page to component', () => {
  const fileMap = mapOf({
    'src/app/dashboard/page.tsx': `import { Card } from '@/components';`,
    'src/components/index.ts': `export { Card } from './Card';`,
    'src/components/Card.tsx': `export const Card = () => null;`,
  });
  const roots = [{ file: 'src/app/dashboard/page.tsx', route: '/dashboard' }];
  const r = traceRoutes({ fileMap, aliases: ALIASES, roots, changed: ['src/components/Card.tsx'] });
  assert.deepStrictEqual(r, { routes: ['/dashboard'], incomplete: false });
});

test('traceRoutes: component reached by no root → empty, complete', () => {
  const fileMap = mapOf({
    'src/app/dashboard/page.tsx': `import { Card } from '@/components/Card';`,
    'src/components/Card.tsx': `export const Card = () => null;`,
    'src/components/Orphan.tsx': `export const Orphan = () => null;`,
  });
  const roots = [{ file: 'src/app/dashboard/page.tsx', route: '/dashboard' }];
  const r = traceRoutes({ fileMap, aliases: ALIASES, roots, changed: ['src/components/Orphan.tsx'] });
  assert.deepStrictEqual(r, { routes: [], incomplete: false });
});

test('traceRoutes: changed file not a known node → incomplete', () => {
  const fileMap = mapOf({
    'src/app/dashboard/page.tsx': `import { Card } from '@/components/Card';`,
    'src/components/Card.tsx': `export const Card = () => null;`,
  });
  const roots = [{ file: 'src/app/dashboard/page.tsx', route: '/dashboard' }];
  const r = traceRoutes({ fileMap, aliases: ALIASES, roots, changed: ['src/components/Ghost.tsx'] });
  assert.deepStrictEqual(r, { routes: [], incomplete: true });
});

test('traceRoutes: unresolved import in reachable graph → incomplete', () => {
  const fileMap = mapOf({
    'src/app/dashboard/page.tsx': `import { Card } from '@/components/Card';`,
    'src/components/Card.tsx': `import { Missing } from './Missing';\nexport const Card = () => null;`,
  });
  const roots = [{ file: 'src/app/dashboard/page.tsx', route: '/dashboard' }];
  const r = traceRoutes({ fileMap, aliases: ALIASES, roots, changed: ['src/components/Card.tsx'] });
  assert.deepStrictEqual(r, { routes: ['/dashboard'], incomplete: true });
});

test('traceRoutes: dynamic non-literal import in reachable graph → incomplete', () => {
  const fileMap = mapOf({
    'src/app/dashboard/page.tsx': `import { Card } from '@/components/Card';`,
    'src/components/Card.tsx': `const m = import(dynamicName);\nexport const Card = () => null;`,
  });
  const roots = [{ file: 'src/app/dashboard/page.tsx', route: '/dashboard' }];
  const r = traceRoutes({ fileMap, aliases: ALIASES, roots, changed: ['src/components/Card.tsx'] });
  assert.deepStrictEqual(r, { routes: ['/dashboard'], incomplete: true });
});

test('traceRoutes: root layout route "*" propagates as a route value', () => {
  const fileMap = mapOf({
    'src/app/layout.tsx': `import { Nav } from '@/components/Nav';`,
    'src/components/Nav.tsx': `export const Nav = () => null;`,
  });
  // The I/O layer maps app/layout.tsx → route '*'; here we assert traceRoutes
  // faithfully returns whatever route string the root carries.
  const roots = [{ file: 'src/app/layout.tsx', route: '*' }];
  const r = traceRoutes({ fileMap, aliases: ALIASES, roots, changed: ['src/components/Nav.tsx'] });
  assert.deepStrictEqual(r, { routes: ['*'], incomplete: false });
});

test('traceRoutes: empty changed → empty, complete', () => {
  const r = traceRoutes({ fileMap: new Map(), aliases: [], roots: [], changed: [] });
  assert.deepStrictEqual(r, { routes: [], incomplete: false });
});

test('normalisePath: strips ./ and leading slashes, posixifies', () => {
  assert.strictEqual(normalisePath('./src/a.ts'), 'src/a.ts');
  assert.strictEqual(normalisePath('/src/a.ts'), 'src/a.ts');
  assert.strictEqual(normalisePath('src\\a.ts'), 'src/a.ts');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
