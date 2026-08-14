# Browser verification techniques

Playwright-MCP technique reference for the `evaluating-phases` agent. These
are *how to drive the browser well* notes, not the evaluation protocol — the
protocol (what to verify, how to score it, what blocks a phase) stays in
`agents/evaluator.md`.

Read the relevant section when you hit the symptom. Do not read this file
preemptively.

---

## Selector hygiene (read this BEFORE clicking anything)

Playwright refs (`e123`) and positional selectors (`getByText('xxx').nth(N)`)
go stale fast. If a panel opens, a row is added or removed, or any state
change re-renders the page, every ref from a previous snapshot is suspect
and `nth()` indices may have shifted by one.

**Rules:**

- Prefer `getByRole('button', { name: 'Stable Label' })` over `nth()` and
  over numeric refs. Role + accessible name survives most re-renders.
- Before clicking a numeric ref, confirm it's from the **most recent**
  snapshot. If anything has happened since (a click, a navigation, a form
  fill, a network response), take a fresh snapshot first.
- Never use `nth(N)` for elements whose index depends on dynamic state
  (e.g. "the 4th `:00` cell" — that 4 changes when slots get booked).
  If the project's UI lacks stable test ids for such elements, write the
  workaround you discovered to `pipeline/procedures.md`.

---

## Never return an unresolved Promise from `browser_evaluate`

Expressions like `document.fonts.ready`, `new Promise(...)`,
`fetch(...).then(...)`, or anything that awaits a network or asset event can
hang indefinitely if the underlying event never fires (font 404, slow compile,
idle network).

Return plain synchronous values only. For "is the page ready" checks, use
`document.readyState === 'complete'` or `mcp__playwright__browser_wait_for`
with a short timeout — not `document.fonts.ready`.

---

## Batch computed-style probes into ONE `browser_evaluate` call

Do NOT call `getComputedStyle(document.querySelector('<selector>'))` once per
element per property — that is one model round-trip per probe, and a fidelity
pass touching a dozen elements turns into dozens of sequential
`browser_evaluate` calls. The dominant cost in long evaluation cycles is the
number of round-trips, not the work each one does.

Decide the full list of selectors and properties you care about FIRST — derive
them from the failed pixel-diff `regions[]`, the `designs/coverage.md`
component list, and the prototype HTML — then probe them all in a **single**
`browser_evaluate` that returns one keyed object:

```js
() => {
  // selector → properties of interest for this fidelity check
  const probe = {
    '.hero h1':   ['fontSize', 'lineHeight', 'fontWeight', 'color', 'marginBottom'],
    'header nav': ['gap', 'paddingTop', 'paddingBottom', 'height'],
    '.card':      ['padding', 'borderRadius', 'boxShadow', 'gap'],
  };
  const out = {};
  for (const [sel, props] of Object.entries(probe)) {
    const el = document.querySelector(sel);
    if (!el) { out[sel] = null; continue; } // null = selector missed; fix the selector, don't re-probe blindly
    const cs = getComputedStyle(el);
    out[sel] = Object.fromEntries(props.map((p) => [p, cs[p]]));
  }
  return out;
}
```

One call, one result table you compare against the prototype's values. Only
issue a second `browser_evaluate` if the first surfaced a `null` (selector
wrong) or revealed a new element you now need to inspect — never to fetch "the
next property" of an element you already had in hand.
