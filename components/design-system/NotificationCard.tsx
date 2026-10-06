import MaterialIcons from "@expo/vector-icons/MaterialIcons";
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
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { motion, radius, spacing, typography } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";

export type NotificationTone = "info" | "success" | "warning" | "danger";

export type NotificationCardProps = {
  title: string;
  body: string;
  timeLabel?: string;
  tone?: NotificationTone;
  unread?: boolean;
  onPress?: () => void;
  onDismiss?: () => void;
  /** Shows a chevron: tapping the card opens something. */
  openable?: boolean;
  /** Small category label above the title (e.g. in a mixed "All" feed). */
  eyebrow?: string;
  style?: StyleProp<ViewStyle>;
  /** Stagger index for entrance fade (visual only) */
  index?: number;
};

const TONE_ICON: Record<
  NotificationTone,
  React.ComponentProps<typeof MaterialIcons>["name"]
> = {
  info: "info-outline",
  success: "check-circle-outline",
  warning: "warning-amber",
  danger: "error-outline",
};

function UnreadDot({ color }: { color: string }) {
  const pulse = useSharedValue(1);

  useEffect(() => {
    pulse.value = withRepeat(
      withTiming(1.35, {
        duration: motion.unreadPulse / 2,
        easing: Easing.inOut(Easing.ease),
      }),
      -1,
      true,
    );
  }, [pulse]);

  const style = useAnimatedStyle(() => ({
    transform: [{ scale: pulse.value }],
    opacity: 2 - pulse.value,
  }));

  return (
    <View style={styles.dotWrap}>
      <Animated.View
        style={[styles.unreadHalo, { backgroundColor: color }, style]}
      />
      <View style={[styles.unreadDot, { backgroundColor: color }]} />
    </View>
  );
}

export function NotificationCard({
  title,
  body,
  timeLabel,
  tone = "info",
  unread = false,
  onPress,
  onDismiss,
  openable = false,
  eyebrow,
  style,
  index = 0,
}: NotificationCardProps) {
  const { colors: c, elevation: elev } = useAppTheme();

  const toneColor: Record<NotificationTone, string> = {
    info: c.primary,
    success: c.successText,
    warning: c.warning,
    danger: c.errorText,
  };
  const toneWash: Record<NotificationTone, string> = {
    info: c.primaryContainer,
    success: c.successContainer,
    warning: c.warningContainer,
    danger: c.dangerContainer,
  };

  const accent = toneColor[tone];

  return (
    <Animated.View
      entering={FadeInDown.delay(index * motion.stagger)
        .duration(motion.normal)
        .springify()
        .damping(18)}
    >
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [
          styles.card,
          {
            backgroundColor: unread ? toneWash[tone] : c.surface,
            ...elev.card,
          },
          pressed && {
            transform: [{ translateY: motion.cardLift }],
            ...elev.cardLift,
          },
          style,
        ]}
      >
        <View style={[styles.accent, { backgroundColor: accent }]} />
        <View style={[styles.iconWrap, { backgroundColor: `${accent}22` }]}>
          <MaterialIcons name={TONE_ICON[tone]} size={20} color={accent} />
        </View>
        <View style={styles.content}>
          {eyebrow ? (
            <Text style={[styles.eyebrow, { color: accent }]} numberOfLines={1}>
              {eyebrow}
            </Text>
          ) : null}
          <View style={styles.titleRow}>
            {unread ? <UnreadDot color={accent} /> : null}
            <Text
              style={[
                styles.title,
                { color: c.textPrimary },
                unread && styles.titleUnread,
              ]}
              numberOfLines={1}
            >
              {title}
            </Text>
          </View>
          <Text
            style={[styles.body, { color: c.textSecondary }]}
            numberOfLines={2}
          >
            {body}
          </Text>
        </View>
        <View style={styles.meta}>
          {timeLabel ? (
            <Text style={[styles.time, { color: c.textTertiary }]}>
              {timeLabel}
            </Text>
          ) : null}
          {onDismiss ? (
            <Pressable
              onPress={onDismiss}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Dismiss notification"
            >
              <MaterialIcons name="close" size={18} color={c.textTertiary} />
            </Pressable>
          ) : openable ? (
            <MaterialIcons
              name="chevron-right"
              size={20}
              color={c.textTertiary}
            />
          ) : null}
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingRight: spacing.md,
    borderRadius: radius.xl,
    overflow: "hidden",
  },
  accent: {
    width: 4,
    alignSelf: "stretch",
    borderTopLeftRadius: radius.xl,
    borderBottomLeftRadius: radius.xl,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    flex: 1,
    gap: 2,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  dotWrap: {
    width: 10,
    height: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  unreadHalo: {
    position: "absolute",
    width: 10,
    height: 10,
    borderRadius: 5,
    opacity: 0.35,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  title: {
    flex: 1,
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  eyebrow: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  titleUnread: {
    fontFamily: typography.fontFamily.bold,
  },
  time: {
    fontFamily: typography.fontFamily.bold,
    fontSize: 12,
    letterSpacing: 0.2,
    textAlign: "right",
  },
  body: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
  },
  meta: {
    alignItems: "flex-end",
    justifyContent: "space-between",
    alignSelf: "stretch",
    minWidth: 64,
    paddingVertical: 2,
  },
});
