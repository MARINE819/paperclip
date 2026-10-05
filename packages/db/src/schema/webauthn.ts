import { pgTable, uuid, text, timestamp, boolean, bigint, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * WebAuthn 등록 기기 Credential (생체인증/보안키)
 * - companyId: Paperclip Rule 1 테넌트 경계 격리
 * - userId: text("user_id") — hard FK 없이 local-board, session user, board_key 모두 수용
 * - credentialId: 고유 base64url credential identifier
 */
export const webauthnCredentials = pgTable(
  "webauthn_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    credentialId: text("credential_id").notNull(),
    publicKey: text("public_key").notNull(),
    counter: bigint("counter", { mode: "number" }).notNull().default(0),
    deviceType: text("device_type").notNull().default("singleDevice"),
    backedUp: boolean("backed_up").notNull().default(false),
    transports: jsonb("transports").$type<string[]>(),
    name: text("name"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    credentialIdIdx: uniqueIndex("webauthn_credentials_credential_id_idx").on(table.credentialId),
    companyUserIdx: index("webauthn_credentials_company_user_idx").on(table.companyId, table.userId),
    userIdx: index("webauthn_credentials_user_idx").on(table.userId),
  }),
);

/**
 * WebAuthn Challenge 검증 및 Replay 방지 세션
 * - companyId: 타 회사 간 챌린지 재사용 원천 차단
 * - userId: 발급받은 사용자만 서명 제출 가능
 * - bindingId: 특정 Approval ID 또는 비상정지 해제 토큰에 1:1 결합 (Cross-Action Replay 방지)
 * - consumedAt: 1회 검증 완료 시 즉시 타임스탬프 기록 (One-Time Use 보장)
 */
export const webauthnChallenges = pgTable(
  "webauthn_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    challenge: text("challenge").notNull(),
    purpose: text("purpose").notNull(), // 'registration' | 'approval_decision' | 'emergency_resume'
    bindingId: text("binding_id"),     // approval ID 또는 target action ID 결합
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    challengeIdx: uniqueIndex("webauthn_challenges_challenge_idx").on(table.challenge),
    companyUserIdx: index("webauthn_challenges_company_user_idx").on(table.companyId, table.userId),
    bindingIdx: index("webauthn_challenges_binding_idx").on(table.bindingId),
  }),
);
