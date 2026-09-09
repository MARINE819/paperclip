import { describe, expect, it } from "vitest";
import {
  createMemoryOperationSchema,
  promoteMemoryOperationSchema,
  reviewMemoryOperationSchema,
} from "./knowledge.js";

describe("knowledge validators", () => {
  it("keeps sourceType in the text-backed allowlist", () => {
    expect(createMemoryOperationSchema.safeParse({
      sourceType: "issue",
      sourceId: "NEX-42",
      content: "Reusable finding",
    }).success).toBe(true);
    expect(createMemoryOperationSchema.safeParse({
      sourceType: "unknown",
      sourceId: "NEX-42",
      content: "Reusable finding",
    }).success).toBe(false);
  });

  it("separates review from promotion input", () => {
    expect(reviewMemoryOperationSchema.safeParse({ reviewState: "approved" }).success).toBe(true);
    expect(reviewMemoryOperationSchema.safeParse({ reviewState: "pending" }).success).toBe(false);
    expect(promoteMemoryOperationSchema.safeParse({ body: "# Markdown" }).success).toBe(true);
  });
});
