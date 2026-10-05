import {
  AnimatedTabIcon,
  AnimatedTabLabel,
} from "@/components/design-system/AnimatedTabIcon";
import { ProductTourOverlay } from "@/components/tour/ProductTourOverlay";
import { radius, spacing, touch, typography } from "@/constants/theme";
import { useAlertsBadge } from "@/hooks/useAlertsBadge";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useAuth } from "@/hooks/useAuth";
import { useIsInPictureInPicture } from "@/modules/navigation-pip";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider,
} from "expo-router/react-navigation";
import type { Theme } from "@react-navigation/native";
import { Redirect, Tabs } from "expo-router";
import React from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export const unstable_settings = {
  initialRouteName: "Home",
};

function AlertsTabIcon({
  color,
  focused,
}: {
  color: string;
  focused: boolean;
}) {
  const { hasUnread } = useAlertsBadge();
  const { colors: c } = useAppTheme();

  return (
    <AnimatedTabIcon focused={focused} color={color}>
      {({ color: iconColor, size }) => (
        <View style={styles.iconWrap}>
          <Ionicons
            name={focused ? "notifications" : "notifications-outline"}
            color={iconColor}
            size={size}
          />
          {hasUnread ? (
            <View
              style={[styles.unreadDot, { backgroundColor: c.danger }]}
              accessibilityLabel="Unread notifications"
            />
          ) : null}
        </View>
      )}
    </AnimatedTabIcon>
  );
}

export default function TabsLayout() {
  const { colors: c, elevation: elev, isDark } = useAppTheme();
  const { ready, user } = useAuth();
  const base = isDark ? DarkTheme : DefaultTheme;
  const currentTheme: Theme = {
    dark: base.dark,
    fonts: base.fonts,
    colors: {
      background: c.background,
      card: c.surface,
      text: c.textPrimary,
      border: c.border,
      primary: c.primary,
      notification: String(base.colors.notification),
    },
  };
  const insets = useSafeAreaInsets();
  const floatBottom = Math.max(insets.bottom, spacing.sm);
  const barHeight = touch.tabBarHeight;
  const inPip = useIsInPictureInPicture();

  // Signed-out users should never stay inside the main app shell.
  if (ready && !user) {
    return <Redirect href="/Login" />;
  }

  return (
    <ThemeProvider value={currentTheme}>
      <View style={styles.root}>
        <Tabs
          safeAreaInsets={{ top: 0, right: 0, bottom: 0, left: 0 }}
          screenOptions={{
            headerShown: false,
            tabBarActiveTintColor: c.primary,
            tabBarInactiveTintColor: c.textSecondary,
            tabBarStyle: inPip ? { display: "none" } : {
              position: "absolute",
              left: spacing.md,
              right: spacing.md,
              bottom: floatBottom,
              height: barHeight,
              paddingBottom: 8,
              paddingTop: 8,
              borderRadius: radius.xl,
              backgroundColor: c.surfaceGlass,
              borderTopWidth: 0,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: c.border,
              // Avoid Android's light rectangular elevation wash behind rounded bars.
              ...(isDark
                ? { elevation: 0, shadowOpacity: 0, shadowRadius: 0 }
                : elev.floating),
              overflow: "hidden",
            },
            tabBarItemStyle: {
              paddingVertical: 2,
            },
            tabBarLabelStyle: {
              fontSize: 11,
              fontFamily: typography.fontFamily.semibold,
              marginTop: 2,
            },
            tabBarLabel: ({ focused, children }) => (
              <AnimatedTabLabel focused={focused}>
                {typeof children === "string" ? children : ""}
              </AnimatedTabLabel>
            ),
            tabBarBackground: () => (
              <View style={StyleSheet.absoluteFill}>
                <View
                  style={[
                    StyleSheet.absoluteFill,
                    {
                      backgroundColor: c.surfaceGlass,
                      borderRadius: radius.xl,
                    },
                  ]}
                />
              </View>
            ),
          }}
        >
          <Tabs.Screen
            name="Home"
            options={{
              title: "Home",
              tabBarIcon: ({ color, focused }) => (
                <AnimatedTabIcon focused={focused} color={color}>
                  {({ color: iconColor, size }) => (
                    <MaterialCommunityIcons
                      name={focused ? "home" : "home-outline"}
                      color={iconColor}
                      size={size}
                    />
                  )}
                </AnimatedTabIcon>
              ),
            }}
          />
          <Tabs.Screen
            name="navigate"
            options={{
              title: "Map",
              tabBarIcon: ({ color, focused }) => (
                <AnimatedTabIcon focused={focused} color={color}>
                  {({ color: iconColor, size }) => (
                    <MaterialCommunityIcons
                      name={focused ? "map" : "map-outline"}
                      color={iconColor}
                      size={size}
                    />
                  )}
                </AnimatedTabIcon>
              ),
            }}
          />
          <Tabs.Screen
            name="safewalk"
            options={{
              title: "Safe Walk",
              tabBarIcon: ({ color, focused }) => (
                <AnimatedTabIcon focused={focused} color={color}>
                  {({ color: iconColor, size }) => (
                    <MaterialCommunityIcons
                      name="walk"
                      color={iconColor}
                      size={size}
                    />
                  )}
                </AnimatedTabIcon>
              ),
            }}
          />
          <Tabs.Screen
            name="alerts"
            options={{
              title: "Alerts",
              tabBarIcon: ({ color, focused }) => (
                <AlertsTabIcon color={color} focused={focused} />
              ),
            }}
          />
          <Tabs.Screen
            name="settings"
            options={{
              title: "Profile",
              tabBarIcon: ({ color, focused }) => (
                <AnimatedTabIcon focused={focused} color={color}>
                  {({ color: iconColor, size }) => (
                    <Ionicons
                      name={focused ? "person-circle" : "person-circle-outline"}
                      color={iconColor}
                      size={size}
                    />
                  )}
                </AnimatedTabIcon>
              ),
            }}
          />
          <Tabs.Screen name="SOS" options={{ href: null }} />
          <Tabs.Screen name="contacts" options={{ href: null }} />
        </Tabs>
        {inPip ? null : <ProductTourOverlay />}
      </View>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  iconWrap: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  unreadDot: {
    position: "absolute",
    top: 1,
    right: 1,
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
