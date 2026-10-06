import { auth, db } from "@/config/firebase";
import { SIGNUP_PHONE_KEY } from "@/constants/preferences";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import {
  arrayRemove,
  arrayUnion,
  doc,
  getDoc,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

const PUSH_TOKEN_KEY = "@SafeRoute:expoPushToken";

/**
 * Types that still pop up while the app is open. Everything else arrives
 * quietly in the Alerts tab (with the badge) so routine updates don't nag.
 * When the app is closed or backgrounded, Android shows every push normally.
 */
const FOREGROUND_ALERT_TYPES = new Set([
  "guardian_invite",
  "guardian_accepted",
  "guardian_alert",
  "safe_walk_started",
  "live_share_started",
  "safety_checkin_failed",
  "safety_checkin_ok",
  "safety_arrived",
  "sos_activated",
  "sos_nearby",
]);

export function shouldAlertInForeground(type: unknown): boolean {
  // Pushes from an older server don't carry a type; err on the side of showing.
  return typeof type !== "string" || FOREGROUND_ALERT_TYPES.has(type);
}

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const show = shouldAlertInForeground(
      notification.request.content.data?.type,
    );
    return {
      shouldShowBanner: show,
      shouldShowList: show,
      shouldPlaySound: show,
      shouldSetBadge: true,
    };
  },
});

function projectId(): string | undefined {
  return (
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function ensureUserProfile(): Promise<void> {
  const user = auth.currentUser;
  if (!user) return;
  const ref = doc(db, "users", user.uid);
  const phoneDigits = await AsyncStorage.getItem(SIGNUP_PHONE_KEY);

  await withTimeout(
    (async () => {
      const existing = await getDoc(ref);
      const base: Record<string, unknown> = {
        displayName: user.displayName ?? "",
        email: user.email ?? "",
        updatedAt: new Date(),
      };
      if (phoneDigits) {
        base.phone = phoneDigits.startsWith("+")
          ? phoneDigits
          : `+91${phoneDigits}`;
      }
      // Seed trust / createdAt only on first write — never clobber live scores.
      if (!existing.exists()) {
        base.trustScore = 50;
        base.trustLevel = "standard";
        base.createdAt = new Date();
      } else {
        const data = existing.data();
        if (typeof data.trustScore !== "number") base.trustScore = 50;
        if (typeof data.trustLevel !== "string") base.trustLevel = "standard";
        if (!data.createdAt) base.createdAt = new Date();
      }
      await setDoc(ref, base, { merge: true });
    })(),
    8_000,
    "ensureUserProfile",
  );
}

export async function registerPushToken(): Promise<string | null> {
  const user = auth.currentUser;
  if (!user || Platform.OS === "web") return null;

  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("safety-alerts", {
        name: "Safety alerts",
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 180, 250],
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
    }

    const current = await Notifications.getPermissionsAsync();
    const permission =
      current.status === "granted"
        ? current
        : await Notifications.requestPermissionsAsync();
    if (permission.status !== "granted") return null;

    const easProjectId = projectId();
    if (!easProjectId) {
      console.warn("EXPO_PUBLIC_EAS_PROJECT_ID is required for push tokens.");
      return null;
    }

    // Without google-services / FCM credentials this call can hang on Android.
    const token = (
      await withTimeout(
        Notifications.getExpoPushTokenAsync({ projectId: easProjectId }),
        8_000,
        "getExpoPushTokenAsync",
      )
    ).data;
    await setDoc(
      doc(db, "users", user.uid),
      {
        expoPushTokens: arrayUnion(token),
        updatedAt: new Date(),
      },
      { merge: true },
    );
    await AsyncStorage.setItem(PUSH_TOKEN_KEY, token);
    return token;
  } catch (error) {
    console.warn("Push token registration skipped:", error);
    return null;
  }
}

export async function unregisterPushToken(token: string): Promise<void> {
  const user = auth.currentUser;
  if (!user) return;
  await updateDoc(doc(db, "users", user.uid), {
    expoPushTokens: arrayRemove(token),
    updatedAt: new Date(),
  });
  await AsyncStorage.removeItem(PUSH_TOKEN_KEY);
}

export async function unregisterCurrentPushToken(): Promise<void> {
  const token = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
  if (token) await unregisterPushToken(token);
}

/**
 * Where tapping a notification should go. Older acknowledgement notifications
 * pointed at the Alerts tab itself, which made "Open" a no-op there.
 */
export function notificationRoute(
  type: unknown,
  route: unknown,
  kind: unknown,
): string | undefined {
  if (
    typeof route === "string" &&
    route.startsWith("/") &&
    route !== "/(tabs)/alerts"
  ) {
    return route;
  }
  if (type === "safety_guardian_acknowledged") {
    return kind === "live_share" ? "/(tabs)/navigate" : "/(tabs)/safewalk";
  }
  if (type === "sos_guardian_acknowledged") return "/(tabs)/SOS";
  return typeof route === "string" && route.startsWith("/") ? route : undefined;
}

export function routeFromNotification(
  response: Notifications.NotificationResponse | null,
): string | null {
  const data = response?.notification.request.content.data;
  return notificationRoute(data?.type, data?.route, data?.kind) ?? null;
}
