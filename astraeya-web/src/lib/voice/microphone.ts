"use client";

/**
 * Which microphone Astraeya listens with.
 *
 * By default the computer's own built-in microphone, even when headphones
 * are plugged in: headset and Bluetooth microphones often pick speech up
 * poorly, and Windows tends to switch to them by itself. The person can pick
 * any other microphone in Settings → Voice; that choice is kept in this
 * browser, because device ids only mean something on this machine.
 */

const KEY = "astraeya:microphone";

/** Headset-style microphones, used only if chosen or if nothing else exists. */
const HEADSET = /headset|hands-?free|bluetooth|airpods|buds|headphone|earphone|\bbt\b/i;
/** Names Windows, macOS and laptops give the built-in microphone. */
const BUILT_IN = /built-?in|internal|microphone array|integrated|realtek|intel|laptop|macbook/i;

export function savedMicrophone(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Null goes back to automatic (the built-in microphone). */
export function saveMicrophone(deviceId: string | null) {
  try {
    if (deviceId) localStorage.setItem(KEY, deviceId);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: automatic it is */
  }
}

/** Real microphones (not the "default" and "communications" aliases). Names appear once permission is given. */
export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications");
}

/** Whether a microphone looks like part of a headset or earbuds. */
export function isHeadset(label: string): boolean {
  return HEADSET.test(label);
}

/** The microphone to use: the chosen one if present, else the built-in one, else the system default (undefined). */
export function pickMicrophone(devices: { deviceId: string; label: string }[], saved: string | null): string | undefined {
  if (saved && devices.some((d) => d.deviceId === saved)) return saved;
  const builtIn =
    devices.find((d) => BUILT_IN.test(d.label) && !isHeadset(d.label)) ?? devices.find((d) => d.label && !isHeadset(d.label));
  return builtIn?.deviceId;
}

export async function preferredMicrophone(): Promise<string | undefined> {
  return pickMicrophone(await listMicrophones(), savedMicrophone());
}

/**
 * Starts speech recognition on a particular microphone where the browser
 * allows it (recent Chrome and Edge accept an audio track); otherwise on the
 * system default. Returns the stream it opened, to be stopped afterwards.
 */
export async function startRecognitionOn(
  recognition: { start: (track?: MediaStreamTrack) => void },
  deviceId: string | undefined
): Promise<MediaStream | null> {
  if (deviceId && navigator.mediaDevices?.getUserMedia) {
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const track = stream.getAudioTracks()[0];
      if (track) {
        recognition.start(track);
        return stream;
      }
    } catch {
      stream?.getTracks().forEach((t) => t.stop());
    }
  }
  recognition.start();
  return null;
}
