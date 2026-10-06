import {
  GradientText,
  ModalBottomSheet,
  PrimaryButton,
  SecondaryButton,
  UserAvatar,
} from "@/components/design-system";
import { DestinationSearchSheet } from "@/components/destination/DestinationSearchSheet";
import {
  motion,
  radius,
  spacing,
  tabContentBottomInset,
  typography,
} from "@/constants/theme";
import {
  loadPinnedPlace,
  loadRecentSearches,
  type DestinationCoordinate,
  type DestinationPlace,
} from "@/core/destinationSearch";
import {
  GUARDIANS_STORAGE_KEY,
  normalizeGuardians,
  type Guardian,
} from "@/core/guardians";
import {
  evaluateSafeWalkDistance,
  formatDistanceKm,
  formatDurationMin,
  haversineKm,
  LAST_GUARDIAN_KEY,
  walkingEtaMinutes,
} from "@/core/safeWalkTrip";
import { useAppTheme } from "@/hooks/useAppTheme";
import {
  useMyOpenSafeWalks,
  type MyOpenSafeWalk,
} from "@/hooks/useMyOpenSafeWalk";
import {
  endSafetySession,
  isSafeWalkScreenMounted,
  loadActiveSafeWalk,
} from "@/services/activeSafeWalk";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import * as Location from "expo-location";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useRef, useState } from "react";
import {
  Alert,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type TripDraft = {
  place: DestinationPlace;
  origin: DestinationCoordinate;
  originLabel: string;
  distanceKm: number;
  etaMin: number;
};

export default function SafeWalkScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { colors: c, elevation: elev, gradients: grads } = useAppTheme();

  const [guardians, setGuardians] = useState<Guardian[]>([]);
  const [lastGuardian, setLastGuardian] = useState<Guardian | null>(null);
  const [recents, setRecents] = useState<DestinationPlace[]>([]);
  const [home, setHome] = useState<DestinationPlace | null>(null);
  const [work, setWork] = useState<DestinationPlace | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [tripDraft, setTripDraft] = useState<TripDraft | null>(null);
  const [resolving, setResolving] = useState(false);
  const { walks: openWalks } = useMyOpenSafeWalks();
  const [endingWalkId, setEndingWalkId] = useState<string | null>(null);

  const resumeWalk = async (walk: MyOpenSafeWalk) => {
    const stored = await loadActiveSafeWalk();
    const params =
      stored?.sessionId === walk.id
        ? stored.params
        : {
            sessionId: walk.id,
            destTitle: walk.destinationLabel ?? "Destination",
            ...(walk.destination
              ? {
                  destLat: String(walk.destination.latitude),
                  destLng: String(walk.destination.longitude),
                }
              : {}),
            ...(walk.startLocation
              ? {
                  originLat: String(walk.startLocation.latitude),
                  originLng: String(walk.startLocation.longitude),
                }
              : {}),
            ...(walk.etaMinutes != null ? { etaMin: String(walk.etaMinutes) } : {}),
          };
    const href = { pathname: "/SafeWalkLive", params } as never;
    // Go back to the live screen if it's still in the stack instead of opening a second copy.
    if (isSafeWalkScreenMounted(walk.id)) router.dismissTo(href);
    else router.push(href);
  };

  const endOpenWalk = (walk: MyOpenSafeWalk) => {
    Alert.alert(
      "End this Safe Walk?",
      "Your guardians will be told you stopped sharing your location.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "End walk",
          style: "destructive",
          onPress: async () => {
            setEndingWalkId(walk.id);
            const result = await endSafetySession(walk.id);
            setEndingWalkId(null);
            if (result.ok) {
              Alert.alert(
                "Safe Walk ended",
                result.alreadyClosed
                  ? "This walk had already ended."
                  : "Your guardians have been notified.",
              );
            } else {
              Alert.alert(
                "Couldn't end Safe Walk",
                `${result.error}\n\nCheck your connection and try again.`,
                [
                  { text: "Cancel", style: "cancel" },
                  { text: "Try again", onPress: () => endOpenWalk(walk) },
                ],
              );
            }
          },
        },
      ],
    );
  };

  /** One walk at a time: returns false (and explains) if one is already open. */
  const ensureNoOpenWalk = (): boolean => {
    const open = openWalks[0];
    if (!open) return true;
    Alert.alert(
      "Safe Walk already running",
      "Resume it or end it before starting a new one.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "End it", style: "destructive", onPress: () => endOpenWalk(open) },
        { text: "Resume", onPress: () => void resumeWalk(open) },
      ],
    );
    return false;
  };

  const heroOpacity = useRef(new Animated.Value(0)).current;
  const heroY = useRef(new Animated.Value(16)).current;

  useFocusEffect(
    useCallback(() => {
      void (async () => {
        const [raw, lastId, recentList, homePlace, workPlace] =
          await Promise.all([
            AsyncStorage.getItem(GUARDIANS_STORAGE_KEY),
            AsyncStorage.getItem(LAST_GUARDIAN_KEY),
            loadRecentSearches(),
            loadPinnedPlace("home"),
            loadPinnedPlace("work"),
          ]);
        const list = normalizeGuardians(raw ? JSON.parse(raw) : []);
        setGuardians(list);
        const byLast = lastId
          ? list.find((g) => g.id === lastId) ?? null
          : null;
        setLastGuardian(
          byLast ?? list.find((g) => g.isPrimary) ?? list[0] ?? null,
        );
        setRecents(recentList.slice(0, 3));
        setHome(homePlace);
        setWork(workPlace);
      })();

      heroOpacity.setValue(0);
      heroY.setValue(16);
      Animated.parallel([
        Animated.timing(heroOpacity, {
          toValue: 1,
          duration: motion.slow,
          useNativeDriver: true,
        }),
        Animated.timing(heroY, {
          toValue: 0,
          duration: motion.slow,
          useNativeDriver: true,
        }),
      ]).start();
    }, [heroOpacity, heroY]),
  );

  const resolveOrigin = async (): Promise<{
    coord: DestinationCoordinate;
    label: string;
  } | null> => {
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== Location.PermissionStatus.GRANTED) {
        Alert.alert(
          "Location needed",
          "Allow location access so Safe Walk can watch your route.",
        );
        return null;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      return {
        coord: {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        },
        label: "Current location",
      };
    } catch {
      Alert.alert(
        "Location unavailable",
        "Could not read your position. Try again in a moment.",
      );
      return null;
    }
  };

  const openTripPreview = async (place: DestinationPlace) => {
    if (!ensureNoOpenWalk()) return;
    setResolving(true);
    const origin = await resolveOrigin();
    setResolving(false);
    if (!origin) return;

    const distanceKm = haversineKm(origin.coord, place.coordinate);
    const etaMin = walkingEtaMinutes(distanceKm);
    const eligibility = evaluateSafeWalkDistance(distanceKm);

    if (eligibility.status === "blocked") {
      Alert.alert("Too far for Safe Walk", eligibility.message, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Open Safe Route",
          onPress: () => router.push("/(tabs)/navigate" as never),
        },
      ]);
      return;
    }

    setTripDraft({
      place,
      origin: origin.coord,
      originLabel: origin.label,
      distanceKm,
      etaMin,
    });
  };

  const continueFromTrip = () => {
    if (!tripDraft) return;
    const eligibility = evaluateSafeWalkDistance(tripDraft.distanceKm);
    if (eligibility.status === "blocked") return;

    const params = {
      destId: tripDraft.place.id,
      destTitle: tripDraft.place.title,
      destSubtitle: tripDraft.place.subtitle,
      destLat: String(tripDraft.place.coordinate.latitude),
      destLng: String(tripDraft.place.coordinate.longitude),
      originLat: String(tripDraft.origin.latitude),
      originLng: String(tripDraft.origin.longitude),
      originLabel: tripDraft.originLabel,
      distanceKm: String(tripDraft.distanceKm.toFixed(3)),
      etaMin: String(tripDraft.etaMin),
      distanceWarn: eligibility.status === "warn" ? "1" : "0",
    };

    setTripDraft(null);

    if (guardians.length === 0) {
      Alert.alert(
        "Add a guardian",
        "Invite someone you trust before starting Safe Walk.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Invite Guardian",
            onPress: () => router.push("/contacts" as never),
          },
        ],
      );
      return;
    }

    router.push({
      pathname: "/SafeWalkGuardian",
      params,
    } as never);
  };

  const quickPlaces: {
    key: string;
    label: string;
    icon: React.ComponentProps<typeof MaterialIcons>["name"];
    place: DestinationPlace | null;
  }[] = [
    { key: "home", label: "Home", icon: "home", place: home },
    { key: "office", label: "Office", icon: "work-outline", place: work },
    {
      key: "metro",
      label: recents[0]?.title?.slice(0, 12) || "Metro",
      icon: "train",
      place: recents[0] ?? null,
    },
  ];

  const eligibility = tripDraft
    ? evaluateSafeWalkDistance(tripDraft.distanceKm)
    : null;

  return (
    <>
      <ScrollView
        style={[styles.root, { backgroundColor: c.background }]}
        contentContainerStyle={[
          styles.scroll,
          {
            paddingTop: Math.max(insets.top, spacing.md) + spacing.sm,
            paddingBottom: tabContentBottomInset(insets.bottom),
          },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.eyebrow, { color: c.primary }]}>
          LIVE PROTECTION
        </Text>
        <GradientText colors={[...grads.greeting]} style={styles.title}>
          Safe Walk
        </GradientText>
        <Text style={[styles.subtitle, { color: c.textSecondary }]}>
          Share your walk with someone you trust.
        </Text>

        <Animated.View
          style={{
            opacity: heroOpacity,
            transform: [{ translateY: heroY }],
          }}
        >
          <LinearGradient
            colors={[...grads.header]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[
              styles.hero,
              {
                borderColor: c.border,
                ...elev.floating,
              },
            ]}
          >
            <View style={styles.heroCopy}>
              <View
                style={[
                  styles.heroIconWrap,
                  { backgroundColor: c.primaryContainer },
                ]}
              >
                <MaterialIcons
                  name="directions-walk"
                  size={28}
                  color={c.primary}
                />
              </View>
              <Text style={[styles.heroTitle, { color: c.textPrimary }]}>
                Calm, short walks — quietly watched.
              </Text>
              <Text style={[styles.heroBody, { color: c.textSecondary }]}>
                Up to 3 km · live share · automatic check-ins · SOS ready
              </Text>
            </View>
            <Image
              source={require("../../assets/images/onboarding-guardian.jpg")}
              style={styles.heroImage}
              contentFit="contain"
            />
          </LinearGradient>
        </Animated.View>

        {openWalks.map((walk) => (
          <View
            key={walk.id}
            style={[
              styles.card,
              styles.liveCard,
              {
                backgroundColor: c.surface,
                borderColor: walk.state === "active" ? c.primary : c.danger,
                ...elev.card,
              },
            ]}
          >
            <View style={styles.liveHeader}>
              <View
                style={[
                  styles.liveDot,
                  {
                    backgroundColor:
                      walk.state === "active" ? c.success : c.danger,
                  },
                ]}
              />
              <Text style={[styles.liveTitle, { color: c.textPrimary }]}>
                {walk.state === "sos"
                  ? "Safe Walk · guardian alerted"
                  : walk.state === "check_in_pending"
                    ? "Safe Walk · check-in pending"
                    : "Safe Walk in progress"}
              </Text>
            </View>
            <Text
              style={[styles.liveSub, { color: c.textSecondary }]}
              numberOfLines={1}
            >
              {walk.destinationLabel
                ? `To ${walk.destinationLabel}`
                : "Your guardians can see your live location."}
              {walk.createdAtMs
                ? ` · started ${new Date(walk.createdAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                : ""}
            </Text>
            <View style={styles.liveActions}>
              <View style={styles.liveAction}>
                <PrimaryButton
                  label="Resume"
                  onPress={() => void resumeWalk(walk)}
                />
              </View>
              <View style={styles.liveAction}>
                <SecondaryButton
                  label={endingWalkId === walk.id ? "Ending…" : "End walk"}
                  disabled={endingWalkId != null}
                  onPress={() => endOpenWalk(walk)}
                />
              </View>
            </View>
          </View>
        ))}

        <PrimaryButton
          label={resolving ? "Getting location…" : "Start Safe Walk"}
          loading={resolving}
          onPress={() => {
            if (ensureNoOpenWalk()) setSearchOpen(true);
          }}
          disabled={resolving}
        />

        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: c.textTertiary }]}>
            Recent destinations
          </Text>
          <View style={styles.chipRow}>
            {quickPlaces.map((item) => (
              <Pressable
                key={item.key}
                disabled={!item.place}
                onPress={() => item.place && void openTripPreview(item.place)}
                style={({ pressed }) => [
                  styles.destChip,
                  {
                    backgroundColor: c.surface,
                    borderColor: c.border,
                    ...elev.card,
                    opacity: item.place ? 1 : 0.45,
                  },
                  pressed && item.place && { ...elev.cardLift },
                ]}
                accessibilityRole="button"
                accessibilityLabel={item.label}
              >
                <View
                  style={[
                    styles.destIcon,
                    { backgroundColor: c.primaryContainer },
                  ]}
                >
                  <MaterialIcons name={item.icon} size={18} color={c.primary} />
                </View>
                <Text
                  style={[styles.destLabel, { color: c.textPrimary }]}
                  numberOfLines={1}
                >
                  {item.label}
                </Text>
              </Pressable>
            ))}
          </View>
          {recents.length > 1 ? (
            <View style={styles.recentList}>
              {recents.slice(1).map((place) => (
                <Pressable
                  key={place.id}
                  onPress={() => void openTripPreview(place)}
                  style={({ pressed }) => [
                    styles.recentRow,
                    {
                      backgroundColor: pressed
                        ? c.surfaceVariant
                        : c.surface,
                      borderColor: c.border,
                    },
                  ]}
                >
                  <MaterialIcons
                    name="history"
                    size={18}
                    color={c.textTertiary}
                  />
                  <View style={styles.recentMeta}>
                    <Text
                      style={[styles.recentTitle, { color: c.textPrimary }]}
                      numberOfLines={1}
                    >
                      {place.title}
                    </Text>
                    <Text
                      style={[styles.recentSub, { color: c.textSecondary }]}
                      numberOfLines={1}
                    >
                      {place.subtitle}
                    </Text>
                  </View>
                  <MaterialIcons
                    name="chevron-right"
                    size={20}
                    color={c.textTertiary}
                  />
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>

        <View
          style={[
            styles.card,
            {
              backgroundColor: c.surface,
              borderColor: c.border,
              ...elev.card,
            },
          ]}
        >
          <Text style={[styles.cardLabel, { color: c.textTertiary }]}>
            Last guardian used
          </Text>
          {lastGuardian ? (
            <View style={styles.guardianRow}>
              <UserAvatar name={lastGuardian.name} size={56} />
              <View style={styles.guardianMeta}>
                <Text style={[styles.guardianName, { color: c.textPrimary }]}>
                  {lastGuardian.name}
                </Text>
                <Text
                  style={[styles.guardianRel, { color: c.textSecondary }]}
                >
                  {lastGuardian.relationship}
                  {lastGuardian.isPrimary ? " · Primary" : ""}
                </Text>
                <View
                  style={[
                    styles.verifiedPill,
                    { backgroundColor: c.successContainer },
                  ]}
                >
                  <MaterialIcons
                    name="verified"
                    size={12}
                    color={c.successText}
                  />
                  <Text
                    style={[styles.verifiedText, { color: c.successText }]}
                  >
                    Verified
                  </Text>
                </View>
              </View>
            </View>
          ) : (
            <View style={styles.emptyBlock}>
              <Image
                source={require("../../assets/images/guardians-empty.jpg")}
                style={[styles.emptyImage, { backgroundColor: c.heroWash }]}
                contentFit="contain"
              />
              <Text style={[styles.empty, { color: c.textSecondary }]}>
                No guardians yet. Invite someone you trust before your first
                Safe Walk.
              </Text>
              <SecondaryButton
                label="Invite Guardian"
                onPress={() => router.push("/contacts" as never)}
              />
            </View>
          )}
        </View>
      </ScrollView>

      <DestinationSearchSheet
        visible={searchOpen}
        onClose={() => setSearchOpen(false)}
        confirmLabel="Continue"
        onSelect={(place) => {
          setSearchOpen(false);
          void openTripPreview(place);
        }}
      />

      <ModalBottomSheet
        visible={tripDraft != null}
        onClose={() => setTripDraft(null)}
        title="Confirm destination"
        heightRatio={0.52}
        footer={
          tripDraft ? (
            <>
              <PrimaryButton label="Continue" onPress={continueFromTrip} />
              {eligibility?.status === "warn" ? (
                <SecondaryButton
                  label="Use Safe Route instead"
                  onPress={() => {
                    setTripDraft(null);
                    router.push("/(tabs)/navigate" as never);
                  }}
                />
              ) : null}
            </>
          ) : null
        }
      >
        {tripDraft ? (
          <View style={styles.sheetBody}>
            <Text style={[styles.tripRoute, { color: c.textPrimary }]}>
              {tripDraft.originLabel} → {tripDraft.place.title}
            </Text>
            <Text style={[styles.tripMeta, { color: c.textSecondary }]}>
              {formatDistanceKm(tripDraft.distanceKm)} ·{" "}
              {formatDurationMin(tripDraft.etaMin)} · Walking
            </Text>
            {tripDraft.place.subtitle ? (
              <Text
                style={[styles.tripSub, { color: c.textTertiary }]}
                numberOfLines={2}
              >
                {tripDraft.place.subtitle}
              </Text>
            ) : null}

            {eligibility?.status === "warn" ? (
              <View
                style={[
                  styles.warnBanner,
                  {
                    backgroundColor: c.warningContainer,
                    borderColor: c.warning,
                  },
                ]}
              >
                <MaterialIcons name="info-outline" size={18} color={c.warning} />
                <Text style={[styles.warnText, { color: c.textPrimary }]}>
                  {eligibility.message}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </ModalBottomSheet>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  eyebrow: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.caption,
    letterSpacing: 1,
  },
  title: {
    fontFamily: typography.fontFamily.bold,
    fontSize: typography.size.hero,
    lineHeight: typography.lineHeight.hero,
    letterSpacing: typography.tracking.tight,
  },
  subtitle: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
    marginBottom: spacing.xs,
  },
  hero: {
    borderRadius: radius.hero,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    minHeight: 168,
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
    gap: spacing.sm,
  },
  heroCopy: {
    flex: 1,
    gap: spacing.sm,
  },
  heroIconWrap: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  heroTitle: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.bodyLarge,
    lineHeight: typography.lineHeight.bodyLarge,
  },
  heroBody: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
  },
  heroImage: {
    width: 100,
    height: 120,
  },
  section: {
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  sectionLabel: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.caption,
    letterSpacing: 0.4,
  },
  chipRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  destChip: {
    flex: 1,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
    gap: spacing.sm,
    alignItems: "flex-start",
  },
  destIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  destLabel: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.caption,
  },
  recentList: {
    gap: spacing.xs,
  },
  recentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  recentMeta: { flex: 1, gap: 2 },
  recentTitle: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.body,
  },
  recentSub: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.caption,
  },
  card: {
    borderRadius: radius.xl,
    padding: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
  },
  cardLabel: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.caption,
  },
  liveCard: {
    borderWidth: 1.5,
    gap: spacing.sm,
  },
  liveHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  liveDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  liveTitle: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.bodyLarge,
  },
  liveSub: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.caption,
  },
  liveActions: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  liveAction: { flex: 1 },
  guardianRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  guardianMeta: { flex: 1, gap: 4 },
  guardianName: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.title,
  },
  guardianRel: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.body,
  },
  verifiedPill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  verifiedText: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: 11,
  },
  emptyBlock: {
    alignItems: "center",
    gap: spacing.md,
  },
  emptyImage: {
    width: "100%",
    height: 140,
    borderRadius: radius.lg,
  },
  empty: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.body,
    textAlign: "center",
  },
  sheetBody: {
    gap: spacing.md,
  },
  tripRoute: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.title,
    lineHeight: typography.lineHeight.title,
  },
  tripMeta: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.body,
  },
  tripSub: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.caption,
  },
  warnBanner: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    alignItems: "flex-start",
  },
  warnText: {
    flex: 1,
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
  },
});
