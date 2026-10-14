import { beforeEach, describe, expect, it } from "vitest";
import {
  isMuted,
  setMuted,
  toggleMuted,
  isDocumentVisible,
  isCooldownActive,
  recordPlayed,
  clearCooldowns,
  canPlayChime,
  playApprovalChime,
} from "./audio-chime";

describe("audio-chime", () => {
  let mockStorage: Record<string, string>;

  beforeEach(() => {
    mockStorage = {};
    clearCooldowns();

    const fakeLocalStorage = {
      getItem: (key: string) => mockStorage[key] ?? null,
      setItem: (key: string, value: string) => {
        mockStorage[key] = value;
      },
      removeItem: (key: string) => {
        delete mockStorage[key];
      },
      clear: () => {
        mockStorage = {};
      },
    };

    (globalThis as any).window = {
      localStorage: fakeLocalStorage,
    };

    (globalThis as any).document = {
      visibilityState: "visible",
    };
  });

  describe("mute persistence", () => {
    it("defaults to unmuted when no preference is stored", () => {
      expect(isMuted()).toBe(false);
    });

    it("persists muted state in localStorage", () => {
      setMuted(true);
      expect(isMuted()).toBe(true);
      expect(mockStorage["paperclip.approval_chime_muted"]).toBe("true");

      setMuted(false);
      expect(isMuted()).toBe(false);
      expect(mockStorage["paperclip.approval_chime_muted"]).toBe("false");
    });

    it("toggles mute state correctly", () => {
      expect(isMuted()).toBe(false);

      const firstToggle = toggleMuted();
      expect(firstToggle).toBe(true);
      expect(isMuted()).toBe(true);

      const secondToggle = toggleMuted();
      expect(secondToggle).toBe(false);
      expect(isMuted()).toBe(false);
    });

    it("prevents chime when muted", async () => {
      setMuted(true);

      expect(canPlayChime("req-1")).toBe(false);

      const played = await playApprovalChime("req-1");
      expect(played).toBe(false);
    });
  });

  describe("visibility check", () => {
    it("allows chime when document is visible", async () => {
      (globalThis as any).document.visibilityState = "visible";

      expect(isDocumentVisible()).toBe(true);
      expect(canPlayChime("req-vis-1")).toBe(true);

      const played = await playApprovalChime("req-vis-1");
      expect(played).toBe(true);
    });

    it("prevents chime when document is hidden", async () => {
      (globalThis as any).document.visibilityState = "hidden";

      expect(isDocumentVisible()).toBe(false);
      expect(canPlayChime("req-vis-2")).toBe(false);

      const played = await playApprovalChime("req-vis-2");
      expect(played).toBe(false);
    });
  });

  describe("cooldown management", () => {
    it("allows first chime for a request ID and blocks immediate duplicate", async () => {
      const requestId = "req-approval-100";

      expect(canPlayChime(requestId)).toBe(true);

      const playedFirst = await playApprovalChime(requestId);
      expect(playedFirst).toBe(true);

      expect(isCooldownActive(requestId)).toBe(true);
      expect(canPlayChime(requestId)).toBe(false);

      const playedSecond = await playApprovalChime(requestId);
      expect(playedSecond).toBe(false);
    });

    it("allows different request IDs independently", async () => {
      const played1 = await playApprovalChime("req-a");
      expect(played1).toBe(true);

      const played2 = await playApprovalChime("req-b");
      expect(played2).toBe(true);
    });

    it("allows chime again once cooldown expires", () => {
      const requestId = "req-timed";
      const now = 10000;

      recordPlayed(requestId, now);

      expect(isCooldownActive(requestId, 10000, now + 5000)).toBe(true);
      expect(isCooldownActive(requestId, 10000, now + 10001)).toBe(false);
    });

    it("clears cooldowns properly", async () => {
      await playApprovalChime("req-clear");
      expect(canPlayChime("req-clear")).toBe(false);

      clearCooldowns();
      expect(canPlayChime("req-clear")).toBe(true);
    });
  });
});