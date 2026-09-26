import {
  DesignSearchBar,
  GradientText,
  LiveMiniMap,
  QuickActionsGrid,
  SafetyScoreChip,
  SOSButton,
  type QuickActionItem,
} from "@/components/design-system";
import { DestinationSearchSheet } from "@/components/destination/DestinationSearchSheet";
import { TourAnchor } from "@/components/tour/TourAnchor";
import { auth } from "@/config/firebase";
import type { DestinationPlace } from "@/core/destinationSearch";
import { calculateSafetyScore } from "@/core/safetyScore";
import {
  motion,
  radius,
  spacing,
  tabContentBottomInset,
  typography,
} from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useProductTour } from "@/hooks/useProductTour";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as Location from "expo-location";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type WeatherInfo = {
  label: string;
  tempC: number | null;
  icon: React.ComponentProps<typeof MaterialIcons>["name"];
};

function greetingForHour(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function weatherIcon(
  code: number,
): React.ComponentProps<typeof MaterialIcons>["name"] {
  if (code === 0) return "wb-sunny";
  if (code <= 3) return "cloud";
  if (code <= 67) return "grain";
  if (code <= 77) return "ac-unit";
  return "thunderstorm";
}

function weatherLabel(code: number): string {
  if (code === 0) return "Clear";
  if (code <= 3) return "Cloudy";
  if (code <= 67) return "Rain";
  if (code <= 77) return "Snow";
  return "Storms";
}

export default function HomeDashboard() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors: c, elevation: elev, gradients: grads } = useAppTheme();
  const { maybeAutoStart, active, step, requestRemeasure } = useProductTour();
  const scrollRef = React.useRef<ScrollView>(null);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [placeName, setPlaceName] = useState("Finding you…");
  const [score, setScore] = useState(72);
  const [weather, setWeather] = useState<WeatherInfo>({
    label: "—",
    tempC: null,
    icon: "cloud-queue",
  });
  const [refreshing, setRefreshing] = useState(false);

  const displayName =
    auth.currentUser?.displayName?.split(" ")[0] ||
    auth.currentUser?.email?.split("@")[0] ||
    "there";

  const hour = new Date().getHours();
  const greetingLine = greetingForHour(hour);

  const loadContext = useCallback(async () => {
    const now = new Date();
    let usedLiveScore = false;

    // Phase 5: prefer live safety_scores cell when signed in
    try {
      if (auth.currentUser) {
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        const { getSafetyScore } = await import("@/services/callables");
        const live = await getSafetyScore({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          departAtMs: now.getTime(),
        });
        if (live.data?.score != null) {
          setScore(live.data.score);
          usedLiveScore = true;
        }
      }
    } catch {
      // fall through to local formula
    }

    if (!usedLiveScore) {
      const baseScore = calculateSafetyScore({
        hour: now.getHours(),
        dayOfWeek: now.getDay(),
        communityRating: 3.8,
        crowdDensity: 0.55,
        streetLighting: now.getHours() >= 18 || now.getHours() < 6 ? 0.45 : 0.85,
        visibilityKm: 8,
        policeDistanceM: 900,
        cctv: 0.4,
        verifiedIncidents30d: 1,
        historicalReports: 2,
        xgbRisk: null,
        xgbConfidence: null,
      });
      setScore(baseScore.score);
    }

    try {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== Location.PermissionStatus.GRANTED) {
        setPlaceName("Location off — enable in Permissions");
        return;
      }
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const { latitude, longitude } = position.coords;

      const places = await Location.reverseGeocodeAsync({
        latitude,
        longitude,
      });
      const place = places[0];
      if (place) {
        const label =
          [place.name || place.street, place.district || place.city]
            .filter(Boolean)
            .join(", ") || "Current area";
        setPlaceName(label);
      } else {
        setPlaceName("Current area");
      }

      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          const code = Number(data?.current?.weather_code ?? 0);
          const temp = data?.current?.temperature_2m;
          setWeather({
            label: weatherLabel(code),
            tempC: typeof temp === "number" ? Math.round(temp) : null,
            icon: weatherIcon(code),
          });
        }
      } catch {
        setWeather({ label: "Local", tempC: null, icon: "wb-cloudy" });
      }
    } catch {
      setPlaceName("Unable to read location");
    }
  }, []);

  useEffect(() => {
    void loadContext();
  }, [loadContext]);

  useFocusEffect(
    useCallback(() => {
      // First-run / pending only — Profile replay starts from the provider
      void maybeAutoStart();
    }, [maybeAutoStart]),
  );

  useEffect(() => {
    if (active) setSearchOpen(false);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const id = step.id;
    const t = setTimeout(() => {
      if (id === "search") {
        scrollRef.current?.scrollTo({ y: 0, animated: true });
      } else if (id === "safewalk") {
        scrollRef.current?.scrollTo({ y: 220, animated: true });
      } else if (id === "report") {
        scrollRef.current?.scrollTo({ y: 360, animated: true });
      } else if (id === "heatmap" || id === "sos") {
        scrollRef.current?.scrollToEnd({ animated: true });
      }
      // Remeasure after scroll animation so the hole matches the feature
      setTimeout(() => requestRemeasure(), 280);
      setTimeout(() => requestRemeasure(), 520);
      setTimeout(() => requestRemeasure(), 900);
    }, 80);
    return () => clearTimeout(t);
  }, [active, step.id, requestRemeasure]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadContext();
    setRefreshing(false);
  };

  const goMap = (params?: Record<string, unknown>) => {
    router.push({ pathname: "/navigate", params: params as never });
  };

  const openDestinationSearch = useCallback(() => {
    setSearchOpen(true);
  }, []);

  const actions: QuickActionItem[] = useMemo(
    () => [
      {
        key: "route",
        label: "Safe Route",
        description: "AI-ranked paths for lighting & crowd",
        icon: "alt-route",
        tone: "primary",
        size: "large",
        onPress: openDestinationSearch,
      },
      {
        key: "walk",
        label: "Safe Walk",
        description: "Live share with your guardian",
        icon: "directions-walk",
        tone: "success",
        size: "large",
        tourId: "safewalk",
        onPress: () => router.push("/(tabs)/safewalk" as never),
      },
      {
        key: "report",
        label: "Report Area",
        description: "Lighting, hazard, or harassment",
        icon: "report-problem",
        tone: "warning",
        size: "small",
        tourId: "report",
        onPress: () => router.push("/CommunityReport" as never),
      },
      {
        key: "police",
        label: "Nearby Police",
        description: "Stations on your map",
        icon: "local-police",
        tone: "danger",
        size: "small",
        onPress: () => goMap({ showPoliceStations: "true" }),
      },
    ],
    [router, openDestinationSearch],
  );

  const onDestinationSelect = (place: DestinationPlace) => {
    setSearch(place.title);
    router.push({
      pathname: "/navigate",
      params: {
        selectedPlaceLat: String(place.coordinate.latitude),
        selectedPlaceLng: String(place.coordinate.longitude),
        selectedPlaceTitle: place.title,
        selectedPlaceSubtitle: place.subtitle,
      } as never,
    });
  };

  const bottomPad = tabContentBottomInset(insets.bottom);

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[
          styles.scroll,
          {
            paddingTop: Math.max(insets.top, spacing.md) + spacing.md,
            paddingBottom: bottomPad,
          },
        ]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        <Animated.View
          entering={FadeInDown.duration(motion.page)}
          style={styles.header}
        >
          <GradientText
            colors={[...grads.greeting]}
            style={styles.greetingLine}
          >{`${greetingLine},`}</GradientText>
          <Text
            style={[styles.nameLine, { color: c.textPrimary }]}
            accessibilityRole="header"
          >
            {displayName}
          </Text>

          <View style={styles.metaRow}>
            <View
              style={[
                styles.locationPill,
                {
                  backgroundColor: c.surface,
                  borderColor: c.border,
                  ...elev.card,
                },
              ]}
            >
              <MaterialIcons name="place" size={16} color={c.primary} />
              <Text
                style={[styles.locationText, { color: c.textPrimary }]}
                numberOfLines={1}
              >
                {placeName}
              </Text>
            </View>
          </View>

          <View style={styles.contextRow}>
            <View
              style={[
                styles.weatherPill,
                { backgroundColor: c.surfaceVariant },
              ]}
            >
              <MaterialIcons
                name={weather.icon}
                size={16}
                color={c.textPrimary}
              />
              <Text style={[styles.weatherText, { color: c.textPrimary }]}>
                {weather.label}
                {weather.tempC != null ? ` · ${weather.tempC}°` : ""}
              </Text>
            </View>
            <SafetyScoreChip score={score} label="Area safety" />
          </View>
        </Animated.View>

        <Animated.View
          entering={FadeInDown.delay(70).duration(motion.normal)}
          style={styles.searchBlock}
        >
          <Text style={[styles.searchKicker, { color: c.primary }]}>
            Where to?
          </Text>
          <TourAnchor id="search">
            <Pressable onPress={openDestinationSearch}>
              <View pointerEvents="none">
                <DesignSearchBar
                  variant="hero"
                  value={search}
                  onChangeText={setSearch}
                  placeholder="Where do you want to go safely?"
                  editable={false}
                />
              </View>
            </Pressable>
          </TourAnchor>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(120).duration(motion.normal)}>
          <Text style={[styles.sectionTitle, { color: c.textPrimary }]}>
            Quick actions
          </Text>
          <QuickActionsGrid actions={actions} />
        </Animated.View>

        <Animated.View
          entering={FadeInDown.delay(160).duration(motion.normal)}
          style={styles.guardiansBlock}
        >
          <Pressable
            onPress={() => router.push("/contacts")}
            style={({ pressed }) => [
              styles.guardiansCard,
              {
                backgroundColor: c.surface,
                borderColor: c.border,
                ...elev.card,
              },
              pressed && { transform: [{ scale: 0.98 }] },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Trusted Guardians"
          >
            <View
              style={[
                styles.guardiansIcon,
                { backgroundColor: c.primaryContainer },
              ]}
            >
              <MaterialIcons
                name="people-outline"
                size={22}
                color={c.primary}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.guardiansTitle, { color: c.textPrimary }]}>
                Trusted Guardians
              </Text>
              <Text
                style={[styles.guardiansSub, { color: c.textSecondary }]}
                numberOfLines={1}
              >
                Invite someone who always knows you’re safe
              </Text>
            </View>
            <MaterialIcons
              name="chevron-right"
              size={22}
              color={c.textTertiary}
            />
          </Pressable>
        </Animated.View>

        <Animated.View
          entering={FadeInDown.delay(200).duration(motion.normal)}
          style={styles.heatBlock}
        >
          <LiveMiniMap onPress={() => goMap()} />
        </Animated.View>
      </ScrollView>

      <TourAnchor
        id="sos"
        style={[
          styles.sosFab,
          { bottom: tabContentBottomInset(insets.bottom) - spacing.sm },
        ]}
      >
        <SOSButton
          compact
          onPress={() => router.push("/(tabs)/SOS" as never)}
          onLongPress={() => router.push("/(tabs)/SOS" as never)}
        />
      </TourAnchor>

      <DestinationSearchSheet
        visible={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelect={onDestinationSelect}
        initialQuery={search}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  scroll: {
    paddingHorizontal: spacing.lg,
  },
  header: {
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  brandWordmark: {
    fontFamily: typography.fontFamily.bold,
    fontSize: typography.size.title,
    letterSpacing: -0.3,
  },
  greetingLine: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
    letterSpacing: 0.2,
  },
  nameLine: {
    fontFamily: typography.fontFamily.bold,
    fontSize: typography.size.hero,
    lineHeight: typography.lineHeight.hero,
    letterSpacing: typography.tracking.tight,
    marginTop: -2,
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  locationPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: "100%",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  locationText: {
    flexShrink: 1,
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.caption,
  },
  weatherPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  weatherText: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.caption,
  },
  contextRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  searchBlock: {
    marginBottom: spacing.xl,
    gap: spacing.sm,
  },
  searchKicker: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.caption,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  sectionTitle: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.display,
    lineHeight: typography.lineHeight.display,
    marginBottom: spacing.md,
    letterSpacing: typography.tracking.title,
  },
  guardiansBlock: {
    marginTop: spacing.xl,
  },
  guardiansCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
  },
  guardiansIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  guardiansTitle: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.body,
  },
  guardiansSub: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.caption,
    marginTop: 2,
  },
  heatBlock: {
    marginTop: spacing.xl,
  },
  sosFab: {
    position: "absolute",
    right: spacing.lg,
    zIndex: 40,
  },
});
