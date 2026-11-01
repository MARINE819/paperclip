import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";
import { voiceApi, type VoiceCommandResponse } from "@/api/voice";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

// Minimal local ambient shape for the non-standard Web Speech API — not part
// of TS's lib.dom.d.ts, and we deliberately avoid adding a @types package for
// it (native-browser-only per Stage 10 Master 1차 scope, no new dependency).
interface SpeechRecognitionResultLike {
  0: { transcript: string };
}
interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionErrorEventLike {
  error: string;
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
}
type SpeechRecognitionConstructorLike = new () => SpeechRecognitionLike;

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructorLike | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructorLike;
    webkitSpeechRecognition?: SpeechRecognitionConstructorLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function isSpeechSynthesisSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export type VoiceBarState =
  | "unsupported"
  | "idle"
  | "listening"
  | "processing"
  | "success"
  | "unknown"
  | "dangerous-approval-requested"
  | "error";

/**
 * The only condition allowed to render the "approval requested" UI. All four
 * clauses must hold — any contradictory combination (e.g. the dangerous
 * command matched but approvalId is missing, or success is false) falls
 * through to the generic error state instead of ever claiming an approval
 * was created. This mirrors the CEO-locked strict predicate exactly.
 */
function isApprovalRequested(response: VoiceCommandResponse): boolean {
  return (
    response.success === true &&
    response.matched === true &&
    response.command === "action.pause_company" &&
    response.approvalId != null
  );
}

export interface VoiceCommandBarProps {
  companyId: string;
  onStateChange?: (state: VoiceBarState) => void;
}

export function VoiceCommandBar({ companyId, onStateChange }: VoiceCommandBarProps) {
  const supported = useRef(getSpeechRecognitionConstructor() !== null).current;
  const ttsSupported = useRef(isSpeechSynthesisSupported()).current;
  const [state, setState] = useState<VoiceBarState>(supported ? "idle" : "unsupported");
  const [resultText, setResultText] = useState<string | null>(null);
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    onStateChange?.(state);
  }, [state, onStateChange]);

  const speak = useCallback(
    (text: string) => {
      if (!ttsEnabled || !ttsSupported) return;
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    },
    [ttsEnabled, ttsSupported],
  );

  const handleTranscript = useCallback(
    async (transcript: string) => {
      setState("processing");
      try {
        const response = await voiceApi.submitCommand(companyId, transcript);
        // The server response is the sole authoritative source — the raw
        // transcript string is never re-interpreted here.
        if (response.command === "unknown" || response.matched === false) {
          setState("unknown");
          setResultText(response.resultText);
          speak(response.resultText);
          return;
        }
        if (response.command === "action.pause_company") {
          if (isApprovalRequested(response)) {
            setState("dangerous-approval-requested");
            setResultText(response.resultText);
            speak(response.resultText);
          } else {
            // Contradictory response (matched a dangerous command but the
            // strict predicate failed) — never imply an approval exists.
            setState("error");
            setResultText("Unexpected response from the server.");
          }
          return;
        }
        setState("success");
        setResultText(response.resultText);
        speak(response.resultText);
      } catch {
        setState("error");
        setResultText("Voice command request failed.");
      }
    },
    [companyId, speak],
  );

  const startListening = useCallback(() => {
    const Ctor = getSpeechRecognitionConstructor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.lang = "ko-KR";
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript ?? "";
      void handleTranscript(transcript);
    };
    recognition.onerror = (event) => {
      setState("error");
      setResultText(
        event.error === "not-allowed"
          ? "마이크 권한이 필요합니다. (Microphone permission is required.)"
          : "음성 인식에 실패했습니다. (Voice recognition failed.)",
      );
    };
    recognition.onend = () => {
      setState((current) => (current === "listening" ? "idle" : current));
    };
    recognitionRef.current = recognition;
    setState("listening");
    setResultText(null);
    recognition.start();
  }, [handleTranscript]);

  if (state === "unsupported") {
    return (
      <div className="flex flex-col gap-1 text-sm" data-testid="voice-command-bar-unsupported">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" disabled aria-label="Voice input unsupported">
            <MicOff />
          </Button>
          <span className="text-xs text-muted-foreground">
            한국어 음성 입력은 보안 연결(HTTPS/localhost) 및 지원 브라우저가 필요합니다. (Voice input requires Chrome or Edge.)
          </span>
        </div>
        <span className="text-xs text-muted-foreground">
          iPhone(iOS Safari) 및 모바일에서는 HTTPS 접속 시 마이크 터치로 작동하며, 미지원 환경에서는 상단 JARVIS 텍스트 지시창을 사용하세요.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="voice-command-bar">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={state === "listening" ? "destructive" : "outline"}
          size="icon"
          onClick={startListening}
          disabled={state === "listening" || state === "processing"}
          aria-label="Start voice command"
        >
          <Mic />
        </Button>
        <span className="text-xs text-muted-foreground">
          {state === "listening"
            ? "한국어 음성 인식 중... (Listening...)"
            : state === "processing"
              ? "JARVIS 음성 명령 처리 중... (Processing...)"
              : "마이크를 눌러 한국어로 지시하세요 (예: 회사 상태, 업무 현황, 회사 일시 정지)"}
        </span>
        {ttsSupported ? (
          <div className="flex items-center gap-1">
            <ToggleSwitch checked={ttsEnabled} onCheckedChange={setTtsEnabled} aria-label="Voice reply (TTS)" />
            <span className="text-xs text-muted-foreground">음성 답변 읽기 (Speak result)</span>
          </div>
        ) : null}
      </div>

      {resultText ? (
        <div className="flex flex-col gap-1 text-sm">
          {state === "unknown" ? (
            <span className="text-destructive">{resultText}</span>
          ) : state === "error" ? (
            <span className="text-destructive">{resultText}</span>
          ) : (
            <span className="text-foreground">{resultText}</span>
          )}
          {state === "dangerous-approval-requested" ? (
            <div className="flex flex-col gap-1 rounded-md border p-2">
              <Badge variant="secondary" className="w-fit">
                Approval requested (CEO 승인 요청됨)
              </Badge>
              <span className="text-xs text-muted-foreground">
                The company has not been paused. Approving this request does not
                automatically execute the action — pausing the company still
                requires a separate, authorized operator action. (음성 명령만으로는 회사가 즉시 정지되지 않으며 기존 승인·보안 절차를 따릅니다.)
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
