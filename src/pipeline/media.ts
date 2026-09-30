import fs from "node:fs/promises";
import sharp from "sharp";
import type { Shot, VoiceLine } from "../core/types.js";
import { newId } from "../core/util.js";
import type { Stage } from "./context.js";

const MOTIONS: Shot["motion"][] = ["push_in", "pan_right", "pull_out", "pan_left"];

/**
 * Plans one shot per script line. Real photos get a Ken Burns move in Remotion.
 * AI images are generated only for lines the script asked for, and fall back to a
 * real photo if Runway is off or fails. With Runway on, the opening photo can get
 * camera-only motion (never altering the property).
 */
export const visuals: Stage = async (job, ctx) => {
  if (!job.script) throw new Error("No script");
  const photoById = new Map(job.assets.filter((a) => a.kind === "photo").map((a) => [a.id, a]));
  const ranked = [...job.photoLabels].sort((a, b) => b.quality - a.quality).map((l) => l.assetId);
  let costUsd = 0;
  let generated = 0;
  const providers = new Set<string>();
  job.assets = job.assets.filter((a) => a.kind !== "ai_image" && a.kind !== "ai_video");
  job.shots = [];

  for (const [i, line] of job.script.lines.entries()) {
    if (line.visualId.startsWith("ai:")) {
      const req = job.aiVisualRequests.find((r) => r.lineId === line.id);
      if (req && ctx.visuals.enabled && generated < ctx.config.runwayMaxClips) {
        try {
          ctx.log(`Generating AI image for ${line.id}`);
          const img = await ctx.visuals.generateImage(req.prompt);
          const id = newId("ast");
          const rel = await ctx.store.writeFile(job.id, `generated/${id}.${img.ext}`, img.data);
          job.assets.push({ id, kind: "ai_image", path: rel, origin: "ai_generated", rights: "generated", meta: { prompt: req.prompt, reason: req.reason, provider: ctx.visuals.name } });
          job.shots.push({ lineId: line.id, assetId: id, motion: "push_in", aiLabel: true });
          costUsd += img.costUsd;
          generated++;
          providers.add(ctx.visuals.name);
          continue;
        } catch (e) {
          job.notes.push(`AI image for ${line.id} failed, used a photo instead: ${(e as Error).message}`);
        }
      }
      // Fallback: the best photo not already used by the neighbouring lines.
      const neighbours = new Set(job.shots.slice(-1).map((s) => s.assetId));
      const fallback = ranked.find((id) => !neighbours.has(id)) ?? ranked[0];
      job.shots.push({ lineId: line.id, assetId: fallback, motion: MOTIONS[i % MOTIONS.length], aiLabel: false });
      continue;
    }
    const photo = photoById.get(line.visualId);
    if (!photo) throw new Error(`Line ${line.id} uses unknown photo ${line.visualId}`);
    const landscape = (photo.width ?? 1) > (photo.height ?? 1) * 1.1;
    job.shots.push({ lineId: line.id, assetId: photo.id, motion: landscape ? (i % 2 ? "pan_left" : "pan_right") : MOTIONS[i % MOTIONS.length], aiLabel: false });
  }

  // Optional: camera motion on the hook shot via Runway image-to-video.
  const first = job.shots[0];
  if (ctx.visuals.enabled && first && !first.aiLabel && generated < ctx.config.runwayMaxClips) {
    try {
      const photo = photoById.get(first.assetId)!;
      const small = await sharp(await fs.readFile(ctx.store.abs(job.id, photo.path))).resize(1280, 1280, { fit: "inside" }).jpeg({ quality: 85 }).toBuffer();
      ctx.log("Adding camera motion to the opening shot");
      const clip = await ctx.visuals.animatePhoto(small, 5);
      const id = newId("ast");
      const rel = await ctx.store.writeFile(job.id, `generated/${id}.${clip.ext}`, clip.data);
      job.assets.push({ id, kind: "ai_video", path: rel, origin: "ai_generated", derivedFrom: photo.id, rights: "generated", durationSec: 5, meta: { provider: ctx.visuals.name, note: "camera motion only" } });
      job.shots[0] = { ...first, assetId: id, motion: "ai_clip", aiLabel: true };
      costUsd += clip.costUsd;
      providers.add(ctx.visuals.name);
    } catch (e) {
      job.notes.push(`Runway motion failed, kept the still photo: ${(e as Error).message}`);
    }
  }
  return { costUsd, providers: [...providers] };
};

const GAP_SEC = 0.25; // breath between lines
const LEAD_IN_SEC = 0.3;

/** Records each line separately (so one line can be redone) and lays them end to end. */
export const voice: Stage = async (job, ctx) => {
  if (!job.script) throw new Error("No script");
  job.assets = job.assets.filter((a) => a.kind !== "voice_line");
  const lines = job.script.lines;
  const out: VoiceLine[] = [];
  let t = LEAD_IN_SEC;
  let costUsd = 0;
  for (const [i, line] of lines.entries()) {
    const spoken = await ctx.tts.speak(line.text, { previous: lines[i - 1]?.text, next: lines[i + 1]?.text });
    const id = newId("ast");
    const rel = await ctx.store.writeFile(job.id, `voice/${line.id}.${spoken.ext}`, spoken.audio);
    job.assets.push({ id, kind: "voice_line", path: rel, origin: "tts", rights: "generated", durationSec: spoken.durationSec, meta: { provider: ctx.tts.name, lineId: line.id } });
    out.push({ lineId: line.id, assetId: id, startSec: t, durationSec: spoken.durationSec, words: spoken.words });
    t += spoken.durationSec + GAP_SEC;
    costUsd += spoken.costUsd;
  }
  job.voice = out;
  return { costUsd, providers: [ctx.tts.name] };
};
