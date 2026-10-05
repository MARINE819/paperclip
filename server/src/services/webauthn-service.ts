import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { webauthnCredentials, webauthnChallenges } from "@paperclipai/db";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { badRequest, notFound } from "../errors.js";

export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const WEBAUTHN_APPROVAL_TOKEN_TTL_MS = 60 * 1000; // 60 seconds

export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbClient = Db | DbTransaction;

export function webauthnService(db: Db) {
  return {
    async generateRegistrationOptions(input: {
      companyId: string;
      userId: string;
      userName: string;
      userDisplayName?: string;
      rpName?: string;
      rpId?: string;
    }) {
      const rpName = input.rpName ?? "Paperclip";
      const rpID = input.rpId ?? "localhost";

      const userCredentials = await db
        .select({ credentialId: webauthnCredentials.credentialId, transports: webauthnCredentials.transports })
        .from(webauthnCredentials)
        .where(
          and(
            eq(webauthnCredentials.companyId, input.companyId),
            eq(webauthnCredentials.userId, input.userId),
          ),
        );

      const options = await generateRegistrationOptions({
        rpName,
        rpID,
        userID: Buffer.from(input.userId, "utf-8"),
        userName: input.userName,
        userDisplayName: input.userDisplayName ?? input.userName,
        attestationType: "none",
        excludeCredentials: userCredentials.map((c) => ({
          id: c.credentialId,
          transports: (c.transports ?? undefined) as any,
        })),
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "preferred",
        },
      });

      const expiresAt = new Date(Date.now() + WEBAUTHN_CHALLENGE_TTL_MS);
      await db.insert(webauthnChallenges).values({
        companyId: input.companyId,
        userId: input.userId,
        challenge: options.challenge,
        purpose: "registration",
        expiresAt,
      });

      return options;
    },

    async verifyRegistration(input: {
      companyId: string;
      userId: string;
      response: RegistrationResponseJSON;
      expectedOrigin: string;
      expectedRpId: string;
      deviceName?: string;
    }) {
      const clientDataJSON = input.response.response?.clientDataJSON;
      if (!clientDataJSON) {
        throw badRequest("Invalid clientDataJSON in WebAuthn response");
      }

      let challengeStr: string | null = null;
      try {
        challengeStr = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf-8")).challenge;
      } catch {
        throw badRequest("Failed to parse clientDataJSON challenge");
      }

      if (!challengeStr) {
        throw badRequest("No challenge present in clientDataJSON");
      }

      const now = new Date();
      const consumed = await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(webauthnChallenges)
          .where(
            and(
              eq(webauthnChallenges.challenge, challengeStr),
              eq(webauthnChallenges.companyId, input.companyId),
              eq(webauthnChallenges.userId, input.userId),
              eq(webauthnChallenges.purpose, "registration"),
              isNull(webauthnChallenges.consumedAt),
              gt(webauthnChallenges.expiresAt, now),
            ),
          );

        const challengeRow = rows[0];
        if (!challengeRow) {
          throw badRequest("WebAuthn registration challenge not found, expired, or already consumed");
        }

        await tx
          .update(webauthnChallenges)
          .set({ consumedAt: now })
          .where(eq(webauthnChallenges.id, challengeRow.id));

        return challengeRow;
      });

      const verification = await verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: consumed.challenge,
        expectedOrigin: input.expectedOrigin,
        expectedRPID: input.expectedRpId,
      });

      if (!verification.verified || !verification.registrationInfo) {
        throw badRequest("WebAuthn registration verification failed");
      }

      const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

      const credentialId = credential.id;
      const publicKey = Buffer.from(credential.publicKey).toString("base64url");
      const counter = credential.counter;

      const [saved] = await db
        .insert(webauthnCredentials)
        .values({
          companyId: input.companyId,
          userId: input.userId,
          credentialId,
          publicKey,
          counter,
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
          transports: (input.response.response.transports ?? null) as any,
          name: input.deviceName ?? null,
        })
        .returning();

      return {
        verified: true,
        credential: {
          id: saved.id,
          credentialId: saved.credentialId,
          name: saved.name,
          createdAt: saved.createdAt,
        },
      };
    },

    async generateAuthenticationOptions(input: {
      companyId: string;
      userId: string;
      purpose: string;
      bindingId?: string;
      rpId?: string;
    }) {
      const rpID = input.rpId ?? "localhost";

      const userCredentials = await db
        .select()
        .from(webauthnCredentials)
        .where(
          and(
            eq(webauthnCredentials.companyId, input.companyId),
            eq(webauthnCredentials.userId, input.userId),
          ),
        );

      if (userCredentials.length === 0) {
        throw notFound("No registered WebAuthn credentials found for user in this company");
      }

      const options = await generateAuthenticationOptions({
        rpID,
        allowCredentials: userCredentials.map((c) => ({
          id: c.credentialId,
          transports: (c.transports ?? undefined) as any,
        })),
        userVerification: "preferred",
      });

      const expiresAt = new Date(Date.now() + WEBAUTHN_CHALLENGE_TTL_MS);
      await db.insert(webauthnChallenges).values({
        companyId: input.companyId,
        userId: input.userId,
        challenge: options.challenge,
        purpose: input.purpose,
        bindingId: input.bindingId ?? null,
        expiresAt,
      });

      return options;
    },

    async verifyAuthentication(input: {
      companyId: string;
      userId: string;
      purpose: string;
      bindingId?: string;
      response: AuthenticationResponseJSON;
      expectedOrigin: string;
      expectedRpId: string;
    }) {
      const clientDataJSON = input.response.response?.clientDataJSON;
      if (!clientDataJSON) {
        throw badRequest("Invalid clientDataJSON in WebAuthn response");
      }

      let challengeStr: string | null = null;
      try {
        challengeStr = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf-8")).challenge;
      } catch {
        throw badRequest("Failed to parse clientDataJSON challenge");
      }

      if (!challengeStr) {
        throw badRequest("No challenge present in clientDataJSON");
      }

      const now = new Date();
      const challengeRow = await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(webauthnChallenges)
          .where(
            and(
              eq(webauthnChallenges.challenge, challengeStr),
              eq(webauthnChallenges.companyId, input.companyId),
              eq(webauthnChallenges.userId, input.userId),
              eq(webauthnChallenges.purpose, input.purpose),
              isNull(webauthnChallenges.consumedAt),
              gt(webauthnChallenges.expiresAt, now),
            ),
          );

        const row = rows[0];
        if (!row) {
          throw badRequest("WebAuthn challenge not found, expired, or already consumed");
        }

        if (input.bindingId && row.bindingId !== input.bindingId) {
          throw badRequest("WebAuthn challenge binding mismatch");
        }

        await tx
          .update(webauthnChallenges)
          .set({ consumedAt: now })
          .where(eq(webauthnChallenges.id, row.id));

        return row;
      });

      const [credentialRow] = await db
        .select()
        .from(webauthnCredentials)
        .where(
          and(
            eq(webauthnCredentials.credentialId, input.response.id),
            eq(webauthnCredentials.companyId, input.companyId),
            eq(webauthnCredentials.userId, input.userId),
          ),
        );

      if (!credentialRow) {
        throw badRequest("WebAuthn credential not found or not owned by user in this company");
      }

      const publicKeyBuffer = Buffer.from(credentialRow.publicKey, "base64url");

      const verification = await verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: input.expectedOrigin,
        expectedRPID: input.expectedRpId,
        credential: {
          id: credentialRow.credentialId,
          publicKey: new Uint8Array(publicKeyBuffer),
          counter: Number(credentialRow.counter),
          transports: (credentialRow.transports ?? undefined) as any,
        },
      });

      if (!verification.verified) {
        throw badRequest("WebAuthn authentication verification failed");
      }

      await db
        .update(webauthnCredentials)
        .set({
          counter: verification.authenticationInfo.newCounter,
          lastUsedAt: now,
        })
        .where(eq(webauthnCredentials.id, credentialRow.id));

      let approvalToken: string | undefined;
      let resumeToken: string | undefined;
      if (input.purpose === "approval_decision" && challengeRow.bindingId) {
        approvalToken = randomBytes(32).toString("hex");
        const tokenExpiresAt = new Date(Date.now() + WEBAUTHN_APPROVAL_TOKEN_TTL_MS);
        await db.insert(webauthnChallenges).values({
          companyId: credentialRow.companyId,
          userId: credentialRow.userId,
          challenge: approvalToken,
          purpose: "approval_token",
          bindingId: challengeRow.bindingId,
          expiresAt: tokenExpiresAt,
        });
      } else if (input.purpose === "emergency_resume" && challengeRow.bindingId) {
        resumeToken = randomBytes(32).toString("hex");
        const tokenExpiresAt = new Date(Date.now() + WEBAUTHN_APPROVAL_TOKEN_TTL_MS);
        await db.insert(webauthnChallenges).values({
          companyId: credentialRow.companyId,
          userId: credentialRow.userId,
          challenge: resumeToken,
          purpose: "emergency_resume_token",
          bindingId: challengeRow.bindingId,
          expiresAt: tokenExpiresAt,
        });
      }

      return {
        verified: true,
        credentialId: credentialRow.credentialId,
        userId: credentialRow.userId,
        companyId: credentialRow.companyId,
        bindingId: challengeRow.bindingId,
        approvalToken,
        resumeToken,
      };
    },

    async listUserCredentials(companyId: string, userId: string) {
      return db
        .select({
          id: webauthnCredentials.id,
          credentialId: webauthnCredentials.credentialId,
          name: webauthnCredentials.name,
          deviceType: webauthnCredentials.deviceType,
          backedUp: webauthnCredentials.backedUp,
          createdAt: webauthnCredentials.createdAt,
          lastUsedAt: webauthnCredentials.lastUsedAt,
        })
        .from(webauthnCredentials)
        .where(
          and(
            eq(webauthnCredentials.companyId, companyId),
            eq(webauthnCredentials.userId, userId),
          ),
        );
    },

    async removeCredential(companyId: string, userId: string, credentialId: string) {
      return db
        .delete(webauthnCredentials)
        .where(
          and(
            eq(webauthnCredentials.id, credentialId),
            eq(webauthnCredentials.companyId, companyId),
            eq(webauthnCredentials.userId, userId),
          ),
        )
        .returning();
    },

    async issueApprovalToken(input: {
      companyId: string;
      userId: string;
      approvalId: string;
      ttlMs?: number;
    }) {
      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + (input.ttlMs ?? WEBAUTHN_APPROVAL_TOKEN_TTL_MS));
      const [row] = await db
        .insert(webauthnChallenges)
        .values({
          companyId: input.companyId,
          userId: input.userId,
          challenge: token,
          purpose: "approval_token",
          bindingId: input.approvalId,
          expiresAt,
        })
        .returning();
      return { token, row };
    },

    async consumeApprovalToken(input: {
      token: string;
      approvalId: string;
      companyId: string;
      userId: string;
    }): Promise<
      | { valid: true; row: typeof webauthnChallenges.$inferSelect }
      | { valid: false; status: number; reason: string; error: string }
    > {
      const now = new Date();
      const [consumed] = await db
        .update(webauthnChallenges)
        .set({ consumedAt: now })
        .where(
          and(
            eq(webauthnChallenges.challenge, input.token),
            eq(webauthnChallenges.purpose, "approval_token"),
            eq(webauthnChallenges.bindingId, input.approvalId),
            eq(webauthnChallenges.companyId, input.companyId),
            eq(webauthnChallenges.userId, input.userId),
            isNull(webauthnChallenges.consumedAt),
            gt(webauthnChallenges.expiresAt, now),
          ),
        )
        .returning();

      if (consumed) {
        return { valid: true, row: consumed };
      }

      // Read-only diagnosis to classify failure accurately without state change
      const [existing] = await db
        .select()
        .from(webauthnChallenges)
        .where(eq(webauthnChallenges.challenge, input.token));

      if (!existing || existing.purpose !== "approval_token") {
        return { valid: false, status: 401, reason: "approval_token_invalid", error: "Invalid WebAuthn approval token" };
      }
      if (existing.companyId !== input.companyId || existing.userId !== input.userId || existing.bindingId !== input.approvalId) {
        return { valid: false, status: 403, reason: "approval_token_binding_mismatch", error: "Approval token binding mismatch" };
      }
      if (existing.consumedAt != null) {
        return { valid: false, status: 409, reason: "approval_token_already_consumed", error: "Approval token has already been consumed" };
      }
      if (existing.expiresAt.getTime() <= now.getTime()) {
        return { valid: false, status: 410, reason: "approval_token_expired", error: "Approval token has expired" };
      }
      return { valid: false, status: 401, reason: "approval_token_invalid", error: "Invalid WebAuthn approval token" };
    },

    async consumeEmergencyResumeToken(input: {
      token: string;
      companyId: string;
      userId: string;
      tx?: DbClient;
    }): Promise<
      | { valid: true; row: typeof webauthnChallenges.$inferSelect }
      | { valid: false; status: number; reason: string; error: string }
    > {
      const client = input.tx ?? db;
      const now = new Date();
      const [consumed] = await client
        .update(webauthnChallenges)
        .set({ consumedAt: now })
        .where(
          and(
            eq(webauthnChallenges.challenge, input.token),
            eq(webauthnChallenges.purpose, "emergency_resume_token"),
            eq(webauthnChallenges.bindingId, input.companyId),
            eq(webauthnChallenges.companyId, input.companyId),
            eq(webauthnChallenges.userId, input.userId),
            isNull(webauthnChallenges.consumedAt),
            gt(webauthnChallenges.expiresAt, now),
          ),
        )
        .returning();

      if (consumed) {
        return { valid: true, row: consumed };
      }

      // Read-only diagnosis to classify failure accurately without state change
      const [existing] = await db
        .select()
        .from(webauthnChallenges)
        .where(eq(webauthnChallenges.challenge, input.token));

      if (!existing || existing.purpose !== "emergency_resume_token") {
        return { valid: false, status: 401, reason: "resume_token_invalid", error: "Invalid WebAuthn emergency resume token" };
      }
      if (existing.companyId !== input.companyId || existing.bindingId !== input.companyId || existing.userId !== input.userId) {
        return { valid: false, status: 403, reason: "resume_token_binding_mismatch", error: "Emergency resume token binding mismatch" };
      }
      if (existing.consumedAt != null) {
        return { valid: false, status: 409, reason: "resume_token_already_consumed", error: "Emergency resume token has already been consumed" };
      }
      if (existing.expiresAt.getTime() <= now.getTime()) {
        return { valid: false, status: 410, reason: "resume_token_expired", error: "Emergency resume token has expired" };
      }
      return { valid: false, status: 401, reason: "resume_token_invalid", error: "Invalid WebAuthn emergency resume token" };
    },
  };
}
