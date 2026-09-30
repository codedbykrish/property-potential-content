import RunwayML from "@runwayml/sdk";
import type { Config } from "../core/config.js";

/**
 * Runway, used sparingly:
 *  - generic AI stills (text to image) for lines the script marks as AI visuals;
 *  - optional camera-only motion on an owned photo (image to video).
 * Neither may change what the property looks like; every output is labelled on screen.
 */
export interface VisualGenerator {
  readonly name: string;
  readonly enabled: boolean;
  generateImage(prompt: string): Promise<{ data: Buffer; ext: string; costUsd: number }>;
  animatePhoto(photo: Buffer, seconds: 5 | 10): Promise<{ data: Buffer; ext: string; costUsd: number }>;
}

const CREDIT_USD = 0.01;

/** Appended to every prompt, so generic images never pose as the listed property. */
const IMAGE_GUARD =
  "Generic illustrative image. Do not show a specific real house, people, faces, text, logos or number plates. Photographic, natural light, vertical 9:16.";

const MOTION_PROMPT =
  "Slow, smooth camera push forward. Keep the building, rooms, furniture, sky and garden exactly as they are. No new objects, no people, no changes to the property.";

export class RunwayGenerator implements VisualGenerator {
  readonly name = "runway";
  readonly enabled = true;
  private client: RunwayML;

  constructor(config: Config) {
    this.client = new RunwayML({ apiKey: config.runwayApiKey });
  }

  async generateImage(prompt: string) {
    const task = await this.client.textToImage
      .create({ model: "gen4_image", ratio: "1080:1920", promptText: `${prompt.slice(0, 700)} ${IMAGE_GUARD}` })
      .waitForTaskOutput();
    const data = await download(task.output[0]);
    return { data, ext: "png", costUsd: 8 * CREDIT_USD };
  }

  async animatePhoto(photo: Buffer, seconds: 5 | 10) {
    // Runway accepts base64 data URIs up to 5MB; the pipeline passes a resized JPEG.
    const task = await this.client.imageToVideo
      .create({
        model: "gen4_turbo",
        ratio: "720:1280",
        duration: seconds,
        promptImage: `data:image/jpeg;base64,${photo.toString("base64")}`,
        promptText: MOTION_PROMPT,
      })
      .waitForTaskOutput();
    // Output URLs expire, so download straight away.
    const data = await download(task.output[0]);
    return { data, ext: "mp4", costUsd: 5 * seconds * CREDIT_USD };
  }
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Downloading Runway output failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export class DisabledGenerator implements VisualGenerator {
  readonly name = "none";
  readonly enabled = false;
  async generateImage(): Promise<never> {
    throw new Error("Runway is not enabled");
  }
  async animatePhoto(): Promise<never> {
    throw new Error("Runway is not enabled");
  }
}

export function createVisualGenerator(config: Config): VisualGenerator {
  if (!config.mock && config.runwayEnabled && config.runwayApiKey) return new RunwayGenerator(config);
  return new DisabledGenerator();
}
