import fs from "node:fs/promises";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "./config.js";
import type { LocalStore } from "./store.js";
import type { Job } from "./types.js";

const BUCKET_FOR_KIND: Record<string, string> = {
  photo: "photos",
  snapshot: "source-snapshots",
  ai_image: "generated",
  ai_video: "generated",
  voice_line: "generated",
  captions: "renders",
  render: "renders",
  thumbnail: "renders",
};

/**
 * Mirrors a local job into the content agent's own Supabase project
 * (schema in supabase/migrations). Does nothing when Supabase isn't configured.
 * Uses the service role key, so it must only ever run on your machine or the worker.
 */
export class SupabaseSync {
  private client?: SupabaseClient;
  private uploaded = new Set<string>();

  constructor(config: Config, private store: LocalStore) {
    if (config.supabaseUrl && config.supabaseServiceKey) {
      this.client = createClient(config.supabaseUrl, config.supabaseServiceKey, { auth: { persistSession: false } });
    }
  }

  get enabled(): boolean {
    return Boolean(this.client);
  }

  async sync(job: Job): Promise<void> {
    const db = this.client;
    if (!db) return;

    const must = <T extends { error: { message: string } | null }>(res: T, what: string) => {
      if (res.error) throw new Error(`Supabase ${what}: ${res.error.message}`);
      return res;
    };

    // Parent row first (so child rows can reference it); the full row goes last, after
    // reviews, because the database only accepts "approved" once an approving review exists.
    must(
      await db
        .from("content_items")
        .upsert({ id: job.id, status: "draft", created_at: job.createdAt, updated_at: job.updatedAt }, { ignoreDuplicates: true }),
      "content_items (create)",
    );

    if (job.facts.length) {
      must(
        await db.from("facts").upsert(
          job.facts.map((f) => ({
            id: f.id,
            content_item_id: job.id,
            field: f.field,
            label: f.label,
            value: f.value,
            unit: f.unit ?? null,
            status: f.status,
            scope: f.scope,
            sources: f.sources,
            conflicts: f.conflicts,
            checked_at: f.checkedAt,
          })),
        ),
        "facts",
      );
    }

    for (const a of job.assets) {
      const bucket = BUCKET_FOR_KIND[a.kind];
      const key = `${job.id}/${a.path}`;
      if (bucket && !this.uploaded.has(`${bucket}:${key}`)) {
        const body = await fs.readFile(this.store.abs(job.id, a.path));
        must(await db.storage.from(bucket).upload(key, body, { upsert: true }), `upload ${key}`);
        this.uploaded.add(`${bucket}:${key}`);
      }
    }
    if (job.assets.length) {
      must(
        await db.from("assets").upsert(
          job.assets.map((a) => ({
            id: a.id,
            content_item_id: job.id,
            kind: a.kind,
            bucket: BUCKET_FOR_KIND[a.kind] ?? null,
            path: `${job.id}/${a.path}`,
            origin: a.origin,
            derived_from: a.derivedFrom ?? null,
            rights: a.rights,
            width: a.width ?? null,
            height: a.height ?? null,
            duration_sec: a.durationSec ?? null,
            sha256: a.sha256 ?? null,
            meta: a.meta,
          })),
        ),
        "assets",
      );
    }

    if (job.renders.length) {
      must(
        await db.from("renders").upsert(
          job.renders.map((r) => ({
            id: r.id,
            content_item_id: job.id,
            version: r.version,
            video_asset_id: r.videoAssetId,
            thumbnail_asset_id: r.thumbnailAssetId,
            captions_asset_id: r.captionsAssetId,
            duration_sec: r.durationSec,
            mock_providers: r.mockProviders,
            qc: r.qc,
            created_at: r.createdAt,
          })),
        ),
        "renders",
      );
    }

    if (job.reviews.length) {
      must(
        await db.from("reviews").upsert(
          job.reviews.map((r) => ({
            id: r.id,
            content_item_id: job.id,
            render_id: r.renderId,
            decision: r.decision,
            note: r.note,
            reviewer: r.reviewer,
            created_at: r.at,
          })),
        ),
        "reviews",
      );
    }

    if (job.stages.length) {
      must(
        await db.from("jobs").upsert(
          job.stages.map((s) => ({
            content_item_id: job.id,
            stage: s.stage,
            started_at: s.startedAt,
            status: s.status,
            finished_at: s.finishedAt,
            error: s.error ?? null,
            cost_usd: s.costUsd,
            providers: s.providers,
          })),
          { onConflict: "content_item_id,stage,started_at" },
        ),
        "jobs",
      );
    }

    must(
      await db.from("content_items").upsert({
        id: job.id,
        status: job.status,
        source: job.source ?? null,
        angles: job.angles,
        chosen_angle_id: job.chosenAngleId ?? null,
        script: job.script ?? null,
        script_issues: job.scriptIssues,
        shots: job.shots,
        voice: job.voice,
        photo_labels: job.photoLabels,
        notes: job.notes,
        created_at: job.createdAt,
        updated_at: job.updatedAt,
      }),
      "content_items",
    );
  }
}
