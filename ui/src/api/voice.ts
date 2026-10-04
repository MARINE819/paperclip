import { api } from "./client";

export type VoiceCommandId = "status.company" | "status.work" | "action.pause_company" | "unknown";

export interface VoiceCommandResponse {
  success: boolean;
  matched: boolean;
  command: VoiceCommandId;
  resultText: string;
  approvalId?: string | null;
  error?: string | null;
}

export const voiceApi = {
  submitCommand: (companyId: string, transcript: string) =>
    api.post<VoiceCommandResponse>(`/companies/${companyId}/voice/command`, { transcript }),
};
