"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { LiveVoiceScreen } from "@/components/voice/live-voice-screen";

/**
 * Live voice, as its own route.
 *
 * A route rather than a panel inside the chat window: it is a full-screen,
 * immersive mode with its own back gesture and its own entry in history, so
 * leaving it should be a navigation rather than a state flag. It also means a
 * phone's back button exits voice mode instead of the whole conversation.
 */
export default function VoicePage() {
  return (
    <Suspense fallback={null}>
      <VoiceRoute />
    </Suspense>
  );
}

function VoiceRoute() {
  const router = useRouter();
  const params = useSearchParams();

  const conversationId = params.get("conversation") ?? undefined;
  const sessionId = params.get("session") ?? undefined;

  return (
    <LiveVoiceScreen
      conversationId={conversationId}
      sessionId={sessionId}
      onExit={(spokenIn) => {
        // Always back to the conversation that was just spoken, fresh from
        // the server, so everything said in live mode is there in the chat
        // and the chat carries straight on from it.
        const id = spokenIn ?? conversationId;
        if (id) {
          router.replace(`/chat/${id}`);
          router.refresh();
        } else {
          router.replace("/chat");
        }
      }}
    />
  );
}
