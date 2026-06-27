// Single source of truth for "which routes does this build cycle need to
// re-diff?". Shared by routes-to-diff.mjs (the CLI the evaluator pipes
// through) AND by pixel-diff.mjs / dom-diff.mjs directly (so a thin env
// wrapper that calls the diff script without the routes-to-diff dance still
// gets scoped — scoping is a default of the tool, not an opt-in shell step).
//
// Pipeline:
//   git diff (merge-base + staged + unstaged)
//     → classifyFile per path
//       route   → that route
//       global  → '*' (hard test-all: root layout, tokens, build config)
//       shared  → trace importers to the routes that render it
//       irrelevant → dropped
//     ∪ prior-cycle failed routes (must be re-verified even if untouched)
//   → '*' (test all) or a deduped route list.
//
// The shared-code trace is what makes a component edit diff just the pages
// that import it instead of the whole app. When the import graph can't be
// trusted (unresolvable import, file outside the source roots) the tracer
// returns incomplete and we fall back to '*' — the old conservative answer.

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyFile, priorFailedRoutes, mergeScope } from '../routes-to-diff-lib.mjs';
import { traceSharedFiles } from './import-graph.mjs';

const STAR = '*';

function runGit(cwd, args) {
  try {
    return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}

// Union of committed-vs-merge-base, staged, and unstaged changed files.
export function changedFiles(cwd, baseRef) {
  const all = new Set();
  const mb = runGit(cwd, `merge-base HEAD ${baseRef}`);
  if (mb) {
    const committed = runGit(cwd, `diff --name-only ${mb.trim()}..HEAD`);
    if (committed) for (const line of committed.split('\n')) if (line) all.add(line);
  } else {
    // No merge-base (orphan branch / missing remote): fall back to HEAD's parent.
    const committed = runGit(cwd, 'diff --name-only HEAD~1..HEAD');
    if (committed) for (const line of committed.split('\n')) if (line) all.add(line);
  }
  const staged = runGit(cwd, 'diff --cached --name-only');
  if (staged) for (const line of staged.split('\n')) if (line) all.add(line);
  const unstaged = runGit(cwd, 'diff --name-only');
  if (unstaged) for (const line of unstaged.split('\n')) if (line) all.add(line);
  return Array.from(all);
}

function loadPayload(cwd, rel) {
  const abs = resolve(cwd, rel);
  if (!existsSync(abs)) return null;
  try { return JSON.parse(readFileSync(abs, 'utf8')); } catch { return null; }
}

// Resolve the file-derived scope (no prior-failure merge yet): classify each
// changed file, trace shared code to its routes, and collapse to '*' on any
// hard-global change or an untrustworthy trace. Exposed for the CLI's
// --verbose reasoning. Returns { scope, routeRoutes, sharedFiles, tracedRoutes,
// hasGlobal, traceIncomplete }.
export function fileDerivedScope(cwd, files) {
  const routeRoutes = new Set();
  const sharedFiles = [];
  let hasGlobal = false;
  for (const f of files) {
    const c = classifyFile(f);
    if (c.kind === 'route') routeRoutes.add(c.route);
    else if (c.kind === 'shared') sharedFiles.push(c.file);
    else if (c.kind === 'global') hasGlobal = true;
  }

  if (routeRoutes.has(STAR)) hasGlobal = true;

  let tracedRoutes = [];
  let traceIncomplete = false;
  if (!hasGlobal && sharedFiles.length) {
    const traced = traceSharedFiles(cwd, sharedFiles);
    tracedRoutes = traced.routes;
    traceIncomplete = traced.incomplete;
    if (tracedRoutes.includes(STAR)) hasGlobal = true;
  }

  let scope;
  if (hasGlobal || traceIncomplete) {
    scope = [STAR];
  } else {
    scope = Array.from(new Set([...routeRoutes, ...tracedRoutes])).sort();
  }
  return {
    scope,
    routeRoutes: Array.from(routeRoutes).sort(),
    sharedFiles,
    tracedRoutes,
    hasGlobal,
    traceIncomplete,
  };
}

// Full scope: file-derived ∪ prior-cycle failures, collapsed to '*' or a
// route list. Returns { scope: '*' | string[], files, fileScope, priorRoutes,
// detail } — `scope` is the literal string '*' for test-all, otherwise the
// sorted route array. An empty result means "no relevant changes and no prior
// failures" which the caller treats as '*' (establish a baseline).
export function computeRouteScope({ cwd = process.cwd(), base = 'main', includePrior = true } = {}) {
  const files = changedFiles(cwd, base);
  const detail = fileDerivedScope(cwd, files);

  let priorRoutes = [];
  if (includePrior) {
    const pixel = loadPayload(cwd, 'pipeline/feedback/pixel-diff.json');
    const dom = loadPayload(cwd, 'pipeline/feedback/dom-diff.json');
    priorRoutes = priorFailedRoutes(pixel, dom);
  }

  const merged = mergeScope(detail.scope, priorRoutes);
  const scope = merged.length === 0 || merged.includes(STAR) ? STAR : merged;
  return { scope, files, fileScope: detail.scope, priorRoutes, detail };
}
