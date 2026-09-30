import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Config } from "../core/config.js";
import { decide } from "../core/review.js";
import { LocalStore } from "../core/store.js";
import { SupabaseSync } from "../core/supabase-sync.js";
import type { Fact, Job } from "../core/types.js";
import { totalCost } from "../pipeline/run.js";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const MIME: Record<string, string> = { ".mp4": "video/mp4", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".srt": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".html": "text/plain; charset=utf-8" };

const STYLE = `
:root { --bg:#f8fafc; --card:#fff; --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --brand:#0f766e; --ok:#15803d; --warn:#b45309; --bad:#b91c1c; }
@media (prefers-color-scheme: dark) { :root { --bg:#0b1220; --card:#111a2e; --ink:#e2e8f0; --muted:#94a3b8; --line:#1e293b; } }
* { box-sizing:border-box } body { margin:0; font:15px/1.5 system-ui, sans-serif; background:var(--bg); color:var(--ink) }
main { max-width:1200px; margin:0 auto; padding:24px 16px 64px } a { color:var(--brand) }
h1 { font-size:22px; margin:0 0 4px } h2 { font-size:17px; margin:28px 0 10px } .muted { color:var(--muted) }
.grid { display:grid; grid-template-columns: 360px 1fr; gap:24px } @media (max-width:860px){ .grid{ grid-template-columns:1fr } }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px }
video { aspect-ratio: 9 / 16; } video, img.thumb { width:100%; border-radius:10px; background:#000; display:block }
table { width:100%; border-collapse:collapse; font-size:14px } th, td { text-align:left; padding:8px; border-bottom:1px solid var(--line); vertical-align:top }
.pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; font-weight:600; border:1px solid currentColor }
.VERIFIED { color:var(--ok) } .USER_SUPPLIED { color:var(--brand) } .ESTIMATE, .AI_SUGGESTION { color:var(--warn) } .UNKNOWN { color:var(--muted) }
.ok { color:var(--ok) } .warn { color:var(--warn) } .bad { color:var(--bad) }
textarea { width:100%; min-height:70px; font:inherit; padding:8px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--ink) }
button { font:inherit; font-weight:600; padding:9px 16px; border-radius:8px; border:1px solid var(--line); cursor:pointer; margin:8px 8px 0 0; background:var(--card); color:var(--ink) }
button.primary { background:var(--brand); color:#fff; border-color:var(--brand) } button:disabled { opacity:.5; cursor:not-allowed }
.banner { padding:10px 14px; border-radius:8px; margin:12px 0; border:1px solid var(--warn); color:var(--warn) }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function listPage(jobs: Job[]): string {
  const rows = jobs
    .map((j) => {
      const addr = j.facts.find((f) => f.field === "address")?.value ?? j.source?.sourceRef ?? j.briefPath;
      return `<tr><td><a href="/reel/${esc(j.id)}">${esc(j.script?.title ?? addr)}</a><div class="muted">${esc(addr)}</div></td><td>${esc(j.status)}</td><td>${esc(j.updatedAt.slice(0, 16).replace("T", " "))}</td><td>$${totalCost(j).toFixed(2)}</td></tr>`;
    })
    .join("");
  return page("Reels", `<h1>Reels</h1><p class="muted">Drafts waiting for your decision are marked in_review.</p><div class="card"><table><tr><th>Reel</th><th>Status</th><th>Updated</th><th>Cost</th></tr>${rows || '<tr><td colspan="4" class="muted">No jobs yet. Run <code>npm run pp-content -- new brief.yaml</code>.</td></tr>'}</table></div>`);
}

function showValue(f: Fact): string {
  if (typeof f.value === "number" && f.unit?.startsWith("GBP")) return `£${f.value.toLocaleString("en-GB")}${f.unit === "GBP" ? "" : f.unit.slice(3)}`;
  return `${typeof f.value === "number" ? f.value.toLocaleString("en-GB") : f.value}${f.unit ? ` ${f.unit}` : ""}`;
}

function sourceLinks(f: Fact): string {
  return f.sources
    .map((s) => {
      const label = { user: "you", listing: "listing", photo: "photo", postcodes_io: "postcodes.io", land_registry: "Land Registry", epc: "EPC register", derived: "calculated" }[s.kind];
      const link = /^https?:/.test(s.ref) ? `<a href="${esc(s.ref)}" target="_blank" rel="noreferrer">${esc(label)}</a>` : esc(label);
      return s.quote ? `${link} <span class="muted">“${esc(s.quote.slice(0, 80))}”</span>` : link;
    })
    .join("<br>");
}

function reelPage(job: Job, message?: string): string {
  const r = job.renders[job.renders.length - 1];
  const asset = (id?: string) => job.assets.find((a) => a.id === id);
  const file = (id?: string) => (asset(id) ? `/files/${job.id}/${asset(id)!.path}` : "");
  const factById = new Map(job.facts.map((f) => [f.id, f]));
  const shotByLine = new Map(job.shots.map((s) => [s.lineId, s]));
  const canReview = r && ["in_review", "changes_requested"].includes(job.status);
  const blocked = r ? r.mockProviders.length > 0 || r.qc.some((c) => !c.ok && c.severity === "error") : true;

  const lines = (job.script?.lines ?? [])
    .map((l) => {
      const shot = shotByLine.get(l.id);
      const a = asset(shot?.assetId);
      const visual = a ? `${a.origin === "ai_generated" ? '<span class="pill warn">AI</span> ' : '<span class="pill ok">real photo</span> '}` : "";
      const facts = l.factIds.map((id) => factById.get(id)).filter(Boolean).map((f) => `<span class="pill ${f!.status}">${esc(f!.status)}</span> ${esc(f!.label)}: ${esc(showValue(f!))}`).join("<br>");
      return `<tr><td>${esc(l.id)}<div class="muted">${esc(l.role)}</div></td><td>${esc(l.text)}${l.onScreen ? `<div class="muted">On screen: ${esc(l.onScreen)}</div>` : ""}</td><td>${visual}</td><td>${facts || '<span class="muted">no facts stated</span>'}</td></tr>`;
    })
    .join("");

  const facts = job.facts
    .map(
      (f) =>
        `<tr><td>${esc(f.label)}</td><td>${esc(showValue(f))}</td><td><span class="pill ${f.status}">${esc(f.status)}</span>${f.scope === "as_advertised" ? '<div class="muted">as advertised</div>' : ""}</td><td>${sourceLinks(f)}${f.conflicts.map((c) => `<div class="bad">Conflict: ${esc(c.note)}</div>`).join("")}</td></tr>`,
    )
    .join("");

  const qc = (r?.qc ?? []).map((c) => `<tr><td class="${c.ok ? "ok" : c.severity === "error" ? "bad" : "warn"}">${c.ok ? "✓" : c.severity === "error" ? "✗" : "!"} ${esc(c.name)}</td><td>${esc(c.detail)}</td></tr>`).join("");
  const angles = job.angles.map((a) => `<tr><td>${a.id === job.chosenAngleId ? "<b>chosen</b>" : ""}</td><td><b>${esc(a.title)}</b><div class="muted">${esc(a.pitch)}</div></td><td>${a.worthiness}/10</td></tr>`).join("");
  const reviews = job.reviews.map((rv) => `<tr><td>${esc(rv.at.slice(0, 16).replace("T", " "))}</td><td>${esc(rv.decision)}</td><td>${esc(rv.note)}</td></tr>`).join("");
  const photos = job.assets.filter((a) => a.kind === "photo").length;
  const ai = job.assets.filter((a) => a.origin === "ai_generated").length;

  return page(
    job.script?.title ?? job.id,
    `<p><a href="/">← All Reels</a></p>
<h1>${esc(job.script?.title ?? job.id)}</h1>
<div class="muted">${esc(job.status)} · render v${r?.version ?? "–"} · ${photos} photos (${esc(job.source?.photoRights)}) · ${ai} AI visuals · cost $${totalCost(job).toFixed(2)}</div>
${message ? `<div class="banner">${esc(message)}</div>` : ""}
${r?.mockProviders.length ? `<div class="banner">Made with offline stand-ins (${esc(r.mockProviders.join(", "))}): silent voice and template script. Add API keys to make a real Reel.</div>` : ""}
<div class="grid">
  <div>
    ${r ? `<video src="${file(r.videoAssetId)}" controls playsinline></video>` : '<div class="card muted">Not rendered yet.</div>'}
    ${r ? `<h2>Thumbnail</h2><img class="thumb" src="${file(r.thumbnailAssetId)}" alt="Thumbnail">` : ""}
    <h2>Decision</h2>
    <form class="card" method="post" action="/reel/${esc(job.id)}/decision">
      <textarea name="note" placeholder="Note (needed for changes or rejection)"></textarea>
      <button class="primary" name="decision" value="approved" ${!canReview || blocked ? "disabled" : ""}>Approve</button>
      <button name="decision" value="changes_requested" ${!canReview ? "disabled" : ""}>Request changes</button>
      <button name="decision" value="rejected" ${!canReview ? "disabled" : ""}>Reject</button>
      ${blocked && canReview ? '<div class="muted">Approval is off until the error checks pass and real providers are used.</div>' : ""}
    </form>
  </div>
  <div>
    <h2>Caption</h2><div class="card">${esc(job.script?.caption)}<p class="muted">${(job.script?.hashtags ?? []).map((h) => `#${esc(h)}`).join(" ")}</p>${r ? `<a href="${file(r.captionsAssetId)}">captions .srt</a>` : ""}</div>
    <h2>Quality checks</h2><div class="card"><table>${qc || '<tr><td class="muted">Not run yet.</td></tr>'}</table></div>
    <h2>Script and the facts behind each line</h2><div class="card"><table><tr><th></th><th>Line</th><th>Visual</th><th>Facts</th></tr>${lines}</table></div>
    <h2>Fact record</h2><div class="card"><table><tr><th>Fact</th><th>Value</th><th>Status</th><th>Sources</th></tr>${facts}</table></div>
    <h2>Angles</h2><div class="card"><table>${angles}</table></div>
    ${job.source?.listingUrl ? `<h2>Source</h2><div class="card"><a href="${esc(job.source.listingUrl)}" target="_blank" rel="noreferrer">${esc(job.source.listingUrl)}</a> · <a href="/files/${esc(job.id)}/source/listing.txt">saved text</a> · read ${esc(job.source.capturedAt.slice(0, 10))}</div>` : ""}
    ${job.notes.length ? `<h2>Notes</h2><div class="card"><ul>${job.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>` : ""}
    ${reviews ? `<h2>History</h2><div class="card"><table>${reviews}</table></div>` : ""}
  </div>
</div>`,
  );
}

function serveFile(req: http.IncomingMessage, res: http.ServerResponse, abs: string) {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    res.writeHead(404).end("Not found");
    return;
  }
  const type = MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : stat.size - 1;
    res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${stat.size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
    fs.createReadStream(abs, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "content-type": type, "content-length": stat.size, "accept-ranges": "bytes" });
  fs.createReadStream(abs).pipe(res);
}

async function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 20_000) throw new Error("Form too large");
  }
  return new URLSearchParams(body);
}

/** Local review page. Binds to 127.0.0.1 only: it has no login. */
export function startReviewServer(config: Config, port = 4321): http.Server {
  const store = new LocalStore(config.dataDir);
  const sync = new SupabaseSync(config, store);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const html = (s: string, status = 200) => res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(s);
      if (req.method === "GET" && url.pathname === "/") return html(listPage(await store.listJobs()));

      const reel = url.pathname.match(/^\/reel\/([\w-]+)$/);
      if (req.method === "GET" && reel) return html(reelPage(await store.loadJob(reel[1]), url.searchParams.get("msg") ?? undefined));

      const post = url.pathname.match(/^\/reel\/([\w-]+)\/decision$/);
      if (req.method === "POST" && post) {
        const job = await store.loadJob(post[1]);
        const form = await readForm(req);
        let msg: string;
        try {
          const d = form.get("decision");
          if (d !== "approved" && d !== "changes_requested" && d !== "rejected") throw new Error("Unknown decision");
          decide(job, d, form.get("note") ?? "", config.reviewer);
          await store.saveJob(job);
          await sync.sync(job);
          msg = d === "approved" ? "Approved. Export it with: npm run pp-content -- export " + job.id : d === "changes_requested" ? "Changes requested. Re-run with: npm run pp-content -- rerun " + job.id + " --from script" : "Rejected.";
        } catch (e) {
          msg = (e as Error).message;
        }
        res.writeHead(303, { location: `/reel/${job.id}?msg=${encodeURIComponent(msg)}` }).end();
        return;
      }

      const f = url.pathname.match(/^\/files\/([\w-]+)\/(.+)$/);
      if (req.method === "GET" && f) {
        const dir = path.resolve(store.jobDir(f[1]));
        const abs = path.resolve(dir, decodeURIComponent(f[2]));
        if (!abs.startsWith(dir + path.sep)) return html("Forbidden", 403);
        return serveFile(req, res, abs);
      }
      html("Not found", 404);
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" }).end((e as Error).message);
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}
