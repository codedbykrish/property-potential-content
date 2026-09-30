import { z } from "zod";

/**
 * Provenance statuses, shared with the Property Potential app's
 * `field_provenance` vocabulary so facts can move between the two later.
 */
export const FactStatus = z.enum(["VERIFIED", "ESTIMATE", "AI_SUGGESTION", "USER_SUPPLIED", "UNKNOWN"]);
export type FactStatus = z.infer<typeof FactStatus>;

/** Statuses a script may state as fact. ESTIMATE is allowed only with hedging words. */
export const SPEAKABLE_STATUSES: FactStatus[] = ["VERIFIED", "USER_SUPPLIED"];

export const FactSource = z.object({
  kind: z.enum(["user", "listing", "photo", "postcodes_io", "land_registry", "epc", "derived"]),
  ref: z.string(), // URL, dataset query, asset id, or "brief"
  quote: z.string().optional(), // the exact text the value came from
});
export type FactSource = z.infer<typeof FactSource>;

export const Fact = z.object({
  id: z.string(),
  field: z.string(), // machine name, e.g. askingPrice
  label: z.string(), // human label, e.g. "Asking price"
  value: z.union([z.string(), z.number(), z.boolean()]),
  unit: z.string().optional(), // GBP, sq ft, m2
  status: FactStatus,
  /** "as_advertised": confirmed only as what the listing says. "independent": confirmed by a separate source. */
  scope: z.enum(["as_advertised", "independent", "none"]).default("none"),
  sources: z.array(FactSource),
  conflicts: z.array(z.object({ source: FactSource, value: z.union([z.string(), z.number(), z.boolean()]), note: z.string() })).default([]),
  checkedAt: z.string(),
});
export type Fact = z.infer<typeof Fact>;

export const PhotoRights = z.enum(["owned", "permission"]);
export type PhotoRights = z.infer<typeof PhotoRights>;

export const AssetOrigin = z.enum(["original", "derived", "ai_generated", "tts", "render"]);

export const Asset = z.object({
  id: z.string(),
  kind: z.enum(["photo", "ai_image", "ai_video", "voice_line", "render", "thumbnail", "captions", "snapshot"]),
  path: z.string(), // path inside the job folder / storage prefix
  origin: AssetOrigin,
  derivedFrom: z.string().optional(),
  rights: z.enum(["owned", "permission", "generated", "n/a"]),
  width: z.number().optional(),
  height: z.number().optional(),
  durationSec: z.number().optional(),
  sha256: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type Asset = z.infer<typeof Asset>;

export const PhotoLabel = z.object({
  assetId: z.string(),
  room: z.string(), // "exterior front", "kitchen", "garden"
  quality: z.number().min(0).max(10),
  features: z.array(z.string()),
  avoid: z.array(z.string()), // people, number plates, watermarks
  heroCandidate: z.boolean(),
});
export type PhotoLabel = z.infer<typeof PhotoLabel>;

export const Angle = z.object({
  id: z.string(),
  title: z.string(),
  pitch: z.string(),
  worthiness: z.number().min(0).max(10),
  factIds: z.array(z.string()),
});
export type Angle = z.infer<typeof Angle>;

export const ScriptLine = z.object({
  id: z.string(),
  text: z.string(),
  role: z.enum(["hook", "beat", "close", "cta"]),
  visualId: z.string(), // photo or AI asset id shown during the line
  factIds: z.array(z.string()),
  onScreen: z.string().optional(), // short overlay, e.g. "£350,000 | 3 bed"
});
export type ScriptLine = z.infer<typeof ScriptLine>;

export const Script = z.object({
  lines: z.array(ScriptLine),
  caption: z.string(),
  hashtags: z.array(z.string()),
  title: z.string(),
  thumbnailText: z.string(),
});
export type Script = z.infer<typeof Script>;

export const Shot = z.object({
  lineId: z.string(),
  assetId: z.string(),
  motion: z.enum(["push_in", "pull_out", "pan_left", "pan_right", "ai_clip"]),
  aiLabel: z.boolean(),
});
export type Shot = z.infer<typeof Shot>;

export const WordTiming = z.object({ word: z.string(), start: z.number(), end: z.number() });
export type WordTiming = z.infer<typeof WordTiming>;

export const VoiceLine = z.object({
  lineId: z.string(),
  assetId: z.string(),
  startSec: z.number(), // position in the Reel
  durationSec: z.number(),
  words: z.array(WordTiming), // relative to the line start
});
export type VoiceLine = z.infer<typeof VoiceLine>;

export const QcCheck = z.object({
  name: z.string(),
  ok: z.boolean(),
  /** A failed "error" check stops the Reel reaching review; a failed "warning" is shown to the reviewer. */
  severity: z.enum(["error", "warning"]),
  detail: z.string(),
});
export type QcCheck = z.infer<typeof QcCheck>;

export const Render = z.object({
  id: z.string(),
  version: z.number(),
  videoAssetId: z.string(),
  thumbnailAssetId: z.string(),
  captionsAssetId: z.string(),
  durationSec: z.number(),
  createdAt: z.string(),
  mockProviders: z.array(z.string()), // providers that were mocked; a mocked render cannot be approved
  qc: z.array(QcCheck).default([]),
});
export type Render = z.infer<typeof Render>;

export const ContentStatus = z.enum([
  "draft", // pipeline running
  "qc_failed",
  "not_worth_it",
  "in_review",
  "changes_requested",
  "approved",
  "rejected",
  "scheduled", // later: publishing
  "published", // later: publishing
]);
export type ContentStatus = z.infer<typeof ContentStatus>;

export const Review = z.object({
  id: z.string(),
  renderId: z.string(),
  decision: z.enum(["approved", "changes_requested", "rejected"]),
  note: z.string().default(""),
  reviewer: z.string(),
  at: z.string(),
});
export type Review = z.infer<typeof Review>;

export const StageName = z.enum(["intake", "photos", "facts", "verify", "angle", "script", "visuals", "voice", "render", "qc"]);
export type StageName = z.infer<typeof StageName>;

export const StageRun = z.object({
  stage: StageName,
  status: z.enum(["ok", "failed", "skipped"]),
  startedAt: z.string(),
  finishedAt: z.string(),
  error: z.string().optional(),
  costUsd: z.number().default(0),
  providers: z.array(z.string()).default([]),
});
export type StageRun = z.infer<typeof StageRun>;

export const SourceBundle = z.object({
  sourceKind: z.enum(["manual", "listing_url", "pp_app", "discovery"]),
  sourceRef: z.string(),
  listingUrl: z.string().optional(),
  listingText: z.string().optional(), // readable text from the listing page, never its photos
  snapshotAssetId: z.string().optional(),
  userFacts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  notes: z.string().default(""),
  photoRights: PhotoRights,
  permissionNote: z.string().default(""),
  capturedAt: z.string(),
});
export type SourceBundle = z.infer<typeof SourceBundle>;

/** One content item: a property turned into one Reel, with everything that made it. */
export const Job = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: ContentStatus,
  briefPath: z.string().optional(),
  options: z.object({ allowAiVisuals: z.boolean().default(true), force: z.boolean().default(false) }).default({ allowAiVisuals: true, force: false }),
  source: SourceBundle.optional(),
  assets: z.array(Asset).default([]),
  photoLabels: z.array(PhotoLabel).default([]),
  facts: z.array(Fact).default([]),
  angles: z.array(Angle).default([]),
  chosenAngleId: z.string().optional(),
  script: Script.optional(),
  aiVisualRequests: z.array(z.object({ lineId: z.string(), prompt: z.string(), reason: z.string() })).default([]),
  scriptIssues: z.array(z.string()).default([]),
  shots: z.array(Shot).default([]),
  voice: z.array(VoiceLine).default([]),
  renders: z.array(Render).default([]),
  reviews: z.array(Review).default([]),
  stages: z.array(StageRun).default([]),
  notes: z.array(z.string()).default([]),
});
export type Job = z.infer<typeof Job>;
