/**
 * Live turn-by-turn navigation helpers — snap-to-route, maneuver tracking,
 * synthesized turns for raw polylines, and on-map turn arrow geometry.
 *
 * Step semantics follow Google Directions: a step's instruction describes the
 * maneuver at the *start* of that step. The HUD therefore shows the next
 * step's instruction with the along-route distance to where it begins.
 */

export type LatLng = { latitude: number; longitude: number };

export type NavStep = {
  instruction: string;
  /** Google Directions maneuver string, e.g. "turn-left" */
  maneuver: string | null;
  distanceMeters: number;
  durationSeconds: number;
  start: LatLng;
  end: LatLng;
  coordinates: LatLng[];
};

export type TurnArrow = {
  /** Polyline along the road, ~25 m before to ~15 m after the turn */
  shaft: LatLng[];
  /** Triangle polygon for the arrowhead at the shaft's end */
  head: LatLng[];
};

export type LiveNavSnapshot = {
  /** Index of the step currently being walked (last maneuver passed). */
  stepIndex: number;
  /** Upcoming maneuver instruction. */
  instruction: string;
  maneuver: string | null;
  /** MaterialIcons name for the turn card */
  maneuverIcon: string;
  /** Along-route distance to the upcoming maneuver. */
  distanceToManeuverMeters: number;
  distanceToManeuverLabel: string;
  remainingMeters: number;
  remainingKm: number;
  remainingMinutes: number;
  /** Degrees clockwise from north — for camera + arrow */
  bearing: number;
  snapped: LatLng;
  /** Progress along the route polyline; feed back as previousAlongMeters. */
  alongMeters: number;
  /** Perpendicular distance from the GPS fix to the route. */
  distanceFromRouteMeters: number;
  traveledCoordinates: LatLng[];
  remainingCoordinates: LatLng[];
  turnArrow: TurnArrow | null;
  arrived: boolean;
  offRoute: boolean;
};

const EARTH_M = 6371000;
/** Whole trip arrival radius. */
const DESTINATION_ARRIVE_M = 35;
/** Off-route if farther than this from the polyline. */
export const OFF_ROUTE_M = 50;
/** Forward-only snapping window around the previous progress. */
const SNAP_BACKTRACK_M = 30;
const SNAP_LOOKAHEAD_M = 400;
/** Metres of match distance traded per metre of jump ahead along the route. */
const SNAP_AHEAD_PENALTY = 0.05;
/** Draw the on-map turn arrow once the turn is this close. */
const TURN_ARROW_SHOW_M = 250;
const TURN_ARROW_BEFORE_M = 25;
const TURN_ARROW_AFTER_M = 15;
const TURN_ARROW_HEAD_LEN_M = 9;
const TURN_ARROW_HEAD_HALF_WIDTH_M = 7;
/** Synthesized turns: bearing measured over this distance each side of a vertex. */
const TURN_WINDOW_M = 20;
const SLIGHT_TURN_DEG = 30;
const TURN_MERGE_M = 20;

const TURN_ICONS = new Set([
  "turn-left",
  "turn-right",
  "turn-slight-left",
  "turn-slight-right",
  "turn-sharp-left",
  "turn-sharp-right",
  "u-turn-left",
  "u-turn-right",
  "fork-left",
  "fork-right",
  "ramp-left",
  "ramp-right",
  "roundabout-left",
  "roundabout-right",
  "merge",
]);

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a → b in degrees [0, 360). */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const φ1 = toRad(a.latitude);
  const φ2 = toRad(b.latitude);
  const Δλ = toRad(b.longitude - a.longitude);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Signed smallest rotation from bearing a to bearing b, in (-180, 180]. Positive = right. */
function signedAngle(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Small-distance offset of a point along a bearing (flat-earth approximation). */
function offsetPoint(p: LatLng, bearing: number, meters: number): LatLng {
  const dLat = (meters * Math.cos(toRad(bearing))) / 111320;
  const dLon =
    (meters * Math.sin(toRad(bearing))) /
    (111320 * Math.max(0.01, Math.cos(toRad(p.latitude))));
  return { latitude: p.latitude + dLat, longitude: p.longitude + dLon };
}

export function formatDistanceLabel(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "—";
  if (meters < 1000) {
    if (meters >= 100) return `${Math.round(meters / 10) * 10} m`;
    return `${Math.max(1, Math.round(meters))} m`;
  }
  const km = meters / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/** MaterialIcons-safe glyph for the turn card. */
export function maneuverToIcon(
  maneuver: string | null,
  instruction: string,
): string {
  const m = (maneuver || "").toLowerCase();
  const t = instruction.toLowerCase();
  const side = (fallback: "left" | "right" = "left"): "left" | "right" =>
    m.includes("right") || /\bright\b/.test(t)
      ? "right"
      : m.includes("left") || /\bleft\b/.test(t)
        ? "left"
        : fallback;

  if (m.includes("uturn") || t.includes("u-turn") || t.includes("u turn"))
    return `u-turn-${side()}`;
  if (m.includes("roundabout") || t.includes("roundabout"))
    return `roundabout-${side()}`;
  if (m.includes("merge") || t.includes("merge")) return "merge";
  if (m.includes("fork") || t.includes("fork")) return `fork-${side()}`;
  if (m.includes("ramp") || t.includes("ramp")) return `ramp-${side()}`;
  if (m.includes("sharp") || t.includes("sharp ")) return `turn-sharp-${side()}`;
  if (
    m.includes("slight") ||
    t.includes("slight ") ||
    m.includes("keep") ||
    t.includes("keep ")
  )
    return `turn-slight-${side()}`;
  if (m === "turn-left" || m === "turn-right" || t.includes("turn "))
    return `turn-${side()}`;
  if (m.includes("left") || /\bleft\b/.test(t)) return "turn-left";
  if (m.includes("right") || /\bright\b/.test(t)) return "turn-right";
  if (t.includes("destination") || t.includes("arrive")) return "flag";
  return "straight";
}

// ---------------------------------------------------------------------------
// Route geometry
// ---------------------------------------------------------------------------

type RouteGeometry = {
  /** cum[i] = distance from route[0] to route[i] */
  cum: number[];
  total: number;
};

const geometryCache = new WeakMap<LatLng[], RouteGeometry>();

function routeGeometry(route: LatLng[]): RouteGeometry {
  const cached = geometryCache.get(route);
  if (cached) return cached;
  const cum = new Array<number>(route.length);
  let d = 0;
  for (let i = 0; i < route.length; i++) {
    if (i > 0) d += haversineMeters(route[i - 1], route[i]);
    cum[i] = d;
  }
  const geom = { cum, total: d };
  geometryCache.set(route, geom);
  return geom;
}

type ClosestResult = {
  index: number;
  point: LatLng;
  distanceMeters: number;
  /** Fraction along segment index→index+1 */
  t: number;
};

function projectOnSegment(p: LatLng, a: LatLng, b: LatLng): ClosestResult {
  const latScale = Math.cos(toRad(p.latitude));
  const ax = a.longitude * latScale;
  const ay = a.latitude;
  const bx = b.longitude * latScale;
  const by = b.latitude;
  const px = p.longitude * latScale;
  const py = p.latitude;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const point = {
    latitude: a.latitude + (b.latitude - a.latitude) * t,
    longitude: a.longitude + (b.longitude - a.longitude) * t,
  };
  return {
    index: 0,
    point,
    distanceMeters: haversineMeters(p, point),
    t,
  };
}

function closestOnSegments(
  position: LatLng,
  route: LatLng[],
  fromSeg: number,
  toSeg: number,
): ClosestResult {
  let best: ClosestResult = {
    index: fromSeg,
    point: route[fromSeg],
    distanceMeters: Infinity,
    t: 0,
  };
  for (let i = fromSeg; i <= toSeg && i < route.length - 1; i++) {
    const hit = projectOnSegment(position, route[i], route[i + 1]);
    if (hit.distanceMeters < best.distanceMeters) {
      best = { ...hit, index: i };
    }
  }
  return best;
}

export function closestPointOnRoute(
  position: LatLng,
  route: LatLng[],
): ClosestResult {
  if (route.length === 0) {
    return { index: 0, point: position, distanceMeters: 0, t: 0 };
  }
  if (route.length === 1) {
    return {
      index: 0,
      point: route[0],
      distanceMeters: haversineMeters(position, route[0]),
      t: 0,
    };
  }
  return closestOnSegments(position, route, 0, route.length - 2);
}

/**
 * Snap near the previous progress so overlapping / parallel parts of the line
 * can't steal the projection. Falls back to a global search only when the
 * user has clearly rejoined a different part of the route.
 */
function closestForward(
  position: LatLng,
  route: LatLng[],
  geom: RouteGeometry,
  previousAlong: number,
): ClosestResult {
  const lo = previousAlong - SNAP_BACKTRACK_M;
  const hi = previousAlong + SNAP_LOOKAHEAD_M;
  let fromSeg = 0;
  while (fromSeg < route.length - 2 && geom.cum[fromSeg + 1] < lo) fromSeg++;
  let toSeg = fromSeg;
  while (toSeg < route.length - 2 && geom.cum[toSeg + 1] <= hi) toSeg++;

  // Within the window, favour matches near current progress so a slightly
  // closer parallel/return leg further along can't win.
  let windowed: ClosestResult | null = null;
  let bestCost = Infinity;
  for (let i = fromSeg; i <= toSeg && i < route.length - 1; i++) {
    const hit = { ...projectOnSegment(position, route[i], route[i + 1]), index: i };
    const ahead = Math.max(0, alongFor(route, geom, hit) - previousAlong);
    const cost = hit.distanceMeters + SNAP_AHEAD_PENALTY * ahead;
    if (cost < bestCost) {
      bestCost = cost;
      windowed = hit;
    }
  }
  if (!windowed) return closestPointOnRoute(position, route);
  if (windowed.distanceMeters <= OFF_ROUTE_M) return windowed;

  const global = closestPointOnRoute(position, route);
  if (
    global.distanceMeters <= OFF_ROUTE_M &&
    global.distanceMeters < windowed.distanceMeters - 20
  ) {
    return global;
  }
  return windowed;
}

function alongFor(route: LatLng[], geom: RouteGeometry, c: ClosestResult) {
  if (c.index >= route.length - 1) return geom.cum[route.length - 1] ?? 0;
  const seg = geom.cum[c.index + 1] - geom.cum[c.index];
  return geom.cum[c.index] + seg * c.t;
}

/** Distance along polyline from route[0] to the closest projection. */
export function distanceAlongRoute(
  route: LatLng[],
  closest: ClosestResult,
): number {
  if (!route.length) return 0;
  return alongFor(route, routeGeometry(route), closest);
}

export function totalRouteMeters(route: LatLng[]): number {
  return route.length ? routeGeometry(route).total : 0;
}

function pointAtAlong(
  route: LatLng[],
  geom: RouteGeometry,
  along: number,
): { point: LatLng; index: number } {
  if (route.length === 1) return { point: route[0], index: 0 };
  const d = Math.max(0, Math.min(geom.total, along));
  let i = 0;
  while (i < route.length - 2 && geom.cum[i + 1] < d) i++;
  const seg = geom.cum[i + 1] - geom.cum[i];
  const t = seg > 0 ? (d - geom.cum[i]) / seg : 0;
  const a = route[i];
  const b = route[i + 1];
  return {
    point: {
      latitude: a.latitude + (b.latitude - a.latitude) * t,
      longitude: a.longitude + (b.longitude - a.longitude) * t,
    },
    index: i,
  };
}

function sliceByAlong(
  route: LatLng[],
  geom: RouteGeometry,
  from: number,
  to: number,
): LatLng[] {
  const a = pointAtAlong(route, geom, from);
  const b = pointAtAlong(route, geom, to);
  const out = [a.point];
  for (let i = a.index + 1; i <= b.index; i++) out.push(route[i]);
  out.push(b.point);
  return out;
}

function sliceRouteFrom(
  route: LatLng[],
  closest: ClosestResult,
): { traveled: LatLng[]; remaining: LatLng[] } {
  const traveled = route.slice(0, closest.index + 1);
  traveled.push(closest.point);
  const remaining = [closest.point, ...route.slice(closest.index + 1)];
  return { traveled, remaining };
}

function bearingAlongRoute(route: LatLng[], closest: ClosestResult): number {
  const look = Math.min(route.length - 1, closest.index + 1);
  const a = closest.point;
  let b = route[look];
  // Prefer a point ~25m ahead for stable bearing
  let acc = 0;
  for (let i = closest.index; i < route.length - 1 && acc < 25; i++) {
    const from = i === closest.index ? closest.point : route[i];
    const to = route[i + 1];
    acc += haversineMeters(from, to);
    b = to;
  }
  if (haversineMeters(a, b) < 1 && closest.index > 0) {
    return bearingDegrees(route[closest.index - 1], closest.point);
  }
  return bearingDegrees(a, b);
}

// ---------------------------------------------------------------------------
// Maneuvers
// ---------------------------------------------------------------------------

type Maneuver = {
  /** Step whose start is this maneuver */
  stepIndex: number;
  along: number;
  point: LatLng;
  instruction: string;
  maneuver: string | null;
  icon: string;
};

const maneuverCache = new WeakMap<
  NavStep[],
  { route: LatLng[]; list: Maneuver[] }
>();

/** Locate every step start (except the first) along the route, in order. */
function routeManeuvers(
  route: LatLng[],
  geom: RouteGeometry,
  steps: NavStep[],
): Maneuver[] {
  const cached = maneuverCache.get(steps);
  if (cached && cached.route === route) return cached.list;

  const list: Maneuver[] = [];
  let fromSeg = 0;
  let lastAlong = 0;
  for (let s = 1; s < steps.length; s++) {
    const target = steps[s].start;
    let best: ClosestResult | null = null;
    for (let i = fromSeg; i < route.length - 1; i++) {
      const hit = projectOnSegment(target, route[i], route[i + 1]);
      if (!best || hit.distanceMeters < best.distanceMeters) {
        best = { ...hit, index: i };
      }
      // Stop once a tight match is well behind us, so later passes over the
      // same spot (loops) don't win.
      if (best.distanceMeters < 8 && geom.cum[i] - geom.cum[best.index] > 100) {
        break;
      }
    }
    if (!best) break;
    const along = Math.max(lastAlong, alongFor(route, geom, best));
    lastAlong = along;
    fromSeg = best.index;
    const step = steps[s];
    list.push({
      stepIndex: s,
      along,
      point: best.point,
      instruction: step.instruction,
      maneuver: step.maneuver,
      icon: maneuverToIcon(step.maneuver, step.instruction),
    });
  }
  maneuverCache.set(steps, { route, list });
  return list;
}

function buildTurnArrow(
  route: LatLng[],
  geom: RouteGeometry,
  maneuverAlong: number,
  currentAlong: number,
): TurnArrow | null {
  const from = Math.max(currentAlong, maneuverAlong - TURN_ARROW_BEFORE_M);
  const to = Math.min(geom.total, maneuverAlong + TURN_ARROW_AFTER_M);
  if (to - from < 5) return null;
  const shaft = sliceByAlong(route, geom, from, to);
  if (shaft.length < 2) return null;
  const end = shaft[shaft.length - 1];
  const tail = pointAtAlong(route, geom, Math.max(from, to - 6)).point;
  const dir = bearingDegrees(tail, end);
  const head = [
    offsetPoint(end, dir, TURN_ARROW_HEAD_LEN_M),
    offsetPoint(end, dir - 90, TURN_ARROW_HEAD_HALF_WIDTH_M),
    offsetPoint(end, dir + 90, TURN_ARROW_HEAD_HALF_WIDTH_M),
  ];
  return { shaft, head };
}

/**
 * Legacy step resolver kept for callers that only track a step index.
 * Returns the index of the step whose start the user has most recently passed.
 */
export function resolveStepIndex(
  steps: NavStep[],
  route: LatLng[],
  alongMeters: number,
  _position?: LatLng,
  _previousIndex?: number,
): number {
  if (!steps.length || !route.length) return 0;
  const list = routeManeuvers(route, routeGeometry(route), steps);
  let idx = 0;
  for (const m of list) {
    if (m.along <= alongMeters + 2) idx = m.stepIndex;
    else break;
  }
  return idx;
}

export type UpdateLiveNavInput = {
  position: LatLng;
  /** Device course if available; otherwise route bearing is used */
  heading?: number | null;
  route: LatLng[];
  steps: NavStep[];
  previousStepIndex: number;
  /** Previous snapshot's alongMeters — enables forward-only snapping. */
  previousAlongMeters?: number | null;
  /** Total trip duration from Directions (minutes) for ETA scaling */
  totalDurationMin: number;
  totalDistanceKm: number;
};

export function updateLiveNavigation(input: UpdateLiveNavInput): LiveNavSnapshot {
  const {
    position,
    heading,
    route,
    steps,
    previousAlongMeters,
    totalDurationMin,
    totalDistanceKm,
  } = input;

  const empty: LiveNavSnapshot = {
    stepIndex: 0,
    instruction: "Continue on route",
    maneuver: null,
    maneuverIcon: "straight",
    distanceToManeuverMeters: 0,
    distanceToManeuverLabel: "—",
    remainingMeters: (totalDistanceKm || 0) * 1000,
    remainingKm: totalDistanceKm || 0,
    remainingMinutes: totalDurationMin || 0,
    bearing: typeof heading === "number" ? heading : 0,
    snapped: position,
    alongMeters: 0,
    distanceFromRouteMeters: 0,
    traveledCoordinates: [],
    remainingCoordinates: route,
    turnArrow: null,
    arrived: false,
    offRoute: false,
  };

  if (!route.length) return empty;

  const geom = routeGeometry(route);
  const closest =
    typeof previousAlongMeters === "number" &&
    Number.isFinite(previousAlongMeters) &&
    route.length > 1
      ? closestForward(position, route, geom, previousAlongMeters)
      : closestPointOnRoute(position, route);
  const along = alongFor(route, geom, closest);
  const total = Math.max(geom.total, 1);
  const remainingMeters = Math.max(0, total - along);
  const { traveled, remaining } = sliceRouteFrom(route, closest);
  const routeBearing = bearingAlongRoute(route, closest);
  const bearing =
    typeof heading === "number" && Number.isFinite(heading) && heading >= 0
      ? heading
      : routeBearing;

  const offRoute = closest.distanceMeters > OFF_ROUTE_M;
  const dest = route[route.length - 1];
  const arrived =
    haversineMeters(position, dest) <= DESTINATION_ARRIVE_M ||
    (!offRoute && remainingMeters <= 15);

  const maneuvers = steps.length ? routeManeuvers(route, geom, steps) : [];
  const next = maneuvers.find((m) => m.along > along + 2) ?? null;
  const stepIndex = arrived
    ? Math.max(0, steps.length - 1)
    : next
      ? Math.max(0, next.stepIndex - 1)
      : Math.max(0, steps.length - 1);

  let instruction: string;
  let maneuver: string | null;
  let maneuverIcon: string;
  let distanceToManeuverMeters: number;
  let turnArrow: TurnArrow | null = null;

  if (arrived) {
    instruction = "You have arrived";
    maneuver = null;
    maneuverIcon = "flag";
    distanceToManeuverMeters = 0;
  } else if (next) {
    instruction = next.instruction || "Continue on route";
    maneuver = next.maneuver;
    maneuverIcon = next.icon;
    distanceToManeuverMeters = Math.max(0, next.along - along);
    if (
      TURN_ICONS.has(next.icon) &&
      distanceToManeuverMeters <= TURN_ARROW_SHOW_M
    ) {
      turnArrow = buildTurnArrow(route, geom, next.along, along);
    }
  } else {
    instruction = "Continue to your destination";
    maneuver = null;
    maneuverIcon = remainingMeters <= 150 ? "flag" : "straight";
    distanceToManeuverMeters = remainingMeters;
  }

  const remainingKm = remainingMeters / 1000;
  const fracLeft = remainingMeters / total;
  const remainingMinutes = Math.max(
    1,
    Math.round((totalDurationMin || remainingKm * 12) * fracLeft),
  );

  return {
    stepIndex,
    instruction,
    maneuver,
    maneuverIcon,
    distanceToManeuverMeters,
    distanceToManeuverLabel: arrived
      ? "Arrived"
      : formatDistanceLabel(distanceToManeuverMeters),
    remainingMeters,
    remainingKm,
    remainingMinutes: arrived ? 0 : remainingMinutes,
    bearing,
    snapped: closest.point,
    alongMeters: along,
    distanceFromRouteMeters: closest.distanceMeters,
    traveledCoordinates: traveled,
    remainingCoordinates: remaining,
    turnArrow,
    arrived,
    offRoute,
  };
}

// ---------------------------------------------------------------------------
// Step sources
// ---------------------------------------------------------------------------

const CARDINALS = [
  "north",
  "northeast",
  "east",
  "southeast",
  "south",
  "southwest",
  "west",
  "northwest",
];

function cardinal(bearing: number): string {
  return CARDINALS[Math.round(bearing / 45) % 8];
}

function turnFromDelta(delta: number): {
  instruction: string;
  maneuver: string;
} {
  const a = Math.abs(delta);
  const side = delta > 0 ? "right" : "left";
  if (a >= 165) return { instruction: "Make a U-turn", maneuver: `uturn-${side}` };
  if (a >= 120)
    return { instruction: `Sharp ${side}`, maneuver: `turn-sharp-${side}` };
  if (a >= 60) return { instruction: `Turn ${side}`, maneuver: `turn-${side}` };
  return { instruction: `Slight ${side}`, maneuver: `turn-slight-${side}` };
}

/**
 * Build turn-by-turn steps from a bare polyline (SafeRoute A* output) by
 * detecting bearing changes. Street names aren't available, so instructions
 * are direction-only ("Turn left", "Slight right").
 */
export function synthesizeTurnSteps(
  polyline: LatLng[],
  distanceM = 0,
  etaMinutes = 0,
): NavStep[] {
  const route: LatLng[] = [];
  for (const p of polyline) {
    const last = route[route.length - 1];
    if (!last || haversineMeters(last, p) >= 0.5) route.push(p);
  }
  if (route.length < 2) return [];

  const geom = routeGeometry(route);
  const total = Math.max(geom.total, 1);

  type Turn = { index: number; along: number; delta: number };
  const turns: Turn[] = [];
  for (let i = 1; i < route.length - 1; i++) {
    const along = geom.cum[i];
    if (along < 10 || total - along < 10) continue;
    const before = pointAtAlong(route, geom, along - TURN_WINDOW_M).point;
    const after = pointAtAlong(route, geom, along + TURN_WINDOW_M).point;
    if (
      haversineMeters(before, route[i]) < 3 ||
      haversineMeters(route[i], after) < 3
    ) {
      continue;
    }
    const delta = signedAngle(
      bearingDegrees(before, route[i]),
      bearingDegrees(route[i], after),
    );
    if (Math.abs(delta) < SLIGHT_TURN_DEG) continue;
    const last = turns[turns.length - 1];
    if (last && along - last.along < TURN_MERGE_M) {
      if (Math.abs(delta) > Math.abs(last.delta)) {
        turns[turns.length - 1] = { index: i, along, delta };
      }
    } else {
      turns.push({ index: i, along, delta });
    }
  }

  const etaSec = Math.max(0, etaMinutes * 60);
  const scale = distanceM > 0 ? distanceM / total : 1;
  const starts = [{ index: 0, along: 0, delta: 0 }, ...turns];

  return starts.map((s, k) => {
    const nextStart = starts[k + 1];
    const endIndex = nextStart ? nextStart.index : route.length - 1;
    const endAlong = nextStart ? nextStart.along : geom.total;
    const segLen = Math.max(0, endAlong - s.along);
    let instruction: string;
    let maneuver: string | null;
    if (k === 0) {
      const ahead = pointAtAlong(route, geom, Math.min(geom.total, 20)).point;
      instruction = `Head ${cardinal(bearingDegrees(route[0], ahead))}`;
      maneuver = null;
    } else {
      ({ instruction, maneuver } = turnFromDelta(s.delta));
    }
    return {
      instruction,
      maneuver,
      distanceMeters: Math.round(segLen * scale),
      durationSeconds: Math.round((etaSec * segLen) / total),
      start: route[s.index],
      end: route[endIndex],
      coordinates: route.slice(s.index, endIndex + 1),
    };
  });
}

function stripHtml(html: string): string {
  return html
    .replace(/<div[^>]*>/gi, ". ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+\.\s/g, ". ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Map Google step JSON → NavStep (requires decodePolyline). */
export function mapGoogleStepToNavStep(
  step: any,
  decodePolyline: (encoded: string) => LatLng[],
): NavStep {
  const coords =
    step?.polyline?.points != null
      ? decodePolyline(step.polyline.points)
      : [
          {
            latitude: step.start_location.lat,
            longitude: step.start_location.lng,
          },
          {
            latitude: step.end_location.lat,
            longitude: step.end_location.lng,
          },
        ];

  return {
    instruction: stripHtml(String(step.html_instructions || "")),
    maneuver: step.maneuver ? String(step.maneuver) : null,
    distanceMeters: Number(step.distance?.value) || 0,
    durationSeconds: Number(step.duration?.value) || 0,
    start: {
      latitude: step.start_location.lat,
      longitude: step.start_location.lng,
    },
    end: {
      latitude: step.end_location.lat,
      longitude: step.end_location.lng,
    },
    coordinates: coords,
  };
}

/**
 * Detailed route geometry from step polylines. The overview polyline is
 * simplified and doesn't line up with step boundaries, which skews snapping
 * and maneuver distances.
 */
export function stepsToRouteCoordinates(steps: NavStep[]): LatLng[] {
  const out: LatLng[] = [];
  for (const step of steps) {
    for (const p of step.coordinates) {
      const last = out[out.length - 1];
      if (
        !last ||
        Math.abs(last.latitude - p.latitude) > 1e-7 ||
        Math.abs(last.longitude - p.longitude) > 1e-7
      ) {
        out.push(p);
      }
    }
  }
  return out;
}
