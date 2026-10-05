import { FloatingActionButton } from "@/components/design-system/FloatingActionButton";
import { PrimaryButton } from "@/components/design-system/PrimaryButton";
import { SafetyScoreChip } from "@/components/design-system/SafetyScoreChip";
import {
  ComparisonRouteCard,
  type ComparisonRoute,
} from "@/components/route/ComparisonRouteCard";
import { WhyThisRoute } from "@/components/route/WhyThisRoute";
import {
  radius,
  spacing,
  tabContentBottomInset,
  typography,
} from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const { height: WINDOW_HEIGHT } = Dimensions.get("window");
/** Idle "Plan a trip" — title + subtitle only, no empty padding. */
const IDLE = 138;
/** Destination selected — copy + CTA + Save/Share (must fit without clipping). */
const DESTINATION = 300;
/**
 * Routes collapsed: destination + cards + Start Navigation always visible.
 * Why-panel scrolls when sheet is pulled up.
 */
const ROUTES_COLLAPSED = 300;
/** Route cards + why panel + sticky CTA. */
const EXPANDED = Math.min(560, Math.round(WINDOW_HEIGHT * 0.62));
/** Extra gap so the floating tab bar never covers the sheet CTA. */
const TAB_CLEARANCE = spacing.md;
/** Breathing room between destination copy and the CTA when there are no routes. */
const DEST_SPACER = spacing.sm;

export type MapTripSheetProps = {
  visible?: boolean;
  destinationTitle?: string | null;
  destinationSubtitle?: string | null;
  routes: ComparisonRoute[];
  selectedIndex: number;
  safetyScore?: number | null;
  refreshing?: boolean;
  onSelectRoute: (index: number) => void;
  onFindRoutes?: () => void;
  onStartNavigation?: () => void;
  onSave?: () => void;
  onShare?: () => void;
  onMyLocation?: () => void;
  onReport?: () => void;
  /** Recalculate routes for the current destination. */
  onRefresh?: () => void;
  /** Dismiss destination + route cards so the user can search again. */
  onDismiss?: () => void;
};

export function MapTripSheet({
  visible = true,
  destinationTitle,
  destinationSubtitle,
  routes,
  selectedIndex,
  safetyScore,
  refreshing = false,
  onSelectRoute,
  onFindRoutes,
  onStartNavigation,
  onSave,
  onShare,
  onMyLocation,
  onReport,
  onRefresh,
  onDismiss,
}: MapTripSheetProps) {
  const insets = useSafeAreaInsets();
  const { colors: c, elevation: elev } = useAppTheme();
  const hasRoutes = routes.length > 0;
  const hasDestination = Boolean(destinationTitle);
  const selected = routes[selectedIndex] ?? routes[0];
  const whyReasons = useMemo(() => {
    const raw = selected?.reasons;
    if (!raw?.length) return [];
    return raw.map((r) => ({
      icon: (r.icon || "check-circle") as React.ComponentProps<
        typeof MaterialIcons
      >["name"],
      text: r.text,
    }));
  }, [selected?.reasons]);

  // Measured section heights so the sheet hugs its content instead of
  // leaving empty space under the route cards.
  const [topH, setTopH] = useState(0);
  const [footerH, setFooterH] = useState(0);
  const [midH, setMidH] = useState(0);
  const measured =
    (setter: (v: number) => void, prev: number) => (v: number) => {
      const next = Math.ceil(v);
      if (Math.abs(next - prev) > 1) setter(next);
    };
  const hasMidContent =
    hasRoutes &&
    (whyReasons.length > 0 || Boolean(selected?.lowConfidenceAdvisory));
  const fitted = topH > 0 && footerH > 0;
  const fitCollapsed = topH + footerH;
  const fitExpanded = Math.min(
    EXPANDED,
    fitCollapsed + (hasMidContent ? midH : 0),
  );

  const targetHeight = fitted
    ? hasRoutes
      ? Math.max(fitCollapsed, fitExpanded)
      : fitCollapsed + DEST_SPACER
    : hasRoutes
      ? EXPANDED
      : hasDestination
        ? DESTINATION
        : IDLE;
  const minHeight = hasRoutes
    ? fitted
      ? fitCollapsed
      : ROUTES_COLLAPSED
    : targetHeight;
  const maxHeight = targetHeight;
  const height = useRef(new Animated.Value(IDLE)).current;
  const heightRef = useRef(IDLE);
  const dragStart = useRef(IDLE);
  const hasRoutesRef = useRef(hasRoutes);
  hasRoutesRef.current = hasRoutes;
  const targetHeightRef = useRef(targetHeight);
  targetHeightRef.current = targetHeight;
  const minHeightRef = useRef(minHeight);
  minHeightRef.current = minHeight;
  const maxHeightRef = useRef(maxHeight);
  maxHeightRef.current = maxHeight;

  useEffect(() => {
    const id = height.addListener(({ value }) => {
      heightRef.current = value;
    });
    return () => height.removeListener(id);
  }, [height]);

  const snapTo = (to: number) => {
    Animated.spring(height, {
      toValue: to,
      useNativeDriver: false,
      friction: 8,
      tension: 80,
    }).start();
  };

  // Resize with content: idle → destination → routes.
  useEffect(() => {
    snapTo(targetHeight);
  }, [targetHeight]);

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) =>
        hasRoutesRef.current && Math.abs(gesture.dy) > 6,
      onPanResponderGrant: () => {
        dragStart.current = heightRef.current;
      },
      onPanResponderMove: (_, gesture) => {
        if (!hasRoutesRef.current) return;
        const next = dragStart.current - gesture.dy;
        height.setValue(
          Math.min(maxHeightRef.current, Math.max(minHeightRef.current, next)),
        );
      },
      onPanResponderRelease: (_, gesture) => {
        if (!hasRoutesRef.current) {
          snapTo(targetHeightRef.current);
          return;
        }
        const current = heightRef.current;
        const collapsed = minHeightRef.current;
        const expanded = maxHeightRef.current;
        if (gesture.vy < -0.35 || gesture.dy < -28) snapTo(expanded);
        else if (gesture.vy > 0.35 || gesture.dy > 28) snapTo(collapsed);
        else
          snapTo(current > (collapsed + expanded) / 2 ? expanded : collapsed);
      },
    }),
  ).current;

  if (!visible) return null;

  const score = Number.isFinite(safetyScore) ? Number(safetyScore) : null;

  return (
    <Animated.View
      style={[
        styles.sheet,
        {
          height,
          maxHeight,
          minHeight,
          bottom: tabContentBottomInset(insets.bottom) + TAB_CLEARANCE,
          backgroundColor: c.surface,
          ...elev.sheet,
        },
      ]}
    >
      <View style={styles.fabs} pointerEvents="box-none">
        {onReport ? (
          <FloatingActionButton
            icon="add-location-alt"
            variant="surface"
            accessibilityLabel="Report this area"
            onPress={onReport}
          />
        ) : null}
        {onMyLocation ? (
          <FloatingActionButton
            icon="my-location"
            variant="primary"
            accessibilityLabel="Current location"
            onPress={onMyLocation}
          />
        ) : null}
      </View>

      <View style={[styles.clip, { backgroundColor: c.surface }]}>
        <View
          onLayout={(e) => measured(setTopH, topH)(e.nativeEvent.layout.height)}
        >
          <View {...pan.panHandlers} style={styles.handleHit}>
            <View style={[styles.handle, { backgroundColor: c.border }]} />
          </View>

          {/* Header — always visible */}
          <View style={styles.header}>
            <View style={styles.headerTop}>
              <Text style={[styles.kicker, { color: c.primary, flex: 1 }]}>
                {hasDestination ? "Destination" : "Plan a trip"}
              </Text>
              {hasDestination || hasRoutes ? (
                <View style={styles.headerActions}>
                  {onRefresh && hasRoutes ? (
                    <Pressable
                      onPress={onRefresh}
                      disabled={refreshing}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel="Recalculate routes"
                      style={[
                        styles.iconBtn,
                        {
                          backgroundColor: c.surfaceVariant,
                          opacity: refreshing ? 0.5 : 1,
                        },
                      ]}
                    >
                      <MaterialIcons
                        name="refresh"
                        size={18}
                        color={c.textPrimary}
                      />
                    </Pressable>
                  ) : null}
                  {onDismiss ? (
                    <Pressable
                      onPress={onDismiss}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel="Close destination"
                      style={[
                        styles.iconBtn,
                        { backgroundColor: c.surfaceVariant },
                      ]}
                    >
                      <MaterialIcons
                        name="close"
                        size={18}
                        color={c.textPrimary}
                      />
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
            </View>
            <Text
              style={[styles.title, { color: c.textPrimary }]}
              numberOfLines={1}
            >
              {destinationTitle || "Where are you headed?"}
            </Text>
            <Text
              style={[styles.subtitle, { color: c.textSecondary }]}
              numberOfLines={2}
            >
              {destinationSubtitle ||
                "Search above to compare lighting, crowds, and community reports."}
            </Text>

            {score != null ? (
              <View style={styles.scoreRow}>
                <Text style={[styles.scoreLabel, { color: c.textPrimary }]}>
                  Safety score
                </Text>
                <SafetyScoreChip score={score} compact />
              </View>
            ) : null}

            {hasRoutes ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.routes}
              >
                {routes.map((route, index) => (
                  <ComparisonRouteCard
                    key={route.id}
                    route={route}
                    selected={index === selectedIndex}
                    onPress={() => onSelectRoute(index)}
                    style={styles.routeCard}
                  />
                ))}
              </ScrollView>
            ) : null}
          </View>
        </View>

        {/* Why / advisory — scrolls; never covers Start Navigation */}
        {hasRoutes ? (
          <ScrollView
            style={styles.scrollMid}
            contentContainerStyle={styles.scrollMidContent}
            showsVerticalScrollIndicator={false}
            nestedScrollEnabled
            onContentSizeChange={(_, h) => measured(setMidH, midH)(h)}
          >
            {whyReasons.length > 0 ? (
              <WhyThisRoute
                title="Why we recommended it"
                reasons={whyReasons}
                style={styles.why}
              />
            ) : null}

            {selected?.lowConfidenceAdvisory ? (
              <View
                style={[
                  styles.advisory,
                  {
                    backgroundColor: c.warningContainer || c.surface,
                    borderColor: c.border,
                  },
                ]}
              >
                <MaterialIcons
                  name="info-outline"
                  size={16}
                  color={c.warning}
                />
                <Text style={[styles.advisoryText, { color: c.textSecondary }]}>
                  {selected.lowConfidenceAdvisory}
                </Text>
              </View>
            ) : null}
          </ScrollView>
        ) : (
          <View style={styles.destSpacer} />
        )}

        {/* Footer — Start Navigation / Find safe routes pinned above the tab bar */}
        <View
          style={styles.footer}
          onLayout={(e) =>
            measured(setFooterH, footerH)(e.nativeEvent.layout.height)
          }
        >
          {hasRoutes && onStartNavigation ? (
            <PrimaryButton
              label="Start Navigation"
              onPress={onStartNavigation}
            />
          ) : hasDestination && onFindRoutes ? (
            <PrimaryButton label="Find safe routes" onPress={onFindRoutes} />
          ) : null}

          {hasDestination ? (
            <View style={styles.actions}>
              {onSave ? (
                <Pressable
                  onPress={onSave}
                  style={styles.action}
                  accessibilityRole="button"
                >
                  <Text style={[styles.actionText, { color: c.primary }]}>
                    Save
                  </Text>
                </Pressable>
              ) : null}
              {onShare ? (
                <Pressable
                  onPress={onShare}
                  style={styles.action}
                  accessibilityRole="button"
                >
                  <Text style={[styles.actionText, { color: c.primary }]}>
                    Share
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: spacing.md,
    right: spacing.md,
    borderRadius: radius.hero,
    overflow: "visible",
    zIndex: 20,
  },
  clip: {
    flex: 1,
    overflow: "hidden",
    borderRadius: radius.hero,
  },
  fabs: {
    position: "absolute",
    right: 0,
    top: -132,
    gap: spacing.sm + 4,
    alignItems: "center",
  },
  handleHit: {
    alignItems: "center",
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: radius.pill,
  },
  header: {
    paddingHorizontal: spacing.lg,
    gap: spacing.xs,
  },
  headerTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  iconBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  scrollMid: {
    flex: 1,
    minHeight: 0,
  },
  destSpacer: {
    flex: 1,
    minHeight: spacing.sm,
  },
  scrollMidContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  kicker: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  title: {
    fontFamily: typography.fontFamily.bold,
    fontSize: typography.size.title,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
  },
  scoreRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.xs,
  },
  scoreLabel: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.body,
  },
  routes: {
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  routeCard: {
    marginRight: spacing.sm,
  },
  why: {
    marginTop: spacing.xs,
  },
  advisory: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.sm,
  },
  advisoryText: {
    flex: 1,
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
  },
  actions: {
    flexDirection: "row",
    gap: spacing.md,
    minHeight: 40,
    alignItems: "center",
  },
  action: {
    minHeight: 40,
    justifyContent: "center",
    paddingVertical: spacing.xs,
  },
  actionText: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.body,
  },
});
