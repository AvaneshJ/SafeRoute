import { typography } from "@/constants/theme";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { navDark } from "./LiveNavigationHUD";

type Props = {
  instruction: string;
  maneuverDistance?: string;
  maneuverIcon?: React.ComponentProps<typeof MaterialIcons>["name"];
  remainingMinutes: number;
  /** Off-route / rerouting headline, replaces the instruction while set. */
  alertTitle?: string;
};

/** Minimal turn card for the Picture-in-Picture window (~150–250 dp wide). */
export function PipNavigationCard({
  instruction,
  maneuverDistance,
  maneuverIcon = "straight",
  remainingMinutes,
  alertTitle,
}: Props) {
  return (
    <View style={styles.wrap} pointerEvents="none">
      <View style={styles.card}>
        <View style={styles.row}>
          <MaterialIcons
            name={alertTitle ? "alt-route" : maneuverIcon}
            size={26}
            color={alertTitle ? "#FBBF24" : navDark.text}
          />
          <Text style={styles.distance} numberOfLines={1}>
            {alertTitle ? "Rerouting" : maneuverDistance || "Go"}
          </Text>
        </View>
        <Text style={styles.instruction} numberOfLines={2}>
          {alertTitle || instruction}
        </Text>
      </View>
      <View style={styles.eta}>
        <Text style={styles.etaText}>
          {Math.max(0, Math.round(remainingMinutes))} min
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    ...StyleSheet.absoluteFill,
    justifyContent: "space-between",
    padding: 6,
  },
  card: {
    backgroundColor: navDark.glass,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  distance: {
    flexShrink: 1,
    color: navDark.text,
    fontSize: 18,
    fontFamily: typography.fontFamily.bold,
  },
  instruction: {
    marginTop: 2,
    color: navDark.muted,
    fontSize: 11,
    lineHeight: 14,
    fontFamily: typography.fontFamily.medium,
  },
  eta: {
    alignSelf: "flex-start",
    backgroundColor: navDark.glass,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  etaText: {
    color: navDark.success,
    fontSize: 12,
    fontFamily: typography.fontFamily.semibold,
  },
});
