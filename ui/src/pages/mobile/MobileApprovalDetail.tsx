import { useEffect, useState } from "react";
import { useParams, useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { approvalsApi } from "../../api/approvals";
import { queryKeys } from "../../lib/queryKeys";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ShieldCheck, ShieldAlert, ChevronDown, ChevronUp, Lock, RefreshCw } from "lucide-react";
import { webauthnMock } from "../../lib/mobile/webauthn-mock";

export function MobileApprovalDetail() {
  const { approvalId } = useParams<{ approvalId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [isCommandsOpen, setIsCommandsOpen] = useState(false);
  const [decisionNote, setDecisionNote] = useState("");
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isAuthProcessing, setIsAuthProcessing] = useState(false);

  const { data: approval, isLoading, refetch } = useQuery({
    queryKey: queryKeys.approvals.detail(approvalId || ""),
    queryFn: () => approvalsApi.get(approvalId || ""),
    enabled: !!approvalId,
  });

  const refresh = () => {
    if (!approvalId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.detail(approvalId) });
    if (approval?.companyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(approval.companyId) });
    }
  };

  const approveMutation = useMutation({
    mutationFn: () => approvalsApi.approve(approvalId!, decisionNote.trim() || undefined),
    onSuccess: () => {
      setErrorMsg(null);
      refresh();
      navigate("/mobile/approvals", { replace: true });
    },
    onError: (err) => {
      setErrorMsg(err instanceof Error ? err.message : "승인 실행 실패");
    }
  });

  const rejectMutation = useMutation({
    mutationFn: () => approvalsApi.reject(approvalId!, decisionNote.trim() || undefined),
    onSuccess: () => {
      setErrorMsg(null);
      refresh();
      navigate("/mobile/approvals", { replace: true });
    },
    onError: (err) => {
      setErrorMsg(err instanceof Error ? err.message : "거절 실행 실패");
    }
  });

  const revisionMutation = useMutation({
    mutationFn: () => approvalsApi.requestRevision(approvalId!, decisionNote.trim() || undefined),
    onSuccess: () => {
      setErrorMsg(null);
      refresh();
      navigate("/mobile/approvals", { replace: true });
    },
    onError: (err) => {
      setErrorMsg(err instanceof Error ? err.message : "수정 요청 실패");
    }
  });

  const handleBiometricAuth = async () => {
    if (!approval) return;
    setIsAuthProcessing(true);
    setErrorMsg(null);

    const challenge = `[결재 승인 챌린지]\n요청 ID: ${approval.id}\n유형: ${approval.type}`;
    try {
      const result = await webauthnMock.authenticate(challenge);
      if (result.success) {
        setIsAuthenticated(true);
      } else {
        setErrorMsg(result.error ?? "생체 인증 실패");
      }
    } catch (e) {
      setErrorMsg("인증 런타임 오류가 발생했습니다.");
    } finally {
      setIsAuthProcessing(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-[60vh] flex-col items-center justify-center p-6 text-center animate-pulse">
        <RefreshCw className="h-8 w-8 text-muted-foreground/35 animate-spin mb-2" />
        <p className="text-xs text-muted-foreground">승인 내역 불러오는 중...</p>
      </div>
    );
  }

  if (!approval) {
    return (
      <div className="p-6 text-center">
        <ShieldAlert className="h-10 w-10 text-red-500 mx-auto mb-2" />
        <p className="text-sm font-semibold text-muted-foreground">승인 요청을 찾을 수 없습니다.</p>
      </div>
    );
  }

  const payload = (approval.payload as Record<string, unknown>) || {};
  const risks = Array.isArray(payload.risks) ? payload.risks : [];
  const proposedCommands = Array.isArray(payload.proposedCommands) ? payload.proposedCommands : [];
  const affectedFiles = Array.isArray(payload.affectedFiles) ? payload.affectedFiles : [];
  const isPending = approval.status === "pending" || approval.status === "revision_requested";

  const isMutationLoading =
    approveMutation.isPending ||
    rejectMutation.isPending ||
    revisionMutation.isPending;

  return (
    <div className="space-y-4 px-4 py-3 max-w-md mx-auto pb-20">
      {/* 1. Risk Assessment Banner (First Order Display) */}
      <Card className={`p-4 border-2 shadow-sm ${risks.length > 0 ? "border-red-500/30 bg-red-500/5" : "border-border/60 bg-muted/10"}`}>
        <div className="flex items-start gap-2.5">
          {risks.length > 0 ? (
            <ShieldAlert className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
          ) : (
            <ShieldCheck className="h-5 w-5 text-green-600 shrink-0 mt-0.5" />
          )}
          <div className="space-y-1.5 flex-1">
            <h4 className={`text-sm font-extrabold ${risks.length > 0 ? "text-red-700 dark:text-red-400" : "text-green-700 dark:text-green-400"}`}>
              {risks.length > 0 ? "HIGH RISK WARNING" : "NORMAL RISK OPERATION"}
            </h4>
            <p className="text-xs leading-relaxed text-foreground/80 font-medium">
              {risks.length > 0
                ? "주의: 에이전트가 보안에 민감한 중요 파일이나 명령을 실행하려고 합니다. 아래 세부 내역을 완전히 검토하십시오."
                : "비교적 안전한 작업입니다. 변경 내역 및 명령어가 적합한지 아래에서 점검하십시오."}
            </p>
            {risks.map((r, i) => (
              <div key={i} className="text-xs text-red-600 dark:text-red-400 font-semibold bg-red-500/10 p-2 rounded-md mt-1.5">
                • {r}
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* 2. Metadata Section */}
      <div className="space-y-2 text-xs">
        <div className="flex justify-between border-b border-border/40 pb-2">
          <span className="text-muted-foreground">요청 유형</span>
          <span className="font-semibold text-foreground uppercase">{approval.type}</span>
        </div>
        <div className="flex justify-between border-b border-border/40 pb-2">
          <span className="text-muted-foreground">상태</span>
          <span className="font-semibold text-foreground capitalize">{approval.status}</span>
        </div>
        <div className="flex justify-between border-b border-border/40 pb-2">
          <span className="text-muted-foreground">생성일</span>
          <span className="font-mono">{new Date(approval.createdAt).toLocaleString()}</span>
        </div>
      </div>

      {/* 3. Proposed Commands (Folded Accordion) */}
      {proposedCommands.length > 0 && (
        <Card className="p-3 border-border/60 shadow-sm">
          <button
            onClick={() => setIsCommandsOpen(!isCommandsOpen)}
            className="flex w-full items-center justify-between text-xs font-bold text-foreground"
          >
            <span>실행 예정 명령 ({proposedCommands.length}건)</span>
            {isCommandsOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          {isCommandsOpen && (
            <pre className="mt-2 p-2.5 rounded bg-muted font-mono text-[10px] text-muted-foreground overflow-x-auto max-h-36 whitespace-pre-wrap border border-border/40">
              {proposedCommands.join("\n")}
            </pre>
          )}
        </Card>
      )}

      {/* 4. Affected Files & Entities */}
      {affectedFiles.length > 0 && (
        <Card className="p-3 border-border/60 shadow-sm space-y-2">
          <h5 className="text-xs font-bold text-foreground">변경 대상 파일</h5>
          <ul className="text-xs font-mono text-muted-foreground space-y-1">
            {affectedFiles.map((file, idx) => (
              <li key={idx} className="truncate bg-muted/40 p-1 rounded">
                • {file}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* 5. Masked Secrets Check */}
      <Card className="p-3 border-border/60 shadow-sm space-y-2">
        <h5 className="text-xs font-bold text-foreground">인증 정보 보호 상태</h5>
        <div className="text-[11px] font-mono text-muted-foreground space-y-1 bg-muted/40 p-2 rounded">
          <div>JWT_SECRET: <span className="text-red-500 font-bold">***[SECURE_MASKED]***</span></div>
          <div>DATABASE_URL: <span className="text-red-500 font-bold">***[SECURE_MASKED]***</span></div>
        </div>
      </Card>

      {/* 6. Biometric Gates Zone & Decision Input */}
      {isPending && (
        <Card className="p-4 border-border/80 shadow-md space-y-3.5 bg-background/50">
          <h5 className="text-xs font-extrabold text-foreground">의사 결정 및 바이오 보안 가드</h5>

          <Textarea
            placeholder="결정 사유를 입력하세요 (선택 사항)"
            value={decisionNote}
            onChange={(e) => setDecisionNote(e.target.value)}
            disabled={isMutationLoading}
            className="text-xs"
          />

          {!isAuthenticated ? (
            <Button
              onClick={handleBiometricAuth}
              disabled={isAuthProcessing || isMutationLoading}
              className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground py-2 text-xs"
            >
              <Lock className="h-4.5 w-4.5" />
              {isAuthProcessing ? "바이오 챌린지 검증 중..." : "Face ID / 기기 생체 인증 수행"}
            </Button>
          ) : (
            <div className="bg-green-500/10 p-2 rounded border border-green-500/20 text-[11px] text-green-700 font-bold text-center">
              생체인증 완료 (결정 승인 가드 해제됨)
            </div>
          )}
        </Card>
      )}

      {/* 7. Error Messages */}
      {errorMsg && (
        <p className="text-xs text-destructive bg-destructive/10 p-2 rounded-md text-center font-medium">
          {errorMsg}
        </p>
      )}

      {/* 8. Bottom Buttons (Strict gate validation) */}
      {isPending && (
        <div className="fixed bottom-0 left-0 right-0 p-4 border-t border-border bg-background/95 backdrop-blur z-20 flex gap-2 max-w-md mx-auto justify-between">
          <Button
            variant="outline"
            size="sm"
            onClick={() => revisionMutation.mutate()}
            disabled={!isAuthenticated || isMutationLoading}
            className="flex-1 text-xs py-2"
          >
            수정 요청
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => rejectMutation.mutate()}
            disabled={!isAuthenticated || isMutationLoading}
            className="flex-1 text-xs py-2"
          >
            반대 (거절)
          </Button>
          <Button
            size="sm"
            onClick={() => approveMutation.mutate()}
            disabled={!isAuthenticated || isMutationLoading}
            className="flex-1 text-xs py-2 bg-green-700 hover:bg-green-600 text-white"
          >
            승인 실행
          </Button>
        </div>
      )}
    </div>
  );
}
