/**
 * Google Places lookups for nearby police stations / hospitals, including the
 * phone number of a chosen place (Place Details) so users can call directly.
 */

import Constants from "expo-constants";
import { haversineMeters, type LatLng } from "@/core/liveNavigation";

export type NearbyPlaceType = "police" | "hospital";

export type NearbyPlace = {
  id: string;
  title: string;
  subtitle: string;
  coordinate: LatLng;
  /** Straight-line distance from the search origin, in km. */
  distance: number;
  type: NearbyPlaceType;
  /** Undefined = not looked up yet, null = Google has no number for it. */
  phone?: string | null;
};

export type NearbyPlacesResult =
  | { ok: true; places: NearbyPlace[] }
  | { ok: false; error: string };

export function placesApiKey(): string {
  return (
    process.env.EXPO_PUBLIC_GOOGLE_PLACES_API_KEY ||
    Constants.expoConfig?.extra?.googlePlacesApiKey ||
    Constants.expoConfig?.android?.config?.googleMaps?.apiKey ||
    Constants.expoConfig?.ios?.config?.googleMapsApiKey ||
    ""
  );
}

/** Closest operational places of `type`, nearest first. */
export async function fetchNearbyPlaces(
  type: NearbyPlaceType,
  origin: LatLng,
  limit = 8,
): Promise<NearbyPlacesResult> {
  const key = placesApiKey();
  if (!key) return { ok: false, error: "Google Places API key is not configured." };

  const fallbackTitle = type === "police" ? "Police Station" : "Hospital";
  try {
    // rankby=distance returns closest first; radius cannot be combined with it.
    const url =
      `https://maps.googleapis.com/maps/api/place/nearbysearch/json` +
      `?location=${origin.latitude},${origin.longitude}` +
      `&rankby=distance&type=${type}&key=${key}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      return { ok: false, error: data.error_message || data.status };
    }

    const results: any[] = Array.isArray(data.results) ? data.results : [];
    const places = results
      .filter(
        (place) =>
          place?.business_status == null ||
          place.business_status === "OPERATIONAL",
      )
      .map((place): NearbyPlace | null => {
        const lat = Number(place?.geometry?.location?.lat);
        const lng = Number(place?.geometry?.location?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        const coordinate = { latitude: lat, longitude: lng };
        return {
          id: String(place.place_id || `${lat},${lng}`),
          title: String(place.name || fallbackTitle),
          subtitle: String(place.vicinity || place.formatted_address || "Nearby"),
          coordinate,
          distance: haversineMeters(origin, coordinate) / 1000,
          type,
        };
      })
      .filter((p): p is NearbyPlace => p != null && Number.isFinite(p.distance))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);

    return { ok: true, places };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Network error",
    };
  }
}

const phoneCache = new Map<string, string | null>();

/** Phone number for a Google place_id, cached for the app session. */
export async function fetchPlacePhone(placeId: string): Promise<string | null> {
  if (phoneCache.has(placeId)) return phoneCache.get(placeId) ?? null;
  const key = placesApiKey();
  // Ids without a real place_id are "lat,lng" fallbacks.
  if (!key || placeId.includes(",")) return null;

  try {
    const url =
      `https://maps.googleapis.com/maps/api/place/details/json` +
      `?place_id=${encodeURIComponent(placeId)}` +
      `&fields=formatted_phone_number,international_phone_number&key=${key}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.status !== "OK") return null;
    const phone =
      data.result?.formatted_phone_number ||
      data.result?.international_phone_number ||
      null;
    phoneCache.set(placeId, phone);
    return phone;
  } catch {
    return null;
  }
}

/** Digits-only form safe for a `tel:` URL. */
export function telUrl(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

export function formatMeters(meters: number): string {
  if (meters < 1000) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
  return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`;
}
