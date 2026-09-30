import { describe, expect, it } from "vitest";
import type { Fact, Script } from "../src/core/types.js";
import { checkScript, numbersIn } from "../src/pipeline/script.js";

const fact = (id: string, field: string, value: Fact["value"], status: Fact["status"], scope: Fact["scope"] = "none"): Fact => ({
  id,
  field,
  label: field,
  value,
  status,
  scope,
  sources: [{ kind: "user", ref: "brief" }],
  conflicts: [],
  checkedAt: "2026-10-01T00:00:00Z",
});

const facts = [
  fact("price", "askingPrice", 250000, "VERIFIED", "as_advertised"),
  fact("beds", "bedrooms", 3, "USER_SUPPLIED"),
  fact("area", "floorAreaSqFt", 1100, "AI_SUGGESTION"),
  fact("est", "estimatedValue", 270000, "ESTIMATE"),
  fact("year", "yearBuilt", 1934, "VERIFIED", "independent"),
];

const filler = "Walk through the rooms and picture how the space could work for you from the kitchen to the garden and beyond it.";

function script(lines: Partial<Script["lines"][number]>[]): Script {
  const base: Script["lines"] = [
    { id: "L1", role: "hook", text: "Here's a house worth a proper look.", visualId: "p1", factIds: [] },
    ...lines.map((l, i) => ({ id: `B${i}`, role: "beat" as const, text: "", visualId: "p2", factIds: [], ...l })),
    { id: "F1", role: "beat", text: filler, visualId: "p3", factIds: [] },
    { id: "F2", role: "close", text: "Would you take it on, or keep looking for something closer to your plans?", visualId: "p4", factIds: [] },
    { id: "C1", role: "cta", text: "Analyse homes like this in minutes with Property Potential.", visualId: "p1", factIds: [] },
  ];
  return { lines: base, caption: "", hashtags: [], title: "", thumbnailText: "" };
}

const gate = (s: Script) => checkScript({ script: s, facts, photoIds: ["p1", "p2", "p3", "p4"], aiVisuals: [] });

describe("numbersIn", () => {
  it("reads prices, thousands, number words and decades", () => {
    const n = numbersIn("Listed at £250,000, or £250k, with three bedrooms, built in the 1930s, 1,100 sq ft");
    expect(n.map((x) => x.value)).toEqual(expect.arrayContaining([250000, 250000, 3, 1930, 1100]));
    expect(n.find((x) => x.raw.includes("1930s"))?.decade).toBe(true);
  });
});

describe("checkScript", () => {
  it("passes a script whose numbers all trace to speakable cited facts", () => {
    expect(gate(script([{ text: "It's listed at £250,000 with three bedrooms.", factIds: ["price", "beds"] }]))).toEqual([]);
  });

  it("rejects a number with no cited fact", () => {
    const issues = gate(script([{ text: "It has 4 bedrooms.", factIds: ["beds"] }]));
    expect(issues.join(" ")).toMatch(/says "4"/);
  });

  it("rejects AI_SUGGESTION facts", () => {
    const issues = gate(script([{ text: "It offers 1,100 sq ft of space.", factIds: ["area"] }]));
    expect(issues.join(" ")).toMatch(/AI_SUGGESTION/);
  });

  it("allows an estimate only with hedging", () => {
    expect(gate(script([{ text: "Similar homes sell for £270,000.", factIds: ["est"] }])).join(" ")).toMatch(/without "around"/);
    expect(gate(script([{ text: "Similar homes sell for around £270,000.", factIds: ["est"] }]))).toEqual([]);
  });

  it("requires an advertised price to be attributed", () => {
    expect(gate(script([{ text: "It costs £250,000.", factIds: ["price"] }])).join(" ")).toMatch(/attributing/);
  });

  it("accepts a decade that matches the build year", () => {
    expect(gate(script([{ text: "It was built in the 1930s.", factIds: ["year"] }]))).toEqual([]);
    expect(gate(script([{ text: "It was built in the 1950s.", factIds: ["year"] }])).join(" ")).toMatch(/1950s/);
  });

  it("checks on-screen text too", () => {
    const issues = gate(script([{ text: "Here is the price.", factIds: ["beds"], onScreen: "£300,000" }]));
    expect(issues.join(" ")).toMatch(/on screen/);
  });

  it("bans hype words", () => {
    expect(gate(script([{ text: "An absolute bargain in a great spot.", factIds: [] }])).join(" ")).toMatch(/bargain/);
  });

  it("rejects unknown visuals and unrequested AI shots", () => {
    const issues = gate(script([{ text: "A look inside the house here.", visualId: "ai:B0" }]));
    expect(issues.join(" ")).toMatch(/never requested/);
  });
});
