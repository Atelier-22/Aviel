/**
 * The live-mode greeting's words, kept for this browser tab once the chat has
 * asked the server to prepare them, so live mode can start speaking without a
 * round trip. The audio itself is cached on the server.
 */

const KEY = "astraeya:live-greeting";

export function rememberGreeting(text: string) {
  try {
    sessionStorage.setItem(KEY, text);
  } catch {
    /* storage unavailable: live mode will ask the server instead */
  }
}

export function readCachedGreeting(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}
