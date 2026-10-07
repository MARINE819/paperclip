import { Mic, MicOff } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface AIOfficeVoiceMicButtonProps {
  isListening: boolean;
  isSupported: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

export function AIOfficeVoiceMicButton({
  isListening,
  isSupported,
  disabled = false,
  onToggle,
}: AIOfficeVoiceMicButtonProps) {
  if (!isSupported) {
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled
        title="브라우저에서 음성 인식을 지원하지 않습니다"
        aria-label="음성 인식 미지원"
        data-testid="mobile-jarvis-voice-mic-btn"
        className="h-8 px-2.5 text-xs text-muted-foreground opacity-50 shrink-0"
      >
        <MicOff className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="sr-only">음성 미지원</span>
      </Button>
    );
  }

  return (
    <Button
      type="button"
      size="sm"
      variant={isListening ? "destructive" : "outline"}
      disabled={disabled}
      onClick={onToggle}
      aria-pressed={isListening}
      aria-label={isListening ? "음성 인식 중지" : "음성으로 지시하기"}
      data-testid="mobile-jarvis-voice-mic-btn"
      className={`h-8 px-2.5 text-xs font-medium transition-colors shrink-0 ${
        isListening ? "animate-pulse" : ""
      }`}
    >
      <Mic className={`h-3.5 w-3.5 ${isListening ? "" : "text-primary"}`} aria-hidden="true" />
      <span className="ml-1 text-xs">
        {isListening ? "듣는 중..." : "음성 지시"}
      </span>
    </Button>
  );
}
