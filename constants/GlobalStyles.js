// constants/GlobalStyles.js — re-exports SafeRoute 2.0 tokens for map/legacy screens
import { StyleSheet } from "react-native";
import { colors as tokens, elevation } from "./theme";

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: tokens.background,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: tokens.charcoal,
  },
  loadingText: {
    fontSize: 20,
    fontWeight: "bold",
    color: tokens.textOnPrimary,
    textAlign: "center",
  },
  loadingSubtext: {
    fontSize: 16,
    color: tokens.textTertiary,
    marginTop: 5,
    textAlign: "center",
  },
  shadow: {
    ...elevation.card,
  },
  shadowSmall: {
    shadowColor: "#111827",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
});

/** @type {typeof tokens} */
const colors = tokens;

export const GlobalStyles = Object.assign(styles, { colors });
