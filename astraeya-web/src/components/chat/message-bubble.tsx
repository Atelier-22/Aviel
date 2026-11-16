"use client";

import { AstraeyaMark } from "@/components/logo";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Cloud, HardDrive } from "lucide-react";
import { CodeBlock } from "./code-block";
import { MessageActions } from "./message-actions";
import { MadeFiles, type MadeFile, type MediaJob } from "./made-files";
import { SvgPreview, extractSvg } from "./svg-preview";
import { useSettingsGroup } from "@/lib/settings/store";

export function MessageBubble({
  id,
  role,
  content,
  timestamp,
  conversationId,
  isStreaming,
  onRetry,
  onBranch,
  model,
  processedLocally,
  routingReason,
  showTypingIndicator = true,
  isLatest = false,
  files = [],
  jobs = [],
  onRegenerateMedia,
  status,
}: {
  id?: string;
  role: "user" | "assistant";
  content: string;
  timestamp?: Date | string;
  conversationId?: string;
  isStreaming?: boolean;
  onRetry?: () => void;
  onBranch?: () => void;
  /** Set when "Show which model answered" is on. */
  model?: string;
  processedLocally?: boolean;
  /** Developer mode only. */
  routingReason?: string;
  showTypingIndicator?: boolean;
  /** The newest reply keeps its actions visible; older ones show them on hover. */
  isLatest?: boolean;
  /** Files Astraeya made with this reply. */
  files?: MadeFile[];
  /** Videos being made for this reply. */
  jobs?: MediaJob[];
  /** Asks for another version of an image made in this reply. */
  onRegenerateMedia?: () => void;
  /** What is happening while a reply is being worked on, e.g. "Creating your file…". */
  status?: string;
}) {
  const behavior = useSettingsGroup("behavior");

  const isUser = role === "user";
  const time =
    timestamp &&
    new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

  return (
    <div
      className={`group flex flex-col ${isUser ? "items-end" : "items-stretch"}`}
    >
      <div
        // Your messages sit in a soft bubble on the right. Replies are text on
        // the page, full column width — the way a document reads, which is
        // what long study answers are.
        //
        // chat-bubble and chat-message carry the density, shape and line-height
        // that Appearance controls; the padding and radius live in CSS so a
        // preference change does not need this component to re-render.
        className={
          isUser
            ? "chat-bubble chat-bubble--user chat-message max-w-[88%] bg-[var(--user-bubble)] text-[15.5px] text-[var(--text-primary)] sm:max-w-[75%]"
            : "chat-message chat-reply w-full text-[15.5px] text-[var(--text-primary)]"
        }
      >
        {isUser ? (
          <span className="whitespace-pre-wrap">{content}</span>
        ) : !content && status && isStreaming ? (
          // Making a file takes longer than a reply. Saying what is happening
          // is the difference between "working" and "stuck".
          <span className="flex items-center gap-2 py-1 text-sm text-[var(--text-secondary)]" role="status">
            <AstraeyaMark size={18} thinking />
            {status}
          </span>
        ) : !content ? (
          showTypingIndicator ? (
            // Waiting on the first token. A static ellipsis is indistinguishable
            // from a stalled request; movement says the connection is alive.
            <span className="flex items-center py-1" role="status">
              {/* The logo's blue ring orbits while Astraeya thinks. */}
              <AstraeyaMark size={26} thinking />
            </span>
          ) : (
            <span className="sr-only" role="status">
              Waiting for a reply
            </span>
          )
        ) : behavior.useMarkdown ? (
          <div className="prose-astraeya">
            <ReactMarkdown
              // GitHub-flavoured Markdown: tables, strikethrough, task lists and
              // bare links. Without it a table arrives as rows of pipes.
              remarkPlugins={[remarkGfm]}
              components={{
                // Wide tables scroll inside the bubble instead of stretching it.
                table({ children }) {
                  return (
                    <div className="table-scroll">
                      <table>{children}</table>
                    </div>
                  );
                },
                a({ href, children }) {
                  return (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  );
                },
                code({ className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || "");
                  const isBlock = className?.includes("language-");
                  // With code formatting off the model is asked not to fence
                  // code, but an older message may still contain a block.
                  if (isBlock && behavior.codeFormatting) {
                    const code = String(children).replace(/\n$/, "");
                    // A drawn logo or icon: show the picture, with downloads,
                    // above its code.
                    const svg =
                      match && /^(svg|xml|html)$/.test(match[1]) ? extractSvg(code) : null;
                    return (
                      <>
                        {svg && <SvgPreview svg={svg} />}
                        <CodeBlock language={match?.[1]} code={code} />
                      </>
                    );
                  }
                  return (
                    <code className={className} {...props}>
                      {children}
                    </code>
                  );
                },
              }}
            >
              {content}
            </ReactMarkdown>
          </div>
        ) : (
          // Markdown off: show exactly what came back, unrendered.
          <span className="whitespace-pre-wrap">{content}</span>
        )}
      </div>

      {!isUser && <MadeFiles files={files} jobs={jobs} onRegenerate={onRegenerateMedia} />}

      {!isUser && status && isStreaming && content && (
        <span className="mt-2 flex items-center gap-2 text-sm text-[var(--text-secondary)]" role="status">
          <AstraeyaMark size={18} thinking />
          {status}
        </span>
      )}

      {(time || model) && (
        <span className="mt-1 flex flex-wrap items-center gap-2 px-1 text-[11px] text-[var(--text-secondary)]">
          {time}
          {model && (
            <span className="flex items-center gap-1">
              {processedLocally ? <HardDrive size={10} /> : <Cloud size={10} />}
              {model}
            </span>
          )}
          {routingReason && (
            <span className="font-mono opacity-70">{routingReason}</span>
          )}
        </span>
      )}

      {!isUser && content && !isStreaming && (
        // The newest reply keeps its actions in view. Older ones fade them in
        // on hover, so a long conversation isn't striped with icon rows.
        <div
          className={`-ml-1.5 transition-opacity ${
            isLatest
              ? "opacity-100"
              : "opacity-100 focus-within:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
          }`}
        >
          <div className="flex items-center gap-1">
            {/* When the reply is done, the mark stays, small and still. */}
            {isLatest && <AstraeyaMark size={16} className="ml-1.5 mr-0.5" />}
          <MessageActions
            content={content}
            onRetry={onRetry}
            onBranch={onBranch}
            messageId={id}
            conversationId={conversationId}
          />
          </div>
        </div>
      )}

      {isUser && content && (
        // Floats in on hover (or keyboard focus) on a desktop; always shown on
        // a touch screen, where there is no hover to reveal it.
        <div className="opacity-100 transition-opacity focus-within:opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
          <MessageActions
            variant="user"
            content={content}
            onBranch={onBranch}
            messageId={id}
            conversationId={conversationId}
          />
        </div>
      )}
    </div>
  );
}
