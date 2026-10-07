import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent } from "@paperclipai/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { jarvisApi, type SubmitToJarvisResult } from "@/api/jarvis";
import { ApiError } from "@/api/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Bot, CheckCircle2, ExternalLink, Loader2, Send, Square, Volume2 } from "lucide-react";
import { AIOfficeVoiceMicButton } from "@/components/AIOfficeVoiceMicButton";
import { AIOfficeVoiceSpeakerButton } from "@/components/AIOfficeVoiceSpeakerButton";
import {
  defaultVoiceSttAdapter,
  defaultVoiceTtsAdapter,
  type VoiceSttAdapter,
  type VoiceTtsAdapter,
} from "@/lib/voice-adapter";

export interface AIOfficeJarvisTaskInstructionProps {
  companyId: string | null;
  jarvisAgent: Agent | null;
  agentById?: Map<string, Agent>;
  onSuccess?: (result: SubmitToJarvisResult) => void;
  voiceAdapter?: VoiceSttAdapter;
  ttsAdapter?: VoiceTtsAdapter;
}

export function AIOfficeJarvisTaskInstruction({
  companyId,
  jarvisAgent,
  agentById,
  onSuccess,
  voiceAdapter,
  ttsAdapter,
}: AIOfficeJarvisTaskInstructionProps) {
  const queryClient = useQueryClient();
  const [requestText, setRequestText] = useState("");
  const [lastResult, setLastResult] = useState<SubmitToJarvisResult | null>(null);

  const adapter = voiceAdapter ?? defaultVoiceSttAdapter;
  const tts = ttsAdapter ?? defaultVoiceTtsAdapter;

  const [isListening, setIsListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const stopListeningRef = useRef<(() => void) | null>(null);

  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [lastSpokenText, setLastSpokenText] = useState<string | null>(null);

  const handleStopTts = useCallback(() => {
    tts.stop();
    setIsSpeaking(false);
  }, [tts]);

  const speakResponse = useCallback(
    (text: string) => {
      setLastSpokenText(text);
      if (!ttsEnabled || !tts.isSupported()) return;

      // Collision prevention: stop any active STT listening when TTS starts speaking
      if (isListening) {
        stopListeningRef.current?.();
        stopListeningRef.current = null;
        setIsListening(false);
      }

      setIsSpeaking(true);
      tts.speak(text, {
        onStart: () => setIsSpeaking(true),
        onEnd: () => setIsSpeaking(false),
        onError: () => setIsSpeaking(false),
      });
    },
    [isListening, tts, ttsEnabled],
  );

  const handleToggleVoice = useCallback(() => {
    // Collision prevention: stop any playing TTS when starting STT
    tts.stop();
    setIsSpeaking(false);

    if (isListening) {
      stopListeningRef.current?.();
      stopListeningRef.current = null;
      setIsListening(false);
      return;
    }

    setVoiceError(null);
    setIsListening(true);

    const cleanup = adapter.startListening({
      onResult: (transcript) => {
        setRequestText((prev) => {
          const trimmed = prev.trim();
          return trimmed ? `${trimmed} ${transcript}` : transcript;
        });
        setIsListening(false);
      },
      onError: (err) => {
        setVoiceError(err);
        setIsListening(false);
      },
      onEnd: () => {
        setIsListening(false);
      },
    });

    stopListeningRef.current = cleanup;
  }, [adapter, isListening, tts]);

  useEffect(() => {
    return () => {
      stopListeningRef.current?.();
      tts.stop();
    };
  }, [tts]);

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (isListening) {
        stopListeningRef.current?.();
        stopListeningRef.current = null;
        setIsListening(false);
      }
      if (!companyId) throw new Error("회사 ID가 필요합니다.");
      if (!jarvisAgent) throw new Error("JARVIS 에이전트를 찾을 수 없습니다.");
      const trimmed = requestText.trim();
      if (!trimmed) throw new Error("업무 지시 내용을 입력해주세요.");

      return jarvisApi.submit(companyId, {
        jarvisAgentId: jarvisAgent.id,
        requestText: trimmed,
      });
    },
    onSuccess: (result) => {
      setLastResult(result);
      setRequestText("");
      // 실제 사용 중인 AI Office 및 이슈 query key 최소 무효화
      queryClient.invalidateQueries({ queryKey: ["ai-office-2d-live-runs"] });
      queryClient.invalidateQueries({ queryKey: ["ai-office-dashboard-summary"] });
      queryClient.invalidateQueries({ queryKey: ["issues"] });
      onSuccess?.(result);

      const assignedAgent = result.selectedAgentId
        ? agentById?.get(result.selectedAgentId)?.name ?? result.selectedAgentId
        : "에이전트";
      let speech = `업무가 접수되었습니다. 담당 전문가 ${assignedAgent}에게 배정되었습니다.`;
      if (result.parentIssueDeduplicated) {
        speech += " 기존 동일 업무와 연계되었습니다.";
      }
      speakResponse(speech);
    },
  });

  let errorMessage: string | null = null;
  if (submitMutation.isError) {
    const err = submitMutation.error;
    if (err instanceof ApiError) {
      if (err.status === 400) {
        errorMessage = `요청 형식 오류 (400): ${err.message}`;
      } else if (err.status === 403) {
        errorMessage = `권한 거부 (403): ${err.message}`;
      } else if (err.status === 422) {
        const body = err.body as { detail?: string; error?: string; reason?: string } | null;
        const detail = body?.detail || body?.reason || err.message;
        errorMessage = `업무 계획 수립 불가 (422): ${detail}`;
      } else {
        errorMessage = `서버 오류 (${err.status}): ${err.message}`;
      }
    } else {
      errorMessage = err instanceof Error ? err.message : "업무 지시 전송에 실패했습니다.";
    }
  }

  const assignedSpecialistName = lastResult?.selectedAgentId
    ? agentById?.get(lastResult.selectedAgentId)?.name ?? lastResult.selectedAgentId
    : null;

  const isSubmitDisabled =
    !companyId ||
    !jarvisAgent ||
    submitMutation.isPending ||
    requestText.trim().length === 0;

  return (
    <Card className="border-border bg-card shadow-xs" data-testid="mobile-jarvis-task-instruction-card">
      <CardHeader className="p-3 pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-primary" aria-hidden="true" />
            <CardTitle className="text-xs font-semibold text-foreground">
              자비스(JARVIS) 업무 지시
            </CardTitle>
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            {jarvisAgent ? (
              <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                <span>자비스 연결됨</span>
              </span>
            ) : (
              <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400 font-medium">
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                <span>JARVIS 미발견</span>
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5 p-3 pt-0">
        {!jarvisAgent ? (
          <div
            className="rounded border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-800 dark:text-amber-200"
            data-testid="mobile-jarvis-missing-agent-notice"
          >
            현재 회사에 등록된 JARVIS 에이전트를 찾을 수 없습니다. (에이전트 이름: JARVIS 필요)
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <textarea
              data-testid="mobile-jarvis-instruction-input"
              rows={2}
              value={requestText}
              onChange={(e) => setRequestText(e.target.value)}
              placeholder="자비스에게 위임할 업무 내용을 입력하세요... (예: '모바일 결재 화면 E2E 테스트 검증해줘')"
              disabled={submitMutation.isPending}
              className="w-full resize-none rounded-md border border-border bg-background p-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-1 focus:ring-ring disabled:opacity-50"
            />

            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <AIOfficeVoiceMicButton
                  isListening={isListening}
                  isSupported={adapter.isSupported()}
                  disabled={!jarvisAgent || submitMutation.isPending}
                  onToggle={handleToggleVoice}
                />
                <AIOfficeVoiceSpeakerButton
                  enabled={ttsEnabled}
                  isSpeaking={isSpeaking}
                  isSupported={tts.isSupported()}
                  disabled={!jarvisAgent || submitMutation.isPending}
                  onToggle={() => setTtsEnabled((prev) => !prev)}
                  onStop={handleStopTts}
                />
                {voiceError ? (
                  <span
                    data-testid="mobile-jarvis-voice-error"
                    className="text-xs text-destructive truncate max-w-48"
                    title={voiceError}
                  >
                    {voiceError}
                  </span>
                ) : isListening ? (
                  <span className="text-xs text-muted-foreground animate-pulse">
                    말씀하시면 텍스트로 입력됩니다...
                  </span>
                ) : isSpeaking ? (
                  <span className="text-xs text-primary animate-pulse">
                    답변을 읽고 있습니다...
                  </span>
                ) : null}
              </div>

              <Button
                type="button"
                size="sm"
                variant="default"
                disabled={isSubmitDisabled}
                onClick={() => submitMutation.mutate()}
                data-testid="mobile-jarvis-submit-btn"
                className="h-8 px-3 text-xs font-semibold shrink-0"
              >
                {submitMutation.isPending ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    <span>지시 분석 및 업무 생성 중...</span>
                  </>
                ) : (
                  <>
                    <Send className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                    <span>자비스에게 지시 전송</span>
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        {/* 성공 접수 영수증 (Success Receipt) */}
        {lastResult ? (
          <div
            className="flex flex-col gap-1.5 rounded border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-xs text-emerald-900 dark:text-emerald-100"
            data-testid="mobile-jarvis-success-receipt"
          >
            <div className="flex items-center gap-1.5 font-semibold text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              <span>업무 접수 및 전문가 배정 완료</span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground pt-1 border-t border-emerald-500/20">
              <div className="flex items-center gap-1">
                <span className="font-medium text-foreground">상위 업무 (Parent):</span>{" "}
                <a
                  href={`/issues/${lastResult.parentIssueId}`}
                  className="font-mono text-primary underline hover:text-primary/80 inline-flex items-center gap-0.5"
                  data-testid="jarvis-receipt-parent-link"
                >
                  <span>{lastResult.parentIssueId.slice(0, 8)}</span>
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              </div>
              <div className="flex items-center gap-1">
                <span className="font-medium text-foreground">하위 실행 (Child):</span>{" "}
                <a
                  href={`/issues/${lastResult.childIssueId}`}
                  className="font-mono text-primary underline hover:text-primary/80 inline-flex items-center gap-0.5"
                  data-testid="jarvis-receipt-child-link"
                >
                  <span>{lastResult.childIssueId.slice(0, 8)}</span>
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              </div>
              <div>
                <span className="font-medium text-foreground">배정 전문가:</span>{" "}
                <span className="font-semibold text-foreground">{assignedSpecialistName}</span>
              </div>
              {lastResult.parentIssueDeduplicated ? (
                <div className="text-amber-600 dark:text-amber-400">
                  (기존 동일 업무 연계됨)
                </div>
              ) : null}
              {lastSpokenText ? (
                <div className="flex w-full items-center justify-between border-t border-emerald-500/20 pt-1.5 mt-1">
                  <span className="text-xs text-muted-foreground">음성 안내</span>
                  {isSpeaking ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={handleStopTts}
                      data-testid="jarvis-receipt-tts-stop-btn"
                      className="h-6 px-2 text-xs"
                    >
                      <Square className="h-3 w-3 fill-current mr-1" aria-hidden="true" />
                      <span>말하기 중지</span>
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!tts.isSupported()}
                      onClick={() => speakResponse(lastSpokenText)}
                      data-testid="jarvis-receipt-tts-replay-btn"
                      className="h-6 px-2 text-xs font-medium"
                    >
                      <Volume2 className="h-3 w-3 text-primary mr-1" aria-hidden="true" />
                      <span>다시 듣기</span>
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* 오류 안내 배너 (Error Banner) */}
        {errorMessage ? (
          <div
            className="flex items-start gap-1.5 rounded border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive"
            data-testid="mobile-jarvis-error-alert"
          >
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
            <div className="leading-snug">{errorMessage}</div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
