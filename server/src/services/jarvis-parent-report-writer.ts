import { issueComments, issues, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { issueService } from "./issues.js";
import {
  JARVIS_PARENT_REPORT_FINGERPRINT_LABEL,
  type JarvisParentReportProjection,
} from "./jarvis-parent-report-projector.js";

export type JarvisParentReportWriteResult =
  | { outcome: "created"; fingerprint: string; commentId: string }
  | { outcome: "deduplicated"; fingerprint: string; commentId: string };

export async function writeJarvisParentReport(
  db: Db,
  projection: JarvisParentReportProjection,
  actor: { agentId: string; runId?: string | null },
): Promise<JarvisParentReportWriteResult> {
  const canonical = projection.canonical;
  if (actor.agentId !== canonical.jarvisAgentId) throw new Error("jarvis_assignment_mismatch");

  return db.transaction(async (tx) => {
    const lockKey = `jarvis-parent-report:${canonical.companyId}:${canonical.parent.id}:${projection.fingerprint}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

    const [parent, child] = await Promise.all([
      tx.select({ id: issues.id, companyId: issues.companyId, assigneeAgentId: issues.assigneeAgentId })
        .from(issues).where(eq(issues.id, canonical.parent.id)).then((rows) => rows[0] ?? null),
      tx.select({ id: issues.id, companyId: issues.companyId, parentId: issues.parentId, assigneeAgentId: issues.assigneeAgentId })
        .from(issues).where(eq(issues.id, canonical.child.id)).then((rows) => rows[0] ?? null),
    ]);
    if (!parent || !child) throw new Error("issue_not_found");
    if (parent.companyId !== canonical.companyId || child.companyId !== canonical.companyId) throw new Error("company_mismatch");
    if (parent.assigneeAgentId !== canonical.jarvisAgentId || parent.assigneeAgentId !== canonical.parent.assigneeAgentId) throw new Error("jarvis_assignment_mismatch");
    if (child.parentId !== parent.id || child.parentId !== canonical.child.parentId) throw new Error("parent_mismatch");
    if (child.assigneeAgentId !== canonical.child.assigneeAgentId) throw new Error("child_assignment_mismatch");
    if (!canonical.acceptedPlan.childIssueIds.includes(child.id)) throw new Error("child_not_in_accepted_plan");

    const existing = await tx.select({ id: issueComments.id })
      .from(issueComments)
      .where(and(
        eq(issueComments.companyId, canonical.companyId),
        eq(issueComments.issueId, parent.id),
        sql<boolean>`${issueComments.metadata} @> ${JSON.stringify({
          version: 1,
          sections: [{ rows: [{ type: "key_value", label: JARVIS_PARENT_REPORT_FINGERPRINT_LABEL, value: projection.fingerprint }] }],
        })}::jsonb`,
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) return { outcome: "deduplicated", fingerprint: projection.fingerprint, commentId: existing.id };

    const comment = await issueService(db).addComment(
      parent.id,
      projection.body,
      actor,
      { authorType: "agent", metadata: projection.metadata, authorizationReason: "canonical_jarvis_parent_report" },
      tx,
    );
    return { outcome: "created", fingerprint: projection.fingerprint, commentId: comment.id };
  });
}
