import fs from "node:fs/promises";
import sharp from "sharp";
import { newId, now, sha256 } from "../core/util.js";
import { readBrief } from "../sources/brief.js";
import { fetchListing } from "../sources/listing-url.js";
import type { Stage } from "./context.js";

/** Reads the brief and, if given, the listing page's text (never its photos). */
export const intake: Stage = async (job, ctx) => {
  if (!job.briefPath) throw new Error("Job has no brief");
  const { brief } = await readBrief(job.briefPath);

  let listingText: string | undefined;
  let snapshotAssetId: string | undefined;
  if (brief.listingUrl) {
    ctx.log(`Reading listing text from ${brief.listingUrl}`);
    const { html, text } = await fetchListing(brief.listingUrl, ctx.fetchImpl);
    listingText = text;
    snapshotAssetId = newId("ast");
    // Kept as evidence of what the listing said when we looked.
    await ctx.store.writeFile(job.id, "source/listing.html", html);
    await ctx.store.writeFile(job.id, "source/listing.txt", text);
    job.assets.push({ id: snapshotAssetId, kind: "snapshot", path: "source/listing.txt", origin: "original", rights: "n/a", meta: { url: brief.listingUrl, html: "source/listing.html" } });
  }

  job.source = {
    sourceKind: brief.listingUrl ? "listing_url" : "manual",
    sourceRef: brief.listingUrl ?? job.briefPath,
    listingUrl: brief.listingUrl,
    listingText,
    snapshotAssetId,
    userFacts: brief.facts,
    notes: brief.notes,
    photoRights: brief.photos.rights,
    permissionNote: brief.photos.permissionNote,
    capturedAt: now(),
  };
};

/**
 * Copies in your photos: drops duplicates, fixes orientation, strips EXIF
 * (including GPS), caps the size, then labels each one.
 */
export const photos: Stage = async (job, ctx) => {
  const { brief, photoPaths } = await readBrief(job.briefPath!);
  job.assets = job.assets.filter((a) => a.kind !== "photo");
  const seen = new Set<string>();
  const added: { assetId: string; path: string }[] = [];
  for (const p of photoPaths) {
    const raw = await fs.readFile(p);
    const hash = sha256(raw);
    if (seen.has(hash)) {
      ctx.log(`Skipping duplicate photo ${p}`);
      continue;
    }
    seen.add(hash);
    const id = newId("ast");
    // sharp drops metadata unless asked to keep it, so this also removes GPS data.
    const img = sharp(raw).rotate().resize(2400, 2400, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 });
    const { data, info } = await img.toBuffer({ resolveWithObject: true });
    const rel = await ctx.store.writeFile(job.id, `photos/${id}.jpg`, data);
    job.assets.push({
      id,
      kind: "photo",
      path: rel,
      origin: "original",
      rights: brief.photos.rights,
      width: info.width,
      height: info.height,
      sha256: hash,
      meta: { sourceFile: p, exifStripped: true },
    });
    added.push({ assetId: id, path: ctx.store.abs(job.id, rel) });
  }
  ctx.log(`Labelling ${added.length} photos`);
  const labels = await ctx.llm.labelPhotos(added);
  const known = new Set(added.map((a) => a.assetId));
  job.photoLabels = labels.filter((l) => known.has(l.assetId));
  for (const a of added) {
    if (!job.photoLabels.some((l) => l.assetId === a.assetId)) {
      job.photoLabels.push({ assetId: a.assetId, room: "unlabelled", quality: 5, features: [], avoid: [], heroCandidate: false });
    }
  }
  return { providers: [ctx.llm.name] };
};
