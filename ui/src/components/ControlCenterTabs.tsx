import { useCallback, useEffect, useState } from "react";
import { AlertCircle, BookOpen, Layers, Shield, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export type ControlCenterTabId = "sre" | "security" | "knowledge" | "quality" | "all";

export const VALID_CONTROL_CENTER_TABS: readonly ControlCenterTabId[] = [
  "sre",
  "security",
  "knowledge",
  "quality",
  "all",
] as const;

export function parseControlCenterTab(value: string | null | undefined): ControlCenterTabId {
  if (value && (VALID_CONTROL_CENTER_TABS as readonly string[]).includes(value)) {
    return value as ControlCenterTabId;
  }
  return "sre";
}

export interface ControlCenterTabMeta {
  id: ControlCenterTabId;
  label: string;
  shortLabel: string;
  icon: typeof AlertCircle;
  description: string;
  badge?: number | string | null;
  badgeVariant?: "default" | "destructive" | "secondary";
}

export const CONTROL_CENTER_TAB_CONFIGS: readonly ControlCenterTabMeta[] = [
  {
    id: "sre",
    label: "운영 & SRE",
    shortLabel: "SRE",
    icon: AlertCircle,
    description: "인시던트 대응, 런타임 안정성 및 복구",
  },
  {
    id: "security",
    label: "보안 & 신뢰",
    shortLabel: "보안",
    icon: Shield,
    description: "도구 신뢰 레지스트리 및 시크릿 관리",
  },
  {
    id: "knowledge",
    label: "지식 & 데이터",
    shortLabel: "지식",
    icon: BookOpen,
    description: "메모리 승격 및 데이터 수명주기 거버넌스",
  },
  {
    id: "quality",
    label: "품질 & 평가",
    shortLabel: "품질",
    icon: Sparkles,
    description: "에이전트 벤치마크 및 회귀 시뮬레이션",
  },
  {
    id: "all",
    label: "전체 보기",
    shortLabel: "전체",
    icon: Layers,
    description: "모든 Control Center Lab 통합 뷰",
  },
] as const;

/**
 * Manages active tab state synchronized with the URL query string (?tab=sre|security|knowledge|quality|all).
 * Falls back safely to "sre" when parameter is missing or invalid.
 */
export function useControlCenterTab(
  initialFallback: ControlCenterTabId = "sre",
): [ControlCenterTabId, (tab: ControlCenterTabId) => void] {
  const [tab, setTabState] = useState<ControlCenterTabId>(() => {
    if (typeof window !== "undefined" && window.location) {
      const sp = new URLSearchParams(window.location.search);
      return parseControlCenterTab(sp.get("tab"));
    }
    return initialFallback;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handlePopState = () => {
      const sp = new URLSearchParams(window.location.search);
      setTabState(parseControlCenterTab(sp.get("tab")));
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const setTab = useCallback((newTab: ControlCenterTabId) => {
    const safeTab = parseControlCenterTab(newTab);
    setTabState(safeTab);
    if (typeof window !== "undefined" && window.history) {
      const url = new URL(window.location.href);
      if (safeTab === "sre") {
        url.searchParams.delete("tab");
      } else {
        url.searchParams.set("tab", safeTab);
      }
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  return [tab, setTab];
}

interface ControlCenterTabsProps {
  activeTab: ControlCenterTabId;
  onTabChange: (tab: ControlCenterTabId) => void;
  className?: string;
  counts?: Partial<Record<ControlCenterTabId, number | string>>;
}

export function ControlCenterTabs({
  activeTab,
  onTabChange,
  className,
  counts,
}: ControlCenterTabsProps) {
  return (
    <div
      className={cn("flex flex-col gap-2 rounded-lg border bg-card p-3", className)}
      data-testid="control-center-tabs-container"
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Control Center</h2>
          <p className="text-xs text-muted-foreground">
            도메인별 운영 통제소 탭을 선택하여 세부 현황을 조회하고 제어합니다.
          </p>
        </div>
      </div>

      {/* Accessible Tab List with Mobile Horizontal Scroll */}
      <div
        role="tablist"
        aria-label="Control Center Tabs"
        className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs"
        data-testid="control-center-tablist"
      >
        {CONTROL_CENTER_TAB_CONFIGS.map((config) => {
          const isActive = activeTab === config.id;
          const Icon = config.icon;
          const count = counts?.[config.id];

          return (
            <button
              key={config.id}
              role="tab"
              type="button"
              id={`control-center-tab-${config.id}`}
              aria-selected={isActive}
              aria-controls={`control-center-panel-${config.id}`}
              data-testid={`control-center-tab-${config.id}`}
              data-state={isActive ? "active" : "inactive"}
              onClick={() => onTabChange(config.id)}
              className={cn(
                "inline-flex h-9 items-center gap-1.5 rounded-md px-3 font-medium transition-colors whitespace-nowrap select-none",
                isActive
                  ? "bg-primary text-primary-foreground shadow-xs"
                  : "bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{config.label}</span>
              {count !== undefined && count !== null ? (
                <span
                  className={cn(
                    "ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-xs font-semibold",
                    isActive
                      ? "bg-primary-foreground/20 text-primary-foreground"
                      : "bg-background text-muted-foreground",
                  )}
                  data-testid={`tab-badge-${config.id}`}
                >
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
