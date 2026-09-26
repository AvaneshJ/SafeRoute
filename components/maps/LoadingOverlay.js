// components/LoadingOverlay.js
import { useAppTheme } from "@/hooks/useAppTheme";
import { StyleSheet, Text, View } from "react-native";

const LoadingOverlay = ({ isVisible, message, subMessage }) => {
  const { colors: c, elevation: elev } = useAppTheme();
  if (!isVisible) return null;

  return (
    <View style={styles.loadingOverlay}>
      <View style={[styles.loadingContent, elev.card]}>
        <Text style={styles.loadingText}>{message}</Text>
        {subMessage && (
          <Text style={[styles.loadingSubText, { color: c.textLight }]}>
            {subMessage}
          </Text>
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  loadingOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 100,
  },
  loadingContent: {
    backgroundColor: "rgba(0, 0, 0, 0.8)",
    paddingHorizontal: 30,
    paddingVertical: 20,
    borderRadius: 10,
    alignItems: "center",
  },
  loadingText: {
    fontSize: 18,
    fontWeight: "bold",
    color: "white",
    textAlign: "center",
  },
  loadingSubText: {
    fontSize: 14,
    textAlign: "center",
    marginTop: 5,
  },
});

export default LoadingOverlay;
