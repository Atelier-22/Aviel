"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  BookOpen,
  Cloud,
  FileText,
  Globe,
  GraduationCap,
  HardDrive,
  Mic,
  MicOff,
  PenLine,
  Radio,
  RotateCcw,
  Search,
  Send,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { MessageBubble } from "./message-bubble";
import type { MadeFile, MediaJob } from "./made-files";
import { Composer, type ThinkMode } from "./composer";
import { AstraeyaIcon } from "../logo";
import { useSettingsStore } from "@/lib/settings/store";
import { apiFetch, apiStream } from "@/lib/api-client";
import {
  getSpeechRecognition,
  haptic,
  playCue,
  recognitionLanguage,
  type SpeechRecognitionLike,
} from "@/lib/speech";
import { readAloud, startReading, stopReading, unlockAudio, type VoicePlayer } from "@/lib/voice/tts";
import { SentenceStream } from "@/lib/voice/sentences";
import { rememberGreeting } from "@/lib/voice/greeting";
import { VoiceNotice } from "@/components/voice/voice-notice";
import { MAX_DICTATION_MS, shouldRestartDictation } from "@/lib/voice/dictation";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: Date | string;
  /** Filled from the stream's meta event, when the setting asks for it. */
  model?: string;
  processedLocally?: boolean;
  routed?: boolean;
  routingReason?: string;
  /**
   * False while the id is a temporary one made in the browser. Messages loaded
   * from the server are stored ones, so it defaults to true when absent.
   */
  saved?: boolean;
  /** Files Astraeya made with this reply. */
  files?: MadeFile[];
  /** Videos being made for this reply. */
  jobs?: MediaJob[];
  /** Progress while the reply is being worked on, e.g. "Creating your file…". */
  status?: string;
};

type PendingFile = {
  name: string;
  mediaType: string;
  base64: string;
  previewUrl?: string;
};

type Project = { id: string; name: string };

// Starting points for what students come here to do. Each fills the box with
// a prompt to finish, rather than sending on its own.
const SUGGESTIONS: { label: string; icon: typeof BookOpen; prompt: string }[] = [
  { label: "Explain a topic", icon: GraduationCap, prompt: "Explain this topic to me simply, then in exam-level detail: " },
  { label: "Summarise notes", icon: BookOpen, prompt: "Summarise these notes into clear key points I can revise from:\n\n" },
  { label: "Plan an assignment", icon: PenLine, prompt: "Help me plan and outline this assignment: " },
  { label: "Research a question", icon: Search, prompt: "Research this question and give me the strongest evidence on each side: " },
];

/** "Good morning", "Good afternoon" or "Good evening", by the device's clock. */
function greeting(name: string | null): string {
  const h = new Date().getHours();
  const part = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name}` : part;
}

export function ChatWindow({
  conversationId,
  title,
  initialMessages = [],
}: {
  conversationId?: string;
  title?: string;
  initialMessages?: Message[];
}) {
  const router = useRouter();
  const { settings, meta } = useSettingsStore();

  const conv = settings.conversation;
  const voice = settings.voice;

  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFailedMessage, setLastFailedMessage] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [sources, setSources] = useState<{ title: string; url: string }[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [micSupported, setMicSupported] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [turnMeta, setTurnMeta] = useState<{
    model?: string;
    processedLocally?: boolean;
  } | null>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  // Seeded from the account default, then overridable per message from the
  // composer without changing the stored preference.
  const [thinkMode, setThinkMode] = useState<ThinkMode>(settings.ai.thinkMode);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // Read by the streaming loop, which is started once and must see the current
  // value rather than the one captured when it began.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Only follow the stream while the user is already at the bottom. Scrolling
  // up to re-read something and being yanked back down on every token is the
  // single most irritating thing a chat UI can do.
  useEffect(() => {
    if (pinnedToBottom && conv.autoScroll) {
      scrollRef.current?.scrollIntoView({
        behavior: settings.appearance.animations === "off" ? "auto" : "smooth",
      });
    }
  }, [messages, pinnedToBottom, conv.autoScroll, settings.appearance.animations]);

  function handleScroll() {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinnedToBottom(distanceFromBottom < 80);
  }

  // Grow the composer with its content instead of scrolling inside one line,
  // capped so a long paste doesn't swallow the conversation.
  function resizeTextarea() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  useEffect(resizeTextarea, [input]);

  useEffect(() => {
    setMicSupported(Boolean(getSpeechRecognition()));
  }, []);

  useEffect(() => () => stopReading(), []);

  // Makes the live-mode greeting ("Hello Peter, what can I do for you
  // today?") ahead of time, in the chosen voice, so live mode can say it the
  // instant it opens. Fire and forget: a failure only means it is made later.
  useEffect(() => {
    void apiFetch<{ greeting?: string }>("/voice/warm", { method: "POST" })
      .then((r) => r?.greeting && rememberGreeting(r.greeting))
      .catch(() => undefined);
  }, [settings.voice.outputVoice]);

  /**
   * Tell the user a reply landed while they were looking elsewhere.
   *
   * Gated on the setting and on an actual granted permission — the setting
   * cannot be true without one, but the permission can be revoked afterwards.
   */
  const notifyIfHidden = useCallback((text: string) => {
    const n = settingsRef.current.notifications;
    if (!n.desktopCompletion) return;
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    if (!document.hidden) return;

    if (n.quietHoursEnabled) {
      const now = new Date();
      const minutes = now.getHours() * 60 + now.getMinutes();
      const [sh, sm] = n.quietHoursStart.split(":").map(Number);
      const [eh, em] = n.quietHoursEnd.split(":").map(Number);
      const start = sh * 60 + sm;
      const end = eh * 60 + em;
      // Quiet hours usually wrap midnight, so the two orderings differ.
      const quiet = start <= end
        ? minutes >= start && minutes < end
        : minutes >= start || minutes < end;
      if (quiet) return;
    }

    try {
      new Notification("Astraeya", {
        body: text.slice(0, 140),
        silent: !n.sound,
      });
    } catch {
      // Blocked, or unsupported in this context.
    }
  }, []);

  // The mic is shown when the browser supports it and the account wants it.
  const showMic = micSupported && voice.dictationEnabled;

  // One dictation spans many browser recognition sessions. The browser ends
  // a session at a pause or after about a minute; while the person still
  // wants to dictate, the next one starts at once (see lib/voice/dictation).
  const dictation = useRef({
    wanted: false,
    startedAt: 0,
    sessionStartedAt: 0,
    heard: false,
    quickFailures: 0,
    lastError: null as string | null,
    restartTimer: null as ReturnType<typeof setTimeout> | null,
    limitTimer: null as ReturnType<typeof setTimeout> | null,
  });

  const finishDictation = useCallback(() => {
    const d = dictation.current;
    d.wanted = false;
    if (d.restartTimer) clearTimeout(d.restartTimer);
    if (d.limitTimer) clearTimeout(d.limitTimer);
    d.restartTimer = d.limitTimer = null;
    recognitionRef.current = null;
    setIsListening(false);
    setInterim("");
  }, []);

  const stopListening = useCallback(() => {
    const d = dictation.current;
    d.wanted = false;
    if (d.restartTimer) clearTimeout(d.restartTimer);
    // stop(), not abort(): the browser still hands over what it heard last.
    const recognition = recognitionRef.current;
    if (recognition) recognition.stop();
    finishDictation();
  }, [finishDictation]);

  const beginSessionRef = useRef<() => void>(() => {});
  beginSessionRef.current = () => {
    const Recognition = getSpeechRecognition();
    const d = dictation.current;
    if (!Recognition || !d.wanted) return;

    const v = settingsRef.current.voice;
    const recognition = new Recognition();
    recognition.lang = recognitionLanguage(v);
    // Always continuous: "tap" mode used to end at the first pause.
    recognition.continuous = true;
    recognition.interimResults = v.liveTranscription;
    recognition.maxAlternatives = 1;

    d.sessionStartedAt = Date.now();
    d.heard = false;
    d.lastError = null;

    recognition.onresult = (event) => {
      d.heard = true;
      d.quickFailures = 0;
      let finalText = "";
      let interimText = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interimText += result[0].transcript;
      }

      setInterim(v.liveTranscription ? interimText : "");

      if (finalText) {
        setInput((prev) => (prev ? `${prev} ${finalText.trim()}` : finalText.trim()).trim());
        // Auto-submit only makes sense when the user has not asked to review
        // the transcript first; the two settings would otherwise contradict.
        // It sends what was said and ends this dictation.
        if (v.autoSubmit && !v.editTranscript) {
          stopListening();
          setTimeout(() => sendRef.current?.(), 60);
        }
      }
    };

    recognition.onerror = (event) => {
      d.lastError = event.error;
    };

    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return; // an older session
      setInterim("");
      const now = Date.now();
      if (!d.heard && now - d.sessionStartedAt < 1500) d.quickFailures += 1;
      if (
        shouldRestartDictation({
          wanted: d.wanted,
          startedAt: d.startedAt,
          now,
          lastError: d.lastError,
          quickFailures: d.quickFailures,
        })
      ) {
        d.restartTimer = setTimeout(() => beginSessionRef.current(), 150);
      } else {
        finishDictation();
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      finishDictation();
    }
  };

  const startListening = useCallback(() => {
    if (!getSpeechRecognition()) return;
    // The person is about to talk: Astraeya stops talking.
    stopReading();
    const v = settingsRef.current.voice;
    const d = dictation.current;
    d.wanted = true;
    d.startedAt = Date.now();
    d.quickFailures = 0;
    if (d.limitTimer) clearTimeout(d.limitTimer);
    d.limitTimer = setTimeout(() => {
      stopListening();
      playCue("stop", settingsRef.current.voice);
    }, MAX_DICTATION_MS);

    beginSessionRef.current();
    setIsListening(true);
    playCue("start", v);
    haptic(v);
  }, [stopListening]);

  // Leaving the chat ends the dictation rather than leaving the mic on.
  useEffect(() => () => {
    dictation.current.wanted = false;
    recognitionRef.current?.abort();
  }, []);

  function toggleListening() {
    if (isListening) {
      stopListening();
      playCue("stop", voice);
      return;
    }
    startListening();
  }

  // Accepts a File[] as well as a FileList: a paste and a drop both hand over
  // a plain array, and only a file input gives a FileList.
  function handleFilesSelected(fileList: FileList | File[]) {
    const maxBytes = (meta?.limits?.maxUploadMb ?? 50) * 1_000_000;

    Array.from(fileList).forEach((file) => {
      if (file.size > maxBytes) {
        setError(
          `"${file.name}" is larger than the ${meta?.limits?.maxUploadMb ?? 50} MB limit.`
        );
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(",")[1] ?? "";
        setPendingFiles((prev) => [
          ...prev,
          {
            name: file.name,
            mediaType: file.type || "application/octet-stream",
            base64,
            previewUrl: file.type.startsWith("image/") ? result : undefined,
          },
        ]);
      };
      reader.readAsDataURL(file);
    });
  }

  function removeFile(name: string) {
    setPendingFiles((prev) => prev.filter((f) => f.name !== name));
  }

  async function streamReply(
    text: string,
    assistantId: string,
    files: PendingFile[] = [],
    useWebSearch = false
  ) {
    setIsStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;

    const body = {
      message: text,
      conversationId,
      projectId: !conversationId ? selectedProject?.id : undefined,
      attachments: files.map((f) => ({
        name: f.name,
        mediaType: f.mediaType,
        base64: f.base64,
      })),
      webSearchEnabled: useWebSearch,
      // Deliberately not sent. The server keeps this flag per conversation and
      // falls back to the stored value when the client omits it, so omitting it
      // leaves the conversation's own setting alone rather than overwriting it
      // with a default on every turn.
      // Per-message, so choosing Deep for one hard question does not change
      // the account's standing preference.
      thinkMode,
    };

    if (settingsRef.current.advanced.debugMode) {
      console.info("[Astraeya] sending", { ...body, attachments: files.length });
    }

    try {
      // Non-streaming is a real setting, not a cosmetic one: without the
      // event-stream Accept header the server answers with one JSON body.
      if (!conv.streamResponses || !settingsRef.current.advanced.streaming) {
        const result = await apiFetch<{
          conversationId: string;
          userMessageId?: string;
          assistantMessageId?: string | null;
          reply: string;
          files?: MadeFile[];
          jobs?: MediaJob[];
          model?: string;
          processedLocally?: boolean;
          sources?: { title: string; url: string }[];
        }>("/chat", { method: "POST", body: JSON.stringify(body) });

        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  content: result.reply,
                  files: result.files,
                  jobs: result.jobs,
                  model: result.model,
                  processedLocally: result.processedLocally,
                }
              : m
          )
        );
        setTurnMeta({
          model: result.model,
          processedLocally: result.processedLocally,
        });
        if (result.sources?.length) setSources(result.sources);
        adoptSavedIds(assistantId, result.userMessageId, result.assistantMessageId);
        afterReply(result.reply);

        if (!conversationId && result.conversationId) {
          router.push(`/chat/${result.conversationId}`);
          router.refresh();
        }
        return;
      }

      const res = await apiStream("/chat", body, controller.signal);
      if (!res.body) throw new Error("No response stream from server");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let newConversationId: string | undefined;
      let fullText = "";

      // "Read every reply aloud": speaking starts with the first sentence,
      // while the rest of the reply is still being written.
      const vs = settingsRef.current.voice;
      let speaker: VoicePlayer | null = vs.autoReadReplies
        ? startReading({
            voice: vs.outputVoice,
            volume: vs.volume,
            rate: vs.rate,
            pitch: vs.pitch,
            onEnd: () => {
              if (vs.micMode === "continuous" && showMic) startListening();
            },
          })
        : null;
      const spoken = new SentenceStream();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const raw of events) {
          const eventLine = raw.split("\n").find((l) => l.startsWith("event: "));
          const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
          if (!eventLine || !dataLine) continue;

          const eventType = eventLine.replace("event: ", "");
          const data = JSON.parse(dataLine.replace("data: ", ""));

          if (eventType === "meta") {
            if (data.conversationId && !conversationId) {
              newConversationId = data.conversationId;
            }
            setTurnMeta({
              model: data.model,
              processedLocally: data.processedLocally,
            });
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      model: data.model,
                      processedLocally: data.processedLocally,
                      routed: data.routed,
                      routingReason: data.routingReason,
                    }
                  : m
              )
            );
            if (settingsRef.current.advanced.debugMode) {
              console.info("[Astraeya] turn meta", data);
            }
          } else if (eventType === "searching") {
            setSearching(true);
          } else if (eventType === "status") {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, status: data.text } : m))
            );
          } else if (eventType === "file") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, files: [...(m.files ?? []), data.file as MadeFile] }
                  : m
              )
            );
          } else if (eventType === "job") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, jobs: [...(m.jobs ?? []), data.job as MediaJob] }
                  : m
              )
            );
          } else if (eventType === "sources") {
            setSearching(false);
            setSources(data.sources ?? []);
          } else if (eventType === "chunk") {
            // The first token means searching is over, whether or not a
            // sources event arrives.
            setSearching(false);
            fullText += data.text;
            if (speaker) for (const sentence of spoken.push(data.text)) speaker.enqueue(sentence);
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, content: m.content + data.text }
                  : m
              )
            );
          } else if (eventType === "done") {
            if (speaker) {
              for (const sentence of spoken.end()) speaker.enqueue(sentence);
              speaker.end();
              speaker = null;
            }
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      status: undefined,
                      // A reply that was only files still needs words.
                      content: m.content || (m.files?.length ? "Here is your file." : m.content),
                    }
                  : m
              )
            );
            adoptSavedIds(assistantId, data.userMessageId, data.assistantMessageId);
          } else if (eventType === "error") {
            setError(data.message);
            setLastFailedMessage(text);
          }
        }
      }

      afterReply(fullText, settingsRef.current.voice.autoReadReplies);

      if (newConversationId) {
        router.push(`/chat/${newConversationId}`);
        router.refresh();
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(err instanceof Error ? err.message : "Something went wrong");
        setLastFailedMessage(text);
      }
    } finally {
      setIsStreaming(false);
    }
  }

  /**
   * Replace the temporary ids of the turn just sent with the ones the server
   * saved, so actions that point at a stored message — branching — work
   * straight away. The user's message is the one right before the reply.
   */
  function adoptSavedIds(
    assistantId: string,
    userMessageId?: string | null,
    assistantMessageId?: string | null
  ) {
    if (!userMessageId && !assistantMessageId) return;
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === assistantId);
      if (idx === -1) return prev;
      return prev.map((m, i) => {
        if (i === idx && assistantMessageId) return { ...m, id: assistantMessageId, saved: true };
        if (i === idx - 1 && m.role === "user" && userMessageId)
          return { ...m, id: userMessageId, saved: true };
        return m;
      });
    });
  }

  /** Branch into a new chat holding everything up to and including a message. */
  async function branchFrom(messageId: string) {
    if (!conversationId) return;
    try {
      const branch = await apiFetch<{ id: string }>(
        `/conversations/${conversationId}/branch`,
        { method: "POST", body: JSON.stringify({ messageId }) }
      );
      router.push(`/chat/${branch.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not branch this chat");
    }
  }

  /** Everything that happens once a reply is complete. */
  function afterReply(text: string, alreadyBeingRead = false) {
    if (!text.trim()) return;

    notifyIfHidden(text);

    const v = settingsRef.current.voice;
    const listenAgain = () => {
      // Continuous mode listens again for the next thing you say, but only
      // once Astraeya has finished talking, so it never hears itself.
      if (v.micMode === "continuous" && showMic) startListening();
    };
    if (v.autoReadReplies && !alreadyBeingRead) {
      readAloud(text, { voice: v.outputVoice, volume: v.volume, rate: v.rate, pitch: v.pitch, onEnd: listenAgain });
    } else if (!v.autoReadReplies && isListening === false) {
      listenAgain();
    }
  }

  async function sendMessage(override?: string) {
    const text = (override ?? input).trim();
    if ((!text && pendingFiles.length === 0) || isStreaming) return;

    // Sending is a key press or a tap: the moment the browser allows audio to
    // be unlocked, so the reply can be read aloud. Anything still being read
    // stops, because the person has moved on.
    unlockAudio();
    stopReading();

    // "Ask before analysing" is a privacy check, so it only asks when the image
    // would actually leave this machine — with local-only processing on, or
    // analysis off, there is nothing to warn about.
    const images = pendingFiles.filter((f) => f.mediaType.startsWith("image/"));
    if (
      images.length > 0 &&
      settings.images.askBeforeAnalyzing &&
      settings.images.analysisEnabled &&
      !settings.privacy.localOnly &&
      turnMeta?.processedLocally !== true
    ) {
      const ok = window.confirm(
        `${images.length === 1 ? "This image" : `These ${images.length} images`} will be sent to a hosted AI service to be read. Continue?`
      );
      if (!ok) return;
    }

    setError(null);
    setLastFailedMessage(null);
    setSources([]);
    setInput("");
    setInterim("");
    const filesToSend = pendingFiles;
    setPendingFiles([]);

    const userMsg: Message = {
      id: crypto.randomUUID(),
      saved: false,
      role: "user",
      content:
        text +
        (filesToSend.length > 0
          ? `${text ? "\n\n" : ""}[Attached: ${filesToSend
              .map((f) => f.name)
              .join(", ")}]`
          : ""),
      createdAt: new Date(),
    };
    const assistantId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      userMsg,
      { id: assistantId, role: "assistant", content: "", createdAt: new Date(), saved: false },
    ]);

    await streamReply(text, assistantId, filesToSend, webSearchEnabled);
  }

  // Held in a ref so speech recognition's callback can send without being
  // rebuilt on every keystroke.
  const sendRef = useRef<() => void>();
  sendRef.current = () => void sendMessage();

  async function retryLastMessage() {
    const text = lastFailedMessage;
    if (!text) return;
    setError(null);
    setLastFailedMessage(null);

    const assistantId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", content: "", createdAt: new Date(), saved: false },
    ]);
    await streamReply(text, assistantId);
  }

  async function regenerateResponse(assistantMessageId: string) {
    const idx = messages.findIndex((m) => m.id === assistantMessageId);
    if (idx <= 0) return;
    const priorUser = [...messages.slice(0, idx)]
      .reverse()
      .find((m) => m.role === "user");
    if (!priorUser) return;

    setMessages((prev) =>
      prev.map((m) => (m.id === assistantMessageId ? { ...m, content: "" } : m))
    );
    await streamReply(priorUser.content, assistantMessageId);
  }

  function stopGeneration() {
    abortRef.current?.abort();
    setIsStreaming(false);
  }

  async function clearConversation() {
    if (!confirm("Delete this conversation? This can't be undone.")) return;

    // A conversation that was never sent has no id on the server yet, so there
    // is nothing to delete — just clear the screen.
    if (conversationId) {
      try {
        await apiFetch(`/conversations/${conversationId}`, { method: "DELETE" });
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Could not delete the conversation"
        );
        return;
      }
    }

    setMessages([]);
    router.push("/chat");
    router.refresh();
  }


  const showProcessing =
    settings.privacy.showProcessingLocation && turnMeta !== null;
  const isEmpty = messages.length === 0;
  const firstName =
    (settings.profile.preferredName?.trim() ||
      settings.profile.displayName?.trim() ||
      "").split(/\s+/)[0] || null;
  const latestAssistantId = [...messages].reverse().find((m) => m.role === "assistant")?.id;

  // One composer, placed in the middle of a new chat and docked at the bottom
  // of a conversation — the same element either way.
  const composer = (
    <Composer
      value={input}
      onChange={setInput}
      onSend={() => void sendMessage()}
      onStop={stopGeneration}
      isStreaming={isStreaming}
      attachments={pendingFiles}
      onAttach={handleFilesSelected}
      onRemoveAttachment={removeFile}
      webSearchEnabled={webSearchEnabled}
      onToggleWebSearch={() => setWebSearchEnabled((v) => !v)}
      selectedProject={selectedProject}
      onSelectProject={setSelectedProject}
      showProjectPicker={!conversationId}
      voiceState={isListening ? "listening" : "idle"}
      onToggleVoice={toggleListening}
      interimTranscript={voice.showTranscript ? interim : ""}
      onCancelVoice={stopListening}
      micSupported={micSupported}
      thinkMode={thinkMode}
      onThinkModeChange={setThinkMode}
      onOpenLiveVoice={() =>
        router.push(
          conversationId ? `/voice?conversation=${conversationId}` : "/voice"
        )
      }
    />
  );

  return (
    <div className="flex h-full flex-col bg-[var(--bg-primary)]">
      <VoiceNotice />
      {/* Top bar: the conversation's name, and nothing that competes with it.
          Deleting, renaming and pinning live in the sidebar's menu for each
          chat. On a phone, the left padding clears the menu button. */}
      {!isEmpty && (
        <header className="flex h-14 shrink-0 items-center gap-3 pl-16 pr-4 md:px-6">
          <h1 className="min-w-0 flex-1 truncate text-[15px] font-medium text-[var(--text-primary)]">
            {title && title !== "New Chat" ? title : messages.find((m) => m.role === "user")?.content.slice(0, 60) || "New chat"}
          </h1>
          {showProcessing && (
            <span
              className="flex shrink-0 items-center gap-1 rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]"
              title={
                turnMeta?.processedLocally
                  ? "Answered by a model running on the Astraeya server. Nothing was sent to an external provider."
                  : "Answered by a hosted AI service. Your message was sent to it."
              }
            >
              {turnMeta?.processedLocally ? (
                <>
                  <HardDrive size={11} /> Local
                </>
              ) : (
                <>
                  <Cloud size={11} /> Hosted
                </>
              )}
            </span>
          )}
        </header>
      )}

      {isEmpty ? (
        // ---- New chat: greeting and composer together, centred ----
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 pb-16">
          <div className="w-full max-w-[760px]">
            <h1 className="mb-8 flex items-center justify-center gap-3 text-center font-serif text-[2rem] font-medium leading-tight text-[var(--text-primary)] sm:text-[2.6rem]">
              <AstraeyaIcon size={40} />
              {greeting(firstName)}
            </h1>

            {composer}

            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map(({ label, icon: Icon, prompt }) => (
                <button
                  key={label}
                  onClick={() => {
                    setInput(prompt);
                    textareaRef.current?.focus();
                  }}
                  className="focus-ring flex items-center gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:border-[var(--accent-solid)] hover:text-[var(--text-primary)]"
                >
                  <Icon size={15} />
                  {label}
                </button>
              ))}
            </div>

            {error && (
              <p role="alert" className="mt-4 text-center text-sm text-[var(--danger)]">
                {error}
              </p>
            )}
          </div>
        </div>
      ) : (
        <>
          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto px-4 pb-8 pt-2 md:px-8"
          >
            <div className="chat-stack mx-auto flex max-w-[760px] flex-col">
              {messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  id={m.id}
                  role={m.role}
                  content={m.content}
                  timestamp={conv.showTimestamps ? m.createdAt : undefined}
                  conversationId={conversationId}
                  model={conv.showModelUsed ? m.model : undefined}
                  processedLocally={m.processedLocally}
                  routingReason={
                    settings.advanced.developerMode ? m.routingReason : undefined
                  }
                  showTypingIndicator={conv.showTypingIndicator}
                  isStreaming={
                    isStreaming && m.id === messages[messages.length - 1]?.id
                  }
                  isLatest={m.id === latestAssistantId}
                  files={m.files}
                  jobs={m.jobs}
                  onRegenerateMedia={
                    m.role === "assistant" && !isStreaming
                      ? () => void sendMessage("Make another version of that image, with a fresh variation.")
                      : undefined
                  }
                  status={m.status}
                  onRetry={
                    m.role === "assistant" ? () => regenerateResponse(m.id) : undefined
                  }
                  onBranch={
                    // Only a stored message can be branched from; a just-sent one
                    // gets its real id when the reply finishes.
                    conversationId && m.saved !== false && !isStreaming
                      ? () => branchFrom(m.id)
                      : undefined
                  }
                />
              ))}

              {searching && (
                <div className="flex items-center gap-2 self-start text-sm text-[var(--text-secondary)]">
                  <Globe size={14} className="animate-pulse" />
                  Searching the web…
                </div>
              )}

              {/* Only for accounts that asked for sources in Settings. */}
              {settings.behavior.citeSources && sources.length > 0 && (
                <div className="self-start rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-2.5">
                  <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
                    <Globe size={11} /> Sources
                  </p>
                  <ul className="flex flex-col gap-1">
                    {sources.map((s) => (
                      <li key={s.url}>
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-accent line-clamp-1 text-xs hover:underline"
                        >
                          {s.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {error && (
                <div
                  role="alert"
                  className="flex items-center justify-between gap-3 rounded-xl border border-[var(--danger)]/30 bg-[var(--danger)]/10 px-4 py-2.5 text-sm text-[var(--danger)]"
                >
                  <span>{error}</span>
                  {lastFailedMessage && (
                    <button
                      onClick={retryLastMessage}
                      className="focus-ring flex shrink-0 items-center gap-1 rounded-md border border-[var(--danger)]/40 px-2 py-1 text-xs hover:bg-[var(--danger)]/10"
                    >
                      <RotateCcw size={12} /> Retry
                    </button>
                  )}
                </div>
              )}
              <div ref={scrollRef} />
            </div>
          </div>

          {/* Docked composer. No band or divider: the conversation fades out
              beneath it, so the box floats on the page. */}
          <div className="composer-dock relative px-4 pb-3 md:px-8">
            {!pinnedToBottom && (
              <button
                onClick={() => {
                  setPinnedToBottom(true);
                  scrollRef.current?.scrollIntoView({ behavior: "smooth" });
                }}
                aria-label="Jump to latest"
                className="absolute -top-12 left-1/2 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] shadow-md hover:text-[var(--text-primary)]"
              >
                <ArrowDown size={16} />
              </button>
            )}
            <div className="mx-auto max-w-[760px]">
              {composer}
              <p className="mt-2 text-center text-[11.5px] text-[var(--text-secondary)]">
                Astraeya can make mistakes. Check important information.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
