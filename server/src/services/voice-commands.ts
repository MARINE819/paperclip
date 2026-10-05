import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { companyService } from "./companies.js";
import { dashboardService } from "./dashboard.js";
import { approvalService } from "./approvals.js";
import { logActivity } from "./activity-log.js";

export type VoiceCommandId =
  | "status.company"
  | "status.work"
  | "action.pause_company"
  | "unknown";

export interface VoiceCommandResponse {
  success: boolean;
  matched: boolean;
  command: VoiceCommandId;
  resultText: string;
  approvalId?: string | null;
  error?: string | null;
}

export interface VoiceCommandActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  userId?: string | null;
}

export function classifyVoiceCommand(transcript: string): VoiceCommandId {
  const normalized = transcript.trim().toLowerCase();

  // 1. Dangerous action.pause_company (check first to avoid partial overlap with status.company)
  if (
    /(?:회사\s*(?:일시\s*정지|긴급\s*정지|정지|멈춰)|(?:pause\s*company|emergency\s*pause|halt\s*company|stop\s*company))/i.test(
      normalized,
    )
  ) {
    return "action.pause_company";
  }

  // 2. status.company
  if (
    /(?:회사\s*(?:상태|현황|정보|요약)|(?:company\s*status|status\s*(?:of\s*)?company|company\s*summary))/i.test(
      normalized,
    )
  ) {
    return "status.company";
  }

  // 3. status.work
  if (
    /(?:(?:업무|작업|태스크|이슈)\s*(?:상태|현황)|(?:work\s*status|task(?:s)?\s*status|issue(?:s)?\s*status|status\s*(?:of\s*)?work))/i.test(
      normalized,
    )
  ) {
    return "status.work";
  }

  return "unknown";
}

export function voiceCommandService(db: Db) {
  const companiesSvc = companyService(db);
  const dashboardSvc = dashboardService(db);
  const approvalsSvc = approvalService(db);

  async function executeCompanyStatus(companyId: string): Promise<VoiceCommandResponse> {
    const company = await companiesSvc.getById(companyId);
    if (!company) {
      return {
        success: false,
        matched: true,
        command: "status.company",
        resultText: "회사를 찾을 수 없습니다.",
        approvalId: null,
        error: "COMPANY_NOT_FOUND",
      };
    }

    const statusLabel =
      company.status === "active"
        ? "정상(active)"
        : company.status === "paused"
        ? "일시정지(paused)"
        : company.status;
    const budgetText =
      company.budgetMonthlyCents != null
        ? `$${(company.budgetMonthlyCents / 100).toLocaleString()}`
        : "설정되지 않음";
    const spentText = `$${((company.spentMonthlyCents ?? 0) / 100).toLocaleString()}`;

    const resultText = `${company.name} 회사의 현재 상태는 ${statusLabel}입니다. 월 예산: ${budgetText}, 이번 달 누적 지출: ${spentText}입니다.`;

    return {
      success: true,
      matched: true,
      command: "status.company",
      resultText,
      approvalId: null,
    };
  }

  async function executeWorkStatus(companyId: string): Promise<VoiceCommandResponse> {
    const summary = await dashboardSvc.summary(companyId);
    const { tasks, pendingApprovals, agents } = summary;

    const resultText = `현재 진행 중인 작업은 ${tasks.inProgress}건, 대기 중인 작업은 ${tasks.open}건, 차단된 작업은 ${tasks.blocked}건입니다. 검토 대기 중인 승인은 ${pendingApprovals}건이며, 활성 에이전트는 ${agents.active}명입니다.`;

    return {
      success: true,
      matched: true,
      command: "status.work",
      resultText,
      approvalId: null,
    };
  }

  async function executePauseCompany(
    companyId: string,
    actor: VoiceCommandActor,
  ): Promise<VoiceCommandResponse> {
    const approvalPayload = {
      title: "Voice Command: Request Authorization to Pause Company",
      summary:
        "A voice command requested authorization to pause company operations. Approving this request records formal human authorization only; it does not pause the company automatically.",
      recommendedAction:
        "Approve only if you authorize operators to pause this company. Performing the actual emergency pause requires a separate, explicit operator action.",
      nextActionOnApproval:
        "Approval records human authorization only. It does not automatically pause the company. A separate authorized operator action is required to perform the emergency pause.",
      risks: [
        "If subsequently paused by an operator, scheduled agent timer ticks (heartbeat) will be suspended.",
        "If subsequently paused by an operator, automated agent wakeups will be suppressed and skipped with reason 'company.inactive'.",
        "If subsequently paused by an operator, queued heartbeat runs will not be dispatched.",
      ],
      source: "voice_control",
      action: "pause_company",
      requestedVia: "voice",
    };

    const approval = await approvalsSvc.create(companyId, {
      type: "request_board_approval",
      payload: approvalPayload,
      requestedByUserId: actor.userId ?? (actor.actorType === "user" ? actor.actorId : null),
      requestedByAgentId: null,
      status: "pending",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType === "user" ? "user" : "system",
      actorId: actor.actorId,
      action: "voice_control.approval_requested",
      entityType: "approval",
      entityId: approval.id,
      details: {
        action: "pause_company",
        requestedVia: "voice",
        title: approvalPayload.title,
      },
    });

    const shortId = approval.id.slice(0, 8);
    const resultText = `회사 일시 정지는 위험 명령이므로 승인 요청(ID: app_${shortId})이 생성되었습니다. 승인이 완료되더라도 회사가 자동으로 정지되지 않으며, 운영자의 별도 조치가 필요합니다.`;

    return {
      success: true,
      matched: true,
      command: "action.pause_company",
      resultText,
      approvalId: approval.id,
    };
  }

  function executeUnknown(transcript: string): VoiceCommandResponse {
    return {
      success: false,
      matched: false,
      command: "unknown",
      resultText: `인식할 수 없는 음성 명령입니다: "${transcript}". 지원되는 명령: 회사 상태 확인, 업무 현황 확인, 회사 일시 정지 권한 요청.`,
      error: "UNKNOWN_VOICE_COMMAND",
      approvalId: null,
    };
  }

  async function processCommand(
    companyId: string,
    rawTranscript: string,
    actor: VoiceCommandActor,
  ): Promise<VoiceCommandResponse> {
    const transcript = rawTranscript.trim();
    const command = classifyVoiceCommand(transcript);

    let response: VoiceCommandResponse;
    switch (command) {
      case "status.company":
        response = await executeCompanyStatus(companyId);
        break;
      case "status.work":
        response = await executeWorkStatus(companyId);
        break;
      case "action.pause_company":
        response = await executePauseCompany(companyId, actor);
        break;
      case "unknown":
      default:
        response = executeUnknown(transcript);
        break;
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType === "user" ? "user" : "system",
      actorId: actor.actorId,
      action: "voice_control.command_processed",
      entityType: "voice_command",
      entityId: randomUUID(),
      details: {
        command: response.command,
        transcript,
        matched: response.matched,
        success: response.success,
        approvalId: response.approvalId ?? null,
        error: response.error ?? null,
      },
    });

    return response;
  }

  return {
    classifyVoiceCommand,
    processCommand,
  };
}
