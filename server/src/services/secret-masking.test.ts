import { describe, expect, it } from "vitest";
import { maskFromHash } from "./secret-masking.js";

describe("maskFromHash (pure)", () => {
  it("derives a truncated, non-reversible display fragment from a hash", () => {
    const hash = "a1b2c3d4e5f6g7h8i9j0";
    const masked = maskFromHash(hash);
    expect(masked).toBe("hash:a1b2c3…i9j0"); // first 6 + last 4 chars of the hash
    expect(masked.startsWith("hash:")).toBe(true);
    expect(masked).not.toContain(hash); // the full hash never appears verbatim
    expect(masked.length).toBeLessThan(hash.length + 6);
  });

  it("is deterministic — the same hash always masks to the same value", () => {
    const hash = "deadbeefcafefeed1234";
    expect(maskFromHash(hash)).toBe(maskFromHash(hash));
  });

  it("two different hashes never mask to the same value (no accidental collision from truncation alone, for these inputs)", () => {
    const a = maskFromHash("aaaaaaaaaaaaaaaaaaaa1111");
    const b = maskFromHash("bbbbbbbbbbbbbbbbbbbb2222");
    expect(a).not.toBe(b);
  });

  it("handles a short hash without throwing, still prefixed and never showing the raw value unprefixed", () => {
    const short = "abc123";
    const masked = maskFromHash(short);
    expect(masked.startsWith("hash:")).toBe(true);
  });
});
