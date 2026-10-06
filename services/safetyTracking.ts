import { auth, db } from "@/config/firebase";
import { downsamplePath } from "@/core/guardianSafety";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import {
  haltSafetyTracking,
  isTrackedSessionOpen,
  SAFETY_LOCATION_TASK,
  TRACKING_PAYLOAD_KEY,
  type TrackingPayload,
  type TrackingProgress,
  writeTrackedLocation,
} from "@/tasks/locationTracking";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";

export async function publishSafetyLocation(
  payload: TrackingPayload,
  location: Location.LocationObject,
  progress?: TrackingProgress,
): Promise<void> {
  if (auth.currentUser?.uid !== payload.userId) return;
  await writeTrackedLocation(payload, location, "foreground", progress);
}

/** Attaches the planned route to live/current so guardians can draw it. */
export async function publishSafetyRoute(
  payload: TrackingPayload,
  path: Array<{ latitude: number; longitude: number }>,
): Promise<void> {
  if (auth.currentUser?.uid !== payload.userId || path.length < 2) return;
  await setDoc(
    doc(db, payload.collection, payload.sessionId, "live", "current"),
    {
      ownerId: payload.userId,
      routePath: downsamplePath(path, 300).map((p) => ({
        latitude: Math.round(p.latitude * 1e6) / 1e6,
        longitude: Math.round(p.longitude * 1e6) / 1e6,
      })),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

export async function startSafetyTracking(
  collection: TrackingPayload["collection"],
  sessionId: string,
): Promise<{ payload: TrackingPayload; background: boolean }> {
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in is required to share a live location.");

  const foreground = await Location.requestForegroundPermissionsAsync();
  if (foreground.status !== Location.PermissionStatus.GRANTED) {
    throw new Error("Location permission is required.");
  }

  const payload: TrackingPayload = {
    collection,
    sessionId,
    userId: user.uid,
  };
  await AsyncStorage.setItem(TRACKING_PAYLOAD_KEY, JSON.stringify(payload));

  const first = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.High,
  });
  await publishSafetyLocation(payload, first);

  let background = false;
  try {
    const permission = await Location.requestBackgroundPermissionsAsync();
    if (permission.status === Location.PermissionStatus.GRANTED) {
      const running = await TaskManager.isTaskRegisteredAsync(
        SAFETY_LOCATION_TASK,
      );
      if (running) {
        await Location.stopLocationUpdatesAsync(SAFETY_LOCATION_TASK);
      }
      await Location.startLocationUpdatesAsync(SAFETY_LOCATION_TASK, {
        accuracy: Location.Accuracy.High,
        timeInterval: 10_000,
        distanceInterval: 5,
        deferredUpdatesInterval: 10_000,
        pausesUpdatesAutomatically: false,
        foregroundService: {
          notificationTitle: "SafeRoute live safety tracking",
          notificationBody: "Your guardian can see your latest location.",
          notificationColor: "#4F46E5",
        },
      });
      background = true;
    }
  } catch (error) {
    console.warn("Background tracking unavailable; foreground tracking remains active.", error);
  }
  return { payload, background };
}

export async function stopSafetyTracking(): Promise<void> {
  await haltSafetyTracking();
}

/**
 * Stops tracking only if it belongs to this session, so ending a walk can't
 * cut off an SOS that started sharing afterwards.
 */
export async function stopSafetyTrackingFor(
  collection: TrackingPayload["collection"],
  sessionId: string,
): Promise<void> {
  const raw = await AsyncStorage.getItem(TRACKING_PAYLOAD_KEY);
  if (raw) {
    try {
      const payload = JSON.parse(raw) as TrackingPayload;
      if (payload.collection !== collection || payload.sessionId !== sessionId) {
        return;
      }
    } catch {
      // Unreadable payload: fall through and halt.
    }
  }
  await haltSafetyTracking();
}

/**
 * Stops leftover tracking from a session that was closed elsewhere (server expiry,
 * another device, a crash before cleanup). Run once auth is restored.
 */
export async function reconcileSafetyTracking(): Promise<void> {
  const raw = await AsyncStorage.getItem(TRACKING_PAYLOAD_KEY);
  if (!raw) {
    if (await TaskManager.isTaskRegisteredAsync(SAFETY_LOCATION_TASK)) {
      await haltSafetyTracking();
    }
    return;
  }
  let payload: TrackingPayload;
  try {
    payload = JSON.parse(raw) as TrackingPayload;
  } catch {
    await haltSafetyTracking();
    return;
  }
  const uid = auth.currentUser?.uid;
  if (uid && uid !== payload.userId) {
    await haltSafetyTracking();
    return;
  }
  if ((await isTrackedSessionOpen(payload)) === false) await haltSafetyTracking();
}
