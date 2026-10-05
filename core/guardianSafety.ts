export type SafetyLocation = {
  latitude: number;
  longitude: number;
  accuracyM?: number | null;
  recordedAtMs?: number;
};

export type GuardianInviteStatus = "pending" | "accepted" | "revoked";
export type SafetySessionKind = "safe_walk" | "live_share";
export type SafetySessionState =
  | "inviting"
  | "active"
  | "check_in_pending"
  | "sos"
  | "completed"
  | "cancelled";

export type SafetyEventType =
  | "started"
  | "location"
  | "checkin_requested"
  | "checkin_ok"
  | "checkin_failed"
  | "guardian_acknowledged"
  | "arrived"
  | "ended"
  | "cancelled";

export type EmergencyEventType =
  | "activated"
  | "location"
  | "guardian_acknowledged"
  | "resolved"
  | "cancelled";

export type DeliveryStatus =
  | "sent"
  | "failed"
  | "no_push_token"
  | "invalid_push_token";

export type NotificationDelivery = {
  userId: string;
  notificationId: string;
  status: DeliveryStatus;
  sms_required: boolean;
  ticketIds: string[];
  error?: string;
};

export type GuardianInviteRequest = {
  guardianUserId?: string | null;
  email?: string | null;
  phone?: string | null;
  displayName?: string | null;
  relationship?: string | null;
};

export type GuardianInviteResponse = {
  inviteId: string;
  inviteToken: string;
  status: "pending";
  expiresAtMs: number;
  delivery: NotificationDelivery | null;
  sms_required: boolean;
};

export type AcceptGuardianInviteRequest = {
  inviteId: string;
  inviteToken: string;
};

export type AcceptGuardianInviteResponse = {
  guardianId: string;
  ownerId: string;
  guardianUserId: string;
  status: "accepted";
};

export type RevokeGuardianRequest = { guardianId: string };
export type RevokeGuardianResponse = {
  guardianId: string;
  status: "revoked";
};

export type SafeWalkStartRequest = {
  destination: SafetyLocation;
  guardianUserId?: string;
  guardianUserIds?: string[];
  eventId?: string;
  etaMinutes?: number | null;
  destinationLabel?: string | null;
  location?: SafetyLocation | null;
  routePath?: Array<{ latitude: number; longitude: number }> | null;
};

export type LiveShareStartRequest = {
  /** Omit or leave empty to share with every accepted guardian. */
  guardianUserIds?: string[];
  eventId?: string;
  expiresAtMs?: number | null;
  location?: SafetyLocation | null;
  destination?: SafetyLocation | null;
  destinationLabel?: string | null;
  etaMinutes?: number | null;
  routePath?: Array<{ latitude: number; longitude: number }> | null;
  travelMode?: string | null;
  walkerName?: string | null;
};

export type SafetySessionStartResponse = {
  sessionId: string;
  state: "inviting" | "active";
  participantIds: string[];
  deliveries: NotificationDelivery[];
  sms_required: boolean;
};

export type SafetyEventRequest = {
  sessionId: string;
  eventId: string;
  type: SafetyEventType;
  location?: SafetyLocation | null;
  etaMinutes?: number | null;
  data?: Record<string, string | number | boolean | null>;
};

export type SafetyEventResponse = {
  sessionId: string;
  eventId: string;
  duplicate: boolean;
  state: SafetySessionState;
  deliveries: NotificationDelivery[];
  sms_required: boolean;
};

export type SosRequest = {
  eventId?: string;
  latitude: number;
  longitude: number;
  accuracyM?: number | null;
  batteryPct: number | null;
  networkType: string | null;
  silent: boolean;
  siren?: boolean;
  audioPath: string | null;
  snapshotPath: string | null;
  safeWalkId: string | null;
  guardianUserIds?: string[];
};

export type SosResponse = {
  emergencyId: string;
  eventId: string;
  duplicate: boolean;
  deliveries: NotificationDelivery[];
  sms_required: boolean;
  /** @deprecated Prefer sms_required. */
  smsFallback: boolean;
};

export type EmergencyEventRequest = {
  emergencyId: string;
  eventId: string;
  type: EmergencyEventType;
  location?: SafetyLocation | null;
  data?: Record<string, string | number | boolean | null>;
};

export type MarkNotificationReadRequest = { notificationId: string };
export type MarkNotificationReadResponse = {
  notificationId: string;
  readAtMs: number;
};

export const GUARDIAN_INVITE_BASE_URL = "https://saferoute-8bc4f.web.app/invite";

export function guardianInviteUrl(inviteId: string, token: string): string {
  return `${GUARDIAN_INVITE_BASE_URL}?inviteId=${encodeURIComponent(inviteId)}&token=${encodeURIComponent(token)}`;
}

/** Evenly thins a polyline, always keeping both endpoints. */
export function downsamplePath<T extends { latitude: number; longitude: number }>(
  path: T[],
  maxPoints: number,
): Array<{ latitude: number; longitude: number }> {
  const points = path.map(({ latitude, longitude }) => ({ latitude, longitude }));
  if (points.length <= maxPoints || maxPoints < 2) return points;
  const step = (points.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, i) => points[Math.round(i * step)]);
}

export function safetyMapsLink(latitude: number, longitude: number): string {
  return `https://maps.google.com/?q=${latitude},${longitude}`;
}

export function safeWalkStartSms(input: {
  walkerName?: string;
  latitude: number;
  longitude: number;
}): string {
  const who = input.walkerName?.trim() || "Someone you trust";
  return (
    `${who} started a Safe Walk. Last known location: ` +
    `${safetyMapsLink(input.latitude, input.longitude)}. You'll receive another ` +
    `message on arrival or if a safety check-in fails.`
  );
}

export function safeWalkArrivalText(walkerName?: string): string {
  return `${walkerName?.trim() || "Someone you trust"} arrived safely.`;
}
