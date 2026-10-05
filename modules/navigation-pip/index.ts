import { requireOptionalNativeModule } from "expo";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";

type PipModeEvent = { isInPictureInPicture: boolean };

type NavigationPipNativeModule = {
  isSupported(): boolean;
  isInPictureInPicture(): boolean;
  setEnabled(enabled: boolean, aspectWidth: number, aspectHeight: number): Promise<void>;
  enter(): Promise<boolean>;
  addListener(
    event: "onPictureInPictureModeChanged",
    listener: (event: PipModeEvent) => void,
  ): { remove(): void };
};

// Optional so JS keeps working on builds that predate the native module.
const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<NavigationPipNativeModule>("NavigationPip")
    : null;

/** Portrait window, roughly the shape Google Maps uses. */
const ASPECT_WIDTH = 3;
const ASPECT_HEIGHT = 4;

let inPip = native?.isInPictureInPicture() ?? false;
const listeners = new Set<() => void>();

native?.addListener("onPictureInPictureModeChanged", (event) => {
  if (event.isInPictureInPicture === inPip) return;
  inPip = event.isInPictureInPicture;
  listeners.forEach((listener) => listener());
});

export function isPictureInPictureSupported(): boolean {
  try {
    return native?.isSupported() ?? false;
  } catch {
    return false;
  }
}

/** Auto-enter Picture-in-Picture when the user leaves the app (Home / recents). */
export function setAutoPictureInPicture(enabled: boolean): void {
  native?.setEnabled(enabled, ASPECT_WIDTH, ASPECT_HEIGHT).catch(() => {});
}

export async function enterPictureInPicture(): Promise<boolean> {
  try {
    return (await native?.enter()) ?? false;
  } catch {
    return false;
  }
}

export function getIsInPictureInPicture(): boolean {
  return inPip;
}

export function subscribePictureInPicture(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useIsInPictureInPicture(): boolean {
  return useSyncExternalStore(
    subscribePictureInPicture,
    getIsInPictureInPicture,
    () => false,
  );
}
