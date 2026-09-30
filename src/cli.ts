import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./core/config.js";
import { decide } from "./core/review.js";
import { LocalStore } from "./core/store.js";
import { SupabaseSync } from "./core/supabase-sync.js";
import { StageName } from "./core/types.js";
import { createCtx, newJob, runPipeline, totalCost } from "./pipeline/run.js";
import { startReviewServer } from "./review/server.js";

const HELP = `pp-content: turn a property and your own photos into a draft Reel for approval.

Usage (via npm run pp-content -- <command>):
  new <brief.yaml> [--no-ai-visuals] [--force] [--mock]   make a new Reel from a brief
  rerun <jobId> [--from <stage>] [--mock]                 re-run a job from a stage (${StageName.options.join(", ")})
  list                                                    list jobs
  show <jobId>                                            print a job's status, QC and costs
  review [--port 4321]                                    open the local review page
  decide <jobId> approve|changes|reject [--note "..."]    record a decision from the terminal
  export <jobId> [--out ./out]                            copy an approved Reel's files for posting

--mock uses offline stand-ins (template script, silent voice) so you can test without API keys.
`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      from: { type: "string" },
      mock: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "no-ai-visuals": { type: "boolean", default: false },
      port: { type: "string", default: "4321" },
      note: { type: "string", default: "" },
      out: { type: "string", default: "out" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [cmd, ...args] = positionals;
  if (!cmd || values.help) {
    console.log(HELP);
    return;
  }
  const config = loadConfig(process.env, values.mock ? { mock: true } : {});
  const store = new LocalStore(config.dataDir);

  switch (cmd) {
    case "new": {
      if (!args[0]) throw new Error("Give the path to a brief YAML file.");
      const job = newJob(args[0], { allowAiVisuals: !values["no-ai-visuals"], force: values.force });
      await store.saveJob(job);
      await runAndReport(job.id, "intake");
      break;
    }
    case "rerun": {
      if (!args[0]) throw new Error("Give a job id.");
      const from = StageName.parse(values.from ?? "intake");
      await runAndReport(args[0], from);
      break;
    }
    case "list": {
      for (const j of await store.listJobs()) console.log(`${j.id}  ${j.status.padEnd(18)} ${j.script?.title ?? j.briefPath}`);
      break;
    }
    case "show": {
      const j = await store.loadJob(args[0]);
      const r = j.renders.at(-1);
      console.log(`${j.id}: ${j.status}, ${j.facts.length} facts, cost $${totalCost(j).toFixed(2)}`);
      for (const s of j.stages.slice(-10)) console.log(`  ${s.stage.padEnd(8)} ${s.status.padEnd(7)} $${s.costUsd.toFixed(3)} ${s.error ?? ""}`);
      if (r) {
        console.log(`Render v${r.version}: ${store.abs(j.id, j.assets.find((a) => a.id === r.videoAssetId)!.path)}`);
        for (const c of r.qc) console.log(`  ${c.ok ? "✓" : c.severity === "error" ? "✗" : "!"} ${c.name}: ${c.detail}`);
      }
      for (const n of j.notes) console.log(`  note: ${n}`);
      break;
    }
    case "review": {
      const port = Number(values.port);
      startReviewServer(config, port);
      console.log(`Review page: http://127.0.0.1:${port}`);
      break;
    }
    case "decide": {
      const j = await store.loadJob(args[0]);
      const map = { approve: "approved", changes: "changes_requested", reject: "rejected" } as const;
      const d = map[args[1] as keyof typeof map];
      if (!d) throw new Error("Decision must be approve, changes or reject.");
      decide(j, d, values.note, config.reviewer);
      await store.saveJob(j);
      await new SupabaseSync(config, store).sync(j);
      console.log(`${j.id} is now ${j.status}.`);
      break;
    }
    case "export": {
      const j = await store.loadJob(args[0]);
      if (j.status !== "approved") throw new Error(`Only approved Reels can be exported; this one is ${j.status}.`);
      const r = j.renders.at(-1)!;
      const approval = j.reviews.findLast((x) => x.decision === "approved");
      if (approval?.renderId !== r.id) throw new Error("The approval is for an older render.");
      const out = path.resolve(values.out, j.id);
      await fs.mkdir(out, { recursive: true });
      const copy = async (id: string, name: string) => fs.copyFile(store.abs(j.id, j.assets.find((a) => a.id === id)!.path), path.join(out, name));
      await copy(r.videoAssetId, "reel.mp4");
      await copy(r.thumbnailAssetId, "thumbnail.jpg");
      await copy(r.captionsAssetId, "captions.srt");
      await fs.writeFile(path.join(out, "caption.txt"), `${j.script!.caption}\n\n${j.script!.hashtags.map((h) => `#${h}`).join(" ")}\n`);
      await fs.writeFile(path.join(out, "fact-record.json"), JSON.stringify({ id: j.id, source: { ...j.source, listingText: undefined }, facts: j.facts, script: j.script, approval }, null, 2));
      console.log(`Exported to ${out}`);
      break;
    }
    default:
      console.log(HELP);
      process.exitCode = 1;
  }

  async function runAndReport(jobId: string, from: StageName) {
    const ctx = createCtx(config, (m) => console.log(m));
    const job = await store.loadJob(jobId);
    try {
      await runPipeline(job, ctx, from);
    } finally {
      console.log(`\n${job.id}: ${job.status}. Cost so far $${totalCost(job).toFixed(2)}.`);
      if (job.status === "in_review") console.log("Open the review page with: npm run pp-content -- review");
    }
  }
}

main().catch((e) => {
  console.error(`\nError: ${(e as Error).message}`);
  process.exitCode = 1;
});
