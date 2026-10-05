import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { webPushService } from "../services/web-push-service.js";
import { badRequest } from "../errors.js";

export function pushRoutes(db: Db) {
  const router = Router();
  const service = webPushService(db);

  // 1. VAPID 공용키 조회 (Fail-closed: 미설정 시 503 반환)
  router.get("/push/public-key", (req, res, next) => {
    try {
      const publicKey = service.getPublicKey();
      res.json({ publicKey });
    } catch (err) {
      next(err);
    }
  });

  // 2. 브라우저 푸시 구독 등록
  router.post("/companies/:companyId/push/subscribe", async (req, res, next) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const userId = req.actor.userId ?? "local-board";
      const body = req.body ?? {};

      // 브라우저 PushSubscription JSON 및 플랫 형식 모두 수용
      const endpoint = body.endpoint?.trim?.() ?? "";
      const p256dh = (body.keys?.p256dh ?? body.p256dh)?.trim?.() ?? "";
      const auth = (body.keys?.auth ?? body.auth)?.trim?.() ?? "";
      const userAgent = req.get("user-agent") ?? undefined;

      if (!endpoint || !p256dh || !auth) {
        throw badRequest("Missing push subscription parameters (endpoint, p256dh, auth required)");
      }

      const subscription = await service.subscribe({
        companyId,
        userId,
        endpoint,
        p256dh,
        auth,
        userAgent,
      });

      res.status(201).json({
        ok: true,
        subscription: {
          id: subscription.id,
          endpoint: subscription.endpoint,
          createdAt: subscription.createdAt,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // 3. 브라우저 푸시 구독 취소
  router.post("/companies/:companyId/push/unsubscribe", async (req, res, next) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const userId = req.actor.userId ?? "local-board";
      const endpoint = req.body?.endpoint?.trim?.() ?? "";

      if (!endpoint) {
        throw badRequest("Missing endpoint for push unsubscription");
      }

      const result = await service.unsubscribe({
        companyId,
        userId,
        endpoint,
      });

      res.json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
