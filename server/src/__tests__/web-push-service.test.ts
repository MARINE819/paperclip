import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { webPushService } from "../services/web-push-service.js";
import { pushSubscriptions } from "@paperclipai/db";
import webpush from "web-push";

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
  },
}));

describe("webPushService", () => {
  const originalEnv = { ...process.env };
  const companyId = "c1111111-1111-4111-8111-111111111111";
  const userId = "local-board";

  let savedSubscriptions: any[] = [];
  let deletedSubscriptions: any[] = [];

  function createMockDb() {
    savedSubscriptions = [];
    deletedSubscriptions = [];

    const db: any = {
      select: vi.fn(() => ({
        from: vi.fn((table) => ({
          where: vi.fn(() => {
            if (table === pushSubscriptions) {
              return Promise.resolve(savedSubscriptions);
            }
            return Promise.resolve([]);
          }),
        })),
      })),
      insert: vi.fn((table) => ({
        values: vi.fn((vals) => {
          return {
            onConflictDoUpdate: vi.fn(() => {
              const row = { id: `sub-${savedSubscriptions.length + 1}`, ...vals };
              savedSubscriptions.push(row);
              return {
                returning: () => Promise.resolve([row]),
              };
            }),
          };
        }),
      })),
      delete: vi.fn((table) => ({
        where: vi.fn((condition) => {
          deletedSubscriptions.push(condition);
          return {
            returning: () => Promise.resolve([{ id: "sub-1" }]),
            catch: vi.fn(() => Promise.resolve()),
          };
        }),
      })),
    };

    return db;
  }

  beforeEach(() => {
    delete process.env.PAPERCLIP_VAPID_PUBLIC_KEY;
    delete process.env.PAPERCLIP_VAPID_PRIVATE_KEY;
    delete process.env.PAPERCLIP_VAPID_SUBJECT;
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("Fail-Closed behavior when VAPID is missing", () => {
    it("reports service is unconfigured and throws 503 on critical operations", async () => {
      const db = createMockDb();
      const service = webPushService(db);

      expect(service.isAvailable()).toBe(false);

      expect(() => service.getPublicKey()).toThrowError(
        expect.objectContaining({ status: 503 }),
      );

      await expect(
        service.subscribe({
          companyId,
          userId,
          endpoint: "https://push.example.com/sub/1",
          p256dh: "key-1",
          auth: "auth-1",
        }),
      ).rejects.toThrowError(expect.objectContaining({ status: 503 }));
    });

    it("safely no-ops on push send without crashing", async () => {
      const db = createMockDb();
      const service = webPushService(db);

      const result = await service.sendNotificationToUser({
        companyId,
        userId,
        notification: {
          title: "Approval Needed",
          body: "Agent requested approval",
        },
      });

      expect(result.sent).toBe(0);
      expect(result.reason).toBe("push_unconfigured");
      expect(webpush.sendNotification).not.toHaveBeenCalled();
    });
  });

  describe("Configured behavior", () => {
    beforeEach(() => {
      process.env.PAPERCLIP_VAPID_PUBLIC_KEY = "test-public-key";
      process.env.PAPERCLIP_VAPID_PRIVATE_KEY = "test-private-key";
      process.env.PAPERCLIP_VAPID_SUBJECT = "mailto:ops@paperclip.local";
    });

    it("reports available and returns public key", () => {
      const db = createMockDb();
      const service = webPushService(db);

      expect(service.isAvailable()).toBe(true);
      expect(service.getPublicKey()).toBe("test-public-key");
    });

    it("subscribes and stores subscription safely", async () => {
      const db = createMockDb();
      const service = webPushService(db);

      const sub = await service.subscribe({
        companyId,
        userId,
        endpoint: "https://push.example.com/sub/1",
        p256dh: "key-1",
        auth: "auth-1",
      });

      expect(sub).toBeDefined();
      expect(savedSubscriptions.length).toBe(1);
      expect(savedSubscriptions[0].endpoint).toBe("https://push.example.com/sub/1");
    });

    it("sends notifications and purges stale subscriptions on 410 Gone", async () => {
      const db = createMockDb();
      savedSubscriptions.push({
        id: "sub-stale",
        companyId,
        userId,
        endpoint: "https://push.example.com/sub/expired",
        p256dh: "key-1",
        auth: "auth-1",
      });

      const staleError: any = new Error("Subscription expired");
      staleError.statusCode = 410;
      vi.mocked(webpush.sendNotification).mockRejectedValueOnce(staleError);

      const service = webPushService(db);
      const result = await service.sendNotificationToUser({
        companyId,
        userId,
        notification: {
          title: "Approval Needed",
          body: "Review agent plan",
        },
      });

      expect(result.sent).toBe(0);
      expect(result.failed).toBe(1);
      // Verify stale subscription was pruned
      expect(db.delete).toHaveBeenCalled();
    });
  });
});
