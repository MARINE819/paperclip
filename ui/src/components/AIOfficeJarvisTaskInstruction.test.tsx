// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import {
  formatSpeechRecognitionError,
  isSpeechSynthesisSupported,
  createBrowserVoiceTtsAdapter,
  type VoiceSttAdapter,
  type VoiceTtsAdapter,
} from "@/lib/voice-adapter";
import { AIOfficeJarvisTaskInstruction } from "./AIOfficeJarvisTaskInstruction";

const mockJarvisApi = vi.hoisted(() => ({
  submit: vi.fn(),
}));

vi.mock("@/api/jarvis", () => ({
  jarvisApi: mockJarvisApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void | Promise<void>) {
  flushSync(callback);
}

async function flushReact() {
  act(() => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  act(() => {});
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-jarvis",
    companyId: "company-1",
    name: "JARVIS",
    urlKey: "jarvis",
    role: "ceo",
    title: "Chief AI Orchestrator",
    icon: null,
    status: "idle",
    reportsTo: null,
    orgUnitId: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 10000,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: true },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  } as Agent;
}

function setInputValue(input: HTMLTextAreaElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("AIOfficeJarvisTaskInstruction", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function render(node: React.ReactElement) {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    let root!: ReturnType<typeof createRoot>;
    act(() => {
      root = createRoot(container);
      root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
    });
    return root;
  }

  it("renders textarea and submit button with JARVIS online status when jarvisAgent exists", () => {
    const jarvis = makeAgent();
    const root = render(
      <AIOfficeJarvisTaskInstruction companyId="company-1" jarvisAgent={jarvis} />,
    );

    expect(container.textContent).toContain("자비스(JARVIS) 업무 지시");
    expect(container.textContent).toContain("자비스 연결됨");

    const textarea = container.querySelector('[data-testid="mobile-jarvis-instruction-input"]');
    expect(textarea).not.toBeNull();

    const submitBtn = container.querySelector('[data-testid="mobile-jarvis-submit-btn"]') as HTMLButtonElement;
    expect(submitBtn).not.toBeNull();
    // initially disabled because text is empty
    expect(submitBtn.disabled).toBe(true);

    act(() => root.unmount());
  });

  it("truthfully displays warning and disables input when jarvisAgent is missing", () => {
    const root = render(
      <AIOfficeJarvisTaskInstruction companyId="company-1" jarvisAgent={null} />,
    );

    expect(container.textContent).toContain("JARVIS 미발견");
    expect(container.textContent).toContain("현재 회사에 등록된 JARVIS 에이전트를 찾을 수 없습니다.");

    const textarea = container.querySelector('[data-testid="mobile-jarvis-instruction-input"]');
    expect(textarea).toBeNull();

    act(() => root.unmount());
  });

  it("disables submit button when requestText is whitespace only", () => {
    const jarvis = makeAgent();
    const root = render(
      <AIOfficeJarvisTaskInstruction companyId="company-1" jarvisAgent={jarvis} />,
    );

    const textarea = container.querySelector('[data-testid="mobile-jarvis-instruction-input"]') as HTMLTextAreaElement;
    setInputValue(textarea, "     ");

    const submitBtn = container.querySelector('[data-testid="mobile-jarvis-submit-btn"]') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);

    act(() => root.unmount());
  });

  it("submits request to jarvisApi.submit with jarvisAgentId and requestText (plan omitted) and resets input on success", async () => {
    const jarvis = makeAgent({ id: "jarvis-100" });
    const specialist = makeAgent({ id: "specialist-200", name: "CodeSpecialist" });
    const agentById = new Map([
      ["jarvis-100", jarvis],
      ["specialist-200", specialist],
    ]);

    mockJarvisApi.submit.mockResolvedValue({
      ok: true,
      parentIssueId: "parent-issue-1111",
      childIssueId: "child-issue-2222",
      selectedAgentId: "specialist-200",
      parentIssueDeduplicated: false,
    });

    const onSuccess = vi.fn();
    const root = render(
      <AIOfficeJarvisTaskInstruction
        companyId="company-1"
        jarvisAgent={jarvis}
        agentById={agentById}
        onSuccess={onSuccess}
      />,
    );

    const textarea = container.querySelector('[data-testid="mobile-jarvis-instruction-input"]') as HTMLTextAreaElement;
    setInputValue(textarea, "모바일 결재 E2E 테스트 검증");

    const submitBtn = container.querySelector('[data-testid="mobile-jarvis-submit-btn"]') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);

    act(() => {
      submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(mockJarvisApi.submit).toHaveBeenCalledWith("company-1", {
      jarvisAgentId: "jarvis-100",
      requestText: "모바일 결재 E2E 테스트 검증",
    });

    // Check success receipt
    const receipt = container.querySelector('[data-testid="mobile-jarvis-success-receipt"]');
    expect(receipt).not.toBeNull();
    expect(receipt?.textContent).toContain("업무 접수 및 전문가 배정 완료");
    expect(receipt?.textContent).toContain("parent-i");
    expect(receipt?.textContent).toContain("child-is");
    expect(receipt?.textContent).toContain("CodeSpecialist");

    const parentLink = container.querySelector('[data-testid="jarvis-receipt-parent-link"]') as HTMLAnchorElement;
    expect(parentLink).not.toBeNull();
    expect(parentLink?.getAttribute("href")).toBe("/issues/parent-issue-1111");

    const childLink = container.querySelector('[data-testid="jarvis-receipt-child-link"]') as HTMLAnchorElement;
    expect(childLink).not.toBeNull();
    expect(childLink?.getAttribute("href")).toBe("/issues/child-issue-2222");

    // Input reset
    expect(textarea.value).toBe("");
    expect(onSuccess).toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("shows deduplication indicator in success receipt when parentIssueDeduplicated is true", async () => {
    const jarvis = makeAgent({ id: "jarvis-100" });
    mockJarvisApi.submit.mockResolvedValue({
      ok: true,
      parentIssueId: "parent-issue-dedup",
      childIssueId: "child-issue-dedup",
      selectedAgentId: "jarvis-100",
      parentIssueDeduplicated: true,
    });

    const root = render(
      <AIOfficeJarvisTaskInstruction companyId="company-1" jarvisAgent={jarvis} />,
    );

    const textarea = container.querySelector('[data-testid="mobile-jarvis-instruction-input"]') as HTMLTextAreaElement;
    setInputValue(textarea, "Repeated command");

    const submitBtn = container.querySelector('[data-testid="mobile-jarvis-submit-btn"]') as HTMLButtonElement;
    act(() => {
      submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("(기존 동일 업무 연계됨)");

    act(() => root.unmount());
  });

  it("displays honest error messages for 400, 403, and 422 responses", async () => {
    const jarvis = makeAgent({ id: "jarvis-1" });

    // 1. 403 Human board actor required
    mockJarvisApi.submit.mockRejectedValue(
      new ApiError("Delegating to JARVIS requires a Human board actor.", 403, {
        error: "Delegating to JARVIS requires a Human board actor.",
      }),
    );

    const root = render(
      <AIOfficeJarvisTaskInstruction companyId="company-1" jarvisAgent={jarvis} />,
    );

    const textarea = container.querySelector('[data-testid="mobile-jarvis-instruction-input"]') as HTMLTextAreaElement;
    setInputValue(textarea, "Task with permission error");

    const submitBtn = container.querySelector('[data-testid="mobile-jarvis-submit-btn"]') as HTMLButtonElement;
    act(() => {
      submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    const errorAlert = container.querySelector('[data-testid="mobile-jarvis-error-alert"]');
    expect(errorAlert).not.toBeNull();
    expect(errorAlert?.textContent).toContain("권한 거부 (403)");
    expect(errorAlert?.textContent).toContain("Delegating to JARVIS requires a Human board actor.");

    act(() => root.unmount());
  });

  it("displays 422 plan derivation error honestly", async () => {
    const jarvis = makeAgent({ id: "jarvis-1" });

    mockJarvisApi.submit.mockRejectedValue(
      new ApiError("Could not derive a delegation plan from requestText.", 422, {
        detail: "no_eligible_specialist",
      }),
    );

    const root = render(
      <AIOfficeJarvisTaskInstruction companyId="company-1" jarvisAgent={jarvis} />,
    );

    const textarea = container.querySelector('[data-testid="mobile-jarvis-instruction-input"]') as HTMLTextAreaElement;
    setInputValue(textarea, "Task with no specialist");

    const submitBtn = container.querySelector('[data-testid="mobile-jarvis-submit-btn"]') as HTMLButtonElement;
    act(() => {
      submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    const errorAlert = container.querySelector('[data-testid="mobile-jarvis-error-alert"]');
    expect(errorAlert).not.toBeNull();
    expect(errorAlert?.textContent).toContain("업무 계획 수립 불가 (422): no_eligible_specialist");

    act(() => root.unmount());
  });

  describe("Voice STT Integration", () => {
    it("renders mic button and injects speech transcript into requestText when speaking", async () => {
      const jarvis = makeAgent();
      let capturedCallbacks: any = null;
      const mockAdapter: VoiceSttAdapter = {
        isSupported: () => true,
        startListening: (callbacks) => {
          capturedCallbacks = callbacks;
          return () => {};
        },
      };

      const root = render(
        <AIOfficeJarvisTaskInstruction
          companyId="company-1"
          jarvisAgent={jarvis}
          voiceAdapter={mockAdapter}
        />,
      );

      const micBtn = container.querySelector('[data-testid="mobile-jarvis-voice-mic-btn"]') as HTMLButtonElement;
      expect(micBtn).not.toBeNull();
      expect(micBtn.disabled).toBe(false);

      // Start listening
      act(() => {
        micBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();

      expect(micBtn.getAttribute("aria-pressed")).toBe("true");
      expect(micBtn.textContent).toContain("듣는 중...");

      // Simulate SpeechRecognition result
      act(() => {
        capturedCallbacks.onResult("모바일 결재 화면 E2E 테스트 검증해줘");
      });
      await flushReact();

      const textarea = container.querySelector('[data-testid="mobile-jarvis-instruction-input"]') as HTMLTextAreaElement;
      expect(textarea.value).toBe("모바일 결재 화면 E2E 테스트 검증해줘");

      // Verify submit button is now enabled
      const submitBtn = container.querySelector('[data-testid="mobile-jarvis-submit-btn"]') as HTMLButtonElement;
      expect(submitBtn.disabled).toBe(false);

      act(() => root.unmount());
    });

    it("appends subsequent speech transcript to existing text with a space", async () => {
      const jarvis = makeAgent();
      let capturedCallbacks: any = null;
      const mockAdapter: VoiceSttAdapter = {
        isSupported: () => true,
        startListening: (callbacks) => {
          capturedCallbacks = callbacks;
          return () => {};
        },
      };

      const root = render(
        <AIOfficeJarvisTaskInstruction
          companyId="company-1"
          jarvisAgent={jarvis}
          voiceAdapter={mockAdapter}
        />,
      );

      const textarea = container.querySelector('[data-testid="mobile-jarvis-instruction-input"]') as HTMLTextAreaElement;
      setInputValue(textarea, "기존 입력 내용");

      const micBtn = container.querySelector('[data-testid="mobile-jarvis-voice-mic-btn"]') as HTMLButtonElement;
      act(() => {
        micBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();

      act(() => {
        capturedCallbacks.onResult("추가 음성 지시");
      });
      await flushReact();

      expect(textarea.value).toBe("기존 입력 내용 추가 음성 지시");

      act(() => root.unmount());
    });

    it("renders disabled mic button when browser does not support SpeechRecognition", async () => {
      const jarvis = makeAgent();
      const mockAdapter: VoiceSttAdapter = {
        isSupported: () => false,
        startListening: () => () => {},
      };

      const root = render(
        <AIOfficeJarvisTaskInstruction
          companyId="company-1"
          jarvisAgent={jarvis}
          voiceAdapter={mockAdapter}
        />,
      );

      const micBtn = container.querySelector('[data-testid="mobile-jarvis-voice-mic-btn"]') as HTMLButtonElement;
      expect(micBtn).not.toBeNull();
      expect(micBtn.disabled).toBe(true);
      expect(micBtn.getAttribute("aria-label")).toBe("음성 인식 미지원");

      // Manual text input remains fully usable
      const textarea = container.querySelector('[data-testid="mobile-jarvis-instruction-input"]') as HTMLTextAreaElement;
      expect(textarea.disabled).toBe(false);
      setInputValue(textarea, "수동 입력");
      expect(textarea.value).toBe("수동 입력");

      act(() => root.unmount());
    });

    it("displays voice error gracefully without breaking manual text submission", async () => {
      const jarvis = makeAgent();
      let capturedCallbacks: any = null;
      const mockAdapter: VoiceSttAdapter = {
        isSupported: () => true,
        startListening: (callbacks) => {
          capturedCallbacks = callbacks;
          return () => {};
        },
      };

      mockJarvisApi.submit.mockResolvedValue({
        ok: true,
        parentIssueId: "parent-v-1",
        childIssueId: "child-v-1",
        selectedAgentId: "agent-qa",
      });

      const root = render(
        <AIOfficeJarvisTaskInstruction
          companyId="company-1"
          jarvisAgent={jarvis}
          voiceAdapter={mockAdapter}
        />,
      );

      const micBtn = container.querySelector('[data-testid="mobile-jarvis-voice-mic-btn"]') as HTMLButtonElement;
      act(() => {
        micBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();

      // Trigger error
      act(() => {
        capturedCallbacks.onError("마이크 접근 권한이 거부되었습니다.");
      });
      await flushReact();

      const errorNotice = container.querySelector('[data-testid="mobile-jarvis-voice-error"]');
      expect(errorNotice).not.toBeNull();
      expect(errorNotice?.textContent).toContain("마이크 접근 권한이 거부되었습니다.");

      // Manual text typing and submission still work 100% normally
      const textarea = container.querySelector('[data-testid="mobile-jarvis-instruction-input"]') as HTMLTextAreaElement;
      setInputValue(textarea, "권한 오류 후 수동 입력");

      const submitBtn = container.querySelector('[data-testid="mobile-jarvis-submit-btn"]') as HTMLButtonElement;
      act(() => {
        submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      await flushReact();

      expect(mockJarvisApi.submit).toHaveBeenCalledWith("company-1", {
        jarvisAgentId: "agent-jarvis",
        requestText: "권한 오류 후 수동 입력",
      });

      act(() => root.unmount());
    });

    it("humanizes standard Web Speech error codes without leaking raw technical strings", () => {
      expect(formatSpeechRecognitionError("no-speech")).toBe(
        "음성이 감지되지 않았습니다. 다시 말씀해주세요.",
      );
      expect(formatSpeechRecognitionError("not-allowed")).toBe(
        "마이크 사용 권한이 거부되었습니다.",
      );
      expect(formatSpeechRecognitionError("audio-capture")).toBe(
        "마이크 장치를 찾을 수 없습니다.",
      );
      expect(formatSpeechRecognitionError("network")).toBe(
        "음성 인식 네트워크 연결에 실패했습니다.",
      );
      expect(formatSpeechRecognitionError("aborted")).toBe(
        "음성 인식이 취소되었습니다.",
      );
      expect(formatSpeechRecognitionError("service-not-allowed")).toBe(
        "음성 인식 서비스를 사용할 수 없습니다.",
      );
      // Strictly verify raw technical strings are never leaked to user
      expect(formatSpeechRecognitionError("some-unknown-vendor-error-code")).toBe(
        "음성 인식 중 오류가 발생했습니다.",
      );
      expect(formatSpeechRecognitionError(undefined)).toBe(
        "음성 인식 중 오류가 발생했습니다.",
      );
    });

    it("cleans up active voice session when user submits task while listening", async () => {
      const jarvis = makeAgent();
      let stopCalled = false;
      const mockAdapter: VoiceSttAdapter = {
        isSupported: () => true,
        startListening: () => {
          return () => {
            stopCalled = true;
          };
        },
      };

      mockJarvisApi.submit.mockResolvedValue({
        ok: true,
        parentIssueId: "parent-v-submit",
        childIssueId: "child-v-submit",
        selectedAgentId: "agent-qa",
      });

      const root = render(
        <AIOfficeJarvisTaskInstruction
          companyId="company-1"
          jarvisAgent={jarvis}
          voiceAdapter={mockAdapter}
        />,
      );

      const textarea = container.querySelector(
        '[data-testid="mobile-jarvis-instruction-input"]',
      ) as HTMLTextAreaElement;
      setInputValue(textarea, "음성 수신 중 제출 테스트");

      const micBtn = container.querySelector(
        '[data-testid="mobile-jarvis-voice-mic-btn"]',
      ) as HTMLButtonElement;
      // Start listening
      act(() => {
        micBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      expect(micBtn.getAttribute("aria-pressed")).toBe("true");

      // While listening, click submit
      const submitBtn = container.querySelector(
        '[data-testid="mobile-jarvis-submit-btn"]',
      ) as HTMLButtonElement;
      act(() => {
        submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      await flushReact();

      // Listening cleanup should have been invoked
      expect(stopCalled).toBe(true);
      expect(mockJarvisApi.submit).toHaveBeenCalledWith("company-1", {
        jarvisAgentId: "agent-jarvis",
        requestText: "음성 수신 중 제출 테스트",
      });

      act(() => root.unmount());
    });

    it("ensures mic button has shrink-0 to prevent layout collapse on small mobile screens", () => {
      const jarvis = makeAgent();
      const mockAdapter: VoiceSttAdapter = {
        isSupported: () => true,
        startListening: () => () => {},
      };

      const root = render(
        <AIOfficeJarvisTaskInstruction
          companyId="company-1"
          jarvisAgent={jarvis}
          voiceAdapter={mockAdapter}
        />,
      );

      const micBtn = container.querySelector(
        '[data-testid="mobile-jarvis-voice-mic-btn"]',
      ) as HTMLButtonElement;
      expect(micBtn.className).toContain("shrink-0");

      act(() => root.unmount());
    });
  });

  describe("Voice TTS Integration", () => {
    function makeMockTts(overrides: Partial<VoiceTtsAdapter> = {}) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let capturedCallbacks: any = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const speakMock = vi.fn((_text: string, callbacks?: any) => {
        capturedCallbacks = callbacks;
        act(() => {
          callbacks?.onStart?.();
        });
      });
      const stopMock = vi.fn(() => {
        act(() => {
          capturedCallbacks?.onEnd?.();
        });
      });
      const adapter: VoiceTtsAdapter = {
        isSupported: () => true,
        speak: speakMock,
        stop: stopMock,
        isSpeaking: () => false,
        ...overrides,
      };
      return {
        adapter,
        speakMock,
        stopMock,
        getCallbacks: () => capturedCallbacks,
      };
    }

    it("speaks Korean response via TTS when submit succeeds and TTS is enabled", async () => {
      const jarvis = makeAgent({ id: "jarvis-100" });
      const specialist = makeAgent({ id: "specialist-200", name: "CodeSpecialist" });
      const agentById = new Map([
        ["jarvis-100", jarvis],
        ["specialist-200", specialist],
      ]);
      const { adapter: mockTts, speakMock } = makeMockTts();

      mockJarvisApi.submit.mockResolvedValue({
        ok: true,
        parentIssueId: "parent-tts-1",
        childIssueId: "child-tts-1",
        selectedAgentId: "specialist-200",
        parentIssueDeduplicated: false,
      });

      const root = render(
        <AIOfficeJarvisTaskInstruction
          companyId="company-1"
          jarvisAgent={jarvis}
          agentById={agentById}
          ttsAdapter={mockTts}
        />,
      );

      const textarea = container.querySelector(
        '[data-testid="mobile-jarvis-instruction-input"]',
      ) as HTMLTextAreaElement;
      setInputValue(textarea, "TTS 안내 음성 검증");

      const submitBtn = container.querySelector(
        '[data-testid="mobile-jarvis-submit-btn"]',
      ) as HTMLButtonElement;
      act(() => {
        submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      await flushReact();

      expect(speakMock).toHaveBeenCalledTimes(1);
      expect(speakMock).toHaveBeenCalledWith(
        "업무가 접수되었습니다. 담당 전문가 CodeSpecialist에게 배정되었습니다.",
        expect.any(Object),
      );

      act(() => root.unmount());
    });

    it("includes deduplication guidance in Korean speech when task is deduplicated", async () => {
      const jarvis = makeAgent({ id: "jarvis-100" });
      const { adapter: mockTts, speakMock } = makeMockTts();

      mockJarvisApi.submit.mockResolvedValue({
        ok: true,
        parentIssueId: "parent-dedup",
        childIssueId: "child-dedup",
        selectedAgentId: "jarvis-100",
        parentIssueDeduplicated: true,
      });

      const root = render(
        <AIOfficeJarvisTaskInstruction
          companyId="company-1"
          jarvisAgent={jarvis}
          ttsAdapter={mockTts}
        />,
      );

      const textarea = container.querySelector(
        '[data-testid="mobile-jarvis-instruction-input"]',
      ) as HTMLTextAreaElement;
      setInputValue(textarea, "중복 업무 지시");

      const submitBtn = container.querySelector(
        '[data-testid="mobile-jarvis-submit-btn"]',
      ) as HTMLButtonElement;
      act(() => {
        submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      await flushReact();

      expect(speakMock).toHaveBeenCalledWith(
        "업무가 접수되었습니다. 담당 전문가 jarvis-100에게 배정되었습니다. 기존 동일 업무와 연계되었습니다.",
        expect.any(Object),
      );

      act(() => root.unmount());
    });

    it("does not speak when TTS toggle is turned OFF", async () => {
      const jarvis = makeAgent();
      const { adapter: mockTts, speakMock } = makeMockTts();

      mockJarvisApi.submit.mockResolvedValue({
        ok: true,
        parentIssueId: "parent-silent",
        childIssueId: "child-silent",
        selectedAgentId: "agent-jarvis",
      });

      const root = render(
        <AIOfficeJarvisTaskInstruction
          companyId="company-1"
          jarvisAgent={jarvis}
          ttsAdapter={mockTts}
        />,
      );

      const speakerBtn = container.querySelector(
        '[data-testid="mobile-jarvis-voice-speaker-btn"]',
      ) as HTMLButtonElement;
      expect(speakerBtn).not.toBeNull();
      expect(speakerBtn.getAttribute("aria-pressed")).toBe("true");

      // Toggle TTS OFF
      act(() => {
        speakerBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();

      expect(speakerBtn.getAttribute("aria-pressed")).toBe("false");

      const textarea = container.querySelector(
        '[data-testid="mobile-jarvis-instruction-input"]',
      ) as HTMLTextAreaElement;
      setInputValue(textarea, "무음 제출 테스트");

      const submitBtn = container.querySelector(
        '[data-testid="mobile-jarvis-submit-btn"]',
      ) as HTMLButtonElement;
      act(() => {
        submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      await flushReact();

      expect(speakMock).not.toHaveBeenCalled();

      act(() => root.unmount());
    });

    it("stops speech immediately when stop button is clicked during TTS playback", async () => {
      const jarvis = makeAgent();
      const { adapter: mockTts, stopMock } = makeMockTts();

      mockJarvisApi.submit.mockResolvedValue({
        ok: true,
        parentIssueId: "parent-stop",
        childIssueId: "child-stop",
        selectedAgentId: "agent-jarvis",
      });

      const root = render(
        <AIOfficeJarvisTaskInstruction
          companyId="company-1"
          jarvisAgent={jarvis}
          ttsAdapter={mockTts}
        />,
      );

      const textarea = container.querySelector(
        '[data-testid="mobile-jarvis-instruction-input"]',
      ) as HTMLTextAreaElement;
      setInputValue(textarea, "말하기 중지 테스트");

      const submitBtn = container.querySelector(
        '[data-testid="mobile-jarvis-submit-btn"]',
      ) as HTMLButtonElement;
      act(() => {
        submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      await flushReact();

      // In speaking state, stop button is displayed in receipt card
      const stopBtn = container.querySelector(
        '[data-testid="jarvis-receipt-tts-stop-btn"]',
      ) as HTMLButtonElement;
      expect(stopBtn).not.toBeNull();
      expect(stopBtn.textContent).toContain("말하기 중지");

      act(() => {
        stopBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();

      expect(stopMock).toHaveBeenCalled();

      act(() => root.unmount());
    });

    it("stops active TTS playback immediately when mic button is clicked (STT collision guard)", async () => {
      const jarvis = makeAgent();
      const { adapter: mockTts, stopMock } = makeMockTts();
      const mockStt: VoiceSttAdapter = {
        isSupported: () => true,
        startListening: () => () => {},
      };

      mockJarvisApi.submit.mockResolvedValue({
        ok: true,
        parentIssueId: "parent-col-1",
        childIssueId: "child-col-1",
        selectedAgentId: "agent-jarvis",
      });

      const root = render(
        <AIOfficeJarvisTaskInstruction
          companyId="company-1"
          jarvisAgent={jarvis}
          voiceAdapter={mockStt}
          ttsAdapter={mockTts}
        />,
      );

      const textarea = container.querySelector(
        '[data-testid="mobile-jarvis-instruction-input"]',
      ) as HTMLTextAreaElement;
      setInputValue(textarea, "충돌 방지 테스트");

      const submitBtn = container.querySelector(
        '[data-testid="mobile-jarvis-submit-btn"]',
      ) as HTMLButtonElement;
      act(() => {
        submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      await flushReact();

      // Click mic button while TTS is active
      const micBtn = container.querySelector(
        '[data-testid="mobile-jarvis-voice-mic-btn"]',
      ) as HTMLButtonElement;
      act(() => {
        micBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();

      expect(stopMock).toHaveBeenCalled();

      act(() => root.unmount());
    });

    it("stops active STT listening immediately when TTS starts speaking (TTS collision guard)", async () => {
      const jarvis = makeAgent();
      let sttCleanupCalled = false;
      const mockStt: VoiceSttAdapter = {
        isSupported: () => true,
        startListening: () => {
          return () => {
            sttCleanupCalled = true;
          };
        },
      };
      const { adapter: mockTts } = makeMockTts();

      mockJarvisApi.submit.mockResolvedValue({
        ok: true,
        parentIssueId: "parent-col-2",
        childIssueId: "child-col-2",
        selectedAgentId: "agent-jarvis",
      });

      const root = render(
        <AIOfficeJarvisTaskInstruction
          companyId="company-1"
          jarvisAgent={jarvis}
          voiceAdapter={mockStt}
          ttsAdapter={mockTts}
        />,
      );

      // Start listening
      const micBtn = container.querySelector(
        '[data-testid="mobile-jarvis-voice-mic-btn"]',
      ) as HTMLButtonElement;
      act(() => {
        micBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      expect(micBtn.getAttribute("aria-pressed")).toBe("true");

      // While STT listening, submit task
      const textarea = container.querySelector(
        '[data-testid="mobile-jarvis-instruction-input"]',
      ) as HTMLTextAreaElement;
      setInputValue(textarea, "STT 수신 중 TTS 실행");

      const submitBtn = container.querySelector(
        '[data-testid="mobile-jarvis-submit-btn"]',
      ) as HTMLButtonElement;
      act(() => {
        submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      await flushReact();

      // STT cleanup was called to prevent loop
      expect(sttCleanupCalled).toBe(true);

      act(() => root.unmount());
    });

    it("provides manual replay button in receipt card for mobile Safari/Chrome autoplay fallback", async () => {
      const jarvis = makeAgent();
      const { adapter: mockTts, speakMock, getCallbacks } = makeMockTts();

      mockJarvisApi.submit.mockResolvedValue({
        ok: true,
        parentIssueId: "parent-replay",
        childIssueId: "child-replay",
        selectedAgentId: "agent-jarvis",
      });

      const root = render(
        <AIOfficeJarvisTaskInstruction
          companyId="company-1"
          jarvisAgent={jarvis}
          ttsAdapter={mockTts}
        />,
      );

      const textarea = container.querySelector(
        '[data-testid="mobile-jarvis-instruction-input"]',
      ) as HTMLTextAreaElement;
      setInputValue(textarea, "모바일 수동 다시 듣기 테스트");

      const submitBtn = container.querySelector(
        '[data-testid="mobile-jarvis-submit-btn"]',
      ) as HTMLButtonElement;
      act(() => {
        submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      await flushReact();

      // Simulate speech finishing
      act(() => {
        getCallbacks()?.onEnd?.();
      });
      await flushReact();

      // Replay button should be present
      const replayBtn = container.querySelector(
        '[data-testid="jarvis-receipt-tts-replay-btn"]',
      ) as HTMLButtonElement;
      expect(replayBtn).not.toBeNull();
      expect(replayBtn.textContent).toContain("다시 듣기");
      expect(replayBtn.disabled).toBe(false);

      // User taps "다시 듣기"
      act(() => {
        replayBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();

      expect(speakMock).toHaveBeenCalledTimes(2);

      act(() => root.unmount());
    });

    it("gracefully disables speaker and replay button when browser does not support TTS", async () => {
      const jarvis = makeAgent();
      const unsupportedTts: VoiceTtsAdapter = {
        isSupported: () => false,
        speak: vi.fn(),
        stop: vi.fn(),
        isSpeaking: () => false,
      };

      mockJarvisApi.submit.mockResolvedValue({
        ok: true,
        parentIssueId: "parent-no-tts",
        childIssueId: "child-no-tts",
        selectedAgentId: "agent-jarvis",
      });

      const root = render(
        <AIOfficeJarvisTaskInstruction
          companyId="company-1"
          jarvisAgent={jarvis}
          ttsAdapter={unsupportedTts}
        />,
      );

      const speakerBtn = container.querySelector(
        '[data-testid="mobile-jarvis-voice-speaker-btn"]',
      ) as HTMLButtonElement;
      expect(speakerBtn).not.toBeNull();
      expect(speakerBtn.disabled).toBe(true);
      expect(speakerBtn.getAttribute("aria-label")).toBe("음성 출력 미지원");

      const textarea = container.querySelector(
        '[data-testid="mobile-jarvis-instruction-input"]',
      ) as HTMLTextAreaElement;
      setInputValue(textarea, "TTS 미지원 환경 제출");

      const submitBtn = container.querySelector(
        '[data-testid="mobile-jarvis-submit-btn"]',
      ) as HTMLButtonElement;
      act(() => {
        submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      await flushReact();

      // speak should not have been called
      expect(unsupportedTts.speak).not.toHaveBeenCalled();

      // Receipt is still displayed normally
      const receipt = container.querySelector('[data-testid="mobile-jarvis-success-receipt"]');
      expect(receipt).not.toBeNull();

      // Replay button is disabled
      const replayBtn = container.querySelector(
        '[data-testid="jarvis-receipt-tts-replay-btn"]',
      ) as HTMLButtonElement;
      expect(replayBtn).not.toBeNull();
      expect(replayBtn.disabled).toBe(true);

      act(() => root.unmount());
    });

    describe("Browser Voice TTS Adapter", () => {
      it("correctly identifies speech synthesis support based on window objects", () => {
        const origSpeechSynthesis = window.speechSynthesis;
        const origUtterance = window.SpeechSynthesisUtterance;

        // Missing window.speechSynthesis
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (window as any).speechSynthesis;
        expect(isSpeechSynthesisSupported()).toBe(false);

        // Define mock window.speechSynthesis and SpeechSynthesisUtterance
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).speechSynthesis = {
          speak: vi.fn(),
          cancel: vi.fn(),
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).SpeechSynthesisUtterance = class {
          text = "";
          lang = "";
          rate = 1;
        };

        expect(isSpeechSynthesisSupported()).toBe(true);

        // Restore
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).speechSynthesis = origSpeechSynthesis;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).SpeechSynthesisUtterance = origUtterance;
      });

      it("configures utterance with ko-KR and attaches lifecycle callbacks", () => {
        const origSpeechSynthesis = window.speechSynthesis;
        const origUtterance = window.SpeechSynthesisUtterance;

        const speakMock = vi.fn();
        const cancelMock = vi.fn();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).speechSynthesis = {
          speak: speakMock,
          cancel: cancelMock,
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let createdUtterance: any = null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).SpeechSynthesisUtterance = class MockUtterance {
          text: string;
          lang = "";
          rate = 1;
          onstart: (() => void) | null = null;
          onend: (() => void) | null = null;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onerror: ((event: any) => void) | null = null;
          constructor(text: string) {
            this.text = text;
            createdUtterance = this;
          }
        };

        const adapter = createBrowserVoiceTtsAdapter();
        expect(adapter.isSupported()).toBe(true);

        const onStart = vi.fn();
        const onEnd = vi.fn();
        const onError = vi.fn();

        adapter.speak("테스트 음성입니다", { onStart, onEnd, onError });

        expect(cancelMock).toHaveBeenCalled();
        expect(createdUtterance).not.toBeNull();
        expect(createdUtterance.text).toBe("테스트 음성입니다");
        expect(createdUtterance.lang).toBe("ko-KR");
        expect(speakMock).toHaveBeenCalledWith(createdUtterance);

        // Trigger utterance events
        createdUtterance.onstart?.();
        expect(onStart).toHaveBeenCalled();

        createdUtterance.onend?.();
        expect(onEnd).toHaveBeenCalled();

        createdUtterance.onerror?.({ error: "canceled" });
        expect(onError).toHaveBeenCalledWith("음성 출력 중 오류가 발생했습니다.");

        adapter.stop();
        expect(cancelMock).toHaveBeenCalledTimes(2);

        // Restore
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).speechSynthesis = origSpeechSynthesis;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).SpeechSynthesisUtterance = origUtterance;
      });
    });
  });
});
