import assert from "node:assert/strict";
import { calculateSafetyScore } from "../core/safetyScore";
import { calculateTrustScore, weightedReportContribution } from "../core/trust";
import { densityBucket, crowdSafetyFeature, buildAnonymousPing } from "../core/crowdDensity";
import { encodeGeohash } from "../core/geohash";
import { heatColor } from "../core/heatmap";
import {
  aStar,
  bidirectionalAStar,
  generateRoutes,
  yenKShortest,
  type RoadGraph,
} from "../core/routeOptimization";
import { initialSafeWalk, reduceSafeWalk } from "../core/safeWalk";
import { initialSos, reduceSos, SOS_HOLD_MS } from "../core/sos";
import { evaluateSensors } from "../core/incidentDetection";
import {
  safeWalkArrivalText,
  safeWalkStartSms,
} from "../core/guardianSafety";

const example = calculateSafetyScore({
  hour: 22.5,
  dayOfWeek: 5,
  communityRating: 4,
  crowdDensity: crowdSafetyFeature("moderate"),
  streetLighting: 0.7,
  visibilityKm: 8,
  policeDistanceM: 800,
  cctv: 0.5,
  verifiedIncidents30d: 1,
  historicalReports: 2,
  xgbRisk: 0.4,
  xgbConfidence: 0.8,
});

const graph: RoadGraph = {
  nodes: {
    A: { id: "A", latitude: 23.25, longitude: 77.4 },
    B: { id: "B", latitude: 23.26, longitude: 77.4 },
    C: { id: "C", latitude: 23.26, longitude: 77.41 },
  },
  edges: [
    {
      id: "AB",
      from: "A",
      to: "B",
      lengthM: 1000,
      speedKmh: 30,
      safetyScore: 100,
      lighting: 1,
      crowd: 0.85,
    },
    {
      id: "BC",
      from: "B",
      to: "C",
      lengthM: 1000,
      speedKmh: 30,
      safetyScore: 100,
      lighting: 1,
      crowd: 0.85,
    },
    {
      id: "AC",
      from: "A",
      to: "C",
      lengthM: 800,
      speedKmh: 40,
      safetyScore: 10,
      lighting: 0.2,
      crowd: 0.2,
    },
  ],
};

const safest = aStar(graph, "A", "C", "safest");
const fastest = bidirectionalAStar(graph, "A", "C", "fastest");
const kPaths = yenKShortest(graph, "A", "C", 3, "balanced");
const three = generateRoutes(graph, "A", "C");

assert.equal(safest?.nodeIds.join(">"), "A>B>C");
assert.ok(fastest);
assert.ok(kPaths.length >= 1);
assert.equal(three.safest?.nodeIds.join(">"), "A>B>C");

const trust = calculateTrustScore({
  accurateReports: 2,
  verifiedReports: 1,
  participationWeeks: 3,
  spamReports: 0,
  fakeReports: 0,
  locationMismatches: 0,
  deletedReports: 0,
});
assert.equal(trust.score, 90);
assert.equal(trust.level, "guardian");
assert.ok(weightedReportContribution({ trustScore: 90, ageDays: 0, verified: true }) > 1);

assert.equal(densityBucket(0), "empty");
assert.equal(densityBucket(4), "moderate");
assert.equal(buildAnonymousPing(23.25, 77.4, 1_700_000_000_000).geohash.length, 7);
assert.equal(encodeGeohash(23.2599, 77.4126, 7).length, 7);
assert.ok(heatColor(10).startsWith("#"));
assert.notEqual(heatColor(10), heatColor(90));

let walk = initialSafeWalk();
walk = reduceSafeWalk(walk, { type: "SELECT_DESTINATION", nowMs: 0 });
assert.equal(walk.state, "inviting");
walk = reduceSafeWalk(walk, { type: "GUARDIAN_ACCEPTED", nowMs: 0 });
assert.equal(walk.state, "active");
// Past grace (20s), then accumulate stillness in ≤5s steps until 60s
walk = reduceSafeWalk(walk, {
  type: "LOCATION",
  movedMeters: 0,
  etaMinutes: 12,
  nowMs: 20_000,
});
for (let t = 25_000; t <= 85_000; t += 5_000) {
  walk = reduceSafeWalk(walk, {
    type: "LOCATION",
    movedMeters: 0,
    etaMinutes: 12,
    nowMs: t,
  });
}
assert.equal(walk.state, "check_in_pending");
walk = reduceSafeWalk(walk, { type: "COUNTDOWN_ELAPSED" });
assert.equal(walk.state, "sos");
// Walker confirms they're fine after the guardian was alerted
assert.equal(
  reduceSafeWalk(walk, { type: "CHECKIN_CONFIRMED", nowMs: 90_000 }).state,
  "active",
);
assert.equal(reduceSafeWalk(walk, { type: "USER_CANCELLED" }).state, "cancelled");

// Wall-clock path
let walk2 = initialSafeWalk();
walk2 = reduceSafeWalk(walk2, { type: "SELECT_DESTINATION", nowMs: 0 });
walk2 = reduceSafeWalk(walk2, { type: "GUARDIAN_ACCEPTED", nowMs: 0 });
walk2 = reduceSafeWalk(walk2, { type: "STATIONARY_TIMEOUT" });
assert.equal(walk2.state, "check_in_pending");

let sos = initialSos();
sos = reduceSos(sos, { type: "HOLD_START", nowMs: 0 });
sos = reduceSos(sos, { type: "HOLD_RELEASE", nowMs: 500 });
assert.equal(sos.phase, "idle");
sos = reduceSos(sos, { type: "HOLD_START", nowMs: 0 });
sos = reduceSos(sos, { type: "HOLD_RELEASE", nowMs: SOS_HOLD_MS });
assert.equal(sos.phase, "countdown");

const finding = evaluateSensors([
  {
    timestampMs: 0,
    speedMps: 0.4,
    accelG: 1,
    gyroRadPerSec: 0.1,
    latitude: 0,
    longitude: 0,
    headingDeg: 10,
    safetyScore: 80,
  },
  {
    timestampMs: 1000,
    speedMps: 5,
    accelG: 1,
    gyroRadPerSec: 0.1,
    latitude: 0,
    longitude: 0,
    headingDeg: 10,
    safetyScore: 80,
  },
]);
assert.equal(finding?.kind, "sudden_sprint");

const startSms = safeWalkStartSms({
  walkerName: "Avanesh",
  latitude: 19.1136,
  longitude: 72.8697,
});
assert.equal(
  startSms,
  "Avanesh started a Safe Walk. Last known location: https://maps.google.com/?q=19.1136,72.8697. You'll receive another message on arrival or if a safety check-in fails.",
);
assert.equal(safeWalkArrivalText("Avanesh"), "Avanesh arrived safely.");
assert.ok(!startSms.includes("ETA"));
assert.ok(!startSms.includes("Destination"));

console.log(JSON.stringify({ example, trust, safest: safest?.nodeIds, fastest: fastest?.nodeIds, paths: kPaths.map((p) => p.nodeIds) }, null, 2));
