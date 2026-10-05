import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { errorHandler } from "./error-handler.js";
import { unprocessable } from "../errors.js";

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: "POST",
    originalUrl: "/api/issues/child-1/work-products",
    actor: undefined,
    app: { locals: {} },
    ...overrides,
  } as unknown as Request;
}

function createMockRes(): Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

const noopNext: NextFunction = vi.fn();

/**
 * Matches the shape express.json() (via body-parser) actually throws when a
 * request body cannot be parsed as JSON -- a SyntaxError with `.status` and
 * `.type === "entity.parse.failed"` attached.
 */
function createBodyParserSyntaxError(): SyntaxError {
  const err = new SyntaxError("Unexpected token o in JSON at position 1") as SyntaxError & {
    status?: number;
    statusCode?: number;
    type?: string;
    body?: string;
  };
  err.status = 400;
  err.statusCode = 400;
  err.type = "entity.parse.failed";
  err.body = "{oops";
  return err;
}

describe("errorHandler", () => {
  it("maps a malformed-JSON body-parser SyntaxError to 400 Bad Request, not 500", () => {
    const req = createMockReq();
    const res = createMockRes();

    errorHandler(createBodyParserSyntaxError(), req, res, noopNext);

    expect(res.status).toHaveBeenCalledWith(400);
    const [payload] = res.json.mock.calls[0]!;
    expect(payload.error).toBeTypeOf("string");
    expect(payload.error).not.toMatch(/internal server error/i);
  });

  it("does not leak the raw request body content in the malformed-JSON response", () => {
    const req = createMockReq();
    const res = createMockRes();

    errorHandler(createBodyParserSyntaxError(), req, res, noopNext);

    const [payload] = res.json.mock.calls[0]!;
    expect(JSON.stringify(payload)).not.toContain("{oops");
  });

  it("still maps a genuine HttpError to its own declared status (regression)", () => {
    const req = createMockReq();
    const res = createMockRes();

    errorHandler(unprocessable("Invalid work product payload"), req, res, noopNext);

    expect(res.status).toHaveBeenCalledWith(422);
    const [payload] = res.json.mock.calls[0]!;
    expect(payload.error).toBe("Invalid work product payload");
  });

  it("still maps a Zod validation error to 400 with a details array (regression)", () => {
    const req = createMockReq();
    const res = createMockRes();
    const zodLikeError = Object.assign(new Error("Invalid input"), {
      name: "ZodError",
      issues: [{ path: ["type"], message: "Required" }],
    });

    errorHandler(zodLikeError, req, res, noopNext);

    expect(res.status).toHaveBeenCalledWith(400);
    const [payload] = res.json.mock.calls[0]!;
    expect(payload.error).toBe("Validation error");
    expect(payload.details).toEqual([{ path: ["type"], message: "Required" }]);
  });

  it("still maps a genuinely unexpected error to 500 (regression -- does not over-widen the new 400 branch)", () => {
    const req = createMockReq();
    const res = createMockRes();

    errorHandler(new Error("something truly unexpected"), req, res, noopNext);

    expect(res.status).toHaveBeenCalledWith(500);
    const [payload] = res.json.mock.calls[0]!;
    expect(payload.error).toBe("Internal server error");
  });

  it("does not treat an unrelated SyntaxError (not from body-parsing) as a malformed request", () => {
    const req = createMockReq();
    const res = createMockRes();
    const unrelatedSyntaxError = new SyntaxError("Invalid regular expression");

    errorHandler(unrelatedSyntaxError, req, res, noopNext);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
