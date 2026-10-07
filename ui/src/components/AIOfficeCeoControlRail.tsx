import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent, Approval, Issue, IssueComment } from "@paperclipai/shared";
import { Check, CheckCircle2, ExternalLink, FileCheck, RefreshCw, RotateCcw, ShieldAlert, X } from "lucide-react";
import { approvalsApi } from "@/api/approvals";
import { issuesApi } from "@/api/issues";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { SeatBadge } from "@/components/AIOfficeFloor";
import { DecisionQueueRail } from "@/components/DecisionQueueRail";
import { ActivityFeed } from "@/components/ActivityFeed";

export interface AIOfficeCeoControlRailProps {
  companyId: string;
  // Pending & Revision Requested Approvals
  allPendingApprovals: Approval[];
  isApprovalsLoading?: boolean;
  approvalsErrorMessage?: string | null;
  // In-Review Issues
  inReviewIssues: Issue[];
  isInReviewLoading?: boolean;
  inReviewErrorMessage?: string | null;
  // Completed Issues
  completedIssues: Issue[];
  isCompletedLoading?: boolean;
  completedErrorMessage?: string | null;
  // Blocker / Offline Agents
  blockedOrOfflineAgents: Array<{ agent: Agent; condition: "error" | "offline" }>;
  isAgentsLoading?: boolean;
  agentsErrorMessage?: string | null;
  // Mappings & Lookup
  agents: Agent[];
  jarvisReportCommentByIssueId?: Map<string, IssueComment>;
  // Callbacks
  onSelectAgent: (agentId: string) => void;
  className?: string;
}

export function AIOfficeCeoControlRail({
  companyId,
  allPendingApprovals,
  isApprovalsLoading = false,
  approvalsErrorMessage = null,
  inReviewIssues,
  isInReviewLoading = false,
  inReviewErrorMessage = null,
  completedIssues,
  isCompletedLoading = false,
  completedErrorMessage = null,
  blockedOrOfflineAgents,
  isAgentsLoading = false,
  agentsErrorMessage = null,
  agents,
  jarvisReportCommentByIssueId,
  onSelectAgent,
  className = "space-y-4 lg:col-span-1",
}: AIOfficeCeoControlRailProps) {
  const queryClient = useQueryClient();

  // State for Review/Note Dialogs
  const [selectedApproval, setSelectedApproval] = useState<Approval | null>(null);
  const [approvalNote, setApprovalNote] = useState("");
  const [reworkIssue, setReworkIssue] = useState<Issue | null>(null);
  const [reworkComment, setReworkComment] = useState("");

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  // Approval Invalidation helper
  const invalidateApprovals = () => {
    queryClient.invalidateQueries({ queryKey: ["ai-office-2d-approvals-pending"] });
    queryClient.invalidateQueries({ queryKey: ["ai-office-2d-approvals-revision-requested"] });
    queryClient.invalidateQueries({ queryKey: ["ai-office-2d-agents"] });
    queryClient.invalidateQueries({ queryKey: ["approvals"] });
  };

  // Issue Invalidation helper
  const invalidateIssues = () => {
    queryClient.invalidateQueries({ queryKey: ["ai-office-2d-issues-in-review"] });
    queryClient.invalidateQueries({ queryKey: ["ai-office-2d-issues-completed"] });
    queryClient.invalidateQueries({ queryKey: ["ai-office-2d-agents"] });
    queryClient.invalidateQueries({ queryKey: ["issues"] });
  };

  // Approval Mutations
  const approveMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => approvalsApi.approve(id, note),
    onSuccess: () => {
      setSelectedApproval(null);
      setApprovalNote("");
      invalidateApprovals();
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => approvalsApi.reject(id, note),
    onSuccess: () => {
      setSelectedApproval(null);
      setApprovalNote("");
      invalidateApprovals();
    },
  });

  const requestRevisionMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => approvalsApi.requestRevision(id, note),
    onSuccess: () => {
      setSelectedApproval(null);
      setApprovalNote("");
      invalidateApprovals();
    },
  });

  // Issue In-Review Mutations
  const acceptIssueMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => issuesApi.update(id, { status: "done" }),
    onSuccess: () => {
      invalidateIssues();
    },
  });

  const reworkIssueMutation = useMutation({
    mutationFn: ({ id, comment }: { id: string; comment: string }) =>
      issuesApi.update(id, { status: "todo", comment }),
    onSuccess: () => {
      setReworkIssue(null);
      setReworkComment("");
      invalidateIssues();
    },
  });

  return (
    <aside className={className} data-testid="ai-office-ceo-control-rail">
      {/* 1. 검토 대기 (In-Review) 큐 */}
      <Card data-testid="desktop-in-review-card">
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5">
              <FileCheck className="h-4 w-4 text-sky-600 dark:text-sky-400" />
              검토 대기 (In-Review) ({inReviewIssues.length}건)
            </span>
            <a href="/issues?status=in_review" className="text-xs font-normal text-primary hover:underline">
              전체 →
            </a>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-xs">
          {isInReviewLoading ? (
            <span className="text-muted-foreground">검토 데이터 로딩 중</span>
          ) : inReviewErrorMessage ? (
            <span className="text-destructive">검토 데이터 조회 실패: {inReviewErrorMessage}</span>
          ) : inReviewIssues.length === 0 ? (
            <span className="text-muted-foreground">검토 대기 중인 업무 없음</span>
          ) : (
            inReviewIssues.map((issue) => {
              const assignee = issue.assigneeAgentId
                ? agentById.get(issue.assigneeAgentId)?.name ?? issue.assigneeAgentId
                : "미배정";
              const reportComment = jarvisReportCommentByIssueId?.get(issue.id);
              const isJarvisReport = Boolean(reportComment);
              const targetUrl = isJarvisReport && reportComment
                ? `/issues/${issue.id}#comment-${reportComment.id}`
                : `/issues/${issue.id}`;

              return (
                <div
                  key={issue.id}
                  className={`flex flex-col gap-1.5 rounded-md border p-2.5 transition-colors ${
                    isJarvisReport
                      ? "border-primary/40 bg-primary/5 hover:bg-primary/10"
                      : "border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10"
                  }`}
                >
                  <a
                    key={issue.id}
                    href={targetUrl}
                    className="flex flex-col gap-1 rounded-md transition-colors"
                    data-testid={`desktop-in-review-item-${issue.id}`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-semibold text-foreground truncate">
                        {issue.identifier ? `${issue.identifier} ` : ""}{issue.title}
                      </span>
                      {isJarvisReport ? (
                        <span
                          className="shrink-0 rounded bg-primary/20 px-1.5 py-0.5 text-xs font-medium text-primary"
                          data-testid={`desktop-jarvis-report-badge-${issue.id}`}
                        >
                          JARVIS 최종 보고
                        </span>
                      ) : (
                        <span className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                          검토 대기
                        </span>
                      )}
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>담당: {assignee}</span>
                      <span className="text-primary hover:underline">
                        {isJarvisReport ? "최종 보고서 확인 →" : "이슈 열기 →"}
                      </span>
                    </div>
                  </a>

                  {/* CEO 검토 액션 버튼 (승인 채택 / 재작업 지시) */}
                  <div className="flex items-center justify-end gap-1.5 border-t pt-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      onClick={() => {
                        setReworkIssue(issue);
                        setReworkComment("");
                      }}
                      data-testid={`desktop-in-review-rework-btn-${issue.id}`}
                    >
                      <RotateCcw className="mr-1 h-3 w-3 text-muted-foreground" />
                      재작업 지시
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="default"
                      className="h-7 px-2 text-xs font-semibold"
                      disabled={acceptIssueMutation.isPending}
                      onClick={() => acceptIssueMutation.mutate({ id: issue.id })}
                      data-testid={`desktop-in-review-accept-btn-${issue.id}`}
                    >
                      <Check className="mr-1 h-3 w-3" />
                      승인 채택 (Done)
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* 2. 승인 대기 (Pending Approvals) 큐 */}
      <Card data-testid="desktop-pending-approvals-card">
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-sm">
            <span>승인 대기 ({allPendingApprovals.length}건)</span>
            <a href="/mobile/approvals" className="text-xs font-normal text-primary hover:underline">
              결재 콘솔 →
            </a>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-xs">
          {isApprovalsLoading ? (
            <span className="text-muted-foreground">승인 데이터 로딩 중</span>
          ) : approvalsErrorMessage ? (
            <span className="text-destructive">승인 데이터 조회 실패: {approvalsErrorMessage}</span>
          ) : allPendingApprovals.length === 0 ? (
            <span className="text-muted-foreground">대기 중인 승인 없음</span>
          ) : (
            allPendingApprovals.map((approval) => {
              const requester = approval.requestedByAgentId
                ? agentById.get(approval.requestedByAgentId)?.name ?? approval.requestedByAgentId
                : "시스템/운영자";
              const isRevision = approval.status === "revision_requested";

              return (
                <div
                  key={approval.id}
                  className="flex flex-col gap-1.5 border-t pt-2 first:border-t-0 first:pt-0"
                >
                  <a
                    href="/mobile/approvals"
                    className="flex items-center justify-between hover:underline rounded p-1 -mx-1 transition-colors"
                    data-testid={`desktop-approval-item-${approval.id}`}
                  >
                    <span className="font-medium text-foreground">
                      {approval.type}
                      {isRevision ? (
                        <span className="ml-1 text-xs text-amber-600 dark:text-amber-400 font-normal">
                          (수정 요청)
                        </span>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground">요청: {requester}</span>
                  </a>

                  <div className="flex items-center justify-between gap-1 border-t pt-1">
                    <span className="font-mono text-muted-foreground text-xs">ID: {approval.id.slice(0, 8)}</span>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-6 px-1.5 text-xs"
                        onClick={() => {
                          setSelectedApproval(approval);
                          setApprovalNote("");
                        }}
                        data-testid={`desktop-approval-review-btn-${approval.id}`}
                      >
                        신속 검토
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-6 px-1.5 text-xs text-amber-600 dark:text-amber-400 hover:text-amber-700"
                        onClick={() => {
                          setSelectedApproval(approval);
                          setApprovalNote("");
                        }}
                        data-testid={`desktop-approval-request-revision-${approval.id}`}
                      >
                        수정 요청
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        className="h-6 px-1.5 text-xs"
                        disabled={rejectMutation.isPending}
                        onClick={() => rejectMutation.mutate({ id: approval.id })}
                        data-testid={`desktop-approval-quick-reject-${approval.id}`}
                      >
                        반려
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="default"
                        className="h-6 px-1.5 text-xs font-semibold"
                        disabled={approveMutation.isPending}
                        onClick={() => approveMutation.mutate({ id: approval.id })}
                        data-testid={`desktop-approval-quick-approve-${approval.id}`}
                      >
                        승인
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* 3. 리스크 가드 & 블로커 센터 */}
      <Card data-testid="desktop-blocker-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5 text-sm">
            <ShieldAlert className="h-4 w-4" /> 블로커 센터
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-xs">
          {isAgentsLoading ? (
            <span className="text-muted-foreground">에이전트 상태 로딩 중</span>
          ) : agentsErrorMessage ? (
            <span className="text-destructive">에이전트 데이터 조회 실패: {agentsErrorMessage}</span>
          ) : blockedOrOfflineAgents.length === 0 ? (
            <span className="text-muted-foreground">차단/오프라인 에이전트 없음</span>
          ) : (
            blockedOrOfflineAgents.map(({ agent, condition }) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => onSelectAgent(agent.id)}
                className="flex w-full items-center justify-between gap-2 border-t pt-2 first:border-t-0 first:pt-0 text-left hover:bg-muted/40 rounded p-1 -mx-1 transition-colors"
                data-testid={`desktop-blocker-item-${agent.id}`}
              >
                <span className="truncate font-medium">{agent.name}</span>
                <SeatBadge state={condition === "error" ? "blocked-error" : "offline"} />
              </button>
            ))
          )}
        </CardContent>
      </Card>

      {/* 4. 최근 완료 업무 & 보고서 */}
      <Card data-testid="desktop-completed-card">
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-sm">
            <span>최근 완료 업무 ({completedIssues.length}건)</span>
            <a href="/issues?status=done" className="text-xs font-normal text-primary hover:underline">
              전체 →
            </a>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-xs">
          {isCompletedLoading ? (
            <span className="text-muted-foreground">완료 데이터 로딩 중</span>
          ) : completedErrorMessage ? (
            <span className="text-destructive">완료 데이터 조회 실패: {completedErrorMessage}</span>
          ) : completedIssues.length === 0 ? (
            <span className="text-muted-foreground">완료된 업무 없음</span>
          ) : (
            completedIssues.slice(0, 3).map((issue) => {
              const reportComment = jarvisReportCommentByIssueId?.get(issue.id);
              return (
                <a
                  key={issue.id}
                  href={reportComment ? `/issues/${issue.id}#comment-${reportComment.id}` : `/issues/${issue.id}`}
                  className="flex items-center justify-between gap-2 border-t pt-2 first:border-t-0 first:pt-0 hover:bg-muted/40 rounded p-1 -mx-1 transition-colors"
                  data-testid={`desktop-completed-item-${issue.id}`}
                >
                  <span className="truncate font-medium">
                    {issue.identifier ? `${issue.identifier}: ` : ""}{issue.title}
                  </span>
                  <span className="shrink-0 text-xs text-primary">보고서/산출물 →</span>
                </a>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* 5. CEO 의사결정 큐 (Decision Queue Rail) */}
      {companyId ? <DecisionQueueRail companyId={companyId} /> : null}

      {/* 6. 최근 활동 피드 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">최근 활동</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ActivityFeed className="max-h-80 overflow-auto p-3" />
        </CardContent>
      </Card>

      {/* 결재 상세 검토 및 의견 입력 다이얼로그 */}
      <Dialog open={selectedApproval !== null} onOpenChange={(open) => { if (!open) setSelectedApproval(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>결재 신속 검토</DialogTitle>
            <DialogDescription>
              결재 내용과 사유를 확인하고 승인, 반려 또는 수정 요청 결정을 내립니다.
            </DialogDescription>
          </DialogHeader>

          {selectedApproval ? (
            <div className="space-y-3 py-2 text-xs">
              <div className="rounded-md border bg-muted/20 p-2.5 space-y-1">
                <div className="flex justify-between">
                  <span className="font-semibold">{selectedApproval.type}</span>
                  <span className="font-mono text-muted-foreground">ID: {selectedApproval.id.slice(0, 8)}</span>
                </div>
                <div className="text-muted-foreground">
                  요청자:{" "}
                  {selectedApproval.requestedByAgentId
                    ? agentById.get(selectedApproval.requestedByAgentId)?.name ?? selectedApproval.requestedByAgentId
                    : "시스템/운영자"}
                </div>
                <div className="text-muted-foreground">
                  생성 시각: {new Date(selectedApproval.createdAt).toLocaleString()}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="font-semibold text-foreground">결재 사유 / 지시 사항 (선택)</label>
                <Textarea
                  value={approvalNote}
                  onChange={(e) => setApprovalNote(e.target.value)}
                  placeholder="승인 또는 반려, 수정 요청 사유를 작성하세요."
                  className="text-xs min-h-20"
                  data-testid="desktop-approval-note-input"
                />
              </div>

              {approveMutation.isError ? (
                <span className="text-destructive">승인 요청 처리 실패: 다시 시도하십시오.</span>
              ) : null}
              {rejectMutation.isError ? (
                <span className="text-destructive">반려 요청 처리 실패: 다시 시도하십시오.</span>
              ) : null}
              {requestRevisionMutation.isError ? (
                <span className="text-destructive">수정 요청 처리 실패: 다시 시도하십시오.</span>
              ) : null}
            </div>
          ) : null}

          <DialogFooter className="flex flex-col sm:flex-row gap-1.5 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => setSelectedApproval(null)}
            >
              닫기
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs text-amber-600 dark:text-amber-400 hover:text-amber-700"
              disabled={requestRevisionMutation.isPending || !selectedApproval}
              onClick={() => {
                if (selectedApproval) {
                  requestRevisionMutation.mutate({ id: selectedApproval.id, note: approvalNote });
                }
              }}
              data-testid="desktop-modal-request-revision-btn"
            >
              수정 요청 (Revision)
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="text-xs"
              disabled={rejectMutation.isPending || !selectedApproval}
              onClick={() => {
                if (selectedApproval) {
                  rejectMutation.mutate({ id: selectedApproval.id, note: approvalNote });
                }
              }}
              data-testid="desktop-modal-reject-btn"
            >
              반려 (Reject)
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              className="text-xs font-semibold"
              disabled={approveMutation.isPending || !selectedApproval}
              onClick={() => {
                if (selectedApproval) {
                  approveMutation.mutate({ id: selectedApproval.id, note: approvalNote });
                }
              }}
              data-testid="desktop-modal-approve-btn"
            >
              승인 (Approve)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 업무 재작업 지시 다이얼로그 */}
      <Dialog open={reworkIssue !== null} onOpenChange={(open) => { if (!open) setReworkIssue(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>업무 재작업 지시 (Rework)</DialogTitle>
            <DialogDescription>
              담당 에이전트에게 업무를 다시 todo 상태로 넘기며 보완할 지시 사항을 전달합니다.
            </DialogDescription>
          </DialogHeader>

          {reworkIssue ? (
            <div className="space-y-3 py-2 text-xs">
              <div className="rounded-md border bg-muted/20 p-2.5 space-y-1">
                <div className="font-semibold text-foreground">
                  {reworkIssue.identifier ? `${reworkIssue.identifier} ` : ""}{reworkIssue.title}
                </div>
                <div className="text-muted-foreground">
                  담당: {reworkIssue.assigneeAgentId
                    ? agentById.get(reworkIssue.assigneeAgentId)?.name ?? reworkIssue.assigneeAgentId
                    : "미배정"}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="font-semibold text-foreground">재작업 지시 사항 (코멘트)</label>
                <Textarea
                  value={reworkComment}
                  onChange={(e) => setReworkComment(e.target.value)}
                  placeholder="보완 또는 수정해야 할 구체적인 내용을 입력하세요."
                  className="text-xs min-h-24"
                  data-testid="desktop-rework-comment-input"
                />
              </div>

              {reworkIssueMutation.isError ? (
                <span className="text-destructive">재작업 지시 처리 실패: 다시 시도하십시오.</span>
              ) : null}
            </div>
          ) : null}

          <DialogFooter className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => setReworkIssue(null)}
            >
              취소
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              className="text-xs font-semibold"
              disabled={reworkIssueMutation.isPending || !reworkIssue}
              onClick={() => {
                if (reworkIssue) {
                  reworkIssueMutation.mutate({ id: reworkIssue.id, comment: reworkComment });
                }
              }}
              data-testid="desktop-modal-submit-rework-btn"
            >
              재작업 지시 전달
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
