// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ControlCenterTabs,
  parseControlCenterTab,
  useControlCenterTab,
  type ControlCenterTabId,
} from "./ControlCenterTabs";

describe("ControlCenterTabs", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    window.history.replaceState({}, "", "/ai-office");
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    window.history.replaceState({}, "", "/");
  });

  async function flushReact() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }

  // 1. parseControlCenterTab logic
  describe("parseControlCenterTab", () => {
    it("returns valid tab identifiers", () => {
      expect(parseControlCenterTab("sre")).toBe("sre");
      expect(parseControlCenterTab("security")).toBe("security");
      expect(parseControlCenterTab("knowledge")).toBe("knowledge");
      expect(parseControlCenterTab("quality")).toBe("quality");
      expect(parseControlCenterTab("all")).toBe("all");
    });

    it("fails safely to 'sre' when input is invalid or missing", () => {
      expect(parseControlCenterTab(null)).toBe("sre");
      expect(parseControlCenterTab(undefined)).toBe("sre");
      expect(parseControlCenterTab("")).toBe("sre");
      expect(parseControlCenterTab("unknown")).toBe("sre");
      expect(parseControlCenterTab("admin")).toBe("sre");
    });
  });

  // 2. ControlCenterTabs component rendering & accessibility
  describe("Component Rendering & Accessibility", () => {
    it("renders all 5 tabs with correct accessibility attributes", async () => {
      let activeTab: ControlCenterTabId = "sre";
      const root = createRoot(container);

      act(() => {
        root.render(
          <ControlCenterTabs
            activeTab={activeTab}
            onTabChange={(tab) => {
              activeTab = tab;
            }}
          />,
        );
      });
      await flushReact();

      const tablist = container.querySelector('[role="tablist"]');
      expect(tablist).not.toBeNull();
      expect(tablist?.getAttribute("aria-label")).toBe("Control Center Tabs");

      const tabs = container.querySelectorAll('[role="tab"]');
      expect(tabs.length).toBe(5);

      // Verify individual tabs
      const sreTab = container.querySelector('[data-testid="control-center-tab-sre"]');
      const secTab = container.querySelector('[data-testid="control-center-tab-security"]');
      const knowTab = container.querySelector('[data-testid="control-center-tab-knowledge"]');
      const qualTab = container.querySelector('[data-testid="control-center-tab-quality"]');
      const allTab = container.querySelector('[data-testid="control-center-tab-all"]');

      expect(sreTab).not.toBeNull();
      expect(secTab).not.toBeNull();
      expect(knowTab).not.toBeNull();
      expect(qualTab).not.toBeNull();
      expect(allTab).not.toBeNull();

      // SRE is active by default
      expect(sreTab?.getAttribute("aria-selected")).toBe("true");
      expect(sreTab?.getAttribute("data-state")).toBe("active");
      expect(secTab?.getAttribute("aria-selected")).toBe("false");
      expect(secTab?.getAttribute("data-state")).toBe("inactive");

      act(() => root.unmount());
    });

    it("renders optional badges when provided", async () => {
      const root = createRoot(container);
      act(() => {
        root.render(
          <ControlCenterTabs
            activeTab="sre"
            onTabChange={() => {}}
            counts={{ sre: 3, security: 1 }}
          />,
        );
      });
      await flushReact();

      const sreBadge = container.querySelector('[data-testid="tab-badge-sre"]');
      expect(sreBadge?.textContent).toBe("3");

      const secBadge = container.querySelector('[data-testid="tab-badge-security"]');
      expect(secBadge?.textContent).toBe("1");

      const qualBadge = container.querySelector('[data-testid="tab-badge-quality"]');
      expect(qualBadge).toBeNull();

      act(() => root.unmount());
    });

    it("triggers onTabChange when a tab is clicked", async () => {
      let selected: ControlCenterTabId = "sre";
      const root = createRoot(container);
      act(() => {
        root.render(
          <ControlCenterTabs
            activeTab={selected}
            onTabChange={(tab) => {
              selected = tab;
            }}
          />,
        );
      });
      await flushReact();

      const securityTab = container.querySelector('[data-testid="control-center-tab-security"]') as HTMLButtonElement;
      act(() => {
        securityTab.click();
      });
      await flushReact();

      expect(selected).toBe("security");

      act(() => root.unmount());
    });
  });

  // 3. useControlCenterTab hook & URL Synchronization
  describe("useControlCenterTab Hook", () => {
    function TestConsumer() {
      const [tab, setTab] = useControlCenterTab("sre");
      return (
        <div>
          <span data-testid="current-tab">{tab}</span>
          <button data-testid="btn-sre" onClick={() => setTab("sre")}>
            SRE
          </button>
          <button data-testid="btn-security" onClick={() => setTab("security")}>
            Security
          </button>
          <button data-testid="btn-knowledge" onClick={() => setTab("knowledge")}>
            Knowledge
          </button>
          <button data-testid="btn-all" onClick={() => setTab("all")}>
            All
          </button>
          <div data-testid="panel-sre">{tab === "sre" || tab === "all" ? "SRE Panel Content" : null}</div>
          <div data-testid="panel-security">{tab === "security" || tab === "all" ? "Security Panel Content" : null}</div>
          <div data-testid="panel-knowledge">{tab === "knowledge" || tab === "all" ? "Knowledge Panel Content" : null}</div>
        </div>
      );
    }

    it("initializes to 'sre' when no URL parameter is provided", async () => {
      window.history.replaceState({}, "", "/ai-office");
      const root = createRoot(container);
      act(() => {
        root.render(<TestConsumer />);
      });
      await flushReact();

      expect(container.querySelector('[data-testid="current-tab"]')?.textContent).toBe("sre");
      expect(container.querySelector('[data-testid="panel-sre"]')?.textContent).toBe("SRE Panel Content");
      expect(container.querySelector('[data-testid="panel-security"]')?.textContent).toBe("");
      expect(container.querySelector('[data-testid="panel-knowledge"]')?.textContent).toBe("");

      act(() => root.unmount());
    });

    it("initializes to URL parameter when valid (?tab=security)", async () => {
      window.history.replaceState({}, "", "/ai-office?tab=security");
      const root = createRoot(container);
      act(() => {
        root.render(<TestConsumer />);
      });
      await flushReact();

      expect(container.querySelector('[data-testid="current-tab"]')?.textContent).toBe("security");
      expect(container.querySelector('[data-testid="panel-security"]')?.textContent).toBe("Security Panel Content");
      expect(container.querySelector('[data-testid="panel-sre"]')?.textContent).toBe("");

      act(() => root.unmount());
    });

    it("fails safely to 'sre' on invalid URL parameter (?tab=invalid123)", async () => {
      window.history.replaceState({}, "", "/ai-office?tab=invalid123");
      const root = createRoot(container);
      act(() => {
        root.render(<TestConsumer />);
      });
      await flushReact();

      expect(container.querySelector('[data-testid="current-tab"]')?.textContent).toBe("sre");
      expect(container.querySelector('[data-testid="panel-sre"]')?.textContent).toBe("SRE Panel Content");

      act(() => root.unmount());
    });

    it("updates window.location.search and mounts corresponding panel on tab change", async () => {
      window.history.replaceState({}, "", "/ai-office");
      const root = createRoot(container);
      act(() => {
        root.render(<TestConsumer />);
      });
      await flushReact();

      // Click Security
      const btnSec = container.querySelector('[data-testid="btn-security"]') as HTMLButtonElement;
      act(() => {
        btnSec.click();
      });
      await flushReact();

      expect(container.querySelector('[data-testid="current-tab"]')?.textContent).toBe("security");
      expect(container.querySelector('[data-testid="panel-security"]')?.textContent).toBe("Security Panel Content");
      expect(container.querySelector('[data-testid="panel-sre"]')?.textContent).toBe("");
      expect(window.location.search).toContain("tab=security");

      // Click Knowledge
      const btnKnow = container.querySelector('[data-testid="btn-knowledge"]') as HTMLButtonElement;
      act(() => {
        btnKnow.click();
      });
      await flushReact();

      expect(container.querySelector('[data-testid="current-tab"]')?.textContent).toBe("knowledge");
      expect(container.querySelector('[data-testid="panel-knowledge"]')?.textContent).toBe("Knowledge Panel Content");
      expect(container.querySelector('[data-testid="panel-security"]')?.textContent).toBe("");
      expect(window.location.search).toContain("tab=knowledge");

      // Click All -> Mounts all panels
      const btnAll = container.querySelector('[data-testid="btn-all"]') as HTMLButtonElement;
      act(() => {
        btnAll.click();
      });
      await flushReact();

      expect(container.querySelector('[data-testid="current-tab"]')?.textContent).toBe("all");
      expect(container.querySelector('[data-testid="panel-sre"]')?.textContent).toBe("SRE Panel Content");
      expect(container.querySelector('[data-testid="panel-security"]')?.textContent).toBe("Security Panel Content");
      expect(container.querySelector('[data-testid="panel-knowledge"]')?.textContent).toBe("Knowledge Panel Content");
      expect(window.location.search).toContain("tab=all");

      // Click SRE -> Cleans up tab param or sets to default
      const btnSre = container.querySelector('[data-testid="btn-sre"]') as HTMLButtonElement;
      act(() => {
        btnSre.click();
      });
      await flushReact();

      expect(container.querySelector('[data-testid="current-tab"]')?.textContent).toBe("sre");
      expect(window.location.search).not.toContain("tab=");

      act(() => root.unmount());
    });
  });
});
