import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False while the page is made on the server and during hydration, true once
 * the browser has taken over. Anything that depends on the device's clock or
 * time zone (a greeting, a message's time) waits for this, because the server
 * runs in UTC: rendering it there gives different text from the browser, and
 * React rejects the page (errors #418, #423, #425).
 */
export function useMounted(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}
