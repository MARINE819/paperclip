import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, NetworkError } from "./client";

describe("api client — network vs HTTP error classification", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("throws NetworkError, not ApiError, when fetch itself rejects (no HTTP response)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );

    await expect(api.get("/agents")).rejects.toMatchObject({
      name: "NetworkError",
      message: "Unable to reach the server. Check your connection and try again.",
    });
    expect(new NetworkError("x", null)).toBeInstanceOf(Error);
  });

  it("still throws ApiError, unchanged, for a real HTTP error response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(api.get("/agents/missing")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      message: "Not found",
    });
    expect(new ApiError("x", 500, null)).toBeInstanceOf(Error);
  });

  it("does not reclassify an intentional AbortError as NetworkError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("The operation was aborted.", "AbortError")),
    );
    const controller = new AbortController();
    controller.abort();

    await expect(api.post("/agents", {}, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("returns success responses normally when the network is healthy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(api.get("/health")).resolves.toEqual({ ok: true });
  });
});
