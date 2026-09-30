import { describe, expect, it } from "vitest";
import type { Fact } from "../src/core/types.js";
import { candidatesToFacts, houseKey, quoteSupports, verifyFacts } from "../src/pipeline/facts.js";
import { parseEpc, parseLandRegistry, parsePostcodesIo } from "../src/providers/public-data.js";

const listing = `12 Sample Road, Leominster HR6 8AA
Offers over £250,000
Three bedroom semi-detached house
Approx. 1,100 sq ft`;

describe("quoteSupports", () => {
  it("needs the quote in the listing and the value in the quote", () => {
    expect(quoteSupports(listing, "Offers over £250,000", 250000)).toBe(true);
    expect(quoteSupports(listing, "Three bedroom", 3)).toBe(true);
    expect(quoteSupports(listing, "Offers over £250,000", 260000)).toBe(false);
    expect(quoteSupports(listing, "Offers over £260,000", 260000)).toBe(false); // not in the page
    expect(quoteSupports(listing, undefined, 3)).toBe(false);
  });
});

describe("houseKey", () => {
  it("finds the house number or name", () => {
    expect(houseKey("12 Sample Road")).toBe("12");
    expect(houseKey("Flat 3, 12A High St")).toBe("12a");
    expect(houseKey("Rose Cottage, Mill Lane")).toBe("rose cottage");
  });
});

describe("verifyFacts", () => {
  const base = candidatesToFacts(
    [
      { field: "askingPrice", label: "Asking price", value: 250000, unit: "GBP", sourceKind: "listing", quote: "Offers over £250,000" },
      { field: "bedrooms", label: "Bedrooms", value: 3, unit: null, sourceKind: "listing", quote: "Three bedroom" },
      { field: "floorAreaSqFt", label: "Floor area", value: 1100, unit: "sq ft", sourceKind: "listing", quote: "Approx. 1,100 sq ft" },
      { field: "garden", label: "Garden", value: "Large rear garden", unit: null, sourceKind: "listing", quote: "huge garden" },
    ],
    { address: "12 Sample Road", postcode: "hr68aa", bedrooms: 4 },
  );

  const sales = parseLandRegistry({
    result: {
      items: [
        { pricePaid: 180000, transactionDate: "Fri, 12 Jan 2018", propertyAddress: { paon: "12", street: "SAMPLE ROAD" }, _about: "http://landregistry.data.gov.uk/data/ppi/transaction/A/current" },
        { pricePaid: 240000, transactionDate: "Mon, 03 Jun 2024", propertyAddress: { paon: "3", street: "SAMPLE ROAD" } },
        { pricePaid: 260000, transactionDate: "Tue, 10 Sep 2024", propertyAddress: { paon: "5", street: "SAMPLE ROAD" } },
        { pricePaid: 230000, transactionDate: "Wed, 05 Mar 2025", propertyAddress: { paon: "9", street: "SAMPLE ROAD" } },
      ],
    },
  });
  const epc = parseEpc({ rows: [{ address1: "12 Sample Road", "current-energy-rating": "D", "total-floor-area": "100", "lodgement-date": "2019-05-01", "lmk-key": "abc" }] });
  const postcode = parsePostcodesIo({ postcode: "HR6 8AA", admin_district: "Herefordshire, County of", region: "West Midlands", latitude: 52.2, longitude: -2.7 });

  const out = verifyFacts(base, { listingText: listing, postcode, sales, epc, today: new Date("2026-10-01") });
  const get = (field: string, kind?: string) => out.filter((f) => f.field === field && (!kind || f.sources[0].kind === kind));

  it("verifies listing claims whose quote is on the page, as advertised", () => {
    const price = get("askingPrice")[0];
    expect(price.status).toBe("VERIFIED");
    expect(price.scope).toBe("as_advertised");
  });

  it("leaves claims whose quote isn't on the page as AI_SUGGESTION", () => {
    expect(get("garden")[0].status).toBe("AI_SUGGESTION");
  });

  it("flags conflicts between you and the listing and stops the listing value being spoken", () => {
    const listingBeds = get("bedrooms", "listing")[0];
    const userBeds = get("bedrooms", "user")[0];
    expect(userBeds.status).toBe("USER_SUPPLIED");
    expect(userBeds.conflicts[0].value).toBe(3);
    expect(listingBeds.conflicts[0].value).toBe(4);
    expect(listingBeds.status).toBe("AI_SUGGESTION");
  });

  it("verifies the postcode and adds location facts", () => {
    expect(get("postcode")[0].status).toBe("VERIFIED");
    expect(get("localAuthority")[0].value).toBe("Herefordshire, County of");
  });

  it("adds Land Registry context and the property's own last sale", () => {
    expect(get("postcodeMedianSalePrice5y")[0].value).toBe(240000);
    expect(get("lastSoldPrice")[0].value).toBe(180000);
  });

  it("checks floor area against the EPC (1,100 vs 1,076 sq ft is within 10%)", () => {
    const area = get("floorAreaSqFt")[0];
    expect(area.status).toBe("VERIFIED");
    expect(area.scope).toBe("independent");
    expect(get("epcRating")[0].value).toBe("D");
  });

  it("derives price per sq ft from speakable facts only", () => {
    const ppsf = get("pricePerSqFt")[0] as Fact;
    expect(ppsf.value).toBe(227);
    expect(ppsf.scope).toBe("as_advertised");
  });

  it("verifies nothing without public data", () => {
    const bare = verifyFacts(base, { sales: [], epc: [] });
    expect(bare.find((f) => f.field === "postcode")!.status).toBe("USER_SUPPLIED");
    expect(bare.some((f) => f.sources[0].kind === "land_registry")).toBe(false);
  });
});
