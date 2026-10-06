import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { LinearGradient } from "expo-linear-gradient";
import React from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { TourAnchor } from "@/components/tour/TourAnchor";
import { motion, radius, spacing, typography } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";

export type QuickActionItem = {
  key: string;
  label: string;
  description?: string;
  icon: React.ComponentProps<typeof MaterialIcons>["name"];
  onPress: () => void;
  tone?: "primary" | "success" | "warning" | "danger" | "neutral";
  size?: "large" | "small";
  /** Product-tour spotlight id */
  tourId?: string;
};

export type QuickActionsGridProps = {
  actions: QuickActionItem[];
  style?: StyleProp<ViewStyle>;
};

/** Premium action layout: large pair + small pair. */
export function QuickActionsGrid({ actions, style }: QuickActionsGridProps) {
  const large = actions.filter((a) => (a.size ?? "small") === "large");
  const small = actions.filter((a) => (a.size ?? "small") === "small");
  const legacy = large.length === 0 && small.length === actions.length;

  if (legacy) {
    return (
      <View style={[styles.grid, style]}>
        {actions.map((action) => (
          <ActionCard key={action.key} action={action} variant="compact" />
        ))}
      </View>
    );
  }

  return (
    <View style={[styles.stack, style]}>
      <View style={styles.largeRow}>
        {large.map((action) => (
          <ActionCard key={action.key} action={action} variant="large" />
        ))}
      </View>
      {small.length > 0 ? (
        <View style={styles.smallRow}>
          {small.map((action) => (
            <ActionCard key={action.key} action={action} variant="small" />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ActionCard({
  action,
  variant,
}: {
  action: QuickActionItem;
  variant: "large" | "small" | "compact";
}) {
  const { colors: c, gradients: grads, elevation: elev } = useAppTheme();
  const tone = action.tone ?? "primary";

  const toneGrad: Record<
    NonNullable<QuickActionItem["tone"]>,
    readonly [string, string]
  > = {
    primary: grads.iconPrimary,
    success: grads.iconSuccess,
    warning: grads.iconWarning,
    danger: grads.iconDanger,
    neutral: grads.iconAccent,
  };

  const toneFg: Record<NonNullable<QuickActionItem["tone"]>, string> = {
    primary: c.primary,
    success: c.successText,
    warning: c.warning,
    danger: c.errorText,
    neutral: c.textPrimary,
  };

  const card = (
    <Pressable
      onPress={action.onPress}
      accessibilityRole="button"
      accessibilityLabel={action.label}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: c.surface,
          borderColor: c.border,
          ...elev.card,
        },
        variant === "large" && styles.cardLarge,
        variant === "small" && styles.cardSmall,
        variant === "compact" && styles.cardCompact,
        pressed && {
          transform: [
            { translateY: motion.cardLift },
            { scale: motion.pressScale },
          ],
          ...elev.cardLift,
        },
      ]}
    >
      <LinearGradient
        colors={[...toneGrad[tone]]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[
          styles.iconTile,
          variant === "large" && styles.iconTileLarge,
          variant === "small" && styles.iconTileSmall,
        ]}
      >
        <MaterialIcons
          name={action.icon}
          size={variant === "large" ? 26 : 20}
          color={toneFg[tone]}
        />
      </LinearGradient>
      <View style={styles.copy}>
        <Text
          style={[
            styles.label,
            { color: c.textPrimary },
            variant === "small" && styles.labelSmall,
          ]}
          numberOfLines={variant === "small" ? 1 : 2}
        >
          {action.label}
        </Text>
        {action.description && variant !== "small" ? (
          <Text
            style={[styles.desc, { color: c.textSecondary }]}
            numberOfLines={2}
          >
            {action.description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );

  // Every card gets the same wrapper so tour-anchored cards size exactly like
  // the others; otherwise row columns end up with different widths.
  const cellStyle = variant === "compact" ? styles.compactCell : styles.cell;
  if (action.tourId) {
    return (
      <TourAnchor id={action.tourId} style={cellStyle}>
        {card}
      </TourAnchor>
    );
  }
  return <View style={cellStyle}>{card}</View>;
}

const styles = StyleSheet.create({
  stack: {
    gap: spacing.md,
  },
  largeRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  smallRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.md,
  },
  card: {
    borderRadius: radius.xl,
    padding: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  cell: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
  },
  compactCell: {
    width: "47%",
    flexGrow: 1,
  },
  cardLarge: {
    flex: 1,
    minHeight: 160,
    flexDirection: "column",
    justifyContent: "space-between",
    gap: spacing.md,
    padding: spacing.lg,
  },
  cardSmall: {
    flex: 1,
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm + 4,
    paddingHorizontal: spacing.md,
  },
  cardCompact: {
    flex: 1,
    alignItems: "center",
    gap: spacing.sm,
  },
  iconTile: {
    width: 44,
    height: 44,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  iconTileLarge: {
    width: 52,
    height: 52,
    borderRadius: radius.lg,
  },
  iconTileSmall: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
  },
  copy: {
    flex: 1,
    gap: 4,
  },
  label: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  labelSmall: {
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
    fontFamily: typography.fontFamily.medium,
  },
  desc: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
  },
});
