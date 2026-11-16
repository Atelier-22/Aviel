# Astra Assist

Astraeya on the Windows desktop. Press **Windows + Ctrl + A** (or Ctrl + Alt + A
if Windows has taken that) to turn it on: a small Astraeya bubble follows the
cursor, listens on the computer's built-in microphone, looks at the screen when
asked something, answers out loud, points at things and puts drafts on the
clipboard. The same keys, or saying "turn off", switch it off. Guide only: it
never clicks or types for the person.

- `src/main.js`: hotkey, tray, sign-in (token encrypted with Windows DPAPI via
  safeStorage), screen capture, pointer overlay, clipboard.
- `src/bubble.*`, `src/speech.js`: the bubble, listening (voice activity,
  16 kHz WAV), Whisper through `POST /voice/transcribe`, `POST /assist/ask`,
  and the streamed voice (`POST /voice/speak`).
- `src/setup.*`: first-run sign-in and how-to. `src/pointer.*`: the marker.

Run in development: `npm install`, then `npm start` (`ASTRAEYA_API_URL` to
point at another API). Build the installer: `npm run dist`, which writes
`dist/AstraAssistSetup-<version>.exe` (unsigned until a code-signing
certificate is configured, so Windows SmartScreen will warn).

Needs the voice server to have speech-to-text (faster-whisper; see
`astraeya-voice`). Next: the "Hey Astra" wake word.
