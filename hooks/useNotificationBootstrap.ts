import { startGuardianSync } from "@/services/guardianSync";
import { startPresenceBeacon } from "@/services/presence";
import { reconcileSafetyTracking } from "@/services/safetyTracking";
import {
  ensureUserProfile,
  registerPushToken,
  routeFromNotification,
} from "@/services/notifications";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { onAuthStateChanged } from "firebase/auth";
import { useEffect, useRef } from "react";
import { auth } from "@/config/firebase";

/**
 * `ready` must be true only once the root Stack is mounted, otherwise a
 * cold-start notification tap navigates before any route exists.
 */
export function useNotificationBootstrap(ready = true): void {
  const router = useRouter();
  const pendingRoute = useRef<string | null>(null);
  const readyRef = useRef(ready);
  readyRef.current = ready;

  useEffect(() => {
    const stopSync = startGuardianSync();
    const stopPresence = startPresenceBeacon();
    const authUnsubscribe = onAuthStateChanged(auth, (user) => {
      if (!user) return;
      void reconcileSafetyTracking().catch(console.warn);
      void ensureUserProfile().catch(console.warn);
      void registerPushToken().catch(console.warn);
    });
    const tokenSubscription = Notifications.addPushTokenListener(() => {
      void registerPushToken().catch(console.warn);
    });
    return () => {
      stopSync();
      stopPresence();
      authUnsubscribe();
      tokenSubscription.remove();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const open = (response: Notifications.NotificationResponse | null) => {
      const route = routeFromNotification(response);
      if (!active || !route) return;
      void Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
      if (readyRef.current) router.push(route as never);
      else pendingRoute.current = route;
    };
    const responseSubscription =
      Notifications.addNotificationResponseReceivedListener(open);
    void Notifications.getLastNotificationResponseAsync().then(open);
    return () => {
      active = false;
      responseSubscription.remove();
    };
  }, [router]);

  useEffect(() => {
    if (!ready || !pendingRoute.current) return;
    const route = pendingRoute.current;
    pendingRoute.current = null;
    const timer = setTimeout(() => router.push(route as never), 50);
    return () => clearTimeout(timer);
  }, [ready, router]);
}
