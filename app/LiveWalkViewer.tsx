import { auth, db, functions } from "@/config/firebase";
import { spacing, typography } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as Haptics from "expo-haptics";
import * as Linking from "expo-linking";
import { useLocalSearchParams, useRouter } from "expo-router";
import { httpsCallable } from "firebase/functions";
import {
  collection as firestoreCollection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
} from "firebase/firestore";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type LatLng = { latitude: number; longitude: number };

type LivePoint = LatLng & {
  accuracy?: number | null;
  recordedAtMs?: number;
};

type SessionEvent = {
  id: string;
  type: string;
  createdAtMs: number;
};

const CLOSED_STATES = ["completed", "cancelled", "expired", "resolved", "closed"];
const MAX_TRAIL_POINTS = 600;
const AUTO_HOME_SECONDS = 10;

const EVENT_BANNERS: Record<string, { text: string; tone: "danger" | "warning" | "success" }> = {
  checkin_failed: { text: "Missed a safety check-in", tone: "danger" },
  checkin_requested: { text: "Check-in pending", tone: "warning" },
  sos: { text: "SOS triggered", tone: "danger" },
  activated: { text: "SOS is active", tone: "danger" },
  arrived: { text: "Arrived safely", tone: "success" },
  ended: { text: "Session ended", tone: "warning" },
  completed: { text: "Session ended safely", tone: "success" },
  resolved: { text: "Emergency resolved", tone: "success" },
  cancelled: { text: "Session was cancelled", tone: "warning" },
};

function isLatLng(value: unknown): value is LatLng {
  const v = value as Partial<LatLng> | undefined;
  return typeof v?.latitude === "number" && typeof v?.longitude === "number";
}

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function formatAgo(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

export default function LiveWalkViewer() {
  const { colors: c } = useAppTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{
    sessionId?: string;
    collection?: string;
    role?: string;
  }>();
  const collection = params.collection === "emergencies" ? "emergencies" : "routes";
  const isEmergency = collection === "emergencies";
  const isResponder = isEmergency && params.role === "responder";
  const loadedRef = useRef(false);
  const mapRef = useRef<MapView>(null);
  const [point, setPoint] = useState<LivePoint | null>(null);
  const [trail, setTrail] = useState<LatLng[]>([]);
  const [destination, setDestination] = useState<LatLng | null>(null);
  const [destinationLabel, setDestinationLabel] = useState<string | null>(null);
  const [routePath, setRoutePath] = useState<LatLng[]>([]);
  const [kind, setKind] = useState<string>(isEmergency ? "emergency" : "safe_walk");
  const [walkerName, setWalkerName] = useState<string | null>(null);
  const [status, setStatus] = useState("active");
  const [etaMinutes, setEtaMinutes] = useState<number | null>(null);
  const [remainingM, setRemainingM] = useState<number | null>(null);
  const [latestEvent, setLatestEvent] = useState<SessionEvent | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [acknowledging, setAcknowledging] = useState(false);
  const [following, setFollowing] = useState(true);
  const [mapReady, setMapReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const stopLiveRef = useRef<(() => void) | null>(null);
  const fittedRef = useRef(false);
  const sawLiveRef = useRef(false);
  const [endDismissed, setEndDismissed] = useState(false);
  const [homeIn, setHomeIn] = useState<number | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    if (!params.sessionId) {
      return () => clearInterval(timer);
    }
    const sessionRef = doc(db, collection, params.sessionId);
    const liveRef = doc(db, collection, params.sessionId, "live", "current");
    const eventsQuery = query(
      firestoreCollection(db, collection, params.sessionId, "events"),
      orderBy("createdAt", "desc"),
      limit(10),
    );
    const stopSession = onSnapshot(
      sessionRef,
      (snap) => {
        if (!snap.exists()) {
          setError("This safety session is no longer available.");
          return;
        }
        const data = snap.data();
        const nextStatus = String(data.state ?? data.status ?? "active");
        setStatus(nextStatus);
        setSessionLoaded(true);
        loadedRef.current = true;
        if (CLOSED_STATES.includes(nextStatus)) {
          stopLiveRef.current?.();
          stopLiveRef.current = null;
        }
        if (isLatLng(data.destination)) setDestination(data.destination);
        if (typeof data.destinationLabel === "string") setDestinationLabel(data.destinationLabel);
        if (Array.isArray(data.routePath) && data.routePath.length > 1) {
          setRoutePath(data.routePath.filter(isLatLng));
        }
        if (typeof data.kind === "string") setKind(data.kind);
        if (typeof data.walkerName === "string" && data.walkerName) setWalkerName(data.walkerName);
        if (typeof data.etaMinutes === "number") setEtaMinutes(data.etaMinutes);
        if (isLatLng(data.location)) {
          const seed = data.location;
          setPoint((prev) => prev ?? seed);
        }
      },
      () => {
        // Nearby helpers lose read access the moment an SOS closes.
        if (loadedRef.current) {
          stopLiveRef.current?.();
          stopLiveRef.current = null;
          setStatus("closed");
          return;
        }
        setError(
          isResponder
            ? "This SOS has already ended. Thank you for being ready to help."
            : "This session has ended or is no longer shared with you.",
        );
      },
    );
    const stopLive = onSnapshot(
      liveRef,
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        if (isLatLng(data.location)) {
          const location = data.location as LivePoint;
          setPoint({ ...location, recordedAtMs: data.recordedAtMs ?? location.recordedAtMs });
          setTrail((prev) => {
            const last = prev[prev.length - 1];
            if (
              last &&
              last.latitude === location.latitude &&
              last.longitude === location.longitude
            ) {
              return prev;
            }
            const next = [...prev, { latitude: location.latitude, longitude: location.longitude }];
            return next.length > MAX_TRAIL_POINTS ? next.slice(-MAX_TRAIL_POINTS) : next;
          });
        }
        if (typeof data.etaMinutes === "number") setEtaMinutes(data.etaMinutes);
        if (typeof data.remainingM === "number") setRemainingM(data.remainingM);
        if (Array.isArray(data.routePath) && data.routePath.length > 1) {
          setRoutePath(data.routePath.filter(isLatLng));
        }
      },
      // Rules deny live/current as soon as a session closes; the session listener owns error UI.
      () => undefined,
    );
    const stopEvents = onSnapshot(
      eventsQuery,
      (snap) => {
        const events = snap.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            type: String(data.type ?? ""),
            actorId: String(data.actorId ?? ""),
            createdAtMs: data.createdAt?.toMillis?.() ?? Date.now(),
          };
        });
        const meaningful = events.find((e) => e.type in EVENT_BANNERS);
        setLatestEvent(meaningful ?? null);
        const uid = auth.currentUser?.uid;
        if (uid && events.some((e) => e.type === "guardian_acknowledged" && e.actorId === uid)) {
          setAcknowledged(true);
        }
      },
      () => undefined,
    );
    stopLiveRef.current = stopLive;
    return () => {
      clearInterval(timer);
      stopSession();
      stopLive();
      stopEvents();
      stopLiveRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection, params.sessionId]);

  useEffect(() => {
    if (!point || !mapReady || !mapRef.current) return;
    if (!fittedRef.current) {
      fittedRef.current = true;
      const coords = [point, ...(destination ? [destination] : []), ...routePath];
      if (coords.length > 1) {
        mapRef.current.fitToCoordinates(coords, {
          edgePadding: { top: 80, right: 60, bottom: 260, left: 60 },
          animated: false,
        });
        return;
      }
    }
    if (following) {
      mapRef.current.animateCamera(
        { center: { latitude: point.latitude, longitude: point.longitude } },
        { duration: 600 },
      );
    }
  }, [point, mapReady, following, destination, routePath]);

  const initialRegion = useMemo(
    () =>
      point
        ? {
            latitude: point.latitude,
            longitude: point.longitude,
            latitudeDelta: 0.01,
            longitudeDelta: 0.01,
          }
        : undefined,
    // Only the first fix seeds the map; later fixes move the camera instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [Boolean(point)],
  );

  const acknowledge = useCallback(async () => {
    if (!params.sessionId || acknowledged || acknowledging) return;
    setAcknowledging(true);
    try {
      const eventId = `${params.sessionId}-${Date.now()}-ack`;
      if (isEmergency) {
        await httpsCallable(functions, "publishEmergencyEvent")({
          emergencyId: params.sessionId,
          type: "guardian_acknowledged",
          eventId,
        });
      } else {
        await httpsCallable(functions, "publishSafetyEvent")({
          sessionId: params.sessionId,
          type: "guardian_acknowledged",
          eventId,
        });
      }
      setAcknowledged(true);
    } catch (err) {
      Alert.alert(
        "Couldn't notify them",
        err instanceof Error ? err.message : "Please try again.",
      );
    } finally {
      setAcknowledging(false);
    }
  }, [acknowledged, acknowledging, isEmergency, params.sessionId]);

  const openDirections = useCallback(() => {
    if (!point) return;
    void Linking.openURL(
      `https://www.google.com/maps/dir/?api=1&destination=${point.latitude},${point.longitude}`,
    );
  }, [point]);

  const staleSeconds = point?.recordedAtMs
    ? Math.max(0, Math.round((now - point.recordedAtMs) / 1000))
    : null;
  const closed = CLOSED_STATES.includes(status);
  const sessionTitle = isResponder
    ? "SOS nearby"
    : isEmergency
      ? "SOS"
      : kind === "live_share"
        ? "Live trip"
        : "Safe Walk";
  const name = isResponder
    ? "Someone needs help"
    : walkerName ?? (isEmergency ? "Emergency" : "Someone you protect");
  const banner = latestEvent ? EVENT_BANNERS[latestEvent.type] : undefined;
  const statusDanger = isEmergency || status === "sos" || status === "check_in_pending";
  const bannerColors = banner
    ? {
        danger: { bg: c.dangerContainer, fg: c.danger },
        warning: { bg: c.warningContainer, fg: c.textPrimary },
        success: { bg: c.successContainer, fg: c.successText },
      }[banner.tone]
    : null;
  const arrivedSafely = latestEvent?.type === "arrived";
  const pillLabel = !closed
    ? status === "active"
      ? "Live"
      : status.replaceAll("_", " ")
    : arrivedSafely
      ? "Arrived"
      : status === "resolved"
        ? "Resolved"
        : status === "expired"
          ? "Expired"
          : "Ended";
  const endCard = closed ? endedCopy() : null;

  const goHome = useCallback(() => {
    router.replace("/(tabs)/Home" as never);
  }, [router]);

  useEffect(() => {
    if (!sessionLoaded) return;
    if (!closed) {
      sawLiveRef.current = true;
      return;
    }
    // Only auto-leave when the session ends while the guardian is watching.
    if (!sawLiveRef.current) return;
    sawLiveRef.current = false;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    setEndDismissed(false);
    setHomeIn(AUTO_HOME_SECONDS);
  }, [closed, sessionLoaded]);

  useEffect(() => {
    if (homeIn == null) return;
    if (homeIn <= 0) {
      goHome();
      return;
    }
    const timer = setTimeout(() => setHomeIn((s) => (s == null ? s : s - 1)), 1000);
    return () => clearTimeout(timer);
  }, [homeIn, goHome]);

  function endedCopy(): { icon: "check-circle" | "info"; title: string; body: string; good: boolean } {
    if (isResponder) {
      return {
        icon: status === "resolved" ? "check-circle" : "info",
        good: status === "resolved",
        title: "This SOS has ended",
        body: "The person is no longer sharing their location. Thank you for being ready to help.",
      };
    }
    if (isEmergency) {
      return status === "resolved"
        ? { icon: "check-circle", good: true, title: `${name} is safe`, body: "The SOS has been marked resolved." }
        : { icon: "info", good: false, title: "SOS ended", body: `${name} cancelled the SOS. Check in with them if you're unsure.` };
    }
    if (arrivedSafely) {
      return {
        icon: "check-circle",
        good: true,
        title: `${name} arrived safely`,
        body: destinationLabel ? `They reached ${destinationLabel}.` : "They reached their destination.",
      };
    }
    if (status === "expired") {
      return {
        icon: "info",
        good: false,
        title: `${sessionTitle} expired`,
        body: `No updates were received for a while. Check in with ${name} if you're unsure.`,
      };
    }
    return {
      icon: "info",
      good: false,
      title: `${name} ended their ${sessionTitle.toLowerCase()}`,
      body: "They stopped sharing their live location. Check in with them if you're unsure.",
    };
  }

  return (
    <View style={[styles.root, { backgroundColor: c.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} accessibilityLabel="Close live viewer" hitSlop={10}>
          <MaterialIcons name="close" size={26} color={c.textPrimary} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={[styles.kicker, { color: statusDanger ? c.danger : c.primary }]}>
            {sessionTitle.toUpperCase()}
          </Text>
          <Text style={[styles.title, { color: c.textPrimary }]} numberOfLines={1}>
            {name}
          </Text>
        </View>
        <View
          style={[
            styles.pill,
            {
              backgroundColor: closed
                ? c.surfaceVariant
                : statusDanger
                  ? c.dangerContainer
                  : c.successContainer,
            },
          ]}
        >
          {!closed ? (
            <View
              style={[styles.liveDot, { backgroundColor: statusDanger ? c.danger : c.success }]}
            />
          ) : null}
          <Text
            style={[
              styles.pillText,
              {
                color: closed ? c.textSecondary : statusDanger ? c.danger : c.successText,
              },
            ]}
          >
            {pillLabel}
          </Text>
        </View>
      </View>

      {error || !params.sessionId ? (
        <View style={styles.center}>
          <MaterialIcons name="location-off" size={48} color={c.danger} />
          <Text style={[styles.message, { color: c.textSecondary }]}>
            {error ?? "This notification does not contain a session."}
          </Text>
        </View>
      ) : point && initialRegion ? (
        <View style={styles.mapWrap}>
          <MapView
            ref={mapRef}
            style={styles.map}
            provider={PROVIDER_GOOGLE}
            initialRegion={initialRegion}
            onMapReady={() => setMapReady(true)}
            onPanDrag={() => setFollowing(false)}
            showsCompass
          >
            <Polyline
              key="planned-route"
              coordinates={routePath}
              strokeColor={c.primary + "66"}
              strokeWidth={6}
            />
            <Polyline
              key="walked-trail"
              coordinates={trail}
              strokeColor={statusDanger ? c.danger : c.primary}
              strokeWidth={5}
            />
            {destination ? (
              <Marker
                coordinate={destination}
                title={destinationLabel ?? "Destination"}
                pinColor="#4F46E5"
              />
            ) : null}
            <Marker coordinate={point} title={name} anchor={{ x: 0.5, y: 0.5 }}>
              <View
                style={[
                  styles.walkerDot,
                  { backgroundColor: statusDanger ? c.danger : c.primary, borderColor: c.surface },
                ]}
              />
            </Marker>
          </MapView>

          {banner && bannerColors ? (
            <View style={[styles.banner, { backgroundColor: bannerColors.bg }]}>
              <MaterialIcons
                name={banner.tone === "success" ? "check-circle" : "warning"}
                size={18}
                color={bannerColors.fg}
              />
              <Text style={[styles.bannerText, { color: bannerColors.fg }]}>{banner.text}</Text>
            </View>
          ) : null}

          {!following ? (
            <Pressable
              onPress={() => setFollowing(true)}
              style={[styles.recenter, { backgroundColor: c.surface, borderColor: c.border }]}
              accessibilityLabel="Follow live location"
            >
              <MaterialIcons name="my-location" size={22} color={c.primary} />
            </Pressable>
          ) : null}
        </View>
      ) : (
        <View style={styles.center}>
          <ActivityIndicator color={c.primary} size="large" />
          <Text style={[styles.message, { color: c.textSecondary }]}>
            Waiting for the first GPS update…
          </Text>
        </View>
      )}

      {!error && params.sessionId ? (
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: c.surface,
              borderColor: c.border,
              paddingBottom: insets.bottom + spacing.md,
            },
          ]}
        >
          {destinationLabel ? (
            <Text style={[styles.destination, { color: c.textSecondary }]} numberOfLines={1}>
              Heading to <Text style={{ color: c.textPrimary }}>{destinationLabel}</Text>
            </Text>
          ) : null}
          <View style={styles.stats}>
            <Stat label="ETA" value={etaMinutes != null && !closed ? `${Math.max(1, Math.round(etaMinutes))} min` : "—"} />
            <Stat label="Remaining" value={remainingM != null && !closed ? formatDistance(remainingM) : "—"} />
            <Stat
              label="Updated"
              value={staleSeconds != null ? formatAgo(staleSeconds) : "—"}
              warn={staleSeconds != null && staleSeconds > 60 && !closed}
            />
          </View>
          {staleSeconds != null && staleSeconds > 60 && !closed ? (
            <Text style={[styles.staleText, { color: c.warning }]}>
              No recent GPS update. They may have lost signal or closed background access.
            </Text>
          ) : null}
          {!closed ? (
            <View style={styles.actions}>
              <Pressable
                onPress={acknowledge}
                disabled={acknowledged || acknowledging}
                style={[
                  styles.primaryBtn,
                  { backgroundColor: acknowledged ? c.successContainer : statusDanger ? c.danger : c.primary },
                ]}
              >
                {acknowledging ? (
                  <ActivityIndicator color={c.textOnPrimary} />
                ) : (
                  <>
                    <MaterialIcons
                      name={acknowledged ? "check" : "visibility"}
                      size={18}
                      color={acknowledged ? c.successText : c.textOnPrimary}
                    />
                    <Text
                      style={[
                        styles.primaryBtnText,
                        { color: acknowledged ? c.successText : c.textOnPrimary },
                      ]}
                    >
                      {isResponder
                        ? acknowledged
                          ? "They know you're coming"
                          : "I'm on my way"
                        : acknowledged
                          ? "They know you're watching"
                          : "I'm watching"}
                    </Text>
                  </>
                )}
              </Pressable>
              <Pressable
                onPress={openDirections}
                disabled={!point}
                style={[styles.iconBtn, { borderColor: c.border }]}
                accessibilityLabel="Directions to their location"
              >
                <MaterialIcons name="directions" size={22} color={c.primary} />
              </Pressable>
              {statusDanger ? (
                <Pressable
                  onPress={() => Linking.openURL("tel:112")}
                  style={[styles.iconBtn, { borderColor: c.danger }]}
                  accessibilityLabel="Call emergency services"
                >
                  <MaterialIcons name="local-phone" size={22} color={c.danger} />
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}

      {endCard && !endDismissed && !error ? (
        <View style={[styles.endScrim, { backgroundColor: c.scrim }]}>
          <View style={[styles.endCard, { backgroundColor: c.surface }]}>
            <View
              style={[
                styles.endIcon,
                { backgroundColor: endCard.good ? c.successContainer : c.warningContainer },
              ]}
            >
              <MaterialIcons
                name={endCard.icon}
                size={32}
                color={endCard.good ? c.successText : c.warning}
              />
            </View>
            <Text style={[styles.endTitle, { color: c.textPrimary }]}>{endCard.title}</Text>
            <Text style={[styles.endBody, { color: c.textSecondary }]}>{endCard.body}</Text>
            <Pressable
              onPress={goHome}
              style={[styles.primaryBtn, styles.endBtn, { backgroundColor: c.primary }]}
              accessibilityRole="button"
            >
              <Text style={[styles.primaryBtnText, { color: c.textOnPrimary }]}>
                {homeIn != null && homeIn > 0 ? `Back to home (${homeIn})` : "Back to home"}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setHomeIn(null);
                setEndDismissed(true);
              }}
              style={styles.endSecondary}
              accessibilityRole="button"
            >
              <Text style={[styles.endSecondaryText, { color: c.primary }]}>
                View last location
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  const { colors: c } = useAppTheme();
  return (
    <View style={styles.stat}>
      <Text style={[styles.statLabel, { color: c.textTertiary }]}>{label}</Text>
      <Text style={[styles.statValue, { color: warn ? c.warning : c.textPrimary }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    minHeight: 72,
    paddingHorizontal: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  headerText: { flex: 1 },
  kicker: { fontFamily: typography.fontFamily.bold, fontSize: 11, letterSpacing: 1 },
  title: { fontFamily: typography.fontFamily.bold, fontSize: typography.size.title },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  liveDot: { width: 8, height: 8, borderRadius: 4 },
  pillText: {
    fontFamily: typography.fontFamily.bold,
    fontSize: typography.size.caption,
    textTransform: "capitalize",
  },
  mapWrap: { flex: 1 },
  map: { flex: 1 },
  walkerDot: { width: 20, height: 20, borderRadius: 10, borderWidth: 3 },
  banner: {
    position: "absolute",
    top: spacing.md,
    left: spacing.md,
    right: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: 12,
  },
  bannerText: { fontFamily: typography.fontFamily.bold, fontSize: typography.size.body },
  recenter: {
    position: "absolute",
    right: spacing.md,
    bottom: spacing.md,
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md },
  message: {
    fontFamily: typography.fontFamily.medium,
    textAlign: "center",
    paddingHorizontal: spacing.xl,
  },
  sheet: {
    borderTopWidth: 1,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.md,
  },
  destination: { fontFamily: typography.fontFamily.medium, fontSize: typography.size.body },
  stats: { flexDirection: "row", gap: spacing.md },
  stat: { flex: 1 },
  statLabel: { fontFamily: typography.fontFamily.medium, fontSize: typography.size.caption },
  statValue: { fontFamily: typography.fontFamily.bold, fontSize: typography.size.body },
  staleText: { fontFamily: typography.fontFamily.medium, fontSize: typography.size.caption },
  actions: { flexDirection: "row", gap: spacing.sm },
  primaryBtn: {
    flex: 1,
    height: 48,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  primaryBtnText: { fontFamily: typography.fontFamily.bold, fontSize: typography.size.body },
  endScrim: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
  },
  endCard: {
    width: "100%",
    maxWidth: 380,
    borderRadius: 24,
    padding: spacing.lg,
    alignItems: "center",
    gap: spacing.sm,
  },
  endIcon: {
    width: 64,
    height: 64,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  endTitle: {
    fontFamily: typography.fontFamily.bold,
    fontSize: typography.size.title,
    textAlign: "center",
  },
  endBody: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.body,
    textAlign: "center",
    marginBottom: spacing.sm,
  },
  endBtn: { flex: 0, alignSelf: "stretch" },
  endSecondary: { paddingVertical: spacing.sm },
  endSecondaryText: { fontFamily: typography.fontFamily.semibold, fontSize: typography.size.body },
  iconBtn: {
    width: 48,
    height: 48,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
