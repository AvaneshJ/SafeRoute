/**
 * Load community reports for map heat / pins (Firestore + optional seed).
 */
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { db } from "@/config/firebase";
import { encodeGeohash } from "@/core/geohash";

export type CommunityMapReport = {
  id: string;
  latitude: number;
  longitude: number;
  /** 1–5 stars for heat layer (5 = safer / positive). */
  rating: number;
  comment: string;
  category: string;
  timestamp: number;
  userId: string;
  status: string;
};

function severityToRating(severity: number): number {
  return Math.min(5, Math.max(1, 6 - Math.round(severity)));
}

/** Neighbor geohash7 prefixes around a point (self + 8 neighbors approx via truncation). */
export function geohashPrefixes(lat: number, lon: number, precision = 5): string[] {
  const full = encodeGeohash(lat, lon, 7);
  const prefix = full.slice(0, precision);
  return [prefix];
}

/**
 * Fetch recent community reports near a map center.
 * Uses geohash prefix range query (precision 5 ≈ city district).
 */
export async function fetchNearbyCommunityReports(
  latitude: number,
  longitude: number,
  maxDocs = 120,
): Promise<CommunityMapReport[]> {
  const prefix = encodeGeohash(latitude, longitude, 5);
  const end = `${prefix}\uf8ff`;
  try {
    const q = query(
      collection(db, "reports"),
      where("geohash", ">=", prefix),
      where("geohash", "<=", end),
      orderBy("geohash"),
      limit(maxDocs),
    );
    const snap = await getDocs(q);
    const out: CommunityMapReport[] = [];
    for (const doc of snap.docs) {
      const d = doc.data();
      const lat = Number(d.latitude);
      const lon = Number(d.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const status = String(d.status || "pending");
      if (status === "rejected" || status === "expired") continue;
      const severity = Number(d.severity) || 3;
      const created = d.createdAt?.toMillis?.() ?? Date.now();
      out.push({
        id: doc.id,
        latitude: lat,
        longitude: lon,
        rating: severityToRating(severity),
        comment: String(d.note || ""),
        category: String(d.category || "other"),
        timestamp: created,
        userId: String(d.authorId || "community"),
        status,
      });
    }
    return out;
  } catch (err) {
    console.warn("fetchNearbyCommunityReports failed:", err);
    return [];
  }
}
