import {
  NotificationCard,
  type NotificationTone,
} from "@/components/design-system";
import {
  radius,
  spacing,
  tabContentBottomInset,
  typography,
} from "@/constants/theme";
import { GuardianWatchList } from "@/components/guardian/GuardianWatchList";
import { useAlertsBadge } from "@/hooks/useAlertsBadge";
import { useAppTheme } from "@/hooks/useAppTheme";
import { auth, db, functions } from "@/config/firebase";
import { useRouter } from "expo-router";
import { onAuthStateChanged } from "firebase/auth";
import { collection, limit, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import React, { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type SectionId = "emergency" | "safety" | "safewalk" | "community" | "all";

type Notif = {
  id: string;
  section: Exclude<SectionId, "all">;
  title: string;
  body: string;
  timeLabel: string;
  tone: NotificationTone;
  unread: boolean;
  ctaLabel: string;
  route?: string;
};

const INITIAL: Notif[] = [];

function sectionFor(type: string): Exclude<SectionId, "all"> {
  if (type.includes("sos") || type.includes("emergency")) return "emergency";
  if (type.startsWith("safety_") || type.includes("walk") || type.includes("live_share")) {
    return "safewalk";
  }
  if (type.includes("arriv") || type.includes("checkin")) return "safewalk";
  if (type.includes("report") || type.includes("community")) return "community";
  return "safety";
}

function toneFor(type: string): NotificationTone {
  if (type.includes("resolved")) return "success";
  if (type.includes("sos") || type.includes("failed")) return "danger";
  if (type.includes("arriv") || type.includes("accepted") || type.includes("acknowledged")) {
    return "success";
  }
  if (type.includes("checkin") || type.includes("invite")) return "warning";
  return "info";
}

function timeLabel(value: unknown): string {
  const millis = (value as { toMillis?: () => number } | null)?.toMillis?.();
  if (!millis) return "Just now";
  const minutes = Math.max(0, Math.round((Date.now() - millis) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

const SECTIONS: {
  id: Exclude<SectionId, "all">;
  label: string;
}[] = [
  { id: "emergency", label: "Emergency" },
  { id: "safety", label: "Safety alerts" },
  { id: "safewalk", label: "Safe Walk updates" },
  { id: "community", label: "Community updates" },
];

const FILTERS: { id: SectionId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "emergency", label: "Emergency" },
  { id: "safety", label: "Safety" },
  { id: "safewalk", label: "Walk" },
  { id: "community", label: "Community" },
];

export default function AlertsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { colors: c } = useAppTheme();
  const { setUnreadCount } = useAlertsBadge();
  const [items, setItems] = useState(INITIAL);
  const [filter, setFilter] = useState<SectionId>("all");

  const unreadCount = items.filter((i) => i.unread).length;

  useEffect(() => {
    setUnreadCount(unreadCount);
  }, [unreadCount, setUnreadCount]);

  useEffect(() => {
    let stopSnapshot: (() => void) | undefined;
    const stopAuth = onAuthStateChanged(auth, (user) => {
      stopSnapshot?.();
      if (!user) {
        setItems([]);
        return;
      }
      const feed = query(
        collection(db, "notifications"),
        where("userId", "==", user.uid),
        orderBy("createdAt", "desc"),
        limit(100),
      );
      stopSnapshot = onSnapshot(feed, (snapshot) => {
        setItems(
          snapshot.docs.map((notification) => {
            const data = notification.data();
            const type = String(data.type ?? "safety");
            return {
              id: notification.id,
              section: sectionFor(type),
              title: String(data.title ?? "SafeRoute update"),
              body: String(data.body ?? ""),
              timeLabel: timeLabel(data.createdAt),
              tone: toneFor(type),
              unread: !data.readAt,
              ctaLabel: String(data.ctaLabel ?? "Open"),
              route: typeof data.route === "string" ? data.route : undefined,
            };
          }),
        );
      });
    });
    return () => {
      stopAuth();
      stopSnapshot?.();
    };
  }, []);

  const visibleSections = useMemo(() => {
    if (filter === "all") return SECTIONS;
    return SECTIONS.filter((s) => s.id === filter);
  }, [filter]);

  const markAllRead = () => {
    const ids = items.filter((item) => item.unread).map((item) => item.id);
    setItems((prev) => prev.map((i) => ({ ...i, unread: false })));
    ids.forEach((notificationId) => {
      void httpsCallable(functions, "markNotificationRead")({
        notificationId,
      }).catch(console.warn);
    });
  };

  const onOpen = (item: Notif) => {
    setItems((prev) =>
      prev.map((i) => (i.id === item.id ? { ...i, unread: false } : i)),
    );
    if (item.unread) {
      void httpsCallable(functions, "markNotificationRead")({
        notificationId: item.id,
      }).catch(console.warn);
    }
    if (item.route) router.push(item.route as never);
  };

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
          { paddingBottom: tabContentBottomInset(insets.bottom) },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.titleRow}>
          <View>
            <Text
              style={[styles.title, { color: c.textPrimary }]}
              accessibilityRole="header"
            >
              Notifications
            </Text>
            <Text style={[styles.subtitle, { color: c.textSecondary }]}>
              {unreadCount} unread · sorted by urgency
            </Text>
          </View>
          <Pressable
            onPress={markAllRead}
            accessibilityRole="button"
            style={[styles.markRead, { backgroundColor: c.surfaceVariant }]}
          >
            <Text style={[styles.markReadText, { color: c.primary }]}>
              Mark all read
            </Text>
          </Pressable>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filters}
        >
          {FILTERS.map((f) => {
            const active = filter === f.id;
            return (
              <Pressable
                key={f.id}
                onPress={() => setFilter(f.id)}
                style={[
                  styles.chip,
                  { backgroundColor: c.surfaceVariant },
                  active && { backgroundColor: c.primaryContainer },
                ]}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <Text
                  style={[
                    styles.chipText,
                    { color: c.textSecondary },
                    active && {
                      color: c.primaryOnContainer,
                      fontFamily: typography.fontFamily.semibold,
                    },
                  ]}
                >
                  {f.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <GuardianWatchList />

        {visibleSections.map((section) => {
          const sectionItems = items.filter((i) => i.section === section.id);
          if (sectionItems.length === 0) return null;
          const sectionUnread = sectionItems.filter((i) => i.unread).length;
          return (
            <View key={section.id} style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={[styles.sectionTitle, { color: c.textPrimary }]}>
                  {section.label}
                </Text>
                {sectionUnread > 0 ? (
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
                      {sectionUnread} new
                    </Text>
                  </View>
                ) : null}
              </View>
              <View style={styles.list}>
                {sectionItems.map((item) => (
                  <View key={item.id} style={styles.cardWrap}>
                    <NotificationCard
                      title={item.title}
                      body={item.body}
                      timeLabel={item.timeLabel}
                      tone={item.tone}
                      unread={item.unread}
                      index={sectionItems.indexOf(item)}
                      onPress={() => onOpen(item)}
                    />
                    <Pressable
                      onPress={() => onOpen(item)}
                      style={[
                        styles.cta,
                        {
                          borderColor: c.border,
                          backgroundColor: c.surface,
                        },
                        (item.tone === "danger" || item.tone === "warning") && {
                          backgroundColor: c.primary,
                          borderColor: c.primary,
                        },
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={item.ctaLabel}
                    >
                      <Text
                        style={[
                          styles.ctaText,
                          { color: c.textPrimary },
                          (item.tone === "danger" ||
                            item.tone === "warning") && {
                            color: c.textOnPrimary,
                          },
                        ]}
                      >
                        {item.ctaLabel}
                      </Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            </View>
          );
        })}
      </ScrollView>
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
  titleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: spacing.md,
  },
  title: {
    fontFamily: typography.fontFamily.bold,
    fontSize: typography.size.headline,
  },
  subtitle: {
    marginTop: 4,
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.body,
  },
  markRead: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
  },
  markReadText: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.caption,
  },
  filters: {
    gap: spacing.sm,
    paddingBottom: spacing.md,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  chipText: {
    fontFamily: typography.fontFamily.medium,
    fontSize: typography.size.caption,
  },
  section: {
    marginBottom: spacing.lg,
    gap: spacing.sm,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  sectionTitle: {
    fontFamily: typography.fontFamily.bold,
    fontSize: typography.size.title,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  badgeText: {
    fontFamily: typography.fontFamily.medium,
    fontSize: 11,
  },
  list: {
    gap: spacing.sm,
  },
  cardWrap: {
    gap: spacing.sm,
  },
  cta: {
    alignSelf: "flex-end",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    minHeight: 40,
    justifyContent: "center",
  },
  ctaText: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.caption,
  },
});
