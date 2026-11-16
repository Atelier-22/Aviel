"use client";

import { useEffect, useState } from "react";
import { Mic, Play, Square, Volume2 } from "lucide-react";
import {
  Callout,
  SaveIndicator,
  SectionHeader,
  SegmentedControl,
  SettingsButton,
  SettingsCard,
  SettingsDropdown,
  SettingsRow,
  SettingsSlider,
  SettingsToggle,
  StatusPill,
} from "../primitives";
import { useSection } from "../use-section";
import { useSpeechSupport } from "@/lib/speech";
import {
  isHeadset,
  listMicrophones,
  pickMicrophone,
  saveMicrophone,
  savedMicrophone,
} from "@/lib/voice/microphone";
import {
  groupVoices,
  loadVoices,
  playPreview,
  stopReading,
  type AstraeyaVoice,
} from "@/lib/voice/tts";

const DICTATION_LANGS = [
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "sw-KE", label: "Kiswahili" },
  { value: "lg-UG", label: "Luganda" },
  { value: "fr-FR", label: "Français" },
  { value: "ar-SA", label: "العربية" },
  { value: "es-ES", label: "Español" },
  { value: "pt-BR", label: "Português (BR)" },
  { value: "de-DE", label: "Deutsch" },
  { value: "hi-IN", label: "हिन्दी" },
  { value: "zh-CN", label: "中文" },
];

export function VoiceSection() {
  const { values, set, reset, resetting, saveState, error, meta } =
    useSection("voice");
  // Only for knowing whether this browser can recognise speech; voices for
  // speaking come from Astraeya's own voice server.
  const { sttSupported } = useSpeechSupport();
  const [voices, setVoices] = useState<AstraeyaVoice[]>([]);
  const [serviceUp, setServiceUp] = useState<boolean | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    loadVoices()
      .then((list) => {
        setVoices(list.voices);
        setServiceUp(list.available);
      })
      .catch(() => setServiceUp(false));
  }, []);

  const [previewing, setPreviewing] = useState(false);
  const [micState, setMicState] = useState<
    "unknown" | "checking" | "ok" | "denied" | "unsupported"
  >("unknown");
  const [micDetail, setMicDetail] = useState<string | null>(null);

  useEffect(() => () => stopReading(), []);

  const voiceDisabled = meta?.features?.voice === false;

  // The clip is made once per voice and kept, so playing it again is instant.
  function preview() {
    if (previewing) return;
    setPreviewing(true);
    setPreviewError(null);
    playPreview(values.outputVoice, values.volume)
      .catch(() => setPreviewError("The voice service isn't available right now, so there's no preview."))
      .finally(() => setPreviewing(false));
  }

  /**
   * Actually opens the microphone.
   *
   * The only honest way to report whether noise suppression is available: ask
   * for it and read back what the browser granted. Dictation itself goes
   * through the Web Speech API, which does not accept constraints — so this
   * reports on the device, and says so.
   */
  async function checkMicrophone() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicState("unsupported");
      setMicDetail("This browser has no microphone API.");
      return;
    }

    setMicState("checking");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          noiseSuppression: values.noiseReduction,
          echoCancellation: values.noiseReduction,
          ...(values.audioQuality === "high" ? { sampleRate: 48000 } : {}),
        },
      });

      const track = stream.getAudioTracks()[0];
      const settings = track?.getSettings?.() ?? {};
      stream.getTracks().forEach((t) => t.stop());

      setMicState("ok");
      setMicDetail(
        [
          track?.label || "Default microphone",
          settings.noiseSuppression === true
            ? "noise suppression on"
            : settings.noiseSuppression === false
              ? "noise suppression not applied"
              : null,
          settings.sampleRate ? `${settings.sampleRate} Hz` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      );
    } catch (err) {
      setMicState("denied");
      setMicDetail(
        err instanceof Error && err.name === "NotAllowedError"
          ? "Permission was refused. Allow microphone access for this site in your browser."
          : "No microphone was available."
      );
    }
  }

  return (
    <>
      <SectionHeader
        title="Voice"
        description="Speaking to Astraeya, and hearing it read a reply back."
        onReset={reset}
        resetting={resetting}
      />

      <div className="mb-3 flex justify-end">
        <SaveIndicator state={saveState} error={error} />
      </div>

      <Callout title="Where voice runs">
        When you speak to Astraeya, your browser turns your words into text; no
        recording of your voice is uploaded. When Astraeya reads a reply aloud,
        the text of that reply is sent to Astraeya&apos;s own server, which makes
        the speech and sends it back. Nothing is sent to any other company, and
        the audio is not stored. If that server is ever unavailable, your
        browser&apos;s built-in voice reads instead, and you&apos;ll see a note
        saying so.
      </Callout>

      {voiceDisabled && (
        <Callout tone="warn" title="Voice is unavailable">
          An administrator has turned voice off for this server.
        </Callout>
      )}

      <SettingsCard
        title="Reading replies aloud"
        description="Astraeya's own voices, the same on every device. Heart is the default."
      >
        {serviceUp === false && (
          <SettingsRow
            label="Voice service"
            unavailable="Astraeya's voice server isn't answering right now. Replies are read with your browser's voice until it is back."
          >
            <StatusPill tone="off">Using backup</StatusPill>
          </SettingsRow>
        )}

        <SettingsRow label="Voice" icon={Volume2}>
          <div className="flex items-center gap-2">
            <SettingsDropdown
              label="Voice"
              value={values.outputVoice}
              disabled={voices.length === 0 || voiceDisabled}
              onChange={(v) => set({ outputVoice: v })}
              groups={groupVoices(voices).map((g) => ({
                label: g.label,
                options: g.voices.map((v) => ({ value: v.id, label: v.label })),
              }))}
            />
            <SettingsButton
              onClick={preview}
              disabled={voices.length === 0 || voiceDisabled || previewing || serviceUp === false}
            >
              {previewing ? <Square size={12} /> : <Play size={12} />}
              {previewing ? "Playing" : "Test"}
            </SettingsButton>
          </div>
        </SettingsRow>
        {previewError && <p className="px-1 pb-2 text-xs text-[var(--danger)]">{previewError}</p>}

        <SettingsRow
          label="Speed"
          description="Applies to the browser's backup voice. Astraeya's voices speak at their natural pace."
        >
          <SettingsSlider
            label="Speech speed"
            value={values.rate}
            min={0.5}
            max={2}
            step={0.05}
            disabled={voiceDisabled}
            onCommit={(v) => set({ rate: v })}
            format={(v) => `${v.toFixed(2)}×`}
          />
        </SettingsRow>

        <SettingsRow label="Pitch" description="Backup voice only.">
          <SettingsSlider
            label="Speech pitch"
            value={values.pitch}
            min={0}
            max={2}
            step={0.1}
            disabled={voiceDisabled}
            onCommit={(v) => set({ pitch: v })}
            format={(v) => v.toFixed(1)}
          />
        </SettingsRow>

        <SettingsRow label="Volume">
          <SettingsSlider
            label="Speech volume"
            value={values.volume}
            min={0}
            max={1}
            step={0.05}
            disabled={voiceDisabled}
            onCommit={(v) => set({ volume: v })}
            format={(v) => `${Math.round(v * 100)}%`}
          />
        </SettingsRow>

        <SettingsRow
          label="Read every reply aloud"
          description="Speaks each answer as it finishes, without you pressing anything."
        >
          <SettingsToggle
            label="Read every reply aloud"
            checked={values.autoReadReplies}
            onChange={(v) => set({ autoReadReplies: v })}
            disabled={voiceDisabled}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title="Speaking to Astraeya">
        <MicrophoneRow />
        <SettingsRow
          label="Microphone in the composer"
          icon={Mic}
          unavailable={
            sttSupported
              ? undefined
              : "This browser has no speech recognition. Chrome and Edge have it; Firefox and Safari do not."
          }
        >
          <SettingsToggle
            label="Microphone in the composer"
            checked={values.dictationEnabled}
            onChange={(v) => set({ dictationEnabled: v })}
            disabled={!sttSupported || voiceDisabled}
          />
        </SettingsRow>

        <SettingsRow
          label="Speech recognition language"
          description="What language you speak when dictating — not the language of the interface."
        >
          <SettingsDropdown
            label="Speech recognition language"
            value={values.inputLanguage}
            disabled={!sttSupported || values.autoDetectInputLanguage}
            onChange={(v) => set({ inputLanguage: v })}
            options={DICTATION_LANGS}
          />
        </SettingsRow>

        <SettingsRow
          label="Detect the language automatically"
          description="Uses your browser's own language instead of the choice above. Web speech recognition cannot detect a language mid-sentence, so this follows the browser rather than the sound."
        >
          <SettingsToggle
            label="Detect the language automatically"
            checked={values.autoDetectInputLanguage}
            onChange={(v) => set({ autoDetectInputLanguage: v })}
            disabled={!sttSupported}
          />
        </SettingsRow>

        <SettingsRow
          label="Live transcription"
          description="Words appear in the composer as you speak them, rather than only when you stop."
        >
          <SettingsToggle
            label="Live transcription"
            checked={values.liveTranscription}
            onChange={(v) => set({ liveTranscription: v })}
            disabled={!sttSupported}
          />
        </SettingsRow>

        <SettingsRow
          label="Show the transcript"
          description="Displays what was heard before it is sent."
        >
          <SettingsToggle
            label="Show the transcript"
            checked={values.showTranscript}
            onChange={(v) => set({ showTranscript: v })}
            disabled={!sttSupported}
          />
        </SettingsRow>

        <SettingsRow
          label="Let me edit before sending"
          description="Off sends what was heard as soon as you stop talking. On leaves it in the composer to correct."
        >
          <SettingsToggle
            label="Let me edit before sending"
            checked={values.editTranscript}
            onChange={(v) => set({ editTranscript: v })}
            disabled={!sttSupported}
          />
        </SettingsRow>

        <SettingsRow
          label="Send automatically"
          description="Sends as soon as you stop speaking. Ignored while 'Let me edit before sending' is on."
        >
          <SettingsToggle
            label="Send automatically"
            checked={values.autoSubmit}
            onChange={(v) => set({ autoSubmit: v })}
            disabled={!sttSupported || values.editTranscript}
          />
        </SettingsRow>

        <SettingsRow
          label="Microphone behaviour"
          description="Tap starts and stops, and keeps listening through pauses for up to 20 minutes. Hold listens only while the button is held. Continuous also starts listening again after each reply."
        >
          <SegmentedControl
            label="Microphone behaviour"
            value={values.micMode}
            onChange={(v) => set({ micMode: v })}
            options={[
              { value: "tap", label: "Tap" },
              { value: "hold", label: "Hold" },
              { value: "continuous", label: "Continuous" },
            ]}
            disabled={!sttSupported}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title="Audio">
        <SettingsRow
          label="Noise reduction"
          description="Requested when Astraeya opens the microphone. Browser dictation does not accept audio constraints, so this applies to the microphone check below and to live voice."
        >
          <SettingsToggle
            label="Noise reduction"
            checked={values.noiseReduction}
            onChange={(v) => set({ noiseReduction: v })}
          />
        </SettingsRow>

        <SettingsRow label="Audio quality">
          <SegmentedControl
            label="Audio quality"
            value={values.audioQuality}
            onChange={(v) => set({ audioQuality: v })}
            options={[
              { value: "standard", label: "Standard" },
              { value: "high", label: "High" },
            ]}
          />
        </SettingsRow>

        <SettingsRow
          label="Sound effects"
          description="A short tone when listening starts and stops."
        >
          <SettingsToggle
            label="Sound effects"
            checked={values.soundEffects}
            onChange={(v) => set({ soundEffects: v })}
          />
        </SettingsRow>

        <SettingsRow
          label="Haptic feedback"
          description="A brief vibration on devices that have one. Desktop browsers ignore it."
        >
          <SettingsToggle
            label="Haptic feedback"
            checked={values.hapticFeedback}
            onChange={(v) => set({ hapticFeedback: v })}
          />
        </SettingsRow>

        <SettingsRow
          label="Check the microphone"
          description={micDetail ?? "Opens the microphone once and reports what the browser gave back."}
        >
          <div className="flex items-center gap-2">
            {micState === "ok" && <StatusPill tone="ok">Working</StatusPill>}
            {micState === "denied" && <StatusPill tone="off">Blocked</StatusPill>}
            {micState === "unsupported" && (
              <StatusPill tone="off">Unsupported</StatusPill>
            )}
            <SettingsButton
              onClick={checkMicrophone}
              busy={micState === "checking"}
            >
              Test
            </SettingsButton>
          </div>
        </SettingsRow>
      </SettingsCard>
    </>
  );
}


/**
 * Which microphone to listen with. Automatic means the computer's built-in
 * microphone, even when headphones are plugged in. Kept in this browser.
 */
function MicrophoneRow() {
  const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([]);
  const [chosen, setChosen] = useState<string>("");
  const [needsPermission, setNeedsPermission] = useState(false);

  async function refresh() {
    const list = await listMicrophones().catch(() => []);
    setDevices(list.map((d) => ({ deviceId: d.deviceId, label: d.label })));
    setNeedsPermission(list.length > 0 && list.every((d) => !d.label));
  }

  useEffect(() => {
    setChosen(savedMicrophone() ?? "");
    void refresh();
    const onChange = () => void refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", onChange);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", onChange);
  }, []);

  async function allow() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* refused: names stay hidden */
    }
    await refresh();
  }

  const automatic = devices.find((d) => d.deviceId === pickMicrophone(devices, null));
  const options = [
    { value: "", label: automatic?.label ? `Automatic: ${automatic.label}` : "Automatic (built-in microphone)" },
    ...devices
      .filter((d) => d.label)
      .map((d) => ({ value: d.deviceId, label: isHeadset(d.label) ? `${d.label} (headset)` : d.label })),
  ];

  return (
    <SettingsRow
      label="Microphone"
      icon={Mic}
      description="Automatic uses the computer's built-in microphone, even with headphones on, because headset microphones often hear you poorly. Choosing works in recent Chrome and Edge."
    >
      {needsPermission ? (
        <SettingsButton onClick={() => void allow()}>Show microphones</SettingsButton>
      ) : (
        <SettingsDropdown
          label="Microphone"
          value={chosen}
          onChange={(v) => {
            setChosen(v);
            saveMicrophone(v || null);
          }}
          options={options}
        />
      )}
    </SettingsRow>
  );
}
