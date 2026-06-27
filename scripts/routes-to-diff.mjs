#!/usr/bin/env node
// Decide which routes pixel-diff / dom-diff should run against this cycle.
// Output is consumed by the evaluator agent:
//   - "*" (on a single line) → test all routes; pass no --only-route flags
//   - one route per line     → pass each as --only-route
//
// The scope decision itself lives in lib/diff-scope.mjs (shared with
// pixel-diff/dom-diff, which now self-scope through the same brain). This
// file is just the CLI wrapper: parse flags, print the result, narrate.
//
// Inputs (all read from disk, no args):
//   - `git diff` against the merge-base of the current branch and <base>,
//     plus staged + unstaged. Each changed file is classified; shared code
//     (components/hooks/utils) is traced through the import graph to the
//     routes that actually render it, instead of forcing a full sweep.
//   - pipeline/feedback/pixel-diff.json + dom-diff.json → prior failed routes,
//     always re-tested so a stuck route never drops out of coverage.
//
// Output policy:
//   - Hard-global change (root layout, theme tokens, build config) OR an
//     untrustworthy import trace → "*"
//   - Otherwise, union of (file-derived routes) ∪ (prior-failure routes)
//   - Empty result (no relevant changes, no prior failures) → "*"
//
// Usage:
//   ROUTES=$(node .claude/scripts/routes-to-diff.mjs)
//   if [ "$ROUTES" = "*" ]; then
//     node .claude/scripts/pixel-diff.mjs --out pipeline/feedback &
//     node .claude/scripts/dom-diff.mjs   --out pipeline/feedback &
//   else
//     FLAGS=""
//     while IFS= read -r r; do FLAGS="$FLAGS --only-route $r"; done <<< "$ROUTES"
//     node .claude/scripts/pixel-diff.mjs --out pipeline/feedback $FLAGS &
//     node .claude/scripts/dom-diff.mjs   --out pipeline/feedback $FLAGS &
//   fi
//   wait
//
// Flags:
//   --base <ref>    override the merge-base ref (default: main).
//   --verbose       print the reasoning to stderr (which files mapped to
//                   which routes, what the import trace resolved, and which
//                   routes carried over from the prior cycle).
//   --no-prior      skip the prior-failure scan (useful for a clean baseline).

import { computeRouteScope } from './lib/diff-scope.mjs';

const CWD = process.cwd();

function parseArgs(argv) {
  const out = { base: 'main', verbose: false, includePrior: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') out.base = argv[++i];
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--no-prior') out.includePrior = false;
    else if (a === '-h' || a === '--help') {
      process.stdout.write(
        'routes-to-diff: emit the list of routes pixel-diff/dom-diff should run\n' +
        'Usage: routes-to-diff.mjs [--base <ref>] [--verbose] [--no-prior]\n'
      );
      process.exit(0);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { scope, files, priorRoutes, detail } = computeRouteScope({
    cwd: CWD,
    base: args.base,
    includePrior: args.includePrior,
  });

  if (args.verbose) {
    const w = (s) => process.stderr.write(s + '\n');
    w(`routes-to-diff: ${files.length} changed file(s) since merge-base with ${args.base}`);
    for (const f of files) w(`  changed: ${f}`);
    w(`  direct route files: ${detail.routeRoutes.length ? detail.routeRoutes.join(', ') : '(none)'}`);
    w(`  shared files traced: ${detail.sharedFiles.length ? detail.sharedFiles.join(', ') : '(none)'}`);
    w(`  trace → routes: ${detail.tracedRoutes.length ? detail.tracedRoutes.join(', ') : '(none)'}` +
      (detail.traceIncomplete ? ' [incomplete → test-all]' : ''));
    if (detail.hasGlobal) w('  hard-global change present → test-all');
    w(`  prior-failure routes: ${priorRoutes.length ? priorRoutes.join(', ') : '(none)'}`);
    w(`  final scope: ${scope === '*' ? '* (test-all)' : scope.join(', ')}`);
  }

  if (scope === '*') {
    process.stdout.write('*\n');
    process.exit(0);
  }
  for (const r of scope) process.stdout.write(r + '\n');
}

main();
