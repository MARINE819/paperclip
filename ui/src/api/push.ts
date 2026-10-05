import { api } from "./client";

export interface PushPublicKeyResult {
  publicKey: string;
}

export interface PushSubscribeResult {
  ok: boolean;
  subscription: {
    id: string;
    endpoint: string;
    createdAt: string;
  };
}

export interface PushUnsubscribeResult {
  ok: boolean;
  unsubscribed: boolean;
}

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export const pushApi = {
  getPublicKey: () => api.get<PushPublicKeyResult>("/push/public-key"),

  subscribe: (
    companyId: string,
    data: {
      endpoint: string;
      keys?: {
        p256dh: string;
        auth: string;
      };
      p256dh?: string;
      auth?: string;
    },
  ) =>
    api.post<PushSubscribeResult>(
      `/companies/${companyId}/push/subscribe`,
      data,
    ),

  unsubscribe: (companyId: string, data: { endpoint: string }) =>
    api.post<PushUnsubscribeResult>(
      `/companies/${companyId}/push/unsubscribe`,
      data,
    ),
};
