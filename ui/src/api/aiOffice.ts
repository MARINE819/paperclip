import type { AIOfficeStatus } from "@paperclipai/shared";
import { api } from "./client";

export const aiOfficeApi = {
  getStatus: () => api.get<AIOfficeStatus>("/ai-office/status"),
};
