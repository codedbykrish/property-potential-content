import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { PhotoRights } from "../core/types.js";

/**
 * The manual input: a YAML file you write per property. See examples/brief.example.yaml.
 * Photos must be ones you own or have explicit permission to use.
 */
export const Brief = z.object({
  listingUrl: z.string().url().optional(),
  photos: z.object({
    dir: z.string().optional(),
    files: z.array(z.string()).default([]),
    rights: PhotoRights,
    permissionNote: z.string().default(""),
  }),
  facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  notes: z.string().default(""),
});
export type Brief = z.infer<typeof Brief>;

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".tif", ".tiff"]);

export async function readBrief(briefPath: string): Promise<{ brief: Brief; photoPaths: string[] }> {
  const raw = YAML.parse(await fs.readFile(briefPath, "utf8"));
  const parsed = Brief.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Brief ${briefPath} is invalid:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  const brief = parsed.data;
  if (brief.photos.rights === "permission" && !brief.photos.permissionNote.trim()) {
    throw new Error("photos.rights is 'permission' but photos.permissionNote is empty: say who gave permission and when.");
  }

  for (const f of brief.photos.files) {
    if (/^[a-z]+:\/\//i.test(f)) throw new Error(`Photos must be local files you own or have permission for, not URLs: ${f}`);
  }
  const base = path.dirname(path.resolve(briefPath));
  const photoPaths = brief.photos.files.map((f) => path.resolve(base, f));
  if (brief.photos.dir) {
    const dir = path.resolve(base, brief.photos.dir);
    const entries = (await fs.readdir(dir)).filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase())).sort();
    photoPaths.push(...entries.map((f) => path.join(dir, f)));
  }
  if (photoPaths.length === 0) throw new Error("The brief lists no photos. Add photos.dir or photos.files.");
  return { brief, photoPaths };
}
