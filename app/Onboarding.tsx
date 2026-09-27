import { PrimaryButton } from "@/components/design-system";
import { ONBOARDING_DONE_KEY } from "@/constants/preferences";
import { motion, radius, spacing, typography } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useAuth } from "@/hooks/useAuth";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { Redirect, useRouter } from "expo-router";
import React, { useCallback, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Dimensions,
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ImageSourcePropType,
  type ListRenderItemInfo,
  type ViewToken,
} from "react-native";
import Animated, {
  Extrapolation,
  FadeInDown,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");

type OnboardingSlide = {
  key: string;
  title: string;
  body: string;
  benefits: string[];
  image: ImageSourcePropType;
  imageLabel: string;
};

const SLIDES: OnboardingSlide[] = [
  {
    key: "ai-routes",
    title: "A safer way home",
    body: "Routes chosen for how they feel, not only how fast they are.",
    benefits: ["Well-lit streets", "Busier sidewalks", "Reports from nearby"],
    image: require("../assets/images/onboarding-safe-routes.jpg"),
    imageLabel:
      "Live city map with a glowing indigo safe route weaving through illuminated streets",
  },
  {
    key: "guardian",
    title: "Someone is with you",
    body: "A trusted person follows the trip until you arrive.",
    benefits: [
      "Live location",
      "An ETA they can trust",
      "Alerted if you need help",
    ],
    image: require("../assets/images/onboarding-guardian.jpg"),
    imageLabel:
      "Traveler and guardian connected by live location sharing with ETA and status updates",
  },
  {
    key: "sos-offline",
    title: "Help, even offline",
    body: "If the signal drops, your people still hear from you.",
    benefits: ["Hold to confirm", "Text with your location", "Dial 112 or 122"],
    image: require("../assets/images/onboarding-sos-offline.jpg"),
    imageLabel:
      "SOS countdown ring with SMS fallback, location pin, and emergency numbers 112 and 122",
  },
];

function ProgressCapsule({
  index,
  scrollX,
}: {
  index: number;
  scrollX: SharedValue<number>;
}) {
  const { colors: c } = useAppTheme();
  const style = useAnimatedStyle(() => {
    const input = [
      (index - 1) * SCREEN_WIDTH,
      index * SCREEN_WIDTH,
      (index + 1) * SCREEN_WIDTH,
    ];
    const width = interpolate(
      scrollX.value,
      input,
      [10, 36, 10],
      Extrapolation.CLAMP,
    );
    const opacity = interpolate(
      scrollX.value,
      input,
      [0.35, 1, 0.35],
      Extrapolation.CLAMP,
    );
    return { width, opacity };
  });

  return (
    <Animated.View
      style={[styles.capsule, { backgroundColor: c.primary }, style]}
    />
  );
}

export default function OnboardingScreen() {
  const { colors: c, elevation: elev } = useAppTheme();
  const router = useRouter();
  const { user, ready, bootstrapRoute } = useAuth();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<OnboardingSlide>>(null);
  const scrollX = useSharedValue(0);
  const [index, setIndex] = useState(0);
  const reduceMotion = useRef(false);

  React.useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      reduceMotion.current = enabled;
    });
  }, []);

  const finish = useCallback(async () => {
    await AsyncStorage.setItem(ONBOARDING_DONE_KEY, "true");
    router.replace("/Signup");
  }, [router]);

  const goNext = useCallback(() => {
    if (index >= SLIDES.length - 1) {
      void finish();
      return;
    }
    const next = index + 1;
    listRef.current?.scrollToIndex({
      index: next,
      animated: !reduceMotion.current,
    });
    setIndex(next);
    void Haptics.selectionAsync();
  }, [finish, index]);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollX.value = e.nativeEvent.contentOffset.x;
  };

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const first = viewableItems[0];
      if (first?.index != null) {
        setIndex(first.index);
      }
    },
  ).current;

  const viewabilityConfig = useRef({
    viewAreaCoveragePercentThreshold: 60,
  }).current;

  if (ready && user) {
    if (bootstrapRoute === "home") return <Redirect href="/(tabs)/Home" />;
    if (bootstrapRoute === "permissions") {
      return <Redirect href="/Permissions" />;
    }
  }

  const slide = SLIDES[index];
  const isLast = index === SLIDES.length - 1;

  return (
    <View
      style={[styles.root, { backgroundColor: c.charcoal }]}
      accessibilityLabel={`Onboarding, step ${index + 1} of ${SLIDES.length}`}
    >
      <FlatList
        ref={listRef}
        data={SLIDES}
        keyExtractor={(item) => item.key}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        bounces={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        style={styles.list}
        getItemLayout={(_, i) => ({
          length: SCREEN_WIDTH,
          offset: SCREEN_WIDTH * i,
          index: i,
        })}
        onScrollToIndexFailed={({ index: failed }) => {
          setTimeout(() => {
            listRef.current?.scrollToIndex({ index: failed, animated: false });
          }, 100);
        }}
        renderItem={({
          item,
          index: i,
        }: ListRenderItemInfo<OnboardingSlide>) => (
          <View style={styles.slide} accessibilityElementsHidden={i !== index}>
            <Image
              source={item.image}
              style={styles.bleed}
              contentFit="cover"
              accessibilityLabel={item.imageLabel}
              transition={280}
            />
          </View>
        )}
      />

      <Pressable
        onPress={finish}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Skip onboarding"
        accessibilityHint="Goes to account creation"
        style={({ pressed }) => [
          styles.skipHit,
          { top: Math.max(insets.top, spacing.sm) + spacing.xs },
          pressed && styles.pressed,
        ]}
      >
        <Text style={[styles.skipLabel, { color: c.textPrimary }]}>Skip</Text>
      </Pressable>

      <View
        style={[
          styles.cardWrap,
          { paddingBottom: Math.max(insets.bottom, spacing.md) },
        ]}
        pointerEvents="box-none"
      >
        <Animated.View
          key={slide.key}
          entering={FadeInDown.duration(motion.normal)}
          style={[styles.card, { backgroundColor: c.surface }, elev.sheet]}
        >
          <View
            style={styles.capsules}
            accessibilityRole="tablist"
            accessibilityLabel={`Page ${index + 1} of ${SLIDES.length}`}
          >
            {SLIDES.map((item, i) => (
              <ProgressCapsule key={item.key} index={i} scrollX={scrollX} />
            ))}
          </View>

          <Text
            style={[styles.title, { color: c.textPrimary }]}
            accessibilityRole="header"
            maxFontSizeMultiplier={1.3}
          >
            {slide.title}
          </Text>
          <Text
            style={[styles.body, { color: c.textSecondary }]}
            maxFontSizeMultiplier={1.35}
          >
            {slide.body}
          </Text>

          <View style={styles.benefits}>
            {slide.benefits.map((line) => (
              <View
                key={line}
                style={[
                  styles.benefitPill,
                  { backgroundColor: c.primaryContainer },
                ]}
              >
                <Text
                  style={[styles.benefitText, { color: c.primaryOnContainer }]}
                >
                  {line}
                </Text>
              </View>
            ))}
          </View>

          <PrimaryButton
            label={isLast ? "Finish" : "Next"}
            onPress={goNext}
            accessibilityHint={
              isLast
                ? "Finish onboarding and create an account"
                : `Go to step ${index + 2} of ${SLIDES.length}`
            }
          />
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  list: {
    flex: 1,
  },
  slide: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
  },
  bleed: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
  },
  skipHit: {
    position: "absolute",
    right: spacing.lg,
    zIndex: 3,
    minHeight: 36,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: "rgba(255,255,255,0.88)",
    justifyContent: "center",
  },
  skipLabel: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.body,
  },
  pressed: {
    opacity: 0.7,
  },
  cardWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.md,
  },
  card: {
    borderRadius: radius.hero,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.lg,
    gap: spacing.md,
  },
  capsules: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 14,
  },
  capsule: {
    height: 8,
    borderRadius: radius.pill,
  },
  title: {
    fontFamily: typography.fontFamily.bold,
    fontSize: typography.size.headline,
    lineHeight: typography.lineHeight.headline,
    letterSpacing: typography.tracking.heading,
  },
  body: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
    marginTop: -spacing.xs,
  },
  benefits: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  benefitPill: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  benefitText: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.caption,
  },
});
