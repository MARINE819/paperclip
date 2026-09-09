import { describe, expect, it } from "vitest";
import { buildKnowledgeProvenanceSnapshot } from "./knowledge.js";

describe("buildKnowledgeProvenanceSnapshot", () => {
  it("copies the generic and auxiliary provenance identities", () => {
    const operation = {
      id: "10000000-0000-4000-8000-000000000001",
      sourceType: "issue",
      sourceId: "NEX-42",
      sourceIssueId: "10000000-0000-4000-8000-000000000002",
      sourceRunId: "10000000-0000-4000-8000-000000000003",
      sourceAgentId: "10000000-0000-4000-8000-000000000004",
    };

    expect(buildKnowledgeProvenanceSnapshot(operation as never)).toMatchObject({
      sourceType: "issue",
      sourceId: "NEX-42",
      sourceIssueId: operation.sourceIssueId,
      sourceRunId: operation.sourceRunId,
      sourceAgentId: operation.sourceAgentId,
      memoryOperationId: operation.id,
    });
  });
});
