import { paperThemeFor } from "@/constants/paperTheme";
import { darkColors, lightColors } from "@/constants/theme";
import { AlertsBadgeProvider } from "@/hooks/useAlertsBadge";
import { AppearanceProvider, useAppearance } from "@/hooks/useAppearance";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import { useNotificationBootstrap } from "@/hooks/useNotificationBootstrap";
import { ProductTourProvider } from "@/hooks/useProductTour";
import "@/tasks/locationTracking";
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter";
import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider,
} from "expo-router/react-navigation";
import type { Theme } from "@react-navigation/native";
import { useFonts } from "expo-font";
import { SplashScreen, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { Provider as PaperProvider } from "react-native-paper";
import { SafeAreaProvider } from "react-native-safe-area-context";

SplashScreen.preventAutoHideAsync();

function RootNavigator() {
  const { scheme } = useAppearance();
  const { ready: authReady } = useAuth();
  useNotificationBootstrap();
  const [fontsLoaded, error] = useFonts({
    "Roboto-Mono": require("../assets/fonts/SpaceMono-Regular.ttf"),
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (error) throw error;
    if (fontsLoaded && authReady) SplashScreen.hideAsync();
  }, [fontsLoaded, authReady, error]);

  if (!fontsLoaded || !authReady) {
    return null;
  }

  const isDark = scheme === "dark";
  const canvas = isDark ? darkColors.background : lightColors.background;
  const base = isDark ? DarkTheme : DefaultTheme;
  const navTheme: Theme = {
    dark: base.dark,
    fonts: base.fonts,
    colors: {
      background: canvas,
      card: isDark ? darkColors.surface : lightColors.surface,
      text: isDark ? darkColors.textPrimary : lightColors.textPrimary,
      border: isDark ? darkColors.border : lightColors.border,
      primary: isDark ? darkColors.primary : lightColors.primary,
      notification: String(base.colors.notification),
    },
  };

  return (
    <PaperProvider theme={paperThemeFor(scheme)}>
      <SafeAreaProvider>
        <StatusBar style={isDark ? "light" : "dark"} />
        <ThemeProvider value={navTheme}>
          <ProductTourProvider>
            <Stack
              screenOptions={{
                animation: "fade_from_bottom",
                animationDuration: 220,
                contentStyle: {
                  backgroundColor: canvas,
                },
              }}
            >
              <Stack.Screen name="index" options={{ headerShown: false }} />
              <Stack.Screen
                name="Onboarding"
                options={{ headerShown: false }}
              />
              <Stack.Screen
                name="Permissions"
                options={{ headerShown: false }}
              />
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="Login" options={{ headerShown: false }} />
              <Stack.Screen name="Signup" options={{ headerShown: false }} />
              <Stack.Screen
                name="GuardianInvite"
                options={{ headerShown: false, presentation: "modal" }}
              />
              <Stack.Screen
                name="LiveWalkViewer"
                options={{
                  headerShown: false,
                  presentation: "fullScreenModal",
                }}
              />
              <Stack.Screen
                name="LiveLocationShareScreen"
                options={{ headerShown: false, presentation: "modal" }}
              />
              <Stack.Screen
                name="LiveNavigation"
                options={{
                  headerShown: false,
                  presentation: "fullScreenModal",
                }}
              />
              <Stack.Screen
                name="RouteComparison"
                options={{
                  headerShown: false,
                  presentation: "fullScreenModal",
                }}
              />
              <Stack.Screen
                name="SavedPlacesScreen"
                options={{ title: "Saved Places" }}
              />
              <Stack.Screen
                name="CommunityReport"
                options={{ headerShown: false, presentation: "modal" }}
              />
              <Stack.Screen
                name="SafeWalkLive"
                options={{
                  headerShown: false,
                  presentation: "fullScreenModal",
                }}
              />
              <Stack.Screen
                name="SafeWalkGuardian"
                options={{
                  headerShown: false,
                  presentation: "card",
                }}
              />
              <Stack.Screen
                name="SafeWalkReview"
                options={{
                  headerShown: false,
                  presentation: "card",
                }}
              />
            </Stack>
          </ProductTourProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </PaperProvider>
  );
}

export default function RootLayout() {
  return (
    <AppearanceProvider>
      <AuthProvider>
        <AlertsBadgeProvider>
          <RootNavigator />
        </AlertsBadgeProvider>
      </AuthProvider>
    </AppearanceProvider>
  );
}
