// Mirror of packages/mcp/src/guard.ts. Mirrored here (decision logic only —
// the caches these read are built shim-side and land in the session state
// file, which these hooks read with zero network/DB access so the hot path
// stays fast): parseGuardMode, isContested, collisionDecision (now routed
// through isContested), collisionDecisionV2, ackGateDecision, stopGateDecision,
// minutesLeft (NaN-safe), listWithOverflow, plus DEFAULT_WINDOW_MS/MAX_WARNED.
// Intentionally NOT mirrored — these build/reconcile the caches and only ever
// run shim-side (packages/mcp), never in the hook process: buildOthersCache,
// buildPendingInbound, reconcileCollisionSent. If you change reason text,
// thresholds, or semantics on the ts side, change it here too.

const DEFAULT_WINDOW_MS = 30 * 60_000
const MAX_WARNED = 100

function ago(iso, nowMs) {
  const ms = nowMs - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return "just now"
  const m = Math.round(ms / 60_000)
  if (m < 1) return "under a minute ago"
  return `${m}m ago`
}

// The shared contest predicate: another live session touched this path within
// the activity window. Both collision guards (v1 warn-once and v2 modes) key
// off it.
function isContested(entries, relPath, nowMs, windowMs) {
  return (entries ?? []).find((e) => {
    if (!e || e.path !== relPath) return false
    const t = new Date(e.touched_at).getTime()
    return Number.isFinite(t) && nowMs - t >= 0 && nowMs - t <= windowMs
  })
}

export function collisionDecision({ entries, relPath, warned, nowMs, windowMs = DEFAULT_WINDOW_MS }) {
  const warnedList = Array.isArray(warned) ? warned : []
  if (!Array.isArray(entries) || !relPath) return { warn: false }
  if (warnedList.includes(relPath)) return { warn: false }

  const hit = isContested(entries, relPath, nowMs, windowMs)
  if (!hit) return { warn: false }

  return {
    warn: true,
    reason:
      `Continuity: ${hit.agent_label} (${hit.user_name}) edited ${relPath} ${ago(hit.touched_at, nowMs)} ` +
      `in another live session. Check agent_file_activity_recent / coordinate before editing; ` +
      `retry the edit to proceed if you decide it's safe.`,
    warned: [...warnedList, relPath].slice(-MAX_WARNED),
  }
}

// Legacy plugin configs stored a boolean collisionGuard; map those onto the
// mode enum. Unknown values fall back to the default (negotiate).
export function parseGuardMode(raw) {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "off" || v === "false" || v === "0") return "off"
  if (v === "warn") return "warn"
  return "negotiate"
}

// Mirror of guard.ts's minutesLeft (which is shared with the shim's delta
// renderer). NaN-safe: malformed timestamps render as 0.
export function minutesLeft(expiresAt, nowMs) {
  const mins = Math.ceil((new Date(expiresAt).getTime() - nowMs) / 60_000)
  return Number.isFinite(mins) ? Math.max(0, mins) : 0
}

// Reasons list at most five items; the suffix keeps the count honest when the
// list is truncated.
function listWithOverflow(due, render) {
  const shown = due.slice(0, 5).map(render).join("; ")
  return due.length > 5 ? `${shown}; …and ${due.length - 5} more` : shown
}

// Mode-aware collision decision. warn = the original warn-once behavior;
// negotiate = deny until a collision message on the path is answered or
// expires (the timeout-override rule — a block must never outlive its window).
export function collisionDecisionV2(args) {
  const { mode, entries, relPath, nowMs, windowMs = DEFAULT_WINDOW_MS } = args
  if (mode === "off") return { action: "allow" }

  if (mode === "warn") {
    const base = collisionDecision({ entries, relPath, warned: args.warned, nowMs, windowMs })
    return base.warn
      ? { action: "deny", reason: base.reason, warned: base.warned }
      : { action: "allow" }
  }

  // negotiate
  const other = isContested(entries, relPath, nowMs, windowMs)
  if (!other) return { action: "allow" }

  const sent = args.collisionSent?.[relPath]
  if (!sent) {
    return {
      action: "deny",
      reason:
        `Continuity: ${other.agent_label} (${other.user_name}) is working in ${relPath}. ` +
        `Coordinate first: message_send({ to_session: "${other.session_id}", about_file: "${relPath}", body: "<what you want to change>" }). ` +
        `The block lifts when they respond, or expires on its own — pick other work meanwhile.`,
    }
  }
  // Responded and dismissed both resolve the gate — the resolution text reaches
  // the sender via prompt-sync, so proceeding is informed, not blind.
  if (sent.status !== "pending") return { action: "allow" }
  const expiresMs = new Date(sent.expires_at).getTime()
  // Timeout override (and fail-open on malformed timestamps): a block must
  // never outlive its window.
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) return { action: "allow" }
  return {
    action: "deny",
    reason:
      `Continuity: still awaiting a response on ${relPath} (expires in ${minutesLeft(sent.expires_at, nowMs)}m). ` +
      `Work elsewhere until then; the block lifts automatically on response or expiry.`,
  }
}

// Deny-once gate on edits while response-required messages sit unanswered.
// One nudge, keyed by message id; the Stop gate is the backstop.
export function ackGateDecision(args) {
  const warned = Array.isArray(args.messageWarned) ? args.messageWarned : []
  const due = (args.pendingInbound ?? []).filter(
    (m) =>
      m?.requires_response &&
      new Date(m.expires_at).getTime() > args.nowMs &&
      !warned.includes(m.message_id),
  )
  if (due.length === 0) return { action: "allow" }
  const list = listWithOverflow(due, (m) => `${m.message_id} from ${m.from_label}: "${m.body.slice(0, 80)}"`)
  return {
    action: "deny",
    reason:
      `Continuity: ${due.length} message(s) require your response before more edits — ${list}. ` +
      `Use message_respond(id, response) or message_dismiss(id, reason); they expire on their own otherwise. ` +
      `Retry the edit to proceed.`,
    warned: [...warned, ...due.map((m) => m.message_id)].slice(-MAX_WARNED),
  }
}

// Turn-end gate: fresh response-required items block the Stop once per stop
// chain (stop_hook_active guards the loop); expired items never block.
export function stopGateDecision(args) {
  if (args.stopHookActive) return { block: false }
  const due = (args.pendingInbound ?? []).filter(
    (m) => m?.requires_response && new Date(m.expires_at).getTime() > args.nowMs,
  )
  if (due.length === 0) return { block: false }
  const list = listWithOverflow(
    due,
    (m) => `message_respond("${m.message_id}", …) — from ${m.from_label}: "${m.body.slice(0, 80)}"`,
  )
  return {
    block: true,
    reason: `Continuity: before ending the turn, answer or dismiss pending message(s): ${list}. Use message_dismiss(id, reason) if a response isn't warranted.`,
  }
}
