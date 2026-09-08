import type { Db } from "@paperclipai/db";
import { getAgentWorkEligibility, type CreateIssueThreadInteraction } from "@paperclipai/shared";
import { issueService } from "./issues.js";
import { documentService } from "./documents.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { getAgentByIdForDelegation, listCompanyAgentsForDelegation } from "./jarvis-agent-directory.js";
import { selectDeterministicSpecialist, type JarvisAgentRejection } from "./jarvis-agent-selector.js";
import {
  JARVIS_DELEGATION_PLAN_SCHEMA_VERSION,
  assertSingleSpecialistPlan,
  validateDelegationPlan,
  type DelegationTask,
  type DelegationTaskClass,
} from "./jarvis-delegation-plan.js";
import { evaluateDelegationLimits, type DelegationLimitViolation } from "./jarvis-delegation-limits.js";
import { computeDelegationPlanFingerprint, computeJarvisIntakeFingerprint } from "./jarvis-idempotency.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";

/**
 * The submitToJarvis integration command
 * (docs/architecture/jarvis-delegation-loop-mvp-plan.md §5.1, §5.4) for the
 * Milestone 1 Paperclip-native single-specialist vertical slice
 * (docs/investigations/jarvis-delegation-loop-first-slice.md,
 * docs/investigations/jarvis-delegation-loop-integration-slice.md).
 *
 * This module deliberately does NOT import from server/src/app.ts,
 * server/src/services/index.ts, or server/src/services/heartbeat.ts, and is
 * not exported from any shared barrel — it is reachable only by direct
 * relative import, matching the precedent already set by the five JARVIS
 * foundation modules and by server/src/__tests__/heartbeat-risk-guard.test.ts
 * importing directly from ../services/heartbeat.ts. Route/UI registration
 * and terminal-event (child-completion) reconciliation are explicitly out of
 * scope for this slice; see docs/investigations/jarvis-delegation-loop-integration-slice.md
 * §2.9 and §4.2 for why those are deferred to a later, separately-approved
 * change.
 *
 * This orchestrator never creates an approval, never marks any Issue Done,
 * and never selects or fabricates an agent that was not present in the
 * caller-visible company agent list — those remain, respectively, Risk
 * Guard's job (already implemented in the untouched heartbeat.ts), the
 * assignee's own completion action, and selectDeterministicSpecialist's
 * structural guarantee.
 */

const PARENT_ISSUE_STATUS = "todo";
const CHILD_ISSUE_STATUS = "todo";
/** A direct child of the JARVIS-owned parent Issue is always exactly one level below it. */
const DEFAULT_DEPTH_BELOW_PARENT = 1;

export interface SubmitToJarvisPlanInput {
  objective: string;
  constraints?: string[];
  acceptanceCriteria: string[];
  evidenceRequirements: string[];
  reviewRequired?: boolean;
  taskClass: DelegationTaskClass;
  tasks: DelegationTask[];
  memoryRefs?: string[];
}

export interface SubmitToJarvisInput {
  companyId: string;
  /** The requesting Human actor. Structural validation only (non-empty, attributed on the created Issue) — session/authentication remains the HTTP route layer's responsibility. */
  requestedByUserId: string;
  jarvisAgentId: string;
  requestText: string;
  sourceType: string;
  sourceRef?: string | null;
  /** Client-supplied idempotency key; falls back to the computed intake fingerprint when omitted. */
  idempotencyKey?: string | null;
  plan: SubmitToJarvisPlanInput;
  /** Levels below the JARVIS-owned parent Issue this child would sit at. Defaults to 1 (a direct child); override only to exercise the delegation-depth guard. */
  depthBelowParent?: number;
}

export interface SubmitToJarvisDeps {
  /** Injected wakeup executor (normally backed by a live heartbeat service instance). Omit to skip triggering a live wakeup — this slice does not construct or import a heartbeat service itself. */
  wakeup?: IssueAssignmentWakeupDeps["wakeup"];
}

export type SubmitToJarvisRejectionReason =
  | "invalid_input"
  | "jarvis_not_found"
  | "jarvis_cross_company"
  | "jarvis_not_invokable"
  | "invalid_plan"
  | "plan_limits_violated"
  | "not_single_specialist"
  | "no_eligible_specialist";

export interface SubmitToJarvisFailure {
  ok: false;
  reason: SubmitToJarvisRejectionReason;
  detail: string;
  /** Present once a parent Issue was created or reused before the failure occurred, so the caller never loses track of a real, already-created Issue. */
  parentIssueId?: string;
  planErrors?: string[];
  limitViolations?: DelegationLimitViolation[];
  rejectedAgents?: JarvisAgentRejection[];
}

export interface SubmitToJarvisSuccess {
  ok: true;
  parentIssueId: string;
  parentIssueDeduplicated: boolean;
  childIssueId: string;
  parentBlockerAdded: boolean;
  selectedAgentId: string;
  intakeFingerprint: string;
  planFingerprint: string;
  reasonCodes: string[];
}

export type SubmitToJarvisResult = SubmitToJarvisSuccess | SubmitToJarvisFailure;

function deriveParentIssueTitle(requestText: string): string {
  const normalized = requestText.trim().replace(/\s+/g, " ");
  const MAX_TITLE_LENGTH = 200;
  return normalized.length > MAX_TITLE_LENGTH ? `${normalized.slice(0, MAX_TITLE_LENGTH - 1)}…` : normalized;
}

export async function submitToJarvis(
  db: Db,
  input: SubmitToJarvisInput,
  deps: SubmitToJarvisDeps = {},
): Promise<SubmitToJarvisResult> {
  const companyId = input.companyId?.trim();
  const requestedByUserId = input.requestedByUserId?.trim();
  const jarvisAgentId = input.jarvisAgentId?.trim();
  const requestText = input.requestText?.trim();

  if (!companyId) return { ok: false, reason: "invalid_input", detail: "companyId is required." };
  if (!requestedByUserId) return { ok: false, reason: "invalid_input", detail: "requestedByUserId is required." };
  if (!jarvisAgentId) return { ok: false, reason: "invalid_input", detail: "jarvisAgentId is required." };
  if (!requestText) return { ok: false, reason: "invalid_input", detail: "requestText is required." };
  if (!input.sourceType?.trim()) return { ok: false, reason: "invalid_input", detail: "sourceType is required." };

  // 2. Company, requesting-actor, and JARVIS identity boundaries.
  const companyAgents = await listCompanyAgentsForDelegation(db, companyId);
  const jarvisAgent =
    companyAgents.find((agent) => agent.id === jarvisAgentId) ?? (await getAgentByIdForDelegation(db, jarvisAgentId));
  if (!jarvisAgent) {
    return { ok: false, reason: "jarvis_not_found", detail: `No agent found with id ${jarvisAgentId}.` };
  }
  if (jarvisAgent.companyId !== companyId) {
    return {
      ok: false,
      reason: "jarvis_cross_company",
      detail: `JARVIS agent ${jarvisAgentId} belongs to company ${jarvisAgent.companyId}, not the requested company ${companyId}.`,
    };
  }
  const eligibilityContext = companyAgents.some((agent) => agent.id === jarvisAgentId)
    ? companyAgents
    : [...companyAgents, jarvisAgent];
  const jarvisEligibility = getAgentWorkEligibility({ agent: jarvisAgent, agents: eligibilityContext });
  if (!jarvisEligibility.invokable) {
    return {
      ok: false,
      reason: "jarvis_not_invokable",
      detail: `JARVIS agent is not invokable (${jarvisEligibility.invokabilityReason}).`,
    };
  }

  // 3. Request fingerprint.
  const intakeFingerprint = computeJarvisIntakeFingerprint({
    companyId,
    actorId: requestedByUserId,
    requestText,
    sourceType: input.sourceType,
    sourceRef: input.sourceRef ?? null,
  });

  // 4/5. Reuse the existing Issue idempotency mechanism (issueService.create's
  // idempotencyKey / issueCreateIdempotencyKeys) rather than a parallel store.
  const parentIdempotencyKey = input.idempotencyKey?.trim() || intakeFingerprint;
  let parentIssueDeduplicated = false;
  const parentIssue = await issueService(db).create(companyId, {
    title: deriveParentIssueTitle(requestText),
    description: requestText,
    status: PARENT_ISSUE_STATUS,
    assigneeAgentId: jarvisAgentId,
    createdByUserId: requestedByUserId,
    responsibleUserId: requestedByUserId,
    idempotencyKey: parentIdempotencyKey,
    onDeduplicated: () => {
      parentIssueDeduplicated = true;
    },
  });

  // 6. Build and validate the single-specialist DelegationPlan. parentIssueId
  // can only be known after the parent Issue exists, so it is filled in here
  // rather than accepted from the caller.
  const planValidation = validateDelegationPlan({
    version: JARVIS_DELEGATION_PLAN_SCHEMA_VERSION,
    parentIssueId: parentIssue.id,
    objective: input.plan.objective,
    constraints: input.plan.constraints ?? [],
    acceptanceCriteria: input.plan.acceptanceCriteria,
    evidenceRequirements: input.plan.evidenceRequirements,
    reviewRequired: input.plan.reviewRequired ?? false,
    taskClass: input.plan.taskClass,
    tasks: input.plan.tasks,
    memoryRefs: input.plan.memoryRefs ?? [],
  });
  if (!planValidation.ok || !planValidation.plan) {
    return {
      ok: false,
      reason: "invalid_plan",
      detail: "The delegation plan failed validation.",
      parentIssueId: parentIssue.id,
      planErrors: planValidation.errors,
    };
  }
  const plan = planValidation.plan;

  const limitViolations = evaluateDelegationLimits({
    depthBelowParent: input.depthBelowParent ?? DEFAULT_DEPTH_BELOW_PARENT,
    childCount: plan.tasks.length,
  });
  if (limitViolations.length > 0) {
    return {
      ok: false,
      reason: "plan_limits_violated",
      detail: limitViolations.map((violation) => violation.message).join(" "),
      parentIssueId: parentIssue.id,
      limitViolations,
    };
  }

  const singleSpecialistCheck = assertSingleSpecialistPlan(plan);
  if (!singleSpecialistCheck.ok) {
    return {
      ok: false,
      reason: "not_single_specialist",
      detail: singleSpecialistCheck.error ?? "Milestone 1 requires exactly one task.",
      parentIssueId: parentIssue.id,
    };
  }

  const planFingerprint = computeDelegationPlanFingerprint(plan);
  const task = plan.tasks[0]!;

  // 7. Deterministic, company-scoped, existing-agent selection.
  const selection = selectDeterministicSpecialist({
    companyId,
    jarvisAgentId,
    candidates: companyAgents,
    task: { requiredCapabilities: task.requiredCapabilities },
  });
  if (selection.blocked || !selection.selectedAgentId) {
    return {
      ok: false,
      reason: "no_eligible_specialist",
      detail: "No eligible existing specialist agent was found for this task. No agent was created automatically.",
      parentIssueId: parentIssue.id,
      rejectedAgents: selection.rejected,
    };
  }

  // 8/9/10. The Board-submitted plan is itself the Human approval boundary.
  // Persist it through Paperclip's canonical plan-document + accepted
  // request_confirmation contract, then use the existing accepted-plan
  // decomposition service to create and link the child. This makes completion
  // reconciliation authoritative instead of leaving an untracked child that
  // merely happens to share parentId.
  const documents = documentService(db);
  const planBody = JSON.stringify(plan, null, 2);
  const existingPlanDocument = await documents.getIssueDocumentByKey(parentIssue.id, "plan");
  const planDocumentResult = existingPlanDocument?.body === planBody
    ? { document: existingPlanDocument }
    : await documents.upsertIssueDocument({
        issueId: parentIssue.id,
        key: "plan",
        title: "JARVIS delegation plan",
        format: "json",
        body: planBody,
        changeSummary: "Board-submitted JARVIS delegation plan",
        baseRevisionId: existingPlanDocument?.latestRevisionId ?? null,
        createdByUserId: requestedByUserId,
      });
  const acceptedPlanRevisionId = planDocumentResult.document.latestRevisionId;
  if (!acceptedPlanRevisionId) {
    throw new Error("JARVIS delegation plan document has no current revision");
  }

  const interactions = issueThreadInteractionService(db);
  const confirmationRequest = {
    kind: "request_confirmation",
    idempotencyKey: `jarvis-plan-approval:${planFingerprint}`,
    title: "Approve JARVIS delegation plan",
    summary: "The Human-submitted JARVIS plan is recorded as the accepted execution plan.",
    continuationPolicy: "none",
    payload: {
      version: 1,
      prompt: "Approve this JARVIS delegation plan?",
      target: {
        type: "issue_document",
        issueId: parentIssue.id,
        documentId: planDocumentResult.document.id,
        key: "plan",
        revisionId: acceptedPlanRevisionId,
        revisionNumber: planDocumentResult.document.latestRevisionNumber,
      },
    },
  } as unknown as CreateIssueThreadInteraction;
  const confirmation = await interactions.create(
    { id: parentIssue.id, companyId },
    confirmationRequest,
    { userId: requestedByUserId },
  );
  if (confirmation.status === "pending") {
    await interactions.acceptInteraction(
      {
        id: parentIssue.id,
        companyId,
        projectId: parentIssue.projectId ?? null,
        goalId: parentIssue.goalId ?? null,
        status: parentIssue.status,
      },
      confirmation.id,
      {},
      { userId: requestedByUserId },
    );
  }

  const decomposition = await issueService(db).decomposeAcceptedPlan(parentIssue.id, {
    acceptedPlanRevisionId,
    actorUserId: requestedByUserId,
    children: [{
      title: task.title,
      description: task.instructions,
      status: CHILD_ISSUE_STATUS,
      assigneeAgentId: selection.selectedAgentId,
      acceptanceCriteria: plan.acceptanceCriteria,
      blockParentUntilDone: true,
      idempotencyKey: planFingerprint,
    }],
  });
  const childIssue = decomposition.childIssues[0];
  if (!childIssue) throw new Error("Accepted JARVIS delegation plan did not produce a child Issue");

  // Best-effort live wakeup. This slice does not construct or import a
  // heartbeat service (server/src/services/heartbeat.ts is contended and
  // untouched); a real wakeup executor must be injected by whichever future,
  // separately-approved slice wires this command to live route/app
  // registration. Without an injected executor, the child Issue is still
  // correctly created and assigned — it simply is not yet woken by this call.
  if (deps.wakeup) {
    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup: deps.wakeup },
      issue: { id: childIssue.id, assigneeAgentId: selection.selectedAgentId, status: CHILD_ISSUE_STATUS },
      reason: "jarvis_delegation_child_assigned",
      mutation: "jarvis_delegation_child_created",
      contextSource: "jarvis_delegation_orchestrator",
      requestedByActorType: "agent",
      requestedByActorId: jarvisAgentId,
    });
  }

  // 11. Structured result with canonical Paperclip identifiers only — never
  // a fabricated approval, evidence, or completion state.
  return {
    ok: true,
    parentIssueId: parentIssue.id,
    parentIssueDeduplicated,
    childIssueId: childIssue.id,
    parentBlockerAdded: true,
    selectedAgentId: selection.selectedAgentId,
    intakeFingerprint,
    planFingerprint,
    reasonCodes: [
      parentIssueDeduplicated ? "parent_issue_reused" : "parent_issue_created",
      ...selection.reasonCodes,
      "child_issue_created",
      "accepted_plan_recorded",
      "parent_blocked_until_child_done",
    ],
  };
}
