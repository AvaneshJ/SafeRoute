// components/SafetyReviewModal.js
import { useAppTheme } from "@/hooks/useAppTheme";
import { Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import SafetyReviewForm from "./SafetyReviewForm";

const SafetyReviewModal = ({
  showReviewModal,
  reviewLocation,
  reviewPlaceLabel,
  reviewPlaceSubtitle,
  onLocationChange,
  onUseCurrentLocation,
  onSubmit,
  onClose,
}) => {
  const { colors: c } = useAppTheme();
  return (
    <Modal
      visible={showReviewModal}
      animationType="slide"
      transparent={true}
      onRequestClose={onClose}
    >
      <View style={styles.modalContainer}>
        <View style={[styles.reviewModal, { backgroundColor: c.surface }]}>
          <View
            style={[styles.reviewModalHeader, { borderBottomColor: c.border }]}
          >
            <Text style={[styles.reviewModalTitle, { color: c.textPrimary }]}>
              Report this area
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

          <View style={styles.reviewFormSlot}>
            <SafetyReviewForm
              location={reviewLocation}
              locationLabel={reviewPlaceLabel}
              locationSubtitle={reviewPlaceSubtitle}
              onLocationChange={onLocationChange}
              onUseCurrentLocation={onUseCurrentLocation}
              onSubmit={onSubmit}
              onCancel={onClose}
              showMapTip
            />
          </View>
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
  reviewModal: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: "80%",
    minHeight: "60%",
    flexGrow: 1,
  },
  reviewModalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 20,
    borderBottomWidth: 1,
  },
  reviewFormSlot: {
    flex: 1,
    minHeight: 0,
  },
  reviewModalTitle: {
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
});

export default SafetyReviewModal;
