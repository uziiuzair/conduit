# Conduit mobile — chat companion (front-end shell)

A React Native (Expo) app for the Conduit mobile companion: a **per-agent chat UI
with inline status actions**, instead of mirroring the desktop terminal. See the
design in
[`docs/superpowers/specs/2026-06-30-conduit-mobile-chat-companion-design.md`](../docs/superpowers/specs/2026-06-30-conduit-mobile-chat-companion-design.md).

## Status: testable shell, mock-backed

This is the **P0 front-end shell**. It runs on a real device and demonstrates the full
UX, but it is driven by **mock data** (`src/data/mock.ts`) with **simulated
interactions** — it does **not** yet talk to a live Conduit bridge. Wiring it to the
structured bridge + approval broker is **P1/P2** (a reviewed phase, because it touches
the desktop's load-bearing PTY and `hooks.rs`).

What works to test right now:

- **Projects screen** — projects → agents triage list, live status vocabulary
  (needs-you / running + activity + `n/m` todos / done / idle), "n need you" summary.
- **Chat screen** — compact timeline (file reads, commands, edits), chat bubbles,
  to-do cards, and the **approval card** with working **Approve / Deny**.
- **Composer** — type a prompt, send it (appends to the feed; a simulated reply follows).
- **Theme switcher** — the three-swatch control (top-right) cycles all **three Warm
  schemes** (Near-Black / Dim / Light), ported 1:1 from the desktop `src/themes.ts`.

## Run it

> ⚠️ **Not via App Store Expo Go.** SDK 56 isn't shipped to the App Store / Play Store
> Expo Go (frozen at SDK 54 since Expo's May 2026 change), so the QR-into-Expo-Go flow
> does **not** work here. Use a **development build** (needs Xcode, which compiles fine):

**iOS Simulator** (verified: `Build Succeeded`):
```bash
cd mobile
npx expo run:ios
```

**Physical iPhone** (development build):
```bash
npx expo run:ios --device
```
Plug in + unlock the iPhone and tap **Trust**; if signing fails, open `ios/*.xcworkspace`
in Xcode once and pick a team under Signing & Capabilities; keep phone + Mac on the same
Wi-Fi (the dev build connects to Metro). A free Apple ID "Personal Team" signature lasts
**7 days** — re-run to refresh.

**Web** (rough, instant — `react-native-web` + `react-dom` are installed):
```bash
npx expo start   # then press w
```

First native build runs prebuild + `pod install` + compile (minutes); rebuilds are fast.
Don't run two Metro instances at once — they fight over port 8081.

## Checks

```bash
npm test          # jest — pure logic (status mapping + feed reducer), 21 tests
npm run typecheck # tsc --noEmit (strict)
```

## Layout

```
App.tsx                      root: ThemeProvider + projects⇆chat navigation
src/theme/
  palettes.ts                the 3 Warm schemes as framework-neutral tokens (← src/themes.ts)
  ThemeContext.tsx           ThemeProvider + useTheme + cycle()
  layout.ts                  lightweight safe-area insets
src/data/
  types.ts                   Agent / Project / ChatItem model (mirrors desktop status vocab)
  mock.ts                    mock projects + per-agent chat feeds  ← swap for BridgeClient (P2)
src/logic/
  status.ts (+ .test.ts)     tool→activity mapping, status dots, badges
  feed.ts   (+ .test.ts)     prompt/approval reducer, event grouping
src/components/atoms.tsx     Avatar / NeedsPill / StatusDot / ThemeButton
src/screens/
  ProjectsScreen.tsx         triage home
  ChatScreen.tsx             timeline + bubbles + approval card + composer
```

## Next (per the spec)

- **P1** structured bridge + approval broker (Rust) + interactive-mode approval test.
- **P2** replace `src/data/mock.ts` with a live `BridgeClient` (WebSocket).
- **P3** pairing (QR + X25519 + token) + tunnel. **P4** APNs push.
