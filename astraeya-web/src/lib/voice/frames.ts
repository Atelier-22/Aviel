/**
 * Reading the frames /voice/speak streams back, one per sentence:
 *   [4-byte length][JSON header][4-byte length][WAV bytes]
 * Bytes arrive in arbitrary pieces; push() returns whole frames as they
 * complete.
 */

export interface SpeechFrameHeader {
  index: number;
  count: number;
  text?: string;
  voice?: string;
  seconds?: number;
  substituted?: boolean;
  /** Set when the rest could not be made; no audio follows. */
  error?: "unavailable" | "failed";
  /** With an error: the sentences that were not spoken. */
  remaining?: string[];
}

export interface SpeechFrame {
  header: SpeechFrameHeader;
  audio: Uint8Array;
}

export class FrameReader {
  private buf = new Uint8Array(0);
  private decoder = new TextDecoder();

  push(chunk: Uint8Array): SpeechFrame[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    const frames: SpeechFrame[] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      const headLen = view.getUint32(0);
      if (this.buf.length < 8 + headLen) break;
      const audioLen = view.getUint32(4 + headLen);
      const total = 8 + headLen + audioLen;
      if (this.buf.length < total) break;
      const header = JSON.parse(this.decoder.decode(this.buf.subarray(4, 4 + headLen))) as SpeechFrameHeader;
      // Copied out, because decodeAudioData takes ownership of its buffer.
      const audio = this.buf.slice(8 + headLen, total);
      frames.push({ header, audio });
      this.buf = this.buf.slice(total);
    }
    return frames;
  }
}
