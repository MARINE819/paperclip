import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalService } from "../services/approvals.ts";

// Stage 8 — Web Push approval notification wiring. Verifies:
// 1. A new approval triggers exactly one best-effort push send.
// 2. Push failure never fails/blocks approval creation (best-effort contract).
// 3. Notification payload carries no secrets — only id/type/title/url.
// 4. Unconfigured push (isAvailable() === false) is a silent no-op, not an error.

const mockSendNotificationToUser = vi.hoisted(() => vi.fn());
const mockIsAvailable = vi.hoisted(() => vi.fn(() => true));

vi.mock("../services/web-push-service.js", () => ({
  webPushService: vi.fn(() => ({
    isAvailable: mockIsAvailable,
    sendNotificationToUser: mockSendNotificationToUser,
  })),
}));

vi.mock("../services/agents.js", () => ({ agentService: vi.fn(() => ({})) }));
vi.mock("../services/budgets.js", () => ({ budgetService: vi.fn(() => ({})) }));
vi.mock("../services/hire-hook.js", () => ({ notifyHireApproved: vi.fn() }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: vi.fn(() => ({})) }));

function createDbStub(input: { insertedRow: Record<string, unknown>; company: Record<string, unknown> | null }) {
  const returning = vi.fn(async () => [input.insertedRow]);
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));

  const from = vi.fn((_table: unknown) => ({
    where: vi.fn(async () => (input.company ? [input.company] : [])),
  }));
  const select = vi.fn((_cols: unknown) => ({ from }));

  return { db: { insert, select } as any, insert, values, returning };
}

describe("approvalService.create — Web Push notification wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAvailable.mockReturnValue(true);
    mockSendNotificationToUser.mockResolvedValue({ sent: 1, failed: 0 });
  });

  const insertedRow = {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    status: "pending",
    payload: { title: "Voice Command: Request Authorization to Pause Company" },
    requestedByAgentId: null,
    expiresAt: null,
  };

  it("sends exactly one push notification after a new approval is created", async () => {
    const { db } = createDbStub({
      insertedRow,
      company: { defaultResponsibleUserId: "board-owner-1" },
    });
    const svc = approvalService(db);

    const created = await svc.create("company-1", {
      type: "request_board_approval",
      payload: insertedRow.payload,
      status: "pending",
    } as any);

    expect(created).toEqual(insertedRow);
    expect(mockSendNotificationToUser).toHaveBeenCalledTimes(1);
    const call = mockSendNotificationToUser.mock.calls[0]![0];
    expect(call.companyId).toBe("company-1");
    expect(call.userId).toBe("board-owner-1");

    // Payload is minimal — only id/type/title/url, never anything secret.
    expect(call.notification).toEqual({
      title: "Voice Command: Request Authorization to Pause Company",
      body: "Type: request_board_approval",
      url: "/mobile/approvals/approval-1",
      tag: "approval-approval-1",
    });
    expect(JSON.stringify(call.notification)).not.toMatch(/token|secret|password|key/i);
  });

  it("falls back to the local-board user when the company has no defaultResponsibleUserId", async () => {
    const { db } = createDbStub({ insertedRow, company: { defaultResponsibleUserId: null } });
    const svc = approvalService(db);

    await svc.create("company-1", {
      type: "request_board_approval",
      payload: insertedRow.payload,
      status: "pending",
    } as any);

    expect(mockSendNotificationToUser).toHaveBeenCalledTimes(1);
    expect(mockSendNotificationToUser.mock.calls[0]![0].userId).toBe("local-board");
  });

  it("still returns the created approval when push is unconfigured (isAvailable() === false) — silent no-op", async () => {
    mockIsAvailable.mockReturnValue(false);
    const { db } = createDbStub({ insertedRow, company: { defaultResponsibleUserId: "board-owner-1" } });
    const svc = approvalService(db);

    const created = await svc.create("company-1", {
      type: "request_board_approval",
      payload: insertedRow.payload,
      status: "pending",
    } as any);

    expect(created).toEqual(insertedRow);
    expect(mockSendNotificationToUser).not.toHaveBeenCalled();
  });

  it("still returns the created approval when the push send itself throws — approval creation is never blocked or failed by a push error", async () => {
    mockSendNotificationToUser.mockRejectedValue(new Error("push endpoint returned 410 Gone"));
    const { db } = createDbStub({ insertedRow, company: { defaultResponsibleUserId: "board-owner-1" } });
    const svc = approvalService(db);

    await expect(
      svc.create("company-1", {
        type: "request_board_approval",
        payload: insertedRow.payload,
        status: "pending",
      } as any),
    ).resolves.toEqual(insertedRow);
  });
});
