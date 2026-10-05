/**
 * Guardian alerts — native SMS composer (+ Share fallback).
 * Real phones open Messages; emulator often needs Share fallback.
 */

import { Linking, Platform, Share } from "react-native";
import {
  safeWalkArrivalText,
  safeWalkStartSms,
  safetyMapsLink,
} from "@/core/guardianSafety";

export function normalizePhoneDigits(phone: string): string {
  return String(phone || "").replace(/\D/g, "");
}

export function buildSmsUrl(phone: string, body: string): string {
  const digits = normalizePhoneDigits(phone);
  const sep = Platform.OS === "ios" ? "&" : "?";
  return `sms:${digits}${sep}body=${encodeURIComponent(body)}`;
}

/**
 * Opens the SMS app prefilled for the guardian. Falls back to the system
 * share sheet if SMS cannot be opened (common on emulators).
 */
export async function notifyGuardianSms(
  phone: string,
  body: string,
): Promise<{ opened: boolean; via: "sms" | "share" | "none" }> {
  const digits = normalizePhoneDigits(phone);
  if (!digits) return { opened: false, via: "none" };

  const url = buildSmsUrl(digits, body);
  try {
    const supported = await Linking.canOpenURL(url);
    if (supported) {
      await Linking.openURL(url);
      return { opened: true, via: "sms" };
    }
  } catch {
    // fall through to Share
  }

  try {
    await Share.share({ message: body });
    return { opened: true, via: "share" };
  } catch {
    return { opened: false, via: "none" };
  }
}

export function mapsLink(lat: number, lng: number): string {
  return safetyMapsLink(lat, lng);
}

export function safeWalkStartedMessage(input: {
  walkerName?: string;
  lat: number;
  lng: number;
}): string {
  return safeWalkStartSms({
    walkerName: input.walkerName,
    latitude: input.lat,
    longitude: input.lng,
  });
}

export function safeWalkArrivedMessage(input: {
  walkerName?: string;
}): string {
  return safeWalkArrivalText(input.walkerName);
}

export function safeWalkCheckinFailedMessage(input: {
  walkerName?: string;
  lat: number;
  lng: number;
}): string {
  const who = input.walkerName?.trim() || "Someone you trust";
  return (
    `SafeRoute alert: ${who} did not confirm a safety check-in. ` +
    `Last known location (map pin): ${mapsLink(input.lat, input.lng)}`
  );
}

export function sosMessage(input: {
  lat: number | null;
  lng: number | null;
}): string {
  if (input.lat != null && input.lng != null) {
    return (
      `SafeRoute SOS — I need help. ` +
      `My location (map pin): ${mapsLink(input.lat, input.lng)}`
    );
  }
  return "SafeRoute SOS — I need help. Location is unavailable.";
}

export function guardianInviteMessage(input: {
  guardianName: string;
  inviteUrl?: string;
}): string {
  return (
    `Hi ${input.guardianName}, I've added you as a Trusted Guardian on SafeRoute. ` +
    (input.inviteUrl
      ? `Tap to accept: ${input.inviteUrl} `
      : "") +
    `If I start a Safe Walk or need help, you may get alerts with my map location. ` +
    `Please keep an eye out. — Sent via SafeRoute`
  );
}
