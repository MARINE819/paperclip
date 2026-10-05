import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { webauthnService } from "../services/webauthn-service.js";
import { badRequest, HttpError } from "../errors.js";

interface WebAuthnTrustConfig {
  origin: string;
  rpId: string;
}

/**
 * WebAuthn Expected Origin 및 RP ID 신뢰 루트 결정
 * 1. PAPERCLIP_WEBAUTHN_ORIGIN / PAPERCLIP_WEBAUTHN_RP_ID 환경변수 최우선 신뢰
 * 2. 비-localhost / 프로덕션 환경에서 환경변수 미설정 시 FAIL CLOSED (503 webauthn_unconfigured)
 * 3. 로컬 루프백(localhost/127.0.0.1) 개발 환경에 한해서만 엄격한 화이트리스트 검증 후 fallback 허용
 */
function resolveWebAuthnTrustConfig(req: Request): WebAuthnTrustConfig {
  const envOrigin = process.env.PAPERCLIP_WEBAUTHN_ORIGIN?.trim();
  const envRpId = process.env.PAPERCLIP_WEBAUTHN_RP_ID?.trim();

  if (envOrigin && envRpId) {
    return { origin: envOrigin, rpId: envRpId };
  }

  const host = (req.get("host") || "").toLowerCase();
  const hostname = host.split(":")[0];
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

  if (isLoopback) {
    const originHeader = req.get("origin");
    const safeLocalOrigin =
      originHeader && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(originHeader)
        ? originHeader
        : "http://localhost:3100";

    return {
      origin: envOrigin || safeLocalOrigin,
      rpId: envRpId || "localhost",
    };
  }

  throw new HttpError(
    503,
    "WebAuthn service unconfigured for non-localhost environments (PAPERCLIP_WEBAUTHN_ORIGIN and PAPERCLIP_WEBAUTHN_RP_ID required)",
    { code: "webauthn_unconfigured" },
  );
}

export function webauthnRoutes(db: Db) {
  const router = Router();
  const service = webauthnService(db);

  // 1. 등록 Challenge 옵션 발급
  router.post("/companies/:companyId/webauthn/register/options", async (req, res, next) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const trust = resolveWebAuthnTrustConfig(req);
      const userId = req.actor.userId ?? "local-board";
      const userName = req.actor.userName ?? req.actor.userEmail ?? userId;

      const options = await service.generateRegistrationOptions({
        companyId,
        userId,
        userName,
        rpId: trust.rpId,
      });

      res.json(options);
    } catch (err) {
      next(err);
    }
  });

  // 2. 등록 응답 서명 검증 및 Credential 저장
  router.post("/companies/:companyId/webauthn/register/verify", async (req, res, next) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const trust = resolveWebAuthnTrustConfig(req);
      const userId = req.actor.userId ?? "local-board";
      const { response, deviceName } = req.body ?? {};

      if (!response) {
        throw badRequest("Missing WebAuthn registration response payload");
      }

      const result = await service.verifyRegistration({
        companyId,
        userId,
        response,
        expectedOrigin: trust.origin,
        expectedRpId: trust.rpId,
        deviceName,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // 3. 인증 Challenge 옵션 발급
  router.post("/companies/:companyId/webauthn/authenticate/options", async (req, res, next) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const trust = resolveWebAuthnTrustConfig(req);
      const userId = req.actor.userId ?? "local-board";
      const { purpose, bindingId } = req.body ?? {};

      if (!purpose) {
        throw badRequest("Missing WebAuthn authentication purpose");
      }

      const options = await service.generateAuthenticationOptions({
        companyId,
        userId,
        purpose,
        bindingId,
        rpId: trust.rpId,
      });

      res.json(options);
    } catch (err) {
      next(err);
    }
  });

  // 4. 인증 응답 서명 검증 (단일 사용 및 Action Binding 검증, purpose === 'approval_decision' 시 60s TTL approvalToken 발급)
  router.post("/companies/:companyId/webauthn/authenticate/verify", async (req, res, next) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const trust = resolveWebAuthnTrustConfig(req);
      const userId = req.actor.userId ?? "local-board";
      const { response, purpose, bindingId } = req.body ?? {};

      if (!response || !purpose) {
        throw badRequest("Missing response or purpose for WebAuthn authentication");
      }

      const result = await service.verifyAuthentication({
        companyId,
        userId,
        purpose,
        bindingId,
        response,
        expectedOrigin: trust.origin,
        expectedRpId: trust.rpId,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // 5. 등록된 사용자 기기 Credential 목록 조회
  router.get("/companies/:companyId/webauthn/credentials", async (req, res, next) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const userId = req.actor.userId ?? "local-board";
      const credentials = await service.listUserCredentials(companyId, userId);
      res.json(credentials);
    } catch (err) {
      next(err);
    }
  });

  // 6. 기기 Credential 삭제
  router.delete("/companies/:companyId/webauthn/credentials/:id", async (req, res, next) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const userId = req.actor.userId ?? "local-board";
      const credentialId = req.params.id as string;

      const deleted = await service.removeCredential(companyId, userId, credentialId);
      res.json({ deleted: deleted.length > 0 });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
