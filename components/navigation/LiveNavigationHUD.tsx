import { SafetyScoreChip } from "@/components/design-system/SafetyScoreChip";
import { UserAvatar } from "@/components/design-system/UserAvatar";
import { NearestPoliceRow } from "@/components/navigation/NearestPoliceRow";
import {
  motion,
  radius,
  spacing,
  tabContentBottomInset,
  typography,
} from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as Haptics from "expo-haptics";
import React, { useEffect } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, {
  Easing,
  FadeInDown,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** Dark chrome for map readability — no light elevation (avoids white shadow boxes). */
export const navDark = {
  glass: "rgba(15, 23, 42, 0.94)",
  glassSoft: "rgba(30, 41, 59, 0.92)",
  border: "rgba(255, 255, 255, 0.14)",
  text: "#F9FAFB",
  muted: "#9CA3AF",
  success: "#34D399",
  danger: "#F87171",
} as const;

export type LiveNavGuardian = {
  name: string;
  connected: boolean;
  phone?: string;
};

export type LiveNavRouteAlert = {
  tone: "warning" | "info" | "success";
  title: string;
  body?: string;
  /** Shows a spinner instead of the icon (e.g. while rerouting). */
  busy?: boolean;
};

const ALERT_TONES: Record<
  LiveNavRouteAlert["tone"],
  { color: string; icon: React.ComponentProps<typeof MaterialIcons>["name"] }
> = {
  warning: { color: "#FBBF24", icon: "wrong-location" },
  info: { color: "#60A5FA", icon: "alt-route" },
  success: { color: navDark.success, icon: "check-circle" },
};

export type LiveNavNearestPolice = {
  name: string;
  distanceM: number;
  phone?: string | null;
};

export type LiveNavigationHUDProps = {
  visible: boolean;
  /** Nearest police station strip under the ETA row. */
  nearestPolice?: LiveNavNearestPolice | null;
  onNavigateToPolice?: () => void;
  onCallPolice?: () => void;
  /** Current turn instruction (plain text) */
  instruction: string;
  /** Distance to next maneuver, e.g. "120 m" */
  maneuverDistance?: string;
  /** MaterialIcons name for the turn glyph */
  maneuverIcon?: React.ComponentProps<typeof MaterialIcons>["name"];
  remainingMinutes: number;
  remainingKm: number;
  safetyScore: number;
  guardian?: LiveNavGuardian | null;
  /** Off-route / reroute banner under the turn card */
  routeAlert?: LiveNavRouteAlert | null;
  onDismissRouteAlert?: () => void;
  /** When true, shows pulse + light haptic cadence (safety caution) */
  vibrationActive?: boolean;
  onCallGuardian?: () => void;
  onReport?: () => void;
  onSOS?: () => void;
  onEnd?: () => void;
  /** Lift actions above the floating tab bar (Map tab). Full-screen routes leave this false. */
  padForTabBar?: boolean;
  style?: StyleProp<ViewStyle>;
};

function VibrationIndicator({ active }: { active: boolean }) {
  const pulse = useSharedValue(0);

  useEffect(() => {
    if (!active) {
      pulse.value = 0;
      return;
    }
    pulse.value = withRepeat(
      withTiming(1, { duration: 900, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    const id = setInterval(() => {
      void Haptics.selectionAsync();
    }, 2800);
    return () => clearInterval(id);
  }, [active, pulse]);

  const style = useAnimatedStyle(() => ({
    opacity: active ? interpolate(pulse.value, [0, 1], [0.35, 1]) : 0.25,
    transform: [
      { scaleX: active ? interpolate(pulse.value, [0, 1], [0.85, 1.05]) : 1 },
    ],
  }));

  return (
    <View
      style={styles.vibWrap}
      accessibilityLabel={
        active ? "Subtle vibration alert active" : "Vibration idle"
      }
    >
      <Animated.View
        style={[styles.vibBar, active && styles.vibBarActive, style]}
      />
      <MaterialIcons
        name="vibration"
        size={14}
        color={active ? navDark.danger : navDark.muted}
      />
    </View>
  );
}

/**
 * Live Navigation HUD — compact map chrome.
 * Top: turn + ETA · Bottom: guardian + thumb actions (clears tab bar when padForTabBar).
 */
export function LiveNavigationHUD({
  visible,
  nearestPolice = null,
  onNavigateToPolice,
  onCallPolice,
  instruction,
  maneuverDistance,
  maneuverIcon = "straight",
  remainingMinutes,
  remainingKm,
  safetyScore,
  guardian,
  routeAlert = null,
  onDismissRouteAlert,
  vibrationActive = false,
  onCallGuardian,
  onReport,
  onSOS,
  onEnd,
  padForTabBar = false,
  style,
}: LiveNavigationHUDProps) {
  const { colors: c } = useAppTheme();
  const insets = useSafeAreaInsets();

  if (!visible) return null;

  const isSharing = Boolean(guardian?.connected);
  const bottomPad = padForTabBar
    ? tabContentBottomInset(insets.bottom)
    : Math.max(insets.bottom, spacing.sm) + spacing.sm;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.root, style]}
      accessibilityLabel="Live navigation"
    >
      <Animated.View
        entering={FadeInDown.duration(motion.normal)}
        style={[styles.top, { paddingTop: insets.top + 5 }]}
      >
        <View style={styles.turnCard}>
          <View style={[styles.turnIcon, { backgroundColor: c.primary }]}>
            <MaterialIcons name={maneuverIcon} size={24} color={navDark.text} />
          </View>
          <View style={styles.turnCopy}>
            {maneuverDistance ? (
              <Text style={styles.maneuverDist}>{maneuverDistance}</Text>
            ) : null}
            <Text style={styles.instruction} numberOfLines={2}>
              {instruction || "Continue straight"}
            </Text>
          </View>
          {onEnd ? (
            <Pressable
              onPress={onEnd}
              style={styles.endBtn}
              accessibilityRole="button"
              accessibilityLabel="End navigation"
            >
              <MaterialIcons name="close" size={18} color={navDark.text} />
            </Pressable>
          ) : null}
        </View>

        <View style={styles.metaRow}>
          <View style={styles.metaPill}>
            <Text style={styles.metaValue}>{remainingMinutes}</Text>
            <Text style={styles.metaUnit}>min</Text>
          </View>
          <View style={styles.metaPill}>
            <Text style={styles.metaValue}>{remainingKm.toFixed(1)}</Text>
            <Text style={styles.metaUnit}>km</Text>
          </View>
          <View style={styles.safetyPill}>
            <Text style={styles.safetyLabel}>Live</Text>
            <SafetyScoreChip score={safetyScore} compact />
            <VibrationIndicator active={vibrationActive || safetyScore < 55} />
          </View>
        </View>

        {nearestPolice && onNavigateToPolice ? (
          <NearestPoliceRow
            name={nearestPolice.name}
            distanceM={nearestPolice.distanceM}
            phone={nearestPolice.phone}
            onNavigate={onNavigateToPolice}
            onCall={onCallPolice}
          />
        ) : null}

        {routeAlert ? (
          <Animated.View
            key={`${routeAlert.tone}-${routeAlert.title}`}
            entering={FadeInDown.duration(motion.fast)}
            style={[
              styles.alertCard,
              { borderColor: ALERT_TONES[routeAlert.tone].color },
            ]}
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
          >
            {routeAlert.busy ? (
              <ActivityIndicator
                size="small"
                color={ALERT_TONES[routeAlert.tone].color}
              />
            ) : (
              <MaterialIcons
                name={ALERT_TONES[routeAlert.tone].icon}
                size={22}
                color={ALERT_TONES[routeAlert.tone].color}
              />
            )}
            <View style={styles.alertCopy}>
              <Text style={styles.alertTitle}>{routeAlert.title}</Text>
              {routeAlert.body ? (
                <Text style={styles.alertBody}>{routeAlert.body}</Text>
              ) : null}
            </View>
            {onDismissRouteAlert && !routeAlert.busy ? (
              <Pressable
                onPress={onDismissRouteAlert}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Dismiss route alert"
              >
                <MaterialIcons name="close" size={18} color={navDark.muted} />
              </Pressable>
            ) : null}
          </Animated.View>
        ) : null}
      </Animated.View>

      <Animated.View
        entering={FadeInDown.delay(60).duration(motion.normal)}
        style={[styles.bottom, { paddingBottom: bottomPad }]}
      >
        <Animated.View
          entering={FadeInDown.delay(100).duration(motion.slow)}
          style={styles.guardianCard}
        >
          <UserAvatar name={guardian?.name || "?"} size={28} />
          <View style={styles.guardianMeta}>
            <Text style={styles.guardianTitle} numberOfLines={1}>
              {guardian?.name || "No guardian"}
            </Text>
            <View style={styles.guardianStatus}>
              <View
                style={[
                  styles.dot,
                  {
                    backgroundColor: isSharing
                      ? navDark.success
                      : navDark.muted,
                  },
                ]}
              />
              <Text
                style={[
                  styles.guardianStatusText,
                  isSharing && { color: navDark.success },
                ]}
              >
                {isSharing ? "Sharing location" : "Not sharing"}
              </Text>
            </View>
          </View>
        </Animated.View>

        <View style={styles.actions}>
          <Pressable
            onPress={onCallGuardian}
            disabled={!guardian?.phone && !onCallGuardian}
            style={({ pressed }) => [
              styles.actionBtn,
              pressed && styles.actionPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Call guardian"
          >
            <MaterialIcons name="call" size={22} color={navDark.text} />
            <Text style={styles.actionLabel}>Call</Text>
          </Pressable>

          <Pressable
            onPress={onReport}
            style={({ pressed }) => [
              styles.actionBtn,
              pressed && styles.actionPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Report area"
          >
            <MaterialIcons name="report-problem" size={22} color={c.warning} />
            <Text style={styles.actionLabel}>Report</Text>
          </Pressable>

          <Pressable
            onPress={onSOS}
            style={({ pressed }) => [
              styles.sosBtn,
              { backgroundColor: c.danger },
              pressed && styles.actionPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="SOS emergency"
          >
            <MaterialIcons name="sos" size={24} color={c.textOnDanger} />
            <Text style={[styles.sosLabel, { color: c.textOnDanger }]}>
              SOS
            </Text>
          </Pressable>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFill,
    justifyContent: "space-between",
  },
  top: {
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  turnCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: navDark.glass,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: navDark.border,
  },
  turnIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  turnCopy: {
    flex: 1,
    gap: 2,
  },
  maneuverDist: {
    fontFamily: typography.fontFamily.bold,
    fontSize: typography.size.bodyLarge,
    color: navDark.text,
  },
  instruction: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
    color: navDark.muted,
  },
  endBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.full,
    backgroundColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  metaPill: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 4,
    backgroundColor: navDark.glassSoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: navDark.border,
  },
  metaValue: {
    fontFamily: typography.fontFamily.bold,
    fontSize: typography.size.bodyLarge,
    color: navDark.text,
  },
  metaUnit: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.caption,
    color: navDark.muted,
    marginBottom: 1,
  },
  safetyPill: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: spacing.sm,
    backgroundColor: navDark.glassSoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: navDark.border,
  },
  safetyLabel: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.caption,
    color: navDark.muted,
    marginRight: "auto",
  },
  alertCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: navDark.glass,
    borderRadius: radius.lg,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
  },
  alertCopy: {
    flex: 1,
    gap: 2,
  },
  alertTitle: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.body,
    color: navDark.text,
  },
  alertBody: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.caption,
    lineHeight: 16,
    color: navDark.muted,
  },
  vibWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  vibBar: {
    width: 14,
    height: 3,
    borderRadius: 2,
    backgroundColor: navDark.muted,
  },
  vibBarActive: {
    backgroundColor: navDark.danger,
  },
  bottom: {
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  guardianCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: "rgba(15, 23, 42, 0.55)",
    borderRadius: radius.md,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 255, 255, 0.1)",
  },
  guardianMeta: {
    flex: 1,
    gap: 0,
  },
  guardianTitle: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.caption,
    color: navDark.text,
  },
  guardianStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  guardianStatusText: {
    fontFamily: typography.fontFamily.medium,
    fontSize: 11,
    color: navDark.muted,
  },
  actions: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: spacing.sm,
  },
  actionBtn: {
    flex: 1,
    minHeight: 56,
    borderRadius: radius.lg,
    backgroundColor: navDark.glassSoft,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: navDark.border,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: spacing.sm,
  },
  actionPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
  actionLabel: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.caption,
    color: navDark.text,
  },
  sosBtn: {
    flex: 1,
    minHeight: 56,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: spacing.sm,
  },
  sosLabel: {
    fontFamily: typography.fontFamily.bold,
    fontSize: typography.size.caption,
    letterSpacing: 0.5,
  },
});
