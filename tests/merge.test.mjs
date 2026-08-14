#!/usr/bin/env node
// Tests for lib/merge.mjs — the settings.json merger that wires specsmith's
// hooks into a host project.
//
// This file exists because of a defect it would have caught: trace-hook.mjs
// has always handled `UserPromptSubmit`, but the event was never listed in
// `requiredHooks`, so no trace ever recorded a user prompt. Nothing under
// tests/ covered lib/ at all — the entire `npx specsmith init|update` surface,
// which is what downstream users actually run.
//
// Run with: `node tests/merge.test.mjs` or `npm test`.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mergeSettingsJson } from '../lib/merge.mjs';

let failures = 0;

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
  else { console.log(`ok   ${msg}`); }
}

// mergeSettingsJson logs progress to stdout; silence it so the test output
// stays readable. Restored after each call via withQuietLog().
function withQuietLog(fn) {
  const realLog = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = realLog; }
}

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'specsmith-merge-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  return root;
}

function readSettings(root) {
  return JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
}

// Every hook event specsmith relies on, and the command each must carry.
// Keep this list in sync with `requiredHooks` in lib/merge.mjs.
const TRACE = 'node .claude/scripts/trace-hook.mjs';
const EXPECTED_EVENTS = {
  PreToolUse: [
    TRACE,
    'node .claude/scripts/guard-repeat-commands.mjs',
    'node .claude/scripts/guard-scope.mjs',
    'node .claude/scripts/guard-orchestrator-discipline.mjs',
    'node .claude/scripts/guard-repeat-reads.mjs',
    'node .claude/scripts/guard-edit-cadence.mjs',
  ],
  PostToolUse: [TRACE],
  SubagentStop: [TRACE],
  Stop: [TRACE],
  UserPromptSubmit: [TRACE],
};

function commandsFor(settings, event) {
  const groups = settings.hooks?.[event] || [];
  return groups.flatMap((g) => (g.hooks || []).map((h) => h.command));
}

// ── Case 1: fresh install wires every required hook event ──
{
  const root = makeProject();
  withQuietLog(() => mergeSettingsJson(root, { dryRun: false, force: false }));
  const settings = readSettings(root);

  for (const [event, commands] of Object.entries(EXPECTED_EVENTS)) {
    const got = commandsFor(settings, event);
    assert(got.length > 0, `fresh install registers ${event}`);
    for (const cmd of commands) {
      assert(got.includes(cmd), `  ${event} carries ${cmd.replace('node .claude/scripts/', '')}`);
    }
  }
  rmSync(root, { recursive: true, force: true });
}

// ── Case 2: the specific regression — UserPromptSubmit reaches the trace hook ──
{
  const root = makeProject();
  withQuietLog(() => mergeSettingsJson(root, { dryRun: false, force: false }));
  const cmds = commandsFor(readSettings(root), 'UserPromptSubmit');
  assert(
    cmds.includes(TRACE),
    'UserPromptSubmit is wired to trace-hook.mjs (without it, traces record zero user prompts)'
  );
  rmSync(root, { recursive: true, force: true });
}

// ── Case 3: re-running the merge is idempotent (no duplicate hook entries) ──
{
  const root = makeProject();
  withQuietLog(() => {
    mergeSettingsJson(root, { dryRun: false, force: false });
    mergeSettingsJson(root, { dryRun: false, force: false });
    mergeSettingsJson(root, { dryRun: false, force: false });
  });
  const settings = readSettings(root);

  let duplicates = 0;
  for (const event of Object.keys(EXPECTED_EVENTS)) {
    const cmds = commandsFor(settings, event);
    if (new Set(cmds).size !== cmds.length) duplicates++;
  }
  assert(duplicates === 0, 'three merges produce no duplicate hook commands');
  assert(
    new Set(settings.permissions.allow).size === settings.permissions.allow.length,
    'three merges produce no duplicate permissions'
  );
  assert(
    new Set(settings.additionalDirectories).size === settings.additionalDirectories.length,
    'three merges produce no duplicate additionalDirectories'
  );
  rmSync(root, { recursive: true, force: true });
}

// ── Case 4: an existing settings.json keeps the user's own hooks and perms ──
{
  const root = makeProject();
  writeFileSync(
    join(root, '.claude', 'settings.json'),
    JSON.stringify({
      permissions: { allow: ['Bash(my-own-tool *)'] },
      additionalDirectories: ['./my-dir'],
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node my-guard.mjs' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node my-prompt-logger.mjs' }] }],
      },
    }, null, 2) + '\n'
  );

  withQuietLog(() => mergeSettingsJson(root, { dryRun: false, force: false }));
  const settings = readSettings(root);

  assert(
    settings.permissions.allow.includes('Bash(my-own-tool *)'),
    'existing user permission survives the merge'
  );
  assert(
    settings.additionalDirectories.includes('./my-dir'),
    'existing user additionalDirectory survives the merge'
  );
  assert(
    commandsFor(settings, 'PreToolUse').includes('node my-guard.mjs'),
    'existing user PreToolUse hook survives the merge'
  );
  assert(
    commandsFor(settings, 'UserPromptSubmit').includes('node my-prompt-logger.mjs'),
    'existing user UserPromptSubmit hook survives the merge'
  );
  assert(
    commandsFor(settings, 'UserPromptSubmit').includes(TRACE),
    'specsmith trace hook is added alongside the user\'s own UserPromptSubmit hook'
  );
  rmSync(root, { recursive: true, force: true });
}

// ── Case 5: dry-run writes nothing ──
{
  const root = makeProject();
  withQuietLog(() => mergeSettingsJson(root, { dryRun: true, force: false }));
  assert(
    !existsSync(join(root, '.claude', 'settings.json')),
    'dry-run does not create settings.json'
  );
  rmSync(root, { recursive: true, force: true });
}

// ── Case 6: invalid existing JSON is left alone, not clobbered ──
{
  const root = makeProject();
  const dest = join(root, '.claude', 'settings.json');
  writeFileSync(dest, '{ this is not json');
  const realError = console.error;
  console.error = () => {};
  try {
    withQuietLog(() => mergeSettingsJson(root, { dryRun: false, force: false }));
  } finally {
    console.error = realError;
  }
  assert(
    readFileSync(dest, 'utf8') === '{ this is not json',
    'malformed settings.json is preserved rather than overwritten'
  );
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
