import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  HelpCircle,
  Puzzle,
  RefreshCw,
  Search,
  Server,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Wrench,
  XCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn, formatDate, relativeTime } from "@/lib/utils";
import { describeApiError } from "@/api/client";
import {
  toolTrustApi,
  type ToolRiskLevel,
  type ToolTrustStatus,
  type TrustRegistryEntry,
  type TrustRegistryType,
} from "@/api/tool-trust";

/** Metadata for trust statuses per F-05 contract */
export const TRUST_STATUS_META: Record<
  ToolTrustStatus,
  { label: string; description: string; badgeVariant: "success" | "neutral" | "warning" | "destructive" }
> = {
  unreviewed: {
    label: "미검토 (Unreviewed)",
    description: "아직 신뢰 또는 차단 검토가 진행되지 않은 기본 상태입니다. Fail-closed 원칙에 따라 신뢰되지 않습니다.",
    badgeVariant: "neutral",
  },
  trusted: {
    label: "신뢰 (Trusted)",
    description: "운영자 검토 또는 승인된 정책에 의해 안전함이 검증된 상태입니다.",
    badgeVariant: "success",
  },
  restricted: {
    label: "제한됨 (Restricted)",
    description: "특정 승인된 스코프 또는 조건부 환경에서만 제한적으로 실행이 허용된 상태입니다.",
    badgeVariant: "warning",
  },
  blocked: {
    label: "차단됨 (Blocked)",
    description: "보안 위험 또는 격리 조치로 인해 실행이 전면 차단된 상태입니다.",
    badgeVariant: "destructive",
  },
  revoked: {
    label: "취소됨 (Revoked)",
    description: "이전에 부여된 신뢰 권한이 취소되어 더 이상 실행할 수 없는 상태입니다.",
    badgeVariant: "destructive",
  },
};

/** Metadata for risk levels per F-05 contract */
export const RISK_LEVEL_META: Record<
  ToolRiskLevel,
  { label: string; badgeVariant: "low" | "medium" | "high" | "critical" }
> = {
  low: { label: "Low (낮음)", badgeVariant: "low" },
  read: { label: "Read (읽기 전용)", badgeVariant: "low" },
  medium: { label: "Medium (중간)", badgeVariant: "medium" },
  write: { label: "Write (쓰기)", badgeVariant: "medium" },
  high: { label: "High (높음)", badgeVariant: "high" },
  critical: { label: "Critical (치명)", badgeVariant: "critical" },
  destructive: { label: "Destructive (파괴적)", badgeVariant: "critical" },
};

export function ToolTypeBadge({ type }: { type: TrustRegistryType }) {
  switch (type) {
    case "tool":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-blue-500/10 px-1.5 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400">
          <Wrench className="h-3 w-3" />
          Tool
        </span>
      );
    case "mcp":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-purple-500/10 px-1.5 py-0.5 text-xs font-medium text-purple-600 dark:text-purple-400">
          <Server className="h-3 w-3" />
          MCP
        </span>
      );
    case "plugin":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
          <Puzzle className="h-3 w-3" />
          Plugin
        </span>
      );
  }
}

export function TrustStatusBadge({ status }: { status: ToolTrustStatus }) {
  const meta = TRUST_STATUS_META[status] ?? {
    label: status,
    badgeVariant: "neutral",
  };

  switch (meta.badgeVariant) {
    case "success":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-3 w-3" />
          {meta.label}
        </span>
      );
    case "warning":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-3 w-3" />
          {meta.label}
        </span>
      );
    case "destructive":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-rose-500/10 px-1.5 py-0.5 text-xs font-medium text-rose-600 dark:text-rose-400">
          {status === "blocked" ? <Ban className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
          {meta.label}
        </span>
      );
    case "neutral":
    default:
      return (
        <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
          <HelpCircle className="h-3 w-3" />
          {meta.label}
        </span>
      );
  }
}

export function RiskLevelBadge({ level }: { level: ToolRiskLevel | null }) {
  if (!level) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
  const meta = RISK_LEVEL_META[level] ?? { label: level, badgeVariant: "low" };

  switch (meta.badgeVariant) {
    case "critical":
    case "high":
      return (
        <span className="inline-flex items-center rounded bg-rose-500/10 px-1.5 py-0.5 text-xs font-medium text-rose-600 dark:text-rose-400">
          {meta.label}
        </span>
      );
    case "medium":
      return (
        <span className="inline-flex items-center rounded bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
          {meta.label}
        </span>
      );
    case "low":
    default:
      return (
        <span className="inline-flex items-center rounded bg-blue-500/10 px-1.5 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400">
          {meta.label}
        </span>
      );
  }
}

/**
 * Renders signature verification status cleanly distinguishing:
 * 1. Verified (signatureVerified === true)
 * 2. Unverified Claim (signatureVerified === false && signature !== null) - warning!
 * 3. No Signature (signature === null) - neutral
 */
export function SignatureStatusBadge({
  signature,
  signatureVerified,
}: {
  signature: string | null;
  signatureVerified: boolean;
}) {
  if (signatureVerified) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
        <ShieldCheck className="h-3 w-3" />
        검증 완료 (Verified)
      </span>
    );
  }

  if (signature !== null) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
        <ShieldAlert className="h-3 w-3" />
        미검증 서명 (Unverified Claim)
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
      <ShieldOff className="h-3 w-3" />
      서명 없음 (None)
    </span>
  );
}

export function AIOfficeToolTrustLab() {
  const [selectedEntry, setSelectedEntry] = useState<TrustRegistryEntry | null>(null);
  const [typeFilter, setTypeFilter] = useState<"all" | TrustRegistryType>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | ToolTrustStatus>("all");
  const [searchQuery, setSearchQuery] = useState("");

  const registryQuery = useQuery({
    queryKey: ["tool-trust-registry"],
    queryFn: () => toolTrustApi.list(),
    refetchInterval: 60_000,
  });

  const entries = useMemo(
    () => registryQuery.data?.entries ?? [],
    [registryQuery.data],
  );

  // Summary counts
  const totalCount = entries.length;
  const trustedCount = useMemo(
    () => entries.filter((e) => e.trustStatus === "trusted").length,
    [entries],
  );
  const unreviewedCount = useMemo(
    () => entries.filter((e) => e.trustStatus === "unreviewed").length,
    [entries],
  );
  const restrictedOrBlockedCount = useMemo(
    () => entries.filter((e) => e.trustStatus === "restricted" || e.trustStatus === "blocked").length,
    [entries],
  );
  const revokedCount = useMemo(
    () => entries.filter((e) => e.trustStatus === "revoked").length,
    [entries],
  );

  // Filtered entries
  const filteredEntries = useMemo(() => {
    return entries.filter((entry) => {
      if (typeFilter !== "all" && entry.type !== typeFilter) return false;
      if (statusFilter !== "all" && entry.trustStatus !== statusFilter) return false;
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const matchesName = entry.name.toLowerCase().includes(query);
        const matchesProvider = Boolean(entry.provider?.toLowerCase().includes(query));
        const matchesSource = entry.source.toLowerCase().includes(query);
        if (!matchesName && !matchesProvider && !matchesSource) return false;
      }
      return true;
    });
  }, [entries, typeFilter, statusFilter, searchQuery]);

  const isLoading = registryQuery.isLoading;
  const isError = registryQuery.isError;
  const errorMessage = registryQuery.error
    ? describeApiError(registryQuery.error, "Trust Registry API 조회 실패")
    : null;

  return (
    <Card className="space-y-4 p-4">
      {/* 1. Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b pb-3">
        <div>
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            <h2 className="text-base font-semibold tracking-tight">
              Control Center — Tool & Plugin Trust Registry (F-05)
            </h2>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            에이전트가 실행하는 Tool, 원격 MCP 서버, 플러그인의 신뢰 상태(Trust Status)와 서명 검증 내역을 실시간 관제합니다. (Fail-Closed 보안 관제)
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => registryQuery.refetch()}
          disabled={isLoading}
          className="h-8 gap-1.5 self-start sm:self-auto"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
          새로고침
        </Button>
      </div>

      {/* API Error state */}
      {isError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-xs text-destructive">
          <div className="font-semibold">Trust Registry 데이터를 불러올 수 없습니다.</div>
          <p className="mt-1 text-muted-foreground">
            {errorMessage ?? "서버 연결을 확인하거나 나중에 다시 시도해 주세요."}
          </p>
        </div>
      ) : null}

      {/* 2. Top Summary Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">전체 등록 항목</div>
          <div className="mt-1 text-lg font-semibold text-foreground">
            {isLoading ? "…" : totalCount}
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">신뢰 (Trusted)</div>
          <div className="mt-1 text-lg font-semibold text-emerald-600 dark:text-emerald-400">
            {isLoading ? "…" : trustedCount}
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">미검토 (Unreviewed)</div>
          <div className="mt-1 text-lg font-semibold text-muted-foreground">
            {isLoading ? "…" : unreviewedCount}
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">제한 / 차단</div>
          <div
            className={cn(
              "mt-1 text-lg font-semibold",
              restrictedOrBlockedCount > 0
                ? "text-rose-600 dark:text-rose-400"
                : "text-foreground",
            )}
          >
            {isLoading ? "…" : restrictedOrBlockedCount}
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">취소됨 (Revoked)</div>
          <div
            className={cn(
              "mt-1 text-lg font-semibold",
              revokedCount > 0
                ? "text-rose-600 dark:text-rose-400"
                : "text-muted-foreground",
            )}
          >
            {isLoading ? "…" : revokedCount}
          </div>
        </Card>
      </div>

      {/* 3. Filter and Search Bar */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground font-medium mr-1">분류:</span>
          {(["all", "tool", "mcp", "plugin"] as const).map((t) => (
            <Button
              key={t}
              variant={typeFilter === t ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setTypeFilter(t)}
              className="h-7 text-xs px-2"
            >
              {t === "all" ? "전체" : t === "tool" ? "Tool" : t === "mcp" ? "MCP" : "Plugin"}
            </Button>
          ))}
          <span className="text-muted-foreground font-medium mx-1">·</span>
          <span className="text-muted-foreground font-medium mr-1">상태:</span>
          {(["all", "trusted", "unreviewed", "restricted", "blocked", "revoked"] as const).map((s) => (
            <Button
              key={s}
              variant={statusFilter === s ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setStatusFilter(s)}
              className="h-7 text-xs px-2"
            >
              {s === "all"
                ? "전체"
                : s === "trusted"
                  ? "신뢰"
                  : s === "unreviewed"
                    ? "미검토"
                    : s === "restricted"
                      ? "제한"
                      : s === "blocked"
                        ? "차단"
                        : "취소"}
            </Button>
          ))}
        </div>

        <div className="relative w-full sm:w-56">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-2 text-muted-foreground" />
          <Input
            placeholder="이름, 공급자, 전송 검색..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-7 pl-8 text-xs"
          />
        </div>
      </div>

      {/* 4. Inventory Table */}
      <div className="space-y-3">
        {entries.length === 0 && !isLoading ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
            등록된 Tool, MCP 서버 또는 플러그인이 없습니다.
          </div>
        ) : filteredEntries.length === 0 && !isLoading ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
            선택된 필터 조건에 일치하는 도구/플러그인이 없습니다.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="border-b bg-muted/30 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">도구 명칭 / 제공자</th>
                  <th className="px-3 py-2 text-left font-medium">유형</th>
                  <th className="px-3 py-2 text-left font-medium">신뢰 상태</th>
                  <th className="px-3 py-2 text-left font-medium">위험 등급</th>
                  <th className="px-3 py-2 text-left font-medium">서명 검증</th>
                  <th className="px-3 py-2 text-left font-medium">소스 / 버전</th>
                  <th className="px-3 py-2 text-left font-medium">상태</th>
                  <th className="px-3 py-2 text-right font-medium">상세</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filteredEntries.map((item) => {
                  return (
                    <tr
                      key={item.id}
                      className="hover:bg-muted/10 transition-colors"
                    >
                      {/* 1. 명칭 및 공급자 */}
                      <td className="px-3 py-2.5">
                        <div className="font-semibold text-foreground">{item.name}</div>
                        <div className="text-muted-foreground text-xs">
                          {item.provider ?? "공급자 정보 없음"}
                        </div>
                      </td>

                      {/* 2. 유형 */}
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <ToolTypeBadge type={item.type} />
                      </td>

                      {/* 3. 신뢰 상태 */}
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <TrustStatusBadge status={item.trustStatus} />
                      </td>

                      {/* 4. 위험 등급 */}
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <RiskLevelBadge level={item.riskLevel} />
                      </td>

                      {/* 5. 서명 검증 */}
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <SignatureStatusBadge
                          signature={item.signature}
                          signatureVerified={item.signatureVerified}
                        />
                      </td>

                      {/* 6. 소스 / 버전 */}
                      <td className="px-3 py-2.5">
                        <div className="font-mono text-muted-foreground">{item.source}</div>
                        {item.version ? (
                          <div className="text-muted-foreground text-xs">v{item.version}</div>
                        ) : null}
                      </td>

                      {/* 7. 활성화 여부 */}
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {item.enabled ? (
                          <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                            활성
                          </span>
                        ) : (
                          <span className="text-muted-foreground">비활성</span>
                        )}
                      </td>

                      {/* 8. 상세 버튼 */}
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSelectedEntry(item)}
                          className="h-7 text-xs"
                        >
                          상세 보기
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 5. Detail Modal Dialog */}
      <Dialog
        open={selectedEntry !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedEntry(null);
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <Shield className="h-5 w-5 text-primary" />
              <span>{selectedEntry?.name} — 신뢰 및 보안 상세 정보</span>
            </DialogTitle>
            <DialogDescription className="text-xs">
              선택된 도구/플러그인의 보안 속성, 서명 검증 및 스코프 승인 내역을 확인합니다.
            </DialogDescription>
          </DialogHeader>

          {selectedEntry ? <ToolTrustDetailView entry={selectedEntry} /> : null}

          <div className="flex justify-end pt-2 border-t">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelectedEntry(null)}
              className="h-8 text-xs"
            >
              닫기
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function ToolTrustDetailView({ entry }: { entry: TrustRegistryEntry }) {
  const statusMeta = TRUST_STATUS_META[entry.trustStatus];

  return (
    <div className="space-y-3 text-xs">
      {/* 1. 기본 식별 정보 */}
      <div className="rounded-md border p-3 space-y-2 bg-muted/10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-foreground text-sm">{entry.name}</span>
            <ToolTypeBadge type={entry.type} />
          </div>
          <TrustStatusBadge status={entry.trustStatus} />
        </div>
        <div className="grid grid-cols-2 gap-2 text-muted-foreground pt-1 border-t">
          <div>
            제공자:{" "}
            <span className="text-foreground font-medium">{entry.provider ?? "—"}</span>
          </div>
          <div>
            버전:{" "}
            <span className="font-mono text-foreground font-medium">
              {entry.version ? `v${entry.version}` : "—"}
            </span>
          </div>
          <div>
            전송 방식 (Source):{" "}
            <span className="font-mono text-foreground font-medium">{entry.source}</span>
          </div>
          <div>
            소속 회사:{" "}
            <span className="text-foreground font-medium">
              {entry.companyId ? entry.companyId : "인스턴스 전역 (Instance-wide)"}
            </span>
          </div>
        </div>
      </div>

      {/* 2. 신뢰 및 위험 등급 */}
      <div className="rounded-md border p-3 space-y-2">
        <div className="font-semibold text-muted-foreground flex items-center gap-1">
          <Shield className="h-3.5 w-3.5" />
          신뢰 정책 및 위험 평가 (Trust & Risk)
        </div>
        <div className="grid grid-cols-2 gap-3 py-1">
          <div className="rounded bg-muted/20 p-2.5">
            <span className="text-muted-foreground">신뢰 상태</span>
            <div className="mt-1">
              <TrustStatusBadge status={entry.trustStatus} />
            </div>
            <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
              {statusMeta.description}
            </p>
          </div>
          <div className="rounded bg-muted/20 p-2.5">
            <span className="text-muted-foreground">위험 등급</span>
            <div className="mt-1">
              <RiskLevelBadge level={entry.riskLevel} />
            </div>
            <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
              {entry.riskLevel === "critical" || entry.riskLevel === "destructive" || entry.riskLevel === "high"
                ? "치명/고위험 도구는 휴먼 승인 게이트(Approval Gate) 통과가 필수입니다."
                : "정상 실행 범위 내의 위험 등급입니다."}
            </p>
          </div>
        </div>
      </div>

      {/* 3. 서명 및 무결성 검증 */}
      <div className="rounded-md border p-3 space-y-2">
        <div className="font-semibold text-muted-foreground flex items-center gap-1">
          <ShieldCheck className="h-3.5 w-3.5" />
          서명 및 출처 무결성 (Integrity Signature)
        </div>
        <div className="flex items-center gap-2">
          <SignatureStatusBadge
            signature={entry.signature}
            signatureVerified={entry.signatureVerified}
          />
        </div>
        {entry.signature ? (
          <div className="space-y-1 pt-1 border-t">
            <span className="text-muted-foreground text-xs">서명 값:</span>
            <pre className="rounded bg-muted p-2 font-mono text-xs overflow-x-auto text-foreground">
              {entry.signature}
            </pre>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs leading-relaxed">
            별도의 서명 메타데이터가 등록되지 않은 도구입니다.
          </p>
        )}
        {entry.sourceUrl ? (
          <div className="text-muted-foreground text-xs">
            출처 URL:{" "}
            <a
              href={entry.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline"
            >
              {entry.sourceUrl}
            </a>
          </div>
        ) : null}
      </div>

      {/* 4. 스코프 (Scopes) & 검토자 (Reviewer) */}
      <div className="rounded-md border p-3 space-y-2">
        <div className="font-semibold text-muted-foreground flex items-center gap-1">
          <Puzzle className="h-3.5 w-3.5" />
          요청 및 승인 스코프 (Scopes)
        </div>
        <div className="grid grid-cols-2 gap-2 text-muted-foreground">
          <div>
            <span className="font-medium text-foreground block mb-0.5">요청 스코프 (Requested):</span>
            {entry.requestedScopes.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {entry.requestedScopes.map((scope) => (
                  <span
                    key={scope}
                    className="inline-block rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground"
                  >
                    {scope}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </div>
          <div>
            <span className="font-medium text-foreground block mb-0.5">승인된 스코프 (Approved):</span>
            {entry.approvedScopes.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {entry.approvedScopes.map((scope) => (
                  <span
                    key={scope}
                    className="inline-block rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-xs text-emerald-600 dark:text-emerald-400"
                  >
                    {scope}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 pt-2 border-t text-muted-foreground">
          <div>
            검토자 (Reviewed By):{" "}
            <span className="font-mono text-foreground font-medium">
              {entry.reviewedBy ?? "미검토"}
            </span>
          </div>
          <div>
            검토 일시:{" "}
            <span className="text-foreground font-medium">
              {entry.reviewedAt
                ? `${formatDate(entry.reviewedAt)} (${relativeTime(entry.reviewedAt)})`
                : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* 5. 안전 안내 */}
      <div className="rounded border border-dashed p-2.5 text-muted-foreground leading-relaxed">
        ℹ️ 본 관제탑 화면은 읽기 전용(Read-Only) 관제 화면입니다. 플러그인 신뢰 검토 및 도구 정책 승인은 별도의 관리자 인가 절차를 통해 수행됩니다.
      </div>
    </div>
  );
}
