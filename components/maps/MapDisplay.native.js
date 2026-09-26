// components/maps/MapDisplay.js
import { useAppTheme } from "@/hooks/useAppTheme";
import { NavigationArrow } from "@/components/navigation/NavigationArrow";
import { heatColor } from "../../core/heatmap";
import { useEffect } from "react";
import {
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Constants from "expo-constants";
import MapView, {
  Circle,
  Marker,
  Polyline,
  PROVIDER_GOOGLE,
} from "react-native-maps";

const isExpoGo = Constants.appOwnership === "expo";

const MapDisplay = ({
  mapRef,
  initialRegion,
  selectedLocation,
  safetyReviews,
  dangerousAreas,
  safetyHeatCells = [],
  reviewDetailPins = [],
  reviewDraftCoordinate = null,
  routeCoordinates,
  routeKey,
  routeColor,
  routeStrokeWidth = 6,
  /** Optional Safest/Balanced/Fastest overlays (comparison mode). */
  comparisonRoutes = null,
  selectedComparisonIndex = 0,
  traveledCoordinates,
  onLongPress,
  onRegionChangeComplete,
  onMyLocationPress,
  nearbyPoliceStations,
  nearbyHospitals,
  showLocationButton = true,
  navigationMode = false,
  navigationCoordinate = null,
  navigationHeading = 0,
}) => {
  const { colors: c, elevation: elev } = useAppTheme();

  useEffect(() => {
    const allNearbyCoords = [];
    if (nearbyPoliceStations.length > 0) {
      allNearbyCoords.push(...nearbyPoliceStations.map((p) => p.coordinate));
    }
    if (nearbyHospitals.length > 0) {
      allNearbyCoords.push(...nearbyHospitals.map((p) => p.coordinate));
    }

    if (mapRef.current && allNearbyCoords.length > 0 && !navigationMode) {
      mapRef.current.fitToCoordinates(allNearbyCoords, {
        edgePadding: { top: 100, right: 50, bottom: 300, left: 50 },
        animated: true,
      });
    }
  }, [nearbyPoliceStations, nearbyHospitals, navigationMode]);

  const ahead =
    Array.isArray(routeCoordinates) && routeCoordinates.length > 0
      ? routeCoordinates
      : [];
  const traveled =
    Array.isArray(traveledCoordinates) && traveledCoordinates.length > 1
      ? traveledCoordinates
      : [];

  // Prefer aggregated heat; fall back to legacy dangerous circles only if no heat.
  const useHeat = Array.isArray(safetyHeatCells) && safetyHeatCells.length > 0;

  return (
    <View style={styles.mapContainer}>
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={PROVIDER_GOOGLE}
        initialRegion={initialRegion}
        showsUserLocation={!navigationMode}
        showsMyLocationButton={false}
        showsTraffic={true}
        showsBuildings={true}
        showsIndoors={true}
        onLongPress={onLongPress}
        onRegionChangeComplete={onRegionChangeComplete}
        rotateEnabled
        pitchEnabled
      >
        {selectedLocation && !navigationMode ? (
          <Marker
            coordinate={selectedLocation.coordinate}
            title={selectedLocation.title}
            pinColor={c.primary}
          />
        ) : null}

        {selectedLocation && navigationMode ? (
          <Marker
            coordinate={selectedLocation.coordinate}
            title={selectedLocation.title}
            pinColor={c.danger}
          />
        ) : null}

        {/* Soft safety heat (geohash aggregates) — scales to many reviews */}
        {useHeat
          ? safetyHeatCells.map((cell) => (
              <Circle
                key={`heat-${cell.id}`}
                center={{
                  latitude: cell.latitude,
                  longitude: cell.longitude,
                }}
                radius={cell.radius}
                strokeColor={`${cell.color}55`}
                fillColor={`${cell.color}33`}
                strokeWidth={1}
                zIndex={0}
              />
            ))
          : dangerousAreas.map((area, index) => (
              <Circle
                key={`danger-${index}`}
                center={{ latitude: area.latitude, longitude: area.longitude }}
                radius={area.radius}
                strokeColor={`${heatColor(((area.severity - 1) / 4) * 100)}99`}
                fillColor={`${heatColor(((area.severity - 1) / 4) * 100)}33`}
                strokeWidth={2}
              />
            ))}

        {/* Street-level only: tiny review dots (capped) */}
        {reviewDetailPins.map((pin) => (
          <Marker
            key={`pin-${pin.id}`}
            coordinate={{
              latitude: pin.latitude,
              longitude: pin.longitude,
            }}
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={false}
            title={`${pin.rating}/5 · ${pin.category || "safety"}`}
            description={pin.comment}
          >
            <View
              style={[
                styles.reviewDot,
                {
                  backgroundColor: pin.color,
                  borderColor: "#fff",
                },
              ]}
            />
          </Marker>
        ))}

        {/* Draft pin while composing a review */}
        {reviewDraftCoordinate ? (
          <Marker
            coordinate={reviewDraftCoordinate}
            title="Reviewing this area"
            pinColor={c.warning}
            zIndex={8}
          />
        ) : null}

        {traveled.length > 1 ? (
          <Polyline
            key={`traveled-${routeKey}`}
            coordinates={traveled}
            strokeColor="rgba(148, 163, 184, 0.75)"
            strokeWidth={Math.max(4, routeStrokeWidth - 2)}
            zIndex={1}
            lineCap="round"
            lineJoin="round"
          />
        ) : null}

        {/* Safest (green) / Balanced (blue) / Fastest (gray) — dim unselected */}
        {!navigationMode &&
        Array.isArray(comparisonRoutes) &&
        comparisonRoutes.length > 0
          ? comparisonRoutes.map((route, index) => {
              const coords = route?.coordinates;
              if (!Array.isArray(coords) || coords.length < 2) return null;
              const selected = index === selectedComparisonIndex;
              const color = route.color || routeColor;
              return (
                <Polyline
                  key={`cmp-${route.id || index}-${selected ? "on" : "off"}`}
                  coordinates={coords}
                  strokeColor={selected ? color : `${color}55`}
                  strokeWidth={selected ? Math.max(routeStrokeWidth, 7) : 4}
                  zIndex={selected ? 3 : 2}
                  lineCap="round"
                  lineJoin="round"
                />
              );
            })
          : null}

        {(navigationMode ||
          !Array.isArray(comparisonRoutes) ||
          comparisonRoutes.length === 0) &&
        ahead.length > 0 ? (
          <Polyline
            key={
              routeKey ||
              `route-${ahead.length}-${routeColor}-${routeStrokeWidth}`
            }
            coordinates={ahead}
            strokeColor={routeColor}
            strokeWidth={routeStrokeWidth}
            zIndex={2}
            lineCap="round"
            lineJoin="round"
          />
        ) : null}

        {nearbyPoliceStations.map((place) => (
          <Marker
            key={`police-${place.id}`}
            coordinate={place.coordinate}
            title={place.title}
            description={place.subtitle}
            pinColor={c.secondary}
          />
        ))}

        {nearbyHospitals.map((place) => (
          <Marker
            key={`hospital-${place.id}`}
            coordinate={place.coordinate}
            title={place.title}
            description={place.subtitle}
            pinColor={c.success}
          />
        ))}

        {navigationMode && navigationCoordinate ? (
          <NavigationArrow
            coordinate={navigationCoordinate}
            heading={navigationHeading || 0}
            color={c.primary}
          />
        ) : null}
      </MapView>

      {isExpoGo && Platform.OS === "android" ? (
        <View style={styles.expoGoBanner} pointerEvents="none">
          <Text style={styles.expoGoBannerTitle}>
            Map tiles need a development build
          </Text>
          <Text style={styles.expoGoBannerBody}>
            Expo Go on Android SDK 57 uses an expired Google Maps key. Location
            still works. Run: npx expo run:android
          </Text>
        </View>
      ) : null}

      {showLocationButton ? (
        <TouchableOpacity
          style={[
            styles.myLocationButton,
            { backgroundColor: c.surface, ...elev.card },
          ]}
          onPress={onMyLocationPress}
        >
          <Text style={styles.myLocationIcon}>📍</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  mapContainer: {
    flex: 1,
  },
  map: {
    flex: 1,
  },
  myLocationButton: {
    position: "absolute",
    bottom: 150,
    right: 20,
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  myLocationIcon: {
    fontSize: 20,
  },
  expoGoBanner: {
    position: "absolute",
    top: 12,
    left: 12,
    right: 12,
    backgroundColor: "rgba(0,0,0,0.78)",
    borderRadius: 10,
    padding: 12,
  },
  expoGoBannerTitle: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 14,
    marginBottom: 4,
  },
  expoGoBannerBody: {
    color: "#eee",
    fontSize: 12,
    lineHeight: 16,
  },
  reviewDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
  },
});

export default MapDisplay;
