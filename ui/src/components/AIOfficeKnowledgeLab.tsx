import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookOpen,
  Brain,
  CheckCircle2,
  Clock,
  FileText,
  HelpCircle,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  XCircle,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn, formatDate, relativeTime } from "@/lib/utils";
import { describeApiError } from "@/api/client";
import {
  knowledgeApi,
  type MemoryOperationItem,
  type KnowledgeRecordItem,
  type MemoryReviewState,
  type MemoryOperationStatus,
  type KnowledgeSyncState,
} from "@/api/knowledge";

interface AIOfficeKnowledgeLabProps {
  companyId?: string;
}

/**
 * Sanitizes server-provided sync error messages to ensure no internal stack
 * traces, absolute filesystem paths, or sensitive tokens are rendered in the UI.
 */
function sanitizeSyncError(raw?: string | null): string {
  if (!raw) return "알 수 없는 동기화 오류";
  // Remove absolute Windows and Unix paths
  let cleaned = raw.replace(/[a-zA-Z]:\\[^:\n\r\t]+|\/(?:Users|home|tmp|var|etc)\/[^\s:]+/g, "[시스템 경로]");
  // Remove JavaScript stack traces
  cleaned = cleaned.split(/\n\s*at\s+/)[0] ?? cleaned;
  // Mask potential API keys/tokens
  cleaned = cleaned.replace(/(?:sk-|bearer\s+|key=)[a-zA-Z0-9_-]{8,}/gi, "[비밀값 마스킹]");
  return cleaned.trim();
}

function ReviewStateBadge({ state, status }: { state: MemoryReviewState; status: MemoryOperationStatus }) {
  if (status === "promoted") {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400">
        <Sparkles className="h-3 w-3" /> 승격 완료
      </span>
    );
  }
  if (state === "approved") {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" /> 검토 승인
      </span>
    );
  }
  if (state === "rejected" || status === "rejected") {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-destructive/20 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
        <XCircle className="h-3 w-3" /> 후보 반려
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
      <Clock className="h-3 w-3" /> 검토 대기
    </span>
  );
}

function SyncStateBadge({
  state,
  backendId,
}: {
  state: KnowledgeSyncState | null | undefined;
  backendId?: string | null;
}) {
  const backendLabel = backendId || "지식 백엔드";
  if (state === "synced") {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
        <ShieldCheck className="h-3 w-3" /> 동기화 완료 ({backendLabel})
      </span>
    );
  }
  if (state === "pending") {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
        <Clock className="h-3 w-3" /> 저장 대기 (F-07)
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-destructive/20 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
        <ShieldAlert className="h-3 w-3" /> 동기화 실패
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      <HelpCircle className="h-3 w-3" /> 미동기화
    </span>
  );
}

function SourceTypeBadge({ type }: { type: string }) {
  return (
    <span className="inline-flex items-center rounded border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
      {type}
    </span>
  );
}

function ConfidenceBadge({ confidence }: { confidence: number | null }) {
  if (confidence === null || confidence === undefined) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const pct = Math.round(confidence * 100);
  const colorClass =
    pct >= 80
      ? "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
      : pct >= 50
        ? "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20"
        : "text-muted-foreground bg-muted border-border";

  return (
    <span className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium", colorClass)}>
      {pct}%
    </span>
  );
}

export function AIOfficeKnowledgeLab({ companyId }: AIOfficeKnowledgeLabProps) {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"candidates" | "records">("candidates");
  const [candidateFilter, setCandidateFilter] = useState<"all" | "pending" | "approved" | "promoted" | "rejected">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [recordSyncFilter, setRecordSyncFilter] = useState<"all" | "synced" | "pending" | "failed">("all");

  // Dialog states
  const [selectedCandidate, setSelectedCandidate] = useState<MemoryOperationItem | null>(null);
  const [promotingCandidate, setPromotingCandidate] = useState<MemoryOperationItem | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<KnowledgeRecordItem | null>(null);

  // Form inputs for review / promote
  const [reviewNotes, setReviewNotes] = useState("");
  const [promoteTitle, setPromoteTitle] = useState("");
  const [promoteType, setPromoteType] = useState("architecture");
  const [promoteSummary, setPromoteSummary] = useState("");
  const [promoteBody, setPromoteBody] = useState("");

  const effectiveCompanyId = companyId ?? "";

  // 1. Memory Operations query
  const candidatesQuery = useQuery({
    queryKey: ["knowledge-memory-operations", effectiveCompanyId],
    queryFn: () => knowledgeApi.listMemoryOperations(effectiveCompanyId),
    enabled: !!effectiveCompanyId,
    retry: false,
  });

  // 2. Knowledge Records query
  const recordsQuery = useQuery({
    queryKey: ["knowledge-records", effectiveCompanyId, searchQuery],
    queryFn: () => knowledgeApi.listKnowledgeRecords(effectiveCompanyId, { q: searchQuery.trim() || undefined }),
    enabled: !!effectiveCompanyId,
    retry: false,
  });

  const memoryOperations = candidatesQuery.data ?? [];
  const knowledgeRecords = recordsQuery.data ?? [];

  // Summary counts
  const summaryCounts = useMemo(() => {
    const totalCandidates = memoryOperations.length;
    const pendingReview = memoryOperations.filter((m) => m.reviewState === "pending").length;
    const approvedCandidates = memoryOperations.filter((m) => m.reviewState === "approved" && m.status === "candidate").length;
    const totalRecords = knowledgeRecords.length;
    const syncFailures = knowledgeRecords.filter(
      (r) => r.externalSyncState === "failed" || r.obsidianSyncState === "failed",
    ).length;

    return {
      totalCandidates,
      pendingReview,
      approvedCandidates,
      totalRecords,
      syncFailures,
    };
  }, [memoryOperations, knowledgeRecords]);

  // Filtered memory operations
  const filteredCandidates = useMemo(() => {
    return memoryOperations.filter((op) => {
      if (candidateFilter === "pending" && op.reviewState !== "pending") return false;
      if (candidateFilter === "approved" && (op.reviewState !== "approved" || op.status === "promoted")) return false;
      if (candidateFilter === "promoted" && op.status !== "promoted") return false;
      if (candidateFilter === "rejected" && op.reviewState !== "rejected" && op.status !== "rejected") return false;

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesTitle = op.title?.toLowerCase().includes(q);
        const matchesSummary = op.summary?.toLowerCase().includes(q);
        const matchesContent = op.content.toLowerCase().includes(q);
        const matchesSource = op.sourceType.toLowerCase().includes(q) || op.sourceId.toLowerCase().includes(q);
        if (!matchesTitle && !matchesSummary && !matchesContent && !matchesSource) return false;
      }
      return true;
    });
  }, [memoryOperations, candidateFilter, searchQuery]);

  // Filtered knowledge records
  const filteredRecords = useMemo(() => {
    return knowledgeRecords.filter((rec) => {
      const syncState = rec.externalSyncState ?? rec.obsidianSyncState;
      if (recordSyncFilter === "synced" && syncState !== "synced") return false;
      if (recordSyncFilter === "pending" && syncState !== "pending") return false;
      if (recordSyncFilter === "failed" && syncState !== "failed") return false;
      return true;
    });
  }, [knowledgeRecords, recordSyncFilter]);

  // Refresh all data
  const handleRefresh = () => {
    void candidatesQuery.refetch();
    void recordsQuery.refetch();
  };

  // Mutations
  const reviewMutation = useMutation({
    mutationFn: ({ id, reviewState, reviewNotes }: { id: string; reviewState: "approved" | "rejected"; reviewNotes?: string }) =>
      knowledgeApi.reviewMemoryOperation(id, { reviewState, reviewNotes }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["knowledge-memory-operations", effectiveCompanyId] });
      setSelectedCandidate(null);
      setReviewNotes("");
    },
  });

  const promoteMutation = useMutation({
    mutationFn: ({ id, params }: { id: string; params: { title?: string; knowledgeType?: string; summary?: string; body?: string } }) =>
      knowledgeApi.promoteMemoryOperation(id, params),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["knowledge-memory-operations", effectiveCompanyId] });
      void queryClient.invalidateQueries({ queryKey: ["knowledge-records", effectiveCompanyId] });
      setPromotingCandidate(null);
      setSelectedCandidate(null);
    },
  });

  const syncMutation = useMutation({
    mutationFn: (recordId: string) => knowledgeApi.syncKnowledgeRecord(recordId),
    onSuccess: (updatedRecord) => {
      void queryClient.invalidateQueries({ queryKey: ["knowledge-records", effectiveCompanyId] });
      if (selectedRecord && selectedRecord.id === updatedRecord.id) {
        setSelectedRecord(updatedRecord);
      }
    },
  });

  const isMutating = reviewMutation.isPending || promoteMutation.isPending || syncMutation.isPending;

  // Open review modal
  const openReviewModal = (op: MemoryOperationItem) => {
    setSelectedCandidate(op);
    setReviewNotes(op.reviewNotes ?? "");
  };

  // Open promote modal (requires reviewState === "approved")
  const openPromoteModal = (op: MemoryOperationItem) => {
    setPromotingCandidate(op);
    setPromoteTitle(op.title ?? (op.summary ? op.summary.slice(0, 60) : "사내 공식 지식"));
    setPromoteType("architecture");
    setPromoteSummary(op.summary ?? "");
    setPromoteBody(op.content);
  };

  return (
    <Card className="space-y-4 p-4" data-testid="ai-office-knowledge-lab">
      {/* 1. Header */}
      <div className="flex flex-col gap-2 border-b pb-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
            <Brain className="h-5 w-5 text-primary" />
            Control Center — Knowledge & Memory (F-07 / F-08)
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            출처 추적성(Provenance)이 보장된 에이전트 지식 추출 파이프라인 및 사내 공식 지식 베이스(SSOT) 관제 센터입니다.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={candidatesQuery.isFetching || recordsQuery.isFetching || isMutating}
            data-testid="knowledge-refresh-btn"
          >
            <RefreshCw className={cn("h-4 w-4", (candidatesQuery.isFetching || recordsQuery.isFetching) && "animate-spin")} />
            새로고침
          </Button>
        </div>
      </div>

      {/* API Error Callout */}
      {candidatesQuery.isError || recordsQuery.isError ? (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          지식 데이터 조회 실패:{" "}
          {describeApiError(candidatesQuery.error ?? recordsQuery.error, "서버와의 통신에 실패했습니다.")}
        </div>
      ) : null}

      {/* 2. Top Summary KPI Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5" aria-label="Knowledge summary metrics">
        <div className="rounded-lg border bg-card p-3 shadow-xs">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>후보 메모리</span>
            <FileText className="h-4 w-4 text-primary" />
          </div>
          <div className="mt-1 text-lg font-semibold text-foreground" data-testid="summary-total-candidates">
            {summaryCounts.totalCandidates}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">이슈/런에서 자동 추출</p>
        </div>

        <div className="rounded-lg border bg-card p-3 shadow-xs">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>검토 대기</span>
            <Clock className="h-4 w-4 text-amber-500" />
          </div>
          <div className="mt-1 text-lg font-semibold text-amber-600 dark:text-amber-400" data-testid="summary-pending-review">
            {summaryCounts.pendingReview}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">인간 CEO 승인 대기</p>
        </div>

        <div className="rounded-lg border bg-card p-3 shadow-xs">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>승격 대기</span>
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          </div>
          <div className="mt-1 text-lg font-semibold text-emerald-600 dark:text-emerald-400" data-testid="summary-approved-candidates">
            {summaryCounts.approvedCandidates}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">검토 완료 승격 가능</p>
        </div>

        <div className="rounded-lg border bg-card p-3 shadow-xs">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>공식 사내 지식</span>
            <BookOpen className="h-4 w-4 text-blue-500" />
          </div>
          <div className="mt-1 text-lg font-semibold text-blue-600 dark:text-blue-400" data-testid="summary-total-records">
            {summaryCounts.totalRecords}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">정규 지식 레코드</p>
        </div>

        <div className="rounded-lg border bg-card p-3 shadow-xs">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>동기화 오류</span>
            <AlertTriangle className="h-4 w-4 text-destructive" />
          </div>
          <div className="mt-1 text-lg font-semibold text-destructive" data-testid="summary-sync-failures">
            {summaryCounts.syncFailures}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">외부 백엔드 저장 실패</p>
        </div>
      </div>

      {/* 3. Sub-Tab Switching Navigation */}
      <div className="flex border-b">
        <button
          type="button"
          onClick={() => setActiveTab("candidates")}
          className={cn(
            "flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors",
            activeTab === "candidates"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
          data-testid="tab-candidates-btn"
        >
          <Brain className="h-4 w-4" />
          메모리 후보군 ({summaryCounts.totalCandidates})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("records")}
          className={cn(
            "flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors",
            activeTab === "records"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
          data-testid="tab-records-btn"
        >
          <BookOpen className="h-4 w-4" />
          공식 사내 지식 ({summaryCounts.totalRecords})
        </button>
      </div>

      {/* 4. Tab Content: Candidates */}
      {activeTab === "candidates" ? (
        <div className="space-y-3" data-testid="candidates-tab-content">
          {/* Controls: Filter Buttons and Search */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Candidate filters">
              <Button
                variant={candidateFilter === "all" ? "default" : "outline"}
                size="xs"
                onClick={() => setCandidateFilter("all")}
                data-testid="filter-candidate-all"
              >
                전체
              </Button>
              <Button
                variant={candidateFilter === "pending" ? "default" : "outline"}
                size="xs"
                onClick={() => setCandidateFilter("pending")}
                data-testid="filter-candidate-pending"
              >
                대기 중 ({summaryCounts.pendingReview})
              </Button>
              <Button
                variant={candidateFilter === "approved" ? "default" : "outline"}
                size="xs"
                onClick={() => setCandidateFilter("approved")}
                data-testid="filter-candidate-approved"
              >
                승인됨 ({summaryCounts.approvedCandidates})
              </Button>
              <Button
                variant={candidateFilter === "promoted" ? "default" : "outline"}
                size="xs"
                onClick={() => setCandidateFilter("promoted")}
                data-testid="filter-candidate-promoted"
              >
                승격됨
              </Button>
              <Button
                variant={candidateFilter === "rejected" ? "default" : "outline"}
                size="xs"
                onClick={() => setCandidateFilter("rejected")}
                data-testid="filter-candidate-rejected"
              >
                반려됨
              </Button>
            </div>

            <div className="relative w-full sm:w-64">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="후보 내용/출처 검색..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8 pl-8 text-xs"
                data-testid="candidate-search-input"
              />
            </div>
          </div>

          {/* Table */}
          {filteredCandidates.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center" data-testid="candidate-empty-state">
              <Brain className="mx-auto h-8 w-8 text-muted-foreground/60" />
              <p className="mt-2 text-sm font-medium text-muted-foreground">해당 조건에 맞는 메모리 작업 후보가 없습니다.</p>
              <p className="mt-1 text-xs text-muted-foreground/75">
                완료된 이슈 및 에이전트 실행에서 지식 후보가 자동 추출되면 여기에 표출됩니다.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-left text-xs">
                <thead className="border-b bg-muted/50 font-medium text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">출처 타입</th>
                    <th className="px-3 py-2">제목 / 요약</th>
                    <th className="px-3 py-2">AI 확신도</th>
                    <th className="px-3 py-2">검토 상태</th>
                    <th className="px-3 py-2">생성 일시</th>
                    <th className="px-3 py-2 text-right">조작 (위험도: 보통)</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filteredCandidates.map((op) => (
                    <tr
                      key={op.id}
                      className="hover:bg-muted/30 transition-colors"
                      data-testid={`candidate-row-${op.id}`}
                    >
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <SourceTypeBadge type={op.sourceType} />
                      </td>
                      <td className="px-3 py-2.5 max-w-xs sm:max-w-sm truncate">
                        <button
                          type="button"
                          onClick={() => openReviewModal(op)}
                          className="font-medium text-foreground hover:underline text-left block truncate"
                          title={op.title ?? op.summary ?? op.content}
                        >
                          {op.title || op.summary || op.content.slice(0, 60)}
                        </button>
                        {op.summary && op.title ? (
                          <p className="text-xs text-muted-foreground truncate">{op.summary}</p>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <ConfidenceBadge confidence={op.confidence} />
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <ReviewStateBadge state={op.reviewState} status={op.status} />
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">
                        {relativeTime(op.createdAt)}
                      </td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1.5">
                          {op.reviewState === "pending" ? (
                            <Button
                              variant="outline"
                              size="xs"
                              onClick={() => openReviewModal(op)}
                              disabled={isMutating}
                              data-testid={`btn-review-${op.id}`}
                            >
                              검토
                            </Button>
                          ) : null}

                          {op.reviewState === "approved" && op.status === "candidate" ? (
                            <Button
                              variant="default"
                              size="xs"
                              onClick={() => openPromoteModal(op)}
                              disabled={isMutating}
                              data-testid={`btn-promote-${op.id}`}
                            >
                              <Sparkles className="mr-1 h-3 w-3" />
                              지식 승격
                            </Button>
                          ) : null}

                          {op.status === "promoted" || op.reviewState === "rejected" ? (
                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={() => openReviewModal(op)}
                              data-testid={`btn-view-${op.id}`}
                            >
                              상세
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {/* 5. Tab Content: Knowledge Records */}
      {activeTab === "records" ? (
        <div className="space-y-3" data-testid="records-tab-content">
          {/* Controls: Sync State Filters and Search */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Knowledge sync filters">
              <Button
                variant={recordSyncFilter === "all" ? "default" : "outline"}
                size="xs"
                onClick={() => setRecordSyncFilter("all")}
                data-testid="filter-record-all"
              >
                전체 ({knowledgeRecords.length})
              </Button>
              <Button
                variant={recordSyncFilter === "synced" ? "default" : "outline"}
                size="xs"
                onClick={() => setRecordSyncFilter("synced")}
                data-testid="filter-record-synced"
              >
                동기화 완료
              </Button>
              <Button
                variant={recordSyncFilter === "pending" ? "default" : "outline"}
                size="xs"
                onClick={() => setRecordSyncFilter("pending")}
                data-testid="filter-record-pending"
              >
                저장 대기 (F-07)
              </Button>
              <Button
                variant={recordSyncFilter === "failed" ? "default" : "outline"}
                size="xs"
                onClick={() => setRecordSyncFilter("failed")}
                data-testid="filter-record-failed"
              >
                동기화 오류 ({summaryCounts.syncFailures})
              </Button>
            </div>

            <div className="relative w-full sm:w-64">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="지식 제목/본문 검색 (서버 쿼리)..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8 pl-8 text-xs"
                data-testid="record-search-input"
              />
            </div>
          </div>

          {/* Table */}
          {filteredRecords.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center" data-testid="record-empty-state">
              <BookOpen className="mx-auto h-8 w-8 text-muted-foreground/60" />
              <p className="mt-2 text-sm font-medium text-muted-foreground">등록된 공식 사내 지식이 없습니다.</p>
              <p className="mt-1 text-xs text-muted-foreground/75">
                메모리 후보를 검토 승인한 후 [지식 승격]을 실행하면 여기에 보존됩니다.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-left text-xs">
                <thead className="border-b bg-muted/50 font-medium text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">지식 분류</th>
                    <th className="px-3 py-2">제목</th>
                    <th className="px-3 py-2">백엔드 동기화 상태</th>
                    <th className="px-3 py-2">대상 백엔드 / 참조</th>
                    <th className="px-3 py-2">생성 일시</th>
                    <th className="px-3 py-2 text-right">조작 (위험도: 보통)</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filteredRecords.map((rec) => {
                    const syncState = rec.externalSyncState ?? rec.obsidianSyncState;
                    const targetRef = rec.externalRef || rec.obsidianPath || "—";
                    const isSyncFailed = syncState === "failed";

                    return (
                      <tr
                        key={rec.id}
                        className="hover:bg-muted/30 transition-colors"
                        data-testid={`record-row-${rec.id}`}
                      >
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <span className="inline-flex items-center rounded border border-border bg-muted/50 px-1.5 py-0.5 text-xs text-muted-foreground">
                            {rec.knowledgeType || "일반"}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 max-w-xs truncate">
                          <button
                            type="button"
                            onClick={() => setSelectedRecord(rec)}
                            className="font-medium text-foreground hover:underline text-left block truncate"
                          >
                            {rec.title}
                          </button>
                          {rec.summary ? (
                            <p className="text-xs text-muted-foreground truncate">{rec.summary}</p>
                          ) : null}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <SyncStateBadge state={syncState} backendId={rec.externalBackendId} />
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground font-mono text-xs max-w-xs truncate">
                          {targetRef}
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">
                          {relativeTime(rec.createdAt)}
                        </td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          <div className="flex items-center justify-end gap-1.5">
                            {isSyncFailed ? (
                              <Button
                                variant="outline"
                                size="xs"
                                onClick={() => syncMutation.mutate(rec.id)}
                                disabled={isMutating}
                                className="border-destructive/30 text-destructive hover:bg-destructive/10"
                                data-testid={`btn-sync-retry-${rec.id}`}
                              >
                                <UploadCloud className="mr-1 h-3 w-3" />
                                재시도
                              </Button>
                            ) : null}

                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={() => setSelectedRecord(rec)}
                              data-testid={`btn-record-detail-${rec.id}`}
                            >
                              상세보기
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {/* 6. Review Dialog (Approve / Reject) */}
      <Dialog open={selectedCandidate !== null} onOpenChange={(open) => !open && setSelectedCandidate(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Brain className="h-5 w-5 text-primary" />
              후보 메모리 검토 (Review)
            </DialogTitle>
            <DialogDescription className="text-xs">
              에이전트가 추출한 후보 메모리를 검토하여 공식 지식 후보로 승인하거나 반려합니다.
            </DialogDescription>
          </DialogHeader>

          {selectedCandidate ? (
            <div className="space-y-3 py-2 text-xs">
              <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/40 p-2.5">
                <div>
                  <span className="text-muted-foreground">출처 타입: </span>
                  <SourceTypeBadge type={selectedCandidate.sourceType} />
                </div>
                <div>
                  <span className="text-muted-foreground">AI 확신도: </span>
                  <ConfidenceBadge confidence={selectedCandidate.confidence} />
                </div>
                <div>
                  <span className="text-muted-foreground">현재 상태: </span>
                  <ReviewStateBadge state={selectedCandidate.reviewState} status={selectedCandidate.status} />
                </div>
                <div>
                  <span className="text-muted-foreground">추출 일시: </span>
                  <span>{formatDate(selectedCandidate.createdAt)}</span>
                </div>
              </div>

              <div>
                <h4 className="font-semibold text-foreground">제목</h4>
                <p className="mt-1 text-sm font-medium text-foreground">
                  {selectedCandidate.title || "제목 없음"}
                </p>
              </div>

              {selectedCandidate.summary ? (
                <div>
                  <h4 className="font-semibold text-foreground">요약</h4>
                  <p className="mt-1 text-xs text-muted-foreground">{selectedCandidate.summary}</p>
                </div>
              ) : null}

              <div>
                <h4 className="font-semibold text-foreground">내용 원문</h4>
                <div className="mt-1 max-h-48 overflow-y-auto rounded-md border bg-card p-2.5 font-mono text-xs whitespace-pre-wrap">
                  {selectedCandidate.content}
                </div>
              </div>

              {selectedCandidate.reviewState === "pending" ? (
                <div className="space-y-1 pt-2">
                  <label htmlFor="review-notes-input" className="font-medium text-foreground">
                    검토자 메모 (선택 사항)
                  </label>
                  <Textarea
                    id="review-notes-input"
                    placeholder="승인 또는 반려 사유를 남겨주세요."
                    value={reviewNotes}
                    onChange={(e) => setReviewNotes(e.target.value)}
                    rows={2}
                    className="text-xs"
                    disabled={isMutating}
                    data-testid="review-notes-textarea"
                  />
                </div>
              ) : null}

              {reviewMutation.isError ? (
                <div role="alert" className="rounded border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                  검토 처리 실패: {describeApiError(reviewMutation.error, "요청 처리 중 오류가 발생했습니다.")}
                </div>
              ) : null}
            </div>
          ) : null}

          <DialogFooter className="flex items-center justify-between gap-2 border-t pt-3 sm:justify-between">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelectedCandidate(null)}
              disabled={isMutating}
            >
              닫기
            </Button>

            {selectedCandidate?.reviewState === "pending" ? (
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() =>
                    reviewMutation.mutate({
                      id: selectedCandidate.id,
                      reviewState: "rejected",
                      reviewNotes: reviewNotes.trim() || undefined,
                    })
                  }
                  disabled={isMutating}
                  data-testid="modal-reject-btn"
                >
                  <XCircle className="mr-1 h-4 w-4" />
                  후보 반려
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() =>
                    reviewMutation.mutate({
                      id: selectedCandidate.id,
                      reviewState: "approved",
                      reviewNotes: reviewNotes.trim() || undefined,
                    })
                  }
                  disabled={isMutating}
                  data-testid="modal-approve-btn"
                >
                  <CheckCircle2 className="mr-1 h-4 w-4" />
                  검토 승인
                </Button>
              </div>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 7. Promote Dialog (Requires reviewState === "approved") */}
      <Dialog open={promotingCandidate !== null} onOpenChange={(open) => !open && setPromotingCandidate(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-5 w-5 text-primary" />
              공식 사내 지식으로 승격 (Promote)
            </DialogTitle>
            <DialogDescription className="text-xs">
              검토 승인된 후보 메모리를 공식 Knowledge Record로 승격합니다.
              본 승인은 사내 지식 승격과 백엔드 자동 저장을 동시에 인가합니다 (F-07 Single Approval Gate).
            </DialogDescription>
          </DialogHeader>

          {promotingCandidate ? (
            <div className="space-y-3 py-2 text-xs">
              <div className="space-y-1">
                <label htmlFor="promote-title-input" className="font-semibold text-foreground">
                  지식 레코드 제목 <span className="text-destructive">*</span>
                </label>
                <Input
                  id="promote-title-input"
                  value={promoteTitle}
                  onChange={(e) => setPromoteTitle(e.target.value)}
                  placeholder="예: Stage 7 모델 라우터 장애 격리 정책"
                  className="text-xs"
                  disabled={isMutating}
                  data-testid="promote-title-input"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label htmlFor="promote-type-input" className="font-semibold text-foreground">
                    지식 분류 (Knowledge Type)
                  </label>
                  <Input
                    id="promote-type-input"
                    value={promoteType}
                    onChange={(e) => setPromoteType(e.target.value)}
                    placeholder="architecture, policy, sop..."
                    className="text-xs"
                    disabled={isMutating}
                    data-testid="promote-type-input"
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-foreground">출처 추적성 (Provenance)</label>
                  <div className="rounded border bg-muted/40 p-2 font-mono text-xs text-muted-foreground truncate">
                    {promotingCandidate.sourceType}: {promotingCandidate.sourceId}
                  </div>
                </div>
              </div>

              <div className="space-y-1">
                <label htmlFor="promote-summary-input" className="font-semibold text-foreground">
                  요약 (Summary)
                </label>
                <Input
                  id="promote-summary-input"
                  value={promoteSummary}
                  onChange={(e) => setPromoteSummary(e.target.value)}
                  placeholder="간결한 1~2줄 핵심 요약"
                  className="text-xs"
                  disabled={isMutating}
                  data-testid="promote-summary-input"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="promote-body-input" className="font-semibold text-foreground">
                  지식 본문 (Markdown Content)
                </label>
                <Textarea
                  id="promote-body-input"
                  value={promoteBody}
                  onChange={(e) => setPromoteBody(e.target.value)}
                  rows={6}
                  className="font-mono text-xs"
                  disabled={isMutating}
                  data-testid="promote-body-textarea"
                />
              </div>

              {promoteMutation.isError ? (
                <div role="alert" className="rounded border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                  승격 처리 실패: {describeApiError(promoteMutation.error, "지식 승격 중 오류가 발생했습니다.")}
                </div>
              ) : null}
            </div>
          ) : null}

          <DialogFooter className="flex items-center justify-between border-t pt-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPromotingCandidate(null)}
              disabled={isMutating}
            >
              취소
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                if (!promotingCandidate || !promoteTitle.trim()) return;
                promoteMutation.mutate({
                  id: promotingCandidate.id,
                  params: {
                    title: promoteTitle.trim(),
                    knowledgeType: promoteType.trim() || undefined,
                    summary: promoteSummary.trim() || undefined,
                    body: promoteBody.trim() || undefined,
                  },
                });
              }}
              disabled={isMutating || !promoteTitle.trim()}
              data-testid="modal-confirm-promote-btn"
            >
              <Sparkles className="mr-1 h-4 w-4" />
              공식 지식으로 승격 실행
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 8. Knowledge Record Detail Dialog */}
      <Dialog open={selectedRecord !== null} onOpenChange={(open) => !open && setSelectedRecord(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <BookOpen className="h-5 w-5 text-primary" />
              사내 공식 지식 상세 (Knowledge Record)
            </DialogTitle>
            <DialogDescription className="text-xs">
              검증된 사내 지식 레코드 및 활성 지식 백엔드 동기화 상태입니다.
            </DialogDescription>
          </DialogHeader>

          {selectedRecord ? (
            <div className="space-y-3 py-2 text-xs">
              <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/40 p-2.5">
                <div>
                  <span className="text-muted-foreground">지식 분류: </span>
                  <span className="font-medium text-foreground">{selectedRecord.knowledgeType || "일반"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">백엔드 상태: </span>
                  <SyncStateBadge
                    state={selectedRecord.externalSyncState ?? selectedRecord.obsidianSyncState}
                    backendId={selectedRecord.externalBackendId}
                  />
                </div>
                <div>
                  <span className="text-muted-foreground">대상 백엔드: </span>
                  <span className="font-mono text-foreground">{selectedRecord.externalBackendId || "지식 백엔드"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">대상 참조: </span>
                  <span className="font-mono text-foreground truncate block">
                    {selectedRecord.externalRef || selectedRecord.obsidianPath || "—"}
                  </span>
                </div>
              </div>

              {/* Sanitized Sync Error Banner if failed */}
              {(selectedRecord.externalSyncState === "failed" || selectedRecord.obsidianSyncState === "failed") && (
                <div role="alert" className="rounded border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">
                  <div className="font-semibold flex items-center gap-1.5">
                    <AlertTriangle className="h-4 w-4" /> 동기화 오류 메시지 (정제됨)
                  </div>
                  <p className="mt-1 font-mono text-xs">
                    {sanitizeSyncError(selectedRecord.externalSyncError ?? selectedRecord.obsidianSyncError)}
                  </p>
                </div>
              )}

              <div>
                <h4 className="font-semibold text-foreground">제목</h4>
                <p className="mt-1 text-sm font-medium text-foreground">{selectedRecord.title}</p>
              </div>

              {selectedRecord.summary ? (
                <div>
                  <h4 className="font-semibold text-foreground">요약</h4>
                  <p className="mt-1 text-xs text-muted-foreground">{selectedRecord.summary}</p>
                </div>
              ) : null}

              <div>
                <h4 className="font-semibold text-foreground">지식 본문</h4>
                <div className="mt-1 max-h-56 overflow-y-auto rounded-md border bg-card p-2.5 font-mono text-xs whitespace-pre-wrap">
                  {selectedRecord.body}
                </div>
              </div>

              {/* Provenance trace */}
              {selectedRecord.metadata?.provenance ? (
                <div className="rounded border bg-muted/20 p-2 text-xs">
                  <span className="font-semibold text-muted-foreground">출처 이력 (Provenance Trace): </span>
                  <span className="font-mono text-muted-foreground">
                    {JSON.stringify(selectedRecord.metadata.provenance)}
                  </span>
                </div>
              ) : null}

              {syncMutation.isError ? (
                <div role="alert" className="rounded border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                  수동 동기화 실패: {describeApiError(syncMutation.error, "동기화 요청에 실패했습니다.")}
                </div>
              ) : null}
            </div>
          ) : null}

          <DialogFooter className="flex items-center justify-between border-t pt-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelectedRecord(null)}
              disabled={isMutating}
            >
              닫기
            </Button>

            {selectedRecord ? (
              <Button
                variant="default"
                size="sm"
                onClick={() => syncMutation.mutate(selectedRecord.id)}
                disabled={isMutating}
                data-testid="modal-sync-retry-btn"
              >
                <UploadCloud className={cn("mr-1 h-4 w-4", syncMutation.isPending && "animate-spin")} />
                {syncMutation.isPending ? "동기화 중..." : "백엔드 동기화 실행 (위험도: 보통)"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
