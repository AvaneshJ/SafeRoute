/**
 * The walker's in-progress Safe Walk: persisted so the Safe Walk tab can
 * resume or end it after the live screen is gone (navigation, app restart).
 */

import { functions } from "@/config/firebase";
import { stopSafetyTrackingFor } from "@/services/safetyTracking";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { httpsCallable } from "firebase/functions";

const ACTIVE_WALK_KEY = "@SafeRoute:activeSafeWalk";

export type ActiveSafeWalk = {
  sessionId: string;
  /** Route params SafeWalkLive was opened with, reused to resume it. */
  params: Record<string, string>;
};

export async function saveActiveSafeWalk(walk: ActiveSafeWalk): Promise<void> {
  await AsyncStorage.setItem(ACTIVE_WALK_KEY, JSON.stringify(walk));
}

export async function loadActiveSafeWalk(): Promise<ActiveSafeWalk | null> {
  try {
    const raw = await AsyncStorage.getItem(ACTIVE_WALK_KEY);
    return raw ? (JSON.parse(raw) as ActiveSafeWalk) : null;
  } catch {
    return null;
  }
}

export async function clearActiveSafeWalk(sessionId?: string): Promise<void> {
  if (sessionId) {
    const current = await loadActiveSafeWalk();
    if (current && current.sessionId !== sessionId) return;
  }
  await AsyncStorage.removeItem(ACTIVE_WALK_KEY);
}

/** Session id of the SafeWalkLive screen currently mounted, if any. */
let mountedWalkSessionId: string | null = null;

/** Pass `onlyIf` when unmounting so a newer screen's registration survives. */
export function setMountedSafeWalk(
  sessionId: string | null,
  onlyIf?: string,
): void {
  if (onlyIf !== undefined && mountedWalkSessionId !== onlyIf) return;
  mountedWalkSessionId = sessionId;
}

export function isSafeWalkScreenMounted(sessionId: string): boolean {
  return mountedWalkSessionId === sessionId;
}

export type EndSessionResult =
  | { ok: true; alreadyClosed: boolean }
  | { ok: false; error: string };

/**
 * Closes a Safe Walk / live-share session on the server and stops this
 * phone's tracking for it. A session that is already closed counts as success.
 */
export async function endSafetySession(
  sessionId: string,
  type: "ended" | "cancelled" = "ended",
): Promise<EndSessionResult> {
  let alreadyClosed = false;
  try {
    await httpsCallable(functions, "publishSafetyEvent")({
      sessionId,
      type,
      eventId: `${sessionId}-${type}`,
    });
  } catch (error) {
    const code = String((error as { code?: string })?.code ?? "");
    if (code.endsWith("failed-precondition") || code.endsWith("not-found")) {
      alreadyClosed = true;
    } else {
      return {
        ok: false,
        error:
          error instanceof Error && error.message
            ? error.message
            : "Could not reach SafeRoute.",
      };
    }
  }
  await stopSafetyTrackingFor("routes", sessionId).catch(console.warn);
  await clearActiveSafeWalk(sessionId).catch(console.warn);
  return { ok: true, alreadyClosed };
}
