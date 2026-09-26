// components/SafetyToggle.js
import { useAppTheme } from "@/hooks/useAppTheme";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

const SafetyToggle = ({ safeRouteOnly, onToggle }) => {
  const { colors: c } = useAppTheme();
  return (
    <View style={styles.safetyToggleContainer}>
      <Text style={[styles.safetyToggleLabel, { color: c.textPrimary }]}>
        Prioritize Safe Routes
      </Text>
      <TouchableOpacity
        style={[
          styles.safetyToggle,
          { backgroundColor: c.surfaceVariant },
          safeRouteOnly && { backgroundColor: c.success },
        ]}
        onPress={onToggle}
      >
        <Text
          style={[
            styles.safetyToggleText,
            { color: c.textSecondary },
            safeRouteOnly && styles.safetyToggleTextActive,
          ]}
        >
          {safeRouteOnly ? "ON" : "OFF"}
        </Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  safetyToggleContainer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  safetyToggleLabel: {
    fontSize: 16,
    fontWeight: "600",
  },
  safetyToggle: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
  },
  safetyToggleText: {
    fontSize: 12,
    fontWeight: "bold",
  },
  safetyToggleTextActive: {
    color: "white",
  },
});

export default SafetyToggle;
