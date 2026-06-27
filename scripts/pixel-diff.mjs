#!/usr/bin/env node
// Visual regression check for design fidelity. For each (design HTML,
// implementation route) pair, renders both in the same headless Chromium
// at the same viewport, diffs the screenshots with pixelmatch, buckets
// the differing pixels into a grid so the model gets "where" not just
// "how much", and writes a structured JSON report.
//
// Designed to be called by the evaluator agent during Step 2b (design
// fidelity). The evaluator already starts the designs server and the
// dev server — this script reads those URLs from the marker files
// (pipeline/designs-server-url, pipeline/dev-server-url) and does not
// start its own.
//
// Config lives in .claude/conventions.json under the `pixelDiff` key.
// Runtime deps (playwright, pixelmatch, pngjs) are loaded dynamically so
// host projects without them get a graceful skip instead of a hard fail.
//
// Usage:
//   node .claude/scripts/pixel-diff.mjs [--out <dir>] [--routes <json>]
//
// Output: JSON to stdout. Exit 0 on pass or skip, 1 on fail, 2 on error.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import {
  STUCK_DELTA_PP,
  annotateStuck,
  effectiveMaxDiffPct,
  bucketDiffPixels,
} from './pixel-diff-lib.mjs';
import { parseViewport, readUrlFile, discoverDesignRoutes, emit } from './lib/diff-io.mjs';
import { computeRouteScope } from './lib/diff-scope.mjs';

// Re-export the pure helpers so existing test code and external callers
// that `import { ... } from './pixel-diff.mjs'` keep working. New code can
// import directly from pixel-diff-lib.mjs.
export { annotateStuck, effectiveMaxDiffPct, bucketDiffPixels };

const CWD = process.cwd();
const CONVENTIONS_PATH = join(CWD, '.claude', 'conventions.json');
const DEFAULT_OUT_DIR = join(CWD, 'pipeline', 'feedback');
const DEV_URL_FILE = join(CWD, 'pipeline', 'dev-server-url');
const DESIGNS_URL_FILE = join(CWD, 'pipeline', 'designs-server-url');

const DEFAULTS = {
  enabled: true,
  viewport: '1280x800',
  // Default raised from 2.0 → 5.0 in v0.10.0: at 2.0 the diff against a hand-
  // written static-HTML prototype rarely converges for a real app — font
  // hinting, computed greetings/timestamps, and live data introduce ~3-6%
  // irreducible drift that no seed-tuning will remove. 5% surfaces structural
  // gaps without flagging cosmetic ones. Tune for goldenscreenshot-strict
  // regression by setting maxDiffPct lower in .claude/conventions.json.
  maxDiffPct: 5.0,
  threshold: 0.1,
  gridSize: 50,
  topRegions: 10,
  masks: [],
  waitFor: null,
  routes: null,
  // Path to a Playwright storageState JSON (cookies + localStorage) applied
  // only to the actual-side screenshot. Use when routes are auth-protected:
  // a project-local wrapper captures the state via a login flow and either
  // sets this field or passes --storage-state at the CLI (which wins).
  // The reference side (designs/*.html) is always loaded without auth.
  storageStatePath: null,
  // Per-route threshold overrides. When one route's structure makes the
  // global maxDiffPct unrealistic (e.g. a dense detail page with spread
  // micro-drift) but the rest converge cleanly, give it its own floor here
  // instead of loosening the global threshold for every route. Shape:
  //   { "/contracts/[id]/indexation": { maxDiffPct: 11.0 } }
  // Match by exact route key (as it appears in `routes`, or the discovered
  // default `/<slug>` for `designs/<slug>.html`). Missing/null is identical
  // to "no overrides defined".
  routeOverrides: null,
};

function parseArgs(argv) {
  const out = { outDir: DEFAULT_OUT_DIR, routesOverride: null, storageStatePath: null, onlyRoutes: [], all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.outDir = resolve(CWD, argv[++i]);
    else if (a === '--routes') out.routesOverride = JSON.parse(argv[++i]);
    else if (a === '--storage-state') out.storageStatePath = resolve(CWD, argv[++i]);
    else if (a === '--only-route') out.onlyRoutes.push(argv[++i]);
    else if (a === '--all') out.all = true;
    else if (a === '-h' || a === '--help') {
      process.stdout.write(
        'pixel-diff: visual regression check vs designs/<slug>.html prototypes\n' +
        'Usage: pixel-diff.mjs [--out <dir>] [--routes <json>] [--storage-state <path>]\n' +
        '                     [--only-route <route> ...] [--all]\n' +
        'Config: .claude/conventions.json -> pixelDiff block\n' +
        '  --storage-state <path>  Playwright storageState JSON; applied only\n' +
        '                          to the actual-side screenshot. Overrides\n' +
        '                          pixelDiff.storageStatePath if both set.\n' +
        '  --only-route <route>    Restrict to specific routes (repeatable).\n' +
        '                          Typically piped from routes-to-diff.mjs.\n' +
        '  --all                   Diff every route, skipping the default\n' +
        '                          change-scoping. Use for a full sweep.\n' +
        '\n' +
        'By default (no --only-route / --all) the script self-scopes to the\n' +
        'routes this cycle changed, via the same logic as routes-to-diff.mjs.\n'
      );
      process.exit(0);
    }
  }
  return out;
}

function loadConfig() {
  if (!existsSync(CONVENTIONS_PATH)) return null;
  let raw;
  try { raw = readFileSync(CONVENTIONS_PATH, 'utf8'); } catch { return null; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed.pixelDiff !== 'object' || parsed.pixelDiff === null) return null;
  return { ...DEFAULTS, ...parsed.pixelDiff };
}

function loadPriorRun(outDir) {
  const path = join(outDir, 'pixel-diff.json');
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

async function loadDeps() {
  try {
    const [{ chromium }, pixelmatchMod, pngjsMod] = await Promise.all([
      import('playwright'),
      import('pixelmatch'),
      import('pngjs'),
    ]);
    return {
      chromium,
      pixelmatch: pixelmatchMod.default ?? pixelmatchMod,
      PNG: pngjsMod.PNG ?? pngjsMod.default?.PNG,
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function screenshotPage(browser, url, viewport, masks, waitFor, storageStatePath) {
  const ctx = await browser.newContext({
    viewport,
    ...(storageStatePath ? { storageState: storageStatePath } : {}),
  });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Best-effort: wait for network to settle, but don't hang forever.
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    if (waitFor) {
      await page.waitForSelector(waitFor, { timeout: 10_000 }).catch(() => {});
    }
    // Small grace period for late-binding fonts / hydration.
    await page.waitForTimeout(300);
    const maskLocators = (masks || []).map((sel) => page.locator(sel));
    const buf = await page.screenshot({
      fullPage: true,
      mask: maskLocators,
      animations: 'disabled',
      caret: 'hide',
    });
    return buf;
  } finally {
    await ctx.close();
  }
}

function cropToCommonHeight(PNG, refBuf, actBuf) {
  const ref = PNG.sync.read(refBuf);
  const act = PNG.sync.read(actBuf);
  const width = Math.min(ref.width, act.width);
  const height = Math.min(ref.height, act.height);
  const cropOne = (img) => {
    if (img.width === width && img.height === height) return img;
    const cropped = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
      const srcStart = y * img.width * 4;
      const dstStart = y * width * 4;
      img.data.copy(cropped.data, dstStart, srcStart, srcStart + width * 4);
    }
    return cropped;
  };
  return { ref: cropOne(ref), act: cropOne(act), width, height };
}

async function diffPair(deps, pair, cfg, viewport, outDir, browser) {
  const refUrl = pair._refUrl;
  const actUrl = pair._actUrl;
  // Reference side (static design HTML) is always loaded without auth — the
  // designs server has no session and adding storageState would inject stale
  // cookies into a same-origin redirect chain that doesn't need them.
  // Only the actual (dev-server) shot uses storageState.
  const refBuf = await screenshotPage(browser, refUrl, viewport, cfg.masks, cfg.waitFor, null);
  const actBuf = await screenshotPage(browser, actUrl, viewport, cfg.masks, cfg.waitFor, cfg.storageStatePath);
  const { PNG, pixelmatch } = deps;
  const { ref, act, width, height } = cropToCommonHeight(PNG, refBuf, actBuf);
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(ref.data, act.data, diff.data, width, height, {
    threshold: cfg.threshold,
    includeAA: false,
  });
  const diffPct = Number(((diffPixels / (width * height)) * 100).toFixed(3));

  const slug = basename(pair.design).replace(/\.html$/, '') || 'index';
  const paths = {
    reference: join(outDir, `pixel-diff-${slug}-reference.png`),
    actual: join(outDir, `pixel-diff-${slug}-actual.png`),
    diff: join(outDir, `pixel-diff-${slug}-diff.png`),
  };
  writeFileSync(paths.reference, PNG.sync.write(ref));
  writeFileSync(paths.actual, PNG.sync.write(act));
  writeFileSync(paths.diff, PNG.sync.write(diff));

  const { regions } = bucketDiffPixels(diff.data, width, height, cfg.gridSize, cfg.topRegions);
  const maxPct = effectiveMaxDiffPct(cfg, pair.route);
  const verdict = diffPct > maxPct ? 'fail' : 'pass';
  const overridden = maxPct !== cfg.maxDiffPct;

  return {
    design: pair.design,
    route: pair.route,
    verdict,
    diff_pct: diffPct,
    max_diff_pct: maxPct,
    ...(overridden ? { max_diff_pct_source: 'routeOverride' } : {}),
    viewport: `${width}x${height}`,
    regions,
    screenshots: {
      reference: paths.reference.replace(CWD + '/', ''),
      actual: paths.actual.replace(CWD + '/', ''),
      diff: paths.diff.replace(CWD + '/', ''),
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.outDir, { recursive: true });

  // Read the prior run's payload (if any) BEFORE writing this run's screenshots
  // — once we start writing, the on-disk PNG names collide with whatever the
  // last run left behind, so we have to capture the prior diff_pct first.
  const prior = loadPriorRun(args.outDir);

  const cfg = loadConfig();
  if (!cfg) {
    emit({ verdict: 'skip', reason: 'no pixelDiff config in .claude/conventions.json' }, 0);
  }
  if (cfg.enabled === false) {
    emit({ verdict: 'skip', reason: 'pixelDiff.enabled is false' }, 0);
  }

  // CLI --storage-state overrides pixelDiff.storageStatePath. Wrappers that
  // capture a session at runtime (login flow → write to a temp path) pass
  // via CLI; projects with a stable cookie file use the config field.
  if (args.storageStatePath) cfg.storageStatePath = args.storageStatePath;
  if (cfg.storageStatePath && !existsSync(cfg.storageStatePath)) {
    emit({
      verdict: 'skip',
      reason: `storageStatePath does not exist: ${cfg.storageStatePath}. The wrapper that captures auth needs to write the file before pixel-diff runs.`,
    }, 0);
  }

  const designsDir = join(CWD, 'designs');
  if (!existsSync(designsDir)) {
    emit({ verdict: 'skip', reason: 'no designs/ directory in repo' }, 0);
  }

  const deps = await loadDeps();
  if (deps.error) {
    emit({
      verdict: 'skip',
      reason: 'pixel-diff requires playwright + pixelmatch + pngjs. Install: npm i -D playwright pixelmatch pngjs && npx playwright install chromium',
      _error: deps.error,
    }, 0);
  }

  const devUrl = readUrlFile(DEV_URL_FILE);
  const designsUrl = readUrlFile(DESIGNS_URL_FILE);
  if (!devUrl || !designsUrl) {
    emit({
      verdict: 'skip',
      reason: `dev server or designs server not running (dev=${devUrl ?? 'missing'}, designs=${designsUrl ?? 'missing'}). Start them via .claude/scripts/start-dev-server.mjs before running pixel-diff.`,
    }, 0);
  }

  let routes = args.routesOverride ?? cfg.routes ?? discoverDesignRoutes(CWD);

  // Resolve the effective route scope. Precedence:
  //   --all                → diff everything (explicit full sweep)
  //   --only-route X …     → exactly those (explicit; typically from
  //                          routes-to-diff.mjs upstream)
  //   neither              → self-scope to this cycle's changed routes, so a
  //                          thin env wrapper that calls pixel-diff directly
  //                          still gets change-scoping. '*' → diff everything.
  let onlyRoutes = args.onlyRoutes;
  let selfScoped = false;
  if (!args.all && (!onlyRoutes || !onlyRoutes.length)) {
    try {
      const { scope } = computeRouteScope({ cwd: CWD, base: 'main' });
      if (scope !== '*') { onlyRoutes = scope; selfScoped = true; }
    } catch { /* fall back to full sweep on any scope-computation error */ }
  }

  let scoped = false;
  if (onlyRoutes && onlyRoutes.length) {
    const allow = new Set(onlyRoutes);
    routes = routes.filter((r) => allow.has(r.route));
    scoped = true;
    if (!routes.length) {
      emit({
        verdict: 'skip',
        reason: selfScoped
          ? `no design/route pairs affected by this cycle's changes (self-scoped to ${JSON.stringify(onlyRoutes)}). Nothing for pixel-diff to verify.`
          : `no configured routes match --only-route filter ${JSON.stringify(onlyRoutes)}`,
        scoped: true,
        ...(selfScoped ? { self_scoped: true } : {}),
      }, 0);
    }
  }
  if (!routes.length) {
    emit({ verdict: 'skip', reason: 'no design/route pairs to compare (no designs/*.html and no explicit routes)' }, 0);
  }

  // Resolve URLs for each pair up front so the loop below is just I/O.
  for (const p of routes) {
    p._refUrl = `${designsUrl.replace(/\/$/, '')}/${basename(p.design)}`;
    p._actUrl = `${devUrl.replace(/\/$/, '')}${p.route.startsWith('/') ? p.route : `/${p.route}`}`;
  }

  const viewport = parseViewport(cfg.viewport);
  process.stderr.write(`pixel-diff: ${routes.length} route(s)\n`);
  const browser = await deps.chromium.launch();
  const results = [];
  try {
    let i = 0;
    for (const pair of routes) {
      i++;
      const t0 = Date.now();
      try {
        const res = await diffPair(deps, pair, cfg, viewport, args.outDir, browser);
        results.push(res);
        const ms = Date.now() - t0;
        const pct = typeof res.diff_pct === 'number' ? `${res.diff_pct.toFixed(2)}%` : '—';
        process.stderr.write(
          `  [${i}/${routes.length}] ${pair.route} → ${res.verdict} (${pct}, ${ms}ms)\n`
        );
      } catch (err) {
        const ms = Date.now() - t0;
        results.push({
          design: pair.design,
          route: pair.route,
          verdict: 'fail',
          error: err.message,
        });
        process.stderr.write(
          `  [${i}/${routes.length}] ${pair.route} → ERROR (${ms}ms): ${err.message}\n`
        );
      }
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => r.verdict === 'fail');
  const verdict = failed.length === 0 ? 'pass' : 'fail';

  // Compare against the prior run (if any) to detect a plateaued diff. The
  // prior payload is on disk from this script's previous invocation; we
  // mutated `results` in-place to add per-route `stuck` / `stuck_delta_pp`.
  const stuckInfo = annotateStuck(results, prior?.routes);

  const overrideCount = results.filter((r) => r.max_diff_pct_source === 'routeOverride').length;
  const summary = `${results.length - failed.length}/${results.length} routes passed (default maxDiffPct=${cfg.maxDiffPct}%${overrideCount ? `, ${overrideCount} route override(s) applied` : ''})`;
  const payload = {
    verdict,
    summary,
    ...(scoped ? { scoped: true, scoped_routes: onlyRoutes, ...(selfScoped ? { self_scoped: true } : {}) } : {}),
    ...(stuckInfo.allStuck
      ? {
          stuck: true,
          stuck_reason:
            `diff_pct has stabilised on every compared route ` +
            `(${stuckInfo.stuckRoutes}/${stuckInfo.comparedRoutes}, all within ${STUCK_DELTA_PP}pp of the prior run). ` +
            `Further micro-edits are unlikely to lower the diff. Options:\n` +
            `  - Raise \`pixelDiff.maxDiffPct\` in .claude/conventions.json if the current floor is acceptable for this view.\n` +
            `  - Add CSS-selector masks to \`pixelDiff.masks\` for the irreducible regions (timestamps, computed greetings, dynamic counts).\n` +
            `  - Accept the current diff_pct as the baseline and move on to other tasks.`,
        }
      : {}),
    routes: results,
  };

  // Persist the payload so the next run can detect plateaus. Independent of
  // whether the caller redirects stdout; the file always lands here.
  try {
    writeFileSync(join(args.outDir, 'pixel-diff.json'), JSON.stringify(payload, null, 2));
  } catch {}

  emit(payload, verdict === 'fail' ? 1 : 0);
}

// Only run main() when invoked as a CLI — leave the module importable for tests.
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('pixel-diff.mjs');
  } catch { return false; }
})();
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`pixel-diff: ${err.stack || err.message}\n`);
    process.exit(2);
  });
}
