// components/SavedPlacesScreen.js (or screens/SavedPlacesScreen.js)

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useFocusEffect, useNavigation } from "expo-router/react-navigation"; // Import useFocusEffect
import React, { useCallback, useState } from "react";
import {
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAppTheme } from "@/hooks/useAppTheme";

interface SavedLocation {
  id: string;
  title: string;
  subtitle: string;
  coordinate: {
    latitude: number;
    longitude: number;
  };
}

const SavedPlacesScreen = () => {
  const { colors: c, elevation: elev } = useAppTheme();
  const [savedPlaces, setSavedPlaces] = useState<SavedLocation[]>([]);
  const navigation = useNavigation() as {
    navigate: (name: string, params?: object) => void;
  };

  const loadSavedPlaces = useCallback(async () => {
    try {
      const jsonValue = await AsyncStorage.getItem("savedLocations");
      const loadedPlaces: SavedLocation[] =
        jsonValue != null ? JSON.parse(jsonValue) : [];
      setSavedPlaces(loadedPlaces);
    } catch (e) {
      Alert.alert("Error", "Could not load saved places.");
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadSavedPlaces();
      return () => {};
    }, [loadSavedPlaces]),
  );

  const handleDeletePlace = async (id: string) => {
    Alert.alert(
      "Delete Place",
      "Are you sure you want to delete this saved place?",
      [
        {
          text: "Cancel",
          style: "cancel",
        },
        {
          text: "Delete",
          onPress: async () => {
            try {
              const updatedPlaces = savedPlaces.filter(
                (place) => place.id !== id,
              );
              await AsyncStorage.setItem(
                "savedLocations",
                JSON.stringify(updatedPlaces),
              );
              setSavedPlaces(updatedPlaces);
              Alert.alert("Deleted", "Place removed from saved list.");
            } catch (e) {
              console.error("Failed to delete place:", e);
              Alert.alert("Error", "Could not delete place.");
            }
          },
          style: "destructive",
        },
      ],
    );
  };

  const handleViewOnMap = (place: SavedLocation) => {
    navigation.navigate("(tabs)", {
      screen: "navigate",
      params: {
        selectedPlaceForMap: place.coordinate,
        selectedPlaceTitle: place.title,
        selectedPlaceSubtitle: place.subtitle,
      },
    });
  };

  const renderItem = ({ item }: { item: SavedLocation }) => (
    <View
      style={[
        styles.placeItem,
        { backgroundColor: c.cardBackground, ...elev.card },
      ]}
    >
      <View style={styles.placeInfo}>
        <Text style={[styles.placeTitle, { color: c.textPrimary }]}>
          {item.title}
        </Text>
        <Text style={[styles.placeSubtitle, { color: c.textSecondary }]}>
          {item.subtitle}
        </Text>
      </View>
      <View style={styles.actionsContainer}>
        <TouchableOpacity
          style={[styles.actionButton, { backgroundColor: c.primaryLight }]}
          onPress={() => handleViewOnMap(item)}
        >
          <Text style={[styles.actionButtonText, { color: c.textPrimary }]}>
            🗺️ View
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionButton, { backgroundColor: c.primaryLight }]}
          onPress={() => handleDeletePlace(item.id)}
        >
          <Text style={[styles.actionButtonText, { color: c.textPrimary }]}>
            🗑️ Delete
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.background }]}>
      <View
        style={[
          styles.header,
          {
            borderBottomColor: c.border,
            backgroundColor: c.background,
          },
        ]}
      >
        <Text style={[styles.headerTitle, { color: c.textPrimary }]}>
          Your Saved Places
        </Text>
      </View>
      {savedPlaces.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={[styles.emptyText, { color: c.textSecondary }]}>
            No saved places yet.
          </Text>
          <Text style={[styles.emptySubText, { color: c.textSecondary }]}>
            Search for a place and tap 'Save' to add it here!
          </Text>
        </View>
      ) : (
        <FlatList
          data={savedPlaces}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
        />
      )}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    padding: 20,
    borderBottomWidth: 1,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: "bold",
    textAlign: "center",
  },
  listContent: {
    padding: 10,
  },
  placeItem: {
    borderRadius: 8,
    padding: 15,
    marginVertical: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  placeInfo: {
    flex: 1,
    marginRight: 10,
  },
  placeTitle: {
    fontSize: 18,
    fontWeight: "600",
  },
  placeSubtitle: {
    fontSize: 14,
    marginTop: 4,
  },
  actionsContainer: {
    flexDirection: "row",
  },
  actionButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginLeft: 10,
    borderRadius: 5,
  },
  actionButtonText: {
    fontWeight: "bold",
    fontSize: 12,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  emptyText: {
    fontSize: 18,
    marginBottom: 10,
    fontWeight: "bold",
  },
  emptySubText: {
    fontSize: 14,
    textAlign: "center",
  },
});

export default SavedPlacesScreen;
