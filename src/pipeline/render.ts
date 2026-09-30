import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { getVideoMetadata, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import type { QcCheck, Render } from "../core/types.js";
import { SPEAKABLE_STATUSES } from "../core/types.js";
import { newId, now } from "../core/util.js";
import { buildReelProps, HEIGHT, toSrt, WIDTH } from "../render/props.js";
import type { Stage } from "./context.js";
import { checkScript } from "./script.js";

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "../render/remotion/index.ts");

/** Renders the 9:16 MP4 and the thumbnail with Remotion, plus an SRT caption file. */
export const render: Stage = async (job, ctx) => {
  const props = buildReelProps(job);
  const version = job.renders.length + 1;
  const jobDir = ctx.store.jobDir(job.id);

  ctx.log("Bundling the Remotion project");
  // The job folder is the public dir, so staticFile("photos/x.jpg") resolves to this job's files.
  const serveUrl = await bundle({ entryPoint: ENTRY, publicDir: jobDir });
  const browser = { browserExecutable: ctx.config.browserExecutable ?? null, logLevel: "error" as const };

  const composition = await selectComposition({ serveUrl, id: "PropertyReel", inputProps: props, ...browser });
  const videoRel = `renders/v${version}.mp4`;
  ctx.log(`Rendering ${composition.durationInFrames} frames`);
  let lastPct = -10;
  await renderMedia({
    serveUrl,
    composition,
    inputProps: props,
    codec: "h264",
    audioCodec: "aac",
    crf: 20,
    outputLocation: ctx.store.abs(job.id, videoRel),
    ...browser,
    onProgress: ({ progress }) => {
      const pct = Math.floor(progress * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        ctx.log(`  ${pct}%`);
      }
    },
  });

  const thumb = await selectComposition({ serveUrl, id: "Thumbnail", inputProps: props, ...browser });
  const thumbRel = `renders/v${version}-thumbnail.jpg`;
  await renderStill({ serveUrl, composition: thumb, inputProps: props, output: ctx.store.abs(job.id, thumbRel), imageFormat: "jpeg", jpegQuality: 90, ...browser });

  const srtRel = await ctx.store.writeFile(job.id, `renders/v${version}.srt`, toSrt(props.words));

  const videoId = newId("ast");
  const thumbId = newId("ast");
  const srtId = newId("ast");
  job.assets.push(
    { id: videoId, kind: "render", path: videoRel, origin: "render", rights: "n/a", width: WIDTH, height: HEIGHT, durationSec: props.durationSec, meta: { version } },
    { id: thumbId, kind: "thumbnail", path: thumbRel, origin: "render", rights: "n/a", width: WIDTH, height: HEIGHT, meta: { version } },
    { id: srtId, kind: "captions", path: srtRel, origin: "render", rights: "n/a", meta: { version } },
  );
  const mockProviders = [ctx.llm, ctx.tts].filter((p) => p.mock).map((p) => p.name);
  const r: Render = { id: newId("rnd"), version, videoAssetId: videoId, thumbnailAssetId: thumbId, captionsAssetId: srtId, durationSec: props.durationSec, createdAt: now(), mockProviders, qc: [] };
  job.renders.push(r);
  return { providers: ["remotion"] };
};

/** Automatic checks before a Reel reaches you. Failed errors stop it; failed warnings are shown on the review page. */
export const qc: Stage = async (job, ctx) => {
  const r = job.renders[job.renders.length - 1];
  if (!r) throw new Error("Nothing rendered");
  const checks: QcCheck[] = [];
  const check = (name: string, ok: boolean, detail: string, severity: QcCheck["severity"] = "error") => checks.push({ name, ok, severity, detail });
  const asset = (id: string) => job.assets.find((a) => a.id === id);

  try {
    const meta = await getVideoMetadata(ctx.store.abs(job.id, asset(r.videoAssetId)!.path));
    check("Format", meta.width === WIDTH && meta.height === HEIGHT && meta.codec === "h264", `${meta.width}×${meta.height}, ${meta.codec}, audio ${meta.audioCodec ?? "none"}`);
    check("Has audio", meta.audioCodec === "aac", `audio codec ${meta.audioCodec ?? "none"}`);
    const d = meta.durationInSeconds ?? 0;
    check("Duration", d >= 20 && d <= 60, `${d.toFixed(1)} s (must be 20 to 60 s)`);
  } catch (e) {
    check("Format", false, `Couldn't read the video: ${(e as Error).message}`);
  }

  const photoIds = job.photoLabels.map((l) => l.assetId);
  const issues = job.script ? checkScript({ script: job.script, facts: job.facts, photoIds, aiVisuals: job.aiVisualRequests }) : ["No script"];
  check("Claim gate", issues.length === 0, issues.length ? issues.join(" ") : "Every number traces to a fact the script may state.");

  const shownPhotos = [...new Set(job.shots.map((s) => s.assetId))].map((id) => asset(id)).filter((a) => a?.kind === "photo");
  const badRights = shownPhotos.filter((a) => a!.rights !== "owned" && a!.rights !== "permission");
  check("Photo rights", badRights.length === 0, badRights.length ? `${badRights.length} photos without owned/permission rights` : `All ${shownPhotos.length} photos are ${job.source?.photoRights}${job.source?.permissionNote ? ` (${job.source.permissionNote})` : ""}.`);

  const aiShots = job.shots.filter((s) => asset(s.assetId)?.origin === "ai_generated");
  check("AI visuals labelled", aiShots.every((s) => s.aiLabel), `${aiShots.length} AI shot(s), all labelled on screen`);

  const spokenWords = job.voice.flatMap((v) => v.words.map((w) => w.word)).join(" ");
  const scriptWords = (job.script?.lines ?? []).map((l) => l.text).join(" ").split(/\s+/).filter(Boolean).join(" ");
  check("Captions match script", spokenWords === scriptWords, spokenWords === scriptWords ? "Every caption word comes from the script." : "Caption words differ from the script.");

  let maxGap = 0;
  for (let i = 1; i < job.voice.length; i++) {
    const prev = job.voice[i - 1];
    maxGap = Math.max(maxGap, job.voice[i].startSec - (prev.startSec + prev.durationSec));
  }
  check("No long silences", maxGap <= 1, `Longest gap between lines ${maxGap.toFixed(2)} s`);

  const cited = new Set((job.script?.lines ?? []).flatMap((l) => l.factIds));
  const conflicted = job.facts.filter((f) => cited.has(f.id) && f.conflicts.length);
  check("Cited facts without conflicts", conflicted.length === 0, conflicted.length ? `Conflicts on: ${conflicted.map((f) => f.label).join(", ")}. Check them before approving.` : "No cited fact has a conflicting source.", "warning");
  const unverifiedPrice = job.facts.find((f) => f.field === "askingPrice" && !SPEAKABLE_STATUSES.includes(f.status));
  if (unverifiedPrice) check("Asking price checked", false, "The asking price couldn't be confirmed, so it isn't mentioned.", "warning");

  check("Real providers", r.mockProviders.length === 0, r.mockProviders.length ? `Made with offline stand-ins (${r.mockProviders.join(", ")}); add API keys for a real Reel. This render can't be approved.` : "Claude and ElevenLabs were used.", "warning");

  r.qc = checks;
  const failed = checks.filter((c) => !c.ok && c.severity === "error");
  if (failed.length) {
    job.status = "qc_failed";
    throw new Error(`Quality check failed: ${failed.map((c) => `${c.name}: ${c.detail}`).join("; ")}`);
  }
  job.status = "in_review";
};
