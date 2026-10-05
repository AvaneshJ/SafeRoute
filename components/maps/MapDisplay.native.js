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
  Polygon,
  Polyline,
  PROVIDER_GOOGLE,
} from "react-native-maps";

const isExpoGo = Constants.appOwnership === "expo";

const TURN_ARROW_OUTLINE = "rgba(15, 23, 42, 0.6)";

/** Apply an alpha to #RGB / #RRGGBB / rgb() colors; other formats pass through. */
function withAlpha(color, alpha) {
  if (typeof color !== "string") return color;
  const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((ch) => ch + ch).join("");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const rgb = color.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const [r, g, b] = rgb[1].split(",").map((part) => part.trim());
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

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
  routeColor,
  routeStrokeWidth = 6,
  /** { shaft: LatLng[], head: LatLng[] } — white on-road arrow at the next turn */
  turnArrow,
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
    Array.isArray(routeCoordinates) && routeCoordinates.length > 1
      ? routeCoordinates
      : [];
  const hasRoute = ahead.length > 0;
  const showTurnArrow =
    navigationMode &&
    Array.isArray(turnArrow?.shaft) &&
    turnArrow.shaft.length > 1 &&
    Array.isArray(turnArrow?.head) &&
    turnArrow.head.length === 3;
  // Route + turn-arrow overlays stay mounted with fixed keys and are hidden via
  // empty/transparent props: on Android New Arch (react-native-maps 1.27),
  // unmounting a Polyline/Polygon can leave a "ghost" still painted on the map.
  const arrowAnchor =
    turnArrow?.head?.[0] ||
    navigationCoordinate ||
    ahead[0] || {
      latitude: initialRegion?.latitude ?? 0,
      longitude: initialRegion?.longitude ?? 0,
    };
  const arrowShaft = showTurnArrow ? turnArrow.shaft : [arrowAnchor, arrowAnchor];
  const arrowHead = showTurnArrow
    ? turnArrow.head
    : [arrowAnchor, arrowAnchor, arrowAnchor];
  const arrowOutline = showTurnArrow ? TURN_ARROW_OUTLINE : "transparent";
  const arrowFill = showTurnArrow ? "#FFFFFF" : "transparent";

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
        showsTraffic={!hasRoute}
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

        {/* Selected route only: soft glow → white casing → colored core */}
        <Polyline
          key="route-glow-outer"
          coordinates={ahead}
          strokeColor={withAlpha(routeColor, 0.16)}
          strokeWidth={routeStrokeWidth + 16}
          zIndex={1}
          lineCap="round"
          lineJoin="round"
        />
        <Polyline
          key="route-glow-inner"
          coordinates={ahead}
          strokeColor={withAlpha(routeColor, 0.32)}
          strokeWidth={routeStrokeWidth + 8}
          zIndex={2}
          lineCap="round"
          lineJoin="round"
        />
        <Polyline
          key="route-casing"
          coordinates={ahead}
          strokeColor="rgba(255, 255, 255, 0.95)"
          strokeWidth={routeStrokeWidth + 3}
          zIndex={3}
          lineCap="round"
          lineJoin="round"
        />
        <Polyline
          key="route-core"
          coordinates={ahead}
          strokeColor={routeColor}
          strokeWidth={routeStrokeWidth}
          zIndex={4}
          lineCap="round"
          lineJoin="round"
        />

        <Polyline
          key="turn-arrow-outline"
          coordinates={arrowShaft}
          strokeColor={arrowOutline}
          strokeWidth={15}
          zIndex={6}
          lineCap="round"
          lineJoin="round"
        />
        <Polygon
          key="turn-arrow-head"
          coordinates={arrowHead}
          fillColor={arrowFill}
          strokeColor={arrowOutline}
          strokeWidth={2}
          zIndex={7}
        />
        <Polyline
          key="turn-arrow-shaft"
          coordinates={arrowShaft}
          strokeColor={arrowFill}
          strokeWidth={10}
          zIndex={8}
          lineCap="round"
          lineJoin="round"
        />

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
