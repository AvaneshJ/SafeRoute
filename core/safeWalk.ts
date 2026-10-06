/**
 * Safe Walk session state machine.
 *
 * idle → inviting → active → check_in_pending → sos
 *                              ↘ active (check-in)
 * active → completed | cancelled
 */

export const STATIONARY_THRESHOLD_M = 15;
/** Inactivity before automatic check-in (design: ~60s stationary). */
export const STATIONARY_TRIGGER_MS = 60 * 1000;
/** Check-in response window before guardian alert. */
export const CHECKIN_COUNTDOWN_MS = 15 * 1000;
/** No check-in for this long after the walk becomes active (avoids false positives at start). */
export const CHECKIN_GRACE_MS = 20 * 1000;
/**
 * Cap how much stillness one LOCATION event can add. GPS often pauses, then
 * delivers one update with a multi-minute gap — that must not instantly trip check-in.
 */
export const MAX_STATIONARY_STEP_MS = 5 * 1000;
export const INVITE_TIMEOUT_MS = 2 * 60 * 1000;
export const LOCATION_GAP_MS = 60 * 1000;

export type SafeWalkState =
  | "idle"
  | "inviting"
  | "active"
  | "check_in_pending"
  | "sos"
  | "completed"
  | "cancelled";

export type SafeWalkSession = {
  state: SafeWalkState;
  etaMinutes: number | null;
  stationaryMs: number;
  countdownMs: number | null;
  inviteExpiresAtMs: number | null;
  lastLocationAtMs: number | null;
  /** When the walk entered `active` — used for start grace. */
  activeSinceMs: number | null;
  failure: string | null;
};

export type SafeWalkEvent =
  | { type: "SELECT_DESTINATION"; nowMs: number }
  | { type: "GUARDIAN_ACCEPTED"; nowMs: number }
  | { type: "GUARDIAN_DECLINED" }
  | { type: "INVITE_TIMEOUT" }
  | { type: "LOCATION"; movedMeters: number; etaMinutes: number; nowMs: number }
  | { type: "STATIONARY_TIMEOUT" }
  | { type: "CHECKIN_CONFIRMED"; nowMs: number }
  | { type: "COUNTDOWN_ELAPSED" }
  | { type: "ARRIVED" }
  | { type: "USER_CANCELLED" }
  | { type: "LOCATION_LOST"; nowMs: number };

export function initialSafeWalk(): SafeWalkSession {
  return {
    state: "idle",
    etaMinutes: null,
    stationaryMs: 0,
    countdownMs: null,
    inviteExpiresAtMs: null,
    lastLocationAtMs: null,
    activeSinceMs: null,
    failure: null,
  };
}

export function reduceSafeWalk(
  session: SafeWalkSession,
  event: SafeWalkEvent
): SafeWalkSession {
  if (event.type === "USER_CANCELLED") {
    if (session.state === "idle" || session.state === "completed") {
      return session;
    }
    return { ...session, state: "cancelled", countdownMs: null, failure: null };
  }

  switch (session.state) {
    case "idle":
      if (event.type === "SELECT_DESTINATION") {
        return {
          ...session,
          state: "inviting",
          inviteExpiresAtMs: event.nowMs + INVITE_TIMEOUT_MS,
          failure: null,
        };
      }
      return session;

    case "inviting":
      if (event.type === "GUARDIAN_ACCEPTED") {
        return {
          ...session,
          state: "active",
          inviteExpiresAtMs: null,
          stationaryMs: 0,
          lastLocationAtMs: event.nowMs,
          activeSinceMs: event.nowMs,
          failure: null,
        };
      }
      if (event.type === "GUARDIAN_DECLINED" || event.type === "INVITE_TIMEOUT") {
        return {
          ...session,
          state: "cancelled",
          inviteExpiresAtMs: null,
          failure:
            event.type === "INVITE_TIMEOUT"
              ? "Guardian did not respond. Safe Walk was not started."
              : "Guardian declined. Safe Walk was not started.",
        };
      }
      return session;

    case "active":
      if (event.type === "ARRIVED") {
        return { ...session, state: "completed", etaMinutes: 0, stationaryMs: 0 };
      }
      if (event.type === "STATIONARY_TIMEOUT") {
        return {
          ...session,
          state: "check_in_pending",
          countdownMs: CHECKIN_COUNTDOWN_MS,
          stationaryMs: STATIONARY_TRIGGER_MS,
        };
      }
      if (event.type === "LOCATION") {
        const moved = event.movedMeters >= STATIONARY_THRESHOLD_M;
        const step = moved
          ? 0
          : Math.min(MAX_STATIONARY_STEP_MS, delta(session, event.nowMs));
        let stationaryMs = moved ? 0 : session.stationaryMs + step;

        // Grace window after start / after a confirmed check-in
        const activeSince = session.activeSinceMs ?? event.nowMs;
        if (event.nowMs - activeSince < CHECKIN_GRACE_MS) {
          stationaryMs = 0;
        }

        const next: SafeWalkSession = {
          ...session,
          etaMinutes: event.etaMinutes,
          stationaryMs,
          lastLocationAtMs: event.nowMs,
          failure: null,
        };
        if (stationaryMs >= STATIONARY_TRIGGER_MS) {
          return {
            ...next,
            state: "check_in_pending",
            countdownMs: CHECKIN_COUNTDOWN_MS,
          };
        }
        return next;
      }
      if (event.type === "LOCATION_LOST") {
        // No fix yet — don't treat "never received GPS" as a full gap.
        if (session.lastLocationAtMs == null) return session;
        const gap = event.nowMs - session.lastLocationAtMs;
        if (gap >= LOCATION_GAP_MS) {
          return {
            ...session,
            state: "check_in_pending",
            countdownMs: CHECKIN_COUNTDOWN_MS,
            failure: "Location updates stopped.",
          };
        }
      }
      return session;

    case "check_in_pending":
      if (event.type === "CHECKIN_CONFIRMED") {
        return {
          ...session,
          state: "active",
          stationaryMs: 0,
          countdownMs: null,
          lastLocationAtMs: event.nowMs,
          // Re-arm grace so check-in can't instantly reappear
          activeSinceMs: event.nowMs,
          failure: null,
        };
      }
      if (event.type === "COUNTDOWN_ELAPSED") {
        return { ...session, state: "sos", countdownMs: 0 };
      }
      if (event.type === "LOCATION") {
        return { ...session, etaMinutes: event.etaMinutes, lastLocationAtMs: event.nowMs };
      }
      return session;

    case "sos":
      // Guardian was already alerted; the walker can still confirm they're fine.
      if (event.type === "CHECKIN_CONFIRMED") {
        return {
          ...session,
          state: "active",
          stationaryMs: 0,
          countdownMs: null,
          lastLocationAtMs: event.nowMs,
          activeSinceMs: event.nowMs,
          failure: null,
        };
      }
      if (event.type === "ARRIVED") {
        return { ...session, state: "completed", etaMinutes: 0, stationaryMs: 0 };
      }
      return session;

    default:
      return session;
  }
}

function delta(session: SafeWalkSession, nowMs: number): number {
  if (session.lastLocationAtMs == null) return 0;
  return Math.max(0, nowMs - session.lastLocationAtMs);
}
