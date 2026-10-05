import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { validate } from "../middleware/validate.js";
import { voiceCommandService } from "../services/voice-commands.js";

export const voiceCommandRequestSchema = z.object({
  transcript: z
    .string()
    .trim()
    .min(1, "transcript is required")
    .max(1000, "transcript must not exceed 1000 characters"),
});

export type VoiceCommandRequestBody = z.infer<typeof voiceCommandRequestSchema>;

export function voiceRoutes(db: Db) {
  const router = Router();
  const service = voiceCommandService(db);

  router.post(
    "/companies/:companyId/voice/command",
    validate(voiceCommandRequestSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const actor = getActorInfo(req);
      const result = await service.processCommand(companyId, req.body.transcript, actor);
      res.status(200).json(result);
    },
  );

  return router;
}
