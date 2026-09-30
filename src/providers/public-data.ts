/**
 * Free UK public data used to verify facts. Each lookup fails soft: a missing or
 * unreachable source leaves facts unverified rather than stopping the pipeline.
 *
 *  - postcodes.io: postcode validity, local authority, region, coordinates (no key)
 *  - HM Land Registry Price Paid (linked data API): past sales in the postcode (no key)
 *  - EPC register (Open Data Communities): floor area, energy rating (free key)
 */

export interface PostcodeInfo {
  postcode: string;
  adminDistrict?: string;
  region?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
}

export interface Sale {
  price: number;
  date: string; // ISO date
  paon?: string; // house number or name
  saon?: string; // flat number
  street?: string;
  propertyType?: string;
  url: string;
}

export interface EpcRecord {
  address: string;
  rating?: string;
  floorAreaM2?: number;
  propertyType?: string;
  builtForm?: string;
  lodgementDate?: string;
  url: string;
}

export interface PublicData {
  postcode(pc: string): Promise<PostcodeInfo | undefined>;
  sales(pc: string): Promise<Sale[]>;
  epc(pc: string): Promise<EpcRecord[]>;
}

type Fetch = typeof fetch;

export class LivePublicData implements PublicData {
  constructor(
    private opts: { epcEmail?: string; epcApiKey?: string } = {},
    private fetchImpl: Fetch = fetch,
  ) {}

  private async json(url: string, headers: Record<string, string> = {}): Promise<any> {
    const res = await this.fetchImpl(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`${new URL(url).hostname} returned HTTP ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  }

  async postcode(pc: string): Promise<PostcodeInfo | undefined> {
    const body = await this.json(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`);
    return body?.result ? parsePostcodesIo(body.result) : undefined;
  }

  async sales(pc: string): Promise<Sale[]> {
    const url = `https://landregistry.data.gov.uk/data/ppi/transaction-record.json?propertyAddress.postcode=${encodeURIComponent(pc)}&_pageSize=200`;
    return parseLandRegistry(await this.json(url));
  }

  async epc(pc: string): Promise<EpcRecord[]> {
    if (!this.opts.epcEmail || !this.opts.epcApiKey) return [];
    const auth = Buffer.from(`${this.opts.epcEmail}:${this.opts.epcApiKey}`).toString("base64");
    const url = `https://epc.opendatacommunities.org/api/v1/domestic/search?postcode=${encodeURIComponent(pc)}&size=200`;
    return parseEpc(await this.json(url, { authorization: `Basic ${auth}` }));
  }
}

export function parsePostcodesIo(r: any): PostcodeInfo {
  return {
    postcode: String(r.postcode),
    adminDistrict: r.admin_district ?? undefined,
    region: r.region ?? undefined,
    country: r.country ?? undefined,
    latitude: typeof r.latitude === "number" ? r.latitude : undefined,
    longitude: typeof r.longitude === "number" ? r.longitude : undefined,
  };
}

const label = (v: any): string | undefined => {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  const pref = v.prefLabel ?? v.label;
  if (Array.isArray(pref)) return pref[0]?._value ?? pref[0];
  if (typeof pref === "string") return pref;
  return pref?._value;
};

export function parseLandRegistry(body: any): Sale[] {
  const items: any[] = body?.result?.items ?? [];
  const sales: Sale[] = [];
  for (const it of items) {
    const price = Number(it.pricePaid);
    const date = new Date(Date.parse(it.transactionDate));
    if (!Number.isFinite(price) || Number.isNaN(date.getTime())) continue;
    const addr = it.propertyAddress ?? {};
    sales.push({
      price,
      date: date.toISOString().slice(0, 10),
      paon: addr.paon ?? undefined,
      saon: addr.saon ?? undefined,
      street: addr.street ?? undefined,
      propertyType: label(it.propertyType),
      url: String(it._about ?? "https://landregistry.data.gov.uk/app/ppd"),
    });
  }
  return sales.sort((a, b) => b.date.localeCompare(a.date));
}

export function parseEpc(body: any): EpcRecord[] {
  const rows: any[] = body?.rows ?? [];
  return rows.map((r) => ({
    address: [r.address1, r.address2, r.address3].filter(Boolean).join(", ") || String(r.address ?? ""),
    rating: r["current-energy-rating"] || undefined,
    floorAreaM2: r["total-floor-area"] ? Number(r["total-floor-area"]) : undefined,
    propertyType: r["property-type"] || undefined,
    builtForm: r["built-form"] || undefined,
    lodgementDate: r["lodgement-date"] || undefined,
    url: r["lmk-key"] ? `https://epc.opendatacommunities.org/domestic/certificate/${r["lmk-key"]}` : "https://epc.opendatacommunities.org/",
  }));
}

/** Offline stand-in used by tests and mock runs: knows nothing, so nothing is verified by it. */
export class NoPublicData implements PublicData {
  async postcode() {
    return undefined;
  }
  async sales() {
    return [];
  }
  async epc() {
    return [];
  }
}
