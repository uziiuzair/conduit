# Usage meters: one direction, one set of windows, one truth per audience

**Status:** shipped (0.27.0 the normalization, 0.28.1 the cross-view fixes)
**Touches:** `src/usageRows.ts`, `src/components/UsagePanel.tsx`,
`src/components/UsagePrefsPanel.tsx`, `src/hooks/useClaudeAmbient.ts`,
`src-tauri/src/claude_usage.rs`, `src/store.ts`

## The problem

The usage panel contradicted itself in four separate ways. Users reported it twice, in the
plainest possible terms: *"the percentage shows the amount left, but the bar shows the amount
used"*, then *"the numbers don't match across the different views."* Both were true, and for
different reasons.

## 1. The label and the bar pointed opposite ways

`UWindow` carried a `mode` (`"remaining" | "used"`) plus a `value` whose meaning depended on
it. Claude and Command Code report `pctUsed`; agy reports `remainingFraction`; context
reports a used percentage. The panel branched on `mode` in three places — once for the label,
once for the bar fill, once for the colour ramp — and one branch was backwards. A meter read
**"62% left"** over a bar filled to **38%**.

**Fix: store one direction.** `UWindow.used` is the fraction *consumed*, 0..1, converted at
the row builder. agy's `remainingFraction` is flipped exactly once, at `agyRow` — the only
place that knows agy reports headroom. Nothing downstream branches.

Then `meterView(w, metric)` returns the label number **and** the bar fraction as one value,
which is what makes the class of bug unrepresentable:

```ts
export function meterView(w: UWindow, metric: UsageMetric): MeterView {
  const used = clamp01(w.used);
  const fraction = metric === "used" ? used : 1 - used;
  return { fraction, pct: Math.round(fraction * 100),
           word: metric === "used" ? "used" : "left",
           severity: used };
}
```

`severity` is **always consumption**, whichever direction is displayed. The colour ramp, the
low-alert and the sort key off danger, not off how the user likes to read the number — a
meter showing "8% left" must be red.

**Default is `"used"`**, because that is what every agent's own view shows:
`claude /usage` prints `Current session ████░░░░░░ 18% · resets 3:50pm`, and quota dashboards
generally count up toward a cap. `"remaining"` is a supported preference
(Settings → Usage display), not a fallback, and it flips the number, the bar and the summary
together.

## 2. Three vendors named the same window three ways

Claude reported "5-hour window" / "Weekly (all)" / "Weekly (Opus)"; Command Code "5-hour
window" / "Weekly"; agy its own per-pool variants. Stacked in one panel those read as
different *kinds* of limit rather than one limit measured by three vendors.

`kind` was already the classification the window filter used, so the label is now derived
from it — `windowLabel(kind, pool?)`. Only agy keeps a pool prefix (`Gemini · Weekly`),
because its pools are genuinely separate quotas and would otherwise collapse into two rows
named "5-hour" and "Weekly".

## 3. The panel and the router asked different questions of the same number

`URow.minRemaining` served two masters. For the **router**, `summaryRemaining([])` answering
`1` is correct: an agent with no usage API must not read as spent, or "no meter" would come
to mean "never route here". For the **panel**, that same `1` was drawn as a healthy green
dot — so an account nothing had been read from looked fine.

Separately, the panel computed its summary number, its dot, its sort and its low-alert over
**all** windows while drawing meters for the **filtered** ones. Hide the Opus window and the
headline number described a meter that was not on screen.

And the collapsed summary printed one bare number — the account's *worst* window — above
meters reading 18, 3 and 79, with nothing saying which. That reads as a contradiction rather
than a worst case.

**Fix: split the audiences, and derive the panel's view once.**

- `URow.minRemaining` stays unfiltered — routing truth.
- `visibleWindows(windows, prefs.windows)` is the one definition of what the panel shows.
- `rowHealth(visible)` returns `remaining: number | null`, where **null means unknown** and is
  deliberately distinct from both 0 and 1. The dot gets its own hollow `unknown` state; the
  sort puts unknown last (not most critical, and certainly not healthiest); the low-alert
  counts it separately rather than folding it into "all clear".
- `worstWindow` returns the window the number came from, so the summary can **name** it:
  `79% used · Weekly · Opus` — visibly the same as the meter below it.
- A single `RowView { row, wins, health }` is built once and every layout reads it, so no two
  layouts can compute a different number.

Also fixed here: the "selected" layout silently fell back to `rows.find(r => r.agent === …)`
when a session named no account — whichever account happened to sort first. With two Claude
accounts signed in that showed one account's figures for a session running on the other, and
"stacked" then showed something different for the same session. The fallback is now taken
only when it is unambiguous (exactly one account for that agent); otherwise the panel asks
the user to pick.

## 4. Conduit was rate-limiting itself

`/api/oauth/usage` throttles. Conduit polled it **every 60 seconds per account**, on top of
the user's real `claude` sessions hitting the same endpoint, and re-fired on every
`visibilitychange` — so alt-tabbing was itself a poll. A 429 body parses fine as JSON but has
no windows, so `parse_plan` returned `None`, `plan_source` became `"unavailable"`, and that
account's meters **blanked**. Combined with problem 3, the blanked account then drew a
healthy green dot. The panel changed its mind minute to minute depending on which account got
through.

**Fix, both ends:**

- `ClaudeAuth.last_plan` caches the most recent *successful* read per account and serves it as
  `planSource: "stale"` (max 1 hour old) when a poll fails. The row keeps its meters and gains
  a quiet "last known" chip. Memory-only, like the tokens; evicted with the account, because a
  recycled id serving the previous holder's usage is worse than serving nothing.
- `useClaudeAmbient` splits the ticks: status stays at 60 s (a cheap, different endpoint), the
  quota fetch moves to **5 minutes** and is not re-fired on every visibility change. Both
  windows Claude reports are measured in *hours* — 60 s was never resolution, only load.

## Invariants to keep

- `UWindow.used` is the only stored direction. Convert at the row builder, never downstream.
- The number and the bar come from **one** `meterView` call.
- `severity` is consumption; `fraction` is presentation. Colour follows severity.
- `URow.minRemaining` is the router's; anything the panel *shows* derives from
  `visibleWindows` + `rowHealth`.
- Unknown is neither 0 nor 1 in the UI. It has its own dot.
- `usageRows.ts` must stay importable without `store.ts` — hence `accountKey` lives there and
  the store re-exports it. Importing the store under the node-env vitest throws on
  `localStorage`, and `usageRows.test.ts` is what holds all of the above in place.
