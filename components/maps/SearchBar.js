// components/SearchBar.js

import { useAppTheme } from "@/hooks/useAppTheme";
import { MaterialIcons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import React from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * SearchBar Component
 * Provides a search input field and displays search results in a dropdown.
 */
const SearchBar = ({
  searchQuery,
  setSearchQuery,
  searchResults,
  showSearchResults,
  onSearch,
  onSelectResult,
  onClearSearch,
  onBookmarkPress,
}) => {
  const insets = useSafeAreaInsets();
  const { colors: c, elevation: elev, isDark } = useAppTheme();
  const debounceTimeout = React.useRef(null);

  const handleSearchChange = (text) => {
    setSearchQuery(text);
    if (debounceTimeout.current) {
      clearTimeout(debounceTimeout.current);
    }
    debounceTimeout.current = setTimeout(() => {
      onSearch(text);
    }, 500);
  };

  const glassBg = isDark ? "rgba(21,26,45,0.78)" : "rgba(255,255,255,0.72)";
  const glassBorder = isDark
    ? "rgba(255,255,255,0.12)"
    : "rgba(255,255,255,0.85)";

  return (
    <View
      style={[styles.searchContainer, { top: Math.max(insets.top, 12) + 8 }]}
    >
      <BlurView
        intensity={48}
        tint={isDark ? "dark" : "light"}
        style={[
          styles.searchInputContainer,
          { backgroundColor: glassBg, borderColor: glassBorder, ...elev.card },
        ]}
      >
        <MaterialIcons
          name="search"
          size={22}
          color={c.primary}
          style={styles.searchIcon}
        />
        <TextInput
          style={[styles.searchInput, { color: c.textPrimary }]}
          placeholder="Search for a safe destination"
          placeholderTextColor={c.textSecondary}
          value={searchQuery}
          onChangeText={handleSearchChange}
          returnKeyType="search"
          onSubmitEditing={() => onSearch(searchQuery)}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity style={styles.clearButton} onPress={onClearSearch}>
            <Text style={[styles.clearButtonText, { color: c.textSecondary }]}>
              ✕
            </Text>
          </TouchableOpacity>
        )}
        {onBookmarkPress ? (
          <TouchableOpacity
            style={styles.bookmarkButton}
            onPress={onBookmarkPress}
            accessibilityLabel="Saved places"
          >
            <MaterialIcons name="bookmark" size={22} color={c.primary} />
          </TouchableOpacity>
        ) : null}
      </BlurView>

      {showSearchResults && searchResults.length > 0 && (
        <View
          style={[
            styles.searchResultsContainer,
            { backgroundColor: c.surface, ...elev.card },
          ]}
        >
          <ScrollView style={styles.searchResults}>
            {searchResults.map((result) => (
              <TouchableOpacity
                key={result.id}
                style={[
                  styles.searchResultItem,
                  { borderBottomColor: c.border },
                ]}
                onPress={() => onSelectResult(result)}
              >
                <View
                  style={[
                    styles.searchResultIcon,
                    { backgroundColor: c.surfaceVariant },
                  ]}
                >
                  <Text style={styles.searchResultIconText}>📍</Text>
                </View>
                <View style={styles.searchResultText}>
                  <Text
                    style={[styles.searchResultTitle, { color: c.textPrimary }]}
                  >
                    {result.title}
                  </Text>
                  <Text
                    style={[
                      styles.searchResultSubtitle,
                      { color: c.textSecondary },
                    ]}
                  >
                    {result.subtitle}
                  </Text>
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  searchContainer: {
    position: "absolute",
    left: 16,
    right: 16,
    zIndex: 30,
  },
  searchInputContainer: {
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
    borderRadius: 28,
    borderWidth: 1,
  },
  searchIcon: {
    marginLeft: 16,
  },
  searchInput: {
    flex: 1,
    height: 52,
    paddingHorizontal: 10,
    fontSize: 16,
  },
  bookmarkButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 4,
  },
  clearButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  clearButtonText: {
    fontSize: 16,
  },
  searchResultsContainer: {
    position: "absolute",
    top: 55,
    left: 0,
    right: 0,
    zIndex: 9,
    borderRadius: 8,
    maxHeight: 300,
    overflow: "hidden",
  },
  searchResults: {
    maxHeight: 300,
  },
  searchResultItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    borderBottomWidth: 1,
  },
  searchResultIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  searchResultIconText: {
    fontSize: 16,
  },
  searchResultText: {
    flex: 1,
  },
  searchResultTitle: {
    fontSize: 16,
    fontWeight: "500",
  },
  searchResultSubtitle: {
    fontSize: 14,
    marginTop: 2,
  },
});

export default SearchBar;
