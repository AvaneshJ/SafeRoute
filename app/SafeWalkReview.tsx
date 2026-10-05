import {
  GradientText,
  PrimaryButton,
  SecondaryButton,
  UserAvatar,
} from "@/components/design-system";
import { motion, radius, spacing, typography } from "@/constants/theme";
import { PRIVACY_SHARE_KEY } from "@/constants/preferences";
import {
  formatDistanceKm,
  formatDurationMin,
  LAST_GUARDIAN_KEY,
} from "@/core/safeWalkTrip";
import { useAppTheme } from "@/hooks/useAppTheme";
import { functions } from "@/config/firebase";
import {
  notifyGuardianSms,
  safeWalkStartedMessage,
} from "@/services/guardianAlerts";
import { readGuardians } from "@/services/guardianSync";
import { startSafetyTracking } from "@/services/safetyTracking";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";
import * as Location from "expo-location";
import { useLocalSearchParams, useRouter } from "expo-router";
import { httpsCallable } from "firebase/functions";
import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const WALKER_NAME_KEY = "@SafeRoute:displayName";

type FeatureRow = {
  icon: React.ComponentProps<typeof MaterialIcons>["name"];
  title: string;
  body: string;
};

const FEATURES: FeatureRow[] = [
  {
    icon: "my-location",
    title: "GPS monitoring on",
    body: "SafeRoute tracks your walk. Your guardian gets a map pin by SMS when you start.",
  },
  {
    icon: "timer",
    title: "Automatic check-ins",
    body: "If you pause unexpectedly, we’ll ask if you’re okay.",
  },
  {
    icon: "emergency",
    title: "SOS available throughout",
    body: "One tap texts your guardian a map pin of your last known spot.",
  },
];

export default function SafeWalkReviewScreen() {
  const { colors: c, elevation: elev, gradients: grads } = useAppTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<Record<string, string>>();
  const [starting, setStarting] = useState(false);
  const fade = useRef(new Animated.Value(1)).current;

  const destTitle = params.destTitle ?? "Destination";
  const originLabel = params.originLabel ?? "Current location";
  const distanceKm = Number(params.distanceKm ?? 0);
  const etaMin = Number(params.etaMin ?? 0);
  const guardianName = params.guardianName ?? "Guardian";
  const guardianRelationship = params.guardianRelationship ?? "";
  const distanceWarn = params.distanceWarn === "1";

  const startWalk = async () => {
    setStarting(true);
    const sharingPreference = await AsyncStorage.getItem(PRIVACY_SHARE_KEY);
    if (sharingPreference === "false") {
      Alert.alert(
        "Live trip sharing is off",
        "Enable “Share live trips with guardians” in Privacy settings before starting a Safe Walk.",
      );
      setStarting(false);
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    if (params.guardianId) {
      await AsyncStorage.setItem(LAST_GUARDIAN_KEY, params.guardianId);
    }

    Animated.timing(fade, {
      toValue: 0.4,
      duration: motion.normal,
      useNativeDriver: true,
    }).start();

    let sessionId = "";
    let smsRequired = !params.guardianId;
    let lat = Number(params.originLat ?? 0);
    let lng = Number(params.originLng ?? 0);
    let walkerName: string | undefined;
    try {
      walkerName = (await AsyncStorage.getItem(WALKER_NAME_KEY)) || undefined;
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (perm.status === Location.PermissionStatus.GRANTED) {
          const pos = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          lat = pos.coords.latitude;
          lng = pos.coords.longitude;
        }
      } catch {
        /* use params */
      }

      // Params can be stale; the synced list has the latest connection state.
      const fresh = (await readGuardians()).find((g) => g.id === params.guardianId);
      const selectedUserId =
        fresh?.verified && fresh.guardianUserId ? fresh.guardianUserId : undefined;
      const started = await httpsCallable<
        Record<string, unknown>,
        {
          sessionId: string;
          delivery?: { smsRequired?: boolean; channel?: string };
          smsRequired?: boolean;
          sms_required?: boolean;
        }
      >(functions, "startSafeWalk")({
        destination: { latitude: Number(params.destLat), longitude: Number(params.destLng) },
        location: { latitude: lat, longitude: lng },
        destinationLabel: destTitle,
        etaMinutes: Number(params.etaMin ?? etaMin) || 1,
        ...(selectedUserId ? { guardianUserIds: [selectedUserId] } : {}),
        eventId: `walk-start-${Date.now()}`,
        walkerName,
      });
      sessionId = started.data.sessionId;
      const serverSms =
        started.data.delivery?.smsRequired ??
        started.data.smsRequired ??
        started.data.sms_required ??
        started.data.delivery?.channel === "sms_required";
      // The server may fall back to other connected guardians; the one picked
      // here still needs a text if they aren't connected.
      smsRequired = Boolean(serverSms) || !selectedUserId;
      await startSafetyTracking("routes", sessionId);
    } catch (error) {
      console.warn("Online Safe Walk start unavailable; using SMS fallback.", error);
      smsRequired = true;
    }

    try {
      if (smsRequired && params.guardianPhone) {
        await notifyGuardianSms(
          params.guardianPhone,
          safeWalkStartedMessage({
            walkerName,
            lat,
            lng,
          }),
        );
      }
    } catch {
      /* non-blocking */
    }

    if (!sessionId && !params.guardianPhone) {
      Alert.alert(
        "Could not start",
        "SafeRoute could not connect to the guardian and no SMS number is available.",
      );
      setStarting(false);
      return;
    }

    router.replace({
      pathname: "/SafeWalkLive",
      params: {
        ...params,
        startedAt: String(Date.now()),
        sessionId,
      },
    } as never);
  };

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: c.background,
          paddingTop: Math.max(insets.top, spacing.md),
          paddingBottom: Math.max(insets.bottom, spacing.lg),
        },
      ]}
    >
      <Animated.View style={[styles.flex, { opacity: fade }]}>
        <Pressable
          onPress={() => router.back()}
          style={styles.back}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <MaterialIcons name="arrow-back" size={22} color={c.textPrimary} />
        </Pressable>

        <Text style={[styles.eyebrow, { color: c.primary }]}>STEP 3 OF 3</Text>
        <GradientText colors={[...grads.greeting]} style={styles.title}>
          Review & Start
        </GradientText>
        <Text style={[styles.subtitle, { color: c.textSecondary }]}>
          Double-check the details. Your guardian is notified the moment you
          start.
        </Text>

        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
        >
          <View
            style={[
              styles.card,
              {
                backgroundColor: c.surface,
                borderColor: c.border,
                ...elev.card,
              },
            ]}
          >
            <Row
              label="Destination"
              value={`${originLabel} → ${destTitle}`}
              color={c}
            />
            <Divider color={c.divider} />
            <Row
              label="Walking distance"
              value={formatDistanceKm(distanceKm)}
              color={c}
            />
            <Divider color={c.divider} />
            <Row
              label="ETA"
              value={formatDurationMin(etaMin)}
              color={c}
            />
          </View>

          {distanceWarn ? (
            <View
              style={[
                styles.warn,
                {
                  backgroundColor: c.warningContainer,
                  borderColor: c.warning,
                },
              ]}
            >
              <MaterialIcons name="info-outline" size={18} color={c.warning} />
              <Text style={[styles.warnText, { color: c.textPrimary }]}>
                This walk is over 3 km. Safe Route is recommended for longer
                trips.
              </Text>
            </View>
          ) : null}

          <View
            style={[
              styles.card,
              {
                backgroundColor: c.surface,
                borderColor: c.border,
                ...elev.card,
              },
            ]}
          >
            <Text style={[styles.cardLabel, { color: c.textTertiary }]}>
              Selected guardian
            </Text>
            <View style={styles.guardianRow}>
              <UserAvatar name={guardianName} size={48} />
              <View style={styles.guardianMeta}>
                <Text style={[styles.guardianName, { color: c.textPrimary }]}>
                  {guardianName}
                </Text>
                <Text style={[styles.guardianRel, { color: c.textSecondary }]}>
                  {guardianRelationship || "Trusted contact"}
                </Text>
              </View>
              <View
                style={[
                  styles.livePill,
                  { backgroundColor: c.successContainer },
                ]}
              >
                <Text style={[styles.livePillText, { color: c.successText }]}>
                  Auto-notify
                </Text>
              </View>
            </View>
          </View>

          <View
            style={[
              styles.card,
              {
                backgroundColor: c.surface,
                borderColor: c.border,
                ...elev.card,
              },
            ]}
          >
            <Text style={[styles.cardLabel, { color: c.textTertiary }]}>
              Emergency contacts
            </Text>
            <Text style={[styles.emergencyCopy, { color: c.textSecondary }]}>
              SOS will alert {guardianName} and open the emergency flow with
              your live location.
            </Text>
          </View>

          <View
            style={[
              styles.card,
              {
                backgroundColor: c.surface,
                borderColor: c.border,
                ...elev.card,
              },
            ]}
          >
            <Text style={[styles.cardLabel, { color: c.textTertiary }]}>
              Safety features
            </Text>
            {FEATURES.map((f) => (
              <View key={f.title} style={styles.featureRow}>
                <View
                  style={[
                    styles.featureIcon,
                    { backgroundColor: c.primaryContainer },
                  ]}
                >
                  <MaterialIcons name={f.icon} size={18} color={c.primary} />
                </View>
                <View style={styles.featureMeta}>
                  <Text
                    style={[styles.featureTitle, { color: c.textPrimary }]}
                  >
                    {f.title}
                  </Text>
                  <Text
                    style={[styles.featureBody, { color: c.textSecondary }]}
                  >
                    {f.body}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </ScrollView>
      </Animated.View>

      <View style={styles.cta}>
        {starting ? (
          <View style={styles.starting}>
            <ActivityIndicator color={c.primary} />
            <Text style={[styles.startingText, { color: c.textSecondary }]}>
              Notifying {guardianName} · starting GPS…
            </Text>
          </View>
        ) : (
          <>
            <PrimaryButton label="Start Safe Walk" onPress={() => void startWalk()} />
            <SecondaryButton label="Go back" onPress={() => router.back()} />
          </>
        )}
      </View>
    </View>
  );
}

function Row({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: { textTertiary: string; textPrimary: string };
}) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: color.textTertiary }]}>
        {label}
      </Text>
      <Text style={[styles.rowValue, { color: color.textPrimary }]}>
        {value}
      </Text>
    </View>
  );
}

function Divider({ color }: { color: string }) {
  return <View style={[styles.divider, { backgroundColor: color }]} />;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  flex: { flex: 1 },
  back: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: -8,
  },
  eyebrow: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.caption,
    letterSpacing: 1,
  },
  title: {
    fontFamily: typography.fontFamily.bold,
    fontSize: typography.size.display,
    lineHeight: typography.lineHeight.display,
    letterSpacing: typography.tracking.heading,
  },
  subtitle: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  scroll: {
    gap: spacing.md,
    paddingBottom: spacing.md,
  },
  card: {
    borderRadius: radius.xl,
    padding: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
  },
  cardLabel: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.caption,
  },
  row: { gap: 4 },
  rowLabel: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.caption,
  },
  rowValue: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.bodyLarge,
    lineHeight: typography.lineHeight.bodyLarge,
  },
  divider: { height: StyleSheet.hairlineWidth },
  warn: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    alignItems: "flex-start",
  },
  warnText: {
    flex: 1,
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
  },
  guardianRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  guardianMeta: { flex: 1, gap: 2 },
  guardianName: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.bodyLarge,
  },
  guardianRel: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.caption,
  },
  livePill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
  },
  livePillText: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: 11,
  },
  emergencyCopy: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  featureRow: {
    flexDirection: "row",
    gap: spacing.md,
    alignItems: "flex-start",
  },
  featureIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  featureMeta: { flex: 1, gap: 2 },
  featureTitle: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.body,
  },
  featureBody: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
  },
  cta: { gap: spacing.sm },
  starting: {
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.md,
  },
  startingText: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.caption,
  },
});
