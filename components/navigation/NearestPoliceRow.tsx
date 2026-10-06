import { radius, spacing, typography } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import { formatMeters } from "@/services/nearbyPlaces";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import React from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

const DARK = {
  bg: "rgba(30, 41, 59, 0.92)",
  border: "rgba(255, 255, 255, 0.14)",
  text: "#F9FAFB",
  muted: "#9CA3AF",
  accent: "#60A5FA",
  callBg: "rgba(96, 165, 250, 0.18)",
};

export type NearestPoliceRowProps = {
  name: string;
  distanceM: number;
  phone?: string | null;
  /** Cancel the current trip and go to this station. */
  onNavigate: () => void;
  onCall?: () => void;
  /** "dark" for map chrome (live navigation), "surface" for themed cards. */
  tone?: "dark" | "surface";
  style?: StyleProp<ViewStyle>;
};

/** Slim "nearest police station" strip with distance, tap-to-navigate and call. */
export function NearestPoliceRow({
  name,
  distanceM,
  phone,
  onNavigate,
  onCall,
  tone = "dark",
  style,
}: NearestPoliceRowProps) {
  const { colors: c } = useAppTheme();
  const palette =
    tone === "dark"
      ? DARK
      : {
          bg: c.surfaceGlass,
          border: c.border,
          text: c.textPrimary,
          muted: c.textSecondary,
          accent: c.primary,
          callBg: c.primaryContainer,
        };
  const distance = formatMeters(distanceM);

  return (
    <View
      style={[
        styles.row,
        { backgroundColor: palette.bg, borderColor: palette.border },
        style,
      ]}
    >
      <Pressable
        onPress={onNavigate}
        style={({ pressed }) => [styles.main, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={`Nearest police station ${name}, ${distance} away. Navigate there now`}
      >
        <MaterialIcons name="local-police" size={16} color={palette.accent} />
        <Text style={[styles.distance, { color: palette.text }]}>{distance}</Text>
        <Text style={[styles.name, { color: palette.muted }]} numberOfLines={1}>
          {name}
        </Text>
        <MaterialIcons name="navigation" size={14} color={palette.muted} />
      </Pressable>
      {phone && onCall ? (
        <Pressable
          onPress={onCall}
          hitSlop={6}
          style={({ pressed }) => [
            styles.call,
            { backgroundColor: palette.callBg },
            pressed && styles.pressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={`Call ${name} at ${phone}`}
        >
          <MaterialIcons name="call" size={15} color={palette.accent} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: spacing.md,
    paddingRight: 4,
    minHeight: 36,
  },
  main: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
  },
  distance: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.caption,
  },
  name: {
    flex: 1,
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.caption,
  },
  call: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: {
    opacity: 0.75,
  },
});
