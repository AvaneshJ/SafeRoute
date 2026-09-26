import {
  AuthTextField,
  PrimaryButton,
  SafeRouteMark,
  SocialButton,
  type FieldStatus,
} from "@/components/design-system";
import { auth } from "@/config/firebase";
import {
  ONBOARDING_DONE_KEY,
  PERMISSIONS_WIZARD_KEY,
  PRODUCT_TOUR_DONE_KEY,
  PRODUCT_TOUR_PENDING_KEY,
  SIGNUP_PHONE_KEY,
} from "@/constants/preferences";
import { spacing, typography } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useAuth } from "@/hooks/useAuth";
import { ensureUserProfile, registerPushToken } from "@/services/notifications";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Linking from "expo-linking";
import { Redirect, useRouter } from "expo-router";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
} from "firebase/auth";
import React, { useMemo, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export type AuthMode = "signup" | "login";

type FieldState = {
  value: string;
  error: string;
  touched: boolean;
};

const emptyField = (): FieldState => ({ value: "", error: "", touched: false });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** 10-digit Indian mobile; optional leading country digits stripped before validate */
const PHONE_RE = /^[6-9]\d{9}$/;

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function normalizePhone(value: string): string {
  const digits = digitsOnly(value);
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

function statusFor(field: FieldState, valid: boolean): FieldStatus {
  if (field.error) return "error";
  if (field.touched && field.value.length > 0 && valid) return "success";
  return "default";
}

type AuthScreenProps = {
  initialMode?: AuthMode;
};

export function AuthScreen({ initialMode = "signup" }: AuthScreenProps) {
  const { colors: c } = useAppTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, ready, bootstrapRoute } = useAuth();

  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [name, setName] = useState<FieldState>(emptyField);
  const [email, setEmail] = useState<FieldState>(emptyField);
  const [phone, setPhone] = useState<FieldState>(emptyField);
  const [password, setPassword] = useState<FieldState>(emptyField);
  const [confirm, setConfirm] = useState<FieldState>(emptyField);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  const isSignup = mode === "signup";

  const emailValid = EMAIL_RE.test(email.value.trim());
  const phoneDigits = normalizePhone(phone.value);
  const phoneEntered = phoneDigits.length > 0;
  const phoneValid = !phoneEntered || PHONE_RE.test(phoneDigits);
  const passwordValid = password.value.length >= 6;
  const confirmValid =
    confirm.value.length > 0 && confirm.value === password.value;
  const nameValid = name.value.trim().length >= 2;

  const title = isSignup ? "Create your account" : "Welcome back";
  const subtitle = isSignup
    ? "Join SafeRoute to plan safer trips and stay connected."
    : "Sign in to continue navigating with confidence.";

  const update =
    (setter: React.Dispatch<React.SetStateAction<FieldState>>) =>
    (text: string) => {
      setter({ value: text, error: "", touched: true });
    };

  const validate = (): boolean => {
    let ok = true;
    const fail = (
      setter: React.Dispatch<React.SetStateAction<FieldState>>,
      current: FieldState,
      message: string,
    ) => {
      setter({ ...current, error: message, touched: true });
      ok = false;
    };

    if (isSignup && !nameValid) {
      fail(setName, name, "Enter your full name");
    }

    if (!email.value.trim()) {
      fail(setEmail, email, "Email is required");
    } else if (!emailValid) {
      fail(setEmail, email, "Enter a valid email");
    }

    if (isSignup && phoneEntered && !PHONE_RE.test(phoneDigits)) {
      fail(setPhone, phone, "Enter a valid 10-digit mobile number");
    }

    if (!password.value) fail(setPassword, password, "Password is required");
    else if (!passwordValid)
      fail(setPassword, password, "Use at least 6 characters");

    if (isSignup) {
      if (!confirm.value) fail(setConfirm, confirm, "Confirm your password");
      else if (!confirmValid)
        fail(setConfirm, confirm, "Passwords do not match");
    }

    return ok;
  };

  const onContinue = async () => {
    if (!validate()) return;

    setLoading(true);
    try {
      await AsyncStorage.setItem(ONBOARDING_DONE_KEY, "true");
      if (isSignup) {
        const cred = await createUserWithEmailAndPassword(
          auth,
          email.value.trim(),
          password.value,
        );
        const displayName = name.value.trim();
        await updateProfile(cred.user, {
          displayName,
        });
        if (phoneEntered) {
          await AsyncStorage.setItem(SIGNUP_PHONE_KEY, phoneDigits);
        } else {
          await AsyncStorage.removeItem(SIGNUP_PHONE_KEY);
        }
        // Profile/push must not block auth navigation (Firestore/FCM can hang).
        void ensureUserProfile().catch(console.warn);
        void registerPushToken().catch(console.warn);
        const pendingInvite = await AsyncStorage.getItem(
          "@SafeRoute:pendingGuardianInvite",
        );
        if (pendingInvite) {
          await AsyncStorage.removeItem("@SafeRoute:pendingGuardianInvite");
          router.replace({
            pathname: "/GuardianInvite",
            params: JSON.parse(pendingInvite),
          });
          return;
        }
        Alert.alert(
          "Account created",
          `Welcome, ${displayName}! Your SafeRoute account is ready.`,
        );
        await AsyncStorage.setItem(PRODUCT_TOUR_PENDING_KEY, "true");
        router.replace("/Permissions");
      } else {
        const cred = await signInWithEmailAndPassword(
          auth,
          email.value.trim(),
          password.value,
        );
        void ensureUserProfile().catch(console.warn);
        void registerPushToken().catch(console.warn);
        const pendingInvite = await AsyncStorage.getItem(
          "@SafeRoute:pendingGuardianInvite",
        );
        if (pendingInvite) {
          await AsyncStorage.removeItem("@SafeRoute:pendingGuardianInvite");
          router.replace({
            pathname: "/GuardianInvite",
            params: JSON.parse(pendingInvite),
          });
          return;
        }
        Alert.alert(
          "Signed in",
          `Welcome back${cred.user.displayName ? `, ${cred.user.displayName}` : ""}!`,
        );
        const wizardDone = await AsyncStorage.getItem(PERMISSIONS_WIZARD_KEY);
        if (wizardDone === "true") {
          const tourDone = await AsyncStorage.getItem(PRODUCT_TOUR_DONE_KEY);
          if (tourDone !== "true") {
            await AsyncStorage.setItem(PRODUCT_TOUR_PENDING_KEY, "true");
          }
          router.replace("/(tabs)/Home");
        } else {
          await AsyncStorage.setItem(PRODUCT_TOUR_PENDING_KEY, "true");
          router.replace("/Permissions");
        }
      }
    } catch (error) {
      Alert.alert(
        isSignup ? "Sign up failed" : "Sign in failed",
        (error as Error).message,
      );
    } finally {
      setLoading(false);
    }
  };

  const onGoogle = () => {
    setGoogleLoading(true);
    Alert.alert(
      "Google",
      "Google Sign-In will activate once OAuth credentials are added to this project.",
    );
    setGoogleLoading(false);
  };

  const openLegal = async (kind: "privacy" | "terms") => {
    const url =
      kind === "privacy"
        ? "https://saferoute.app/privacy"
        : "https://saferoute.app/terms";
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert("Unavailable", "Could not open the link right now.");
    }
  };

  const modeSwitcher = useMemo(
    () =>
      isSignup ? (
        <Text style={[styles.switchText, { color: c.textSecondary }]}>
          Already have an account?{" "}
          <Text
            style={[styles.switchLink, { color: c.textLink }]}
            onPress={() => {
              setMode("login");
              setConfirm(emptyField());
              setPhone(emptyField());
            }}
            accessibilityRole="link"
          >
            Log in
          </Text>
        </Text>
      ) : (
        <Text style={[styles.switchText, { color: c.textSecondary }]}>
          Need an account?{" "}
          <Text
            style={[styles.switchLink, { color: c.textLink }]}
            onPress={() => setMode("signup")}
            accessibilityRole="link"
          >
            Sign up
          </Text>
        </Text>
      ),
    [isSignup, c.textLink, c.textSecondary],
  );

  if (ready && user) {
    if (bootstrapRoute === "home") return <Redirect href="/(tabs)/Home" />;
    if (bootstrapRoute === "permissions") {
      return <Redirect href="/Permissions" />;
    }
  }

  return (
    <View
      style={[
        styles.root,
        {
          paddingTop: Math.max(insets.top, spacing.sm),
          backgroundColor: c.background,
        },
      ]}
    >
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            { paddingBottom: Math.max(insets.bottom, spacing.lg) + spacing.md },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.brand}>
            <SafeRouteMark size={48} />
            <Text style={[styles.wordmark, { color: c.textPrimary }]}>
              SafeRoute
            </Text>
          </View>

          <Text
            style={[styles.title, { color: c.textPrimary }]}
            accessibilityRole="header"
          >
            {title}
          </Text>
          <Text style={[styles.subtitle, { color: c.textSecondary }]}>
            {subtitle}
          </Text>

          <View style={styles.form}>
            {isSignup ? (
              <AuthTextField
                label="Name"
                value={name.value}
                onChangeText={update(setName)}
                status={statusFor(name, nameValid)}
                helperText={
                  name.error ||
                  (statusFor(name, nameValid) === "success"
                    ? "Looks good"
                    : undefined)
                }
                leadingIcon="person-outline"
                autoCapitalize="words"
                textContentType="name"
                returnKeyType="next"
              />
            ) : null}

            <AuthTextField
              label="Email"
              value={email.value}
              onChangeText={update(setEmail)}
              status={statusFor(email, emailValid)}
              helperText={
                email.error ||
                (statusFor(email, emailValid) === "success"
                  ? "Valid email"
                  : undefined)
              }
              leadingIcon="mail-outline"
              autoCapitalize="none"
              keyboardType="email-address"
              textContentType="emailAddress"
              autoComplete="email"
              returnKeyType="next"
            />

            {isSignup ? (
              <AuthTextField
                label="Phone (optional)"
                value={phone.value}
                onChangeText={(text) => {
                  const next = normalizePhone(text).slice(0, 10);
                  setPhone({ value: next, error: "", touched: true });
                }}
                status={
                  phoneEntered
                    ? statusFor(phone, PHONE_RE.test(phoneDigits))
                    : "default"
                }
                helperText={
                  phone.error ||
                  (phoneEntered && PHONE_RE.test(phoneDigits)
                    ? "Used for SOS and guardian alerts"
                    : "Optional — for SOS and guardian SMS")
                }
                leadingIcon="phone-iphone"
                prefix="+91"
                keyboardType="phone-pad"
                textContentType="telephoneNumber"
                autoComplete="tel"
                maxLength={10}
                returnKeyType="next"
              />
            ) : null}

            <AuthTextField
              label="Password"
              value={password.value}
              onChangeText={update(setPassword)}
              status={statusFor(password, passwordValid)}
              helperText={
                password.error ||
                (statusFor(password, passwordValid) === "success"
                  ? "Strong enough to continue"
                  : "At least 6 characters")
              }
              password
              leadingIcon="lock-outline"
              textContentType={isSignup ? "newPassword" : "password"}
              returnKeyType={isSignup ? "next" : "done"}
            />

            {isSignup ? (
              <AuthTextField
                label="Confirm Password"
                value={confirm.value}
                onChangeText={update(setConfirm)}
                status={statusFor(confirm, confirmValid)}
                helperText={
                  confirm.error ||
                  (statusFor(confirm, confirmValid) === "success"
                    ? "Passwords match"
                    : undefined)
                }
                password
                leadingIcon="lock-outline"
                textContentType="newPassword"
                returnKeyType="done"
              />
            ) : null}
          </View>

          <PrimaryButton
            label="Continue"
            loading={loading}
            onPress={onContinue}
            style={styles.continue}
            accessibilityHint={
              isSignup
                ? "Create your SafeRoute account"
                : "Sign in to SafeRoute"
            }
          />

          <View style={styles.dividerRow}>
            <View style={[styles.dividerLine, { backgroundColor: c.border }]} />
            <Text style={[styles.dividerText, { color: c.textTertiary }]}>
              or
            </Text>
            <View style={[styles.dividerLine, { backgroundColor: c.border }]} />
          </View>

          <SocialButton
            provider="google"
            loading={googleLoading}
            onPress={onGoogle}
          />

          {modeSwitcher}

          <Text style={[styles.legal, { color: c.textTertiary }]}>
            By continuing, you agree to our{" "}
            <Text
              style={[styles.legalLink, { color: c.primary }]}
              onPress={() => openLegal("terms")}
              accessibilityRole="link"
            >
              Terms
            </Text>{" "}
            and acknowledge the{" "}
            <Text
              style={[styles.legalLink, { color: c.primary }]}
              onPress={() => openLegal("privacy")}
              accessibilityRole="link"
            >
              Privacy Notice
            </Text>
            .
          </Text>

          <Pressable
            onPress={() => router.back()}
            hitSlop={12}
            style={styles.back}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Text style={[styles.backLabel, { color: c.textSecondary }]}>
              Back
            </Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  scroll: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm + 4,
    marginBottom: spacing.xl,
  },
  wordmark: {
    fontFamily: typography.fontFamily.bold,
    fontSize: typography.size.title,
    lineHeight: typography.lineHeight.title,
  },
  title: {
    fontFamily: typography.fontFamily.bold,
    fontSize: typography.size.headline,
    lineHeight: typography.lineHeight.headline,
    letterSpacing: typography.tracking.heading,
    marginBottom: spacing.sm,
  },
  subtitle: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.bodyLarge,
    lineHeight: typography.lineHeight.bodyLarge,
    marginBottom: spacing.xl,
  },
  form: {
    gap: spacing.md,
  },
  continue: {
    marginTop: spacing.xl,
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginVertical: spacing.xl,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  dividerText: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.caption,
  },
  switchText: {
    marginTop: spacing.xl,
    textAlign: "center",
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.body,
  },
  switchLink: {
    fontFamily: typography.fontFamily.semibold,
  },
  legal: {
    marginTop: spacing.xl,
    textAlign: "center",
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption + 2,
    paddingHorizontal: spacing.sm,
  },
  legalLink: {
    fontFamily: typography.fontFamily.semibold,
  },
  back: {
    alignSelf: "center",
    marginTop: spacing.md,
    minHeight: 44,
    justifyContent: "center",
  },
  backLabel: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.body,
  },
});
