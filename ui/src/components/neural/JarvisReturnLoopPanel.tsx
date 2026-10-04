import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Cpu,
  ExternalLink,
  FileText,
  RotateCcw,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CeoBriefingSummary, JarvisReturnLoopData } from "./neuralCommandTypes";

export interface JarvisReturnLoopPanelProps {
  ceoBriefing: CeoBriefingSummary;
  returnLoopData: JarvisReturnLoopData | null;
  onNavigateToKnowledgeTab?: () => void;
  className?: string;
}

/**
 * JarvisReturnLoopPanel:
 * Distinctly separates:
 * 1. CEO Briefing: high-level business issue metrics (Done issues, Blocked issues, Active Pending Approvals).
 * 2. Return Loop Telemetry: factual execution routing telemetry for the latest terminal run (succeeded / failed),
 *    plus verified Obsidian knowledge linkage if available.
 *
 * Truthfulness Contract:
 * - completedCount / blockedCount reflect real dashboard issue states (issues.status === "done" / "blocked").
 * - pendingApprovalCount reflects active pending approvals from the approvals API (excluding expired/consumed).
 * - failedCount is omitted per backend contract audit (no task-level failed aggregate).
 * - Return Loop telemetry only displays factual backend values from terminal runs.
 * - Zero fabricated file attachments or fake work products.
 */
export function JarvisReturnLoopPanel({
  ceoBriefing,
  returnLoopData,
  onNavigateToKnowledgeTab,
  className,
}: JarvisReturnLoopPanelProps) {
  const { completedCount, blockedCount, pendingApprovalCount, recentActivity } = ceoBriefing;

  return (
    <div
      data-testid="jarvis-return-loop-panel"
      className={cn("flex flex-col gap-4", className)}
    >
      {/* 1. CEO Briefing Metric Cards (Dashboard Business Task Status) */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card className="border-border/60 bg-card/60">
          <CardContent className="flex items-center justify-between p-4">
            <div className="flex flex-col">
              <span className="text-xs font-medium text-muted-foreground">완료된 업무 (Done)</span>
              <span className="text-2xl font-bold text-foreground" data-testid="briefing-completed-count">
                {completedCount !== null ? `${completedCount}건` : "—"}
              </span>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-500">
              <CheckCircle2 className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/60 bg-card/60">
          <CardContent className="flex items-center justify-between p-4">
            <div className="flex flex-col">
              <span className="text-xs font-medium text-muted-foreground">차단된 업무 (Blocked)</span>
              <span
                className={cn(
                  "text-2xl font-bold",
                  blockedCount !== null && blockedCount > 0 ? "text-amber-500" : "text-foreground",
                )}
                data-testid="briefing-blocked-count"
              >
                {blockedCount !== null ? `${blockedCount}건` : "—"}
              </span>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500">
              <ShieldAlert className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/60 bg-card/60">
          <CardContent className="flex items-center justify-between p-4">
            <div className="flex flex-col">
              <span className="text-xs font-medium text-muted-foreground">승인 대기 (Approvals)</span>
              <span
                className={cn(
                  "text-2xl font-bold",
                  pendingApprovalCount !== null && pendingApprovalCount > 0 ? "text-primary" : "text-foreground",
                )}
                data-testid="briefing-approval-count"
              >
                {pendingApprovalCount !== null ? `${pendingApprovalCount}건` : "—"}
              </span>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Sparkles className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 2. Return Loop Telemetry & Knowledge Linkage (Terminal Run Telemetry) */}
      <Card className="border-border/80 bg-card">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <div className="flex items-center gap-2">
            <RotateCcw className="h-4 w-4 text-primary" />
            <CardTitle className="text-sm font-semibold">
              Agent → JARVIS 반환 루프 (Return Loop Telemetry)
            </CardTitle>
          </div>
          {returnLoopData ? (
            <Badge
              variant="outline"
              className={cn(
                "text-xs font-mono",
                returnLoopData.status === "succeeded"
                  ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                  : "border-destructive/30 text-destructive",
              )}
            >
              {returnLoopData.status === "succeeded" ? "터미널 성공 종료" : "터미널 이상 종료"}
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">터미널 기록 대기 중</span>
          )}
        </CardHeader>

        <CardContent className="flex flex-col gap-3 text-xs pt-1">
          {returnLoopData ? (
            <>
              {/* Task Title & Agent */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 border-b border-border/50 pb-2">
                <span className="font-semibold text-foreground truncate">
                  {returnLoopData.taskTitle}
                </span>
                <span className="text-muted-foreground font-medium">
                  수행: {returnLoopData.agentName}
                </span>
              </div>

              {/* Execution Routing Details (Only truthful backend values) */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 py-1">
                <div className="flex flex-col gap-0.5">
                  <span className="text-muted-foreground text-xs">실제 실행자 (Executor)</span>
                  <span className="font-mono text-foreground font-medium">
                    {returnLoopData.actualExecutor ?? returnLoopData.routedExecutor ?? "미기록"}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-muted-foreground text-xs">제공자 / 모델 (Provider / Model)</span>
                  <span className="font-mono text-foreground font-medium">
                    {returnLoopData.provider ? `${returnLoopData.provider} / ${returnLoopData.model ?? ""}` : "미기록"}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-muted-foreground text-xs">종료 시각</span>
                  <span className="text-muted-foreground">
                    {new Date(returnLoopData.finishedAt).toLocaleTimeString()}
                  </span>
                </div>
              </div>

              {/* Error Code if terminal failure */}
              {returnLoopData.errorCode ? (
                <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-2 text-destructive">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>오류 코드: {returnLoopData.errorCode}</span>
                </div>
              ) : null}

              {/* Knowledge / Obsidian Linkage (Strictly when obsidianPath or syncState exists) */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/30 p-2.5 mt-1">
                <div className="flex items-center gap-2">
                  <BookOpen className="h-4 w-4 text-violet-500 shrink-0" />
                  <div className="flex flex-col">
                    <span className="font-medium text-foreground text-xs">
                      Obsidian / Knowledge 연계
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {returnLoopData.obsidianPath ? (
                        <>경로: <code className="font-mono">{returnLoopData.obsidianPath}</code></>
                      ) : (
                        "연계된 Obsidian 지식 노트 없음"
                      )}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {returnLoopData.obsidianSyncState ? (
                    <Badge variant="outline" className="text-xs font-mono">
                      {returnLoopData.obsidianSyncState === "synced"
                        ? "동기화 완료"
                        : returnLoopData.obsidianSyncState === "pending"
                        ? "동기화 대기"
                        : "동기화 실패"}
                    </Badge>
                  ) : null}
                  {onNavigateToKnowledgeTab ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs gap-1"
                      onClick={onNavigateToKnowledgeTab}
                    >
                      <ExternalLink className="h-3 w-3" />
                      <span>Knowledge Lab</span>
                    </Button>
                  ) : null}
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center p-6 text-center text-muted-foreground">
              <FileText className="h-8 w-8 mb-2 opacity-50" />
              <span>최근 종료된 터미널 실행 기록이 없습니다.</span>
              {recentActivity ? (
                <span className="text-xs mt-1 text-muted-foreground/80">
                  최근 활동: {recentActivity}
                </span>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
