// components/NavigationHeader.js
import {
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useAppTheme } from "@/hooks/useAppTheme";

/**
 * NavigationHeader Component
 * Displays current navigation information (time, distance, route title)
 * and a button to stop navigation.
 *
 * Props:
 * - isVisible: Boolean to control visibility.
 * - routeInfo: Object containing current route details (duration, distance, title, safety).
 * - onStopNavigation: Function to call when the stop button is pressed.
 */
const NavigationHeader = ({ isVisible, routeInfo, onStopNavigation }) => {
  const { elevation: elev } = useAppTheme();
  if (!isVisible || !routeInfo) return null;

  return (
    <View
      style={[
        styles.navigationHeader,
        { backgroundColor: routeInfo.color, ...elev.card },
      ]}
    >
      <View style={styles.navigationInfo}>
        <Text style={styles.navigationTime}>{routeInfo.duration} min</Text>
        <Text style={styles.navigationDistance}>
          ({routeInfo.distance.toFixed(1)} km)
        </Text>
        <Text style={styles.navigationRoute}>{routeInfo.title}</Text>
        <Text style={styles.navigationSafety}>
          Safety: {routeInfo.safety?.overall || "Unknown"}
        </Text>
      </View>
      <TouchableOpacity style={styles.stopButton} onPress={onStopNavigation}>
        <Text style={styles.stopButtonText}>✕</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  navigationHeader: {
    position: "absolute",
    top: Platform.OS === "ios" ? 50 : 20,
    left: 15,
    right: 15,
    borderRadius: 8,
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    zIndex: 10,
  },
  navigationInfo: {
    flex: 1,
  },
  navigationTime: {
    fontSize: 20,
    fontWeight: "bold",
    color: "white",
  },
  navigationDistance: {
    fontSize: 14,
    color: "rgba(255, 255, 255, 0.8)",
  },
  navigationRoute: {
    fontSize: 12,
    color: "rgba(255, 255, 255, 0.8)",
    marginTop: 2,
  },
  navigationSafety: {
    fontSize: 12,
    color: "rgba(255, 255, 255, 0.9)",
    fontWeight: "bold",
    marginTop: 4,
  },
  stopButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255, 255, 255, 0.3)",
    alignItems: "center",
    justifyContent: "center",
  },
  stopButtonText: {
    color: "white",
    fontSize: 18,
    fontWeight: "bold",
  },
});

export default NavigationHeader;
