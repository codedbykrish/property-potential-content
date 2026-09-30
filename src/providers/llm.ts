import fs from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import sharp from "sharp";
import { z } from "zod";
import type { Config } from "../core/config.js";
import type { Angle, Fact, PhotoLabel, Script } from "../core/types.js";
import { formatGbp } from "../core/util.js";

// ---------------------------------------------------------------------------
// Shapes the model returns. Kept flat and bound-free for structured outputs;
// ranges are checked by the pipeline afterwards.
// ---------------------------------------------------------------------------

const PhotoLabelsOut = z.object({
  photos: z.array(
    z.object({
      assetId: z.string(),
      room: z.string(),
      quality: z.number(),
      features: z.array(z.string()),
      avoid: z.array(z.string()),
      heroCandidate: z.boolean(),
    }),
  ),
});

export const CandidateFact = z.object({
  field: z.string(),
  label: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
  unit: z.string().nullable(),
  sourceKind: z.enum(["listing", "user", "photo"]),
  quote: z.string().nullable(), // exact supporting text from the listing or notes, or the photo asset id
});
export type CandidateFact = z.infer<typeof CandidateFact>;
const FactsOut = z.object({ facts: z.array(CandidateFact) });

const AnglesOut = z.object({
  angles: z.array(z.object({ title: z.string(), pitch: z.string(), worthiness: z.number(), factIds: z.array(z.string()) })),
});

export const AiVisualRequest = z.object({ lineId: z.string(), prompt: z.string(), reason: z.string() });
export type AiVisualRequest = z.infer<typeof AiVisualRequest>;

const ScriptOut = z.object({
  lines: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      role: z.enum(["hook", "beat", "close", "cta"]),
      visualId: z.string(),
      factIds: z.array(z.string()),
      onScreen: z.string().nullable(),
    }),
  ),
  caption: z.string(),
  hashtags: z.array(z.string()),
  title: z.string(),
  thumbnailText: z.string(),
  aiVisuals: z.array(AiVisualRequest),
});

export interface ScriptResult {
  script: Script;
  aiVisuals: AiVisualRequest[];
}

export interface ScriptInput {
  facts: Fact[];
  angle: Angle;
  photos: PhotoLabel[];
  allowAiVisuals: boolean;
  issues?: string[]; // problems with a previous draft to fix
  previous?: Script;
}

export interface LlmUsage {
  costUsd: number;
}

export interface Llm {
  readonly name: string;
  readonly mock: boolean;
  usage: LlmUsage;
  labelPhotos(photos: { assetId: string; path: string }[]): Promise<PhotoLabel[]>;
  extractFacts(input: { listingText?: string; userFacts: Record<string, unknown>; notes: string; photos: PhotoLabel[] }): Promise<CandidateFact[]>;
  proposeAngles(input: { facts: Fact[]; photos: PhotoLabel[] }): Promise<Omit<Angle, "id">[]>;
  writeScript(input: ScriptInput): Promise<ScriptResult>;
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

// USD per million tokens for the default model; used only for the cost ledger.
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
};

const SYSTEM = `You work for Property Potential, a UK property analysis brand, making short vertical videos about real UK properties.
Accuracy matters more than hype. Never invent facts. Use British English and UK property terms (freehold, leasehold, semi-detached, sq ft, EPC).
Prices are in GBP. Do not make claims about investment returns, future value or mortgage affordability.`;

const FACT_FIELDS = `Use these field names where they fit: address, postcode, town, propertyType, bedrooms, bathrooms, receptions, askingPrice, priceQualifier (e.g. "Offers over", "Guide price"), tenure, floorAreaSqFt, plotSizeAcres, epcRating, councilTaxBand, yearBuilt, parking, garden, condition, keyFeature (one fact per notable feature). Use camelCase for any other field.`;

export class ClaudeLlm implements Llm {
  readonly name = "claude";
  readonly mock = false;
  usage: LlmUsage = { costUsd: 0 };
  private client: Anthropic;

  constructor(private config: Config) {
    this.client = new Anthropic({ apiKey: config.anthropicApiKey });
  }

  private async call<T extends z.ZodType>(
    schema: T,
    content: Anthropic.Beta.BetaContentBlockParam[],
    effort: "low" | "medium" | "high",
  ): Promise<z.infer<T>> {
    const res = await this.client.beta.messages.parse({
      model: this.config.claudeModel,
      max_tokens: 16000,
      system: SYSTEM,
      // Server-side fallback: if a request is declined, the API reroutes it by category.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort, format: betaZodOutputFormat(schema) },
      messages: [{ role: "user", content }],
    });
    const price = PRICE_PER_MTOK[this.config.claudeModel] ?? PRICE_PER_MTOK["claude-opus-5-5"];
    this.usage.costUsd += (res.usage.input_tokens * price.input + res.usage.output_tokens * price.output) / 1e6;
    if (res.stop_reason === "refusal") throw new Error(`Claude declined the request (${res.stop_details?.category ?? "no category"})`);
    if (res.stop_reason === "max_tokens") throw new Error("Claude ran out of output tokens");
    if (!res.parsed_output) throw new Error("Claude returned output that did not match the schema");
    return res.parsed_output as z.infer<T>;
  }

  async labelPhotos(photos: { assetId: string; path: string }[]): Promise<PhotoLabel[]> {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const p of photos) {
      const small = await sharp(await fs.readFile(p.path)).resize(1024, 1024, { fit: "inside" }).jpeg({ quality: 80 }).toBuffer();
      content.push({ type: "text", text: `Photo ${p.assetId}:` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: small.toString("base64") } });
    }
    content.push({
      type: "text",
      text: `Label each photo above. room: what it shows ("exterior front", "kitchen", "rear garden", "street"). quality: 0-10 for use in a social video (sharpness, light, composition). features: notable, visible selling points, stated plainly ("original fireplace", "south-facing garden" only if the sun direction is obvious). avoid: anything that must not be shown (people, faces, number plates, agent watermarks, personal documents). heroCandidate: true if it would make a strong opening shot. Return one entry per photo using its asset id.`,
    });
    const out = await this.call(PhotoLabelsOut, content, "low");
    return out.photos.map((p) => ({ ...p, quality: Math.max(0, Math.min(10, p.quality)) }));
  }

  async extractFacts(input: { listingText?: string; userFacts: Record<string, unknown>; notes: string; photos: PhotoLabel[] }): Promise<CandidateFact[]> {
    const text = [
      `Extract property facts. ${FACT_FIELDS}`,
      `Rules: every fact needs a source. sourceKind "user" for the owner's facts and notes, "listing" for the listing text, "photo" for something visible in a photo label. quote must be the exact words from the listing or notes that state the value (copy them character for character), or the photo asset id. Numbers go in as numbers without symbols or commas (askingPrice 350000). If the listing and the user disagree, return both facts. Leave out anything you would have to guess.`,
      `User-supplied facts (JSON):\n${JSON.stringify(input.userFacts, null, 2)}`,
      `User notes:\n${input.notes || "(none)"}`,
      `Photo labels (JSON):\n${JSON.stringify(input.photos)}`,
      `Listing text:\n${input.listingText ?? "(no listing URL given)"}`,
    ].join("\n\n");
    const out = await this.call(FactsOut, [{ type: "text", text }], "medium");
    return out.facts;
  }

  async proposeAngles(input: { facts: Fact[]; photos: PhotoLabel[] }): Promise<Omit<Angle, "id">[]> {
    const text = [
      `Propose exactly 3 distinct content angles for a 30-45 second Reel about this property, each built only on the facts listed. Good angles: value (price per sq ft vs local sales), renovation upside, a standout feature, location, an unusual property. worthiness: 0-10, how likely this angle is to hold a UK property audience's attention; be honest and give low scores to bland properties. factIds: the ids of the facts the angle depends on (prefer VERIFIED and USER_SUPPLIED facts).`,
      `Facts (JSON):\n${JSON.stringify(input.facts.map((f) => ({ id: f.id, label: f.label, value: f.value, unit: f.unit, status: f.status, scope: f.scope })), null, 2)}`,
      `Photo labels (JSON):\n${JSON.stringify(input.photos)}`,
    ].join("\n\n");
    const out = await this.call(AnglesOut, [{ type: "text", text }], "high");
    return out.angles.map((a) => ({ ...a, worthiness: Math.max(0, Math.min(10, a.worthiness)) }));
  }

  async writeScript(input: ScriptInput): Promise<ScriptResult> {
    const facts = input.facts.map((f) => ({ id: f.id, label: f.label, value: f.value, unit: f.unit, status: f.status, scope: f.scope }));
    const text = [
      `Write a voiceover script for a 30-45 second vertical Reel (about 85-110 spoken words) using this angle: "${input.angle.title}": ${input.angle.pitch}`,
      `Structure: one hook line (under 12 words, lands in the first 2 seconds), 4-6 beat lines, one close line, one CTA line inviting viewers to analyse properties like this with Property Potential. Give lines ids L1, L2, ... in order.`,
      `Fact rules, which are checked by code:
- Every number, price, size, rating or factual claim in a line must come from a fact listed in that line's factIds, and match its value.
- Only facts with status VERIFIED or USER_SUPPLIED may be stated as fact. ESTIMATE facts need "around", "about" or "roughly". Never use AI_SUGGESTION or UNKNOWN facts.
- A fact with scope "as_advertised" must be attributed ("listed at", "on the market for", "the listing says").
- No "bargain", "guaranteed", "investment opportunity", "won't last", "must see", returns, yields or predictions.`,
      `Visuals: visualId is the asset id of the photo shown while the line plays. Use each photo at most twice, open on a hero candidate, and never pick photos whose labels list something to avoid unless nothing else fits.`,
      input.allowAiVisuals
        ? `AI visuals: you may request up to 2 generic AI images in aiVisuals (for example a map-style establishing shot of the town, or a clearly conceptual "what a renovated kitchen could look like"). They must never depict this property as it is, and they will be labelled "AI-generated" on screen. For those lines set visualId to "ai:<lineId>". Leave aiVisuals empty if the photos are enough.`
        : `AI visuals are off: leave aiVisuals empty and use only the photos.`,
      `onScreen: optional short overlay text (under 28 characters) for key facts, e.g. "£350,000 · 3 bed". Also write caption (Instagram/TikTok caption, 1-3 short sentences, no hashtags inside), hashtags (5-8, without #), title (under 60 characters), thumbnailText (3-5 punchy words, no claims not in the facts).`,
      `Facts (JSON):\n${JSON.stringify(facts, null, 2)}`,
      `Photos (JSON):\n${JSON.stringify(input.photos)}`,
      input.issues?.length
        ? `A previous draft failed these checks. Fix every one:\n- ${input.issues.join("\n- ")}\n\nPrevious draft (JSON):\n${JSON.stringify(input.previous)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const out = await this.call(ScriptOut, [{ type: "text", text }], "high");
    return {
      script: {
        lines: out.lines.map((l) => ({ ...l, onScreen: l.onScreen ?? undefined })),
        caption: out.caption,
        hashtags: out.hashtags.map((h) => h.replace(/^#/, "")),
        title: out.title,
        thumbnailText: out.thumbnailText,
      },
      aiVisuals: input.allowAiVisuals ? out.aiVisuals : [],
    };
  }
}

// ---------------------------------------------------------------------------
// Mock: deterministic, offline. Lets the whole pipeline run without API keys.
// Renders made with it are marked and cannot be approved.
// ---------------------------------------------------------------------------

export class MockLlm implements Llm {
  readonly name = "mock-llm";
  readonly mock = true;
  usage: LlmUsage = { costUsd: 0 };

  async labelPhotos(photos: { assetId: string; path: string }[]): Promise<PhotoLabel[]> {
    return photos.map((p, i) => ({
      assetId: p.assetId,
      room: i === 0 ? "exterior front" : `room ${i + 1}`,
      quality: i === 0 ? 8 : 6,
      features: [],
      avoid: [],
      heroCandidate: i === 0,
    }));
  }

  async extractFacts(input: { listingText?: string; userFacts: Record<string, unknown>; notes: string }): Promise<CandidateFact[]> {
    const facts: CandidateFact[] = [];
    for (const [field, value] of Object.entries(input.userFacts)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        facts.push({ field, label: labelFor(field), value, unit: unitFor(field), sourceKind: "user", quote: String(value) });
      }
    }
    const text = input.listingText ?? "";
    const price = text.match(/£\s?([\d,]{5,})/);
    if (price && !("askingPrice" in input.userFacts)) {
      facts.push({ field: "askingPrice", label: "Asking price", value: Number(price[1].replace(/,/g, "")), unit: "GBP", sourceKind: "listing", quote: price[0] });
    }
    const beds = text.match(/(\d+)\s*bed(room)?s?/i);
    if (beds && !("bedrooms" in input.userFacts)) {
      facts.push({ field: "bedrooms", label: "Bedrooms", value: Number(beds[1]), unit: null, sourceKind: "listing", quote: beds[0] });
    }
    return facts;
  }

  async proposeAngles(input: { facts: Fact[] }): Promise<Omit<Angle, "id">[]> {
    const ids = input.facts.filter((f) => f.status === "VERIFIED" || f.status === "USER_SUPPLIED").map((f) => f.id);
    return [
      { title: "What this home offers", pitch: "A straight walk-through of the key facts.", worthiness: 6, factIds: ids },
      { title: "Renovation potential", pitch: "Where the upside could be.", worthiness: 5, factIds: ids },
      { title: "The location", pitch: "Why the area matters.", worthiness: 4, factIds: ids },
    ];
  }

  async writeScript(input: ScriptInput): Promise<ScriptResult> {
    const speakable = input.facts.filter((f) => f.status === "VERIFIED" || f.status === "USER_SUPPLIED");
    const get = (field: string) => speakable.find((f) => f.field === field);
    const photos = input.photos.map((p) => p.assetId);
    const pick = (i: number) => photos[i % photos.length];
    const lines: Script["lines"] = [];
    const town = get("town");
    const type = get("propertyType");
    const beds = get("bedrooms");
    const price = get("askingPrice");
    lines.push({ id: "L1", role: "hook", text: `Let's look at this ${type ? String(type.value).toLowerCase() : "home"}${town ? ` in ${town.value}` : ""}.`, visualId: pick(0), factIds: [type, town].filter(Boolean).map((f) => f!.id) });
    if (beds) lines.push({ id: "L2", role: "beat", text: `It has ${beds.value} bedrooms.`, visualId: pick(1), factIds: [beds.id], onScreen: `${beds.value} bed` });
    if (price) {
      const attributed = price.scope === "as_advertised" ? "It's listed at" : "The asking price is";
      lines.push({ id: "L3", role: "beat", text: `${attributed} ${formatGbp(Number(price.value))}.`, visualId: pick(2), factIds: [price.id], onScreen: formatGbp(Number(price.value)) });
    }
    const tenure = get("tenure");
    if (tenure) lines.push({ id: "L4", role: "beat", text: `It's ${String(tenure.value).toLowerCase()}, which is often the first thing buyers ask about.`, visualId: pick(3), factIds: [tenure.id] });
    lines.push({ id: "L5", role: "beat", text: "Walk through the rooms and picture how the space could work for you, from the kitchen to the garden.", visualId: pick(4), factIds: [] });
    lines.push({ id: "L6", role: "close", text: "So, is this one worth a closer look, or would you keep searching?", visualId: pick(5), factIds: [] });
    lines.push({ id: "L7", role: "cta", text: "Analyse homes like this in minutes with Property Potential.", visualId: pick(0), factIds: [] });
    return {
      script: {
        lines,
        caption: "A quick look at this property. What would you do with it?",
        hashtags: ["ukproperty", "propertypotential", "househunting", "renovation", "propertytour"],
        title: input.angle.title,
        thumbnailText: "Worth a look?",
      },
      aiVisuals: [],
    };
  }
}

function labelFor(field: string): string {
  const known: Record<string, string> = {
    address: "Address",
    postcode: "Postcode",
    town: "Town",
    propertyType: "Property type",
    bedrooms: "Bedrooms",
    bathrooms: "Bathrooms",
    askingPrice: "Asking price",
    tenure: "Tenure",
    floorAreaSqFt: "Floor area",
    epcRating: "EPC rating",
  };
  return known[field] ?? field.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

function unitFor(field: string): string | null {
  if (field === "askingPrice") return "GBP";
  if (field === "floorAreaSqFt") return "sq ft";
  return null;
}

export function createLlm(config: Config): Llm {
  if (!config.mock && config.anthropicApiKey) return new ClaudeLlm(config);
  return new MockLlm();
}
