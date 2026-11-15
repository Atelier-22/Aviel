import { notFound } from "next/navigation";
import { ChatWindow } from "@/components/chat/chat-window";
import { serverApiFetch } from "@/lib/api-server";
import type { MadeFile, MediaJob } from "@/components/chat/made-files";

type ConversationDetail = {
  id: string;
  title: string;
  messages: {
    id: string;
    role: string;
    content: string;
    createdAt: string;
    files?: MadeFile[];
    jobs?: MediaJob[];
  }[];
};

export default async function ChatPage({
  params,
}: {
  params: { id: string };
}) {
  // The backend scopes this lookup to the authenticated user, so a conversation
  // belonging to someone else comes back as a 404 here — same as one that
  // doesn't exist, which is what we want to show either way.
  const conversation = await serverApiFetch<ConversationDetail>(
    `/conversations/${params.id}`
  );

  if (!conversation) return notFound();

  return (
    <ChatWindow
      conversationId={conversation.id}
      title={conversation.title}
      initialMessages={conversation.messages.map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        content: m.content,
        createdAt: m.createdAt,
        files: m.files,
        jobs: m.jobs,
      }))}
    />
  );
}
