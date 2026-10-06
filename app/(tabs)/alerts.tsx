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
import { notificationRoute } from "@/services/notifications";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useRouter } from "expo-router";
import { onAuthStateChanged } from "firebase/auth";
import { collection, limit, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
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

const SECTION_LABEL: Record<Exclude<SectionId, "all">, string> = {
  emergency: "Emergency",
  safety: "Safety",
  safewalk: "Safe Walk",
  community: "Community",
};

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
  const [clearing, setClearing] = useState(false);

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
            const route = notificationRoute(type, data.route, data.data?.kind);
            return {
              id: notification.id,
              section: sectionFor(type),
              title: String(data.title ?? "SafeRoute update"),
              body: String(data.body ?? ""),
              timeLabel: timeLabel(data.createdAt),
              tone: toneFor(type),
              unread: !data.readAt,
              // Opening this tab from itself does nothing; treat it as not openable.
              route: route === "/(tabs)/alerts" ? undefined : route,
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

  // The query is already newest-first; filters only narrow it, never regroup it.
  const visibleItems = useMemo(
    () => (filter === "all" ? items : items.filter((i) => i.section === filter)),
    [items, filter],
  );

  const unreadBySection = useMemo(() => {
    const counts: Partial<Record<SectionId, number>> = {};
    for (const item of items) {
      if (item.unread) counts[item.section] = (counts[item.section] ?? 0) + 1;
    }
    return counts;
  }, [items]);

  const clearAll = () => {
    if (items.length === 0) return;
    Alert.alert(
      "Clear all notifications?",
      "This removes every notification from this list. It can't be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear all",
          style: "destructive",
          onPress: async () => {
            const previous = items;
            setClearing(true);
            setItems([]);
            try {
              await httpsCallable(functions, "clearNotifications")({});
            } catch (error) {
              console.warn(error);
              setItems(previous);
              Alert.alert(
                "Couldn't clear notifications",
                "Check your connection and try again.",
              );
            } finally {
              setClearing(false);
            }
          },
        },
      ],
    );
  };

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
    if (!item.route) return;
    if (item.route.startsWith("/(tabs)/")) router.navigate(item.route as never);
    else router.push(item.route as never);
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
          <View style={styles.titleCopy}>
            <Text
              style={[styles.title, { color: c.textPrimary }]}
              accessibilityRole="header"
            >
              Notifications
            </Text>
            <Text style={[styles.subtitle, { color: c.textSecondary }]}>
              {unreadCount > 0 ? `${unreadCount} unread · ` : ""}Newest first
            </Text>
          </View>
          {items.length > 0 ? (
            <View style={styles.headerActions}>
              {unreadCount > 0 ? (
                <Pressable
                  onPress={markAllRead}
                  accessibilityRole="button"
                  accessibilityLabel="Mark all read"
                  hitSlop={6}
                  style={[
                    styles.headerBtn,
                    { backgroundColor: c.surfaceVariant },
                  ]}
                >
                  <MaterialIcons name="done-all" size={16} color={c.primary} />
                  <Text style={[styles.headerBtnText, { color: c.primary }]}>
                    Read
                  </Text>
                </Pressable>
              ) : null}
              <Pressable
                onPress={clearAll}
                disabled={clearing}
                accessibilityRole="button"
                accessibilityLabel="Clear all notifications"
                hitSlop={6}
                style={[
                  styles.headerBtn,
                  { backgroundColor: c.surfaceVariant },
                  clearing && { opacity: 0.5 },
                ]}
              >
                <MaterialIcons
                  name="delete-sweep"
                  size={16}
                  color={c.errorText}
                />
                <Text style={[styles.headerBtnText, { color: c.errorText }]}>
                  Clear all
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filters}
        >
          {FILTERS.map((f) => {
            const active = filter === f.id;
            const unread = f.id === "all" ? unreadCount : unreadBySection[f.id] ?? 0;
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
                  {unread > 0 ? ` · ${unread}` : ""}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <GuardianWatchList />

        {visibleItems.length > 0 ? (
          <View style={styles.list}>
            {visibleItems.map((item, index) => (
              <NotificationCard
                key={item.id}
                eyebrow={filter === "all" ? SECTION_LABEL[item.section] : undefined}
                title={item.title}
                body={item.body}
                timeLabel={item.timeLabel}
                tone={item.tone}
                unread={item.unread}
                openable={item.route != null}
                index={Math.min(index, 8)}
                onPress={() => onOpen(item)}
              />
            ))}
          </View>
        ) : (
          <View style={styles.empty}>
            <View
              style={[styles.emptyIcon, { backgroundColor: c.surfaceVariant }]}
            >
              <MaterialIcons
                name="notifications-none"
                size={28}
                color={c.textTertiary}
              />
            </View>
            <Text style={[styles.emptyTitle, { color: c.textPrimary }]}>
              You&apos;re all caught up
            </Text>
            <Text style={[styles.emptyBody, { color: c.textSecondary }]}>
              {filter === "all"
                ? "New safety alerts and Safe Walk updates will show up here."
                : `No ${SECTION_LABEL[filter].toLowerCase()} notifications right now.`}
            </Text>
          </View>
        )}
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
  titleCopy: {
    flexShrink: 1,
  },
  headerActions: {
    flexDirection: "row",
    gap: spacing.xs,
    marginTop: 4,
  },
  headerBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
  },
  headerBtnText: {
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
  list: {
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  empty: {
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.xs,
  },
  emptyTitle: {
    fontFamily: typography.fontFamily.semibold,
    fontSize: typography.size.bodyLarge,
  },
  emptyBody: {
    fontFamily: typography.fontFamily.regular,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
    textAlign: "center",
  },
});
