import { describe, expect, it } from "vitest";
import { EXPECTED_SELF_CHECK_HASH, hashFloat64, runSelfCheck } from "../src/index.ts";

describe("hashFloat64", () => {
  it("is stable and 16 hex digits long", () => {
    expect(hashFloat64([1, 2, 3])).toBe(hashFloat64(new Float64Array([1, 2, 3])));
    expect(hashFloat64([1, 2, 3])).toMatch(/^[0-9a-f]{16}$/);
  });

  it("treats -0 as 0 and all NaNs as one value", () => {
    expect(hashFloat64([-0])).toBe(hashFloat64([0]));
    expect(hashFloat64([NaN])).toBe(hashFloat64([0 / 0]));
  });

  it("detects the smallest possible change and reordering", () => {
    const base = [0.1, 0.2, 0.3];
    expect(hashFloat64([0.1, 0.2, 0.30000000000000004])).not.toBe(hashFloat64(base));
    expect(hashFloat64([0.2, 0.1, 0.3])).not.toBe(hashFloat64(base));
    expect(hashFloat64([])).not.toBe(hashFloat64([0]));
  });
});

describe("engine self-check", () => {
  it("produces the pinned hash in Node (the web app checks the same hash in a Web Worker)", () => {
    const result = runSelfCheck();
    expect(result.hash).toBe(EXPECTED_SELF_CHECK_HASH);
    expect(result.matches).toBe(true);
    expect(result.numbers).toBeGreaterThan(9000);
  });

  it("gives the same result every time", () => {
    expect(runSelfCheck().hash).toBe(runSelfCheck().hash);
  });
});
