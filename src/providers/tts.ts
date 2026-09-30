import type { Config } from "../core/config.js";
import type { WordTiming } from "../core/types.js";

export interface SpokenLine {
  audio: Buffer;
  ext: "mp3" | "wav";
  durationSec: number;
  words: WordTiming[]; // words as written in the script, timed relative to the start of this line
  costUsd: number;
}

export interface Tts {
  readonly name: string;
  readonly mock: boolean;
  speak(text: string, context?: { previous?: string; next?: string }): Promise<SpokenLine>;
}

/**
 * How words should be said, applied to the audio request only (captions keep the
 * written form). Extend this as odd UK place names come up.
 */
const PRONUNCIATION: [RegExp, string][] = [
  [/\bsq\.?\s?ft\b/gi, "square feet"],
  [/\bsq\.?\s?m\b/gi, "square metres"],
  [/\bEPC\b/g, "E P C"],
  [/\bLeominster\b/g, "Lemster"],
  [/\bWorcester\b/g, "Wooster"],
  [/\bGloucester\b/g, "Gloster"],
  [/\bMarylebone\b/g, "Marleybone"],
];

export function forSpeech(text: string): string {
  return PRONUNCIATION.reduce((s, [re, say]) => s.replace(re, say), text);
}

/** Splits written text into caption words (punctuation stays attached). */
export function splitWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Maps character-level timings from the TTS onto the written words. The spoken text
 * may differ from the written one (pronunciation fixes), so words are timed
 * proportionally across the spoken span rather than matched character by character.
 */
export function timeWords(written: string, spokenChars: string[], starts: number[], ends: number[]): WordTiming[] {
  const words = splitWords(written);
  if (words.length === 0 || spokenChars.length === 0) return [];
  const firstIdx = spokenChars.findIndex((c) => c.trim() !== "");
  let lastIdx = spokenChars.length - 1;
  while (lastIdx > 0 && spokenChars[lastIdx].trim() === "") lastIdx--;
  const t0 = starts[Math.max(0, firstIdx)];
  const t1 = ends[lastIdx];
  const totalChars = words.reduce((n, w) => n + w.length, 0);
  let acc = 0;
  return words.map((word) => {
    const start = t0 + ((t1 - t0) * acc) / totalChars;
    acc += word.length;
    const end = t0 + ((t1 - t0) * acc) / totalChars;
    return { word, start, end };
  });
}

// ElevenLabs API price per 1,000 characters (multilingual model), for the cost ledger.
const ELEVENLABS_USD_PER_1K = 0.08;

export class ElevenLabsTts implements Tts {
  readonly name = "elevenlabs";
  readonly mock = false;

  constructor(private config: Config) {}

  async speak(text: string, context: { previous?: string; next?: string } = {}): Promise<SpokenLine> {
    const spoken = forSpeech(text);
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.config.elevenLabsVoiceId}/with-timestamps?output_format=mp3_44100_128`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": this.config.elevenLabsApiKey!, "content-type": "application/json" },
      body: JSON.stringify({
        text: spoken,
        model_id: this.config.elevenLabsModel,
        // Neighbouring lines keep intonation consistent when lines are recorded separately.
        previous_text: context.previous ? forSpeech(context.previous) : undefined,
        next_text: context.next ? forSpeech(context.next) : undefined,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`ElevenLabs failed: HTTP ${res.status} ${await res.text()}`);
    const body = (await res.json()) as {
      audio_base64: string;
      alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
    };
    const a = body.alignment;
    if (!a || a.characters.length === 0) throw new Error("ElevenLabs returned no timing data");
    const durationSec = a.character_end_times_seconds[a.character_end_times_seconds.length - 1] + 0.15;
    return {
      audio: Buffer.from(body.audio_base64, "base64"),
      ext: "mp3",
      durationSec,
      words: timeWords(text, a.characters, a.character_start_times_seconds, a.character_end_times_seconds),
      costUsd: (spoken.length / 1000) * ELEVENLABS_USD_PER_1K,
    };
  }
}

/** Offline stand-in: silent audio with timings at a natural speaking pace (~2.6 words a second). */
export class MockTts implements Tts {
  readonly name = "mock-tts";
  readonly mock = true;

  async speak(text: string): Promise<SpokenLine> {
    const words = splitWords(text);
    const perWord = 1 / 2.6;
    const durationSec = Math.max(1, words.length * perWord + 0.3);
    return {
      audio: silentWav(durationSec),
      ext: "wav",
      durationSec,
      words: words.map((word, i) => ({ word, start: 0.1 + i * perWord, end: 0.1 + (i + 1) * perWord })),
      costUsd: 0,
    };
  }
}

function silentWav(seconds: number, sampleRate = 22050): Buffer {
  const samples = Math.round(seconds * sampleRate);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  return buf;
}

export function createTts(config: Config): Tts {
  if (!config.mock && config.elevenLabsApiKey) return new ElevenLabsTts(config);
  return new MockTts();
}
