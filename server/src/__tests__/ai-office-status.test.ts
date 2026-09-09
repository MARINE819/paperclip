import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { aiOfficeRoutes } from "../routes/ai-office.js";
import {
  checkPidLiveness,
  getAIOfficeStatus,
  sanitizeDatabaseUrl,
} from "../services/ai-office-status.js";

describe("checkPidLiveness", () => {
  it("returns dead for non-positive or invalid pids", () => {
    expect(checkPidLiveness(0)).toBe("dead");
    expect(checkPidLiveness(-10)).toBe("dead");
    expect(checkPidLiveness(NaN)).toBe("dead");
  });

  it("returns alive when process signal 0 succeeds", () => {
    const killMock = () => {};
    expect(checkPidLiveness(1234, killMock)).toBe("alive");
  });

  it("returns alive when kill throws EPERM (Windows cross-account service alive)", () => {
    const killMock = () => {
      const err = new Error("operation not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    };
    expect(checkPidLiveness(1234, killMock)).toBe("alive");
  });

  it("returns dead when kill throws ESRCH (process not found)", () => {
    const killMock = () => {
      const err = new Error("no such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    };
    expect(checkPidLiveness(1234, killMock)).toBe("dead");
  });

  it("returns unknown when kill throws unexpected error", () => {
    const killMock = () => {
      const err = new Error("invalid argument") as NodeJS.ErrnoException;
      err.code = "EINVAL";
      throw err;
    };
    expect(checkPidLiveness(1234, killMock)).toBe("unknown");
  });
});

describe("sanitizeDatabaseUrl", () => {
  it("masks password in connection strings", () => {
    const url = "postgres://paperclip:mysecretpw@127.0.0.1:54329/paperclip";
    expect(sanitizeDatabaseUrl(url)).toBe("postgres://paperclip:***@127.0.0.1:54329/paperclip");
  });

  it("preserves urls without password", () => {
    const url = "postgres://paperclip@127.0.0.1:54329/paperclip";
    expect(sanitizeDatabaseUrl(url)).toBe("postgres://paperclip@127.0.0.1:54329/paperclip");
  });

  it("provides sanitized fallback when url is undefined", () => {
    expect(sanitizeDatabaseUrl(undefined, 54329)).toBe("postgres://paperclip:***@127.0.0.1:54329/paperclip");
    expect(sanitizeDatabaseUrl(undefined, 5432)).toBe("postgres://paperclip:***@127.0.0.1:5432/paperclip");
  });

  it("returns safe fallback on invalid url string", () => {
    expect(sanitizeDatabaseUrl("not a url")).toBe("postgres://***@***");
  });
});

describe("getAIOfficeStatus service", () => {
  function makeTempInstance() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-office-status-"));
    const logsDir = path.join(root, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    return {
      root,
      logsDir,
      cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  }

  it("resolves status for running supervisor with diagnostics uptime", async () => {
    const tmp = makeTempInstance();
    try {
      const now = new Date("2026-09-09T12:00:00.000Z");
      const loadedAt = new Date("2026-09-09T11:58:30.000Z").toISOString(); // 90s ago
      const pid = 8888;

      fs.writeFileSync(path.join(tmp.logsDir, "control-plane-supervisor.pid"), String(pid));
      fs.writeFileSync(
        path.join(tmp.logsDir, "supervisor-diagnostics.jsonl"),
        JSON.stringify({ event: "process_loaded", pid, at: loadedAt }) + "\n",
      );

      const mockDb = {
        execute: async (query: any) => {
          const sqlStr = JSON.stringify(query);
          if (sqlStr.includes("current_setting") || sqlStr.includes("port")) {
            return [{ port: 54329 }];
          }
          if (sqlStr.includes("pg_stat_activity") || sqlStr.includes("count")) {
            return [{ count: 3 }];
          }
          return [1];
        },
      } as any;

      const status = await getAIOfficeStatus(mockDb, {
        instanceRoot: tmp.root,
        killProcess: () => {},
        now: () => now,
        listenHost: "127.0.0.1",
        listenPort: 3100,
      });

      expect(status.timestamp).toBe("2026-09-09T12:00:00.000Z");
      expect(status.supervisor.status).toBe("running");
      expect(status.supervisor.pid).toBe(pid);
      expect(status.supervisor.uptimeSeconds).toBe(90);
      expect(status.database.status).toBe("healthy");
      expect(status.database.port).toBe(54329);
      expect(status.database.activeConnections).toBe(3);
      expect(status.database.connectionUrlSanitized).toContain("***");
      expect(status.server.status).toBe("healthy");
      expect(status.server.listenPort).toBe(3100);
      expect(status.server.listenHost).toBe("127.0.0.1");
    } finally {
      tmp.cleanup();
    }
  });

  it("resolves supervisor uptime from control-plane-lifecycle.jsonl when diagnostics event is absent", async () => {
    const tmp = makeTempInstance();
    try {
      const now = new Date("2026-09-09T12:00:00.000Z");
      const startedAt = new Date("2026-09-09T11:55:00.000Z").toISOString(); // 300s ago
      const pid = 7777;

      fs.writeFileSync(path.join(tmp.logsDir, "control-plane-supervisor.pid"), String(pid));
      fs.writeFileSync(
        path.join(tmp.logsDir, "control-plane-lifecycle.jsonl"),
        JSON.stringify({ event: "supervisor_started", pid, at: startedAt }) + "\n",
      );

      const status = await getAIOfficeStatus(undefined, {
        instanceRoot: tmp.root,
        killProcess: () => {},
        now: () => now,
      });

      expect(status.supervisor.status).toBe("running");
      expect(status.supervisor.pid).toBe(pid);
      expect(status.supervisor.uptimeSeconds).toBe(300);
      expect(status.database.status).toBe("unreachable");
    } finally {
      tmp.cleanup();
    }
  });

  it("detects recovering supervisor when database is unreachable and fresh recovery state exists", async () => {
    const tmp = makeTempInstance();
    try {
      const now = new Date("2026-09-09T12:00:00.000Z");
      const pid = 5555;

      fs.writeFileSync(path.join(tmp.logsDir, "control-plane-supervisor.pid"), String(pid));
      const recoveryFile = path.join(tmp.logsDir, "control-plane-recovery-state.json");
      fs.writeFileSync(
        recoveryFile,
        JSON.stringify({ attempts: 2, nextAttemptAt: now.getTime() + 10_000 }),
      );
      fs.utimesSync(recoveryFile, now, now);

      // Failing DB
      const mockDb = {
        execute: async () => {
          throw new Error("connection refused");
        },
      } as any;

      const status = await getAIOfficeStatus(mockDb, {
        instanceRoot: tmp.root,
        killProcess: () => {},
        now: () => now,
      });

      expect(status.supervisor.status).toBe("recovering");
      expect(status.database.status).toBe("unreachable");
    } finally {
      tmp.cleanup();
    }
  });

  it("detects recovering supervisor when API is unhealthy and fresh recovery state exists", async () => {
    const tmp = makeTempInstance();
    try {
      const now = new Date("2026-09-09T12:00:00.000Z");
      const pid = 5555;

      fs.writeFileSync(path.join(tmp.logsDir, "control-plane-supervisor.pid"), String(pid));
      const recoveryFile = path.join(tmp.logsDir, "control-plane-recovery-state.json");
      fs.writeFileSync(
        recoveryFile,
        JSON.stringify({ attempts: 1, nextAttemptAt: now.getTime() + 5_000 }),
      );
      fs.utimesSync(recoveryFile, now, now);

      const status = await getAIOfficeStatus(undefined, {
        instanceRoot: tmp.root,
        killProcess: () => {},
        now: () => now,
        isApiHealthy: false,
      });

      expect(status.supervisor.status).toBe("recovering");
      expect(status.server.status).toBe("unhealthy");
    } finally {
      tmp.cleanup();
    }
  });

  it("does not falsely report recovering if recovery state file is stale (> 5 min old)", async () => {
    const tmp = makeTempInstance();
    try {
      const now = new Date("2026-09-09T12:00:00.000Z");
      const pid = 5555;

      fs.writeFileSync(path.join(tmp.logsDir, "control-plane-supervisor.pid"), String(pid));
      const recoveryFile = path.join(tmp.logsDir, "control-plane-recovery-state.json");
      fs.writeFileSync(
        recoveryFile,
        JSON.stringify({ attempts: 1, nextAttemptAt: now.getTime() - 400_000 }),
      );
      // Set mtime to 10 minutes ago
      const tenMinutesAgo = new Date(now.getTime() - 600_000);
      fs.utimesSync(recoveryFile, tenMinutesAgo, tenMinutesAgo);

      const status = await getAIOfficeStatus(undefined, {
        instanceRoot: tmp.root,
        killProcess: () => {},
        now: () => now,
      });

      expect(status.supervisor.status).toBe("running");
    } finally {
      tmp.cleanup();
    }
  });

  it("reports stopped supervisor when pid file is absent", async () => {
    const tmp = makeTempInstance();
    try {
      const status = await getAIOfficeStatus(undefined, {
        instanceRoot: tmp.root,
      });

      expect(status.supervisor.status).toBe("stopped");
      expect(status.supervisor.pid).toBeNull();
      expect(status.supervisor.uptimeSeconds).toBe(0);
    } finally {
      tmp.cleanup();
    }
  });
});

describe("GET /api/ai-office/status route auth", () => {
  function createTestApp(actor: any, options: any = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api/ai-office", aiOfficeRoutes(undefined, options));
    app.use(errorHandler);
    return app;
  }

  it("returns 401 when unauthenticated (actor.type === none)", async () => {
    const app = createTestApp({ type: "none", source: "none" });
    const res = await request(app).get("/api/ai-office/status");
    expect(res.status).toBe(401);
  });

  it("returns 403 when authenticated as agent (actor.type === agent)", async () => {
    const app = createTestApp({
      type: "agent",
      agentId: "agent-123",
      source: "agent_key",
      keyScope: "full",
    });
    const res = await request(app).get("/api/ai-office/status");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Board access required/i);
  });

  it("returns 200 when authenticated as board (actor.type === board)", async () => {
    const app = createTestApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
    });
    const res = await request(app).get("/api/ai-office/status");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("timestamp");
    expect(res.body).toHaveProperty("supervisor");
    expect(res.body).toHaveProperty("database");
    expect(res.body).toHaveProperty("server");
    expect(res.body).toHaveProperty("backup");
  });
});
