import fs from "node:fs/promises";
import path from "node:path";
import { Job } from "./types.js";

/**
 * Local working store. Each job lives in `<dataDir>/jobs/<jobId>/` with a
 * `job.json` record and its asset files. Rendering needs files on disk, so
 * this is always the working copy; Supabase (see supabase-sync.ts) mirrors it.
 */
export class LocalStore {
  constructor(readonly dataDir: string) {}

  jobDir(jobId: string): string {
    return path.join(this.dataDir, "jobs", jobId);
  }

  abs(jobId: string, rel: string): string {
    return path.join(this.jobDir(jobId), rel);
  }

  async saveJob(job: Job): Promise<void> {
    const dir = this.jobDir(job.id);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, "job.json.tmp");
    await fs.writeFile(tmp, JSON.stringify(job, null, 2));
    await fs.rename(tmp, path.join(dir, "job.json"));
  }

  async loadJob(jobId: string): Promise<Job> {
    const raw = await fs.readFile(path.join(this.jobDir(jobId), "job.json"), "utf8");
    return Job.parse(JSON.parse(raw));
  }

  async listJobs(): Promise<Job[]> {
    const root = path.join(this.dataDir, "jobs");
    let ids: string[] = [];
    try {
      ids = await fs.readdir(root);
    } catch {
      return [];
    }
    const jobs: Job[] = [];
    for (const id of ids) {
      try {
        jobs.push(await this.loadJob(id));
      } catch {
        // ignore folders without a readable job.json
      }
    }
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async writeFile(jobId: string, rel: string, data: Buffer | string): Promise<string> {
    const abs = this.abs(jobId, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, data);
    return rel;
  }
}
