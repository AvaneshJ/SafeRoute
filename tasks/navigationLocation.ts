import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";

export const NAVIGATION_LOCATION_TASK = "saferoute-navigation-location";

type NavLocationListener = (location: Location.LocationObject) => void;

const listeners = new Set<NavLocationListener>();

/**
 * Receive fixes delivered by the background navigation task. The task runs in
 * the same JS runtime while the app is backgrounded (Android foreground
 * service / iOS background location), so the Map screen keeps updating.
 */
export function subscribeNavigationLocations(
  listener: NavLocationListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

TaskManager.defineTask(NAVIGATION_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.error("Navigation location task failed", error);
    return;
  }
  const locations = (
    data as { locations?: Location.LocationObject[] } | undefined
  )?.locations;
  if (!locations?.length) return;
  for (const location of locations) {
    for (const listener of listeners) {
      try {
        listener(location);
      } catch (listenerError) {
        console.warn("Navigation location listener failed", listenerError);
      }
    }
  }
});

/**
 * Start background location for an active trip. Returns false when background
 * permission isn't granted; foreground navigation still works in that case.
 */
export async function startNavigationBackgroundUpdates(
  destinationTitle?: string,
  options: { requestPermission?: boolean } = {},
): Promise<boolean> {
  const { requestPermission = true } = options;
  try {
    let permission = await Location.getBackgroundPermissionsAsync();
    if (
      permission.status !== Location.PermissionStatus.GRANTED &&
      requestPermission &&
      permission.canAskAgain
    ) {
      permission = await Location.requestBackgroundPermissionsAsync();
    }
    if (permission.status !== Location.PermissionStatus.GRANTED) return false;

    if (await Location.hasStartedLocationUpdatesAsync(NAVIGATION_LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(NAVIGATION_LOCATION_TASK);
    }
    await Location.startLocationUpdatesAsync(NAVIGATION_LOCATION_TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: 2000,
      distanceInterval: 4,
      pausesUpdatesAutomatically: false,
      activityType: Location.ActivityType.Fitness,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: "SafeRoute navigation",
        notificationBody: destinationTitle
          ? `Navigating to ${destinationTitle}`
          : "Turn-by-turn navigation is active.",
        notificationColor: "#4F46E5",
      },
    });
    return true;
  } catch (error) {
    console.warn("Background navigation unavailable", error);
    return false;
  }
}

export async function stopNavigationBackgroundUpdates(): Promise<void> {
  try {
    if (await Location.hasStartedLocationUpdatesAsync(NAVIGATION_LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(NAVIGATION_LOCATION_TASK);
    }
  } catch (error) {
    console.warn("Could not stop background navigation", error);
  }
}
