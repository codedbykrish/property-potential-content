import type { Config } from "../core/config.js";
import type { LocalStore } from "../core/store.js";
import type { Job } from "../core/types.js";
import type { Llm } from "../providers/llm.js";
import type { PublicData } from "../providers/public-data.js";
import type { VisualGenerator } from "../providers/runway.js";
import type { Tts } from "../providers/tts.js";

export interface Ctx {
  config: Config;
  store: LocalStore;
  llm: Llm;
  tts: Tts;
  visuals: VisualGenerator;
  publicData: PublicData;
  log: (msg: string) => void;
  fetchImpl?: typeof fetch;
}

/** What a stage reports back to the runner, for the cost ledger and the mock check. */
export interface StageResult {
  costUsd?: number;
  providers?: string[];
  /** Stop the pipeline after this stage without it being an error (e.g. "not worth a Reel"). */
  halt?: boolean;
}

export type Stage = (job: Job, ctx: Ctx) => Promise<StageResult | void>;
