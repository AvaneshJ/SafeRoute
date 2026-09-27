import { HeatMapLegend } from "@/components/design-system/HeatMapLegend";

import { motion, radius, spacing, typography } from "@/constants/theme";

import { useAppTheme } from "@/hooks/useAppTheme";

import { Image } from "expo-image";

import React, { useEffect } from "react";

import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

export type HeatMapPreviewProps = {
  onPress?: () => void;

  style?: StyleProp<ViewStyle>;
};

/** Live community heat map teaser card with subtle live pulse. */

export function HeatMapPreview({ onPress, style }: HeatMapPreviewProps) {
  const { colors: c, elevation: elev } = useAppTheme();

  const pulse = useSharedValue(1);

  useEffect(() => {
    pulse.value = withRepeat(
      withTiming(1.15, {
        duration: motion.slow * 2,

        easing: Easing.inOut(Easing.ease),
      }),

      -1,

      true,
    );
  }, [pulse]);

  const liveDotStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulse.value }],

    opacity: 2 - pulse.value,
  }));

  return (
    <Pressable
      onPress={onPress}

      accessibilityRole="button"

      accessibilityLabel="Open live community heat map"

      style={({ pressed }) => [
        styles.card,

        {
          backgroundColor: c.surface,

          borderColor: c.border,

          ...elev.card,
        },

        pressed && styles.pressed,

        style,
      ]}
    >
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={[styles.title, { color: c.textPrimary }]}>
            Community heat map
          </Text>

          <View
            style={[styles.livePill, { backgroundColor: c.dangerContainer }]}
          >
            <Animated.View
              style={[
                styles.liveDot,

                { backgroundColor: c.danger },

                liveDotStyle,
              ]}
            />

            <Text style={[styles.liveText, { color: c.danger }]}>LIVE</Text>
          </View>
        </View>

        <Text style={[styles.subtitle, { color: c.textSecondary }]}>
          Neighborhood safety from recent reports and lighting
        </Text>
      </View>

      <View style={[styles.mapFrame, { backgroundColor: c.heroWash }]}>
        <Image
          source={require("../../assets/images/heatmap-preview.jpg")}

          style={styles.mapImage}

          contentFit="cover"

          transition={280}
        />

        <View style={[styles.reportsPill, { backgroundColor: c.surfaceGlass }]}>
          <Text style={[styles.reportsText, { color: c.textPrimary }]}>
            12 reports nearby
          </Text>
        </View>

        <View style={styles.legendWrap} pointerEvents="none">
          <HeatMapLegend title="Safety" />
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,

    padding: spacing.md,

    borderWidth: 1,

    gap: spacing.md,
  },

  pressed: {
    opacity: 0.96,

    transform: [{ scale: 0.995 }],
  },

  header: {
    gap: spacing.xs,
  },

  titleRow: {
    flexDirection: "row",

    alignItems: "center",

    justifyContent: "space-between",

    gap: spacing.sm,
  },

  title: {
    fontFamily: typography.fontFamily.semibold,

    fontSize: typography.size.title,
  },

  livePill: {
    flexDirection: "row",

    alignItems: "center",

    gap: 6,

    paddingHorizontal: spacing.sm,

    paddingVertical: 4,

    borderRadius: radius.pill,
  },

  liveDot: {
    width: 8,

    height: 8,

    borderRadius: radius.full,
  },

  liveText: {
    fontFamily: typography.fontFamily.bold,

    fontSize: 10,

    letterSpacing: 0.8,
  },

  subtitle: {
    fontFamily: typography.fontFamily.regular,

    fontSize: typography.size.body,

    lineHeight: typography.lineHeight.body,
  },

  mapFrame: {
    height: 168,

    borderRadius: radius.xl,

    overflow: "hidden",
  },

  mapImage: {
    width: "100%",

    height: "100%",
  },

  legendWrap: {
    position: "absolute",

    right: spacing.sm,

    bottom: spacing.sm,

    transform: [{ scale: 0.82 }],
  },

  reportsPill: {
    position: "absolute",

    left: spacing.sm,

    top: spacing.sm,

    paddingHorizontal: spacing.sm + 2,

    paddingVertical: 4,

    borderRadius: radius.pill,
  },

  reportsText: {
    fontFamily: typography.fontFamily.medium,

    fontSize: 11,
  },
});
