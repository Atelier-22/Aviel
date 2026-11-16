"use client";

import { useEffect } from "react";
import { API_BASE_URL } from "@/lib/api";

/**
 * On a free host the API sleeps after 15 quiet minutes and takes 30–60 s to
 * start again. Opening any page (the sign-in page included) asks it to wake
 * straight away, so it is usually up by the time the first message is sent.
 * Once per tab; failures don't matter.
 */
export function WakeServers() {
  useEffect(() => {
    if (sessionStorage.getItem("astraeya-woke")) return;
    sessionStorage.setItem("astraeya-woke", "1");
    void fetch(`${API_BASE_URL}/health`, { cache: "no-store" }).catch(() => undefined);
  }, []);
  return null;
}
