import { haversineMeters, type LatLng } from "@/core/liveNavigation";
import {
  fetchNearbyPlaces,
  fetchPlacePhone,
  type NearbyPlace,
} from "@/services/nearbyPlaces";
import { useEffect, useRef, useState } from "react";

/** Re-query Places only after moving this far (each lookup is a billed call). */
const REFRESH_AFTER_M = 400;
/** Back-off before retrying after a failed lookup. */
const RETRY_AFTER_MS = 60_000;

/**
 * Nearest police station to a moving position, with its phone number once
 * Place Details returns it. `distanceM` is recomputed on every position change.
 */
export function useNearestPolice(position: LatLng | null, enabled: boolean) {
  const [station, setStation] = useState<NearbyPlace | null>(null);
  const lastQueryAtRef = useRef<LatLng | null>(null);
  const lastFailureAtRef = useRef(0);
  const inFlightRef = useRef(false);
  const generationRef = useRef(0);

  const lat = position?.latitude;
  const lng = position?.longitude;

  useEffect(() => {
    if (!enabled) {
      generationRef.current++;
      lastQueryAtRef.current = null;
      inFlightRef.current = false;
      setStation(null);
      return;
    }
    if (lat == null || lng == null || inFlightRef.current) return;

    const here = { latitude: lat, longitude: lng };
    const last = lastQueryAtRef.current;
    if (last && haversineMeters(last, here) < REFRESH_AFTER_M) return;
    if (Date.now() - lastFailureAtRef.current < RETRY_AFTER_MS) return;

    const generation = generationRef.current;
    inFlightRef.current = true;
    void (async () => {
      const result = await fetchNearbyPlaces("police", here, 1);
      if (generation !== generationRef.current) return;
      inFlightRef.current = false;
      const nearest = result.ok ? result.places[0] : undefined;
      if (!nearest) {
        lastFailureAtRef.current = Date.now();
        return;
      }
      lastQueryAtRef.current = here;
      setStation((prev) =>
        prev?.id === nearest.id ? { ...nearest, phone: prev.phone } : nearest,
      );
      const phone = await fetchPlacePhone(nearest.id);
      if (generation !== generationRef.current) return;
      setStation((prev) => (prev?.id === nearest.id ? { ...prev, phone } : prev));
    })();
  }, [enabled, lat, lng]);

  const distanceM =
    station && lat != null && lng != null
      ? haversineMeters({ latitude: lat, longitude: lng }, station.coordinate)
      : null;

  return { station, distanceM };
}
