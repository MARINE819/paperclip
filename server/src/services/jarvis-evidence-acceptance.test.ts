import { describe, expect, it } from "vitest";
import { evaluateEvidenceAcceptance, type JarvisEvidenceCandidate } from "./jarvis-evidence-acceptance.js";

const CHILD_ISSUE_ID = "issue-child-1";

function workProduct(overrides: Partial<JarvisEvidenceCandidate> & { id: string }): JarvisEvidenceCandidate {
  return {
    issueId: CHILD_ISSUE_ID,
    type: "artifact",
    status: "active",
    healthStatus: "healthy",
    reviewState: "none",
    url: "https://example.test/artifact/1",
    metadata: null,
    ...overrides,
  };
}

describe("evaluateEvidenceAcceptance", () => {
  it("accepts a single healthy, resolvable work product on the correct issue", () => {
    const result = evaluateEvidenceAcceptance({
      childIssueId: CHILD_ISSUE_ID,
      workProducts: [workProduct({ id: "wp-1" })],
    });
    expect(result.accepted).toBe(true);
    expect(result.acceptedWorkProductIds).toEqual(["wp-1"]);
    expect(result.problems).toEqual([]);
  });

  it("rejects when there are no work products at all", () => {
    const result = evaluateEvidenceAcceptance({ childIssueId: CHILD_ISSUE_ID, workProducts: [] });
    expect(result.accepted).toBe(false);
    expect(result.acceptedWorkProductIds).toEqual([]);
    expect(result.reasonCodes).toEqual(["no_acceptable_work_product"]);
  });

  it("excludes and reports a work product belonging to a different issue", () => {
    const result = evaluateEvidenceAcceptance({
      childIssueId: CHILD_ISSUE_ID,
      workProducts: [workProduct({ id: "wp-wrong-issue", issueId: "issue-other" })],
    });
    expect(result.accepted).toBe(false);
    expect(result.problems.some((p) => p.includes("different issue"))).toBe(true);
  });

  it("rejects a work product with status failed", () => {
    const result = evaluateEvidenceAcceptance({
      childIssueId: CHILD_ISSUE_ID,
      workProducts: [workProduct({ id: "wp-failed", status: "failed" })],
    });
    expect(result.accepted).toBe(false);
    expect(result.problems.some((p) => p.includes('status "failed"'))).toBe(true);
  });

  it("rejects a work product with status archived", () => {
    const result = evaluateEvidenceAcceptance({
      childIssueId: CHILD_ISSUE_ID,
      workProducts: [workProduct({ id: "wp-archived", status: "archived" })],
    });
    expect(result.accepted).toBe(false);
  });

  it("rejects an unhealthy work product", () => {
    const result = evaluateEvidenceAcceptance({
      childIssueId: CHILD_ISSUE_ID,
      workProducts: [workProduct({ id: "wp-unhealthy", healthStatus: "unhealthy" })],
    });
    expect(result.accepted).toBe(false);
    expect(result.problems.some((p) => p.includes("unhealthy"))).toBe(true);
  });

  it("rejects a work product with no url, attachment path, or workspace_file resourceRef", () => {
    const result = evaluateEvidenceAcceptance({
      childIssueId: CHILD_ISSUE_ID,
      workProducts: [workProduct({ id: "wp-unresolvable", url: null, metadata: null })],
    });
    expect(result.accepted).toBe(false);
    expect(result.problems.some((p) => p.includes("no resolvable open location"))).toBe(true);
  });

  it("accepts a workspace_file resourceRef with a non-empty path even without a url", () => {
    const result = evaluateEvidenceAcceptance({
      childIssueId: CHILD_ISSUE_ID,
      workProducts: [
        workProduct({
          id: "wp-workspace-file",
          url: null,
          metadata: { resourceRef: { kind: "workspace_file", path: "artifacts/report.md" } },
        }),
      ],
    });
    expect(result.accepted).toBe(true);
    expect(result.acceptedWorkProductIds).toEqual(["wp-workspace-file"]);
  });

  it("rejects a workspace_file resourceRef with an empty path", () => {
    const result = evaluateEvidenceAcceptance({
      childIssueId: CHILD_ISSUE_ID,
      workProducts: [
        workProduct({
          id: "wp-empty-path",
          url: null,
          metadata: { resourceRef: { kind: "workspace_file", path: "" } },
        }),
      ],
    });
    expect(result.accepted).toBe(false);
  });

  it("accepts an attachment-backed work product via metadata.openPath even without a url", () => {
    const result = evaluateEvidenceAcceptance({
      childIssueId: CHILD_ISSUE_ID,
      workProducts: [
        workProduct({
          id: "wp-attachment",
          url: null,
          metadata: { contentPath: "/api/attachments/1/content", openPath: "/api/attachments/1/content" },
        }),
      ],
    });
    expect(result.accepted).toBe(true);
  });

  it("accepts if at least one of several work products is acceptable", () => {
    const result = evaluateEvidenceAcceptance({
      childIssueId: CHILD_ISSUE_ID,
      workProducts: [
        workProduct({ id: "wp-bad", status: "failed" }),
        workProduct({ id: "wp-good" }),
      ],
    });
    expect(result.accepted).toBe(true);
    expect(result.acceptedWorkProductIds).toEqual(["wp-good"]);
  });
});
