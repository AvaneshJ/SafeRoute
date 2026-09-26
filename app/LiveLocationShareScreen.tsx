import { PrimaryButton, SecondaryButton } from "@/components/design-system";
import { functions } from "@/config/firebase";
import { spacing, typography } from "@/constants/theme";
import {
  GUARDIANS_STORAGE_KEY,
  normalizeGuardians,
  type Guardian,
} from "@/core/guardians";
import { useAppTheme } from "@/hooks/useAppTheme";
import { mapsLink, notifyGuardianSms } from "@/services/guardianAlerts";
import { startSafetyTracking, stopSafetyTracking } from "@/services/safetyTracking";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import { useLocalSearchParams, useRouter } from "expo-router";
import { httpsCallable } from "firebase/functions";
import React, { useEffect, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function LiveLocationShareScreen() {
  const { colors: c } = useAppTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ startSharing?: string; targetGuardianId?: string }>();
  const [guardians, setGuardians] = useState<Guardian[]>([]);
  const [sharing, setSharing] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void AsyncStorage.getItem(GUARDIANS_STORAGE_KEY).then((raw) => {
      setGuardians(normalizeGuardians(raw ? JSON.parse(raw) : []));
    });
  }, []);

  const selected =
    guardians.find((item) => item.id === params.targetGuardianId) ??
    guardians.find((item) => item.isPrimary) ??
    guardians[0];

  const start = async () => {
    if (!selected) {
      Alert.alert("Add a guardian", "Choose a trusted guardian before sharing.");
      return;
    }
    setBusy(true);
    let position: Location.LocationObject | null = null;
    try {
      position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const result = await httpsCallable<
        Record<string, unknown>,
        {
          sessionId: string;
          smsRequired?: boolean;
          sms_required?: boolean;
          delivery?: { smsRequired?: boolean };
        }
      >(functions, "startLiveShare")({
        guardianUserId: selected.guardianUserId ?? null,
        guardianUserIds: selected.guardianUserId ? [selected.guardianUserId] : [],
        eventId: `share-${Date.now()}`,
        location: {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        },
      });
      await startSafetyTracking("routes", result.data.sessionId);
      setSessionId(result.data.sessionId);
      setSharing(true);
      const smsRequired =
        result.data.delivery?.smsRequired ??
        result.data.smsRequired ??
        result.data.sms_required ??
        false;
      if (smsRequired) {
        await notifyGuardianSms(
          selected.phone,
          `I'm sharing my live location with you on SafeRoute. Last known location: ${mapsLink(position.coords.latitude, position.coords.longitude)}.`,
        );
      }
    } catch (error) {
      if (position) {
        await notifyGuardianSms(
          selected.phone,
          `I'm sharing my location from SafeRoute. Last known location: ${mapsLink(position.coords.latitude, position.coords.longitude)}.`,
        );
        Alert.alert(
          "SMS fallback opened",
          "This guardian is not connected in SafeRoute, so live in-app viewing is unavailable.",
        );
      } else {
        Alert.alert("Could not start sharing", (error as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      if (sessionId) {
        await httpsCallable(functions, "publishSafetyEvent")({
          sessionId,
          type: "cancelled",
          eventId: `${sessionId}-stopped`,
        }).catch(console.warn);
      }
      await stopSafetyTracking();
      setSharing(false);
      setSessionId("");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (
      params.startSharing === "true" &&
      guardians.length > 0 &&
      !sharing &&
      !busy
    ) {
      // Navigation can explicitly request immediate sharing after contacts load.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void start();
    }
    // Run once after contacts load; start() owns subsequent state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guardians.length, params.startSharing]);

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: c.background,
          paddingTop: Math.max(insets.top, spacing.lg),
          paddingBottom: Math.max(insets.bottom, spacing.lg),
        },
      ]}
    >
      <View style={styles.body}>
        <Text style={[styles.title, { color: c.textPrimary }]}>Live location sharing</Text>
        <Text style={[styles.copy, { color: c.textSecondary }]}>
          {sharing
            ? `${selected?.name ?? "Your guardian"} can see your moving location. Background updates are requested every 10 seconds.`
            : selected
              ? `Share securely with ${selected.name}.`
              : "Add a trusted guardian before sharing."}
        </Text>
      </View>
      <PrimaryButton
        label={sharing ? "Stop sharing" : "Start sharing"}
        onPress={() => void (sharing ? stop() : start())}
        loading={busy}
        disabled={!selected}
      />
      <SecondaryButton label="Close" onPress={() => router.back()} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: spacing.lg, gap: spacing.md },
  body: { flex: 1, justifyContent: "center", gap: spacing.md },
  title: { fontFamily: typography.fontFamily.bold, fontSize: typography.size.headline },
  copy: { fontFamily: typography.fontFamily.regular, fontSize: typography.size.bodyLarge, lineHeight: typography.lineHeight.bodyLarge },
});
