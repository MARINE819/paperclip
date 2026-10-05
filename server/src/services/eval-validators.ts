// F-04 Agent Eval / Simulation Lab — deterministic validators.
// Every validator is a PURE function over already-collected run result data
// (no I/O of its own: filesystem/HTTP/DB checks were performed by whatever
// actually drove the run, out of scope for this phase, and their outcome is
// captured as plain data in `actualResult` before it ever reaches here).
// Malformed or missing data always fails closed — never throws, never
// silently passes. See docs/contracts/nexora-f04-eval-api.md.

export type ValidatorSpec = { type: string; [key: string]: unknown };

export type ValidatorResult = {
  type: string;
  deterministic: boolean;
  passed: boolean;
  details: string;
  expected?: unknown;
  actual?: unknown;
};

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(b, key) &&
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

function getAtPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((acc, segment) => {
    if (acc === null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[segment];
  }, value);
}

type MiniSchema = {
  type?: "object" | "array" | "string" | "number" | "boolean";
  required?: string[];
  properties?: Record<string, MiniSchema>;
};

function validateMiniSchema(schema: MiniSchema, value: unknown, pathLabel = "$"): string | null {
  if (schema.type) {
    const actualType = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (actualType !== schema.type) {
      return `${pathLabel}: expected type ${schema.type}, got ${actualType}`;
    }
  }
  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) {
        return `${pathLabel}: missing required property '${key}'`;
      }
    }
    for (const [key, subSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const err = validateMiniSchema(subSchema, obj[key], `${pathLabel}.${key}`);
        if (err) return err;
      }
    }
  }
  return null;
}

function fail(type: string, details: string, expected?: unknown, actual?: unknown): ValidatorResult {
  return { type, deterministic: true, passed: false, details, expected, actual };
}

function pass(type: string, details: string, expected?: unknown, actual?: unknown): ValidatorResult {
  return { type, deterministic: true, passed: true, details, expected, actual };
}

function validateExactValue(spec: ValidatorSpec, actualResult: unknown): ValidatorResult {
  const expected = spec.expected;
  const actual = getAtPath(actualResult, spec.path as string | undefined);
  if (actual === undefined) {
    return fail("exact_value", `path '${spec.path ?? "$"}' not present in run result`, expected, actual);
  }
  return deepEqual(actual, expected)
    ? pass("exact_value", "matched exactly", expected, actual)
    : fail("exact_value", "value did not match expected", expected, actual);
}

function validateSchema(spec: ValidatorSpec, actualResult: unknown): ValidatorResult {
  const schema = spec.schema as MiniSchema | undefined;
  if (!schema || typeof schema !== "object") {
    return fail("schema", "validator spec is missing a schema", schema, actualResult);
  }
  const actual = getAtPath(actualResult, spec.path as string | undefined);
  const err = validateMiniSchema(schema, actual);
  return err ? fail("schema", err, schema, actual) : pass("schema", "matched schema", schema, actual);
}

function validateHttpStatus(spec: ValidatorSpec, actualResult: unknown): ValidatorResult {
  const expectedStatus = spec.expectedStatus;
  if (typeof expectedStatus !== "number") {
    return fail("http_status", "validator spec is missing a numeric expectedStatus", expectedStatus);
  }
  const actualStatus = getAtPath(actualResult, (spec.path as string | undefined) ?? "httpStatus");
  if (typeof actualStatus !== "number") {
    return fail("http_status", "run result has no numeric httpStatus", expectedStatus, actualStatus);
  }
  return actualStatus === expectedStatus
    ? pass("http_status", "status matched", expectedStatus, actualStatus)
    : fail("http_status", "status did not match", expectedStatus, actualStatus);
}

function validateFileExistence(spec: ValidatorSpec, actualResult: unknown): ValidatorResult {
  const expectedExists = spec.expectedExists !== false; // default true
  const files = getAtPath(actualResult, (spec.path as string | undefined) ?? "files");
  const filePath = spec.filePath;
  if (typeof filePath !== "string" || !files || typeof files !== "object") {
    return fail("file_existence", "run result has no files map or spec has no filePath", filePath, files);
  }
  const actualExists = Boolean((files as Record<string, unknown>)[filePath]);
  return actualExists === expectedExists
    ? pass("file_existence", `${filePath} existence matched`, expectedExists, actualExists)
    : fail("file_existence", `${filePath} existence did not match`, expectedExists, actualExists);
}

function validateJson(spec: ValidatorSpec, actualResult: unknown): ValidatorResult {
  const raw = getAtPath(actualResult, spec.path as string | undefined);
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return fail("json", `not valid JSON: ${error instanceof Error ? error.message : String(error)}`, spec.expected, raw);
    }
  }
  if (spec.expected === undefined) {
    return pass("json", "value is valid JSON", spec.expected, parsed);
  }
  return deepEqual(parsed, spec.expected)
    ? pass("json", "JSON matched expected", spec.expected, parsed)
    : fail("json", "JSON did not match expected", spec.expected, parsed);
}

function validateDbState(spec: ValidatorSpec, actualResult: unknown): ValidatorResult {
  const expected = spec.expected as Record<string, unknown> | undefined;
  const actual = getAtPath(actualResult, (spec.path as string | undefined) ?? "dbState");
  if (!expected || typeof expected !== "object") {
    return fail("db_state", "validator spec is missing an expected object", expected);
  }
  if (!actual || typeof actual !== "object") {
    return fail("db_state", "run result has no dbState object", expected, actual);
  }
  const actualObj = actual as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    if (!deepEqual(actualObj[key], value)) {
      return fail("db_state", `dbState.${key} did not match`, expected, actual);
    }
  }
  return pass("db_state", "dbState matched all expected keys", expected, actual);
}

function validateTestResult(spec: ValidatorSpec, actualResult: unknown): ValidatorResult {
  const testResult = getAtPath(actualResult, (spec.path as string | undefined) ?? "testResult") as
    | { passed?: number; failed?: number; total?: number }
    | undefined;
  if (!testResult || typeof testResult !== "object") {
    return fail("test_result", "run result has no testResult object", spec, testResult);
  }
  const failed = Number(testResult.failed ?? Number.NaN);
  const total = Number(testResult.total ?? Number.NaN);
  const passedCount = Number(testResult.passed ?? Number.NaN);
  if (!Number.isFinite(failed) || !Number.isFinite(total) || !Number.isFinite(passedCount)) {
    return fail("test_result", "testResult is missing numeric passed/failed/total", spec, testResult);
  }
  const minPassRate = spec.minPassRate;
  if (typeof minPassRate === "number") {
    const rate = total > 0 ? passedCount / total : 0;
    return rate >= minPassRate
      ? pass("test_result", `pass rate ${rate} >= ${minPassRate}`, minPassRate, rate)
      : fail("test_result", `pass rate ${rate} < ${minPassRate}`, minPassRate, rate);
  }
  return failed === 0
    ? pass("test_result", "no failed tests", 0, failed)
    : fail("test_result", `${failed} failed test(s)`, 0, failed);
}

const VALIDATORS: Record<string, (spec: ValidatorSpec, actualResult: unknown) => ValidatorResult> = {
  exact_value: validateExactValue,
  schema: validateSchema,
  http_status: validateHttpStatus,
  file_existence: validateFileExistence,
  json: validateJson,
  db_state: validateDbState,
  test_result: validateTestResult,
};

/** Runs one validator spec against a run's result data. Unknown validator types fail closed. */
export function runValidator(spec: ValidatorSpec, actualResult: unknown): ValidatorResult {
  const fn = VALIDATORS[spec.type];
  if (!fn) {
    return fail(spec.type ?? "unknown", `unknown validator type '${String(spec.type)}'`);
  }
  try {
    return fn(spec, actualResult);
  } catch (error) {
    // A validator must never throw into the caller — a malformed result
    // (wrong shape, unexpected null, etc.) is a FAIL, not a crash.
    return fail(spec.type, `validator threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Runs every deterministic validator spec in order against one run result. */
export function runAllValidators(specs: ValidatorSpec[], actualResult: unknown): ValidatorResult[] {
  return specs.map((spec) => runValidator(spec, actualResult));
}
