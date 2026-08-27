import { useEffect, useState } from "react";
import { useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../../context/CompanyContext";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { approvalsApi } from "../../api/approvals";
import { companiesApi } from "../../api/companies";
import { healthApi } from "../../api/health";
import { queryKeys } from "../../lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ShieldCheck, ShieldAlert, ShieldX, Clock, RefreshCw, Power } from "lucide-react";
import { webauthnMock } from "../../lib/mobile/webauthn-mock";

export function MobileApprovalConsole() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<"pending" | "history">("pending");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isEmergencyActionPending, setIsEmergencyActionPending] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "모바일 관제탑" }]);
  }, [setBreadcrumbs]);

  // Query health (for PC online/offline indicator)
  const { data: health, refetch: refetchHealth, isFetching: isFetchingHealth } = useQuery({
    queryKey: ["health"],
    queryFn: () => healthApi.get(),
    refetchInterval: 15000, // Poll every 15s for PC online status
  });

  // Query approvals
  const { data: approvals, isLoading: isLoadingApprovals, refetch: refetchApprovals } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId || ""),
    queryFn: () => approvalsApi.list(selectedCompanyId || ""),
    enabled: !!selectedCompanyId,
  });

  const updateCompanyMutation = useMutation({
    mutationFn: (data: { status: "active" | "paused" }) =>
      companiesApi.update(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["company", selectedCompanyId] });
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      setIsEmergencyActionPending(false);
    },
    onError: (err) => {
      setErrorMsg(err instanceof Error ? err.message : "긴급 조치 변경 실패");
      setIsEmergencyActionPending(false);
    }
  });

  const handleEmergencyToggle = async () => {
    if (!selectedCompany) return;
    const isCurrentlyPaused = selectedCompany.status === "paused";
    const targetStatus = isCurrentlyPaused ? "active" : "paused";
    const challengeText = `회사 전체 긴급 중지 상태를 '${isCurrentlyPaused ? "정상 운영" : "긴급 중지"}'(으)로 전환합니다.`;

    setIsEmergencyActionPending(true);
    setErrorMsg(null);

    try {
      const authResult = await webauthnMock.authenticate(challengeText);
      if (authResult.success) {
        updateCompanyMutation.mutate({ status: targetStatus });
      } else {
        setErrorMsg(authResult.error ?? "생체 인증이 취소되었습니다.");
        setIsEmergencyActionPending(false);
      }
    } catch (e) {
      setErrorMsg("인증 진행 중 에러가 발생했습니다.");
      setIsEmergencyActionPending(false);
    }
  };

  const handleManualRefresh = () => {
    refetchHealth();
    refetchApprovals();
  };

  if (!selectedCompanyId) {
    return (
      <div className="flex h-[60vh] flex-col items-center justify-center p-6 text-center">
        <ShieldX className="h-12 w-12 text-muted-foreground/40 mb-3" />
        <p className="text-sm font-medium text-muted-foreground">회사를 먼저 선택해 주세요.</p>
      </div>
    );
  }

  const isPcOnline = health?.status === "ok";
  const isPaused = selectedCompany?.status === "paused";

  // Filter approvals
  const pendingApprovals = (approvals ?? [])
    .filter((a) => a.status === "pending" || a.status === "revision_requested")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const resolvedApprovals = (approvals ?? [])
    .filter((a) => a.status !== "pending" && a.status !== "revision_requested")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <div className="space-y-4 px-4 py-2 max-w-md mx-auto">
      {/* PC Status & Emergency Control Panel */}
      <Card className="p-4 border-border/80 shadow-sm space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${isPcOnline ? "bg-green-500 animate-pulse" : "bg-red-500"}`} />
            <span className="text-xs font-semibold text-muted-foreground">
              PC Client: {isPcOnline ? "ONLINE" : "OFFLINE"}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={handleManualRefresh}
            disabled={isFetchingHealth || isLoadingApprovals}
          >
            <RefreshCw className={`h-4 w-4 ${isFetchingHealth ? "animate-spin" : ""}`} />
          </Button>
        </div>

        <div className="flex items-center justify-between border-t border-border/40 pt-3">
          <div>
            <h4 className="text-sm font-bold text-foreground">회사 전체 긴급 중지</h4>
            <p className="text-xs text-muted-foreground">활성화 시 모든 에이전트 스케줄 중단</p>
          </div>
          <Button
            variant={isPaused ? "default" : "destructive"}
            size="sm"
            onClick={handleEmergencyToggle}
            disabled={isEmergencyActionPending}
            className="flex items-center gap-1.5"
          >
            <Power className="h-4 w-4" />
            {isPaused ? "긴급 중지 해제" : "즉시 긴급 중지"}
          </Button>
        </div>

        {errorMsg && (
          <p className="text-xs text-destructive bg-destructive/10 p-2 rounded-md">{errorMsg}</p>
        )}
      </Card>

      {/* Tabs */}
      <div className="flex border-b border-border/60">
        <button
          onClick={() => setActiveTab("pending")}
          className={`flex-1 py-2 text-sm font-semibold text-center border-b-2 transition-colors ${
            activeTab === "pending"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground"
          }`}
        >
          대기 중 ({pendingApprovals.length})
        </button>
        <button
          onClick={() => setActiveTab("history")}
          className={`flex-1 py-2 text-sm font-semibold text-center border-b-2 transition-colors ${
            activeTab === "history"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground"
          }`}
        >
          승인 내역 ({resolvedApprovals.length})
        </button>
      </div>

      {/* Approvals Lists */}
      {activeTab === "pending" ? (
        <div className="space-y-3">
          {isLoadingApprovals ? (
            <p className="text-xs text-muted-foreground text-center py-8 animate-pulse">로딩 중...</p>
          ) : pendingApprovals.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
              <ShieldCheck className="h-10 w-10 text-muted-foreground/30 mb-2" />
              <p className="text-xs">대기 중인 승인 요청이 없습니다.</p>
            </div>
          ) : (
            pendingApprovals.map((a) => (
              <MobileApprovalCard key={a.id} approval={a} onClick={() => navigate(`/mobile/approvals/${a.id}`)} />
            ))
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {isLoadingApprovals ? (
            <p className="text-xs text-muted-foreground text-center py-8 animate-pulse">로딩 중...</p>
          ) : resolvedApprovals.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
              <Clock className="h-10 w-10 text-muted-foreground/30 mb-2" />
              <p className="text-xs">최근 처리된 승인이 없습니다.</p>
            </div>
          ) : (
            resolvedApprovals.map((a) => (
              <MobileApprovalCard key={a.id} approval={a} isHistory onClick={() => navigate(`/mobile/approvals/${a.id}`)} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function MobileApprovalCard({
  approval,
  isHistory = false,
  onClick
}: {
  approval: any;
  isHistory?: boolean;
  onClick: () => void;
}) {
  const [timeLeft, setTimeLeft] = useState<string>("");

  useEffect(() => {
    if (isHistory || !approval.expiresAt) return;

    const updateTimer = () => {
      const diff = new Date(approval.expiresAt).getTime() - Date.now();
      if (diff <= 0) {
        setTimeLeft("만료됨");
      } else {
        const mins = Math.floor(diff / 60000);
        const secs = Math.floor((diff % 60000) / 1000);
        setTimeLeft(`${mins}:${secs < 10 ? "0" : ""}${secs}`);
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [approval.expiresAt, isHistory]);

  const payload = approval.payload || {};
  const isHighRisk = approval.type === "budget_override_required" || (payload.risks && payload.risks.length > 0);

  return (
    <Card
      onClick={onClick}
      className={`p-4 border-border/80 shadow-sm cursor-pointer hover:border-primary/40 active:bg-muted/40 transition-colors ${
        isHistory ? "opacity-75" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1.5 flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="text-[10px] tracking-wide uppercase px-1.5 py-0">
              {approval.type}
            </Badge>
            {isHighRisk && !isHistory && (
              <Badge variant="destructive" className="text-[10px] bg-red-600 px-1.5 py-0 animate-pulse">
                HIGH RISK
              </Badge>
            )}
          </div>
          <h4 className="text-sm font-bold text-foreground truncate">
            {payload.title || payload.recommendedAction || "승인 검토 요청"}
          </h4>
          <p className="text-[11px] text-muted-foreground">
            {new Date(approval.createdAt).toLocaleTimeString()} 생성
          </p>
        </div>

        <div className="text-right shrink-0">
          {isHistory ? (
            <span className="inline-block text-xs font-semibold text-muted-foreground capitalize">
              {approval.status}
            </span>
          ) : (
            <div className="space-y-1">
              <span className="block text-[10px] text-muted-foreground">만료 시간</span>
              <span className="block text-xs font-bold text-amber-500 font-mono flex items-center justify-end gap-1">
                <Clock className="h-3 w-3" />
                {timeLeft || "계산 중"}
              </span>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
