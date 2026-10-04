// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { Agent, Approval } from "@paperclipai/shared";
import type { OrgNode } from "../api/agents";
import { AIOfficeControlTower, deriveAgentCondition, OFFLINE_AFTER_MS } from "./AIOfficeControlTower";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Alpha",
    urlKey: "alpha",
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    orgUnitId: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

interface TestOrgNode {
  id: string;
  name: string;
  role: string;
  status: string;
  reports: TestOrgNode[];
}

function makeOrgNode(overrides: Partial<TestOrgNode> = {}): TestOrgNode {
  return {
    id: "agent-root",
    name: "JARVIS",
    role: "ceo",
    status: "active",
    reports: [],
    ...overrides,
  };
}

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    requestedByAgentId: null,
    requestedByUserId: null,
    status: "pending",
    payload: {},
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-09-17T11:55:00.000Z"),
    updatedAt: new Date("2026-09-17T11:55:00.000Z"),
    ...overrides,
  };
}

describe("deriveAgentCondition (Stage 9 offline/error contract)", () => {
  it("returns 'error' first regardless of anything else", () => {
    expect(deriveAgentCondition({ status: "error", lastHeartbeatAt: new Date() }, true)).toBe("error");
  });

  it("excludes a 'running' agent even with a stale heartbeat", () => {
    expect(
      deriveAgentCondition(
        { status: "running", lastHeartbeatAt: new Date(Date.now() - 60 * 60_000) },
        false,
      ),
    ).toBeNull();
  });

  it("excludes an agent with a current live run even if idle and stale", () => {
    expect(
      deriveAgentCondition(
        { status: "idle", lastHeartbeatAt: new Date(Date.now() - 60 * 60_000) },
        true,
      ),
    ).toBeNull();
  });

  it("treats a null lastHeartbeatAt as offline", () => {
    expect(deriveAgentCondition({ status: "idle", lastHeartbeatAt: null }, false)).toBe("offline");
  });

  it("treats more than 30 minutes stale as offline", () => {
    const now = Date.now();
    expect(
      deriveAgentCondition({ status: "idle", lastHeartbeatAt: new Date(now - 31 * 60_000) }, false, now),
    ).toBe("offline");
  });

  it("does not treat less than 30 minutes stale as offline", () => {
    const now = Date.now();
    expect(
      deriveAgentCondition({ status: "idle", lastHeartbeatAt: new Date(now - 29 * 60_000) }, false, now),
    ).toBeNull();
  });

  it("exposes the 30-minute threshold as OFFLINE_AFTER_MS", () => {
    expect(OFFLINE_AFTER_MS).toBe(30 * 60 * 1000);
  });
});

describe("AIOfficeControlTower", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  function render(props: Parameters<typeof AIOfficeControlTower>[0]) {
    const root = createRoot(container);
    act(() => {
      root.render(<AIOfficeControlTower {...props} />);
    });
    return root;
  }

  it("shows 'No hierarchy data.' for an empty org tree", () => {
    const root = render({
      orgTree: [],
      agentsById: new Map(),
      orgUnitNameById: new Map(),
      liveRunByAgentId: new Map(),
      pendingApprovalByAgentId: new Map(),
    });

    expect(container.textContent).toContain("No hierarchy data.");

    act(() => root.unmount());
  });

  it("renders the real reportsTo hierarchy (root and nested child) without fabricating nodes", () => {
    const orgTree = [
      makeOrgNode({
        id: "agent-root",
        name: "JARVIS",
        role: "ceo",
        status: "error",
        reports: [makeOrgNode({ id: "agent-child", name: "강건", role: "general", status: "idle", reports: [] })],
      }),
    ] as OrgNode[];
    const root = render({
      orgTree,
      agentsById: new Map([
        ["agent-root", makeAgent({ id: "agent-root", name: "JARVIS", status: "error" })],
        ["agent-child", makeAgent({ id: "agent-child", name: "강건", status: "idle" })],
      ]),
      orgUnitNameById: new Map(),
      liveRunByAgentId: new Map(),
      pendingApprovalByAgentId: new Map(),
    });

    expect(container.textContent).toContain("JARVIS");
    expect(container.textContent).toContain("강건");
    expect(container.textContent).not.toContain("Atlas");

    act(() => root.unmount());
  });

  it("shows the agent status badge for each node", () => {
    const orgTree = [makeOrgNode({ id: "agent-1", name: "Alpha", status: "idle", reports: [] })] as OrgNode[];
    const root = render({
      orgTree,
      agentsById: new Map([["agent-1", makeAgent({ id: "agent-1", status: "idle" })]]),
      orgUnitNameById: new Map(),
      liveRunByAgentId: new Map(),
      pendingApprovalByAgentId: new Map(),
    });

    expect(container.textContent).toContain("idle");

    act(() => root.unmount());
  });

  it("shows the current work (Running (status)) when a live run exists", () => {
    const orgTree = [makeOrgNode({ id: "agent-1", name: "Alpha", reports: [] })] as OrgNode[];
    const root = render({
      orgTree,
      agentsById: new Map([["agent-1", makeAgent({ id: "agent-1" })]]),
      orgUnitNameById: new Map(),
      liveRunByAgentId: new Map([["agent-1", { status: "running" }]]),
      pendingApprovalByAgentId: new Map(),
    });

    expect(container.textContent).toContain("Task: Running (running)");

    act(() => root.unmount());
  });

  it("shows queued as the live run status when queued", () => {
    const orgTree = [makeOrgNode({ id: "agent-1", name: "Alpha", reports: [] })] as OrgNode[];
    const root = render({
      orgTree,
      agentsById: new Map([["agent-1", makeAgent({ id: "agent-1" })]]),
      orgUnitNameById: new Map(),
      liveRunByAgentId: new Map([["agent-1", { status: "queued" }]]),
      pendingApprovalByAgentId: new Map(),
    });

    expect(container.textContent).toContain("Task: Running (queued)");

    act(() => root.unmount());
  });

  it("shows '—' for current work when there is no live run", () => {
    const orgTree = [makeOrgNode({ id: "agent-1", name: "Alpha", reports: [] })] as OrgNode[];
    const root = render({
      orgTree,
      agentsById: new Map([["agent-1", makeAgent({ id: "agent-1" })]]),
      orgUnitNameById: new Map(),
      liveRunByAgentId: new Map(),
      pendingApprovalByAgentId: new Map(),
    });

    expect(container.textContent).toContain("Task: —");

    act(() => root.unmount());
  });

  it("shows a pending approval indicator when one exists for the agent", () => {
    const orgTree = [makeOrgNode({ id: "agent-1", name: "Alpha", reports: [] })] as OrgNode[];
    const root = render({
      orgTree,
      agentsById: new Map([["agent-1", makeAgent({ id: "agent-1" })]]),
      orgUnitNameById: new Map(),
      liveRunByAgentId: new Map(),
      pendingApprovalByAgentId: new Map([["agent-1", makeApproval({ status: "pending" })]]),
    });

    expect(container.textContent).toContain("Approval: pending");

    act(() => root.unmount());
  });

  it("shows a revision_requested approval indicator when applicable", () => {
    const orgTree = [makeOrgNode({ id: "agent-1", name: "Alpha", reports: [] })] as OrgNode[];
    const root = render({
      orgTree,
      agentsById: new Map([["agent-1", makeAgent({ id: "agent-1" })]]),
      orgUnitNameById: new Map(),
      liveRunByAgentId: new Map(),
      pendingApprovalByAgentId: new Map([["agent-1", makeApproval({ status: "revision_requested" })]]),
    });

    expect(container.textContent).toContain("Approval: revision_requested");

    act(() => root.unmount());
  });

  it("shows no approval indicator when there is none for the agent", () => {
    const orgTree = [makeOrgNode({ id: "agent-1", name: "Alpha", reports: [] })] as OrgNode[];
    const root = render({
      orgTree,
      agentsById: new Map([["agent-1", makeAgent({ id: "agent-1" })]]),
      orgUnitNameById: new Map(),
      liveRunByAgentId: new Map(),
      pendingApprovalByAgentId: new Map(),
    });

    expect(container.textContent).not.toContain("Approval:");

    act(() => root.unmount());
  });

  it("shows the 'error' condition badge for an agent with status=error", () => {
    const orgTree = [makeOrgNode({ id: "agent-1", name: "Alpha", status: "error", reports: [] })] as OrgNode[];
    const root = render({
      orgTree,
      agentsById: new Map([["agent-1", makeAgent({ id: "agent-1", status: "error", lastHeartbeatAt: new Date() })]]),
      orgUnitNameById: new Map(),
      liveRunByAgentId: new Map(),
      pendingApprovalByAgentId: new Map(),
    });

    expect(container.textContent).toContain("error");

    act(() => root.unmount());
  });

  it("shows the 'offline' condition badge for a stale idle agent with no live run", () => {
    const orgTree = [makeOrgNode({ id: "agent-1", name: "Alpha", status: "idle", reports: [] })] as OrgNode[];
    const root = render({
      orgTree,
      agentsById: new Map([
        ["agent-1", makeAgent({ id: "agent-1", status: "idle", lastHeartbeatAt: new Date(Date.now() - 45 * 60_000) })],
      ]),
      orgUnitNameById: new Map(),
      liveRunByAgentId: new Map(),
      pendingApprovalByAgentId: new Map(),
    });

    expect(container.textContent).toContain("offline");

    act(() => root.unmount());
  });

  it("does not show a condition badge for a stale agent that has a current live run", () => {
    const orgTree = [makeOrgNode({ id: "agent-1", name: "Alpha", status: "idle", reports: [] })] as OrgNode[];
    const root = render({
      orgTree,
      agentsById: new Map([
        ["agent-1", makeAgent({ id: "agent-1", status: "idle", lastHeartbeatAt: new Date(Date.now() - 45 * 60_000) })],
      ]),
      orgUnitNameById: new Map(),
      liveRunByAgentId: new Map([["agent-1", { status: "running" }]]),
      pendingApprovalByAgentId: new Map(),
    });

    expect(container.textContent).not.toContain("offline");
    expect(container.textContent).not.toContain("error");

    act(() => root.unmount());
  });

  it("shows the mapped department name when the agent has an orgUnitId", () => {
    const orgTree = [makeOrgNode({ id: "agent-1", name: "Alpha", reports: [] })] as OrgNode[];
    const root = render({
      orgTree,
      agentsById: new Map([["agent-1", makeAgent({ id: "agent-1", orgUnitId: "org-unit-1" })]]),
      orgUnitNameById: new Map([["org-unit-1", "Engineering"]]),
      liveRunByAgentId: new Map(),
      pendingApprovalByAgentId: new Map(),
    });

    expect(container.textContent).toContain("Dept: Engineering");

    act(() => root.unmount());
  });

  it("shows 'Unassigned' for an agent with no orgUnitId, honestly, not a fabricated department", () => {
    const orgTree = [makeOrgNode({ id: "agent-1", name: "Alpha", reports: [] })] as OrgNode[];
    const root = render({
      orgTree,
      agentsById: new Map([["agent-1", makeAgent({ id: "agent-1", orgUnitId: null })]]),
      orgUnitNameById: new Map([["org-unit-1", "Engineering"]]),
      liveRunByAgentId: new Map(),
      pendingApprovalByAgentId: new Map(),
    });

    expect(container.textContent).toContain("Dept: Unassigned");

    act(() => root.unmount());
  });

  it("does not use a fixed grid-cols layout (mobile-safe absolute/flow layout)", () => {
    const orgTree = [makeOrgNode({ id: "agent-1", name: "Alpha", reports: [] })] as OrgNode[];
    const root = render({
      orgTree,
      agentsById: new Map([["agent-1", makeAgent({ id: "agent-1" })]]),
      orgUnitNameById: new Map(),
      liveRunByAgentId: new Map(),
      pendingApprovalByAgentId: new Map(),
    });

    expect(container.querySelector('[class*="grid-cols-"]')).toBeNull();
    expect(container.querySelector(".overflow-auto")).not.toBeNull();

    act(() => root.unmount());
  });
});
