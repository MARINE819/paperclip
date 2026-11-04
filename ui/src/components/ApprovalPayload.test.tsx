// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalPayloadRenderer, approvalLabel } from "./ApprovalPayload";
import { ThemeProvider } from "../context/ThemeContext";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("approvalLabel", () => {
  it("uses payload titles for generic board approvals", () => {
    expect(
      approvalLabel("request_board_approval", {
        title: "Reply with an ASCII frog",
      }),
    ).toBe("Board Approval: Reply with an ASCII frog");
  });
});

describe("ApprovalPayloadRenderer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders request_board_approval payload fields without falling back to raw JSON", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            payload={{
              title: "Reply with an ASCII frog",
              summary: "Board asked for approval before posting the frog.",
              recommendedAction: "Approve the frog reply.",
              nextActionOnApproval: "Post the frog comment on the issue.",
              risks: ["The frog might be too powerful."],
              proposedComment: "(o)<",
            }}
          />
        </ThemeProvider>,
      );
    });

    expect(container.textContent).toContain("Reply with an ASCII frog");
    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).toContain("Approve the frog reply.");
    expect(container.textContent).toContain("Post the frog comment on the issue.");
    expect(container.textContent).toContain("The frog might be too powerful.");
    expect(container.textContent).toContain("(o)<");
    expect(container.textContent).not.toContain("\"recommendedAction\"");

    act(() => {
      root.unmount();
    });
  });

  it("renders markdown in board approval prose fields", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            payload={{
              title: "Reply with an ASCII frog",
              summary: "**Bold** and `code` and [a link](https://example.com).",
              recommendedAction: "Approve the **frog** reply.",
              nextActionOnApproval: "Post the `frog` comment.",
              risks: ["The **frog** might be too powerful."],
            }}
          />
        </ThemeProvider>,
      );
    });

    const bodies = container.querySelectorAll(".paperclip-markdown");
    expect(bodies.length).toBe(4);

    const summary = bodies[0];
    expect(summary.querySelector("strong")?.textContent).toBe("Bold");
    expect(summary.querySelector("code")?.textContent).toBe("code");
    const link = summary.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com");
    expect(link?.textContent).toBe("a link");

    // The raw markdown characters must not survive into the rendered text.
    expect(container.textContent).not.toContain("**Bold**");
    expect(container.textContent).not.toContain("[a link](https://example.com)");

    expect(bodies[1].querySelector("strong")?.textContent).toBe("frog");
    expect(bodies[2].querySelector("code")?.textContent).toBe("frog");
    expect(bodies[3].querySelector("strong")?.textContent).toBe("frog");

    act(() => {
      root.unmount();
    });
  });

  it("does not nest a second bullet when a risk is authored as a markdown list item", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            payload={{
              title: "Reply with an ASCII frog",
              risks: [
                "- **Leading dash** risk.",
                "* Leading star risk.",
                "• Leading dot risk.",
                "1. Leading number risk.",
                "2) Leading paren risk.",
              ],
            }}
          />
        </ThemeProvider>,
      );
    });

    const bodies = container.querySelectorAll(".paperclip-markdown");
    expect(bodies.length).toBe(5);
    for (const body of bodies) {
      expect(body.querySelector("ul")).toBeNull();
      expect(body.querySelector("ol")).toBeNull();
      expect(body.querySelector("li")).toBeNull();
    }

    expect(bodies[0].querySelector("strong")?.textContent).toBe("Leading dash");
    expect(container.textContent).toContain("Leading star risk.");
    expect(container.textContent).toContain("Leading dot risk.");
    expect(container.textContent).toContain("Leading number risk.");
    expect(container.textContent).toContain("Leading paren risk.");
    expect(container.textContent).not.toContain("- **Leading dash**");

    act(() => {
      root.unmount();
    });
  });

  it("renders every risk when two entries collapse to the same text after marker stripping", () => {
    const root = createRoot(container);
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      act(() => {
        root.render(
          <ThemeProvider>
            <ApprovalPayloadRenderer
              type="request_board_approval"
              payload={{
                title: "Reply with an ASCII frog",
                risks: ["- Low probability", "* Low probability"],
              }}
            />
          </ThemeProvider>,
        );
      });

      expect(container.querySelectorAll(".paperclip-markdown").length).toBe(2);
      expect(errors).toEqual([]);
    } finally {
      console.error = originalError;
      act(() => {
        root.unmount();
      });
    }
  });

  it("can hide the repeated title when the card header already shows it", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            hidePrimaryTitle
            payload={{
              title: "Reply with an ASCII frog",
              summary: "Board asked for approval before posting the frog.",
            }}
          />
        </ThemeProvider>,
      );
    });

    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).not.toContain("TitleReply with an ASCII frog");

    act(() => {
      root.unmount();
    });
  });

  it("shows SAVE_CANDIDATE/NEEDS_REVIEW/EXCLUDED counts from summaryCounts", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            payload={{
              title: "SYNC-02 daily report",
              summaryCounts: { saveCandidateCount: 5, needsReviewCount: 2, excludedCount: 1 },
            }}
          />
        </ThemeProvider>,
      );
    });

    expect(container.textContent).toContain("SAVE_CANDIDATE: 5");
    expect(container.textContent).toContain("NEEDS_REVIEW: 2");
    expect(container.textContent).toContain("EXCLUDED: 1");

    act(() => {
      root.unmount();
    });
  });

  it("still shows a count of 0 instead of hiding it", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            payload={{
              title: "SYNC-02 daily report",
              summaryCounts: { saveCandidateCount: 0, needsReviewCount: 0, excludedCount: 0 },
            }}
          />
        </ThemeProvider>,
      );
    });

    expect(container.textContent).toContain("SAVE_CANDIDATE: 0");
    expect(container.textContent).toContain("NEEDS_REVIEW: 0");
    expect(container.textContent).toContain("EXCLUDED: 0");

    act(() => {
      root.unmount();
    });
  });

  it("shows save readiness as 저장 준비 가능 when readyForPrepare is true", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            payload={{ title: "SYNC-02 daily report", readyForPrepare: true }}
          />
        </ThemeProvider>,
      );
    });

    expect(container.textContent).toContain("저장 준비 가능");
    expect(container.textContent).not.toContain("저장 준비 불가");

    act(() => {
      root.unmount();
    });
  });

  it("shows save readiness as 저장 준비 불가 when readyForPrepare is false", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            payload={{ title: "SYNC-02 daily report", readyForPrepare: false }}
          />
        </ThemeProvider>,
      );
    });

    expect(container.textContent).toContain("저장 준비 불가");
    expect(container.textContent).not.toContain("저장 준비 가능");

    act(() => {
      root.unmount();
    });
  });

  it("renders the full report inside a <details> that is closed by default", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            payload={{
              title: "SYNC-02 daily report",
              reportMarkdown: "# Full Report\n\nSAVE_CANDIDATE list here.",
            }}
          />
        </ThemeProvider>,
      );
    });

    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBeFalsy();

    act(() => {
      root.unmount();
    });
  });

  // jsdom does not reliably implement the native browser toggle-on-click
  // behavior for <details>/<summary> (a user click in a real browser flips
  // `.open`, but jsdom's click simulation does not consistently reproduce
  // this). This test verifies the fallback explicitly allowed by the task:
  // opening/closing via the `open` DOM property directly, and confirming
  // the component's own rendering reacts correctly to that state.
  it("exposes the markdown-rendered report once open is set, and the <details> element reports closed again once reset (open-property-level check)", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            payload={{ title: "SYNC-02 daily report", reportMarkdown: "**bold report body**" }}
          />
        </ThemeProvider>,
      );
    });

    const details = container.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBeFalsy();

    act(() => {
      details.open = true;
    });
    expect(details.open).toBe(true);
    const markdownBody = details.querySelector(".paperclip-markdown");
    expect(markdownBody).not.toBeNull();
    expect(markdownBody?.querySelector("strong")?.textContent).toBe("bold report body");

    act(() => {
      details.open = false;
    });
    expect(details.open).toBe(false);

    act(() => {
      root.unmount();
    });
  });

  it("renders a pre-existing approval with no SYNC-02 fields exactly as before (no empty sections)", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            payload={{
              title: "Reply with an ASCII frog",
              summary: "Board asked for approval before posting the frog.",
            }}
          />
        </ThemeProvider>,
      );
    });

    expect(container.textContent).toContain("Reply with an ASCII frog");
    expect(container.textContent).not.toContain("Save candidates");
    expect(container.textContent).not.toContain("Save readiness");
    expect(container.textContent).not.toContain("Full report");
    expect(container.querySelector("details")).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("does not leak SYNC-02 fields into other approval types (hire_agent regression)", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="hire_agent"
            payload={{
              name: "Designer",
              role: "designer",
              summaryCounts: { saveCandidateCount: 9 },
              readyForPrepare: true,
              reportMarkdown: "should not render for hire_agent",
            }}
          />
        </ThemeProvider>,
      );
    });

    expect(container.textContent).toContain("Designer");
    expect(container.textContent).not.toContain("Save candidates");
    expect(container.textContent).not.toContain("저장 준비 가능");
    expect(container.textContent).not.toContain("should not render for hire_agent");
    expect(container.querySelector("details")).toBeNull();

    act(() => {
      root.unmount();
    });
  });
});
