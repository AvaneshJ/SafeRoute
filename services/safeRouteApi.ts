/**
 * Client for SafeRoute Phase 3–6 FastAPI routing.
 * POST /route/safe → Safest / Balanced / Fastest + explain + confidence
 * POST /route/reroute → live Safe Walk recalculation
 * POST /report/hazard → temporary decaying hazard
 */
import { Platform } from "react-native";
import Constants from "expo-constants";
import { synthesizeTurnSteps, type NavStep } from "@/core/liveNavigation";

export type SafeRouteMode = "safest" | "balanced" | "fastest" | "all";

export type RouteReason = { icon: string; text: string };

export type ConfidenceDetail = {
  confidence: number;
  components?: {
    data_coverage: number;
    report_freshness: number;
    model_agreement: number;
  };
  low_confidence?: boolean;
  advisory?: string | null;
};

export type SafeRouteCard = {
  id?: string;
  type: "safest" | "balanced" | "fastest" | string;
  distance: number;
  eta: number;
  safety: number;
  alpha: number;
  cost: number;
  polyline: [number, number][];
  node_count: number;
  confidence?: number | null;
  reasons?: RouteReason[];
  time_weight?: number;
  explanation?: {
    title?: string;
    reasons?: RouteReason[];
    confidence?: ConfidenceDetail;
    stats?: {
      lighting_pct?: number;
      [key: string]: unknown;
    };
  };
  confidence_detail?: ConfidenceDetail;
};

export type SafeRouteResponse = {
  routes: SafeRouteCard[];
  selected: string;
  safety_engine?: string;
  ml_loaded?: boolean;
  rule_routes?: SafeRouteCard[] | null;
  time_weight?: number;
};

export type RerouteResponse = {
  offer: boolean;
  message: string | null;
  detail: string | null;
  safety_delta: number;
  hazard: Record<string, unknown> | null;
  edges_penalized: number;
  route: SafeRouteCard;
  explanation?: SafeRouteCard["explanation"];
  /** How far the position had to snap to the safety road graph (m). */
  origin_snap_m?: number;
};

export const ROUTE_KIND_COLORS: Record<"safest" | "balanced" | "fastest", string> =
  {
    safest: "#10B981",
    balanced: "#3B82F6",
    fastest: "#94A3B8",
  };

export const ROUTE_KIND_LABELS: Record<"safest" | "balanced" | "fastest", string> =
  {
    safest: "Safest",
    balanced: "Balanced",
    fastest: "Fastest",
  };

function defaultRoutingBaseUrl(): string {
  if (Platform.OS === "android") return "http://10.0.2.2:8000";
  return "http://127.0.0.1:8000";
}

export function getRoutingApiBaseUrl(): string {
  const fromEnv =
    process.env.EXPO_PUBLIC_ROUTING_API_URL ||
    (Constants.expoConfig?.extra as { routingApiUrl?: string } | undefined)
      ?.routingApiUrl;
  return (fromEnv || defaultRoutingBaseUrl()).trim().replace(/\/$/, "");
}

export async function fetchSafeRoutes(
  origin: { latitude: number; longitude: number },
  destination: { latitude: number; longitude: number },
  mode: SafeRouteMode = "all",
  signal?: AbortSignal,
  safetyEngine: "xgboost" | "rule" | "compare" = "xgboost",
): Promise<SafeRouteResponse> {
  const base = getRoutingApiBaseUrl();
  const res = await fetch(`${base}/route/safe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      origin: [origin.latitude, origin.longitude],
      destination: [destination.latitude, destination.longitude],
      mode,
      safety_engine: safetyEngine,
    }),
    signal,
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      detail = err?.detail || detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }

  return (await res.json()) as SafeRouteResponse;
}

export async function fetchRouteExplain(routeId: string): Promise<unknown> {
  const base = getRoutingApiBaseUrl();
  const res = await fetch(`${base}/route/explain/${routeId}`);
  if (!res.ok) throw new Error(`Explain failed: ${res.status}`);
  return res.json();
}

export async function fetchRouteConfidence(routeId: string): Promise<ConfidenceDetail & { id: string; safety: number }> {
  const base = getRoutingApiBaseUrl();
  const res = await fetch(`${base}/route/confidence/${routeId}`);
  if (!res.ok) throw new Error(`Confidence failed: ${res.status}`);
  return res.json();
}

export async function reportTemporaryHazard(body: {
  latitude: number;
  longitude: number;
  category?: string;
  severity?: number;
  note?: string;
}): Promise<{ ok: boolean; hazard: Record<string, unknown> }> {
  const base = getRoutingApiBaseUrl();
  const res = await fetch(`${base}/report/hazard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hazard report failed: ${res.status}`);
  return res.json();
}

export async function fetchLiveReroute(body: {
  position: { latitude: number; longitude: number };
  destination: { latitude: number; longitude: number };
  mode?: SafeRouteMode;
  currentPolyline?: { latitude: number; longitude: number }[];
  currentSafety?: number;
  signal?: AbortSignal;
}): Promise<RerouteResponse> {
  const base = getRoutingApiBaseUrl();
  const res = await fetch(`${base}/route/reroute`, {
    signal: body.signal,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      position: [body.position.latitude, body.position.longitude],
      destination: [body.destination.latitude, body.destination.longitude],
      mode: body.mode ?? "safest",
      current_polyline: (body.currentPolyline || []).map((p) => [
        p.latitude,
        p.longitude,
      ]),
      current_safety: body.currentSafety,
    }),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      detail = err?.detail || detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json();
}

/** Turn-by-turn steps for a SafeRoute polyline, derived from its geometry. */
export function polylineToNavSteps(
  polyline: { latitude: number; longitude: number }[],
  distanceM = 0,
  etaMinutes = 0,
): NavStep[] {
  return synthesizeTurnSteps(polyline, distanceM, etaMinutes);
}
