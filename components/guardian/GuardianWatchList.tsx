import { auth, db } from "@/config/firebase";
import { radius, spacing, typography } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useRouter } from "expo-router";
import { onAuthStateChanged } from "firebase/auth";
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  type QuerySnapshot,
} from "firebase/firestore";
import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

type WatchedSession = {
  id: string;
  collection: "routes" | "emergencies";
  kind: string;
  state: string;
  walkerName: string;
  destinationLabel: string | null;
  updatedAtMs: number;
};

type Protectee = { id: string; name: string };

const LIVE_STATES = ["active", "check_in_pending", "sos"];

function toSessions(
  snap: QuerySnapshot,
  source: WatchedSession["collection"],
  uid: string,
): WatchedSession[] {
  return snap.docs
    .map((d) => {
      const data = d.data();
      return {
        id: d.id,
        collection: source,
        ownerId: String(data.ownerId ?? data.userId ?? ""),
        kind: source === "emergencies" ? "emergency" : String(data.kind ?? "safe_walk"),
        state: String(data.state ?? "active"),
        walkerName: String(data.walkerName || "Someone you protect"),
        destinationLabel: typeof data.destinationLabel === "string" ? data.destinationLabel : null,
        updatedAtMs: data.updatedAt?.toMillis?.() ?? 0,
      };
    })
    .filter((s) => s.ownerId !== uid && LIVE_STATES.includes(s.state))
    .map(({ ownerId: _ownerId, ...rest }) => rest);
}

function sessionLabel(s: WatchedSession): string {
  if (s.collection === "emergencies") return "SOS active";
  if (s.state === "sos") return "SOS during Safe Walk";
  if (s.state === "check_in_pending") return "Check-in pending";
  return s.kind === "live_share" ? "On a trip" : "On a Safe Walk";
}

/** Live sessions the signed-in user is guarding, plus the people who added them. */
export function GuardianWatchList() {
  const { colors: c } = useAppTheme();
  const router = useRouter();
  const [routes, setRoutes] = useState<WatchedSession[]>([]);
  const [emergencies, setEmergencies] = useState<WatchedSession[]>([]);
  const [protectees, setProtectees] = useState<Protectee[]>([]);

  useEffect(() => {
    let stops: Array<() => void> = [];
    const stopAll = () => {
      stops.forEach((stop) => stop());
      stops = [];
    };
    const stopAuth = onAuthStateChanged(auth, (user) => {
      stopAll();
      if (!user) {
        setRoutes([]);
        setEmergencies([]);
        setProtectees([]);
        return;
      }
      const uid = user.uid;
      const watch = (source: WatchedSession["collection"], set: typeof setRoutes) =>
        onSnapshot(
          // The state filter is required: rules only let guardians read open sessions.
          query(
            collection(db, source),
            where("participantIds", "array-contains", uid),
            source === "routes" ? where("state", "in", LIVE_STATES) : where("state", "==", "active"),
            orderBy("updatedAt", "desc"),
            limit(20),
          ),
          (snap) => set(toSessions(snap, source, uid)),
          (err) => console.warn(`[guardian] ${source} watch failed`, err),
        );
      stops.push(watch("routes", setRoutes), watch("emergencies", setEmergencies));
      stops.push(
        onSnapshot(
          query(
            collection(db, "guardians"),
            where("guardianUserId", "==", uid),
            where("status", "==", "accepted"),
          ),
          (snap) =>
            setProtectees(
              snap.docs.map((d) => ({
                id: d.id,
                name: String(d.get("ownerName") || "SafeRoute user"),
              })),
            ),
          (err) => console.warn("[guardian] protectees watch failed", err),
        ),
      );
    });
    return () => {
      stopAuth();
      stopAll();
    };
  }, []);

  const sessions = [...emergencies, ...routes].sort((a, b) => {
    const urgent = (s: WatchedSession) => (s.collection === "emergencies" || s.state !== "active" ? 1 : 0);
    return urgent(b) - urgent(a) || b.updatedAtMs - a.updatedAtMs;
  });

  if (sessions.length === 0 && protectees.length === 0) return null;

  return (
    <View style={styles.root}>
      {sessions.length > 0 ? (
        <View style={styles.group}>
          <Text style={[styles.heading, { color: c.textPrimary }]}>Live now</Text>
          {sessions.map((s) => {
            const urgent = s.collection === "emergencies" || s.state !== "active";
            return (
              <Pressable
                key={`${s.collection}/${s.id}`}
                onPress={() =>
                  router.push({
                    pathname: "/LiveWalkViewer",
                    params: { sessionId: s.id, collection: s.collection },
                  } as never)
                }
                style={[
                  styles.card,
                  {
                    backgroundColor: urgent ? c.dangerContainer : c.surface,
                    borderColor: urgent ? c.danger : c.border,
                  },
                ]}
                accessibilityRole="button"
                accessibilityLabel={`Watch ${s.walkerName} live`}
              >
                <View style={[styles.dot, { backgroundColor: urgent ? c.danger : c.success }]} />
                <View style={styles.cardText}>
                  <Text style={[styles.name, { color: c.textPrimary }]} numberOfLines={1}>
                    {s.walkerName}
                  </Text>
                  <Text
                    style={[styles.meta, { color: urgent ? c.danger : c.textSecondary }]}
                    numberOfLines={1}
                  >
                    {sessionLabel(s)}
                    {s.destinationLabel ? ` · to ${s.destinationLabel}` : ""}
                  </Text>
                </View>
                <Text style={[styles.watch, { color: urgent ? c.danger : c.primary }]}>Watch</Text>
                <MaterialIcons
                  name="chevron-right"
                  size={20}
                  color={urgent ? c.danger : c.primary}
                />
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {protectees.length > 0 ? (
        <View style={styles.group}>
          <Text style={[styles.heading, { color: c.textPrimary }]}>You protect</Text>
          <View style={styles.chips}>
            {protectees.map((p) => (
              <View
                key={p.id}
                style={[styles.chip, { backgroundColor: c.primaryContainer }]}
              >
                <MaterialIcons name="shield" size={14} color={c.primaryOnContainer} />
                <Text style={[styles.chipText, { color: c.primaryOnContainer }]}>{p.name}</Text>
              </View>
            ))}
          </View>
          {sessions.length === 0 ? (
            <Text style={[styles.meta, { color: c.textSecondary }]}>
              You will get a notification when they start a Safe Walk, share a trip, or trigger SOS.
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.lg, marginBottom: spacing.lg },
  group: { gap: spacing.sm },
  heading: { fontFamily: typography.fontFamily.bold, fontSize: typography.size.title },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  cardText: { flex: 1 },
  name: { fontFamily: typography.fontFamily.bold, fontSize: typography.size.body },
  meta: { fontFamily: typography.fontFamily.regular, fontSize: typography.size.caption },
  watch: { fontFamily: typography.fontFamily.semibold, fontSize: typography.size.caption },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  chipText: { fontFamily: typography.fontFamily.medium, fontSize: typography.size.caption },
});
