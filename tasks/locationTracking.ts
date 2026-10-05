import { auth, db } from "@/config/firebase";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";

export const SAFETY_LOCATION_TASK = "saferoute-safety-location";
export const TRACKING_PAYLOAD_KEY = "@SafeRoute:safetyTrackingPayload";

export type TrackingPayload = {
  collection: "routes" | "emergencies";
  sessionId: string;
  userId: string;
};

export type TrackingProgress = {
  etaMinutes?: number | null;
  remainingM?: number | null;
};

export async function writeTrackedLocation(
  payload: TrackingPayload,
  location: Location.LocationObject,
  source: "foreground" | "background",
  progress?: TrackingProgress,
): Promise<void> {
  const extras: Record<string, number> = {};
  if (typeof progress?.etaMinutes === "number" && Number.isFinite(progress.etaMinutes)) {
    extras.etaMinutes = Math.max(0, Math.round(progress.etaMinutes));
  }
  if (typeof progress?.remainingM === "number" && Number.isFinite(progress.remainingM)) {
    extras.remainingM = Math.max(0, Math.round(progress.remainingM));
  }
  await setDoc(
    doc(db, payload.collection, payload.sessionId, "live", "current"),
    {
      ownerId: payload.userId,
      location: {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        accuracy: location.coords.accuracy,
        heading: location.coords.heading,
        speed: location.coords.speed,
      },
      recordedAtMs: location.timestamp,
      source,
      updatedAt: serverTimestamp(),
      ...extras,
    },
    { merge: true },
  );
}

const OPEN_STATES: Record<TrackingPayload["collection"], string[]> = {
  routes: ["active", "check_in_pending", "sos"],
  emergencies: ["active"],
};

/** null when it can't be determined (offline, auth not restored yet). */
export async function isTrackedSessionOpen(payload: TrackingPayload): Promise<boolean | null> {
  if (auth.currentUser?.uid !== payload.userId) return null;
  try {
    const snap = await getDoc(doc(db, payload.collection, payload.sessionId));
    if (!snap.exists()) return false;
    return OPEN_STATES[payload.collection].includes(String(snap.get("state") ?? ""));
  } catch {
    return null;
  }
}

/** Stops the OS location task and forgets the session. */
export async function haltSafetyTracking(): Promise<void> {
  try {
    if (await TaskManager.isTaskRegisteredAsync(SAFETY_LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(SAFETY_LOCATION_TASK);
    }
  } finally {
    await AsyncStorage.removeItem(TRACKING_PAYLOAD_KEY);
  }
}

TaskManager.defineTask(SAFETY_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.error("Safety location task failed", error);
    return;
  }
  let payload: TrackingPayload | null = null;
  try {
    const raw = await AsyncStorage.getItem(TRACKING_PAYLOAD_KEY);
    if (!raw) {
      // Nothing to share for: don't keep the GPS running.
      await haltSafetyTracking();
      return;
    }
    payload = JSON.parse(raw) as TrackingPayload;
    const locations = (
      data as { locations?: Location.LocationObject[] } | undefined
    )?.locations;
    const latest = locations?.[locations.length - 1];
    if (latest) await writeTrackedLocation(payload, latest, "background");
  } catch (taskError) {
    // Rules reject live writes once the session is closed; stop tracking when that's why.
    if (payload && (taskError as { code?: string })?.code === "permission-denied") {
      if ((await isTrackedSessionOpen(payload)) === false) {
        await haltSafetyTracking();
        return;
      }
    }
    console.error("Could not publish background safety location", taskError);
  }
});
