import { useCallback, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Agent, Issue, OrgUnitStatus } from "@paperclipai/shared";
import {
  Bot,
  Building2,
  Coffee,
  Compass,
  DoorOpen,
  GitBranch,
  Maximize2,
  Mic,
  RotateCcw,
  Sofa,
  Sprout,
  Users,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { LiveRunForIssue } from "@/api/heartbeats";
import {
  AmenityTile,
  EmptyRoomNote,
  EmptySeat,
  RoomBox,
  SeatBadge,
  Workstation,
} from "@/components/AIOfficeFloor";
import type { AIOfficeWorkspaceTarget } from "@/components/AIOfficeWorkspaceSheet";
import type { VoiceBarState } from "@/components/VoiceCommandBar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  AGENT_BEHAVIOR_LABEL,
  computeRoomCapacity,
  deriveAgentBehavior,
  type AgentBehaviorKind,
  type AgentBehaviorState,
} from "./officeLayoutEngine";

export interface DepartmentRoomSpec {
  label: string;
  orgUnitName: string | null;
}

export interface TopDownOfficeCanvasProps {
  agents: Agent[];
  orgUnits: OrgUnitStatus[];
  departmentRooms: ReadonlyArray<DepartmentRoomSpec>;
  secretariatRoom: DepartmentRoomSpec;
  otherOrgUnits: OrgUnitStatus[];
  jarvis: Agent | undefined;
  atlas: Agent | undefined;
  liveRunByAgentId: Map<string, LiveRunForIssue>;
  pendingApprovalAgentIds: Set<string>;
  inReviewAgentIds: Set<string>;
  orgUnitIdByName: Map<string, string>;
  allIssues?: Issue[];
  completedIssues?: Issue[];
  pendingApprovalCount: number;
  voiceState: VoiceBarState;
  now: number;
  onSelectAgent: (agentId: string) => void;
  onSelectWorkspace: (target: AIOfficeWorkspaceTarget) => void;
}

const ZOOM_STEPS = [0.75, 0.9, 1, 1.15, 1.3] as const;

export function TopDownOfficeCanvas({
  agents,
  departmentRooms,
  secretariatRoom,
  otherOrgUnits,
  jarvis,
  atlas,
  liveRunByAgentId,
  pendingApprovalAgentIds,
  inReviewAgentIds,
  orgUnitIdByName,
  allIssues = [],
  completedIssues = [],
  pendingApprovalCount,
  voiceState,
  now,
  onSelectAgent,
  onSelectWorkspace,
}: TopDownOfficeCanvasProps) {
  const [zoomIndex, setZoomIndex] = useState<number>(2); // 1.0x default
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const pinchDistanceRef = useRef<number | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);

  const zoomScale = ZOOM_STEPS[zoomIndex] ?? 1;
  const isVoiceListening = voiceState === "listening" || voiceState === "processing";

  // Derive deterministic real-time behavior for every registered AI employee
  const behaviorByAgentId = useMemo(() => {
    const map = new Map<string, AgentBehaviorState>();
    for (const agent of agents) {
      const behaviorState = deriveAgentBehavior({
        agent,
        liveRun: liveRunByAgentId.get(agent.id),
        hasPendingApproval: pendingApprovalAgentIds.has(agent.id),
        hasInReview: inReviewAgentIds.has(agent.id),
        now,
        allIssues,
        completedIssues,
      });
      map.set(agent.id, behaviorState);
    }
    return map;
  }, [agents, liveRunByAgentId, pendingApprovalAgentIds, inReviewAgentIds, now, allIssues, completedIssues]);

  // Count real behaviors across the office for the top status strip
  const behaviorSummary = useMemo(() => {
    const counts: Record<AgentBehaviorKind, number> = {
      idle: 0,
      "task-assigned": 0,
      "moving-to-seat": 0,
      "working-typing": 0,
      collaborating: 0,
      "approval-waiting": 0,
      "task-completed": 0,
      "blocked-error": 0,
      offline: 0,
    };
    for (const item of behaviorByAgentId.values()) {
      counts[item.behavior] += 1;
    }
    return counts;
  }, [behaviorByAgentId]);

  // Collect real collaborating pairs (never fabricated)
  const activeCollaborations = useMemo(() => {
    const pairs: Array<{ fromName: string; toName: string; taskTitle: string | null }> = [];
    const seen = new Set<string>();
    const nameById = new Map(agents.map((a) => [a.id, a.name]));

    for (const [agentId, bState] of behaviorByAgentId.entries()) {
      for (const peerId of bState.collaboratorIds) {
        const key = [agentId, peerId].sort().join(":");
        if (seen.has(key)) continue;
        seen.add(key);
        const fromName = nameById.get(agentId);
        const toName = nameById.get(peerId);
        if (fromName && toName) {
          pairs.push({
            fromName,
            toName,
            taskTitle: bState.activeIssueTitle,
          });
        }
      }
    }
    return pairs;
  }, [agents, behaviorByAgentId]);

  const handleZoomIn = useCallback(() => {
    setZoomIndex((prev) => Math.min(ZOOM_STEPS.length - 1, prev + 1));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoomIndex((prev) => Math.max(0, prev - 1));
  }, []);

  const handleResetView = useCallback(() => {
    setZoomIndex(2);
    setPanOffset({ x: 0, y: 0 });
  }, []);

  const scrollToZone = useCallback((zoneId: string) => {
    if (typeof document === "undefined") return;
    const el = document.getElementById(zoneId);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, []);

  // Touch pinch-to-zoom & pan support for Mobile (iPhone / Android)
  const handleTouchStart = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      if (e.touches.length === 2) {
        const dx = e.touches[0]!.clientX - e.touches[1]!.clientX;
        const dy = e.touches[0]!.clientY - e.touches[1]!.clientY;
        pinchDistanceRef.current = Math.hypot(dx, dy);
      } else if (e.touches.length === 1 && zoomScale > 1) {
        dragStartRef.current = {
          x: e.touches[0]!.clientX,
          y: e.touches[0]!.clientY,
          originX: panOffset.x,
          originY: panOffset.y,
        };
      }
    },
    [zoomScale, panOffset],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      if (e.touches.length === 2 && pinchDistanceRef.current !== null) {
        const dx = e.touches[0]!.clientX - e.touches[1]!.clientX;
        const dy = e.touches[0]!.clientY - e.touches[1]!.clientY;
        const nextDist = Math.hypot(dx, dy);
        const delta = nextDist - pinchDistanceRef.current;
        if (Math.abs(delta) > 28) {
          if (delta > 0) {
            setZoomIndex((prev) => Math.min(ZOOM_STEPS.length - 1, prev + 1));
          } else {
            setZoomIndex((prev) => Math.max(0, prev - 1));
          }
          pinchDistanceRef.current = nextDist;
        }
      } else if (e.touches.length === 1 && dragStartRef.current && zoomScale > 1) {
        const dx = e.touches[0]!.clientX - dragStartRef.current.x;
        const dy = e.touches[0]!.clientY - dragStartRef.current.y;
        setPanOffset({
          x: Math.max(-240, Math.min(240, dragStartRef.current.originX + dx)),
          y: Math.max(-240, Math.min(240, dragStartRef.current.originY + dy)),
        });
      }
    },
    [zoomScale],
  );

  const handleTouchEnd = useCallback(() => {
    pinchDistanceRef.current = null;
    dragStartRef.current = null;
  }, []);

  function renderAgentWorkstation(agent: Agent, roleOverride?: string, isJarvisSeat?: boolean) {
    const bState = behaviorByAgentId.get(agent.id);
    const seatState = bState?.seatState ?? "idle";
    const behavior = bState?.behavior ?? "idle";

    return (
      <Workstation
        key={agent.id}
        agentId={agent.id}
        name={agent.name}
        role={roleOverride ?? agent.title ?? agent.role}
        liveRun={liveRunByAgentId.get(agent.id)}
        state={seatState}
        behavior={behavior}
        voiceActive={Boolean(isJarvisSeat && isVoiceListening)}
        onClick={() => onSelectAgent(agent.id)}
      />
    );
  }

  function renderDepartmentRoom(room: DepartmentRoomSpec) {
    const orgUnitId = room.orgUnitName ? orgUnitIdByName.get(room.orgUnitName) : undefined;
    const deptAgents = orgUnitId ? agents.filter((agent) => agent.orgUnitId === orgUnitId) : [];
    const isUnmatched = !room.orgUnitName;
    const capacity = computeRoomCapacity(deptAgents.length, !isUnmatched);

    return (
      <RoomBox
        key={room.label}
        label={room.label}
        icon={DoorOpen}
        muted={isUnmatched}
        seatCountBadge={!isUnmatched && deptAgents.length > 0 ? `${deptAgents.length}명 근무` : undefined}
        isExpanded={capacity.isExpandedRoom}
        onOpen={() =>
          onSelectWorkspace({
            kind: "room",
            label: room.label,
            agentIds: deptAgents.map((agent) => agent.id),
          })
        }
      >
        {isUnmatched ? (
          <EmptyRoomNote note="NEXORA 조직 확정 부서 — 아직 실제 org_unit 데이터 없음" />
        ) : deptAgents.length === 0 ? (
          <EmptyRoomNote note="배정 대기 (배정된 AI 직원 없음)" />
        ) : (
          deptAgents.map((agent) => renderAgentWorkstation(agent))
        )}
      </RoomBox>
    );
  }

  return (
    <div
      data-testid="ai-office-topdown-floor"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card/60 p-3 shadow-xs"
    >
      {/* 상단 사무실 탐색·조작 컨트롤 바 (PC & 모바일 공통) */}
      <div
        data-testid="ai-office-floor-toolbar"
        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs"
      >
        {/* 구역 빠른 스크롤 이동 칩 */}
        <div className="flex flex-wrap items-center gap-1.5" role="navigation" aria-label="사무실 구역 빠른 이동">
          <span className="mr-1 inline-flex items-center gap-1 font-semibold text-foreground">
            <Compass className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            <span>평면도 구역 이동:</span>
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => scrollToZone("office-zone-command")}
            data-testid="office-jump-command"
          >
            지휘 본부
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => scrollToZone("office-zone-departments")}
            data-testid="office-jump-departments"
          >
            실무 부서
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => scrollToZone("office-zone-corridor")}
            data-testid="office-jump-corridor"
          >
            회의실·라운지
          </Button>
          {otherOrgUnits.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => scrollToZone("office-zone-expansion")}
              data-testid="office-jump-expansion"
            >
              확장 부서 ({otherOrgUnits.length})
            </Button>
          ) : null}
        </div>

        {/* 확대/축소 및 초기화 컨트롤 */}
        <div className="flex items-center gap-1" data-testid="office-zoom-controls">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={handleZoomOut}
            disabled={zoomIndex === 0}
            aria-label="사무실 화면 축소"
            data-testid="office-zoom-out-btn"
          >
            <ZoomOut className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <span
            className="min-w-12 text-center font-mono text-xs font-medium text-muted-foreground"
            data-testid="office-zoom-level"
          >
            {Math.round(zoomScale * 100)}%
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={handleZoomIn}
            disabled={zoomIndex === ZOOM_STEPS.length - 1}
            aria-label="사무실 화면 확대"
            data-testid="office-zoom-in-btn"
          >
            <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={handleResetView}
            aria-label="사무실 화면 비율 초기화"
            data-testid="office-zoom-reset-btn"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="sr-only">초기화</span>
          </Button>
        </div>
      </div>

      {/* 실시간 9종 직원 행동 상태 스트립 (실제 데이터 기반) */}
      <div
        data-testid="ai-office-behavior-strip"
        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/50 bg-background/60 px-3 py-1.5 text-xs"
      >
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-medium text-muted-foreground">실시간 행동 상태:</span>
          <span className="inline-flex items-center gap-1">
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: "var(--status-agent-running)" } as CSSProperties}
            />
            <span>{AGENT_BEHAVIOR_LABEL["working-typing"]}: {behaviorSummary["working-typing"]}</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: "var(--status-task-in_review)" } as CSSProperties}
            />
            <span>{AGENT_BEHAVIOR_LABEL.collaborating}: {behaviorSummary.collaborating}</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: "var(--status-agent-paused)" } as CSSProperties}
            />
            <span>{AGENT_BEHAVIOR_LABEL["approval-waiting"]}: {behaviorSummary["approval-waiting"]}</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: "var(--status-agent-idle)" } as CSSProperties}
            />
            <span>{AGENT_BEHAVIOR_LABEL.idle}: {behaviorSummary.idle}</span>
          </span>
          {behaviorSummary["task-assigned"] > 0 ? (
            <span className="inline-flex items-center gap-1 font-medium text-primary">
              <span>{AGENT_BEHAVIOR_LABEL["task-assigned"]}: {behaviorSummary["task-assigned"]}</span>
            </span>
          ) : null}
          {behaviorSummary["moving-to-seat"] > 0 ? (
            <span className="inline-flex items-center gap-1 font-medium text-primary">
              <span>{AGENT_BEHAVIOR_LABEL["moving-to-seat"]}: {behaviorSummary["moving-to-seat"]}</span>
            </span>
          ) : null}
          {behaviorSummary["task-completed"] > 0 ? (
            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
              <span>{AGENT_BEHAVIOR_LABEL["task-completed"]}: {behaviorSummary["task-completed"]}</span>
            </span>
          ) : null}
          {behaviorSummary["blocked-error"] > 0 ? (
            <span className="inline-flex items-center gap-1 font-semibold text-destructive">
              <span>{AGENT_BEHAVIOR_LABEL["blocked-error"]}: {behaviorSummary["blocked-error"]}</span>
            </span>
          ) : null}
        </div>
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Maximize2 className="h-3 w-3" aria-hidden="true" />
          <span>상하 스크롤 및 핀치 줌으로 전체 부서 탐색</span>
        </span>
      </div>

      {/* 평면형 2D 픽셀아트 사무실 뷰포트 (상하 스크롤 + 핀치 줌 + 좌우 이동 지원) */}
      <div
        ref={viewportRef}
        data-testid="ai-office-scroll-viewport"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        className="scrollbar-auto-hide relative max-h-screen overflow-x-auto overflow-y-auto rounded-lg border border-border/80 bg-muted/20 p-3"
      >
        <div
          data-testid="ai-office-canvas-stage"
          className="flex flex-col gap-4 transition-transform duration-150 origin-top-left"
          style={
            zoomScale !== 1 || panOffset.x !== 0 || panOffset.y !== 0
              ? ({
                  transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomScale})`,
                } as CSSProperties)
              : undefined
          }
        >
          {/* ── ZONE 1: 상단 지휘 본부 (CEO실 · JARVIS 워크스테이션 · COO석 · 비서실) ── */}
          <div id="office-zone-command" className="space-y-2">
            <div className="flex items-center justify-between px-1 text-xs font-semibold text-muted-foreground">
              <span>1구역 — 지휘 본부 (Executive & Orchestration Wing)</span>
              {isVoiceListening ? (
                <span
                  data-testid="jarvis-voice-active-banner"
                  className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400"
                >
                  <Mic className="h-3 w-3 animate-pulse" aria-hidden="true" />
                  <span>JARVIS 한국어 음성 수신 중</span>
                </span>
              ) : null}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <RoomBox
                label="CEO실"
                icon={Users}
                seatCountBadge={pendingApprovalCount > 0 ? `결재 대기 ${pendingApprovalCount}건` : undefined}
                onOpen={() => onSelectWorkspace({ kind: "ceo", label: "CEO실" })}
              >
                <button
                  type="button"
                  onClick={() => onSelectWorkspace({ kind: "ceo", label: "CEO실" })}
                  className="flex w-40 flex-col items-center gap-1 rounded-md border bg-card p-2 text-center text-xs hover:bg-muted/40"
                  data-testid="ai-office-ceo-seat"
                >
                  <span className="font-medium">서대곤</span>
                  <span className="text-muted-foreground">CEO</span>
                  <SeatBadge state="idle" />
                  <span className="text-muted-foreground">인간 CEO 고정 조직 자리</span>
                </button>
              </RoomBox>

              <RoomBox
                label="JARVIS 워크스테이션"
                icon={Bot}
                onOpen={
                  jarvis
                    ? () =>
                        onSelectWorkspace({
                          kind: "room",
                          label: "JARVIS 워크스테이션",
                          agentIds: [jarvis.id],
                        })
                    : undefined
                }
              >
                {jarvis ? (
                  renderAgentWorkstation(jarvis, "CTO / Orchestrator", true)
                ) : (
                  <EmptySeat caption="DB에서 JARVIS 에이전트를 찾을 수 없습니다." />
                )}
              </RoomBox>

              <RoomBox
                label="COO석"
                icon={Users}
                muted={!atlas}
                onOpen={
                  atlas
                    ? () =>
                        onSelectWorkspace({
                          kind: "room",
                          label: "COO석",
                          agentIds: [atlas.id],
                        })
                    : undefined
                }
              >
                {atlas ? (
                  renderAgentWorkstation(atlas, "COO")
                ) : (
                  <EmptySeat caption="공석 — 아직 Atlas 에이전트가 생성되지 않았습니다." />
                )}
              </RoomBox>

              {renderDepartmentRoom(secretariatRoom)}
            </div>
          </div>

          {/* ── 중앙 가로 복도 (Main Horizontal Hallway) ── */}
          <div
            aria-hidden="true"
            className="flex items-center justify-between rounded border border-dashed border-border/60 bg-background/40 px-3 py-1.5 text-xs text-muted-foreground"
          >
            <span className="font-mono">═══ 중앙 연결 복도 (Main Corridor) ═══</span>
            <span>지휘 본부 ↔ 실무 부서 이동 통로</span>
          </div>

          {/* ── ZONE 2: 핵심 실무 부서 구역 (Master 1차 확정 부서) ── */}
          <div id="office-zone-departments" className="space-y-2">
            <div className="flex items-center justify-between px-1 text-xs font-semibold text-muted-foreground">
              <span>2구역 — 핵심 실무 부서 (Core Operations Rooms)</span>
              <span>신규 직원 채용 시 소속 부서 빈 좌석에 자동 배정</span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {departmentRooms.slice(1).map((room) => renderDepartmentRoom(room))}
            </div>
          </div>

          {/* ── ZONE 3: 중앙 협업 회의실 · 라운지 · 공용 홀 ── */}
          <div id="office-zone-corridor" className="space-y-2">
            <div className="flex items-center justify-between px-1 text-xs font-semibold text-muted-foreground">
              <span>3구역 — 협업 회의실 및 공용 공간 (Collaboration & Lounge)</span>
              {activeCollaborations.length > 0 ? (
                <span
                  data-testid="office-active-collaboration-badge"
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary"
                >
                  <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>실시간 협업 진행 {activeCollaborations.length}건</span>
                </span>
              ) : null}
            </div>

            {activeCollaborations.length > 0 ? (
              <div
                data-testid="office-collaboration-banner"
                className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background/70 px-3 py-2 text-xs"
              >
                <span className="font-semibold text-foreground">실시간 협업 연결:</span>
                {activeCollaborations.map((pair, idx) => (
                  <span
                    key={`${pair.fromName}-${pair.toName}-${idx}`}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2.5 py-0.5"
                  >
                    <span className="font-medium">{pair.fromName}</span>
                    <span>↔</span>
                    <span className="font-medium">{pair.toName}</span>
                    {pair.taskTitle ? (
                      <span className="max-w-48 truncate text-muted-foreground">({pair.taskTitle})</span>
                    ) : null}
                  </span>
                ))}
              </div>
            ) : null}

            {/* 최소 공간 표현 — 장식/시설물. 조직 Room(RoomBox)과 달리 헤더가 없는
                별도 AmenityTile로 렌더해 "조직처럼 보이는" 문제를 구조적으로 차단. */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <AmenityTile icon={Sofa} label="회의실" />
              <AmenityTile icon={Coffee} label="라운지" />
              <AmenityTile icon={Sprout} />
              <AmenityTile icon={Sprout} />
            </div>
          </div>

          {/* ── ZONE 4: 전문 부서 및 하단 자동 확장 구역 (상하 스크롤 탐색) ── */}
          {otherOrgUnits.length > 0 ? (
            <div id="office-zone-expansion" className="space-y-2 border-t border-border/70 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-medium text-muted-foreground">
                  기타 / 미배정 조직 (Master 1차 정식 부서 아님 — 실제 데이터만 표시)
                </h2>
                <span className="text-xs text-muted-foreground">
                  신규 부서 생성 시 아래로 자동 확장 (상하 스크롤 탐색)
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {otherOrgUnits.map((unit) => {
                  const unitAgents = agents.filter((agent) => agent.orgUnitId === unit.orgUnitId);
                  const capacity = computeRoomCapacity(unitAgents.length, true);
                  return (
                    <RoomBox
                      key={unit.orgUnitId}
                      label={unit.name}
                      icon={Building2}
                      muted={unitAgents.length === 0}
                      seatCountBadge={unitAgents.length > 0 ? `${unitAgents.length}명 근무` : undefined}
                      isExpanded={capacity.isExpandedRoom}
                      onOpen={() =>
                        onSelectWorkspace({
                          kind: "room",
                          label: unit.name,
                          agentIds: unitAgents.map((agent) => agent.id),
                        })
                      }
                    >
                      {unitAgents.length === 0 ? (
                        <EmptyRoomNote note="배정된 AI 직원 없음" />
                      ) : (
                        unitAgents.map((agent) => renderAgentWorkstation(agent))
                      )}
                    </RoomBox>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
