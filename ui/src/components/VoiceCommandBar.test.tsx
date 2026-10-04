// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceCommandResponse } from "../api/voice";
import { VoiceCommandBar } from "./VoiceCommandBar";

const mockVoiceApi = vi.hoisted(() => ({
  submitCommand: vi.fn(),
}));

vi.mock("../api/voice", async () => {
  const actual = await vi.importActual<typeof import("../api/voice")>("../api/voice");
  return { ...actual, voiceApi: mockVoiceApi };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

interface RecognitionResultLike {
  0: { transcript: string };
}

class MockSpeechRecognition {
  lang = "";
  interimResults = true;
  onresult: ((event: { results: ArrayLike<RecognitionResultLike> }) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
}

let lastRecognitionInstance: MockSpeechRecognition | null = null;

function installSpeechRecognition() {
  class TrackedMockSpeechRecognition extends MockSpeechRecognition {
    constructor() {
      super();
      lastRecognitionInstance = this;
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).SpeechRecognition = TrackedMockSpeechRecognition;
}

function uninstallSpeechRecognition() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).SpeechRecognition;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).webkitSpeechRecognition;
  lastRecognitionInstance = null;
}

function installSpeechSynthesis() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).speechSynthesis = { speak: vi.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (globalThis as any).SpeechSynthesisUtterance === "undefined") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).SpeechSynthesisUtterance = class {
      text: string;
      constructor(text: string) {
        this.text = text;
      }
    };
  }
}

function uninstallSpeechSynthesis() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).speechSynthesis;
}

function makeResponse(overrides: Partial<VoiceCommandResponse> = {}): VoiceCommandResponse {
  return {
    success: true,
    matched: true,
    command: "status.company",
    resultText: "The server is running.",
    approvalId: null,
    error: null,
    ...overrides,
  };
}

describe("VoiceCommandBar", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    uninstallSpeechRecognition();
    uninstallSpeechSynthesis();
    vi.clearAllMocks();
  });

  function render() {
    const root = createRoot(container);
    act(() => {
      root.render(<VoiceCommandBar companyId="company-1" />);
    });
    return root;
  }

  async function speak(transcript: string) {
    act(() => {
      lastRecognitionInstance?.onresult?.({ results: [{ 0: { transcript } }] });
    });
    await flushReact();
    await flushReact();
  }

  it("1. shows unsupported UI and disables the mic when SpeechRecognition is absent", () => {
    const root = render();

    expect(container.textContent).toContain("Voice input requires Chrome or Edge.");
    const button = container.querySelector("button");
    expect(button?.disabled).toBe(true);

    act(() => root.unmount());
  });

  it("2. shows a permission-denied message on mic error 'not-allowed'", async () => {
    installSpeechRecognition();
    const root = render();

    const micButton = container.querySelector("button")!;
    act(() => {
      micButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      lastRecognitionInstance?.onerror?.({ error: "not-allowed" });
    });
    await flushReact();

    expect(container.textContent).toContain("Microphone permission is required.");

    act(() => root.unmount());
  });

  it("3. renders the status.company result text on a matched read-only command", async () => {
    installSpeechRecognition();
    mockVoiceApi.submitCommand.mockResolvedValue(
      makeResponse({ command: "status.company", resultText: "Server: healthy. 3 agents idle." }),
    );
    const root = render();

    const micButton = container.querySelector("button")!;
    act(() => micButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await speak("현재 서버 상태 어때?");

    expect(mockVoiceApi.submitCommand).toHaveBeenCalledWith("company-1", "현재 서버 상태 어때?");
    expect(container.textContent).toContain("Server: healthy. 3 agents idle.");

    act(() => root.unmount());
  });

  it("4. renders the status.work result text on a matched read-only command", async () => {
    installSpeechRecognition();
    mockVoiceApi.submitCommand.mockResolvedValue(
      makeResponse({ command: "status.work", resultText: "2 agents working, 1 approval pending." }),
    );
    const root = render();

    act(() => container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await speak("현재 작업 상태는?");

    expect(container.textContent).toContain("2 agents working, 1 approval pending.");

    act(() => root.unmount());
  });

  it("5. shows the approval-requested UI for a fully valid dangerous command response", async () => {
    installSpeechRecognition();
    mockVoiceApi.submitCommand.mockResolvedValue(
      makeResponse({
        command: "action.pause_company",
        resultText: "Approval request created.",
        approvalId: "approval-123",
      }),
    );
    const root = render();

    act(() => container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await speak("회사 전체 정지해줘");

    expect(container.textContent).toContain("Approval requested");
    expect(container.textContent).toContain("has not been paused");
    expect(container.textContent).toContain("does not");

    act(() => root.unmount());
  });

  it("6. shows the unknown fail-closed UI for an HTTP 200 business unknown response", async () => {
    installSpeechRecognition();
    mockVoiceApi.submitCommand.mockResolvedValue(
      makeResponse({
        success: false,
        matched: false,
        command: "unknown",
        resultText: "Sorry, I don't support that command.",
        approvalId: null,
        error: "UNKNOWN_VOICE_COMMAND",
      }),
    );
    const root = render();

    act(() => container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await speak("오늘 날씨 어때");

    expect(container.textContent).toContain("Sorry, I don't support that command.");

    act(() => root.unmount());
  });

  it("7. speaks the result via TTS when the toggle is ON", async () => {
    installSpeechRecognition();
    installSpeechSynthesis();
    mockVoiceApi.submitCommand.mockResolvedValue(
      makeResponse({ command: "status.company", resultText: "All systems normal." }),
    );
    const root = render();

    const toggle = container.querySelector('[role="switch"], button[aria-label="Voice reply (TTS)"]');
    act(() => toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    act(() => container.querySelectorAll("button")[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await speak("현재 서버 상태 어때?");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((window as any).speechSynthesis.speak).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it("8. does not call speak when TTS toggle is OFF", async () => {
    installSpeechRecognition();
    installSpeechSynthesis();
    mockVoiceApi.submitCommand.mockResolvedValue(
      makeResponse({ command: "status.company", resultText: "All systems normal." }),
    );
    const root = render();

    act(() => container.querySelectorAll("button")[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await speak("현재 서버 상태 어때?");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((window as any).speechSynthesis.speak).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("9. shows a transport-failure error, distinct from the unknown business response", async () => {
    installSpeechRecognition();
    mockVoiceApi.submitCommand.mockRejectedValue(new Error("Network error"));
    const root = render();

    act(() => container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await speak("현재 서버 상태 어때?");

    expect(container.textContent).toContain("Voice command request failed.");
    expect(container.textContent).not.toContain("don't support");

    act(() => root.unmount());
  });

  it("10. treats action.pause_company with approvalId null as an error, never approval-requested", async () => {
    installSpeechRecognition();
    mockVoiceApi.submitCommand.mockResolvedValue(
      makeResponse({ command: "action.pause_company", approvalId: null, success: true, matched: true }),
    );
    const root = render();

    act(() => container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await speak("회사 전체 정지해줘");

    expect(container.textContent).not.toContain("Approval requested");
    expect(container.textContent).toContain("Unexpected response");

    act(() => root.unmount());
  });

  it("11. treats action.pause_company with success:false as an error, never approval-requested", async () => {
    installSpeechRecognition();
    mockVoiceApi.submitCommand.mockResolvedValue(
      makeResponse({ command: "action.pause_company", approvalId: "approval-123", success: false, matched: true }),
    );
    const root = render();

    act(() => container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await speak("회사 전체 정지해줘");

    expect(container.textContent).not.toContain("Approval requested");

    act(() => root.unmount());
  });

  it("12. treats matched:false as unknown/fail-closed regardless of command", async () => {
    installSpeechRecognition();
    mockVoiceApi.submitCommand.mockResolvedValue(
      makeResponse({
        command: "action.pause_company",
        matched: false,
        success: false,
        approvalId: null,
        resultText: "Command not recognized.",
      }),
    );
    const root = render();

    act(() => container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await speak("회사 전체 정지해줘");

    expect(container.textContent).not.toContain("Approval requested");
    expect(container.textContent).toContain("Command not recognized.");

    act(() => root.unmount());
  });

  it("13/14. voiceApi.submitCommand calls the locked endpoint '/companies/:companyId/voice/command' with body { transcript }", async () => {
    // Uses the real (unmocked) voice.ts module against a mocked fetch, so the
    // exact URL and body are verified against real code, not just the
    // component-level mock used by the other tests in this file.
    const realVoiceApi = await vi.importActual<typeof import("../api/voice")>("../api/voice");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeResponse(),
    });
    const originalFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchMock;

    try {
      await realVoiceApi.voiceApi.submitCommand("company-1", "hello world");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/companies/company-1/voice/command");
    expect(url).not.toContain("/voice/commands");
    expect(JSON.parse(init.body)).toEqual({ transcript: "hello world" });
  });
});
