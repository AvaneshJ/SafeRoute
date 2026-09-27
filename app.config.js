/**
 * Expo app config. Reads Maps keys from .env at config time.
 * app.json alone cannot expand $EXPO_PUBLIC_* for native Maps.
 */
export default ({ config }) => ({
  ...config,
  name: "SafeRoute",
  slug: "SafeRoute",
  version: "2.0.0",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme: "saferoute",
  userInterfaceStyle: "automatic",
  ios: {
    supportsTablet: true,
    bundleIdentifier: "com.saferoute.app",
    config: {
      googleMapsApiKey: process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY,
    },
  },
  android: {
    package: "com.saferoute.app",
    googleServicesFile: "./google-services.json",
    adaptiveIcon: {
      foregroundImage: "./assets/images/adaptive-icon.png",
      backgroundColor: "#E8F6F3",
    },
    config: {
      googleMaps: {
        apiKey: process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY,
      },
    },
  },
  web: {
    bundler: "metro",
    output: "static",
    favicon: "./assets/images/favicon.png",
  },
  plugins: [
    "expo-router",
    "expo-dev-client",
    [
      "expo-notifications",
      {
        icon: "./assets/images/icon.png",
        color: "#4F46E5",
        defaultChannel: "safety-alerts",
      },
    ],
    "expo-speech-recognition",
    [
      "expo-location",
      {
        locationAlwaysAndWhenInUsePermission:
          "Allow $(PRODUCT_NAME) to use your location during trips and Safe Walk.",
        isAndroidBackgroundLocationEnabled: true,
        isIosBackgroundLocationEnabled: true,
      },
    ],
    [
      "expo-splash-screen",
      {
        image: "./assets/images/splash-icon.png",
        imageWidth: 200,
        resizeMode: "contain",
        backgroundColor: "#E8F6F3",
      },
    ],
    [
      "react-native-maps",
      {
        androidGoogleMapsApiKey: process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY,
        iosGoogleMapsApiKey: process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY,
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    googleDirectionsApiKey: process.env.EXPO_PUBLIC_GOOGLE_DIRECTIONS_API_KEY,
    googlePlacesApiKey: process.env.EXPO_PUBLIC_GOOGLE_PLACES_API_KEY,
    routingApiUrl: process.env.EXPO_PUBLIC_ROUTING_API_URL,
    eas: {
      projectId: "b63c7a11-1b06-4531-a840-da530bac811e",
    },
  },
});
