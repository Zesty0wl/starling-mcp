import { describe, expect, it } from "vitest";
import { OPERATIONS } from "../src/operations.js";
import { ALL_TOOLS } from "../src/tools/index.js";

describe("API coverage", () => {
  it("covers every operation in Starling's public API spec", () => {
    const covered = new Set(ALL_TOOLS.flatMap((t) => t.operations));
    const missing = Object.keys(OPERATIONS).filter((op) => !covered.has(op));
    expect(missing).toEqual([]);
    expect(Object.keys(OPERATIONS)).toHaveLength(87);
  });

  it("only references real operations", () => {
    for (const tool of ALL_TOOLS)
      for (const op of tool.operations) expect(OPERATIONS[op], `${tool.name} → ${op}`).toBeDefined();
  });

  it("has unique tool names", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("never exposes a write operation at the read tier", () => {
    for (const tool of ALL_TOOLS.filter((t) => t.tier === "read")) {
      for (const op of tool.operations) expect(OPERATIONS[op]!.method, `${tool.name} → ${op}`).toBe("GET");
      expect(tool.readOnly, tool.name).toBe(true);
    }
  });

  it("puts every signed money-moving operation behind confirmation", () => {
    for (const tool of ALL_TOOLS) {
      if (tool.operations.some((op) => OPERATIONS[op]!.signed)) expect(tool.confirm, tool.name).toBe(true);
      if (tool.tier === "payments") expect(tool.confirm, tool.name).toBe(true);
    }
  });
});
