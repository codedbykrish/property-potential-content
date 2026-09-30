import path from "node:path";
import type { Config } from "../core/config.js";
import { LocalStore } from "../core/store.js";
import { SupabaseSync } from "../core/supabase-sync.js";
import type { Job, StageName } from "../core/types.js";
import { newId, now } from "../core/util.js";
import { createLlm } from "../providers/llm.js";
import { LivePublicData, NoPublicData } from "../providers/public-data.js";
import { createVisualGenerator } from "../providers/runway.js";
import { createTts } from "../providers/tts.js";
import type { Ctx, Stage } from "./context.js";
import { extractFacts, verify } from "./facts.js";
import { intake, photos } from "./intake.js";
import { visuals, voice } from "./media.js";
import { qc, render } from "./render.js";
import { angle, script } from "./script.js";

export const STAGES: [StageName, Stage][] = [
  ["intake", intake],
  ["photos", photos],
  ["facts", extractFacts],
  ["verify", verify],
  ["angle", angle],
  ["script", script],
  ["visuals", visuals],
  ["voice", voice],
  ["render", render],
  ["qc", qc],
];

export function createCtx(config: Config, log: (m: string) => void = console.log): Ctx {
  return {
    config,
    store: new LocalStore(config.dataDir),
    llm: createLlm(config),
    tts: createTts(config),
    visuals: createVisualGenerator(config),
    publicData: config.mock ? new NoPublicData() : new LivePublicData({ epcEmail: config.epcEmail, epcApiKey: config.epcApiKey }),
    log,
  };
}

export function newJob(briefPath: string, options: Partial<Job["options"]> = {}): Job {
  const t = now();
  return {
    id: newId("reel"),
    createdAt: t,
    updatedAt: t,
    status: "draft",
    briefPath: path.resolve(briefPath),
    options: { allowAiVisuals: true, force: false, ...options },
    assets: [],
    photoLabels: [],
    facts: [],
    angles: [],
    aiVisualRequests: [],
    scriptIssues: [],
    shots: [],
    voice: [],
    renders: [],
    reviews: [],
    stages: [],
    notes: [],
  };
}

/**
 * Runs the stages in order, from `from` onwards, saving after each one so a
 * failed or changed job can be resumed from any stage.
 */
export async function runPipeline(job: Job, ctx: Ctx, from: StageName = "intake"): Promise<Job> {
  const sync = new SupabaseSync(ctx.config, ctx.store);
  const startAt = STAGES.findIndex(([name]) => name === from);
  if (startAt < 0) throw new Error(`Unknown stage ${from}`);
  if (["approved", "scheduled", "published"].includes(job.status)) throw new Error(`Job ${job.id} is ${job.status}; make a new job instead of changing it.`);
  job.status = "draft";
  ctx.log(`Job ${job.id}: providers ${ctx.llm.name}, ${ctx.tts.name}, visuals ${ctx.visuals.name}${sync.enabled ? ", syncing to Supabase" : ""}`);

  for (const [name, stage] of STAGES.slice(startAt)) {
    const startedAt = now();
    const llmBefore = ctx.llm.usage.costUsd;
    ctx.log(`▶ ${name}`);
    try {
      const res = (await stage(job, ctx)) ?? {};
      job.stages.push({ stage: name, status: "ok", startedAt, finishedAt: now(), costUsd: (res.costUsd ?? 0) + (ctx.llm.usage.costUsd - llmBefore), providers: res.providers ?? [] });
      job.updatedAt = now();
      await ctx.store.saveJob(job);
      await sync.sync(job);
      if (res.halt) {
        ctx.log(`■ stopped after ${name}: ${job.status}`);
        return job;
      }
    } catch (e) {
      const msg = (e as Error).message;
      job.stages.push({ stage: name, status: "failed", startedAt, finishedAt: now(), error: msg, costUsd: ctx.llm.usage.costUsd - llmBefore, providers: [] });
      if (job.status === "draft") job.status = "qc_failed";
      job.notes.push(`${name} failed: ${msg}`);
      job.updatedAt = now();
      await ctx.store.saveJob(job);
      await sync.sync(job).catch(() => {});
      throw e;
    }
  }
  return job;
}

export function totalCost(job: Job): number {
  return job.stages.reduce((n, s) => n + s.costUsd, 0);
}
