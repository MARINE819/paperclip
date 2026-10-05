import { describe, expect, it } from "vitest";
import { runAllValidators, runValidator } from "./eval-validators.js";

describe("eval-validators (pure, deterministic)", () => {
  it("exact_value: passes on exact match, fails on mismatch, fails closed when path is absent", () => {
    expect(runValidator({ type: "exact_value", expected: 42, path: "n" }, { n: 42 }).passed).toBe(true);
    expect(runValidator({ type: "exact_value", expected: 42, path: "n" }, { n: 43 }).passed).toBe(false);
    const missing = runValidator({ type: "exact_value", expected: 42, path: "missing" }, { n: 42 });
    expect(missing.passed).toBe(false);
    expect(missing.details).toMatch(/not present/);
  });

  it("exact_value: deep-equals objects/arrays, not just primitives", () => {
    expect(
      runValidator({ type: "exact_value", expected: { a: [1, 2], b: "x" } }, { a: [1, 2], b: "x" }).passed,
    ).toBe(true);
    expect(
      runValidator({ type: "exact_value", expected: { a: [1, 2] } }, { a: [1, 3] }).passed,
    ).toBe(false);
  });

  it("schema: validates required properties and types, fails closed on wrong type", () => {
    const schema = { type: "object" as const, required: ["id", "name"], properties: { id: { type: "string" as const } } };
    expect(runValidator({ type: "schema", schema }, { id: "x", name: "y" }).passed).toBe(true);
    expect(runValidator({ type: "schema", schema }, { name: "y" }).passed).toBe(false);
    expect(runValidator({ type: "schema", schema }, { id: 5, name: "y" }).passed).toBe(false);
    expect(runValidator({ type: "schema" }, { id: "x" }).passed).toBe(false); // missing schema in spec
  });

  it("http_status: matches numeric status, fails closed when actual is missing/non-numeric", () => {
    expect(runValidator({ type: "http_status", expectedStatus: 200 }, { httpStatus: 200 }).passed).toBe(true);
    expect(runValidator({ type: "http_status", expectedStatus: 200 }, { httpStatus: 500 }).passed).toBe(false);
    expect(runValidator({ type: "http_status", expectedStatus: 200 }, {}).passed).toBe(false);
    expect(runValidator({ type: "http_status", expectedStatus: 200 }, { httpStatus: "200" }).passed).toBe(false);
  });

  it("file_existence: checks a files map, fails closed when the map or filePath is missing", () => {
    expect(
      runValidator({ type: "file_existence", filePath: "out.txt" }, { files: { "out.txt": true } }).passed,
    ).toBe(true);
    expect(
      runValidator({ type: "file_existence", filePath: "out.txt" }, { files: { "out.txt": false } }).passed,
    ).toBe(false);
    expect(runValidator({ type: "file_existence", filePath: "out.txt" }, {}).passed).toBe(false);
    expect(runValidator({ type: "file_existence" }, { files: { "out.txt": true } }).passed).toBe(false);
  });

  it("json: parses a raw string and matches expected, fails closed on invalid JSON", () => {
    expect(runValidator({ type: "json", expected: { a: 1 } }, { a: 1 }).passed).toBe(true);
    expect(
      runValidator({ type: "json", path: "body", expected: { a: 1 } }, { body: '{"a":1}' }).passed,
    ).toBe(true);
    const badJson = runValidator({ type: "json", path: "body", expected: { a: 1 } }, { body: "{not json" });
    expect(badJson.passed).toBe(false);
    expect(badJson.details).toMatch(/not valid JSON/);
  });

  it("db_state: passes when actual is a superset of expected keys, fails closed when dbState is missing", () => {
    expect(
      runValidator({ type: "db_state", expected: { status: "active" } }, { dbState: { status: "active", extra: 1 } }).passed,
    ).toBe(true);
    expect(
      runValidator({ type: "db_state", expected: { status: "active" } }, { dbState: { status: "inactive" } }).passed,
    ).toBe(false);
    expect(runValidator({ type: "db_state", expected: { status: "active" } }, {}).passed).toBe(false);
  });

  it("test_result: passes with 0 failures or a satisfied minPassRate, fails closed on malformed shape", () => {
    expect(
      runValidator({ type: "test_result" }, { testResult: { passed: 10, failed: 0, total: 10 } }).passed,
    ).toBe(true);
    expect(
      runValidator({ type: "test_result" }, { testResult: { passed: 8, failed: 2, total: 10 } }).passed,
    ).toBe(false);
    expect(
      runValidator({ type: "test_result", minPassRate: 0.7 }, { testResult: { passed: 8, failed: 2, total: 10 } }).passed,
    ).toBe(true);
    expect(runValidator({ type: "test_result" }, { testResult: {} }).passed).toBe(false);
    expect(runValidator({ type: "test_result" }, {}).passed).toBe(false);
  });

  it("unknown validator type fails closed rather than throwing", () => {
    const result = runValidator({ type: "not_a_real_validator" }, { anything: true });
    expect(result.passed).toBe(false);
    expect(result.details).toMatch(/unknown validator type/);
  });

  it("a validator whose implementation would throw (e.g. path traversal on a non-object) fails closed, never throws to the caller", () => {
    expect(() => runValidator({ type: "exact_value", expected: 1, path: "a.b.c" }, null)).not.toThrow();
    expect(runValidator({ type: "exact_value", expected: 1, path: "a.b.c" }, null).passed).toBe(false);
    expect(() => runValidator({ type: "schema", schema: { type: "object" as const } }, undefined)).not.toThrow();
  });

  it("runAllValidators runs specs in order and returns one result per spec", () => {
    const results = runAllValidators(
      [
        { type: "exact_value", expected: 1, path: "a" },
        { type: "exact_value", expected: 2, path: "b" },
      ],
      { a: 1, b: 99 },
    );
    expect(results).toHaveLength(2);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
  });
});
