import {
  AuthTextField,
  GuardianCard,
  ModalBottomSheet,
  PrimaryButton,
  SecondaryButton,
} from "@/components/design-system";
import {
  radius,
  spacing,
  tabContentBottomInset,
  touch,
  typography,
} from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import { auth, db, functions } from "@/config/firebase";
import {
  GUARDIANS_STORAGE_KEY,
  MAX_GUARDIANS,
  RELATIONSHIP_OPTIONS,
  createGuardianId,
  ensurePrimary,
  normalizeGuardians,
  setPrimaryGuardian,
  sortGuardians,
  type Guardian,
  type GuardianRelationship,
} from "@/core/guardians";
import {
  guardianInviteMessage,
  notifyGuardianSms,
} from "@/services/guardianAlerts";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Image } from "expo-image";
import * as Linking from "expo-linking";
import { onAuthStateChanged } from "firebase/auth";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import React, { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function GuardiansScreen() {
  const insets = useSafeAreaInsets();
  const { colors: c, elevation: elev } = useAppTheme();

  const [guardians, setGuardians] = useState<Guardian[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [relationship, setRelationship] =
    useState<GuardianRelationship>("Friend");
  const [nameError, setNameError] = useState("");
  const [phoneError, setPhoneError] = useState("");

  const load = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(GUARDIANS_STORAGE_KEY);
      const list = ensurePrimary(
        normalizeGuardians(raw ? JSON.parse(raw) : []),
      );
      setGuardians(sortGuardians(list));
    } catch (error) {
      console.error("Failed to load guardians", error);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const persist = async (next: Guardian[]) => {
    const sorted = sortGuardians(ensurePrimary(next));
    setGuardians(sorted);
    await AsyncStorage.setItem(GUARDIANS_STORAGE_KEY, JSON.stringify(sorted));
  };

  const resetForm = () => {
    setName("");
    setPhone("");
    setRelationship("Friend");
    setNameError("");
    setPhoneError("");
  };

  const openSheet = () => {
    if (guardians.length >= MAX_GUARDIANS) {
      Alert.alert(
        "Guardian limit reached",
        `You can add up to ${MAX_GUARDIANS} trusted guardians. Remove one to invite someone new.`,
      );
      return;
    }
    resetForm();
    setSheetOpen(true);
  };

  const sendInvite = async (g: Guardian, inviteUrl?: string) => {
    const body = guardianInviteMessage({ guardianName: g.name, inviteUrl });
    // Prefer native SMS to the guardian's number; Share is the fallback.
    const result = await notifyGuardianSms(g.phone, body);
    if (result.opened) return;
    try {
      await Promise.race([
        Share.share({ message: body }),
        new Promise<void>((resolve) => setTimeout(resolve, 1200)),
      ]);
    } catch {
      // User dismissed share sheet
    }
  };

  useEffect(() => {
    let stopConnections: (() => void) | undefined;
    const stopAuth = onAuthStateChanged(auth, (user) => {
      stopConnections?.();
      if (!user) return;
      stopConnections = onSnapshot(
        query(collection(db, "guardians"), where("userId", "==", user.uid)),
        (snapshot) => {
          const connections = new Map(
            snapshot.docs.map((item) => [item.id, item.data()]),
          );
          setGuardians((current) => {
            const next = current.map((guardian) => {
              const connection = guardian.connectionId
                ? connections.get(guardian.connectionId)
                : undefined;
              if (!connection) return guardian;
              const status = connection.status as Guardian["connectionStatus"];
              return {
                ...guardian,
                verified: status === "accepted",
                connectionStatus: status,
                guardianUserId:
                  typeof connection.guardianUserId === "string"
                    ? connection.guardianUserId
                    : undefined,
              };
            });
            void AsyncStorage.setItem(
              GUARDIANS_STORAGE_KEY,
              JSON.stringify(next),
            );
            return sortGuardians(next);
          });
        },
      );
    });
    return () => {
      stopAuth();
      stopConnections?.();
    };
  }, []);

  const handleSaveInvite = async () => {
    let ok = true;
    if (!name.trim() || name.trim().length < 2) {
      setNameError("Enter their name");
      ok = false;
    } else setNameError("");

    const digits = phone.replace(/\D/g, "");
    if (digits.length !== 10) {
      setPhoneError("Enter a valid 10-digit mobile number");
      ok = false;
    } else setPhoneError("");

    if (!ok) return;

    if (guardians.some((g) => g.phone === digits)) {
      Alert.alert("Already added", "This number is already a guardian.");
      return;
    }

    setSaving(true);
    try {
      const isFirst = guardians.length === 0;
      let newbie: Guardian = {
        id: createGuardianId(),
        name: name.trim(),
        phone: digits,
        relationship,
        verified: false,
        isPrimary: isFirst,
        connectionStatus: "pending",
      };
      let inviteUrl: string | undefined;
      try {
        const result = await httpsCallable<
          {
            displayName: string;
            phone: string;
            relationship: GuardianRelationship;
            isPrimary: boolean;
          },
          {
            connectionId?: string;
            inviteId: string;
            token?: string;
            inviteToken: string;
            inviteUrl?: string;
          }
        >(functions, "createGuardianInvite")({
          displayName: newbie.name,
          phone: newbie.phone,
          relationship: newbie.relationship,
          isPrimary: newbie.isPrimary,
        });
        const inviteId = result.data.inviteId;
        const inviteToken = result.data.inviteToken ?? result.data.token ?? "";
        inviteUrl =
          result.data.inviteUrl ??
          Linking.createURL("/GuardianInvite", {
            queryParams: { inviteId, token: inviteToken },
          });
        newbie = {
          ...newbie,
          connectionId: result.data.connectionId ?? result.data.inviteId,
        };
      } catch (error) {
        console.warn("Created local SMS-only guardian; invite backend unavailable.", error);
      }
      const next = isFirst
        ? [newbie]
        : [...guardians.map((g) => ({ ...g, isPrimary: g.isPrimary })), newbie];
      await persist(next);
      setSheetOpen(false);
      resetForm();
      await sendInvite(newbie, inviteUrl);
      Alert.alert(
        "Invite ready",
        `${newbie.name} is pending until they accept the SafeRoute invite. SMS fallback remains available.`,
      );
    } finally {
      setSaving(false);
    }
  };

  const onTogglePrimary = async (id: string, value: boolean) => {
    if (!value) {
      Alert.alert(
        "Keep one primary",
        "Choose another guardian as Primary instead of turning this off.",
      );
      return;
    }
    await persist(setPrimaryGuardian(guardians, id));
  };

  const onRemove = (guardian: Guardian) => {
    Alert.alert(
      "Remove guardian?",
      `${guardian.name} will no longer receive Safe Walk or SOS alerts from you.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            if (guardian.connectionId) {
              void httpsCallable(functions, "revokeGuardian")({
                guardianId: guardian.connectionId,
              }).catch(console.warn);
            }
            const next = guardians.filter((g) => g.id !== guardian.id);
            await persist(ensurePrimary(next));
          },
        },
      ],
    );
  };

  const onCall = (guardian: Guardian) => {
    void Linking.openURL(`tel:${guardian.phone}`);
  };

  const onResend = async (guardian: Guardian) => {
    try {
      const result = await httpsCallable<
        {
          connectionId?: string;
          displayName: string;
          phone: string;
          relationship: string;
        },
        {
          connectionId?: string;
          inviteId: string;
          token?: string;
          inviteToken: string;
          inviteUrl?: string;
        }
      >(functions, "createGuardianInvite")({
        connectionId: guardian.connectionId,
        displayName: guardian.name,
        phone: guardian.phone,
        relationship: guardian.relationship,
      });
      const inviteId = result.data.inviteId;
      const inviteToken = result.data.inviteToken ?? result.data.token ?? "";
      const inviteUrl =
        result.data.inviteUrl ??
        Linking.createURL("/GuardianInvite", {
          queryParams: { inviteId, token: inviteToken },
        });
      await sendInvite(guardian, inviteUrl);
    } catch {
      await sendInvite(guardian);
    }
  };

  const atCapacity = guardians.length >= MAX_GUARDIANS;
  const empty = guardians.length === 0;

  return (
    <View
      style={[
        styles.root,
        {
          paddingTop: Math.max(insets.top, spacing.md),
          backgroundColor: c.background,
        },
      ]}
    >
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          {
            paddingBottom:
              tabContentBottomInset(insets.bottom) +
              touch.buttonHeight +
              spacing.lg,
          },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <Text
          style={[styles.title, { color: c.textPrimary }]}
          accessibilityRole="header"
        >
          Trusted Guardians
        </Text>
        <Text style={[styles.subtitle, { color: c.textSecondary }]}>
          People who can follow your Safe Walk and receive SOS if you need help.
          Add up to {MAX_GUARDIANS}.
        </Text>

        <View style={[styles.counter, { backgroundColor: c.primaryContainer }]}>
          <Text style={[styles.counterText, { color: c.primaryOnContainer }]}>
            {guardians.length} of {MAX_GUARDIANS} guardians
          </Text>
          {guardians.some((g) => g.isPrimary) ? (
            <Text
              style={[styles.counterPrimary, { color: c.primaryOnContainer }]}
            >
              Primary: {guardians.find((g) => g.isPrimary)?.name}
            </Text>
          ) : null}
        </View>

        {empty ? (
          <View style={styles.empty} accessibilityLabel="No guardians yet">
            <Image
              source={require("../../assets/images/guardians-empty.png")}
              style={styles.emptyArt}
              contentFit="contain"
            />
            <Text style={[styles.emptyTitle, { color: c.textPrimary }]}>
              No guardians yet
            </Text>
            <Text style={[styles.emptyBody, { color: c.textSecondary }]}>
              Invite someone you trust. Your Primary Guardian is notified first
              during Safe Walk and SOS.
            </Text>
          </View>
        ) : (
          <View style={styles.list}>
            {guardians.map((g) => (
              <GuardianCard
                key={g.id}
                guardian={g}
                onTogglePrimary={onTogglePrimary}
                onCall={onCall}
                onRemove={onRemove}
                onMarkVerified={
                  undefined
                }
                onResendInvite={g.verified ? undefined : onResend}
              />
            ))}
          </View>
        )}
      </ScrollView>

      <View
        style={[
          styles.footer,
          {
            paddingBottom: tabContentBottomInset(insets.bottom),
            backgroundColor: c.background,
            borderTopColor: c.border,
            ...elev.sheet,
          },
        ]}
      >
        <PrimaryButton
          label="Invite Guardian"
          onPress={openSheet}
          disabled={atCapacity}
          accessibilityHint={
            atCapacity
              ? "Maximum of five guardians reached"
              : "Open form to invite a guardian"
          }
        />
      </View>

      <ModalBottomSheet
        visible={sheetOpen}
        onClose={() => {
          setSheetOpen(false);
          resetForm();
        }}
        title="Invite Guardian"
        heightRatio={0.72}
        scrollable={false}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.sheetBody}
        >
          <Text style={[styles.sheetHint, { color: c.textSecondary }]}>
            We’ll help you share an invite. They stay Pending until confirmed.
          </Text>

          <AuthTextField
            label="Name"
            value={name}
            onChangeText={(t) => {
              setName(t);
              setNameError("");
            }}
            status={nameError ? "error" : "default"}
            helperText={nameError}
            leadingIcon="person-outline"
            autoCapitalize="words"
            textContentType="name"
          />

          <AuthTextField
            label="Phone"
            value={phone}
            onChangeText={(t) => {
              setPhone(t.replace(/\D/g, "").slice(0, 10));
              setPhoneError("");
            }}
            status={phoneError ? "error" : "default"}
            helperText={phoneError || "10-digit mobile number"}
            leadingIcon="phone-iphone"
            keyboardType="phone-pad"
            textContentType="telephoneNumber"
          />

          <Text style={[styles.relLabel, { color: c.textPrimary }]}>
            Relationship
          </Text>
          <View style={styles.relChips}>
            {RELATIONSHIP_OPTIONS.map((option) => {
              const selected = option === relationship;
              return (
                <Pressable
                  key={option}
                  onPress={() => setRelationship(option)}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: c.surfaceVariant,
                      borderColor: c.border,
                    },
                    selected && {
                      backgroundColor: c.primaryContainer,
                      borderColor: c.primary,
                    },
                  ]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                >
                  <Text
                    style={[
                      styles.chipLabel,
                      { color: c.textSecondary },
                      selected && {
                        color: c.primary,
                        fontFamily: typography.fontFamily.semibold,
                      },
                    ]}
                  >
                    {option}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <PrimaryButton
            label="Send Invite"
            loading={saving}
            onPress={handleSaveInvite}
            style={styles.sheetCta}
          />
          <SecondaryButton
            label="Cancel"
            onPress={() => {
              setSheetOpen(false);
              resetForm();
            }}
          />
        </ScrollView>
      </ModalBottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  scroll: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  title: {
    fontFamily: typography.fontFamily.bold,
    fontSize: typography.size.headline,
    lineHeight: typography.lineHeight.headline,
    letterSpacing: -0.3,
  },
  subtitle: {
    marginTop: spacing.sm,
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.bodyLarge,
    lineHeight: typography.lineHeight.bodyLarge,
  },
  counter: {
    marginTop: spacing.md,
    marginBottom: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.xl,
    gap: 2,
  },
  counterText: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.body,
  },
  counterPrimary: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.caption,
  },
  list: {
    gap: spacing.md,
  },
  empty: {
    alignItems: "center",
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.md,
  },
  emptyArt: {
    width: 200,
    height: 200,
    marginBottom: spacing.md,
  },
  emptyTitle: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.title,
    marginBottom: spacing.sm,
  },
  emptyBody: {
    textAlign: "center",
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sheetBody: {
    gap: spacing.sm,
    paddingBottom: spacing.lg,
  },
  sheetHint: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.body,
    marginBottom: spacing.sm,
  },
  relLabel: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.body,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  relChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  chipLabel: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.caption,
  },
  sheetCta: {
    marginTop: spacing.sm,
  },
});
