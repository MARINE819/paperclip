// ui/src/lib/voice-adapter.ts

export interface SpeechRecognitionResultLike {
  0: { transcript: string };
}

export interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
}

export interface SpeechRecognitionErrorEventLike {
  error: string;
}

export interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop?: () => void;
  abort?: () => void;
}

export type SpeechRecognitionConstructorLike = new () => SpeechRecognitionLike;

export function getSpeechRecognitionConstructor(): SpeechRecognitionConstructorLike | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructorLike;
    webkitSpeechRecognition?: SpeechRecognitionConstructorLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface VoiceSttCallbacks {
  onResult: (transcript: string) => void;
  onError?: (error: string) => void;
  onEnd?: () => void;
}

export interface VoiceSttAdapter {
  isSupported: () => boolean;
  startListening: (callbacks: VoiceSttCallbacks) => () => void;
}

export const SPEECH_ERROR_MESSAGES: Record<string, string> = {
  "no-speech": "음성이 감지되지 않았습니다. 다시 말씀해주세요.",
  "not-allowed": "마이크 사용 권한이 거부되었습니다.",
  "audio-capture": "마이크 장치를 찾을 수 없습니다.",
  "network": "음성 인식 네트워크 연결에 실패했습니다.",
  "aborted": "음성 인식이 취소되었습니다.",
  "service-not-allowed": "음성 인식 서비스를 사용할 수 없습니다.",
};

export function formatSpeechRecognitionError(error: string | undefined): string {
  if (!error) return "음성 인식 중 오류가 발생했습니다.";
  return SPEECH_ERROR_MESSAGES[error] ?? "음성 인식 중 오류가 발생했습니다.";
}

export function createBrowserVoiceSttAdapter(
  getConstructor: () => SpeechRecognitionConstructorLike | null = getSpeechRecognitionConstructor,
): VoiceSttAdapter {
  return {
    isSupported: () => getConstructor() !== null,
    startListening: (callbacks: VoiceSttCallbacks) => {
      const Ctor = getConstructor();
      if (!Ctor) {
        callbacks.onError?.("음성 인식을 지원하지 않는 브라우저입니다.");
        callbacks.onEnd?.();
        return () => {};
      }

      try {
        const recognition = new Ctor();
        recognition.lang = "ko-KR";
        recognition.interimResults = false;

        let stopped = false;

        recognition.onresult = (event) => {
          if (stopped) return;
          const transcript = event.results[0]?.[0]?.transcript ?? "";
          if (transcript.trim()) {
            callbacks.onResult(transcript.trim());
          }
        };

        recognition.onerror = (event) => {
          if (stopped) return;
          callbacks.onError?.(formatSpeechRecognitionError(event.error));
        };

        recognition.onend = () => {
          if (stopped) return;
          callbacks.onEnd?.();
        };

        recognition.start();

        return () => {
          stopped = true;
          try {
            if (typeof recognition.stop === "function") {
              recognition.stop();
            } else if (typeof recognition.abort === "function") {
              recognition.abort();
            }
          } catch {
            // ignore cleanup errors
          }
        };
      } catch (err) {
        callbacks.onError?.(err instanceof Error ? err.message : "음성 인식을 시작할 수 없습니다.");
        callbacks.onEnd?.();
        return () => {};
      }
    },
  };
}

export const defaultVoiceSttAdapter = createBrowserVoiceSttAdapter();
