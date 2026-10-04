import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, LockKeyhole, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { secretsRegistryApi, type SecretsRegistryEntry, type SecretsRegistryEntryType } from "@/api/secrets";
import { describeApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDate } from "@/lib/utils";

const TYPE_LABELS: Record<SecretsRegistryEntryType, string> = {
  secret: "회사 비밀",
  agent_api_key: "에이전트 API 키",
  board_api_key: "보드 API 키",
};

function displayName(entry: SecretsRegistryEntry): string {
  return entry.label || "이름 없음";
}

function displayDate(value: string | null): string {
  return value ? formatDate(value) : "—";
}

function statusClass(status: string): string {
  if (status === "active") return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  if (status === "revoked" || status === "expired") return "bg-destructive/10 text-destructive";
  return "bg-muted text-muted-foreground";
}

function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-all text-sm text-foreground">{children}</dd>
    </div>
  );
}

export function AIOfficeSecretsLab({ companyId }: { companyId: string }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<"all" | SecretsRegistryEntryType>("all");
  const [searchQuery, setSearchQuery] = useState("");

  const listQuery = useQuery({
    queryKey: ["ai-office-secrets-registry", companyId],
    queryFn: () => secretsRegistryApi.list(companyId),
    retry: false,
  });
  const detailQuery = useQuery({
    queryKey: ["ai-office-secrets-registry-detail", companyId, selectedId],
    queryFn: () => secretsRegistryApi.get(companyId, selectedId!),
    enabled: selectedId !== null,
    retry: false,
  });

  const entries = listQuery.data?.entries ?? [];
  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    return entries.filter((entry) => {
      if (typeFilter !== "all" && entry.type !== typeFilter) return false;
      if (!query) return true;
      return [entry.label, entry.provider, entry.maskedIdentifier, entry.scope]
        .some((value) => value?.toLocaleLowerCase().includes(query));
    });
  }, [entries, typeFilter, searchQuery]);
  const selectedSummary = entries.find((entry) => entry.id === selectedId);

  return (
    <Card className="space-y-4 p-4" data-testid="ai-office-secrets-lab">
      <div className="flex flex-col gap-2 border-b pb-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
            <LockKeyhole className="h-5 w-5 text-primary" />
            Control Center — Secrets & Credentials (F-02)
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            비밀 값은 표시되지 않습니다. 키 식별자는 해시에서 파생된 복원 불가능한 표시값이며, 이 화면에는 안전한 메타데이터만 표시됩니다.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void listQuery.refetch()} disabled={listQuery.isFetching}>
          <RefreshCw className="h-4 w-4" /> 새로고침
        </Button>
      </div>

      {listQuery.isError ? (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          Secrets Registry 데이터를 불러올 수 없습니다. {describeApiError(listQuery.error, "조회 실패")}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Secrets summary">
        {([
          ["전체 기록", entries.length],
          ["회사 비밀", entries.filter((entry) => entry.type === "secret").length],
          ["에이전트 API 키", entries.filter((entry) => entry.type === "agent_api_key").length],
          ["내 보드 API 키", entries.filter((entry) => entry.type === "board_api_key").length],
        ] as const).map(([label, count]) => (
          <Card key={label} className="p-3">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-1 text-lg font-semibold">
              {listQuery.isLoading ? "…" : listQuery.isError ? "—" : count}
            </div>
          </Card>
        ))}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1">
          {(["all", "secret", "agent_api_key", "board_api_key"] as const).map((type) => (
            <Button
              key={type}
              variant={typeFilter === type ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setTypeFilter(type)}
            >
              {type === "all" ? "전체" : TYPE_LABELS[type]}
            </Button>
          ))}
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            aria-label="자격 증명 검색"
            placeholder="이름, 제공자, 식별자 검색"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      {listQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">자격 증명 메타데이터를 불러오는 중…</p>
      ) : listQuery.isError ? null : entries.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          표시할 비밀 또는 자격 증명 기록이 없습니다.
        </p>
      ) : filteredEntries.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          검색 조건에 맞는 기록이 없습니다.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-xs">
            <thead className="border-b bg-muted/30 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">이름 / 유형</th>
                <th className="px-3 py-2 font-medium">제공자 / 범위</th>
                <th className="px-3 py-2 font-medium">표시 식별자</th>
                <th className="px-3 py-2 font-medium">상태</th>
                <th className="px-3 py-2 font-medium">생성 / 갱신</th>
                <th className="px-3 py-2 text-right font-medium">상세</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filteredEntries.map((entry) => (
                <tr key={`${entry.type}-${entry.id}`}>
                  <td className="px-3 py-2">
                    <div className="font-medium text-foreground">{displayName(entry)}</div>
                    <div className="text-muted-foreground">{TYPE_LABELS[entry.type]}</div>
                  </td>
                  <td className="px-3 py-2">
                    <div>{entry.provider ?? "—"}</div>
                    <div className="text-muted-foreground">{entry.scope}</div>
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {entry.maskedIdentifier ?? <span className="text-muted-foreground">값 미표시</span>}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`rounded px-2 py-1 font-medium ${statusClass(entry.status)}`}>{entry.status}</span>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    <div>{displayDate(entry.createdAt)}</div>
                    <div>{displayDate(entry.updatedAt)}</div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button variant="outline" size="sm" onClick={() => setSelectedId(entry.id)}>
                      상세 보기
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={selectedId !== null} onOpenChange={(open) => { if (!open) setSelectedId(null); }}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-5 w-5 text-primary" />
              {selectedSummary ? displayName(selectedSummary) : "자격 증명"} — 안전한 상세 정보
            </DialogTitle>
            <DialogDescription>값과 원본 API 키는 이 화면에서 조회하거나 표시하지 않습니다.</DialogDescription>
          </DialogHeader>
          {detailQuery.isLoading ? <p className="text-sm text-muted-foreground">상세 정보를 불러오는 중…</p> : null}
          {detailQuery.isError ? (
            <p role="alert" className="text-sm text-destructive">
              상세 정보를 불러올 수 없습니다. {describeApiError(detailQuery.error, "조회 실패")}
            </p>
          ) : null}
          {detailQuery.data?.entry && !detailQuery.isError ? (
            <dl className="grid grid-cols-2 gap-3 rounded-md border p-3">
              <DetailField label="유형">{TYPE_LABELS[detailQuery.data.entry.type]}</DetailField>
              <DetailField label="상태">{detailQuery.data.entry.status}</DetailField>
              <DetailField label="제공자">{detailQuery.data.entry.provider ?? "—"}</DetailField>
              <DetailField label="범위">{detailQuery.data.entry.scope}</DetailField>
              <DetailField label="소유자 유형">{detailQuery.data.entry.ownerType}</DetailField>
              <DetailField label="소유자 ID">{detailQuery.data.entry.ownerId}</DetailField>
              <DetailField label="표시 식별자">{detailQuery.data.entry.maskedIdentifier ?? "값 미표시"}</DetailField>
              <DetailField label="생성자">{detailQuery.data.entry.createdBy ?? "—"}</DetailField>
              <DetailField label="생성 일시">{displayDate(detailQuery.data.entry.createdAt)}</DetailField>
              <DetailField label="갱신 일시">{displayDate(detailQuery.data.entry.updatedAt)}</DetailField>
              <DetailField label="마지막 사용">{displayDate(detailQuery.data.entry.lastUsedAt)}</DetailField>
              <DetailField label="만료 일시">{displayDate(detailQuery.data.entry.expiresAt)}</DetailField>
              <DetailField label="폐기 일시">{displayDate(detailQuery.data.entry.revokedAt)}</DetailField>
            </dl>
          ) : null}
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="h-4 w-4 shrink-0" />
            표시 식별자는 해시에서 파생된 복원 불가능한 값입니다. 회사 비밀에는 식별자 미리보기를 제공하지 않습니다.
          </p>
          <div className="flex justify-end border-t pt-2">
            <Button variant="outline" size="sm" onClick={() => setSelectedId(null)}>닫기</Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
