import crypto from "node:crypto";

export const now = () => new Date().toISOString();

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

export function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Normalise a UK postcode to "AB1 2CD" form, or return undefined if it doesn't look like one. */
export function normalisePostcode(raw: string): string | undefined {
  const compact = raw.toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$/.test(compact)) return undefined;
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

export function formatGbp(n: number): string {
  return `£${Math.round(n).toLocaleString("en-GB")}`;
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
