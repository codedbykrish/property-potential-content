import type { Fact, FactSource, FactStatus } from "../core/types.js";
import { SPEAKABLE_STATUSES } from "../core/types.js";
import { median, newId, normalisePostcode, now } from "../core/util.js";
import type { CandidateFact } from "../providers/llm.js";
import type { EpcRecord, PostcodeInfo, Sale } from "../providers/public-data.js";
import type { Stage } from "./context.js";

const SQ_FT_PER_M2 = 10.7639;

/** Step 1: Claude reads the listing text, your facts and notes, and the photo labels. */
export const extractFacts: Stage = async (job, ctx) => {
  const src = job.source!;
  const candidates = await ctx.llm.extractFacts({
    listingText: src.listingText,
    userFacts: src.userFacts,
    notes: src.notes,
    photos: job.photoLabels,
  });
  job.facts = candidatesToFacts(candidates, src.userFacts);
  return { providers: [ctx.llm.name] };
};

export function candidatesToFacts(candidates: CandidateFact[], userFacts: Record<string, unknown>): Fact[] {
  const facts: Fact[] = [];
  const t = now();
  // Your own brief facts always go in as USER_SUPPLIED, whatever the model returned.
  for (const [field, value] of Object.entries(userFacts)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
    const fromModel = candidates.find((c) => c.field === field && c.sourceKind === "user");
    facts.push({
      id: newId("fct"),
      field,
      label: fromModel?.label ?? field,
      value,
      unit: fromModel?.unit ?? undefined,
      status: "USER_SUPPLIED",
      scope: "none",
      sources: [{ kind: "user", ref: "brief" }],
      conflicts: [],
      checkedAt: t,
    });
  }
  for (const c of candidates) {
    if (c.sourceKind === "user" && field(c) in userFacts) continue;
    facts.push({
      id: newId("fct"),
      field: c.field,
      label: c.label,
      value: c.value,
      unit: c.unit ?? undefined,
      // Notes are yours; listing and photo readings are the model's until checked.
      status: c.sourceKind === "user" ? "USER_SUPPLIED" : "AI_SUGGESTION",
      scope: "none",
      sources: [{ kind: c.sourceKind, ref: c.sourceKind === "user" ? "brief notes" : c.sourceKind === "photo" ? String(c.quote ?? "") : "listing", quote: c.quote ?? undefined }],
      conflicts: [],
      checkedAt: t,
    });
  }
  return facts;
}

const field = (c: CandidateFact) => c.field;

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const digits = (s: string) => s.replace(/[^0-9.]/g, "");

/** True when the quote is really in the listing and actually states the value. */
export function quoteSupports(listingText: string, quote: string | undefined, value: Fact["value"]): boolean {
  if (!quote || quote.trim().length < 2) return false;
  if (!squash(listingText).includes(squash(quote))) return false;
  if (typeof value === "number") {
    const q = quote.replace(/,/g, "");
    const nums = (q.match(/\d+(\.\d+)?/g) ?? []).map(Number);
    // "£350k" style
    const k = q.match(/(\d+(\.\d+)?)\s*k\b/i);
    if (k) nums.push(Number(k[1]) * 1000);
    const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    for (const [w, n] of Object.entries(words)) if (new RegExp(`\\b${w}\\b`, "i").test(q)) nums.push(n);
    return nums.some((n) => Math.abs(n - value) < 1e-6);
  }
  if (typeof value === "string") return squash(quote).includes(squash(value)) || squash(value).includes(squash(quote));
  return true;
}

function addConflict(f: Fact, source: FactSource, value: Fact["value"], note: string) {
  f.conflicts.push({ source, value, note });
}

function valuesDiffer(a: Fact["value"], b: Fact["value"]): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) > 1e-6;
  return squash(String(a)) !== squash(String(b));
}

/** First house number or name in an address line, for matching against public records. */
export function houseKey(address: string): string | undefined {
  const m = address.match(/^\s*(?:flat\s+\w+,?\s*)?(\d+[a-z]?)\b/i);
  if (m) return m[1].toLowerCase();
  const first = address.split(",")[0]?.trim().toLowerCase();
  return first || undefined;
}

export interface VerifyInputs {
  listingText?: string;
  postcode?: PostcodeInfo;
  sales: Sale[];
  epc: EpcRecord[];
  today?: Date;
}

/**
 * Step 2: plain code, not the model, checks facts against the listing snapshot
 * and public data. Pure so it can be tested with fixtures.
 */
export function verifyFacts(facts: Fact[], inp: VerifyInputs): Fact[] {
  const t = now();
  const out = facts.map((f) => ({ ...f, sources: [...f.sources], conflicts: [...f.conflicts] }));
  const byField = (name: string) => out.filter((f) => f.field === name);
  const add = (f: Omit<Fact, "id" | "checkedAt" | "conflicts"> & { conflicts?: Fact["conflicts"] }) => {
    const fact: Fact = { id: newId("fct"), checkedAt: t, conflicts: [], ...f };
    out.push(fact);
    return fact;
  };

  // 1. Listing claims whose quote really appears in the saved page become VERIFIED "as advertised".
  if (inp.listingText) {
    for (const f of out) {
      const s = f.sources.find((x) => x.kind === "listing");
      if (f.status === "AI_SUGGESTION" && s && quoteSupports(inp.listingText, s.quote, f.value)) {
        f.status = "VERIFIED";
        f.scope = "as_advertised";
        f.checkedAt = t;
      }
    }
  }

  // 2. Same field from you and from the listing with different values: keep both, flag both.
  const fields = new Set(out.map((f) => f.field));
  for (const name of fields) {
    const group = byField(name);
    for (const a of group) {
      for (const b of group) {
        if (a !== b && a.sources[0].kind !== b.sources[0].kind && valuesDiffer(a.value, b.value)) {
          addConflict(a, b.sources[0], b.value, `${b.sources[0].kind} says ${b.value}`);
        }
      }
    }
  }

  // 3. Postcode and location from postcodes.io.
  const pcFact = byField("postcode")[0];
  if (inp.postcode) {
    if (pcFact) {
      pcFact.sources.push({ kind: "postcodes_io", ref: `https://api.postcodes.io/postcodes/${encodeURIComponent(inp.postcode.postcode)}` });
      if (normalisePostcode(String(pcFact.value)) === normalisePostcode(inp.postcode.postcode)) {
        pcFact.status = "VERIFIED";
        pcFact.scope = "independent";
      }
    }
    const ref = { kind: "postcodes_io" as const, ref: `https://api.postcodes.io/postcodes/${encodeURIComponent(inp.postcode.postcode)}` };
    if (inp.postcode.adminDistrict) add({ field: "localAuthority", label: "Local authority", value: inp.postcode.adminDistrict, status: "VERIFIED", scope: "independent", sources: [ref] });
    if (inp.postcode.region) add({ field: "region", label: "Region", value: inp.postcode.region, status: "VERIFIED", scope: "independent", sources: [ref] });
  }

  // 4. Land Registry: recent sales in the postcode, and this property's own last sale.
  const today = inp.today ?? new Date();
  const fiveYearsAgo = new Date(today);
  fiveYearsAgo.setFullYear(today.getFullYear() - 5);
  const recent = inp.sales.filter((s) => new Date(s.date) >= fiveYearsAgo);
  const lrRef = (url: string) => ({ kind: "land_registry" as const, ref: url });
  if (recent.length >= 3) {
    add({
      field: "postcodeMedianSalePrice5y",
      label: `Median sale price in the postcode (${recent.length} sales, last 5 years)`,
      value: Math.round(median(recent.map((s) => s.price))!),
      unit: "GBP",
      status: "VERIFIED",
      scope: "independent",
      sources: [lrRef("https://landregistry.data.gov.uk/app/ppd")],
    });
  }
  const address = byField("address")[0];
  const key = address ? houseKey(String(address.value)) : undefined;
  if (key) {
    const own = inp.sales.find((s) => (s.paon ?? "").toLowerCase() === key || (s.saon ?? "").toLowerCase() === key);
    if (own) {
      add({ field: "lastSoldPrice", label: `Last sold price (${own.date})`, value: own.price, unit: "GBP", status: "VERIFIED", scope: "independent", sources: [lrRef(own.url)] });
      add({ field: "lastSoldDate", label: "Last sold date", value: own.date, status: "VERIFIED", scope: "independent", sources: [lrRef(own.url)] });
    }
  }

  // 5. EPC register: floor area and energy rating for the matching address.
  if (key) {
    const epc = inp.epc
      .filter((e) => houseKey(e.address) === key)
      .sort((a, b) => (b.lodgementDate ?? "").localeCompare(a.lodgementDate ?? ""))[0];
    if (epc) {
      const ref = { kind: "epc" as const, ref: epc.url };
      if (epc.floorAreaM2) {
        const sqft = Math.round(epc.floorAreaM2 * SQ_FT_PER_M2);
        const existing = byField("floorAreaSqFt");
        if (existing.length === 0) {
          add({ field: "floorAreaSqFt", label: "Floor area (EPC)", value: sqft, unit: "sq ft", status: "VERIFIED", scope: "independent", sources: [ref] });
        }
        for (const f of existing) {
          const v = Number(f.value);
          if (Number.isFinite(v) && Math.abs(v - sqft) / sqft <= 0.1) {
            f.sources.push(ref);
            f.status = "VERIFIED";
            f.scope = "independent";
          } else {
            addConflict(f, ref, sqft, `EPC records ${sqft} sq ft (${epc.floorAreaM2} m²)`);
          }
        }
      }
      if (epc.rating) {
        const existing = byField("epcRating");
        if (existing.length === 0) add({ field: "epcRating", label: "EPC rating", value: epc.rating, status: "VERIFIED", scope: "independent", sources: [ref] });
        for (const f of existing) {
          if (squash(String(f.value)) === squash(epc.rating)) {
            f.sources.push(ref);
            f.status = "VERIFIED";
            f.scope = "independent";
          } else addConflict(f, ref, epc.rating, `EPC register says ${epc.rating}`);
        }
      }
    }
  }

  // 6. Derived: price per sq ft, only from facts that may be spoken.
  const price = byField("askingPrice").find((f) => SPEAKABLE_STATUSES.includes(f.status) && f.conflicts.length === 0);
  const area = byField("floorAreaSqFt").find((f) => SPEAKABLE_STATUSES.includes(f.status) && f.conflicts.length === 0);
  if (price && area && Number(area.value) > 0) {
    const status: FactStatus = price.status === "USER_SUPPLIED" || area.status === "USER_SUPPLIED" ? "USER_SUPPLIED" : "VERIFIED";
    add({
      field: "pricePerSqFt",
      label: "Asking price per sq ft",
      value: Math.round(Number(price.value) / Number(area.value)),
      unit: "GBP per sq ft",
      status,
      scope: price.scope === "as_advertised" ? "as_advertised" : "none",
      sources: [{ kind: "derived", ref: `${price.id} / ${area.id}` }],
    });
  }

  // A fact with an unresolved conflict can't be spoken until you settle it in the brief.
  for (const f of out) {
    if (f.conflicts.length && f.status === "VERIFIED" && f.scope === "as_advertised") f.status = "AI_SUGGESTION";
  }
  return out;
}

export const verify: Stage = async (job, ctx) => {
  const pcRaw = job.facts.find((f) => f.field === "postcode")?.value;
  const pc = pcRaw ? normalisePostcode(String(pcRaw)) : undefined;
  let postcode: PostcodeInfo | undefined;
  let sales: Sale[] = [];
  let epc: EpcRecord[] = [];
  const providers: string[] = [];
  if (pc) {
    const soft = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        const r = await fn();
        providers.push(name);
        return r;
      } catch (e) {
        job.notes.push(`${name} lookup failed: ${(e as Error).message}`);
        ctx.log(`${name} lookup failed: ${(e as Error).message}`);
        return fallback;
      }
    };
    [postcode, sales, epc] = await Promise.all([
      soft("postcodes.io", () => ctx.publicData.postcode(pc), undefined),
      soft("land_registry", () => ctx.publicData.sales(pc), [] as Sale[]),
      soft("epc", () => ctx.publicData.epc(pc), [] as EpcRecord[]),
    ]);
  } else {
    job.notes.push("No valid postcode, so nothing could be checked against public data.");
  }
  job.facts = verifyFacts(job.facts, { listingText: job.source?.listingText, postcode, sales, epc });
  return { providers };
};
