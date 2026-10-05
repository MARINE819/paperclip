import webpush from "web-push";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pushSubscriptions } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { HttpError } from "../errors.js";

export interface PushNotificationPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  data?: Record<string, unknown>;
}

export function webPushService(db: Db) {
  const publicKey = process.env.PAPERCLIP_VAPID_PUBLIC_KEY?.trim() || null;
  const privateKey = process.env.PAPERCLIP_VAPID_PRIVATE_KEY?.trim() || null;
  const subject = process.env.PAPERCLIP_VAPID_SUBJECT?.trim() || "mailto:admin@paperclip.local";

  const isConfigured = Boolean(publicKey && privateKey);

  if (isConfigured) {
    try {
      webpush.setVapidDetails(subject, publicKey!, privateKey!);
    } catch (err) {
      logger.warn({ err }, "Failed to initialize VAPID details for Web Push");
    }
  } else {
    logger.info(
      "Web Push service is unconfigured (PAPERCLIP_VAPID_PUBLIC_KEY / PAPERCLIP_VAPID_PRIVATE_KEY missing). Remote push disabled (fail-closed).",
    );
  }

  function assertAvailable() {
    if (!isConfigured) {
      throw new HttpError(503, "Web Push service unconfigured", { code: "push_unconfigured" });
    }
  }

  return {
    isAvailable() {
      return isConfigured;
    },

    getPublicKey() {
      assertAvailable();
      return publicKey!;
    },

    async subscribe(input: {
      companyId: string;
      userId: string;
      endpoint: string;
      p256dh: string;
      auth: string;
      userAgent?: string;
    }) {
      assertAvailable();

      const [subscription] = await db
        .insert(pushSubscriptions)
        .values({
          companyId: input.companyId,
          userId: input.userId,
          endpoint: input.endpoint.trim(),
          p256dh: input.p256dh.trim(),
          auth: input.auth.trim(),
          userAgent: input.userAgent ?? null,
        })
        .onConflictDoUpdate({
          target: [pushSubscriptions.endpoint, pushSubscriptions.companyId],
          set: {
            userId: input.userId,
            p256dh: input.p256dh.trim(),
            auth: input.auth.trim(),
            userAgent: input.userAgent ?? null,
            updatedAt: new Date(),
          },
        })
        .returning();

      return subscription;
    },

    async unsubscribe(input: { companyId: string; userId: string; endpoint: string }) {
      assertAvailable();

      const deleted = await db
        .delete(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.companyId, input.companyId),
            eq(pushSubscriptions.userId, input.userId),
            eq(pushSubscriptions.endpoint, input.endpoint.trim()),
          ),
        )
        .returning();

      return { unsubscribed: deleted.length > 0 };
    },

    async sendNotificationToUser(input: {
      companyId: string;
      userId: string;
      notification: PushNotificationPayload;
    }) {
      if (!isConfigured) {
        logger.debug(
          { companyId: input.companyId, userId: input.userId },
          "Skipping push notification: web push unconfigured (fail-closed)",
        );
        return { sent: 0, failed: 0, reason: "push_unconfigured" };
      }

      const subscriptions = await db
        .select()
        .from(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.companyId, input.companyId),
            eq(pushSubscriptions.userId, input.userId),
          ),
        );

      if (subscriptions.length === 0) {
        return { sent: 0, failed: 0, reason: "no_subscriptions" };
      }

      const payloadString = JSON.stringify(input.notification);
      let sent = 0;
      let failed = 0;

      for (const sub of subscriptions) {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: {
                p256dh: sub.p256dh,
                auth: sub.auth,
              },
            },
            payloadString,
          );
          sent++;
        } catch (err: any) {
          failed++;
          logger.warn({ err, endpoint: sub.endpoint }, "Failed to send Web Push notification");
          // Stale subscription handling: 404 or 410 means subscription expired/unregistered
          if (err.statusCode === 404 || err.statusCode === 410) {
            await db
              .delete(pushSubscriptions)
              .where(eq(pushSubscriptions.id, sub.id))
              .catch((deleteErr) => {
                logger.warn({ deleteErr, id: sub.id }, "Failed to remove stale push subscription");
              });
          }
        }
      }

      return { sent, failed };
    },
  };
}
