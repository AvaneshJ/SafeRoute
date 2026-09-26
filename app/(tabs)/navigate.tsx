// SafeMaps.js (Main Application Component)

import AsyncStorage from "@react-native-async-storage/async-storage"; // Import AsyncStorage for saving locations
import {
  useFocusEffect,
  useNavigation,
  useRoute,
} from "expo-router/react-navigation";
import Constants from "expo-constants";
import * as Linking from "expo-linking";
import * as Location from "expo-location";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Animated, Share, StatusBar, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

// Import all custom components
import { heatColor } from "../../core/heatmap";
import { planCandidateRoutes } from "../../core/routeOptimization";
import {
  calculateSafetyScore,
  legacySafetyLabel,
} from "../../core/safetyScore";
import { MapTripSheet } from "../../components/maps/MapTripSheet";
import DirectionsModal from "../../components/maps/DirectionModal";
import LoadingOverlay from "../../components/maps/LoadingOverlay";
import LongPressInstruction from "../../components/maps/LongPressInstruction";
import MapDisplay from "../../components/maps/MapDisplay";
import { LiveNavigationHUD } from "../../components/navigation/LiveNavigationHUD";
import {
  GUARDIANS_STORAGE_KEY,
  createGuardianId,
  normalizeGuardians,
  type Guardian,
} from "../../core/guardians";
import NearestPlaceConfirmationModal from "../../components/maps/NearestPlaceConfirmationModal";
import SafetyReviewModal from "../../components/maps/SafetyReviewModal";
import SearchBar from "../../components/maps/SearchBar";
import { mapNavigateRoutesToComparison } from "../../components/route/mapNavigateRoutes";
import {
  mapGoogleStepToNavStep,
  updateLiveNavigation,
  type LiveNavSnapshot,
  type NavStep,
} from "../../core/liveNavigation";
import {
  buildReviewDetailPins,
  buildSafetyHeatLayer,
} from "../../core/reviewMapLayer";

// Import global styles
import { GlobalStyles } from "../../constants/GlobalStyles";
import { useAppTheme } from "@/hooks/useAppTheme";
import { functions, auth } from "@/config/firebase";
import { httpsCallable } from "firebase/functions";
import {
  publishSafetyLocation,
  startSafetyTracking,
  stopSafetyTracking,
} from "@/services/safetyTracking";
import {
  ROUTE_KIND_COLORS,
  ROUTE_KIND_LABELS,
  fetchSafeRoutes,
  polylineToNavSteps,
} from "@/services/safeRouteApi";
import { submitCommunityReport, ratingToSeverity } from "@/services/communityIntelligence";
import { fetchNearbyCommunityReports } from "@/services/communityReports";
import {
  mapsLink,
  notifyGuardianSms,
} from "@/services/guardianAlerts";

// --- Interface Definitions for better type safety (if using TypeScript) ---
interface Coordinate {
  latitude: number;
  longitude: number;
}

interface SearchResult {
  id: string;
  title: string;
  coordinate: Coordinate;
  subtitle: string;
}

interface SafetyReview {
  id: number;
  latitude: number;
  longitude: number;
  rating: number;
  comment: string;
  category: string;
  timestamp: number;
  userId: string;
}

interface DangerousArea {
  latitude: number;
  longitude: number;
  radius: number;
  severity: number;
}

interface RouteDraft {
  id: string;
  coordinates: Coordinate[];
  distance: number;
  duration: number;
  description: string;
  directions: any[];
}

interface RouteInfo extends RouteDraft {
  safety: any;
  color: string;
  title: string;
  mode?: "safest" | "balanced" | "fastest";
}

const SafeMaps = () => {
  // --- Navigation Hooks ---
  const route = useRoute() as { params?: Record<string, any> };
  const navigation = useNavigation() as {
    navigate: (name: string, params?: object) => void;
    setParams: (params: object) => void;
  };
  const { colors: themeColors, isDark } = useAppTheme();
  const { showPoliceStations, showHospitals } = route.params || {};

  // --- State for Location and Map ---
  const [location, setLocation] = useState<Location.LocationObject | null>(
    null,
  );
  const [isLocationReady, setIsLocationReady] = useState<boolean>(false); // NEW: Track if location is ready
  const [mapRegion, setMapRegion] = useState<any>(null); // Map's visible region
  const mapRef = useRef<any>(null); // Reference to MapView component
  const [currentRegionName, setCurrentRegionName] = useState<string | null>(
    null,
  ); // Current city/region name

  // NEW: State for location watcher subscription
  const [locationWatcher, setLocationWatcher] =
    useState<Location.LocationSubscription | null>(null);

  // --- State for Search Functionality ---
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [showSearchResults, setShowSearchResults] = useState<boolean>(false);
  const [selectedLocation, setSelectedLocation] = useState<SearchResult | null>(
    null,
  );

  // --- State for Route and Navigation ---
  const [routeCoordinates, setRouteCoordinates] = useState<Coordinate[]>([]);
  const [routeInfo, setRouteInfo] = useState<RouteInfo | null>(null);
  const [routeOptions, setRouteOptions] = useState<any[]>([]); // Array of potential routes
  const [selectedRouteIndex, setSelectedRouteIndex] = useState<number>(0);
  const [isCalculatingRoute, setIsCalculatingRoute] = useState<boolean>(false);
  const [isNavigationMode, setIsNavigationMode] = useState<boolean>(false);
  const [directions, setDirections] = useState<NavStep[]>([]); // Turn-by-turn steps
  const [showDirectionsModal, setShowDirectionsModal] =
    useState<boolean>(false);
  const [primaryGuardian, setPrimaryGuardian] = useState<Guardian | null>(null);
  const [guardianConnected, setGuardianConnected] = useState(false);
  const router = useRouter();

  /** Live GMaps-style navigation progress (updated by GPS watcher). */
  const [liveNav, setLiveNav] = useState<LiveNavSnapshot | null>(null);
  const navStepIndexRef = useRef(0);
  const routeCoordsRef = useRef<Coordinate[]>([]);
  const navStepsRef = useRef<NavStep[]>([]);
  const routeMetaRef = useRef({ durationMin: 0, distanceKm: 0 });
  const arrivedAlertedRef = useRef(false);
  const navShareSessionRef = useRef("");
  const navShareUploadAtRef = useRef(0);

  // NEW: State to hold navigation params for a pending route calculation
  const [pendingNavigationRoute, setPendingNavigationRoute] = useState<
    any | null
  >(null);

  // --- State for Safety Features ---
  const [safetyReviews, setSafetyReviews] = useState<SafetyReview[]>([]);
  const [dangerousAreas, setDangerousAreas] = useState<DangerousArea[]>([]);
  const [safeRouteOnly, setSafeRouteOnly] = useState<boolean>(true); // Toggle for prioritizing safe routes
  const [showReviewModal, setShowReviewModal] = useState<boolean>(false);
  const [reviewLocation, setReviewLocation] = useState<Coordinate | null>(null);
  const [reviewPlaceLabel, setReviewPlaceLabel] = useState<string | null>(null);
  const [reviewPlaceSubtitle, setReviewPlaceSubtitle] = useState<string | null>(
    null,
  );

  // --- State for UI Overlays ---
  const [showLongPressInstruction, setShowLongPressInstruction] =
    useState<boolean>(false);
  const longPressTipShownRef = useRef(false);

  const LONG_PRESS_TIP_KEY = "@SafeRoute:longPressTipSeen";

  const dismissLongPressTip = useCallback(async () => {
    setShowLongPressInstruction(false);
    longPressTipShownRef.current = true;
    try {
      await AsyncStorage.setItem(LONG_PRESS_TIP_KEY, "true");
    } catch {
      // ignore persistence failures
    }
  }, []);

  // --- State for Nearby Places (Police/Hospital) ---
  const [nearbyPoliceStations, setNearbyPoliceStations] = useState<
    SearchResult[]
  >([]);
  const [nearbyHospitals, setNearbyHospitals] = useState<SearchResult[]>([]);
  const [isLoadingNearby, setIsLoadingNearby] = useState<boolean>(false);

  // --- State for Nearest Place Confirmation Modal ---
  const [nearestPlaceDetails, setNearestPlaceDetails] = useState<any>(null);
  const [showNearestPlaceModal, setShowNearestPlaceModal] =
    useState<boolean>(false);

  // --- Animation for Bottom Sheet ---
  const bottomSheetAnim = useRef(new Animated.Value(0)).current;
  const [showBottomSheet, setShowBottomSheet] = useState<boolean>(false);

  // --- API Keys ---
  const GOOGLE_PLACES_API_KEY =
    process.env.EXPO_PUBLIC_GOOGLE_PLACES_API_KEY ||
    Constants.expoConfig?.extra?.googlePlacesApiKey ||
    Constants.expoConfig?.android?.config?.googleMaps?.apiKey ||
    Constants.expoConfig?.ios?.config?.googleMapsApiKey;

  const GOOGLE_DIRECTIONS_API_KEY =
    process.env.EXPO_PUBLIC_GOOGLE_DIRECTIONS_API_KEY ||
    Constants.expoConfig?.extra?.googleDirectionsApiKey ||
    Constants.expoConfig?.android?.config?.googleMaps?.apiKey ||
    Constants.expoConfig?.ios?.config?.googleMapsApiKey;

  // --- Effects ---

  /**
   * Phase 5: load community reports for the heat map.
   * Prefers Firestore reports near the user; falls back to Mumbai seed samples.
   */
  const loadSafetyData = useCallback(async (coords?: Coordinate | null) => {
    const mumbaiSeed: SafetyReview[] = [
      {
        id: 1,
        latitude: 19.1195,
        longitude: 72.8465,
        rating: 2,
        comment: "Poor street lighting after 9pm",
        category: "lighting",
        timestamp: Date.now() - 86400000 * 2,
        userId: "community",
      },
      {
        id: 2,
        latitude: 19.1188,
        longitude: 72.8472,
        rating: 1,
        comment: "Verbal harassment near junction",
        category: "harassment",
        timestamp: Date.now() - 86400000 * 5,
        userId: "community",
      },
      {
        id: 3,
        latitude: 19.0901,
        longitude: 72.8368,
        rating: 2,
        comment: "Phone snatching reported",
        category: "crime",
        timestamp: Date.now() - 86400000 * 10,
        userId: "community",
      },
      {
        id: 4,
        latitude: 19.0598,
        longitude: 72.8292,
        rating: 3,
        comment: "Dim stretch near station approach",
        category: "lighting",
        timestamp: Date.now() - 86400000,
        userId: "community",
      },
      {
        id: 5,
        latitude: 19.0175,
        longitude: 72.8475,
        rating: 2,
        comment: "Unsafe after dark — multiple reports",
        category: "crime",
        timestamp: Date.now() - 86400000 * 3,
        userId: "community",
      },
    ];

    let reviews = mumbaiSeed;
    if (coords) {
      const remote = await fetchNearbyCommunityReports(
        coords.latitude,
        coords.longitude,
      );
      if (remote.length > 0) {
        reviews = remote.map((r, i) => ({
          id: i + 1,
          latitude: r.latitude,
          longitude: r.longitude,
          rating: r.rating,
          comment: r.comment,
          category: r.category,
          timestamp: r.timestamp,
          userId: r.userId,
        }));
      }
    }

    setSafetyReviews(reviews);
    setDangerousAreas(
      reviews
        .filter((review) => review.rating <= 2)
        .map((review) => ({
          latitude: review.latitude,
          longitude: review.longitude,
          radius: 500,
          severity: review.rating,
        })),
    );
  }, []);

  // Initial location and safety data load on component mount
  useEffect(() => {
    getCurrentLocation();
    void loadSafetyData(null);
  }, [loadSafetyData]);

  // Refresh community heat when GPS is ready
  useEffect(() => {
    if (!location) return;
    void loadSafetyData({
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
    });
  }, [location, loadSafetyData]);

  // Set initial map region when location is available
  useEffect(() => {
    if (location) {
      setMapRegion({
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        latitudeDelta: 0.0922,
        longitudeDelta: 0.0421,
      });
    }
  }, [location]);

  // Long-press tip: first map open only (persisted — never again after seen/dismissed)
  useEffect(() => {
    if (!isLocationReady || longPressTipShownRef.current) return;

    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    let showTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const maybeShowTip = async () => {
      try {
        const seen = await AsyncStorage.getItem(LONG_PRESS_TIP_KEY);
        if (cancelled || seen === "true" || longPressTipShownRef.current) {
          longPressTipShownRef.current = true;
          return;
        }
      } catch {
        // If storage fails, still only show once this session via the ref.
      }

      longPressTipShownRef.current = true;
      showTimer = setTimeout(() => {
        if (cancelled) return;
        setShowLongPressInstruction(true);
        hideTimer = setTimeout(() => {
          void dismissLongPressTip();
        }, 6000);
      }, 2000);
    };

    void maybeShowTip();
    return () => {
      cancelled = true;
      if (showTimer) clearTimeout(showTimer);
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, [isLocationReady, dismissLongPressTip]);

  // Effect to trigger nearby search based on navigation route parameters (from Home screen)
  useEffect(() => {
    if (location && (showPoliceStations || showHospitals)) {
      // Clear any existing route/search results when a nearby search is triggered
      setRouteCoordinates([]);
      setRouteInfo(null);
      setRouteOptions([]);
      setSelectedLocation(null);
      setSearchQuery("");
      setShowSearchResults(false);
      setShowBottomSheet(false);
      setIsNavigationMode(false); // Ensure not in navigation mode

      if (showPoliceStations) {
        getNearbyPlaces("police");
      }
      if (showHospitals) {
        getNearbyPlaces("hospital");
      }

      // IMPORTANT for tab navigation: Clear params after consumption
      // This prevents the effect from re-running if the user navigates away
      // and then back to the SafeMaps tab without pressing the button again.
      navigation.setParams({
        showPoliceStations: undefined,
        showHospitals: undefined,
      });
    }
  }, [location, showPoliceStations, showHospitals, navigation]);

  // Effect to capture navigation parameters from SavedPlacesScreen / Destination Search
  useFocusEffect(
    useCallback(() => {
      const params = route.params as Record<string, unknown> | undefined;
      if (!params) return;

      if (params.selectedPlaceForMap) {
        const {
          selectedPlaceForMap,
          selectedPlaceTitle,
          selectedPlaceSubtitle,
        } = params as {
          selectedPlaceForMap: { latitude: number; longitude: number };
          selectedPlaceTitle: string;
          selectedPlaceSubtitle: string;
        };

        setPendingNavigationRoute({
          coordinate: selectedPlaceForMap,
          title: selectedPlaceTitle,
          subtitle: selectedPlaceSubtitle,
        });

        navigation.setParams({
          selectedPlaceForMap: undefined,
          selectedPlaceTitle: undefined,
          selectedPlaceSubtitle: undefined,
        });
        return;
      }

      if (params.selectedPlaceLat != null && params.selectedPlaceLng != null) {
        setPendingNavigationRoute({
          coordinate: {
            latitude: Number(params.selectedPlaceLat),
            longitude: Number(params.selectedPlaceLng),
          },
          title: String(params.selectedPlaceTitle ?? "Destination"),
          subtitle: String(params.selectedPlaceSubtitle ?? ""),
        });
        navigation.setParams({
          selectedPlaceLat: undefined,
          selectedPlaceLng: undefined,
          selectedPlaceTitle: undefined,
          selectedPlaceSubtitle: undefined,
        } as never);
      }
    }, [route.params, navigation]),
  );

  // Effect to clean up location watcher when component unmounts
  useEffect(() => {
    return () => {
      if (locationWatcher) {
        locationWatcher.remove();
      }
    };
  }, [locationWatcher]);

  // --- Location and Safety Data Management Functions ---

  /**
   * Fetches the current device location and requests permissions.
   * Also performs reverse geocoding to get current city/region name.
   */
  const getCurrentLocation = async () => {
    try {
      let { status } = await Location.requestForegroundPermissionsAsync();

      if (status !== "granted") {
        Alert.alert(
          "Permission denied",
          "Location permission is required to use this app.",
        );
        return;
      }

      let currentLocation = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });

      setLocation(currentLocation);
      setIsLocationReady(true); // NEW: Set location as ready

      // Reverse geocode to get current city/region name
      const reverseGeocode = await Location.reverseGeocodeAsync(
        currentLocation.coords,
      );
      if (reverseGeocode && reverseGeocode.length > 0) {
        const { city, region } = reverseGeocode[0];
        if (city) {
          setCurrentRegionName(city);
        } else if (region) {
          setCurrentRegionName(region);
        }
      }

      if (mapRef.current && currentLocation) {
        mapRef.current.animateToRegion({
          latitude: currentLocation.coords.latitude,
          longitude: currentLocation.coords.longitude,
          latitudeDelta: 0.0922,
          longitudeDelta: 0.0421,
        });
      }
    } catch (error) {
      console.error("Failed to get current location:", error);
      Alert.alert("Error", "Failed to get current location. Please try again.");
      setIsLocationReady(false); // Ensure it's false on error
    }
  };

  const safetyHeatCells = useMemo(
    () =>
      buildSafetyHeatLayer(
        safetyReviews,
        mapRegion?.latitudeDelta ?? 0.05,
      ),
    [safetyReviews, mapRegion?.latitudeDelta],
  );

  const reviewDetailPins = useMemo(
    () => buildReviewDetailPins(safetyReviews, mapRegion),
    [safetyReviews, mapRegion],
  );

  const resolveReviewPlaceLabel = useCallback(async (coord: Coordinate) => {
    setReviewPlaceLabel("Looking up this area…");
    setReviewPlaceSubtitle(
      `${coord.latitude.toFixed(5)}, ${coord.longitude.toFixed(5)} · ~150 m radius`,
    );
    try {
      const places = await Location.reverseGeocodeAsync(coord);
      const p = places?.[0];
      if (p) {
        const title =
          p.name ||
          p.street ||
          p.district ||
          p.subregion ||
          p.city ||
          "Pinned map area";
        const bits = [
          p.street,
          p.district,
          p.city || p.subregion,
        ].filter(Boolean);
        const unique = [...new Set(bits.map(String))];
        setReviewPlaceLabel(String(title));
        setReviewPlaceSubtitle(
          `${unique.join(", ") || "Nearby area"} · ~150 m around pin`,
        );
        return;
      }
    } catch {
      // fall through
    }
    setReviewPlaceLabel("Pinned map location");
    setReviewPlaceSubtitle(
      `${coord.latitude.toFixed(5)}, ${coord.longitude.toFixed(5)} · ~150 m radius`,
    );
  }, []);

  const openReviewAt = useCallback(
    (coord: Coordinate) => {
      setReviewLocation(coord);
      void resolveReviewPlaceLabel(coord);
      setShowReviewModal(true);
      setShowLongPressInstruction(false);
      longPressTipShownRef.current = true;
      void AsyncStorage.setItem(LONG_PRESS_TIP_KEY, "true").catch(() => {});
    },
    [resolveReviewPlaceLabel],
  );

  /**
   * Submits a community safety review: updates local heat immediately,
   * then persists via Firebase verifyReport (Phase 5).
   */
  const submitSafetyReview = useCallback(
    (
      latitude: number,
      longitude: number,
      rating: number,
      comment: string,
      category: string,
    ) => {
      const newReview: SafetyReview = {
        id: Date.now(),
        latitude,
        longitude,
        rating,
        comment,
        category,
        timestamp: Date.now(),
        userId: "current_user",
      };

      const updatedReviews = [...safetyReviews, newReview];
      setSafetyReviews(updatedReviews);

      if (rating <= 2) {
        const newDangerousArea: DangerousArea = {
          latitude,
          longitude,
          radius: 500,
          severity: rating,
        };
        setDangerousAreas((prev) => [...prev, newDangerousArea]);
      }

      setShowReviewModal(false);
      setReviewLocation(null);
      setReviewPlaceLabel(null);
      setReviewPlaceSubtitle(null);

      void (async () => {
        const result = await submitCommunityReport({
          latitude,
          longitude,
          category,
          severity: ratingToSeverity(rating),
          note: comment,
          anonymous: true,
        });
        if (result.ok) {
          Alert.alert(
            "Report submitted",
            reviewPlaceLabel
              ? `Thanks — your report for “${reviewPlaceLabel}” is being verified and will improve SafeRoute for others.`
              : "Thank you — your report is being verified and helps keep the community safer.",
          );
        } else if (result.needsAuth) {
          Alert.alert(
            "Saved on this device",
            "Sign in next time to share this report with the community network.",
          );
        } else {
          Alert.alert(
            "Saved locally",
            `Could not reach the community server (${result.error}). Your review still updates this map session.`,
          );
        }
      })();
    },
    [safetyReviews, reviewPlaceLabel],
  );

  // --- Search Functionality ---

  /**
   * Searches for places using Google Places Text Search API.
   * @param {string} query - The search query string.
   */
  const searchPlaces = async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      setShowSearchResults(false);
      return;
    }

    setShowLongPressInstruction(false); // Hide tip if still visible during search

    if (!GOOGLE_PLACES_API_KEY) {
      Alert.alert(
        "API Key Missing",
        "Google Places API key is not configured. Please add it to your app.json extra field.",
      );
      console.error("Google Places API key is missing.");
      return;
    }

    try {
      const PLACE_SEARCH_URL =
        "https://maps.googleapis.com/maps/api/place/textsearch/json";

      // Bias results towards current location for relevance
      const locationBias = location
        ? `&locationbias=circle:50000@${location.coords.latitude},${location.coords.longitude}`
        : "";

      const url = `${PLACE_SEARCH_URL}?query=${encodeURIComponent(
        query,
      )}&key=${GOOGLE_PLACES_API_KEY}${locationBias}`;

      const response = await fetch(url);
      const data = await response.json();

      if (data.status === "OK") {
        const formattedResults: SearchResult[] = data.results
          .slice(0, 5) // Limit to top 5 results
          .map((place: any) => ({
            id: place.place_id, // Unique ID from Google Places
            title: place.name,
            subtitle:
              place.formatted_address ||
              `${place.vicinity || ""}, ${
                place.plus_code?.compound_code || ""
              }`,
            coordinate: {
              latitude: place.geometry.location.lat,
              longitude: place.geometry.location.lng,
            },
          }));
        setSearchResults(formattedResults);
        setShowSearchResults(true);
      } else if (data.status === "ZERO_RESULTS") {
        setSearchResults([]);
        setShowSearchResults(true);
      } else {
        console.error(
          "Google Places API error:",
          data.status,
          data.error_message,
        );
        Alert.alert(
          "Search Error",
          `Google Places API Error: ${data.error_message || data.status}`,
        );
      }
    } catch (error) {
      console.error("Places API fetch error:", error);
      Alert.alert(
        "Search Error",
        "Network error or invalid API key. Check console for details.",
      );
    }
  };

  /**
   * Selects a search result, updates state, animates map, and shows bottom sheet.
   * @param {SearchResult} result - The selected search result object.
   */
  const selectSearchResult = (result: SearchResult) => {
    setSearchQuery(result.title);
    setShowSearchResults(false);
    setSelectedLocation(result);
    animateBottomSheet(true);
    mapRef.current?.animateToRegion({
      latitude: result.coordinate.latitude,
      longitude: result.coordinate.longitude,
      latitudeDelta: 0.01,
      longitudeDelta: 0.01,
    });
  };

  /**
   * Animates the bottom sheet up or down.
   * @param {boolean} show - True to show, false to hide.
   */
  const animateBottomSheet = (show: boolean) => {
    Animated.timing(bottomSheetAnim, {
      toValue: show ? 1 : 0,
      duration: 300,
      useNativeDriver: false,
    }).start(() => {
      if (!show) setShowBottomSheet(false);
    });
    if (show) setShowBottomSheet(true);
  };

  // --- Utility Functions ---

  /**
   * Decodes an encoded polyline string into an array of coordinates.
   * Used for Google Directions API route polylines.
   * @param {string} encoded - The encoded polyline string.
   * @returns {Coordinate[]} Array of {latitude, longitude} objects.
   */
  const decodePolyline = (encoded: string): Coordinate[] => {
    const coordinates: Coordinate[] = [];
    let index = 0;
    let lat = 0;
    let lng = 0;

    while (index < encoded.length) {
      let b;
      let shift = 0;
      let result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const dlat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
      lat += dlat;

      shift = 0;
      result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const dlng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
      lng += dlng;

      coordinates.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
    }
    return coordinates;
  };

  /**
   * Calculates distance between two coordinates using Haversine formula.
   * Accepts either {latitude, longitude} or Google Places {lat, lng}.
   * @returns {number} Distance in kilometers, or NaN if coords are invalid.
   */
  const calculateDistance = (
    origin: {
      latitude?: number;
      longitude?: number;
      lat?: number;
      lng?: number;
    },
    destination: {
      latitude?: number;
      longitude?: number;
      lat?: number;
      lng?: number;
    },
  ): number => {
    const oLat = Number(origin.latitude ?? origin.lat);
    const oLng = Number(origin.longitude ?? origin.lng);
    const dLat = Number(destination.latitude ?? destination.lat);
    const dLng = Number(destination.longitude ?? destination.lng);
    if (![oLat, oLng, dLat, dLng].every(Number.isFinite)) return NaN;

    const R = 6371; // Earth's radius in km
    const deg2rad = (deg: number) => deg * (Math.PI / 180);

    const deltaLat = deg2rad(dLat - oLat);
    const deltaLon = deg2rad(dLng - oLng);
    const a =
      Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
      Math.cos(deg2rad(oLat)) *
        Math.cos(deg2rad(dLat)) *
        Math.sin(deltaLon / 2) *
        Math.sin(deltaLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  /**
   * Gets the safety score for a given area based on nearby reviews.
   * @param {number} latitude
   * @param {number} longitude
   * @param {number} radius - Search radius in meters.
   * @returns {object} {score, status, reviews}
   */
  const getAreaSafetyScore = useCallback(
    (latitude: number, longitude: number, radius = 500) => {
      const nearbyReviews = safetyReviews.filter((review) => {
        const distance = calculateDistance(
          { latitude, longitude },
          { latitude: review.latitude, longitude: review.longitude },
        );
        return distance <= radius / 1000; // Convert radius to km for comparison
      });

      if (nearbyReviews.length === 0) {
        return { score: 3, status: "unreviewed", reviews: [] };
      }

      const avgRating =
        nearbyReviews.reduce((sum, review) => sum + review.rating, 0) /
        nearbyReviews.length;

      let status = "safe";
      if (avgRating <= 2) status = "dangerous";
      else if (avgRating <= 3.5) status = "caution";

      return { score: avgRating, status, reviews: nearbyReviews };
    },
    [safetyReviews],
  );

  /**
   * Analyzes the safety of an entire route by checking segments.
   * @param {Coordinate[]} coordinates - Array of route coordinates.
   * @returns {object} Overall safety status, danger percentage, and segment-wise safety.
   */
  const analyzeRouteSafety = useCallback(
    (coordinates: Coordinate[]) => {
      let totalDangerousSegments = 0;
      let totalSafeSegments = 0;
      let totalUnreviewedSegments = 0;

      const segmentSafety = [];

      // Analyze more frequently along the route for better accuracy (every 5th coordinate)
      for (let i = 0; i < coordinates.length; i += 5) {
        const coord = coordinates[i];
        const safety = getAreaSafetyScore(coord.latitude, coord.longitude, 500); // Check within 500m radius

        segmentSafety.push({
          coordinate: coord,
          safety: safety.status,
          score: safety.score,
        });

        if (safety.status === "dangerous") totalDangerousSegments++;
        else if (safety.status === "safe") totalSafeSegments++;
        else totalUnreviewedSegments++;
      }

      const totalSegments = segmentSafety.length;
      const dangerPercentage =
        totalSegments > 0 ? (totalDangerousSegments / totalSegments) * 100 : 0;

      let overallSafety = "safe";
      // If even one dangerous segment, or 1% of segments are dangerous, mark as dangerous
      if (totalDangerousSegments > 0 || dangerPercentage >= 1) {
        overallSafety = "dangerous";
      } else if (dangerPercentage > 10) {
        overallSafety = "caution";
      } else if (
        totalSegments > 0 &&
        totalUnreviewedSegments / totalSegments > 0.7
      ) {
        overallSafety = "unreviewed"; // Mostly unreviewed route
      }

      return {
        overall: overallSafety,
        dangerPercentage,
        segmentSafety,
        stats: {
          dangerous: totalDangerousSegments,
          safe: totalSafeSegments,
          unreviewed: totalUnreviewedSegments,
        },
      };
    },
    [getAreaSafetyScore],
  );

  /**
   * Phase 3: A* routes from local FastAPI (Safest / Balanced / Fastest).
   * Returns null if the backend is unreachable.
   */
  const getSafeBackendRoutes = async (
    origin: Coordinate,
    destination: Coordinate,
  ): Promise<RouteInfo[] | null> => {
    try {
      const data = await fetchSafeRoutes(origin, destination, "all");
      if (!data?.routes?.length) return null;

      const order = ["safest", "balanced", "fastest"] as const;
      const sorted = [...data.routes].sort(
        (a, b) =>
          order.indexOf(a.type as (typeof order)[number]) -
          order.indexOf(b.type as (typeof order)[number]),
      );

      return sorted.map((card) => {
        const kind =
          card.type === "safest" ||
          card.type === "balanced" ||
          card.type === "fastest"
            ? card.type
            : "balanced";
        const coordinates = (card.polyline || []).map(([lat, lon]) => ({
          latitude: lat,
          longitude: lon,
        }));
        const distanceKm = (card.distance || 0) / 1000;
        const duration = card.eta || 0;
        return {
          id: card.id || `safe-${kind}`,
          mode: kind,
          coordinates,
          distance: distanceKm,
          duration,
          description: `${distanceKm.toFixed(2)} km • ${duration} min`,
          directions: polylineToNavSteps(
            coordinates,
            card.distance || 0,
            duration,
          ),
          safety: {
            overall: legacySafetyLabel(
              card.safety,
              (card.confidence ?? 80) / 100,
            ),
            score: card.safety,
            lighting:
              card.explanation?.stats &&
              typeof (card.explanation as any).stats?.lighting_pct === "number"
                ? (card.explanation as any).stats.lighting_pct / 100
                : null,
            crowd: null,
          },
          color: ROUTE_KIND_COLORS[kind],
          title: `${ROUTE_KIND_LABELS[kind]} Route`,
          confidence: card.confidence ?? card.confidence_detail?.confidence,
          reasons: card.reasons ?? card.explanation?.reasons,
          confidence_detail: card.confidence_detail ?? card.explanation?.confidence,
          explanation: card.explanation,
        };
      });
    } catch (err) {
      console.warn("SafeRoute API unavailable, falling back to Google:", err);
      return null;
    }
  };

  /**
   * Fetches multiple route options from Google Directions API, including alternatives
   * and routes avoiding certain features, then analyzes their safety.
   * @param {Coordinate} origin - {latitude, longitude}
   * @param {Coordinate} destination - {latitude, longitude}
   * @returns {Promise<RouteInfo[]>} Sorted array of route objects with safety analysis.
   */
  const getMultipleGoogleRoutes = async (
    origin: Coordinate,
    destination: Coordinate,
  ): Promise<RouteInfo[]> => {
    if (!GOOGLE_DIRECTIONS_API_KEY) {
      Alert.alert(
        "API Key Missing",
        "Google Directions API key is not configured. Please add it to your app.json extra field.",
      );
      throw new Error("Google Directions API key not found");
    }

    const fetchRoute = async (pref = "") => {
      const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${
        origin.latitude
      },${origin.longitude}&destination=${destination.latitude},${
        destination.longitude
      }&key=${GOOGLE_DIRECTIONS_API_KEY}&alternatives=true&units=metric${
        pref ? `&${pref}` : ""
      }`;
      const response = await fetch(url);
      const data = await response.json();
      if (data.status !== "OK") {
        console.warn(
          `Google Directions API error (${pref}):`,
          data.status,
          data.error_message,
        );
        return [];
      }
      return data.routes || [];
    };

    let allGoogleRoutes: any[] = [];

    // Fetch standard routes and alternatives
    allGoogleRoutes.push(...(await fetchRoute()));
    // Fetch routes avoiding highways
    allGoogleRoutes.push(...(await fetchRoute("avoid=highways")));
    // Fetch routes avoiding tolls
    allGoogleRoutes.push(...(await fetchRoute("avoid=tolls")));

    // Process and remove duplicates
    const processedRoutes: RouteDraft[] = allGoogleRoutes.map(
      (route, index) => {
        const leg = route.legs[0];
        const coordinates = decodePolyline(route.overview_polyline.points);
        const directions = leg.steps.map((step: any) =>
          mapGoogleStepToNavStep(step, decodePolyline),
        );

        return {
          id: `route-${Date.now()}-${index}`,
          coordinates,
          distance: leg.distance.value / 1000, // in km
          duration: Math.round(leg.duration.value / 60), // in minutes
          description: `${leg.distance.text} • ${leg.duration.text}`,
          directions,
        };
      },
    );

    // Remove duplicate routes based on proximity of distance and duration
    const uniqueRoutes: RouteDraft[] = [];
    for (const route of processedRoutes) {
      const isDuplicate = uniqueRoutes.some((existing) => {
        const distanceDiff = Math.abs(existing.distance - route.distance);
        const durationDiff = Math.abs(existing.duration - route.duration);
        return distanceDiff < 0.5 && durationDiff < 2; // 0.5km and 2min tolerance
      });
      if (!isDuplicate) {
        uniqueRoutes.push(route);
      }
    }

    const now = new Date();
    const scorePoint = (latitude: number, longitude: number) => {
      const area = getAreaSafetyScore(latitude, longitude, 200);
      const lightingReviews = area.reviews.filter(
        (review: SafetyReview) => review.category === "lighting",
      );
      const lighting =
        lightingReviews.length === 0
          ? null
          : (lightingReviews.reduce(
              (sum: number, review: SafetyReview) => sum + review.rating,
              0,
            ) /
              lightingReviews.length -
              1) /
            4;
      return calculateSafetyScore({
        hour: now.getHours() + now.getMinutes() / 60,
        dayOfWeek: now.getDay(),
        communityRating: area.reviews.length > 0 ? area.score : null,
        crowdDensity: null,
        streetLighting: lighting,
        visibilityKm: null,
        policeDistanceM: null,
        cctv: null,
        verifiedIncidents30d: null,
        historicalReports: area.reviews.length > 0 ? area.reviews.length : null,
        xgbRisk: null,
        xgbConfidence: null,
      });
    };

    const candidates = uniqueRoutes.map((route) => ({
      id: route.id,
      coordinates: route.coordinates,
      distanceKm: route.distance,
      durationMin: route.duration,
    }));

    const planned = planCandidateRoutes(candidates, (point) => {
      const scored = scorePoint(point.latitude, point.longitude);
      return {
        score: scored.score,
        lighting: scored.vector.streetLighting,
        crowd: scored.vector.crowdDensity,
      };
    });

    const routesWithSafety = uniqueRoutes.map((route, index) => {
      const safetyAnalysis = analyzeRouteSafety(route.coordinates);
      const routeId = route.id;
      const plan = planned.find((item) => item.id === routeId);
      const midpoint =
        route.coordinates[Math.floor(route.coordinates.length / 2)];
      const midpointScore = midpoint
        ? scorePoint(midpoint.latitude, midpoint.longitude)
        : null;
      const score = plan?.safetyScore ?? midpointScore?.score ?? 50;
      const confidence = midpointScore?.confidence ?? 0;
      const mode =
        plan?.mode === "safest" ||
        plan?.mode === "balanced" ||
        plan?.mode === "fastest"
          ? plan.mode
          : undefined;
      return {
        ...route,
        mode,
        safety: {
          ...safetyAnalysis,
          overall: plan
            ? legacySafetyLabel(score, confidence)
            : safetyAnalysis.overall,
          score,
          lighting: plan?.lighting ?? null,
          crowd: plan?.crowd ?? null,
        },
        color: mode ? ROUTE_KIND_COLORS[mode] : heatColor(score),
        title:
          plan?.title ??
          (index === 0 ? "Primary Route" : `Alternative Route ${index + 1}`),
      };
    });

    const order = new Map(planned.map((item, index) => [item.id, index]));
    routesWithSafety.sort((a, b) => {
      const aId = a.id;
      const bId = b.id;
      const aOrder = order.has(aId) ? order.get(aId)! : 99;
      const bOrder = order.has(bId) ? order.get(bId)! : 99;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return (b.safety?.score ?? 0) - (a.safety?.score ?? 0);
    });

    return routesWithSafety.map((route, index) => {
      const fallback: ("safest" | "balanced" | "fastest")[] = [
        "safest",
        "balanced",
        "fastest",
      ];
      const mode = route.mode ?? fallback[index];
      if (!mode) return route;
      return {
        ...route,
        mode,
        color: ROUTE_KIND_COLORS[mode],
        title: route.title || `${ROUTE_KIND_LABELS[mode]} Route`,
      };
    });
  };

  /**
   * Function to calculate routes and display options.
   * This does NOT set navigation mode to true immediately.
   * @param {Coordinate} destinationCoord - The coordinate of the destination to calculate route for.
   * @param {boolean} [showBottomSheetOnFinish=true] - Whether to show the bottom sheet after calculation.
   */
  const calculateAndShowRoutes = async (
    destinationCoord: Coordinate,
    showBottomSheetOnFinish: boolean = true,
  ) => {
    if (!location) {
      Alert.alert("Error", "Please get your current location first.");
      return;
    }
    if (!destinationCoord) {
      Alert.alert("Error", "Please select a destination first.");
      return;
    }

    setIsCalculatingRoute(true);
    setRouteOptions([]); // Clear previous options
    setRouteCoordinates([]);
    setRouteInfo(null);
    setDirections([]);
    setSelectedRouteIndex(0);
    setIsNavigationMode(false); // Ensure navigation mode is false when showing options

    // Set selectedLocation here, just before calculation uses it (if not already set by search)
    // This ensures selectedLocation is consistent for route calculation and bottom sheet display
    if (!selectedLocation || selectedLocation.coordinate !== destinationCoord) {
      setSelectedLocation({
        id: `temp-${destinationCoord.latitude}-${destinationCoord.longitude}`,
        title: nearestPlaceDetails?.title || "Destination",
        subtitle: nearestPlaceDetails?.subtitle || "",
        coordinate: destinationCoord,
      });
    }

    try {
      const origin = {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
      };
      // Prefer Mumbai road-graph A* (Phase 3); fall back to Google + client planner
      let routes =
        (await getSafeBackendRoutes(origin, destinationCoord)) ||
        (await getMultipleGoogleRoutes(origin, destinationCoord));

      if (!routes || routes.length === 0) {
        Alert.alert(
          "No Routes Found",
          "Could not calculate any routes between the selected locations.",
        );
        return;
      }

      setRouteOptions(routes);

      let selectedRoute = routes[0];
      const balanced = routes.find((r) => r.mode === "balanced");
      if (balanced) selectedRoute = balanced;

      // If "safeRouteOnly" is enabled and the best route is dangerous, try to find an alternative.
      if (safeRouteOnly && selectedRoute.safety.overall === "dangerous") {
        const saferAlternative = routes.find(
          (r) => r.safety.overall !== "dangerous",
        );
        if (saferAlternative) {
          selectedRoute = saferAlternative;
          Alert.alert(
            "Safer Route Found",
            "The primary route passes through unsafe areas. A safer alternative has been selected for you.",
          );
        } else {
          Alert.alert(
            "Safety Warning",
            "All available routes pass through areas marked as unsafe. Consider traveling at a different time or choosing a different destination.",
            [
              { text: "Continue Anyway", onPress: () => {} }, // Allows user to proceed with dangerous route
              {
                text: "Cancel",
                onPress: () => {
                  setIsCalculatingRoute(false);
                  return;
                },
                style: "cancel",
              },
            ],
          );
        }
      }

      setRouteCoordinates(selectedRoute.coordinates);
      setRouteInfo(selectedRoute);
      setDirections(selectedRoute.directions || []);
      setSelectedRouteIndex(routes.indexOf(selectedRoute)); // Set index of the actually selected route

      // Fit map to route coordinates
      if (selectedRoute.coordinates.length > 0) {
        mapRef.current?.fitToCoordinates(selectedRoute.coordinates, {
          edgePadding: { top: 100, right: 50, bottom: 300, left: 50 },
          animated: true,
        });
      }
    } catch (error) {
      console.error("Route calculation error:", error);
      Alert.alert(
        "Route Error",
        "Could not calculate routes. Please check your internet connection or try again later.",
      );
    } finally {
      setIsCalculatingRoute(false);
      // Only show bottom sheet if explicitly requested
      if (showBottomSheetOnFinish) {
        animateBottomSheet(true);
      }
    }
  };

  /**
   * Fetch nearby police/hospital, pick the true nearest by distance (not prominence).
   */
  const getNearbyPlaces = async (placeType: string) => {
    if (!location) {
      Alert.alert(
        "Location Error",
        "Cannot find nearby places without your current location.",
      );
      return;
    }
    if (!GOOGLE_PLACES_API_KEY) {
      Alert.alert(
        "API Key Missing",
        "Google Places API key is not configured.",
      );
      console.error("Google Places API key is missing.");
      return;
    }

    setIsLoadingNearby(true);
    setNearbyPoliceStations([]);
    setNearbyHospitals([]);
    setNearestPlaceDetails(null);

    const origin = {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
    };
    const label = placeType === "police" ? "police stations" : "hospitals";
    const titleLabel = placeType === "police" ? "Police Stations" : "Hospitals";

    try {
      // rankby=distance returns closest first; radius cannot be combined with it.
      const url =
        `https://maps.googleapis.com/maps/api/place/nearbysearch/json` +
        `?location=${origin.latitude},${origin.longitude}` +
        `&rankby=distance&type=${placeType}&key=${GOOGLE_PLACES_API_KEY}`;

      const response = await fetch(url);
      const data = await response.json();

      if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
        console.error(
          `Google Places Nearby Search error for ${placeType}:`,
          data.status,
          data.error_message,
        );
        Alert.alert(
          "Nearby Search Error",
          `Could not fetch ${placeType} locations. Error: ${
            data.error_message || data.status
          }`,
        );
        return;
      }

      const results: any[] = Array.isArray(data.results) ? data.results : [];
      if (results.length === 0) {
        Alert.alert(
          `No ${titleLabel} Found`,
          `Could not find any ${label} near you.`,
        );
        return;
      }

      type NearbyHit = SearchResult & { distance: number; type: string };

      const formatted: NearbyHit[] = results
        .filter(
          (place: any) =>
            place?.business_status == null ||
            place.business_status === "OPERATIONAL",
        )
        .map((place: any) => {
          const lat = Number(place?.geometry?.location?.lat);
          const lng = Number(place?.geometry?.location?.lng);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
          const coordinate = { latitude: lat, longitude: lng };
          const distance = calculateDistance(origin, coordinate);
          if (!Number.isFinite(distance)) return null;
          return {
            id: String(place.place_id || `${lat},${lng}`),
            title: String(place.name || titleLabel),
            subtitle: String(
              place.vicinity || place.formatted_address || "Nearby",
            ),
            coordinate,
            distance,
            type: placeType,
          } as NearbyHit;
        })
        .filter(Boolean)
        .sort((a, b) => (a as NearbyHit).distance - (b as NearbyHit).distance)
        .slice(0, 8) as NearbyHit[];

      if (formatted.length === 0) {
        Alert.alert(
          `No ${titleLabel} Found`,
          `Could not find any ${label} near you.`,
        );
        return;
      }

      const nearest = formatted[0];

      if (placeType === "police") {
        setNearbyPoliceStations(formatted);
      } else {
        setNearbyHospitals(formatted);
      }

      setNearestPlaceDetails(nearest);
      setShowNearestPlaceModal(true);

      if (mapRef.current) {
        mapRef.current.fitToCoordinates(
          [origin, ...formatted.map((p) => p.coordinate)],
          {
            edgePadding: { top: 100, right: 50, bottom: 300, left: 50 },
            animated: true,
          },
        );
      }
    } catch (error) {
      console.error(`Error fetching nearby ${placeType}:`, error);
      Alert.alert(
        "Network Error",
        `Failed to fetch nearby ${placeType}. Check your internet connection.`,
      );
    } finally {
      setIsLoadingNearby(false);
    }
  };

  /**
   * Starts navigation to the nearest place found (after confirmation).
   */
  const startNavigationToNearestPlace = () => {
    if (!nearestPlaceDetails || !location) {
      Alert.alert("Error", "No nearest place selected for navigation.");
      return;
    }
    calculateAndShowRoutes(nearestPlaceDetails.coordinate, false); // MODIFIED: Pass 'false' here
    setShowNearestPlaceModal(false); // Close the modal
  };

  /**
   * Initiates actual navigation mode with live turn-by-turn + camera follow.
   */
  const startActualNavigation = async () => {
    if (!routeInfo || !routeCoordinates.length || !location) {
      Alert.alert(
        "Error",
        "No route selected or current location unavailable to start navigation.",
      );
      return;
    }

    // Tear down any previous watcher before starting a new session.
    if (locationWatcher) {
      locationWatcher.remove();
      setLocationWatcher(null);
    }

    const steps = (routeInfo.directions || directions || []) as NavStep[];
    navStepIndexRef.current = 0;
    arrivedAlertedRef.current = false;
    routeCoordsRef.current = routeCoordinates;
    navStepsRef.current = steps;
    routeMetaRef.current = {
      durationMin: routeInfo.duration || 0,
      distanceKm: routeInfo.distance || 0,
    };

    const seed = updateLiveNavigation({
      position: {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
      },
      heading: location.coords.heading,
      route: routeCoordinates,
      steps,
      previousStepIndex: 0,
      totalDurationMin: routeInfo.duration || 0,
      totalDistanceKm: routeInfo.distance || 0,
    });
    setLiveNav(seed);
    setIsNavigationMode(true);

    try {
      const raw = await AsyncStorage.getItem(GUARDIANS_STORAGE_KEY);
      const list = normalizeGuardians(raw ? JSON.parse(raw) : []);
      const primary = list.find((g) => g.isPrimary) ?? list[0] ?? null;
      setPrimaryGuardian(primary);
      setGuardianConnected(Boolean(primary?.verified));
      if (primary) {
        try {
          const response = await httpsCallable<
            Record<string, unknown>,
            { sessionId: string; sms_required: boolean }
          >(functions, "startLiveShare")({
            guardianUserIds: primary.guardianUserId
              ? [primary.guardianUserId]
              : [],
            eventId: `navigation-${createGuardianId()}`,
            location: {
              latitude: location.coords.latitude,
              longitude: location.coords.longitude,
            },
          });
          navShareSessionRef.current = response.data.sessionId;
          await startSafetyTracking("routes", response.data.sessionId);
          setGuardianConnected(!response.data.sms_required);
          if (response.data.sms_required) {
            await notifyGuardianSms(
              primary.phone,
              `I'm sharing my navigation location from SafeRoute. Last known location: ${mapsLink(location.coords.latitude, location.coords.longitude)}.`,
            );
          }
        } catch {
          setGuardianConnected(false);
          await notifyGuardianSms(
            primary.phone,
            `I'm starting navigation with SafeRoute. Last known location: ${mapsLink(location.coords.latitude, location.coords.longitude)}.`,
          );
        }
      }
    } catch {
      setPrimaryGuardian(null);
      setGuardianConnected(false);
    }

    // Immediate camera into navigation perspective.
    requestAnimationFrame(() => {
      mapRef.current?.animateCamera(
        {
          center: seed.snapped,
          heading: seed.bearing,
          pitch: 55,
          zoom: 17.5,
        },
        { duration: 700 },
      );
    });

    try {
      const watcher = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 800,
          distanceInterval: 3,
          mayShowUserSettingsDialog: true,
        },
        (newLocation) => {
          if (!newLocation.coords) return;
          const { latitude, longitude, heading, speed } = newLocation.coords;
          const position = { latitude, longitude };

          const snapshot = updateLiveNavigation({
            position,
            heading:
              typeof heading === "number" && heading >= 0 ? heading : null,
            route: routeCoordsRef.current,
            steps: navStepsRef.current,
            previousStepIndex: navStepIndexRef.current,
            totalDurationMin: routeMetaRef.current.durationMin,
            totalDistanceKm: routeMetaRef.current.distanceKm,
          });
          navStepIndexRef.current = snapshot.stepIndex;
          setLiveNav(snapshot);
          setLocation(newLocation);
          if (
            navShareSessionRef.current &&
            auth.currentUser &&
            Date.now() - navShareUploadAtRef.current >= 5_000
          ) {
            navShareUploadAtRef.current = Date.now();
            void publishSafetyLocation(
              {
                collection: "routes",
                sessionId: navShareSessionRef.current,
                userId: auth.currentUser.uid,
              },
              newLocation,
            ).catch(console.warn);
          }

          if (!mapRef.current) return;

          // Prefer GPS course when moving; otherwise route tangent.
          const moving =
            typeof speed === "number" && Number.isFinite(speed) && speed > 0.8;
          const camHeading =
            moving && typeof heading === "number" && heading >= 0
              ? heading
              : snapshot.bearing;

          mapRef.current.animateCamera(
            {
              center: snapshot.snapped,
              heading: camHeading,
              pitch: 58,
              zoom: 18,
            },
            { duration: 450 },
          );

          if (snapshot.arrived && !arrivedAlertedRef.current) {
            arrivedAlertedRef.current = true;
            Alert.alert("Arrived", "You have reached your destination.", [
              { text: "Done", onPress: () => stopNavigation() },
            ]);
          }
        },
      );
      setLocationWatcher(watcher);
    } catch (error) {
      console.error("Error starting location watcher:", error);
      Alert.alert(
        "Navigation Error",
        "Could not start live navigation. Please check location permissions.",
      );
    }
  };

  /**
   * Stops the current navigation.
   */
  const stopNavigation = () => {
    const sharingSession = navShareSessionRef.current;
    navShareSessionRef.current = "";
    if (sharingSession) {
      void httpsCallable(functions, "publishSafetyEvent")({
        sessionId: sharingSession,
        type: "ended",
        eventId: `${sharingSession}-ended`,
      }).catch(console.warn);
      void stopSafetyTracking();
    }
    setIsNavigationMode(false);
    setLiveNav(null);
    navStepIndexRef.current = 0;
    arrivedAlertedRef.current = false;
    setRouteCoordinates([]);
    setRouteInfo(null);
    setDirections([]);
    setRouteOptions([]);
    setSelectedRouteIndex(0);
    setNearbyPoliceStations([]);
    setNearbyHospitals([]);
    setNearestPlaceDetails(null);
    setShowNearestPlaceModal(false);

    if (locationWatcher) {
      locationWatcher.remove();
      setLocationWatcher(null);
    }

    if (location) {
      mapRef.current?.animateCamera(
        {
          center: {
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
          },
          heading: 0,
          pitch: 0,
          zoom: 14,
        },
        { duration: 500 },
      );
    }
  };

  useEffect(() => {
    if (isLocationReady && pendingNavigationRoute) {
      const { coordinate, title, subtitle } = pendingNavigationRoute;
      stopNavigation();
      setShowBottomSheet(false);
      setShowNearestPlaceModal(false);
      setSelectedLocation({
        id: `saved-${coordinate.latitude}-${coordinate.longitude}`,
        title: title || "Saved Place",
        subtitle: subtitle || "",
        coordinate: coordinate,
      });
      mapRef.current?.animateToRegion({
        latitude: coordinate.latitude,
        longitude: coordinate.longitude,
        latitudeDelta: 0.01,
        longitudeDelta: 0.01,
      });
      calculateAndShowRoutes(coordinate, false);
      setPendingNavigationRoute(null);
    }
  }, [isLocationReady, pendingNavigationRoute]);

  /**
   * Selects a different route option from the available list.
   * @param {number} routeIndex - The index of the selected route in routeOptions array.
   */
  const selectRouteOption = (routeIndex: number) => {
    const newSelectedRoute = routeOptions[routeIndex];
    if (!newSelectedRoute) return;

    setSelectedRouteIndex(routeIndex);
    // Clear first so react-native-maps drops the previous polyline before drawing the next.
    setRouteCoordinates([]);
    setRouteInfo(newSelectedRoute);
    setDirections(newSelectedRoute.directions || []);

    requestAnimationFrame(() => {
      setRouteCoordinates(newSelectedRoute.coordinates || []);
      if (newSelectedRoute.coordinates?.length) {
        mapRef.current?.fitToCoordinates(newSelectedRoute.coordinates, {
          edgePadding: { top: 100, right: 50, bottom: 300, left: 50 },
          animated: true,
        });
      }
    });

    if (newSelectedRoute.safety?.overall === "dangerous") {
      Alert.alert(
        "Safety Warning",
        "This route passes through areas reported as unsafe. Please consider an alternative route or travel during daylight hours.",
        [{ text: "Understood", style: "default" }],
      );
    }
  };

  /**
   * Handles saving the selected location to AsyncStorage.
   * @param {SearchResult} loc - The location object to save.
   */
  const handleSaveLocation = async (loc: SearchResult) => {
    if (!loc) {
      Alert.alert("Error", "No location selected to save.");
      return;
    }
    try {
      // Retrieve existing saved locations from AsyncStorage
      const savedLocationsJson = await AsyncStorage.getItem("savedLocations");
      const savedLocations: SearchResult[] = savedLocationsJson
        ? JSON.parse(savedLocationsJson)
        : [];

      // Check if location already exists to prevent duplicates
      const exists = savedLocations.some((item) => item.id === loc.id);
      if (exists) {
        Alert.alert(
          "Location Already Saved",
          `${loc.title} is already in your saved places.`,
        );
        return;
      }

      // Add the new location and save back to AsyncStorage
      const newSavedLocations = [...savedLocations, loc];
      await AsyncStorage.setItem(
        "savedLocations",
        JSON.stringify(newSavedLocations),
      );
      Alert.alert(
        "Location Saved",
        `${loc.title} has been added to your saved places!`,
      );
    } catch (error) {
      console.error("Error saving location:", error);
      Alert.alert("Error", "Failed to save location. Please try again.");
    }
  };

  /**
   * Handles sharing the selected location's details using React Native's Share API.
   * @param {SearchResult | null} loc - The location object to share.
   */
  const handleShareLocation = async (loc: SearchResult | null) => {
    if (!loc) {
      Alert.alert("Error", "No location selected to share.");
      return;
    }

    // Create a message with location details and a Google Maps link
    const message = `Check out this location: ${loc.title} - ${loc.subtitle}.
Coordinates: ${loc.coordinate.latitude}, ${loc.coordinate.longitude}.
View on Map: https://www.google.com/maps/search/?api=1&query=${loc.coordinate.latitude},${loc.coordinate.longitude}`;

    try {
      // Use the Share API to open the native share sheet
      await Share.share({
        message: message,
        url: `https://www.google.com/maps/search/?api=1&query=${loc.coordinate.latitude},${loc.coordinate.longitude}`,
        title: `Share ${loc.title}`,
      });
    } catch (error: any) {
      // Handle potential errors during sharing (e.g., user cancels share)
      Alert.alert(
        "Error Sharing",
        error.message || "Failed to share location.",
      );
      console.error("Error sharing location:", error);
    }
  };

  // --- Render Logic ---

  // Show loading screen if location is not yet available
  if (!isLocationReady) {
    // Use isLocationReady for initial loading screen
    return (
      <SafeAreaView style={GlobalStyles.loadingContainer}>
        <Text style={GlobalStyles.loadingText}>Loading SafeRoute...</Text>
        <Text style={GlobalStyles.loadingSubtext}>
          Finding the safest paths for you
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <>
      <StatusBar
        barStyle={isDark || isNavigationMode ? "light-content" : "dark-content"}
        backgroundColor={
          isDark || isNavigationMode ? themeColors.background : "#ffffff"
        }
      />
      <SafeAreaView
        style={[
          GlobalStyles.container,
          { backgroundColor: themeColors.background },
        ]}
      >
        {/* Search Bar — hidden during live navigation so the turn card sits cleanly */}
        {!isNavigationMode ? (
          <SearchBar
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            searchResults={searchResults}
            showSearchResults={showSearchResults}
            onSearch={searchPlaces}
            onSelectResult={selectSearchResult}
            onClearSearch={() => {
              setSearchQuery("");
              setShowSearchResults(false);
            }}
            onBookmarkPress={() => navigation.navigate("SavedPlacesScreen")}
          />
        ) : null}

        {/* Map Display Component */}
        <MapDisplay
          mapRef={mapRef}
          initialRegion={mapRegion}
          selectedLocation={selectedLocation}
          safetyReviews={safetyReviews}
          dangerousAreas={dangerousAreas}
          safetyHeatCells={safetyHeatCells as any}
          reviewDetailPins={reviewDetailPins as any}
          reviewDraftCoordinate={
            (showReviewModal && reviewLocation ? reviewLocation : undefined) as any
          }
          routeCoordinates={
            isNavigationMode && liveNav?.remainingCoordinates?.length
              ? liveNav.remainingCoordinates
              : routeCoordinates
          }
          comparisonRoutes={
            !isNavigationMode && routeOptions.length > 0
              ? routeOptions.slice(0, 3).map((r) => ({
                  id: r.id,
                  coordinates: r.coordinates,
                  color: r.color,
                }))
              : null
          }
          selectedComparisonIndex={selectedRouteIndex}
          traveledCoordinates={
            isNavigationMode ? liveNav?.traveledCoordinates : undefined
          }
          routeKey={`${selectedRouteIndex}-${routeInfo?.id ?? "none"}-${
            liveNav?.stepIndex ?? "x"
          }`}
          routeColor={
            isNavigationMode
              ? themeColors.primary
              : routeInfo?.color || themeColors.primary
          }
          routeStrokeWidth={isNavigationMode ? 8 : 6}
          navigationMode={isNavigationMode}
          navigationCoordinate={
            (isNavigationMode
              ? liveNav?.snapped ||
                (location
                  ? {
                      latitude: location.coords.latitude,
                      longitude: location.coords.longitude,
                    }
                  : undefined)
              : undefined) as any
          }
          navigationHeading={
            isNavigationMode
              ? (liveNav?.bearing ?? location?.coords?.heading ?? 0)
              : 0
          }
          onLongPress={(event: any) => {
            openReviewAt(event.nativeEvent.coordinate);
          }}
          onRegionChangeComplete={(region: any) => {
            if (
              region?.latitude != null &&
              region?.longitude != null &&
              region?.latitudeDelta != null
            ) {
              setMapRegion(region);
            }
          }}
          onMyLocationPress={getCurrentLocation}
          nearbyPoliceStations={nearbyPoliceStations}
          nearbyHospitals={nearbyHospitals}
          showLocationButton={false}
        />

        {/* Loading Overlay for route calculation or nearby search */}
        <LoadingOverlay
          isVisible={isCalculatingRoute || isLoadingNearby}
          message={
            isCalculatingRoute
              ? "Finding safest route..."
              : "Finding nearby places..."
          }
          subMessage={
            isCalculatingRoute ? "Avoiding dangerous areas" : "Please wait..."
          }
        />

        {/* Live Navigation HUD — full-screen map chrome */}
        <LiveNavigationHUD
          visible={Boolean(isNavigationMode && routeInfo)}
          padForTabBar
          instruction={
            liveNav?.instruction ||
            directions[0]?.instruction ||
            routeInfo?.title ||
            "Continue on route"
          }
          maneuverDistance={
            liveNav?.distanceToManeuverLabel ||
            (directions[0]?.distanceMeters != null
              ? `${Math.round(directions[0].distanceMeters)} m`
              : undefined)
          }
          maneuverIcon={(liveNav?.maneuverIcon as any) || "straight"}
          remainingMinutes={
            liveNav?.remainingMinutes ?? Math.round(routeInfo?.duration ?? 0)
          }
          remainingKm={
            liveNav != null
              ? liveNav.remainingKm
              : Number(routeInfo?.distance ?? 0)
          }
          safetyScore={
            Number.isFinite(routeInfo?.safety?.score)
              ? Math.round(routeInfo!.safety!.score as number)
              : 70
          }
          guardian={
            primaryGuardian
              ? {
                  name: primaryGuardian.name,
                  phone: primaryGuardian.phone,
                  connected: guardianConnected,
                }
              : null
          }
          onCallGuardian={() => {
            if (primaryGuardian?.phone) {
              void Linking.openURL(`tel:${primaryGuardian.phone}`);
            } else {
              Alert.alert(
                "No guardian",
                "Add a Trusted Guardian to call them during your trip.",
              );
            }
          }}
          onReport={() => {
            if (location?.coords) {
              openReviewAt({
                latitude: location.coords.latitude,
                longitude: location.coords.longitude,
              });
            } else {
              Alert.alert(
                "Location needed",
                "Wait for your location, or long-press the map on the area you want to review.",
              );
            }
          }}
          onSOS={() => router.push("/SOS" as never)}
          onEnd={stopNavigation}
        />

        <MapTripSheet
          visible={!isNavigationMode}
          destinationTitle={selectedLocation?.title}
          destinationSubtitle={selectedLocation?.subtitle}
          routes={
            routeOptions.length > 0
              ? mapNavigateRoutesToComparison(routeOptions)
              : []
          }
          selectedIndex={selectedRouteIndex}
          safetyScore={
            routeInfo && Number.isFinite(routeInfo.safety?.score)
              ? Math.round(Number(routeInfo.safety.score))
              : null
          }
          onSelectRoute={selectRouteOption}
          onFindRoutes={() => {
            if (selectedLocation) {
              calculateAndShowRoutes(selectedLocation.coordinate, false);
            }
          }}
          onRefresh={() => {
            if (selectedLocation) {
              calculateAndShowRoutes(selectedLocation.coordinate, false);
            }
          }}
          refreshing={isCalculatingRoute}
          onDismiss={() => {
            setSelectedLocation(null);
            setRouteOptions([]);
            setRouteCoordinates([]);
            setRouteInfo(null);
            setDirections([]);
            setSelectedRouteIndex(0);
            setSearchQuery("");
            setShowSearchResults(false);
            setNearbyPoliceStations([]);
            setNearbyHospitals([]);
            setNearestPlaceDetails(null);
          }}
          onStartNavigation={() => {
            // Stay on the map so the selected polyline + LiveNavigationHUD remain visible.
            void startActualNavigation();
          }}
          onSave={
            selectedLocation
              ? () => handleSaveLocation(selectedLocation)
              : undefined
          }
          onShare={
            selectedLocation
              ? () => handleShareLocation(selectedLocation)
              : undefined
          }
          onMyLocation={getCurrentLocation}
          onReport={() => {
            if (location?.coords) {
              openReviewAt({
                latitude: location.coords.latitude,
                longitude: location.coords.longitude,
              });
            } else {
              Alert.alert(
                "Location needed",
                "Wait for your location, or long-press the map on the area you want to review.",
              );
            }
          }}
        />

        {/* Safety Review Modal Component */}
        <SafetyReviewModal
          showReviewModal={showReviewModal}
          reviewLocation={reviewLocation}
          reviewPlaceLabel={reviewPlaceLabel}
          reviewPlaceSubtitle={reviewPlaceSubtitle}
          onLocationChange={(next: {
            coordinate: { latitude: number; longitude: number };
            title: string;
            subtitle: string;
          }) => {
            setReviewLocation(next.coordinate);
            setReviewPlaceLabel(next.title);
            setReviewPlaceSubtitle(next.subtitle);
          }}
          onUseCurrentLocation={() => {
            if (location?.coords) {
              openReviewAt({
                latitude: location.coords.latitude,
                longitude: location.coords.longitude,
              });
            } else {
              Alert.alert(
                "Location needed",
                "Waiting for GPS. You can also search for an area above.",
              );
            }
          }}
          onSubmit={submitSafetyReview}
          onClose={() => {
            setShowReviewModal(false);
            setReviewLocation(null);
            setReviewPlaceLabel(null);
            setReviewPlaceSubtitle(null);
          }}
        />

        {/* Directions Modal Component */}
        <DirectionsModal
          showDirectionsModal={showDirectionsModal}
          directions={directions}
          routeInfo={routeInfo}
          onClose={() => setShowDirectionsModal(false)}
        />

        {/* Long Press Instruction Overlay */}
        <LongPressInstruction
          isVisible={showLongPressInstruction}
          onClose={() => {
            void dismissLongPressTip();
          }}
        />

        {/* Nearest Place Confirmation Modal Component */}
        <NearestPlaceConfirmationModal
          isVisible={showNearestPlaceModal}
          placeDetails={nearestPlaceDetails}
          onConfirmNavigation={startNavigationToNearestPlace}
          onCancel={() => {
            setShowNearestPlaceModal(false);
            setNearestPlaceDetails(null); // Clear details if user cancels
            setNearbyPoliceStations([]); // Clear markers if user cancels
            setNearbyHospitals([]); // Clear markers if user cancels
          }}
        />
      </SafeAreaView>
    </>
  );
};

export default SafeMaps;
