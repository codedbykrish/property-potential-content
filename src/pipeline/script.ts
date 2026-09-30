import type { Fact, Script } from "../core/types.js";
import { SPEAKABLE_STATUSES } from "../core/types.js";
import { newId } from "../core/util.js";
import type { AiVisualRequest } from "../providers/llm.js";
import type { Stage } from "./context.js";

/** Below this worthiness the job stops with "not worth a Reel" (the gate discovery will reuse). */
export const MIN_WORTHINESS = 4;

export const angle: Stage = async (job, ctx) => {
  const proposed = await ctx.llm.proposeAngles({ facts: job.facts, photos: job.photoLabels });
  const known = new Set(job.facts.map((f) => f.id));
  job.angles = proposed.map((a) => ({ ...a, id: newId("ang"), factIds: a.factIds.filter((id) => known.has(id)) }));
  const best = [...job.angles].sort((a, b) => b.worthiness - a.worthiness)[0];
  const cost = { providers: [ctx.llm.name] };
  if (!best) throw new Error("No angles were proposed");
  if (!job.chosenAngleId || !job.angles.some((a) => a.id === job.chosenAngleId)) job.chosenAngleId = best.id;
  if (best.worthiness < MIN_WORTHINESS && !job.options.force) {
    job.status = "not_worth_it";
    job.notes.push(`Best angle scored ${best.worthiness}/10, below ${MIN_WORTHINESS}. Re-run with --force to make it anyway.`);
    return { ...cost, halt: true };
  }
  return cost;
};

const BANNED = [
  "bargain",
  "guaranteed",
  "guarantee",
  "investment opportunity",
  "won't last",
  "wont last",
  "must see",
  "must-see",
  "steal",
  "no brainer",
  "no-brainer",
  "yield",
  "return on investment",
  "roi",
  "will increase in value",
  "cheapest",
  "best value",
];
const HEDGES = /\b(around|about|roughly|approximately|estimated|circa)\b/i;
const ATTRIBUTION = /\b(listed|listing|asking|guide price|on the market|offers (over|in excess|in the region)|advertised|marketed)\b/i;
// "one" is left out: it is usually a pronoun ("this one").
const NUMBER_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/** Every number a line states: "£350,000", "£350k", "1,200", "3", "three", "1930s". */
export function numbersIn(text: string): { raw: string; value: number; decade?: boolean }[] {
  const out: { raw: string; value: number; decade?: boolean }[] = [];
  // No trailing word boundary, so "1930s", "3bed" and "250k" are all caught.
  const re = /(£)?(\d[\d,]*(?:\.\d+)?)(\s?k(?![a-z])|\s?m(?![a-z])|s(?![a-z]))?/gi;
  for (const m of text.matchAll(re)) {
    const [raw, pound, num, suffix = ""] = m;
    let value = Number(num.replace(/,/g, ""));
    const suf = suffix.trim().toLowerCase();
    if (suf === "k") value *= 1_000;
    if (suf === "m" && pound) value *= 1_000_000; // "£1.2m"; a bare "5m" stays 5 (metres)
    const decade = suf === "s" && /^\d{3}0$/.test(num);
    if (Number.isFinite(value)) out.push({ raw, value, decade });
  }
  for (const [w, n] of Object.entries(NUMBER_WORDS)) {
    for (const m of text.matchAll(new RegExp(`\\b${w}\\b`, "gi"))) out.push({ raw: m[0], value: n });
  }
  return out;
}

function numberMatchesFact(n: { value: number; decade?: boolean }, f: Fact): boolean {
  const vals: number[] = [];
  if (typeof f.value === "number") vals.push(f.value);
  if (typeof f.value === "string") for (const m of f.value.replace(/,/g, "").matchAll(/\d+(\.\d+)?/g)) vals.push(Number(m[0]));
  return vals.some((v) => {
    if (n.decade) return Math.floor(v / 10) * 10 === n.value;
    if (Math.abs(v - n.value) < 1e-6) return true;
    // Allow rounded speech: "£350k" for 349,950, "1,200 sq ft" for 1,195 (within 1%).
    return v > 100 && Math.abs(v - n.value) / v <= 0.01;
  });
}

export interface GateInput {
  script: Script;
  facts: Fact[];
  photoIds: string[];
  aiVisuals: AiVisualRequest[];
}

/**
 * The claim gate. Plain code, so the model can't talk its way past it:
 * every number must trace to a cited fact the script is allowed to state.
 */
export function checkScript({ script, facts, photoIds, aiVisuals }: GateInput): string[] {
  const issues: string[] = [];
  const byId = new Map(facts.map((f) => [f.id, f]));
  const photos = new Set(photoIds);
  const aiLines = new Set(aiVisuals.map((a) => a.lineId));
  const words = script.lines.reduce((n, l) => n + l.text.split(/\s+/).filter(Boolean).length, 0);

  if (script.lines.length < 4 || script.lines.length > 10) issues.push(`Script has ${script.lines.length} lines; aim for 6 to 9.`);
  if (words < 55 || words > 130) issues.push(`Script is ${words} words; it must be 55 to 130 words (about 25 to 50 seconds).`);
  if (script.lines[0]?.role !== "hook") issues.push("The first line must be the hook.");
  const hookWords = script.lines[0]?.text.split(/\s+/).length ?? 0;
  if (hookWords > 14) issues.push(`The hook is ${hookWords} words; keep it under 14 so it lands in 2 seconds.`);
  if (!script.lines.some((l) => l.role === "cta")) issues.push("There is no CTA line.");
  if (aiVisuals.length > 2) issues.push(`${aiVisuals.length} AI visuals requested; the limit is 2.`);

  const photoUse = new Map<string, number>();
  for (const line of script.lines) {
    const where = `Line ${line.id} ("${line.text}")`;
    const lower = line.text.toLowerCase();
    for (const b of BANNED) if (new RegExp(`\\b${b.replace(/[-']/g, ".")}\\b`, "i").test(lower)) issues.push(`${where} uses "${b}", which isn't allowed.`);

    if (line.visualId.startsWith("ai:")) {
      if (!aiLines.has(line.id)) issues.push(`${where} shows an AI visual that was never requested.`);
    } else if (!photos.has(line.visualId)) {
      issues.push(`${where} uses visual ${line.visualId}, which isn't one of the photos.`);
    } else {
      photoUse.set(line.visualId, (photoUse.get(line.visualId) ?? 0) + 1);
    }

    const cited: Fact[] = [];
    for (const id of line.factIds) {
      const f = byId.get(id);
      if (!f) {
        issues.push(`${where} cites fact ${id}, which doesn't exist.`);
        continue;
      }
      cited.push(f);
      const hedged = HEDGES.test(line.text);
      if (!SPEAKABLE_STATUSES.includes(f.status) && !(f.status === "ESTIMATE" && hedged)) {
        issues.push(
          f.status === "ESTIMATE"
            ? `${where} states the estimate "${f.label}" without "around" or "about".`
            : `${where} relies on "${f.label}", which is ${f.status} and can't be stated as fact.`,
        );
      }
      if (f.scope === "as_advertised" && ["askingPrice", "pricePerSqFt"].includes(f.field) && !ATTRIBUTION.test(line.text)) {
        issues.push(`${where} gives the listing's price without attributing it ("listed at", "on the market for").`);
      }
    }

    for (const text of [line.text, line.onScreen ?? ""]) {
      for (const n of numbersIn(text)) {
        if (!cited.some((f) => numberMatchesFact(n, f))) {
          issues.push(`${where} says "${n.raw.trim()}"${text === line.onScreen ? " on screen" : ""}, which doesn't match any fact it cites.`);
        }
      }
    }
  }
  for (const [id, n] of photoUse) if (n > 2) issues.push(`Photo ${id} is used ${n} times; the limit is 2.`);
  return [...new Set(issues)];
}

export const script: Stage = async (job, ctx) => {
  const chosen = job.angles.find((a) => a.id === job.chosenAngleId);
  if (!chosen) throw new Error("No angle chosen");
  // Photos with things to avoid (people, number plates) are left out unless nothing else is left.
  const clean = job.photoLabels.filter((l) => l.avoid.length === 0);
  const photos = clean.length >= 3 ? clean : job.photoLabels;
  const allowAi = job.options.allowAiVisuals && ctx.visuals.enabled;

  let result = await ctx.llm.writeScript({ facts: job.facts, angle: chosen, photos, allowAiVisuals: allowAi });
  let issues = checkScript({ script: result.script, facts: job.facts, photoIds: photos.map((p) => p.assetId), aiVisuals: result.aiVisuals });
  for (let attempt = 0; issues.length && attempt < 2; attempt++) {
    ctx.log(`Script failed ${issues.length} checks; asking for a fix`);
    result = await ctx.llm.writeScript({ facts: job.facts, angle: chosen, photos, allowAiVisuals: allowAi, issues, previous: result.script });
    issues = checkScript({ script: result.script, facts: job.facts, photoIds: photos.map((p) => p.assetId), aiVisuals: result.aiVisuals });
  }
  job.script = result.script;
  job.scriptIssues = issues;
  job.aiVisualRequests = result.aiVisuals;
  job.shots = [];
  if (issues.length) {
    job.status = "qc_failed";
    throw new Error(`Script still fails the claim gate:\n- ${issues.join("\n- ")}`);
  }
  return { providers: [ctx.llm.name] };
};
