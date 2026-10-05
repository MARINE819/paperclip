import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Web Push 구독 테이블
 * - companyId: 회사 테넌트 경계 격리
 * - userId: 대상 사용자 식별자
 * - endpoint: 브라우저 푸시 서비스 엔드포인트 URL
 * - p256dh, auth: 클라이언트 공개키 및 인증 시크릿
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    endpointCompanyIdx: uniqueIndex("push_subscriptions_endpoint_company_idx").on(table.endpoint, table.companyId),
    companyUserIdx: index("push_subscriptions_company_user_idx").on(table.companyId, table.userId),
    userIdx: index("push_subscriptions_user_idx").on(table.userId),
  }),
);
