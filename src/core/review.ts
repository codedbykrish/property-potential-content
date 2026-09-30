import type { Job, Review } from "./types.js";
import { newId, now } from "./util.js";

/**
 * Records your decision on the latest render. Approval is refused when the
 * render isn't the latest, failed QC, or was made with offline stand-ins.
 */
export function decide(job: Job, decision: Review["decision"], note: string, reviewer: string): Review {
  const latest = job.renders[job.renders.length - 1];
  if (!latest) throw new Error("There is no render to review.");
  if (!["in_review", "changes_requested"].includes(job.status)) throw new Error(`This Reel is ${job.status}, so it can't be reviewed now.`);
  if (decision === "approved") {
    if (latest.mockProviders.length) throw new Error(`This render was made with offline stand-ins (${latest.mockProviders.join(", ")}), so it can't be approved.`);
    const failed = latest.qc.filter((c) => !c.ok && c.severity === "error");
    if (failed.length) throw new Error(`Quality checks failed: ${failed.map((c) => c.name).join(", ")}`);
  }
  if (decision !== "approved" && !note.trim()) throw new Error("Please add a note saying what to change or why it's rejected.");
  const review: Review = { id: newId("rev"), renderId: latest.id, decision, note, reviewer, at: now() };
  job.reviews.push(review);
  job.status = decision;
  job.updatedAt = now();
  return review;
}
