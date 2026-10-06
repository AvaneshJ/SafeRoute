import {
  PrimaryButton,
  SecondaryButton,
  SOSButton,
  UserAvatar,
} from "@/components/design-system";
import {
  motion,
  radius,
  spacing,
  touch,
  typography,
} from "@/constants/theme";
import {
  CHECKIN_COUNTDOWN_MS,
  CHECKIN_GRACE_MS,
  STATIONARY_THRESHOLD_M,
  STATIONARY_TRIGGER_MS,
  initialSafeWalk,
  reduceSafeWalk,
  type SafeWalkSession,
} from "@/core/safeWalk";
import {
  haversineMeters,
  updateLiveNavigation,
  type LatLng,
  type LiveNavSnapshot,
  type NavStep,
} from "@/core/liveNavigation";
import {
  formatDistanceKm,
  formatDurationMin,
} from "@/core/safeWalkTrip";
import { NearestPoliceRow } from "@/components/navigation/NearestPoliceRow";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useNearestPolice } from "@/hooks/useNearestPolice";
import { telUrl } from "@/services/nearbyPlaces";
import { auth, db, functions } from "@/config/firebase";
import {
  clearActiveSafeWalk,
  endSafetySession,
  saveActiveSafeWalk,
  setMountedSafeWalk,
} from "@/services/activeSafeWalk";
import {
  notifyGuardianSms,
  safeWalkArrivedMessage,
  safeWalkCheckinFailedMessage,
} from "@/services/guardianAlerts";
import { fetchWalkingRoute } from "@/services/walkingRoute";
import { fetchLiveReroute } from "@/services/safeRouteApi";
import {
  publishSafetyLocation,
  publishSafetyRoute,
  stopSafetyTrackingFor,
} from "@/services/safetyTracking";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import * as Linking from "expo-linking";
import * as Location from "expo-location";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { doc, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type Phase = "loading" | "active" | "check_in_pending" | "arrived";

const { height: SCREEN_H } = Dimensions.get("window");
const WALKER_NAME_KEY = "@SafeRoute:displayName";
const CLOSED_SESSION_STATES = ["completed", "cancelled", "expired"];

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function SafeWalkLiveScreen() {
  const { colors: c, elevation: elev, gradients: grads, isDark } =
    useAppTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<Record<string, string>>();

  const guardianName = params.guardianName || "Guardian";
  const guardianPhone = params.guardianPhone || "";
  const sessionId = params.sessionId || "";
  const initialDistance = Number(params.distanceKm ?? 1.2);
  const initialEta = Number(params.etaMin ?? 14);
  const originLat = Number(params.originLat ?? 19.1136);
  const originLng = Number(params.originLng ?? 72.8697);
  const destLat = Number(params.destLat ?? 19.128);
  const destLng = Number(params.destLng ?? 72.845);

  // Can switch mid-walk when the user heads to the nearest police station.
  const [dest, setDest] = useState<LatLng>(() => ({
    latitude: destLat,
    longitude: destLng,
  }));
  const [destTitle, setDestTitle] = useState(
    () => params.destTitle || "Destination",
  );

  const [phase, setPhase] = useState<Phase>("loading");
  const [progress, setProgress] = useState(0);
  const [etaMin, setEtaMin] = useState(initialEta);
  const [distanceLeft, setDistanceLeft] = useState(initialDistance);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [countdownSec, setCountdownSec] = useState(
    CHECKIN_COUNTDOWN_MS / 1000,
  );
  const [extended, setExtended] = useState(false);
  const extendedRef = useRef(false);
  const [routeCoords, setRouteCoords] = useState<LatLng[]>([
    { latitude: originLat, longitude: originLng },
    dest,
  ]);
  const [userCoord, setUserCoord] = useState<LatLng>({
    latitude: originLat,
    longitude: originLng,
  });
  const [remainingPath, setRemainingPath] = useState<LatLng[]>([]);
  const [traveledPath, setTraveledPath] = useState<LatLng[]>([]);
  const [errorHint, setErrorHint] = useState<string | null>(null);
  const [routeSafety, setRouteSafety] = useState<number | null>(null);
  const rerouteBusy = useRef(false);
  const lastRerouteOfferAt = useRef(0);

  const sessionRef = useRef<SafeWalkSession>(initialSafeWalk());
  const routeRef = useRef<LatLng[]>([]);
  const stepsRef = useRef<NavStep[]>([]);
  const stepIndexRef = useRef(0);
  const totalDurationRef = useRef(initialEta);
  const totalDistanceRef = useRef(initialDistance);
  const lastPosRef = useRef<LatLng | null>(null);
  /** Anchor used to detect real movement (resets stillness). */
  const moveAnchorRef = useRef<LatLng | null>(null);
  /** Wall-clock: last time we saw meaningful movement. */
  const lastMoveAtRef = useRef<number>(Date.now());
  const activeSinceRef = useRef<number>(Date.now());
  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const mapRef = useRef<MapView | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stillnessTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const arrivedNotified = useRef(false);
  const checkinAlerted = useRef(false);
  const lastUploadAtRef = useRef(0);
  const walkerNameRef = useRef<string>("");
  const phaseRef = useRef<Phase>("loading");
  /** True once the server session is closed (ended, arrived, expired elsewhere). */
  const sessionClosedRef = useRef(false);
  /** Lets the screen be removed without the "leave Safe Walk?" prompt. */
  const allowLeaveRef = useRef(false);
  const [ending, setEnding] = useState(false);
  const [guardianAlerted, setGuardianAlerted] = useState(false);
  const navigation = useNavigation();

  const pulse = useRef(new Animated.Value(1)).current;
  const modalScale = useRef(new Animated.Value(0.92)).current;
  const modalOpacity = useRef(new Animated.Value(0)).current;
  const successScale = useRef(new Animated.Value(0.6)).current;

  phaseRef.current = phase;

  const walkInProgress = phase === "active" || phase === "check_in_pending";
  const nearestPolice = useNearestPolice(
    walkInProgress ? userCoord : null,
    walkInProgress,
  );
  const headedToNearestPolice =
    nearestPolice.station != null &&
    nearestPolice.station.coordinate.latitude === dest.latitude &&
    nearestPolice.station.coordinate.longitude === dest.longitude;

  /** Re-route the walk to the nearest police station, keeping the session live. */
  const walkToNearestPolice = async () => {
    const station = nearestPolice.station;
    if (!station || headedToNearestPolice || rerouteBusy.current) return;
    rerouteBusy.current = true;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const from = lastPosRef.current ?? userCoord;
      const walking = await fetchWalkingRoute(from, station.coordinate);
      routeRef.current = walking.coordinates;
      stepsRef.current = walking.steps;
      stepIndexRef.current = 0;
      totalDurationRef.current = walking.durationMin;
      totalDistanceRef.current = walking.distanceKm;
      extendedRef.current = false;
      lastRerouteOfferAt.current = Date.now();
      setExtended(false);
      setDest(station.coordinate);
      setDestTitle(station.title);
      setRouteSafety(null);
      setRouteCoords(walking.coordinates);
      setRemainingPath(walking.coordinates);
      setTraveledPath([]);
      setDistanceLeft(walking.distanceKm);
      setEtaMin(walking.durationMin);
      setProgress(0);
      if (sessionId && auth.currentUser) {
        void publishSafetyRoute(
          { collection: "routes", sessionId, userId: auth.currentUser.uid },
          walking.coordinates,
        ).catch(console.warn);
      }
    } finally {
      rerouteBusy.current = false;
    }
  };

  const applySession = (next: SafeWalkSession) => {
    sessionRef.current = next;
    if (next.state === "check_in_pending" && phaseRef.current === "active") {
      setPhase("check_in_pending");
      setCountdownSec(
        Math.max(1, Math.round((next.countdownMs ?? CHECKIN_COUNTDOWN_MS) / 1000)),
      );
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
    if (next.state === "completed" && phaseRef.current !== "arrived") {
      setPhase("arrived");
    }
    if (next.state === "sos") {
      void triggerSosFromCheckin();
    }
  };

  const triggerSosFromCheckin = async () => {
    if (checkinAlerted.current) return;
    checkinAlerted.current = true;
    const pos = lastPosRef.current ?? userCoord;
    let smsRequired = !sessionId;
    if (sessionId) {
      try {
        const result = await httpsCallable<
          Record<string, unknown>,
          {
            smsRequired?: boolean;
            sms_required?: boolean;
            delivery?: { smsRequired?: boolean };
          }
        >(functions, "publishSafetyEvent")({
          sessionId,
          type: "checkin_failed",
          // Unique per miss: a fixed id would be deduped and a second miss never alerts.
          eventId: `${sessionId}-checkin-failed-${Date.now()}`,
          location: pos,
        });
        smsRequired =
          result.data.delivery?.smsRequired ??
          result.data.smsRequired ??
          result.data.sms_required ??
          false;
      } catch {
        smsRequired = true;
      }
    }
    if (smsRequired) {
      await notifyGuardianSms(
        guardianPhone,
        safeWalkCheckinFailedMessage({
          walkerName: walkerNameRef.current,
          lat: pos.latitude,
          lng: pos.longitude,
        }),
      );
    }
    // Keep sharing location and stay on this screen: the guardian needs the live
    // position most right now, and the walker can still confirm they're safe.
    setGuardianAlerted(true);
  };

  const onArrived = async () => {
    if (arrivedNotified.current) return;
    arrivedNotified.current = true;
    applySession(reduceSafeWalk(sessionRef.current, { type: "ARRIVED" }));
    setPhase("arrived");
    setProgress(100);
    setDistanceLeft(0);
    setEtaMin(0);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    let smsRequired = !sessionId;
    if (sessionId) {
      try {
        const result = await httpsCallable<
          Record<string, unknown>,
          {
            smsRequired?: boolean;
            sms_required?: boolean;
            delivery?: { smsRequired?: boolean };
          }
        >(functions, "publishSafetyEvent")({
          sessionId,
          type: "arrived",
          eventId: `${sessionId}-arrived`,
          location: lastPosRef.current ?? userCoord,
        });
        smsRequired =
          result.data.delivery?.smsRequired ??
          result.data.smsRequired ??
          result.data.sms_required ??
          false;
      } catch {
        smsRequired = true;
      }
    }
    if (smsRequired) {
      await notifyGuardianSms(
        guardianPhone,
        safeWalkArrivedMessage({ walkerName: walkerNameRef.current }),
      );
    }
    sessionClosedRef.current = true;
    await stopSafetyTrackingFor("routes", sessionId);
    await clearActiveSafeWalk(sessionId);
  };

  const stopLocalTracking = () => {
    watchRef.current?.remove();
    watchRef.current = null;
    if (elapsedTimer.current) clearInterval(elapsedTimer.current);
    if (stillnessTimer.current) clearInterval(stillnessTimer.current);
    if (countdownTimer.current) clearInterval(countdownTimer.current);
  };

  /** Leave to the Safe Walk tab without stacking another tabs instance. */
  const leaveScreen = () => {
    allowLeaveRef.current = true;
    router.dismissTo("/(tabs)/safewalk" as never);
  };

  const finishEnd = async (localOnly: boolean) => {
    setEnding(true);
    const result = localOnly
      ? ({ ok: true, alreadyClosed: false } as const)
      : sessionId
        ? await endSafetySession(sessionId)
        : ({ ok: true, alreadyClosed: false } as const);
    setEnding(false);

    if (!result.ok) {
      Alert.alert(
        "Couldn't end Safe Walk",
        `${result.error}\n\nYour guardian may still see this walk as active. Check your connection and try again.`,
        [
          { text: "Keep walking", style: "cancel" },
          { text: "Try again", onPress: () => void finishEnd(false) },
          {
            text: "Stop on this phone",
            style: "destructive",
            onPress: () => void finishEnd(true),
          },
        ],
      );
      return;
    }

    sessionClosedRef.current = true;
    applySession(
      reduceSafeWalk(sessionRef.current, { type: "USER_CANCELLED" }),
    );
    stopLocalTracking();
    if (localOnly) {
      await stopSafetyTrackingFor("routes", sessionId).catch(console.warn);
      await clearActiveSafeWalk(sessionId).catch(console.warn);
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert(
      "Safe Walk ended",
      localOnly
        ? "Location sharing stopped on this phone. It will close for your guardian automatically within a couple of hours."
        : `${guardianName} has been told you stopped sharing your location.`,
      [{ text: "OK", onPress: leaveScreen }],
      { cancelable: false },
    );
  };

  useEffect(() => {
    let cancelled = false;

    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1.25,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        }),
      ]),
    ).start();

    void (async () => {
      try {
        const name = await AsyncStorage.getItem(WALKER_NAME_KEY);
        if (name) walkerNameRef.current = name;
      } catch {
        /* ignore */
      }

      const origin: LatLng = {
        latitude: originLat,
        longitude: originLng,
      };

      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== Location.PermissionStatus.GRANTED) {
        setErrorHint("Location permission is required for Safe Walk.");
        setPhase("active");
        return;
      }

      let start = origin;
      try {
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        });
        start = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        };
        if (!cancelled) {
          setUserCoord(start);
          lastPosRef.current = start;
        }
      } catch {
        /* use origin from params */
      }

      const walking = await fetchWalkingRoute(start, dest);
      if (cancelled) return;

      routeRef.current = walking.coordinates;
      stepsRef.current = walking.steps;
      totalDurationRef.current = walking.durationMin || initialEta;
      totalDistanceRef.current = walking.distanceKm || initialDistance;
      setRouteCoords(walking.coordinates);
      setDistanceLeft(walking.distanceKm || initialDistance);
      setEtaMin(walking.durationMin || initialEta);
      setRemainingPath(walking.coordinates);
      phaseRef.current = "active";
      setPhase("active");
      if (sessionId && auth.currentUser) {
        void publishSafetyRoute(
          { collection: "routes", sessionId, userId: auth.currentUser.uid },
          walking.coordinates,
        ).catch(console.warn);
      }

      // Mark session active (guardians already verified — skip invite wait)
      const armedAt = Date.now();
      activeSinceRef.current = armedAt;
      lastMoveAtRef.current = armedAt;
      moveAnchorRef.current = start;
      sessionRef.current = reduceSafeWalk(
        reduceSafeWalk(initialSafeWalk(), {
          type: "SELECT_DESTINATION",
          nowMs: armedAt,
        }),
        { type: "GUARDIAN_ACCEPTED", nowMs: armedAt },
      );

      elapsedTimer.current = setInterval(() => {
        setElapsedSec((s) => s + 1);
      }, 1000);

      // Wall-clock stillness monitor — works even when the emulator freezes GPS
      // and stops delivering watchPosition callbacks.
      stillnessTimer.current = setInterval(() => {
        if (phaseRef.current !== "active") return;
        if (sessionRef.current.state !== "active") return;
        const now = Date.now();
        if (now - activeSinceRef.current < CHECKIN_GRACE_MS) return;
        if (now - lastMoveAtRef.current < STATIONARY_TRIGGER_MS) return;
        applySession(
          reduceSafeWalk(sessionRef.current, { type: "STATIONARY_TIMEOUT" }),
        );
      }, 1000);

      const seed = updateLiveNavigation({
        position: start,
        heading: null,
        route: walking.coordinates,
        steps: walking.steps,
        previousStepIndex: 0,
        totalDurationMin: totalDurationRef.current,
        totalDistanceKm: totalDistanceRef.current,
      });
      applyNavSnapshot(seed, false);

      watchRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 1000,
          distanceInterval: 0,
          mayShowUserSettingsDialog: true,
        },
        (loc) => {
          if (!loc.coords) return;
          if (
            phaseRef.current === "arrived" ||
            phaseRef.current === "loading"
          ) {
            return;
          }

          const position: LatLng = {
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
          };
          lastPosRef.current = position;
          setUserCoord(position);

          // Meaningful move vs anchor (ignore GPS jitter / tiny sim noise)
          const anchor = moveAnchorRef.current ?? position;
          const movedFromAnchor = haversineMeters(anchor, position);
          if (movedFromAnchor >= STATIONARY_THRESHOLD_M) {
            moveAnchorRef.current = position;
            lastMoveAtRef.current = Date.now();
          }

          const snapshot = updateLiveNavigation({
            position,
            heading:
              typeof loc.coords.heading === "number" && loc.coords.heading >= 0
                ? loc.coords.heading
                : null,
            route: routeRef.current,
            steps: stepsRef.current,
            previousStepIndex: stepIndexRef.current,
            totalDurationMin:
              totalDurationRef.current + (extendedRef.current ? 10 : 0),
            totalDistanceKm: totalDistanceRef.current,
          });
          stepIndexRef.current = snapshot.stepIndex;
          applyNavSnapshot(snapshot, extendedRef.current);

          if (
            sessionId &&
            auth.currentUser &&
            !sessionClosedRef.current &&
            Date.now() - lastUploadAtRef.current >= 5_000
          ) {
            lastUploadAtRef.current = Date.now();
            void publishSafetyLocation(
              {
                collection: "routes",
                sessionId,
                userId: auth.currentUser.uid,
              },
              loc,
              {
                etaMinutes: snapshot.remainingMinutes,
                remainingM: snapshot.remainingMeters,
              },
            ).catch(console.warn);
          }

          // Keep session ETA fresh; stillness is handled by the wall-clock timer
          if (
            phaseRef.current === "active" ||
            phaseRef.current === "check_in_pending"
          ) {
            applySession(
              reduceSafeWalk(sessionRef.current, {
                type: "LOCATION",
                movedMeters: movedFromAnchor,
                etaMinutes: snapshot.remainingMinutes,
                nowMs: Date.now(),
              }),
            );
          }

          if (snapshot.arrived) {
            void onArrived();
          }

          const speed = loc.coords.speed;
          const moving =
            typeof speed === "number" && Number.isFinite(speed) && speed > 0.8;
          const camHeading =
            moving &&
            typeof loc.coords.heading === "number" &&
            loc.coords.heading >= 0
              ? loc.coords.heading
              : snapshot.bearing;

          mapRef.current?.animateCamera(
            {
              center: snapshot.snapped,
              heading: camHeading,
              pitch: 45,
              zoom: 17.5,
            },
            { duration: 450 },
          );
        },
      );
    })();

    return () => {
      cancelled = true;
      stopLocalTracking();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Remember the open walk so the Safe Walk tab can offer Resume / End even if
  // this screen gets buried or the app restarts.
  useEffect(() => {
    if (!sessionId) return;
    setMountedSafeWalk(sessionId);
    void saveActiveSafeWalk({ sessionId, params: { ...params } }).catch(
      console.warn,
    );
    return () => setMountedSafeWalk(null, sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // The walk can be closed from somewhere else (Safe Walk tab, expiry job,
  // another device). Stop this screen instead of silently sharing on.
  useEffect(() => {
    if (!sessionId) return;
    return onSnapshot(
      doc(db, "routes", sessionId),
      (snap) => {
        const state = snap.data()?.state;
        if (!snap.exists() || CLOSED_SESSION_STATES.includes(state)) {
          if (sessionClosedRef.current) return;
          sessionClosedRef.current = true;
          stopLocalTracking();
          void stopSafetyTrackingFor("routes", sessionId).catch(console.warn);
          void clearActiveSafeWalk(sessionId).catch(console.warn);
          if (phaseRef.current === "arrived") return;
          if (navigation.isFocused()) {
            Alert.alert(
              "Safe Walk ended",
              state === "expired"
                ? "This walk closed automatically after a long period without updates."
                : "This walk was ended.",
              [{ text: "OK", onPress: leaveScreen }],
              { cancelable: false },
            );
          } else {
            allowLeaveRef.current = true;
            navigation.goBack();
          }
        } else if (state === "active" && sessionRef.current.state === "sos") {
          setGuardianAlerted(false);
        }
      },
      (err) => console.warn("SafeWalkLive session listener", err),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Hardware back / swipe: never drop an open walk silently.
  useEffect(() => {
    return navigation.addListener("beforeRemove", (e) => {
      if (allowLeaveRef.current || sessionClosedRef.current) return;
      if (phaseRef.current === "arrived") return;
      e.preventDefault();
      Alert.alert(
        "Safe Walk is still on",
        `${guardianName} can still see your live location. End the walk, or keep it running in the background?`,
        [
          { text: "Stay", style: "cancel" },
          {
            text: "Keep running",
            onPress: () => {
              allowLeaveRef.current = true;
              navigation.dispatch(e.data.action);
            },
          },
          {
            text: "End walk",
            style: "destructive",
            onPress: () => void finishEnd(false),
          },
        ],
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, guardianName]);

  // Phase 6 — poll for safer remaining path when hazards appear ahead
  useEffect(() => {
    if (phase !== "active") return;
    const tick = async () => {
      if (rerouteBusy.current) return;
      if (Date.now() - lastRerouteOfferAt.current < 90_000) return;
      const pos = lastPosRef.current ?? userCoord;
      rerouteBusy.current = true;
      try {
        const result = await fetchLiveReroute({
          position: pos,
          destination: dest,
          mode: "safest",
          currentPolyline: routeRef.current,
          currentSafety: routeSafety ?? undefined,
        });
        if (!result.offer || !result.route?.polyline?.length) return;
        lastRerouteOfferAt.current = Date.now();
        const delta = result.safety_delta ?? 0;
        Alert.alert(
          result.message || "Safer route available",
          result.detail ||
            `A safer path is available${delta > 0 ? ` (+${delta} safety)` : ""}.`,
          [
            { text: "Keep current", style: "cancel" },
            {
              text: "Take safer route",
              onPress: () => {
                const coords = (result.route.polyline || []).map(
                  ([lat, lon]) => ({
                    latitude: lat,
                    longitude: lon,
                  }),
                );
                if (coords.length < 2) return;
                routeRef.current = coords;
                setRouteCoords(coords);
                setRemainingPath(coords);
                setRouteSafety(result.route.safety);
                const km = (result.route.distance || 0) / 1000;
                const mins = result.route.eta || etaMin;
                totalDistanceRef.current = km;
                totalDurationRef.current = mins;
                setDistanceLeft(km);
                setEtaMin(mins);
                void Haptics.notificationAsync(
                  Haptics.NotificationFeedbackType.Success,
                );
              },
            },
          ],
        );
      } catch {
        /* API optional during walk */
      } finally {
        rerouteBusy.current = false;
      }
    };
    const id = setInterval(() => {
      void tick();
    }, 45_000);
    return () => clearInterval(id);
  }, [phase, dest, userCoord, routeSafety, etaMin]);

  const applyNavSnapshot = (
    snapshot: LiveNavSnapshot,
    tripExtended = false,
  ) => {
    setProgress(
      Math.min(
        100,
        Math.max(
          0,
          Math.round(
            ((totalDistanceRef.current - snapshot.remainingKm) /
              Math.max(totalDistanceRef.current, 0.001)) *
              100,
          ),
        ),
      ),
    );
    setDistanceLeft(Math.max(0, snapshot.remainingKm));
    setEtaMin(Math.max(0, snapshot.remainingMinutes + (tripExtended ? 10 : 0)));
    setTraveledPath(snapshot.traveledCoordinates);
    setRemainingPath(snapshot.remainingCoordinates);
    setUserCoord(snapshot.snapped);
  };

  const extendTrip = () => {
    extendedRef.current = true;
    setEtaMin((e) => e + 10);
    setExtended(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  useEffect(() => {
    if (phase !== "check_in_pending") return;

    modalScale.setValue(0.92);
    modalOpacity.setValue(0);
    Animated.parallel([
      Animated.spring(modalScale, {
        toValue: 1,
        friction: 8,
        tension: 120,
        useNativeDriver: true,
      }),
      Animated.timing(modalOpacity, {
        toValue: 1,
        duration: motion.normal,
        useNativeDriver: true,
      }),
    ]).start();

    countdownTimer.current = setInterval(() => {
      setCountdownSec((s) => {
        if (s <= 1) {
          if (countdownTimer.current) clearInterval(countdownTimer.current);
          applySession(
            reduceSafeWalk(sessionRef.current, { type: "COUNTDOWN_ELAPSED" }),
          );
          return 0;
        }
        if (s <= 5) {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        }
        return s - 1;
      });
    }, 1000);

    return () => {
      if (countdownTimer.current) clearInterval(countdownTimer.current);
    };
  }, [phase, modalScale, modalOpacity]);

  useEffect(() => {
    if (phase !== "arrived") return;
    successScale.setValue(0.6);
    Animated.spring(successScale, {
      toValue: 1,
      friction: 5,
      tension: 90,
      useNativeDriver: true,
    }).start();
    watchRef.current?.remove();
    watchRef.current = null;
    if (stillnessTimer.current) clearInterval(stillnessTimer.current);
  }, [phase, successScale]);

  const confirmSafe = () => {
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    const now = Date.now();
    lastMoveAtRef.current = now;
    activeSinceRef.current = now;
    if (lastPosRef.current) moveAnchorRef.current = lastPosRef.current;
    applySession(
      reduceSafeWalk(sessionRef.current, {
        type: "CHECKIN_CONFIRMED",
        nowMs: now,
      }),
    );
    phaseRef.current = "active";
    setPhase("active");
    setCountdownSec(CHECKIN_COUNTDOWN_MS / 1000);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const wasAlerted = checkinAlerted.current;
    checkinAlerted.current = false;
    setGuardianAlerted(false);
    if (sessionId) {
      void httpsCallable(functions, "publishSafetyEvent")({
        sessionId,
        type: "checkin_ok",
        eventId: `${sessionId}-checkin-${Date.now()}`,
      }).catch((err) => {
        console.warn(err);
        if (wasAlerted) {
          Alert.alert(
            "Couldn't reach your guardian",
            `${guardianName} was alerted that you missed a check-in. Call or message them to let them know you're safe.`,
          );
        }
      });
    }
  };

  const endWalk = () => {
    if (ending) return;
    Alert.alert(
      "End Safe Walk?",
      `${guardianName} will stop seeing your live location.`,
      [
        { text: "Keep walking", style: "cancel" },
        {
          text: "End walk",
          style: "destructive",
          onPress: () => void finishEnd(false),
        },
      ],
    );
  };

  const arrivalTime = useMemo(() => {
    const d = new Date();
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }, [phase]);

  const region = useMemo(
    () => ({
      latitude: userCoord.latitude,
      longitude: userCoord.longitude,
      latitudeDelta: 0.01,
      longitudeDelta: 0.01,
    }),
    [userCoord.latitude, userCoord.longitude],
  );

  if (phase === "loading") {
    return (
      <View
        style={[
          styles.root,
          styles.loading,
          {
            backgroundColor: c.background,
            paddingTop: Math.max(insets.top, spacing.md),
          },
        ]}
      >
        <ActivityIndicator color={c.primary} size="large" />
        <Text style={[styles.loadingText, { color: c.textSecondary }]}>
          Getting your route and GPS…
        </Text>
      </View>
    );
  }

  if (phase === "arrived") {
    return (
      <View
        style={[
          styles.root,
          {
            paddingTop: Math.max(insets.top, spacing.md),
            paddingBottom: Math.max(insets.bottom, spacing.lg),
            backgroundColor: c.background,
          },
        ]}
      >
        <View style={styles.arrivalBody}>
          <Animated.View
            style={[
              styles.successRing,
              {
                backgroundColor: c.successContainer,
                transform: [{ scale: successScale }],
              },
            ]}
          >
            <MaterialIcons name="check-circle" size={72} color={c.success} />
          </Animated.View>
          <Text style={[styles.arrivalTitle, { color: c.textPrimary }]}>
            You’ve arrived safely 🎉
          </Text>
          <Text style={[styles.arrivalSub, { color: c.textSecondary }]}>
            {guardianName} has been notified: you arrived safely at {destTitle}.
          </Text>

          <View
            style={[
              styles.arrivalCard,
              {
                backgroundColor: c.surface,
                borderColor: c.border,
                ...elev.card,
              },
            ]}
          >
            <Stat
              label="Walk duration"
              value={formatElapsed(elapsedSec)}
              color={c}
            />
            <Stat
              label="Distance walked"
              value={formatDistanceKm(totalDistanceRef.current)}
              color={c}
            />
            <Stat label="Arrival time" value={arrivalTime} color={c} />
          </View>
        </View>

        <PrimaryButton
          label="Done"
          onPress={leaveScreen}
        />
      </View>
    );
  }

  return (
    <View
      style={[
        styles.root,
        {
          paddingTop: Math.max(insets.top, spacing.md),
          paddingBottom: Math.max(insets.bottom, spacing.lg),
          backgroundColor: c.background,
        },
      ]}
    >
      <View style={styles.topBar}>
        <UserAvatar name={guardianName} size={44} />
        <View style={styles.topMeta}>
          <Text style={[styles.guardianName, { color: c.textPrimary }]}>
            {guardianName}
          </Text>
          <View style={styles.liveRow}>
            <Animated.View
              style={[
                styles.liveDot,
                {
                  backgroundColor: c.success,
                  transform: [{ scale: pulse }],
                },
              ]}
            />
            <Text style={[styles.liveLabel, { color: c.successText }]}>
              Live Monitoring
            </Text>
          </View>
        </View>
        <View
          style={[styles.timerPill, { backgroundColor: c.surfaceVariant }]}
        >
          <MaterialIcons name="schedule" size={14} color={c.textSecondary} />
          <Text style={[styles.timerText, { color: c.textPrimary }]}>
            {formatElapsed(elapsedSec)}
          </Text>
        </View>
      </View>

      {errorHint ? (
        <Text style={[styles.errorHint, { color: c.danger }]}>{errorHint}</Text>
      ) : null}

      <View
        style={[
          styles.mapWrap,
          {
            height: SCREEN_H * 0.38,
            borderColor: c.border,
            backgroundColor: c.surfaceVariant,
            ...elev.card,
          },
        ]}
      >
        <MapView
          ref={mapRef}
          style={StyleSheet.absoluteFill}
          provider={PROVIDER_GOOGLE}
          initialRegion={region}
          showsUserLocation={false}
          followsUserLocation={false}
        >
          {traveledPath.length > 1 ? (
            <Polyline
              coordinates={traveledPath}
              strokeColor={c.primary}
              strokeWidth={5}
            />
          ) : null}
          {remainingPath.length > 1 ? (
            <Polyline
              coordinates={remainingPath}
              strokeColor={isDark ? "#4A5168" : "#CBD5E1"}
              strokeWidth={4}
            />
          ) : routeCoords.length > 1 ? (
            <Polyline
              coordinates={routeCoords}
              strokeColor={c.primary}
              strokeWidth={4}
            />
          ) : null}
          <Marker coordinate={userCoord} title="You" anchor={{ x: 0.5, y: 0.5 }}>
            <View style={styles.youMarker}>
              <Animated.View
                style={[
                  styles.youPulse,
                  {
                    backgroundColor: c.indigoGlow,
                    transform: [{ scale: pulse }],
                  },
                ]}
              />
              <View style={[styles.youDot, { backgroundColor: c.primary }]} />
            </View>
          </Marker>
          <Marker
            coordinate={dest}
            title={destTitle}
            pinColor={isDark ? "#A5B4FC" : "#4F46E5"}
          />
        </MapView>
        <View
          style={[
            styles.mapBadge,
            { backgroundColor: c.surfaceGlass, borderColor: c.border },
          ]}
        >
          <Text style={[styles.mapBadgeText, { color: c.textSecondary }]}>
            Walking to {destTitle}
          </Text>
        </View>
        {nearestPolice.station && nearestPolice.distanceM != null ? (
          <NearestPoliceRow
            tone="surface"
            name={nearestPolice.station.title}
            distanceM={nearestPolice.distanceM}
            phone={nearestPolice.station.phone}
            onNavigate={() => void walkToNearestPolice()}
            onCall={() => {
              const phone = nearestPolice.station?.phone;
              if (phone) void Linking.openURL(telUrl(phone));
            }}
            style={styles.policeStrip}
          />
        ) : null}
      </View>

      <ScrollView
        style={styles.midScroll}
        contentContainerStyle={styles.midScrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.statsRow}>
          <StatCard
            label="ETA"
            value={formatDurationMin(Math.ceil(etaMin))}
            c={c}
            elev={elev}
          />
          <StatCard
            label="Remaining"
            value={formatDistanceKm(distanceLeft)}
            c={c}
            elev={elev}
          />
          <StatCard
            label="Progress"
            value={`${Math.round(progress)}%`}
            c={c}
            elev={elev}
            accent
          />
        </View>

        <View
          style={[styles.progressTrack, { backgroundColor: c.surfaceVariant }]}
        >
          <LinearGradient
            colors={[...grads.primaryButton]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={[styles.progressFill, { width: `${Math.round(progress)}%` }]}
          />
        </View>

        <Text style={[styles.extendHint, { color: c.textTertiary }]}>
          {extended
            ? "Trip extended · ETA updated"
            : "Live GPS · progress updates as you walk"}
        </Text>
      </ScrollView>

      <View style={styles.actions}>
        <PrimaryButton
          label="End Safe Walk"
          onPress={endWalk}
          loading={ending}
        />
        <SecondaryButton label="Extend Trip" onPress={extendTrip} />
      </View>

      <View
        style={[
          styles.sosFab,
          { bottom: Math.max(insets.bottom, spacing.lg) + 120 },
        ]}
        pointerEvents="box-none"
      >
        <SOSButton
          compact
          onPress={() => router.push("/(tabs)/SOS" as never)}
          onLongPress={() => router.push("/(tabs)/SOS" as never)}
        />
      </View>

      <Modal
        visible={phase === "check_in_pending"}
        transparent
        animationType="none"
        statusBarTranslucent
        onRequestClose={confirmSafe}
      >
        <View style={[styles.modalScrim, { backgroundColor: c.overlay }]}>
          <Animated.View
            style={[
              styles.modalCard,
              {
                backgroundColor: c.surfaceElevated,
                borderColor: c.border,
                ...elev.cardLift,
                opacity: modalOpacity,
                transform: [{ scale: modalScale }],
              },
            ]}
          >
            <View
              style={[
                styles.shieldWrap,
                { backgroundColor: c.primaryContainer },
              ]}
            >
              <MaterialIcons name="shield" size={36} color={c.primary} />
            </View>
            <Text style={[styles.modalTitle, { color: c.textPrimary }]}>
              {guardianAlerted ? `${guardianName} was alerted` : "Are you safe?"}
            </Text>
            <Text style={[styles.modalBody, { color: c.textSecondary }]}>
              {guardianAlerted
                ? `You missed the check-in, so we told ${guardianName} and kept sharing your live location. Tap “I’m Safe” to let them know you're okay.`
                : `We noticed you haven’t moved for a bit. Confirm you’re okay — or we’ll alert ${guardianName}.`}
            </Text>

            {!guardianAlerted && (
              <View
                style={[
                  styles.countdownRing,
                  {
                    borderColor: c.warning,
                    backgroundColor: c.warningContainer,
                  },
                ]}
              >
                <Text style={[styles.countdownNum, { color: c.textPrimary }]}>
                  {countdownSec}
                </Text>
                <Text
                  style={[styles.countdownUnit, { color: c.textSecondary }]}
                >
                  sec
                </Text>
              </View>
            )}

            <PrimaryButton label="I’m Safe" onPress={confirmSafe} />
            <Pressable
              onPress={() => {
                void triggerSosFromCheckin();
                router.push("/(tabs)/SOS" as never);
              }}
              style={[
                styles.sosSecondary,
                {
                  borderColor: c.danger,
                  backgroundColor: c.dangerContainer,
                },
              ]}
              accessibilityRole="button"
              accessibilityLabel="SOS"
            >
              <MaterialIcons name="emergency" size={18} color={c.danger} />
              <Text style={[styles.sosSecondaryText, { color: c.danger }]}>
                {guardianAlerted ? "Open SOS" : "Send SOS now"}
              </Text>
            </Pressable>
          </Animated.View>
        </View>
      </Modal>
    </View>
  );
}

function StatCard({
  label,
  value,
  c,
  elev,
  accent,
}: {
  label: string;
  value: string;
  c: {
    surface: string;
    border: string;
    textPrimary: string;
    textTertiary: string;
    primaryContainer: string;
  };
  elev: { card: object };
  accent?: boolean;
}) {
  return (
    <View
      style={[
        styles.statCard,
        {
          backgroundColor: accent ? c.primaryContainer : c.surface,
          borderColor: c.border,
          ...elev.card,
        },
      ]}
    >
      <Text style={[styles.statValue, { color: c.textPrimary }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: c.textTertiary }]}>{label}</Text>
    </View>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: { textTertiary: string; textPrimary: string };
}) {
  return (
    <View style={styles.arrivalStat}>
      <Text style={[styles.arrivalStatLabel, { color: color.textTertiary }]}>
        {label}
      </Text>
      <Text style={[styles.arrivalStatValue, { color: color.textPrimary }]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  loading: {
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
  },
  loadingText: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.body,
  },
  errorHint: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.caption,
    textAlign: "center",
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  topMeta: { flex: 1, gap: 2 },
  guardianName: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.bodyLarge,
  },
  liveRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  liveLabel: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.caption,
  },
  timerPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  timerText: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.caption,
    fontVariant: ["tabular-nums"],
  },
  mapWrap: {
    borderRadius: radius.xl,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
  },
  mapBadge: {
    position: "absolute",
    left: spacing.md,
    top: spacing.md,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  mapBadgeText: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.caption,
  },
  policeStrip: {
    position: "absolute",
    left: spacing.sm,
    right: spacing.sm,
    bottom: spacing.sm,
  },
  youMarker: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  youPulse: {
    ...StyleSheet.absoluteFill,
    borderRadius: 14,
  },
  youDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: "#FFFFFF",
  },
  statsRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  statCard: {
    flex: 1,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    alignItems: "center",
    gap: 2,
  },
  statValue: {
    fontFamily: typography.fontFamily.bold,
    fontSize: typography.size.bodyLarge,
  },
  statLabel: {
    fontFamily: typography.fontFamily.medium,
    fontSize: 11,
  },
  progressTrack: {
    height: 8,
    borderRadius: radius.pill,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: radius.pill,
  },
  extendHint: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.caption,
    textAlign: "center",
  },
  spacer: { flex: 1 },
  midScroll: {
    flex: 1,
    minHeight: 0,
  },
  midScrollContent: {
    gap: spacing.md,
    paddingBottom: spacing.sm,
  },
  actions: { gap: spacing.sm },
  sosFab: {
    position: "absolute",
    right: spacing.lg,
    zIndex: 20,
  },
  modalScrim: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
  },
  modalCard: {
    borderRadius: radius.xl,
    padding: spacing.lg,
    gap: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
  },
  shieldWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  modalTitle: {
    fontFamily: typography.fontFamily.bold,
    fontSize: typography.size.title,
    textAlign: "center",
  },
  modalBody: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
    textAlign: "center",
  },
  countdownRing: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  countdownNum: {
    fontFamily: typography.fontFamily.bold,
    fontSize: typography.size.title,
  },
  countdownUnit: {
    fontFamily: typography.fontFamily.medium,
    fontSize: 10,
    marginTop: -2,
  },
  sosSecondary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    minHeight: touch.minTarget,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    paddingHorizontal: spacing.lg,
    width: "100%",
  },
  sosSecondaryText: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.body,
  },
  arrivalBody: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.sm,
  },
  successRing: {
    width: 120,
    height: 120,
    borderRadius: 60,
    alignItems: "center",
    justifyContent: "center",
  },
  arrivalTitle: {
    fontFamily: typography.fontFamily.bold,
    fontSize: typography.size.display,
    lineHeight: typography.lineHeight.display,
    textAlign: "center",
  },
  arrivalSub: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
    textAlign: "center",
  },
  arrivalCard: {
    width: "100%",
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.md,
    marginTop: spacing.md,
  },
  arrivalStat: { gap: 2 },
  arrivalStatLabel: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.caption,
  },
  arrivalStatValue: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.bodyLarge,
  },
});
