/**
 * Evidence acceptance validation for the JARVIS Delegation Loop MVP
 * (docs/architecture/jarvis-delegation-loop-mvp-plan.md §5.6). This module
 * is deliberately DB-agnostic: it evaluates already-fetched work-product
 * rows (matching the shape of packages/shared's IssueWorkProduct /
 * issue_work_products) rather than querying the database itself. Wiring it
 * to the real workProductService (server/src/services/work-products.ts) is
 * integration work deferred to a follow-up slice.
 *
 * The rule this enforces, per the architecture docs: a filename or claim
 * mentioned only in a comment is never acceptable evidence. Because the
 * input to this module is already restricted to registered work-product
 * rows (not comment text), that rule is satisfied structurally by the
 * shape of the input — this module additionally checks that each work
 * product belongs to the correct child Issue, is not in a failed/archived
 * state, is not marked unhealthy, and resolves to an openable location
 * (a URL, an attachment content/open path, or a workspace_file resourceRef
 * path).
 */

export interface JarvisEvidenceCandidate {
  id: string;
  issueId: string;
  type: string;
  status: string;
  healthStatus: string;
  reviewState: string;
  url: string | null;
  metadata: Record<string, unknown> | null;
}

export interface JarvisEvidenceAcceptanceResult {
  accepted: boolean;
  acceptedWorkProductIds: string[];
  reasonCodes: string[];
  problems: string[];
}

const UNACCEPTABLE_STATUSES = new Set(["failed", "archived"]);

function resolvesToOpenableLocation(workProduct: JarvisEvidenceCandidate): boolean {
  const metadata = workProduct.metadata as
    | { resourceRef?: { kind?: string; path?: string }; contentPath?: string; openPath?: string }
    | null;
  const resourceRef = metadata?.resourceRef;
  if (resourceRef?.kind === "workspace_file") {
    return typeof resourceRef.path === "string" && resourceRef.path.trim().length > 0;
  }
  if (typeof workProduct.url === "string" && workProduct.url.trim().length > 0) return true;
  return Boolean(metadata?.contentPath || metadata?.openPath);
}

export function evaluateEvidenceAcceptance(input: {
  childIssueId: string;
  workProducts: JarvisEvidenceCandidate[];
}): JarvisEvidenceAcceptanceResult {
  const problems: string[] = [];
  const scoped = input.workProducts.filter((wp) => wp.issueId === input.childIssueId);
  const excludedCount = input.workProducts.length - scoped.length;
  if (excludedCount > 0) {
    problems.push(`${excludedCount} work product(s) belong to a different issue and were excluded from acceptance.`);
  }

  const accepted: JarvisEvidenceCandidate[] = [];
  for (const wp of scoped) {
    if (UNACCEPTABLE_STATUSES.has(wp.status)) {
      problems.push(`Work product ${wp.id} has status "${wp.status}" and cannot count as accepted evidence.`);
      continue;
    }
    if (wp.healthStatus === "unhealthy") {
      problems.push(`Work product ${wp.id} is unhealthy and cannot count as accepted evidence.`);
      continue;
    }
    if (!resolvesToOpenableLocation(wp)) {
      problems.push(`Work product ${wp.id} has no resolvable open location (no url, attachment path, or workspace_file resourceRef).`);
      continue;
    }
    accepted.push(wp);
  }

  return {
    accepted: accepted.length > 0,
    acceptedWorkProductIds: accepted.map((wp) => wp.id),
    reasonCodes:
      accepted.length > 0
        ? ["registered_work_product_present", "resolvable_location", "acceptable_health_and_status"]
        : ["no_acceptable_work_product"],
    problems,
  };
}
