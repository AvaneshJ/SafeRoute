/**
 * Nearby-helper presence. While the app is open and the user has opted in,
 * we keep `presence/{uid}` updated with an approximate location so the
 * server can alert people within a few hundred metres of an SOS.
 * Only the server reads these docs; nothing is written in the background.
 */
import { auth, db } from "@/config/firebase";
import { HELP_NEARBY_KEY } from "@/constants/preferences";
import { encodeGeohash } from "@/core/geohash";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import { onAuthStateChanged } from "firebase/auth";
import { deleteDoc, doc, serverTimestamp, setDoc } from "firebase/firestore";
import { AppState, type AppStateStatus } from "react-native";

const BEAT_MS = 5 * 60_000;
const MIN_REWRITE_MS = 10 * 60_000;
const MIN_MOVE_M = 75;

let started = false;
let last: { latitude: number; longitude: number; atMs: number } | null = null;

function metersBetween(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLng = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export async function isHelpNearbyEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem(HELP_NEARBY_KEY)) !== "false";
}

export async function setHelpNearbyEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(HELP_NEARBY_KEY, enabled ? "true" : "false");
  if (enabled) {
    last = null;
    await beat();
  } else {
    await clearPresence();
  }
}

export async function clearPresence(): Promise<void> {
  const uid = auth.currentUser?.uid;
  last = null;
  if (!uid) return;
  await deleteDoc(doc(db, "presence", uid)).catch(() => undefined);
}

async function beat(): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid || AppState.currentState !== "active") return;
  if (!(await isHelpNearbyEnabled())) return;
  const permission = await Location.getForegroundPermissionsAsync();
  if (permission.status !== Location.PermissionStatus.GRANTED) return;

  const fix =
    (await Location.getLastKnownPositionAsync({ maxAge: 2 * 60_000 })) ??
    (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
  if (!fix) return;
  const here = { latitude: fix.coords.latitude, longitude: fix.coords.longitude };
  const now = Date.now();
  if (last && now - last.atMs < MIN_REWRITE_MS && metersBetween(last, here) < MIN_MOVE_M) {
    return;
  }
  last = { ...here, atMs: now };
  await setDoc(doc(db, "presence", uid), {
    userId: uid,
    latitude: Math.round(here.latitude * 1e4) / 1e4,
    longitude: Math.round(here.longitude * 1e4) / 1e4,
    geohash6: encodeGeohash(here.latitude, here.longitude, 6),
    updatedAtMs: now,
    updatedAt: serverTimestamp(),
  });
}

/** Starts the foreground presence heartbeat once per app lifetime. */
export function startPresenceBeacon(): () => void {
  if (started) return () => undefined;
  started = true;
  const safeBeat = () => void beat().catch((e) => console.warn("[presence]", e));
  const timer = setInterval(safeBeat, BEAT_MS);
  const appState = AppState.addEventListener("change", (state: AppStateStatus) => {
    if (state === "active") safeBeat();
  });
  const stopAuth = onAuthStateChanged(auth, (user) => {
    last = null;
    if (user) safeBeat();
  });
  return () => {
    started = false;
    clearInterval(timer);
    appState.remove();
    stopAuth();
  };
}
