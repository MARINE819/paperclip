import { Square, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface AIOfficeVoiceSpeakerButtonProps {
  enabled: boolean;
  isSpeaking: boolean;
  isSupported: boolean;
  disabled?: boolean;
  onToggle: () => void;
  onStop: () => void;
}

export function AIOfficeVoiceSpeakerButton({
  enabled,
  isSpeaking,
  isSupported,
  disabled = false,
  onToggle,
  onStop,
}: AIOfficeVoiceSpeakerButtonProps) {
  if (!isSupported) {
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled
        title="브라우저에서 음성 출력을 지원하지 않습니다"
        aria-label="음성 출력 미지원"
        data-testid="mobile-jarvis-voice-speaker-btn"
        className="h-8 px-2.5 text-xs text-muted-foreground opacity-50 shrink-0"
      >
        <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="sr-only">음성 출력 미지원</span>
      </Button>
    );
  }

  if (isSpeaking) {
    return (
      <Button
        type="button"
        size="sm"
        variant="destructive"
        disabled={disabled}
        onClick={onStop}
        aria-label="음성 답변 중지"
        data-testid="mobile-jarvis-voice-speaker-btn"
        className="h-8 px-2.5 text-xs font-medium transition-colors shrink-0 animate-pulse"
      >
        <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
        <span className="ml-1 text-xs">말하기 중지</span>
      </Button>
    );
  }

  return (
    <Button
      type="button"
      size="sm"
      variant={enabled ? "outline" : "ghost"}
      disabled={disabled}
      onClick={onToggle}
      aria-pressed={enabled}
      aria-label={enabled ? "음성 답변 끄기" : "음성 답변 켜기"}
      data-testid="mobile-jarvis-voice-speaker-btn"
      className="h-8 px-2.5 text-xs font-medium transition-colors shrink-0"
    >
      {enabled ? (
        <>
          <Volume2 className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          <span className="ml-1 text-xs">음성 ON</span>
        </>
      ) : (
        <>
          <VolumeX className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="ml-1 text-xs text-muted-foreground">음성 OFF</span>
        </>
      )}
    </Button>
  );
}
