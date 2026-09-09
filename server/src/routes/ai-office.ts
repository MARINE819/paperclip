import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertAuthenticated, assertBoard } from "./authz.js";
import {
  getAIOfficeStatus,
  type AIOfficeStatusServiceOptions,
} from "../services/ai-office-status.js";

export function aiOfficeRoutes(
  db?: Db,
  options?: AIOfficeStatusServiceOptions,
) {
  const router = Router();

  router.get("/status", async (req, res) => {
    assertAuthenticated(req);
    assertBoard(req);

    const status = await getAIOfficeStatus(db, options);
    res.json(status);
  });

  return router;
}
