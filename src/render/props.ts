import type { Job, WordTiming } from "../core/types.js";

/** Everything the Remotion composition needs, as plain data. Paths are relative to the job folder. */
export interface ReelProps {
  [key: string]: unknown;
  fps: number;
  durationSec: number;
  segments: Segment[];
  words: WordTiming[]; // absolute times in the Reel, for captions
  endCard: { fromSec: number; headline: string; sub: string };
  thumbnail: { imageSrc: string; text: string; price?: string };
}

export interface Segment {
  lineId: string;
  fromSec: number;
  durationSec: number;
  src: string;
  kind: "image" | "video";
  motion: "push_in" | "pull_out" | "pan_left" | "pan_right" | "ai_clip";
  aiLabel: boolean;
  onScreen?: string;
  voiceSrc: string;
  voiceFromSec: number;
}

export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1920;
const END_CARD_SEC = 2;

export function buildReelProps(job: Job): ReelProps {
  if (!job.script) throw new Error("No script");
  const asset = (id: string) => {
    const a = job.assets.find((x) => x.id === id);
    if (!a) throw new Error(`Missing asset ${id}`);
    return a;
  };
  const voiceByLine = new Map(job.voice.map((v) => [v.lineId, v]));
  const shotByLine = new Map(job.shots.map((s) => [s.lineId, s]));
  const lines = job.script.lines;
  const lastVoice = voiceByLine.get(lines[lines.length - 1].id);
  if (!lastVoice) throw new Error("Voiceover missing for the last line");
  const speechEnd = lastVoice.startSec + lastVoice.durationSec;
  const durationSec = speechEnd + END_CARD_SEC;

  const segments: Segment[] = lines.map((line, i) => {
    const v = voiceByLine.get(line.id);
    const shot = shotByLine.get(line.id);
    if (!v || !shot) throw new Error(`Line ${line.id} is missing its voice or shot`);
    const fromSec = i === 0 ? 0 : v.startSec;
    const next = lines[i + 1] ? voiceByLine.get(lines[i + 1].id)!.startSec : durationSec;
    const a = asset(shot.assetId);
    return {
      lineId: line.id,
      fromSec,
      durationSec: next - fromSec,
      src: a.path,
      kind: a.kind === "ai_video" ? "video" : "image",
      motion: shot.motion,
      aiLabel: shot.aiLabel,
      onScreen: line.onScreen,
      voiceSrc: asset(v.assetId).path,
      voiceFromSec: v.startSec,
    };
  });

  const words = job.voice.flatMap((v) => v.words.map((w) => ({ word: w.word, start: v.startSec + w.start, end: v.startSec + w.end })));

  const hero = job.shots.find((s) => !s.aiLabel && job.assets.find((a) => a.id === s.assetId)?.kind === "photo") ?? job.shots[0];
  const price = job.facts.find((f) => f.field === "askingPrice" && (f.status === "VERIFIED" || f.status === "USER_SUPPLIED"));
  return {
    fps: FPS,
    durationSec,
    segments,
    words,
    endCard: { fromSec: speechEnd - 0.5, headline: "Property Potential", sub: "See what a property could be worth" },
    thumbnail: {
      imageSrc: asset(hero.assetId).kind === "photo" ? asset(hero.assetId).path : segments.find((s) => s.kind === "image")!.src,
      text: job.script.thumbnailText,
      price: price ? `£${Number(price.value).toLocaleString("en-GB")}` : undefined,
    },
  };
}

/** Groups words into short caption chunks (up to 3 words or ~18 characters, never across a pause). */
export function captionChunks(words: WordTiming[]): { words: WordTiming[]; start: number; end: number }[] {
  const chunks: { words: WordTiming[]; start: number; end: number }[] = [];
  let cur: WordTiming[] = [];
  const flush = () => {
    if (cur.length) chunks.push({ words: cur, start: cur[0].start, end: cur[cur.length - 1].end });
    cur = [];
  };
  for (const w of words) {
    const len = cur.reduce((n, x) => n + x.word.length + 1, 0) + w.word.length;
    const gap = cur.length ? w.start - cur[cur.length - 1].end : 0;
    if (cur.length >= 3 || len > 18 || gap > 0.35) flush();
    cur.push(w);
    if (/[.!?,;:]$/.test(w.word)) flush();
  }
  flush();
  return chunks;
}

/** SRT captions for upload alongside the video (platforms can show them as closed captions). */
export function toSrt(words: WordTiming[]): string {
  const ts = (s: number) => {
    const ms = Math.round(s * 1000);
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const sec = Math.floor((ms % 60_000) / 1000);
    const milli = ms % 1000;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(milli).padStart(3, "0")}`;
  };
  // Longer groups than the burned-in captions: about 7 words per cue.
  const cues: WordTiming[][] = [];
  let cur: WordTiming[] = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= 7 || /[.!?]$/.test(w.word)) {
      cues.push(cur);
      cur = [];
    }
  }
  if (cur.length) cues.push(cur);
  return cues.map((c, i) => `${i + 1}\n${ts(c[0].start)} --> ${ts(c[c.length - 1].end)}\n${c.map((w) => w.word).join(" ")}\n`).join("\n");
}
