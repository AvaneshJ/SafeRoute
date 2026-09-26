import { PrimaryButton, SafeRouteMark } from "@/components/design-system";
import { ONBOARDING_DONE_KEY } from "@/constants/preferences";
import { radius, spacing, typography } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useAuth } from "@/hooks/useAuth";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { Redirect, useRouter } from "expo-router";
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** Design reference frame (iPhone 14/15 logical): 390 × 844 */
const FRAME = { width: 390, height: 844 };

export default function WelcomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors: c, gradients: grads, elevation: elev } = useAppTheme();
  const { ready, bootstrapRoute } = useAuth();
  const [loading, setLoading] = useState(false);

  // Persisted Firebase session → skip welcome / onboarding / login.
  if (!ready || bootstrapRoute === "loading") {
    return <View style={[styles.root, { backgroundColor: c.background }]} />;
  }
  if (bootstrapRoute === "home") {
    return <Redirect href="/(tabs)/Home" />;
  }
  if (bootstrapRoute === "permissions") {
    return <Redirect href="/Permissions" />;
  }
  if (bootstrapRoute === "login") {
    return <Redirect href="/Login" />;
  }

  const onGetStarted = () => {
    setLoading(true);
    router.push("/Onboarding");
  };

  const onLogin = async () => {
    await AsyncStorage.setItem(ONBOARDING_DONE_KEY, "true");
    router.push("/Login");
  };

  return (
    <View
      style={[styles.root, { backgroundColor: c.background }]}
      accessibilityLabel="SafeRoute welcome"
    >
      <LinearGradient
        colors={[...grads.header, grads.iconPrimary[0]]}
        locations={[0, 0.55, 1]}
        start={{ x: 0.15, y: 0 }}
        end={{ x: 0.85, y: 1 }}
        style={StyleSheet.absoluteFill}
      />

      {/* Top — brand */}
      <View
        style={[
          styles.top,
          {
            paddingTop: Math.max(insets.top, spacing.sm) + spacing.md,
          },
        ]}
      >
        <View style={styles.brandRow}>
          <SafeRouteMark size={56} />
          <View style={styles.brandCopy}>
            <Text style={[styles.wordmark, { color: c.textPrimary }]}>
              SafeRoute
            </Text>
            <Text style={[styles.tagline, { color: c.textSecondary }]}>
              Navigate with confidence.
            </Text>
          </View>
        </View>
      </View>

      {/* Center — illustration with caption anchored below */}
      <View
        style={styles.hero}
        accessibilityRole="image"
        accessibilityLabel="Woman walking a glowing safe route through illuminated city streets at evening"
      >
        <View style={styles.heroCluster}>
          <View
            style={[
              styles.heroFrame,
              { backgroundColor: c.primaryLight },
              elev.floating,
            ]}
          >
            <Image
              source={require("../assets/images/welcome-hero.png")}
              style={styles.heroImage}
              contentFit="cover"
              transition={300}
            />
          </View>
          <Text style={[styles.emotion, { color: c.textSecondary }]}>
            A lit path home, and someone who knows you arrived.
          </Text>
        </View>
      </View>

      {/* Bottom — single primary CTA + login */}
      <View
        style={[
          styles.bottom,
          { paddingBottom: Math.max(insets.bottom, spacing.md) + spacing.sm },
        ]}
      >
        <PrimaryButton
          label="Get Started"
          loading={loading}
          onPress={onGetStarted}
          accessibilityHint="Opens a short product tour"
        />
        <Pressable
          onPress={() => void onLogin()}
          hitSlop={12}
          accessibilityRole="link"
          accessibilityLabel="Already have an account? Log in"
          style={({ pressed }) => [
            styles.loginRow,
            pressed && styles.loginPressed,
          ]}
        >
          <Text style={[styles.loginMuted, { color: c.textSecondary }]}>
            Already have an account?{" "}
          </Text>
          <Text style={[styles.loginAction, { color: c.primary }]}>Log in</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    maxWidth: FRAME.width + 80,
    alignSelf: "center",
    width: "100%",
  },
  top: {
    paddingHorizontal: spacing.lg,
    justifyContent: "flex-start",
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm + 4,
  },
  brandCopy: {
    flex: 1,
    gap: 0,
  },
  wordmark: {
    fontFamily: typography.fontFamily.bold,
    fontSize: typography.size.headline,
    lineHeight: typography.lineHeight.headline,
    letterSpacing: typography.tracking.heading,
  },
  tagline: {
    marginTop: 0,
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  emotion: {
    marginTop: spacing.md,
    maxWidth: 280,
    paddingHorizontal: spacing.sm,
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.bodyLarge,
    lineHeight: typography.lineHeight.bodyLarge,
    textAlign: "center",
  },
  hero: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    justifyContent: "center",
    alignItems: "center",
  },
  heroCluster: {
    width: "100%",
    alignItems: "center",
  },
  heroFrame: {
    width: "100%",
    maxWidth: 280,
    aspectRatio: 1,
    borderRadius: radius.hero,
    overflow: "hidden",
  },
  heroImage: {
    width: "100%",
    height: "100%",
  },
  bottom: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.md,
  },
  loginRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    alignItems: "center",
    minHeight: 44,
    paddingVertical: spacing.xs,
  },
  loginPressed: {
    opacity: 0.7,
  },
  loginMuted: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  loginAction: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
});
