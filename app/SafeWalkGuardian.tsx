import {
  GradientText,
  PrimaryButton,
  SecondaryButton,
  UserAvatar,
} from "@/components/design-system";
import { radius, spacing, typography } from "@/constants/theme";
import {
  GUARDIANS_STORAGE_KEY,
  normalizeGuardians,
  sortGuardians,
  type Guardian,
} from "@/core/guardians";
import { LAST_GUARDIAN_KEY } from "@/core/safeWalkTrip";
import { useAppTheme } from "@/hooks/useAppTheme";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function SafeWalkGuardianScreen() {
  const { colors: c, elevation: elev, gradients: grads } = useAppTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<Record<string, string>>();

  const [guardians, setGuardians] = useState<Guardian[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lastId, setLastId] = useState<string | null>(null);
  const scales = useRef<Record<string, Animated.Value>>({}).current;

  useEffect(() => {
    void (async () => {
      const [raw, storedLast] = await Promise.all([
        AsyncStorage.getItem(GUARDIANS_STORAGE_KEY),
        AsyncStorage.getItem(LAST_GUARDIAN_KEY),
      ]);
      const list = sortGuardians(
        normalizeGuardians(raw ? JSON.parse(raw) : []),
      );
      setGuardians(list);
      setLastId(storedLast);
      const initial =
        (storedLast && list.find((g) => g.id === storedLast)?.id) ||
        list.find((g) => g.isPrimary)?.id ||
        list[0]?.id ||
        null;
      setSelectedId(initial);
      list.forEach((g) => {
        if (!scales[g.id]) {
          scales[g.id] = new Animated.Value(g.id === initial ? 1.02 : 1);
        }
      });
    })();
  }, [scales]);

  const select = (id: string) => {
    setSelectedId(id);
    void Haptics.selectionAsync();
    Object.keys(scales).forEach((key) => {
      Animated.spring(scales[key], {
        toValue: key === id ? 1.02 : 1,
        useNativeDriver: true,
        friction: 7,
        tension: 160,
      }).start();
    });
  };

  const selected = guardians.find((g) => g.id === selectedId) ?? null;

  const continueNext = () => {
    if (!selected) return;
    router.push({
      pathname: "/SafeWalkReview",
      params: {
        ...params,
        guardianId: selected.id,
        guardianConnectionId: selected.connectionId ?? "",
        guardianUserId: selected.guardianUserId ?? "",
        guardianName: selected.name,
        guardianRelationship: selected.relationship,
        guardianPhone: selected.phone,
      },
    } as never);
  };

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: c.background,
          paddingTop: Math.max(insets.top, spacing.md),
          paddingBottom: Math.max(insets.bottom, spacing.lg),
        },
      ]}
    >
      <Pressable
        onPress={() => router.back()}
        style={styles.back}
        accessibilityRole="button"
        accessibilityLabel="Back"
      >
        <MaterialIcons name="arrow-back" size={22} color={c.textPrimary} />
      </Pressable>

      <Text style={[styles.eyebrow, { color: c.primary }]}>STEP 2 OF 3</Text>
      <GradientText colors={[...grads.greeting]} style={styles.title}>
        Choose Guardian
      </GradientText>
      <Text style={[styles.subtitle, { color: c.textSecondary }]}>
        Verified guardians are notified automatically — no need to accept each
        walk.
      </Text>

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
      >
        {guardians.length === 0 ? (
          <View style={styles.empty}>
            <Image
              source={require("../assets/images/guardians-empty.jpg")}
              style={[styles.emptyImage, { backgroundColor: c.heroWash }]}
              contentFit="contain"
            />
            <Text style={[styles.emptyText, { color: c.textSecondary }]}>
              Invite a trusted guardian to continue.
            </Text>
            <SecondaryButton
              label="Invite Guardian"
              onPress={() => router.push("/contacts" as never)}
            />
          </View>
        ) : (
          guardians.map((g) => {
            const selectedCard = g.id === selectedId;
            const scale = scales[g.id] ?? new Animated.Value(1);
            return (
              <Animated.View
                key={g.id}
                style={{ transform: [{ scale }] }}
              >
                <Pressable
                  onPress={() => select(g.id)}
                  style={[
                    styles.card,
                    {
                      backgroundColor: selectedCard
                        ? c.backgroundSelected
                        : c.surface,
                      borderColor: selectedCard ? c.primary : c.border,
                      borderWidth: selectedCard ? 2 : StyleSheet.hairlineWidth,
                      ...(selectedCard ? elev.cardLift : elev.card),
                    },
                  ]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: selectedCard }}
                >
                  <UserAvatar name={g.name} size={52} />
                  <View style={styles.meta}>
                    <View style={styles.nameRow}>
                      <Text
                        style={[styles.name, { color: c.textPrimary }]}
                        numberOfLines={1}
                      >
                        {g.name}
                      </Text>
                      {g.isPrimary ? (
                        <View
                          style={[
                            styles.badge,
                            { backgroundColor: c.primaryContainer },
                          ]}
                        >
                          <Text
                            style={[
                              styles.badgeText,
                              { color: c.primaryOnContainer },
                            ]}
                          >
                            Primary
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    <Text style={[styles.rel, { color: c.textSecondary }]}>
                      {g.relationship}
                    </Text>
                    <View style={styles.tags}>
                      <View
                        style={[
                          styles.tag,
                          {
                            backgroundColor: g.verified
                              ? c.successContainer
                              : c.warningContainer,
                          },
                        ]}
                      >
                        <MaterialIcons
                          name={g.verified ? "verified" : "sms"}
                          size={12}
                          color={g.verified ? c.successText : c.warning}
                        />
                        <Text
                          style={[
                            styles.tagText,
                            { color: g.verified ? c.successText : c.warning },
                          ]}
                        >
                          {g.verified ? "Connected" : "SMS fallback"}
                        </Text>
                      </View>
                      {lastId === g.id ? (
                        <Text
                          style={[styles.lastUsed, { color: c.textTertiary }]}
                        >
                          Last used
                        </Text>
                      ) : null}
                    </View>
                  </View>
                  {selectedCard ? (
                    <View
                      style={[
                        styles.check,
                        { backgroundColor: c.primary },
                      ]}
                    >
                      <MaterialIcons
                        name="check"
                        size={16}
                        color={c.textOnPrimary}
                      />
                    </View>
                  ) : (
                    <View style={styles.checkSpacer} />
                  )}
                </Pressable>
              </Animated.View>
            );
          })
        )}
      </ScrollView>

      {selected ? (
        <Text style={[styles.confirm, { color: c.textSecondary }]}>
          {selected.name} will get SMS alerts with your map location, ETA, and
          emergency updates.
        </Text>
      ) : null}

      <PrimaryButton
        label="Continue"
        onPress={continueNext}
        disabled={!selected}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  flex: { flex: 1 },
  back: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: -8,
  },
  eyebrow: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.caption,
    letterSpacing: 1,
  },
  title: {
    fontFamily: typography.fontFamily.bold,
    fontSize: typography.size.display,
    lineHeight: typography.lineHeight.display,
    letterSpacing: typography.tracking.heading,
  },
  subtitle: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  list: {
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.xl,
  },
  meta: { flex: 1, gap: 4 },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  name: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.bodyLarge,
    flexShrink: 1,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  badgeText: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: 11,
  },
  rel: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.caption,
  },
  tags: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: 2,
  },
  tag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  tagText: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: 11,
  },
  lastUsed: {
    fontFamily: typography.fontFamily.medium,
    fontSize: 11,
  },
  check: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  checkSpacer: {
    width: 28,
    height: 28,
  },
  confirm: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
    textAlign: "center",
  },
  empty: {
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.xl,
  },
  emptyImage: {
    width: "100%",
    height: 160,
    borderRadius: radius.lg,
  },
  emptyText: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.body,
    textAlign: "center",
  },
});
