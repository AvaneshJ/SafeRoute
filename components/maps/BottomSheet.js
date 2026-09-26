// components/maps/BottomSheet.js
import React from "react";
import {
  Animated,
  Dimensions,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useAppTheme } from "@/hooks/useAppTheme";

const { height } = Dimensions.get("window");

/**
 * BottomSheet Component
 * Displays details about a selected location and provides actions.
 *
 * Props:
 * - showBottomSheet: Boolean to control visibility.
 * - bottomSheetAnim: Animated value for controlling slide-up animation.
 * - selectedLocation: Object containing location details (title, subtitle, coordinate).
 * - onStartNavigation: Function to initiate navigation to the selected location.
 * - onSaveLocation: Function to save the selected location. (NEW)
 * - onShareLocation: Function to share the user's current location. (NEW)
 * - onClose: Function to close the bottom sheet.
 */
const BottomSheet = ({
  showBottomSheet,
  bottomSheetAnim,
  selectedLocation,
  onStartNavigation,
  onSaveLocation, // NEW PROP
  onShareLocation, // NEW PROP
  onClose,
}) => {
  const { colors: c, elevation: elev } = useAppTheme();
  if (showBottomSheet !== true || !selectedLocation) {
    return null;
  }

  return (
    <Animated.View
      style={[
        styles.bottomSheet,
        { backgroundColor: c.surface, ...elev.sheet },
        {
          transform: [
            {
              translateY: bottomSheetAnim.interpolate({
                inputRange: [0, 1],
                outputRange: [height * 0.35, 0], // Slide from below screen to its position
              }),
            },
          ],
        },
      ]}
    >
      <TouchableOpacity
        style={[styles.bottomSheetHandle, { backgroundColor: c.border }]}
        onPress={onClose}
      />
      <View style={styles.bottomSheetContent}>
        <Text style={[styles.bottomSheetTitle, { color: c.textPrimary }]}>
          {selectedLocation?.title}
        </Text>
        <Text style={[styles.bottomSheetSubtitle, { color: c.textSecondary }]}>
          {selectedLocation?.subtitle}
        </Text>

        <View style={styles.bottomSheetActions}>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={onStartNavigation}
          >
            <Text style={styles.actionButtonText}>🛡️</Text>
            <Text
              style={[styles.actionButtonLabel, { color: c.textSecondary }]}
            >
              Safe Route
            </Text>
          </TouchableOpacity>

          {/* NEW: Save Button */}
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => onSaveLocation(selectedLocation)}
          >
            <Text style={styles.actionButtonText}>💾</Text>
            <Text
              style={[styles.actionButtonLabel, { color: c.textSecondary }]}
            >
              Save
            </Text>
          </TouchableOpacity>

          {/* NEW: Share Button */}
          <TouchableOpacity
            style={styles.actionButton}
            onPress={onShareLocation}
          >
            <Text style={styles.actionButtonText}>📤</Text>
            <Text
              style={[styles.actionButtonLabel, { color: c.textSecondary }]}
            >
              Share
            </Text>
          </TouchableOpacity>

          {/* Removed Call button as per your previous instruction */}
          {/* <TouchableOpacity style={styles.actionButton}>
            <Text style={styles.actionButtonText}>📞</Text>
            <Text style={styles.actionButtonLabel}>Call</Text>
          </TouchableOpacity> */}
        </View>
      </View>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  bottomSheet: {
    position: "absolute",
    bottom: 70,
    left: 0,
    right: 0,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 20,
  },
  bottomSheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    alignSelf: "center",
    marginTop: 8,
    marginBottom: 8,
  },
  bottomSheetContent: {
    paddingHorizontal: 20,
  },
  bottomSheetTitle: {
    fontSize: 20,
    fontWeight: "bold",
    marginTop: 8,
  },
  bottomSheetSubtitle: {
    fontSize: 14,
    marginTop: 4,
  },
  bottomSheetActions: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginTop: 24,
  },
  actionButton: {
    alignItems: "center",
    padding: 8,
  },
  actionButtonText: {
    fontSize: 24,
    marginBottom: 4,
  },
  actionButtonLabel: {
    fontSize: 12,
  },
});

export default BottomSheet;
