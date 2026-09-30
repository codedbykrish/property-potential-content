import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decide } from "../src/core/review.js";
import { normalisePostcode } from "../src/core/util.js";
import { newJob } from "../src/pipeline/run.js";
import { captionChunks, toSrt } from "../src/render/props.js";
import { readBrief } from "../src/sources/brief.js";
import { checkListingUrl, htmlToText } from "../src/sources/listing-url.js";
import { forSpeech, timeWords } from "../src/providers/tts.js";

describe("listing URLs", () => {
  it("refuses portals and accepts agent sites", () => {
    expect(() => checkListingUrl("https://www.rightmove.co.uk/properties/123")).toThrow(/rightmove/);
    expect(() => checkListingUrl("https://zoopla.co.uk/for-sale/details/1")).toThrow(/zoopla/);
    expect(() => checkListingUrl("https://www.example-agent.co.uk/property/1")).not.toThrow();
  });

  it("keeps text and structured data, drops images and scripts", () => {
    const text = htmlToText(
      `<html><head><script>track()</script><script type="application/ld+json">{"price":"250000"}</script></head><body><nav>Menu</nav><h1>12 Sample Road</h1><img src="a.jpg"><p>Offers over &pound;250,000</p></body></html>`,
    );
    expect(text).toContain("12 Sample Road");
    expect(text).toContain("Offers over £250,000");
    expect(text).toContain('{"price":"250000"}');
    expect(text).not.toContain("track()");
    expect(text).not.toContain("a.jpg");
    expect(text).not.toContain("Menu");
  });
});

describe("briefs", () => {
  async function write(yaml: string) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brief-"));
    await fs.mkdir(path.join(dir, "photos"));
    await fs.writeFile(path.join(dir, "photos", "a.jpg"), "x");
    await fs.writeFile(path.join(dir, "brief.yaml"), yaml);
    return path.join(dir, "brief.yaml");
  }

  it("reads photos from a folder", async () => {
    const { photoPaths } = await readBrief(await write("photos:\n  dir: ./photos\n  rights: owned\n"));
    expect(photoPaths).toHaveLength(1);
  });

  it("requires a permission note for permission photos", async () => {
    await expect(readBrief(await write("photos:\n  dir: ./photos\n  rights: permission\n"))).rejects.toThrow(/permissionNote/);
  });

  it("rejects unknown rights", async () => {
    await expect(readBrief(await write("photos:\n  dir: ./photos\n  rights: scraped\n"))).rejects.toThrow(/rights/);
  });

  it("rejects photo URLs", async () => {
    await expect(readBrief(await write("photos:\n  files: [https://agent.example/photo.jpg]\n  rights: owned\n"))).rejects.toThrow(/local files/);
  });
});

describe("voice timing and captions", () => {
  it("applies pronunciation to the audio only", () => {
    expect(forSpeech("1,100 sq ft in Leominster")).toBe("1,100 square feet in Lemster");
  });

  it("times written words across the spoken span", () => {
    const chars = [..."Hi there"];
    const starts = chars.map((_, i) => i * 0.1);
    const ends = chars.map((_, i) => (i + 1) * 0.1);
    const words = timeWords("Hi there", chars, starts, ends);
    expect(words.map((w) => w.word)).toEqual(["Hi", "there"]);
    expect(words[0].start).toBeCloseTo(0);
    expect(words[1].end).toBeCloseTo(0.8);
  });

  it("chunks captions and writes SRT", () => {
    const words = ["It", "has", "three", "bedrooms.", "Take", "a", "look."].map((w, i) => ({ word: w, start: i * 0.4, end: i * 0.4 + 0.35 }));
    const chunks = captionChunks(words);
    expect(chunks[0].words.map((w) => w.word)).toEqual(["It", "has", "three"]);
    expect(toSrt(words)).toContain("00:00:00,000 --> 00:00:01,550\nIt has three bedrooms.");
  });
});

describe("review decisions", () => {
  const render = (mock: string[], ok = true) => ({
    id: "r1",
    version: 1,
    videoAssetId: "v",
    thumbnailAssetId: "t",
    captionsAssetId: "c",
    durationSec: 30,
    createdAt: "",
    mockProviders: mock,
    qc: [{ name: "Format", ok, severity: "error" as const, detail: "" }],
  });

  it("refuses to approve mock renders or failed QC", () => {
    const j = newJob("brief.yaml");
    j.status = "in_review";
    j.renders = [render(["mock-llm"])];
    expect(() => decide(j, "approved", "", "krish")).toThrow(/stand-ins/);
    j.renders = [render([], false)];
    expect(() => decide(j, "approved", "", "krish")).toThrow(/Quality/);
  });

  it("approves a clean render and needs a note to reject", () => {
    const j = newJob("brief.yaml");
    j.status = "in_review";
    j.renders = [render([])];
    expect(() => decide(j, "rejected", "", "krish")).toThrow(/note/);
    decide(j, "approved", "", "krish");
    expect(j.status).toBe("approved");
    expect(j.reviews[0].renderId).toBe("r1");
  });
});

it("normalises postcodes", () => {
  expect(normalisePostcode("hr68aa")).toBe("HR6 8AA");
  expect(normalisePostcode("not a postcode")).toBeUndefined();
});
