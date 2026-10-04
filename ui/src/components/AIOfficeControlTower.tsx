import type { Agent, Approval } from "@paperclipai/shared";
import type { OrgNode } from "@/api/agents";
import { AgentStatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";

// Single source of truth for the Stage 9 offline/error contract, reused by
// both this component and AIOfficeStatus.tsx's Error/Offline Agents section:
// error status wins outright; a "running" status or an existing live run
// both count as actively working and are never flagged; only past that does
// a missing/stale heartbeat (> 30 minutes) count as offline.
export const OFFLINE_AFTER_MS = 30 * 60 * 1000;

export function deriveAgentCondition(
  agent: Pick<Agent, "status" | "lastHeartbeatAt">,
  hasLiveRun: boolean,
  now: number = Date.now(),
): "error" | "offline" | null {
  if (agent.status === "error") return "error";
  if (agent.status === "running") return null;
  if (hasLiveRun) return null;
  if (!agent.lastHeartbeatAt) return "offline";
  return now - new Date(agent.lastHeartbeatAt).getTime() > OFFLINE_AFTER_MS ? "offline" : null;
}

// ── 2D tree layout (same algorithm as OrgChart.tsx's local layoutTree/
// layoutForest, reimplemented here since those are page-local and not
// exported — OrgChart.tsx itself is intentionally left untouched). ──
const CARD_W = 200;
const CARD_H = 136;
const GAP_X = 24;
const GAP_Y = 56;
const PADDING = 24;

interface LayoutNode {
  node: OrgNode;
  x: number;
  y: number;
  children: LayoutNode[];
}

function subtreeWidth(node: OrgNode): number {
  if (node.reports.length === 0) return CARD_W;
  const childrenW = node.reports.reduce((sum, c) => sum + subtreeWidth(c), 0);
  const gaps = (node.reports.length - 1) * GAP_X;
  return Math.max(CARD_W, childrenW + gaps);
}

function layoutTree(node: OrgNode, x: number, y: number): LayoutNode {
  const totalW = subtreeWidth(node);
  const children: LayoutNode[] = [];
  if (node.reports.length > 0) {
    const childrenW = node.reports.reduce((sum, c) => sum + subtreeWidth(c), 0);
    const gaps = (node.reports.length - 1) * GAP_X;
    let cx = x + (totalW - childrenW - gaps) / 2;
    for (const child of node.reports) {
      const cw = subtreeWidth(child);
      children.push(layoutTree(child, cx, y + CARD_H + GAP_Y));
      cx += cw + GAP_X;
    }
  }
  return { node, x: x + (totalW - CARD_W) / 2, y, children };
}

function layoutForest(roots: OrgNode[]): LayoutNode[] {
  let x = PADDING;
  const y = PADDING;
  const result: LayoutNode[] = [];
  for (const root of roots) {
    const w = subtreeWidth(root);
    result.push(layoutTree(root, x, y));
    x += w + GAP_X;
  }
  return result;
}

function flattenLayout(nodes: LayoutNode[]): LayoutNode[] {
  const result: LayoutNode[] = [];
  function walk(n: LayoutNode) {
    result.push(n);
    n.children.forEach(walk);
  }
  nodes.forEach(walk);
  return result;
}

function collectEdges(nodes: LayoutNode[]): Array<{ parent: LayoutNode; child: LayoutNode }> {
  const edges: Array<{ parent: LayoutNode; child: LayoutNode }> = [];
  function walk(n: LayoutNode) {
    for (const c of n.children) {
      edges.push({ parent: n, child: c });
      walk(c);
    }
  }
  nodes.forEach(walk);
  return edges;
}

export interface AIOfficeControlTowerProps {
  orgTree: OrgNode[];
  agentsById: Map<string, Agent>;
  orgUnitNameById: Map<string, string>;
  liveRunByAgentId: Map<string, { status: string }>;
  pendingApprovalByAgentId: Map<string, Approval>;
}

export function AIOfficeControlTower({
  orgTree,
  agentsById,
  orgUnitNameById,
  liveRunByAgentId,
  pendingApprovalByAgentId,
}: AIOfficeControlTowerProps) {
  if (orgTree.length === 0) {
    return <div className="text-sm text-muted-foreground">No hierarchy data.</div>;
  }

  const layout = layoutForest(orgTree);
  const flat = flattenLayout(layout);
  const edges = collectEdges(layout);
  const now = Date.now();

  const width = Math.max(...flat.map((n) => n.x + CARD_W)) + PADDING;
  const height = Math.max(...flat.map((n) => n.y + CARD_H)) + PADDING;

  return (
    <div className="overflow-auto rounded-md border">
      <div className="relative" style={{ width, height }}>
        <svg className="absolute inset-0 text-border" width={width} height={height}>
          {edges.map(({ parent, child }, index) => (
            <line
              key={index}
              x1={parent.x + CARD_W / 2}
              y1={parent.y + CARD_H}
              x2={child.x + CARD_W / 2}
              y2={child.y}
              stroke="currentColor"
              strokeWidth={1.5}
            />
          ))}
        </svg>
        {flat.map(({ node, x, y }) => {
          const agent = agentsById.get(node.id);
          const liveRun = liveRunByAgentId.get(node.id);
          const approval = pendingApprovalByAgentId.get(node.id);
          const condition = agent ? deriveAgentCondition(agent, !!liveRun, now) : null;
          const departmentName = agent?.orgUnitId ? orgUnitNameById.get(agent.orgUnitId) ?? "Unassigned" : "Unassigned";

          return (
            <div
              key={node.id}
              className="absolute flex flex-col gap-1 rounded-md border bg-card p-2 text-xs"
              style={{ left: x, top: y, width: CARD_W, height: CARD_H }}
            >
              <div className="flex flex-wrap items-center gap-1">
                <span className="truncate font-medium">{node.name}</span>
                <AgentStatusBadge status={node.status} />
              </div>
              <span className="text-muted-foreground">{node.role}</span>
              {condition ? <Badge variant="destructive">{condition}</Badge> : null}
              <span className="truncate text-muted-foreground">
                Task: {liveRun ? `Running (${liveRun.status})` : "—"}
              </span>
              <span className="truncate text-muted-foreground">Dept: {departmentName}</span>
              {approval ? <Badge variant="secondary">Approval: {approval.status}</Badge> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
