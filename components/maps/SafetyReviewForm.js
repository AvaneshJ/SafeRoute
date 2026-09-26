// components/SafetyReviewForm.js
import { AreaPlaceSearch } from "@/components/maps/AreaPlaceSearch";
import { useAppTheme } from "@/hooks/useAppTheme";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useState } from "react";
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

/**
 * SafetyReviewForm — area card + search + rating form.
 */
const SafetyReviewForm = ({
  location,
  locationLabel,
  locationSubtitle,
  onLocationChange,
  onUseCurrentLocation,
  onSubmit,
  onCancel,
  showMapTip = true,
}) => {
  const { colors: c } = useAppTheme();
  const [rating, setRating] = useState(3);
  const [comment, setComment] = useState("");
  const [category, setCategory] = useState("general");

  const categories = [
    { value: "general", label: "General Safety" },
    { value: "lighting", label: "Poor Lighting" },
    { value: "harassment", label: "Harassment" },
    { value: "crime", label: "Crime Reports" },
    { value: "security", label: "Security Presence" },
    { value: "crowd", label: "Crowded Area" },
    { value: "infrastructure", label: "Bad Infrastructure" },
  ];

  const coordsLabel =
    location != null
      ? `${Number(location.latitude).toFixed(5)}, ${Number(
          location.longitude,
        ).toFixed(5)}`
      : "—";

  const handleSubmit = () => {
    if (!location) {
      Alert.alert(
        "Pick an area",
        "Search for a place or use your current location before submitting.",
      );
      return;
    }
    if (comment.trim().length < 10) {
      Alert.alert(
        "Error",
        "Please provide a detailed comment (at least 10 characters).",
      );
      return;
    }

    onSubmit(
      location.latitude,
      location.longitude,
      rating,
      comment.trim(),
      category,
    );
    setRating(3);
    setComment("");
    setCategory("general");
  };

  return (
    <View style={styles.formShell}>
      <ScrollView
        style={styles.reviewForm}
        contentContainerStyle={styles.reviewFormContent}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      >
      <View
        style={[
          styles.areaCard,
          {
            backgroundColor: c.primaryContainer,
            borderColor: c.border,
          },
        ]}
        accessibilityRole="summary"
        accessibilityLabel={`Reviewing area ${locationLabel || coordsLabel}`}
      >
        <View style={[styles.areaIcon, { backgroundColor: c.primary }]}>
          <MaterialIcons name="place" size={22} color={c.textOnPrimary} />
        </View>
        <View style={styles.areaCopy}>
          <Text style={[styles.areaKicker, { color: c.primary }]}>
            Reviewing this area
          </Text>
          <Text
            style={[styles.areaTitle, { color: c.textPrimary }]}
            numberOfLines={2}
          >
            {locationLabel || "Choose an area below"}
          </Text>
          <Text
            style={[styles.areaSub, { color: c.textSecondary }]}
            numberOfLines={2}
          >
            {locationSubtitle ||
              (location
                ? `About 100–150 m around ${coordsLabel}. Your report helps people nearby.`
                : "Search for a place, or use your current location.")}
          </Text>
        </View>
      </View>

      <Text style={[styles.searchLabel, { color: c.textPrimary }]}>
        Change area
      </Text>
      <AreaPlaceSearch
        biasCoordinate={location}
        onSelectPlace={(place) => {
          onLocationChange?.({
            coordinate: place.coordinate,
            title: place.title,
            subtitle: `${place.subtitle} · ~150 m around pin`,
          });
        }}
        onUseCurrentLocation={onUseCurrentLocation}
        showUseCurrentLocation={Boolean(onUseCurrentLocation)}
      />

      {showMapTip ? (
        <Text style={[styles.hint, { color: c.textSecondary }]}>
          Tip: On the map you can also long-press the exact road or block to
          review.
        </Text>
      ) : null}

      <Text style={[styles.reviewFormLabel, { color: c.textPrimary }]}>
        How safe do you feel in this area?
      </Text>

      <View style={styles.ratingContainer}>
        {[1, 2, 3, 4, 5].map((star) => (
          <TouchableOpacity
            key={star}
            style={[
              styles.starButton,
              rating >= star && { backgroundColor: c.warning },
            ]}
            onPress={() => setRating(star)}
          >
            <Text
              style={[
                styles.starText,
                { color: c.surfaceVariant },
                rating >= star && styles.starTextActive,
              ]}
            >
              ★
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={[styles.ratingLabel, { color: c.textSecondary }]}>
        {rating === 1
          ? "Very Unsafe"
          : rating === 2
            ? "Unsafe"
            : rating === 3
              ? "Neutral"
              : rating === 4
                ? "Safe"
                : "Very Safe"}
      </Text>

      <Text style={[styles.reviewFormLabel, { color: c.textPrimary }]}>
        Category
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.categoryScroll}
        contentContainerStyle={styles.categoryScrollContent}
      >
        {categories.map((cat) => (
          <TouchableOpacity
            key={cat.value}
            style={[
              styles.categoryButton,
              { backgroundColor: c.surfaceVariant },
              category === cat.value && { backgroundColor: c.primary },
            ]}
            onPress={() => setCategory(cat.value)}
          >
            <Text
              style={[
                styles.categoryButtonText,
                { color: c.textSecondary },
                category === cat.value && styles.categoryButtonTextActive,
              ]}
            >
              {cat.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <Text style={[styles.reviewFormLabel, { color: c.textPrimary }]}>
        Details (Help others stay safe)
      </Text>
      <TextInput
        style={[
          styles.commentInput,
          {
            borderColor: c.border,
            color: c.textPrimary,
          },
        ]}
        placeholder="Describe what makes this area safe or unsafe..."
        placeholderTextColor={c.textTertiary}
        value={comment}
        onChangeText={setComment}
        multiline
        numberOfLines={4}
        maxLength={500}
      />

      <Text style={[styles.charCount, { color: c.textSecondary }]}>
        {comment.length}/500
      </Text>
      </ScrollView>

      <View style={styles.reviewFormButtons}>
        <TouchableOpacity
          style={[styles.cancelButton, { backgroundColor: c.surfaceVariant }]}
          onPress={onCancel}
        >
          <Text style={[styles.cancelButtonText, { color: c.textSecondary }]}>
            Cancel
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.submitButton, { backgroundColor: c.success }]}
          onPress={handleSubmit}
        >
          <Text style={styles.submitButtonText}>Submit Review</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  formShell: {
    flex: 1,
    minHeight: 0,
  },
  reviewForm: {
    flex: 1,
  },
  reviewFormContent: {
    padding: 20,
    paddingBottom: 12,
  },
  areaCard: {
    flexDirection: "row",
    gap: 12,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 12,
  },
  areaIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  areaCopy: {
    flex: 1,
    gap: 2,
  },
  areaKicker: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  areaTitle: {
    fontSize: 16,
    fontWeight: "700",
  },
  areaSub: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
  searchLabel: {
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 6,
  },
  hint: {
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 12,
  },
  reviewFormLabel: {
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 12,
    marginTop: 8,
  },
  ratingContainer: {
    flexDirection: "row",
    justifyContent: "center",
    marginBottom: 8,
  },
  starButton: {
    padding: 8,
    marginHorizontal: 4,
    borderRadius: 20,
  },
  starText: {
    fontSize: 24,
  },
  starTextActive: {
    color: "white",
  },
  ratingLabel: {
    textAlign: "center",
    fontSize: 14,
    marginBottom: 20,
  },
  categoryScroll: {
    marginBottom: 20,
  },
  categoryScrollContent: {
    alignItems: "center",
  },
  categoryButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginRight: 8,
  },
  categoryButtonText: {
    fontSize: 12,
  },
  categoryButtonTextActive: {
    color: "white",
  },
  commentInput: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    textAlignVertical: "top",
    minHeight: 100,
  },
  charCount: {
    textAlign: "right",
    fontSize: 12,
    marginTop: 4,
    marginBottom: 20,
  },
  reviewFormButtons: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 16,
    gap: 0,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    marginRight: 8,
    alignItems: "center",
  },
  cancelButtonText: {
    fontWeight: "600",
  },
  submitButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    marginLeft: 8,
    alignItems: "center",
  },
  submitButtonText: {
    color: "white",
  },
});

export default SafetyReviewForm;
