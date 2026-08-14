# Coding pitfalls

Language- and tooling-level traps that have each cost a real build cycle.
Referenced from `agents/developer.md`; read the entry when the symptom matches,
not preemptively.

These are general coding hazards rather than pipeline rules. They live here so
the developer agent file stays an operational checklist — every one of them
used to sit inline, and each new incident added another paragraph to a prompt
loaded on every dispatch.

---

## `process.exit()` inside `try` / `finally`

Calling `process.exit()` from inside a `try` block can short-circuit a
`finally` block that is supposed to restore state (lock file, mutated config,
env var, temp directory, watcher cleanup). Node's exact behaviour depends on
version and on what is in the `finally`, but the failure mode is consistent:
your `finally` does not run and the world is left mid-mutation.

Capture the exit code inside `try`, let `finally` run, then exit after both
blocks have completed.

```js
// BAD — finally may not run, mutation leaks
try {
  mutateConfig();
  const code = await spawnChild();
  process.exit(code);                    // ⚠ skips finally
} finally {
  restoreConfig();
}

// GOOD — finally always runs, exit happens after
let code = 0;
try {
  mutateConfig();
  code = await spawnChild();
} finally {
  restoreConfig();
}
process.exit(code);
```

---

## JSX comment placement

JSX braces `{/* ... */}` are only valid INSIDE JSX — between elements, or as
siblings of children. They are NOT valid in the whitespace zone right after
`return (` and before the root element. Putting them there parses as multiple
expressions in a single return, which is a syntax error like `Expected ','`,
got `'{'`.

Multi-line context comments go ABOVE `return (` as plain `//` lines. JSX
comments stay inside JSX.

```tsx
// This comment is fine — it lives in the function body, not in JSX.
return (
  <div>
    {/* This comment is also fine — it's a child of <div>. */}
    <span>hello</span>
  </div>
);
```

A self-broken build costs a full cycle to diagnose (curl returns 500, the
dev-server log surfaces the SyntaxError) — catch it at edit time.

---

## `pgrep -f` shell-wrapper false positives

`pgrep -f "<pattern>"` matches the bash wrapper currently executing your
`pgrep` command itself, so you will see a "live" PID that vanishes by the time
you try to kill it.

Cross-check before acting: `kill -0 <pid>` confirms liveness, and
`cat /proc/<pid>/cmdline` (or `ps -p <pid> -o args=`) shows the actual current
command rather than historic argv from a parent shell snapshot. Do not loop on
phantom PIDs.

---

## `head` / `tail` on generated, minified, or barrel-export files

`head` and `tail` are LINE-based, not byte-based. A barrel-export `.d.ts` (for
example `node_modules/lucide-react/dist/lucide-react.d.ts`) or a minified
bundle often packs thousands of exports onto a single 10K+ character line, so
`grep "Foo" big.d.ts | head -10` can return 30 KB+ of one mostly-irrelevant
line.

When grepping such files, pipe through `cut -c1-200` to bound line width:

```bash
grep "Foo" big.d.ts | head -10 | cut -c1-200
```

The same gotcha applies to webpack chunks, `tsc` error output with deep type
expansion, and any generated artifact.
