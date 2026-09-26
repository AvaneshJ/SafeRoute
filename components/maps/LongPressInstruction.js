// components/maps/LongPressInstruction.js
import { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, TouchableOpacity } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppTheme } from "@/hooks/useAppTheme";

/** Matches SearchBar: top inset + 8, then ~52px field height */
const SEARCH_BAR_OFFSET = 8;
const SEARCH_BAR_HEIGHT = 52;
const GAP_BELOW_SEARCH = 12;

/**
 * LongPressInstruction Component
 * Displays a temporary, dismissible instruction for long-pressing to add reviews.
 * Sits below the map search bar so the two never overlap.
 *
 * Props:
 * - isVisible: Boolean to control visibility.
 * - onClose: Function to call when the instruction should be dismissed.
 */
const LongPressInstruction = ({ isVisible, onClose }) => {
  const { colors: c, elevation: elev } = useAppTheme();
  const insets = useSafeAreaInsets();
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (isVisible) {
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 500,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 500,
        useNativeDriver: true,
      }).start();
    }
  }, [isVisible, fadeAnim]);

  if (!isVisible) {
    return null;
  }

  const top =
    Math.max(insets.top, 12) +
    SEARCH_BAR_OFFSET +
    SEARCH_BAR_HEIGHT +
    GAP_BELOW_SEARCH;

  return (
    <Animated.View
      style={[
        styles.container,
        { top, opacity: fadeAnim, backgroundColor: c.info, ...elev.card },
      ]}
    >
      <Text style={styles.text}>
        Long-press on the map to add a safety review
      </Text>
      <TouchableOpacity
        onPress={onClose}
        style={styles.closeButton}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Dismiss tip"
      >
        <Text style={styles.closeButtonText}>✕</Text>
      </TouchableOpacity>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 20,
    right: 20,
    paddingVertical: 12,
    paddingHorizontal: 15,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    zIndex: 20,
  },
  text: {
    color: "white",
    fontSize: 14,
    fontWeight: "600",
    flexShrink: 1,
    marginRight: 10,
  },
  closeButton: {
    padding: 5,
  },
  closeButtonText: {
    color: "white",
    fontSize: 16,
    fontWeight: "bold",
  },
});

export default LongPressInstruction;
