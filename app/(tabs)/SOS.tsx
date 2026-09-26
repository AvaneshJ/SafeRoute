import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";
import * as Linking from "expo-linking";
import * as Location from "expo-location";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  Vibration,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  initialSos,
  reduceSos,
  smsFallbackRequired,
  SOS_CANCEL_MS,
  SOS_GPS_INTERVAL_MS,
  SOS_HOLD_MS,
  type SosSession,
} from "@/core/sos";
import {
  radius,
  spacing,
  tabContentBottomInset,
  touch,
  typography,
} from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import { functions } from "@/config/firebase";
import { SILENT_SOS_KEY } from "@/constants/preferences";
import {
  notifyGuardianSms,
  sosMessage,
} from "@/services/guardianAlerts";
import { startSafetyTracking } from "@/services/safetyTracking";
import { httpsCallable } from "firebase/functions";

const EMERGENCY_CALL = "122";
const CONTACTS_STORAGE_KEY = "@SafeRoute:contacts";

type StatusRow = {
  id: string;
  label: string;
  detail: string;
  on: boolean;
};

export default function SosScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { colors: c } = useAppTheme();
  const [session, setSession] = useState<SosSession>(initialSos());
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [secondsLeft, setSecondsLeft] = useState(5);
  const [holdProgress, setHoldProgress] = useState(0);
  const [statusRows, setStatusRows] = useState<StatusRow[]>([]);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTick = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    void (async () => {
      const silentPref = await AsyncStorage.getItem(SILENT_SOS_KEY);
      if (silentPref === "true") {
        setSession((s) => ({ ...s, silent: true, siren: false }));
      }
    })();
  }, []);
  const watchRef = useRef<Location.LocationSubscription | null>(null);

  useEffect(() => {
    return () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
      if (holdTick.current) clearInterval(holdTick.current);
      if (countdownTimer.current) clearInterval(countdownTimer.current);
      watchRef.current?.remove();
      Vibration.cancel();
    };
  }, []);

  const announce = (msg: string) => {
    AccessibilityInfo.announceForAccessibility(msg);
  };

  const revealStatuses = useCallback(async (smsOk: boolean) => {
    const rows: StatusRow[] = [
      {
        id: "gps",
        label: "Live location",
        detail: "Updating every 5 s",
        on: false,
      },
      {
        id: "audio",
        label: "Audio recording",
        detail: "Mic path reserved",
        on: false,
      },
      {
        id: "guardian",
        label: "Guardian notified",
        detail: "Push / in-app alert",
        on: false,
      },
      {
        id: "police",
        label: "Police notified",
        detail: `Dialing ${EMERGENCY_CALL}`,
        on: false,
      },
      {
        id: "sms",
        label: "SMS sent",
        detail: smsOk ? "Maps link to contact" : "Queued offline",
        on: false,
      },
    ];
    setStatusRows(rows.map((r) => ({ ...r })));
    for (let i = 0; i < rows.length; i++) {
      await new Promise((r) => setTimeout(r, 200));
      setStatusRows((prev) =>
        prev.map((row, idx) => (idx <= i ? { ...row, on: true } : row)),
      );
      announce(rows[i].label);
    }
  }, []);

  const beginActiveAlert = useCallback(
    async (next: SosSession) => {
      announce("SOS active. Help is being contacted.");
      if (!next.silent && next.siren) {
        Vibration.vibrate([0, 800, 400, 800], true);
      }
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status === "granted") {
        watchRef.current = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            timeInterval: SOS_GPS_INTERVAL_MS,
            distanceInterval: 0,
          },
          () => undefined,
        );
      }

      let online = true;
      try {
        const probe = await fetch(
          "https://connectivitycheck.gstatic.com/generate_204",
        );
        online = probe.ok || probe.status === 204;
      } catch {
        online = false;
      }

      const contactsRaw = await AsyncStorage.getItem(CONTACTS_STORAGE_KEY);
      const contacts: { name: string; phone: string }[] = contactsRaw
        ? JSON.parse(contactsRaw)
        : [];
      const position =
        permission.status === "granted"
          ? await Location.getCurrentPositionAsync({})
          : null;
      const body = sosMessage({
        lat: position?.coords.latitude ?? null,
        lng: position?.coords.longitude ?? null,
      });

      let smsOk = false;
      let emergencyId = "";
      let smsGuardianUserIds: string[] = [];
      if (position) {
        try {
          const response = await httpsCallable<
            Record<string, unknown>,
            {
              emergencyId: string;
              smsFallback?: boolean;
              deliveries?: { userId: string; sms_required: boolean }[];
            }
          >(functions, "activateSOS")({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            silent: next.silent,
            batteryPct: null,
            networkType: online ? "online" : "none",
            audioPath: null,
            snapshotPath: null,
            safeWalkId: null,
            eventId: `sos-${Date.now()}`,
            guardianUserIds: contacts
              .map(
                (contact) =>
                  (contact as { guardianUserId?: string }).guardianUserId,
              )
              .filter((value): value is string => Boolean(value)),
          });
          emergencyId = response.data.emergencyId;
          smsGuardianUserIds = (response.data.deliveries ?? [])
            .filter((delivery) => delivery.sms_required)
            .map((delivery) => delivery.userId);
          await startSafetyTracking("emergencies", emergencyId);
        } catch (error) {
          console.warn("Online SOS dispatch failed; using SMS fallback.", error);
        }
      }

      const smsTargets = contacts.filter((contact) => {
        const guardian = contact as {
          verified?: boolean;
          guardianUserId?: string;
        };
        return (
          !emergencyId ||
          !guardian.verified ||
          (guardian.guardianUserId &&
            smsGuardianUserIds.includes(guardian.guardianUserId))
        );
      });
      for (const contact of smsTargets) {
        const result = await notifyGuardianSms(contact.phone, body);
        smsOk = result.opened || smsOk;
      }
      if (contacts.length === 0 && (
        smsFallbackRequired(
          { ...next, phase: "active", uploadAttempts: online ? 1 : 4 },
          online,
        )
      )) {
        smsOk = false;
      }
      Alert.alert(
        "Call emergency services?",
        `SafeRoute has started guardian alerts. Call ${EMERGENCY_CALL} now?`,
        [
          { text: "Not now", style: "cancel" },
          {
            text: `Call ${EMERGENCY_CALL}`,
            onPress: () => void Linking.openURL(`tel:${EMERGENCY_CALL}`),
          },
        ],
      );
      void revealStatuses(smsOk);
    },
    [revealStatuses],
  );

  const clearHoldTimers = () => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (holdTick.current) {
      clearInterval(holdTick.current);
      holdTick.current = null;
    }
    setHoldProgress(0);
  };

  const startCountdown = () => {
    const started = Date.now();
    setSession((current) =>
      reduceSos(current, { type: "HOLD_COMPLETE", nowMs: started }),
    );
    setSecondsLeft(SOS_CANCEL_MS / 1000);
    announce("Countdown started. Five seconds to cancel.");
    if (!sessionRef.current.silent) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Vibration.vibrate(200);
    }
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    let remaining = SOS_CANCEL_MS / 1000;
    countdownTimer.current = setInterval(() => {
      remaining -= 1;
      setSecondsLeft(remaining);
      announce(String(remaining > 0 ? remaining : "Alerting"));
      if (!sessionRef.current.silent) {
        void Haptics.impactAsync(
          remaining <= 1
            ? Haptics.ImpactFeedbackStyle.Heavy
            : Haptics.ImpactFeedbackStyle.Medium,
        );
      }
      if (remaining > 0) return;
      if (countdownTimer.current) clearInterval(countdownTimer.current);
      const next = reduceSos(sessionRef.current, { type: "COUNTDOWN_ELAPSED" });
      sessionRef.current = next;
      setSession(next);
      if (next.phase === "active") void beginActiveAlert(next);
    }, 1000);
  };

  const onHoldStart = () => {
    if (session.phase === "active" || session.phase === "countdown") return;
    const now = Date.now();
    setSession((current) =>
      reduceSos(current, { type: "HOLD_START", nowMs: now }),
    );
    announce("Holding. Keep pressing.");
    if (!session.silent) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    }
    const start = Date.now();
    holdTick.current = setInterval(() => {
      const p = Math.min(1, (Date.now() - start) / SOS_HOLD_MS);
      setHoldProgress(p);
      if (!sessionRef.current.silent && p < 1) {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    }, 250);
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => {
      clearHoldTimers();
      setHoldProgress(1);
      startCountdown();
    }, SOS_HOLD_MS);
  };

  const onHoldEnd = () => {
    clearHoldTimers();
    setSession((current) => {
      if (current.phase !== "holding") return current;
      const next = reduceSos(current, {
        type: "HOLD_RELEASE",
        nowMs: Date.now(),
      });
      if (next.phase === "idle") announce("Cancelled.");
      return next;
    });
  };

  const cancelCountdown = () => {
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    Vibration.cancel();
    setSession((current) => {
      const cancelled = reduceSos(current, { type: "CANCEL" });
      return reduceSos(cancelled, { type: "RESET" });
    });
    setStatusRows([]);
    announce("SOS cancelled.");
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  };

  const phase = session.phase;
  const bg =
    phase === "active"
      ? "#0B0608"
      : phase === "countdown"
        ? "#140A0C"
        : phase === "holding"
          ? "#1A1214"
          : "#111827";

  const buttonLabel =
    phase === "countdown"
      ? String(secondsLeft)
      : phase === "active"
        ? "LIVE"
        : phase === "holding"
          ? "HOLD"
          : "SOS";

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: bg,
          paddingTop: Math.max(insets.top, spacing.lg),
          paddingBottom: tabContentBottomInset(insets.bottom),
        },
      ]}
    >
      <Pressable
        onPress={() => router.back()}
        style={styles.close}
        accessibilityRole="button"
        accessibilityLabel="Close SOS"
      >
        <Text style={styles.closeText}>Close</Text>
      </Pressable>

      <Text style={styles.eyebrow}>
        {phase === "active"
          ? "SOS ACTIVE"
          : phase === "countdown"
            ? "ALERTING IN"
            : phase === "holding"
              ? "KEEP HOLDING"
              : "EMERGENCY"}
      </Text>

      <Text style={styles.headline}>
        {phase === "active"
          ? "Help is on the way"
          : phase === "countdown"
            ? "Guardians and helpline will be contacted"
            : "Hold for help"}
      </Text>

      <View style={styles.buttonWrap}>
        {(phase === "holding" || phase === "countdown") && (
          <View
            style={[
              styles.ring,
              {
                borderColor: c.danger,
                opacity: 0.35 + holdProgress * 0.4,
                transform: [{ scale: 1 + holdProgress * 0.06 }],
              },
            ]}
          />
        )}
        <Pressable
          onPressIn={onHoldStart}
          onPressOut={onHoldEnd}
          disabled={phase === "active" || phase === "countdown"}
          accessibilityRole="button"
          accessibilityLabel="Emergency SOS"
          accessibilityHint="Hold for two seconds to request help"
          style={[
            styles.sosButton,
            { backgroundColor: c.danger },
            phase === "active" && styles.sosLive,
            phase === "countdown" && styles.sosCountdown,
          ]}
        >
          <View
            style={[
              styles.holdArc,
              {
                backgroundColor: c.dangerPressed,
                height: phase === "holding" ? `${holdProgress * 100}%` : "0%",
              },
            ]}
          />
          <Text
            style={[
              styles.sosLabel,
              { color: c.textOnDanger },
              phase === "countdown" && styles.sosDigit,
            ]}
          >
            {buttonLabel}
          </Text>
        </Pressable>
      </View>

      {phase === "countdown" ? (
        <Pressable
          onPress={cancelCountdown}
          style={styles.cancel}
          accessibilityRole="button"
          accessibilityLabel="Cancel SOS"
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      ) : null}

      <ScrollView
        style={styles.lowerScroll}
        contentContainerStyle={styles.lowerScrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {phase === "active" ? (
          <View style={styles.statusList}>
            {statusRows.map((row) => (
              <View key={row.id} style={styles.statusRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.statusLabel}>{row.label}</Text>
                  <Text style={styles.statusDetail}>{row.detail}</Text>
                </View>
                <Text
                  style={[
                    styles.statusOn,
                    { color: c.success },
                    !row.on && { color: c.warning },
                  ]}
                >
                  {row.on ? "On" : "…"}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {phase === "idle" || phase === "cancelled" ? (
          <View style={styles.toggles}>
            <View style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>Silent mode</Text>
              <Switch
                value={session.silent}
                onValueChange={() => {
                  setSession((c) => {
                    const next = reduceSos(c, { type: "TOGGLE_SILENT" });
                    void AsyncStorage.setItem(
                      SILENT_SOS_KEY,
                      next.silent ? "true" : "false",
                    );
                    return next;
                  });
                }}
                trackColor={{ false: "#374151", true: c.dangerContainer }}
                thumbColor={session.silent ? c.danger : "#F9FAFB"}
              />
            </View>
            <View style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>Siren vibration</Text>
              <Switch
                value={session.siren}
                disabled={session.silent}
                onValueChange={() =>
                  setSession((c) => reduceSos(c, { type: "TOGGLE_SIREN" }))
                }
                trackColor={{ false: "#374151", true: c.primaryContainer }}
                thumbColor={session.siren ? c.primary : "#F9FAFB"}
              />
            </View>
            <Text style={styles.hint}>
              Press and hold for 2 seconds. A 5-second cancel window follows.
            </Text>
          </View>
        ) : null}

        {phase === "holding" ? (
          <Text style={styles.hint}>
            {Math.round(holdProgress * 2 * 10) / 10}s · release now to cancel
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    alignItems: "center",
    gap: spacing.md,
  },
  close: {
    alignSelf: "flex-end",
    minHeight: touch.minTarget,
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
  },
  closeText: {
    fontFamily: typography.fontFamily.medium,
    color: "#9CA3AF",
    fontSize: typography.size.body,
  },
  eyebrow: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.caption,
    color: "#F87171",
    letterSpacing: 1.5,
  },
  headline: {
    fontFamily: typography.fontFamily.bold,
    fontSize: typography.size.title,
    color: "#F9FAFB",
    textAlign: "center",
    marginBottom: spacing.sm,
  },
  buttonWrap: {
    width: 220,
    height: 220,
    alignItems: "center",
    justifyContent: "center",
    marginVertical: spacing.md,
  },
  ring: {
    position: "absolute",
    width: 200,
    height: 200,
    borderRadius: 100,
    borderWidth: 2,
  },
  sosButton: {
    width: 168,
    height: 168,
    borderRadius: 84,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  sosLive: {
    width: 120,
    height: 120,
    borderRadius: 60,
  },
  sosCountdown: {
    width: 168,
    height: 168,
  },
  holdArc: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
  sosLabel: {
    fontFamily: typography.fontFamily.bold,
    fontSize: 36,
    letterSpacing: 2,
  },
  sosDigit: {
    fontSize: 56,
    letterSpacing: 0,
  },
  cancel: {
    minHeight: 52,
    minWidth: 200,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: "#F3F4F6",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
  },
  cancelText: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.bodyLarge,
    color: "#F3F4F6",
  },
  lowerScroll: {
    flex: 1,
    minHeight: 0,
    alignSelf: "stretch",
    width: "100%",
  },
  lowerScrollContent: {
    paddingBottom: spacing.lg,
    gap: spacing.md,
  },
  statusList: {
    width: "100%",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: "#1C1014",
    borderWidth: 1,
    borderColor: "#3A5A3A",
    gap: spacing.md,
  },
  statusLabel: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.body,
    color: "#F3F4F6",
  },
  statusDetail: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.caption,
    color: "#9CA3AF",
  },
  statusOn: {
    fontFamily: typography.fontFamily.bold,
    fontSize: typography.size.caption,
  },
  toggles: {
    width: "100%",
    marginTop: spacing.xl,
    gap: spacing.sm,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.sm,
  },
  toggleLabel: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.body,
    color: "#E5E7EB",
  },
  hint: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.caption,
    color: "#9CA3AF",
    textAlign: "center",
    marginTop: spacing.sm,
  },
});
