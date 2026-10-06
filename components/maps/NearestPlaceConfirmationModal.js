// components/maps/NearestPlaceConfirmationModal.js
import { useAppTheme } from "@/hooks/useAppTheme";
import { telUrl } from "@/services/nearbyPlaces";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as Linking from "expo-linking";
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

const NearestPlaceConfirmationModal = ({
  isVisible,
  placeDetails,
  onConfirmNavigation,
  onCancel,
}) => {
  const { colors: c, elevation: elev } = useAppTheme();
  if (!isVisible || !placeDetails) {
    return null;
  }

  const placeTypeDisplay =
    placeDetails.type === "police" ? "Police Station" : "Hospital";

  return (
    <Modal
      visible={isVisible}
      animationType="fade"
      transparent={true}
      onRequestClose={onCancel}
    >
      <View style={styles.overlay}>
        <View
          style={[
            styles.modalContainer,
            { backgroundColor: c.surface, ...elev.card },
          ]}
        >
          <Text style={[styles.title, { color: c.textPrimary }]}>
            Nearest {placeTypeDisplay} Found!
          </Text>
          <Text style={[styles.placeName, { color: c.primary }]}>
            {placeDetails.title}
          </Text>
          <Text style={[styles.placeAddress, { color: c.textSecondary }]}>
            {placeDetails.subtitle}
          </Text>
          {Number.isFinite(placeDetails.distance) ? (
              <Text style={[styles.placeDistance, { color: c.textPrimary }]}>
                {placeDetails.distance < 1
                  ? `Approximately ${Math.round(placeDetails.distance * 1000)} m away`
                  : `Approximately ${placeDetails.distance.toFixed(1)} km away`}
              </Text>
            ) : null}

          {placeDetails.phone === undefined ? (
            <ActivityIndicator size="small" color={c.textSecondary} />
          ) : placeDetails.phone ? (
            <TouchableOpacity
              style={[styles.callButton, { borderColor: c.primary }]}
              onPress={() => Linking.openURL(telUrl(placeDetails.phone))}
              accessibilityRole="button"
              accessibilityLabel={`Call ${placeDetails.title} at ${placeDetails.phone}`}
            >
              <MaterialIcons name="call" size={18} color={c.primary} />
              <Text style={[styles.callButtonText, { color: c.primary }]}>
                {placeDetails.phone}
              </Text>
            </TouchableOpacity>
          ) : (
            <Text style={[styles.noPhone, { color: c.textSecondary }]}>
              No phone number listed
            </Text>
          )}

          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[
                styles.cancelButton,
                { backgroundColor: c.surfaceVariant },
              ]}
              onPress={onCancel}
            >
              <Text
                style={[styles.cancelButtonText, { color: c.textSecondary }]}
              >
                Cancel
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.navigateButton, { backgroundColor: c.success }]}
              onPress={onConfirmNavigation}
            >
              <Text style={styles.navigateButtonText}>Start Navigation</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    justifyContent: "center",
    alignItems: "center",
  },
  modalContainer: {
    borderRadius: 15,
    padding: 25,
    width: "85%",
    alignItems: "center",
  },
  title: {
    fontSize: 20,
    fontWeight: "bold",
    marginBottom: 10,
    textAlign: "center",
  },
  placeName: {
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 5,
    textAlign: "center",
  },
  placeAddress: {
    fontSize: 14,
    marginBottom: 5,
    textAlign: "center",
  },
  placeDistance: {
    fontSize: 14,
    fontWeight: "bold",
    marginTop: 10,
    marginBottom: 20,
  },
  callButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1.5,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  callButtonText: {
    fontWeight: "600",
    fontSize: 15,
  },
  noPhone: {
    fontSize: 13,
  },
  buttonRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    width: "100%",
    marginTop: 15,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
    marginRight: 10,
  },
  cancelButtonText: {
    fontWeight: "bold",
    fontSize: 16,
  },
  navigateButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
    marginLeft: 10,
  },
  navigateButtonText: {
    color: "white",
    fontWeight: "bold",
    fontSize: 16,
  },
});

export default NearestPlaceConfirmationModal;
