// components/DirectionsModal.js
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useAppTheme } from "@/hooks/useAppTheme";

/**
 * DirectionsModal Component
 * Displays turn-by-turn directions for a selected route in a modal.
 *
 * Props:
 * - showDirectionsModal: Boolean to control modal visibility.
 * - directions: Array of direction step objects ({instruction, distance, duration}).
 * - routeInfo: Object containing overall route information (e.g., title, total distance/duration).
 * - onClose: Function to close the modal.
 */
const DirectionsModal = ({
  showDirectionsModal,
  directions,
  routeInfo,
  onClose,
}) => {
  const { colors: c } = useAppTheme();
  if (!showDirectionsModal) return null;

  return (
    <Modal
      visible={showDirectionsModal}
      animationType="slide"
      transparent={true}
      onRequestClose={onClose}
    >
      <View style={styles.modalContainer}>
        <View style={[styles.directionsModal, { backgroundColor: c.surface }]}>
          <View
            style={[styles.directionsHeader, { borderBottomColor: c.border }]}
          >
            <Text style={[styles.directionsTitle, { color: c.textPrimary }]}>
              Turn-by-turn directions
            </Text>
            <TouchableOpacity
              style={[
                styles.closeButton,
                { backgroundColor: c.surfaceVariant },
              ]}
              onPress={onClose}
            >
              <Text
                style={[styles.closeButtonText, { color: c.textSecondary }]}
              >
                ✕
              </Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.directionsScrollView}
            contentContainerStyle={{ paddingBottom: 24 }}
            nestedScrollEnabled
          >
            {routeInfo && (
              <View
                style={[
                  styles.routeSummary,
                  { backgroundColor: c.backgroundLight },
                ]}
              >
                <Text
                  style={[styles.routeSummaryText, { color: c.textPrimary }]}
                >
                  Total: {routeInfo.description}
                </Text>
                <Text
                  style={[
                    styles.routeSummarySafety,
                    { color: routeInfo.color },
                  ]}
                >
                  Safety: {routeInfo.safety?.overall || "Unknown"}
                </Text>
              </View>
            )}
            {directions.map((direction, index) => (
              <View
                key={index}
                style={[styles.directionStep, { borderBottomColor: c.border }]}
              >
                <View
                  style={[styles.stepIndicator, { backgroundColor: c.primary }]}
                >
                  <Text style={styles.stepNumber}>{index + 1}</Text>
                </View>
                <View style={styles.stepContent}>
                  <Text
                    style={[styles.stepInstruction, { color: c.textPrimary }]}
                  >
                    {direction.instruction}
                  </Text>
                  <Text
                    style={[styles.stepDetails, { color: c.textSecondary }]}
                  >
                    {direction.distanceMeters != null
                      ? `${Math.round(direction.distanceMeters)} m`
                      : direction.distance || ""}
                    {direction.durationSeconds != null
                      ? ` • ${Math.max(1, Math.round(direction.durationSeconds / 60))} min`
                      : direction.duration
                        ? ` • ${direction.duration}`
                        : ""}
                  </Text>
                </View>
              </View>
            ))}
            {directions.length === 0 && (
              <Text
                style={[styles.noDirectionsText, { color: c.textSecondary }]}
              >
                No detailed directions available for this route.
              </Text>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  modalContainer: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "flex-end",
  },
  directionsModal: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: "80%",
    minHeight: "40%",
    flexGrow: 1,
  },
  directionsHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 20,
    borderBottomWidth: 1,
  },
  directionsTitle: {
    fontSize: 18,
    fontWeight: "bold",
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  closeButtonText: {
    fontSize: 16,
  },
  directionsScrollView: {
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  routeSummary: {
    padding: 16,
    borderRadius: 8,
    marginHorizontal: 10,
    marginBottom: 10,
  },
  routeSummaryText: {
    fontSize: 16,
    fontWeight: "bold",
  },
  routeSummarySafety: {
    fontSize: 14,
    fontWeight: "600",
    marginTop: 4,
  },
  directionStep: {
    flexDirection: "row",
    padding: 16,
    borderBottomWidth: 1,
    alignItems: "flex-start",
  },
  stepIndicator: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 16,
    flexShrink: 0,
  },
  stepNumber: {
    color: "white",
    fontSize: 12,
    fontWeight: "bold",
  },
  stepContent: {
    flex: 1,
  },
  stepInstruction: {
    fontSize: 16,
    fontWeight: "500",
  },
  stepDetails: {
    fontSize: 14,
    marginTop: 4,
  },
  noDirectionsText: {
    textAlign: "center",
    padding: 20,
    fontSize: 16,
  },
});

export default DirectionsModal;
