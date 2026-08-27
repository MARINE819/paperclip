# 모바일 원격 승인 — 두 번째 백엔드 슬라이스: Approval 안전 수명주기 구현

**날짜:** 2026-08-27
**상태:** 구현·테스트·문서화 완료. **라이브 DB에 migration을 적용하지 않았음**(0219/0220 모두 미적용). `heartbeat.ts` 미수정. 라이브 Approval/Issue 상태 미변경.

## User Request

[[mobile-remote-approval-lifecycle-security-design]] 설계 문서를 기준으로 다음 항목을 구현: Approval TTL(HIGH/UNKNOWN 15분), fingerprint 기반 무효화, 1회성 consume(같은 run만 멱등, 다른 run은 거부), idempotency key(claim-first 트랜잭션 패턴, 재사용 시 409, 만료 시 410), 그리고 이 모든 것을 뒷받침하는 신규 `approval_action_idempotency_keys` 테이블. 여러 라운드의 설계 리뷰(자기참조 FK, legacy backfill 정책, consume 원자성, idempotency 트랜잭션 순서)를 거쳐 최종 승인된 통합 diff를 그대로 구현했다.

## 쉬운 말 요약

**왜 이 작업을 하는가:** 모바일에서 승인 버튼을 누르는 상황은 PC 브라우저와 다르다 — 통신이 불안정해 같은 요청이 중복 전송될 수 있고, 승인자가 알림을 늦게 확인해 오래된 요청을 뒤늦게 누를 수도 있다. 이번 작업은 이런 상황에서도 "승인은 정확히 의도한 대로, 정확히 한 번만" 처리되도록 서버 쪽 안전장치를 완성하는 것이다.

**무엇을 만들었는가:**
1. **만료(TTL)**: HIGH/UNKNOWN 위험 승인은 15분이 지나면 자동으로 "만료"로 취급되어 더 이상 승인/거절할 수 없다(410 응답).
2. **1회성 소비(consume)**: 승인된 작업이 실제로 실행될 때, "이 승인을 누가 썼는지"를 기록해 다른 실행이 같은 승인을 재사용하지 못하게 막는다. 같은 실행이 재시도하는 것은 허용하지만(멱등), 다른 실행은 예외 없이 거부된다.
3. **idempotency key**: 모바일 앱이 승인 버튼을 누를 때 매번 같은 식별자를 함께 보내면, 네트워크 재시도로 같은 요청이 여러 번 도착해도 서버는 실제로는 딱 한 번만 처리하고 나머지는 첫 번째 결과를 그대로 돌려준다 — 심지어 두 요청이 정확히 동시에 도착해도 마찬가지다.

**어떻게 안전을 보장했는가:** "누가 먼저 승인 처리를 할 자격을 얻는지"(선점)와 "실제로 승인 상태를 바꾸는 것"과 "그 결과를 기록하는 것"을 전부 하나의 데이터베이스 트랜잭션으로 묶었다. 그래서 셋 중 하나라도 실패하면 전부 취소되고, 절대로 "승인은 됐는데 기록이 안 남는" 또는 "선점만 되고 아무 일도 안 일어나는" 어중간한 상태가 생기지 않는다.

## 변경 파일

| 파일 | 성격 | 변경량 | 내용 |
|---|---|---|---|
| `packages/db/src/schema/approvals.ts` | 기존 파일 확장 | +56/-0 | `expiresAt`, `taskFingerprint`, `consumedAt`, `consumedByRunId`(FK→heartbeat_runs, `onDelete: set null`), `supersededByApprovalId`(자기참조 FK, `onDelete: set null`) 추가, `companyId+taskFingerprint` 인덱스 |
| `packages/db/src/schema/approval_action_idempotency_keys.ts` | **신규 파일** | — | idempotency 클레임 테이블. `status`(reserved/completed, CHECK 제약), nullable `httpStatus`/`responseBody`, `expiresAt`, unique `(actorIdentity, idempotencyKey)` |
| `packages/db/src/schema/index.ts` | 기존 파일 확장 | +6/-1 | `BoardApiKeyScope`, `approvalActionIdempotencyKeys` export 추가 |
| `packages/db/src/migrations/0219_known_miracleman.sql` | **신규** | 23줄 | approvals 컬럼 5개 추가 DDL(drizzle-kit 자동 생성, 무수정) + Option A legacy backfill(같은 파일, `--> statement-breakpoint`로 분리, 같은 트랜잭션) |
| `packages/db/src/migrations/0220_free_hobgoblin.sql` | **신규** | 21줄 | `approval_action_idempotency_keys` 테이블 생성(drizzle-kit 자동 생성 그대로) |
| `packages/db/src/migrations/meta/0219_snapshot.json`, `0220_snapshot.json` | **신규** | — | drizzle-kit 자동 생성 스냅샷 |
| `packages/db/src/migrations/meta/_journal.json` | 기존 파일, **순수 추가만** | idx 219, 220 항목 2개 append | 기존 idx 0~218 항목은 바이트 단위로 불변 확인됨(아래 참조) |
| `packages/shared/src/validators/approval.ts` | 기존 파일 확장 | +2 | `resolveApprovalSchema`/`requestApprovalRevisionSchema`에 선택적 `idempotencyKey` 필드 |
| `server/src/errors.ts` | 기존 파일 확장 | +4 | `gone(message, details?)` 410 헬퍼(이번 슬라이스는 실제로는 라우트에서 직접 `res.status(410)`을 쓰지만, 향후 재사용을 위해 유지) |
| `server/src/services/approval-lifecycle.ts` | **신규 파일** | ~300줄 | `approvalTtlMsForRisk`, `computeApprovalFingerprint`, `effectiveApprovalStatus`, `fingerprintStatus`, `consumeApproval`, `actorIdentityFor`, `requestFingerprintFor`, `checkApprovalIdempotency`, `claimApprovalIdempotency`, `completeApprovalIdempotency` |
| `server/src/services/approvals.ts` | 기존 파일 확장 | +105/-24 | `resolveApproval`에 원자적 만료 검사(`isExpiredAt` + WHERE절 `or(isNull(expiresAt), gt(expiresAt, now))`) 및 `outcome`(`applied`/`already_applied`/`conflict`/`expired`) 추가, `approve`/`reject`/`requestRevision` 세 함수 모두 같은 패턴으로 재작성 |
| `server/src/routes/approvals.ts` | 기존 파일 확장 | +635/-158(net +477) | `projectApprovalResponse` 헬퍼, `runApproveSideEffects`/`runRejectSideEffects` 추출, approve/reject/request-revision 세 라우트에 idempotencyKey 유무에 따른 두 경로(기존 경로 그대로 유지 / claim-first 트랜잭션 경로 신설), GET 목록·상세·생성·resubmit 응답에 `effectiveStatus`/`fingerprintStatus` 노출 |
| `server/src/__tests__/approval-lifecycle.test.ts` | **신규** | 22개 테스트 | 순수 함수 단위 테스트 + `consumeApproval`/idempotency claim의 embedded-postgres 통합 테스트 |
| `server/src/__tests__/approval-idempotency-routes.test.ts` | **신규** | 10개 테스트 | HTTP 200/409/410 계약, 중복 부수효과 방지, 동시 요청 경쟁 — embedded-postgres + 실제 라우트 |
| `server/src/__tests__/approval-routes-idempotency.test.ts` | 기존 테스트 파일 수정 | +14/-9 | `requestRevision` 모킹 응답을 새 `{approval, applied, outcome}` 계약에 맞게 갱신 |

`server/src/app.ts`, `server/src/services/index.ts`, `server/src/services/heartbeat.ts`는 이번 슬라이스에서 전혀 수정하지 않았다. `server/src/routes/issues.ts`는 이번 세션과 무관한 외부 변경(+104)이 이미 있었음을 `git diff --stat`으로 확인했으나 이번 작업에서 손대지 않았다.

## Migration 0219/0220 — 백업 대조 결과

- **0219 생성**: 생성 전 전체 `migrations/` 백업 → `pnpm run generate` 실행 → 0218 SQL/snapshot이 백업과 **바이트 단위로 동일**함을 `diff`로 확인, journal 기존 idx 0~217 항목도 위치별로 전부 동일 확인, 새 idx 218(`0219_known_miracleman`) 1개만 append됨을 확인. 생성된 DDL 7줄에 Option A backfill(`UPDATE ... SET task_fingerprint = payload->>'taskFingerprint', expires_at = created_at + interval '15 minutes' WHERE type='request_board_approval' AND status IN ('pending','revision_requested') AND payload->>'source'='risk_guard' AND payload->>'taskFingerprint' IS NOT NULL`)를 `--> statement-breakpoint`로 구분해 같은 파일 끝에 추가(같은 트랜잭션으로 원자 적용되도록 — 이유는 아래 참조).
- **0220 생성**: 동일 절차로 백업 → 생성 → 0219 SQL/snapshot 바이트 단위 동일 확인, journal 기존 idx 0~217 불변 확인, 새 idx 219(`0220_free_hobgoblin`) 1개만 append됨을 확인. `approval_action_idempotency_keys` 테이블 생성 DDL(unique index, FK 2개, CHECK 제약)만 포함, 손으로 수정하지 않고 도구 생성 그대로 채택.
- `pnpm run check:migrations`(번호순서/중복 + 대용량 테이블 안전 규칙): **통과** (0219/0220 포함, 신규 findings 없음).
- **라이브 DB에는 0219도 0220도 적용하지 않았다** — `tsx src/migrate.ts`/`pnpm run migrate`를 이번 세션에서 한 번도 실행하지 않았다.

## Legacy backfill의 실제 효과 (Option A, 아직 적용 안 됨 — 적용 시 예상되는 결과만 기록)

Option A(원본 `createdAt` 기준)로 확정했으므로, **0219가 실제로 라이브 DB에 적용되는 순간** 이미 15분보다 오래된 기존 pending risk_guard 승인(예: 과거 조사에서 확인된 NEX-103의 `9f63606f-...`)은 **즉시 만료 처리**된다. 이는 의도된 동작이며, 적용 여부와 시점은 Human이 별도로 결정할 사항이다(아래 참조).

## 테스트 결과

| 검사 | 결과 |
|---|---|
| `npx tsc --noEmit` (server / packages/db / packages/shared) | 전부 **exit 0** |
| `pnpm run check:migrations` | **통과** |
| `approval-lifecycle.test.ts`(신규) | **22/22 통과** — 순수 함수(TTL/fingerprint/effectiveStatus/fingerprintStatus/actorIdentity) + `consumeApproval`(정상 소비, not-approved 거부, 만료 거부, fingerprint 불일치 거부, superseded 거부, 동일 run 멱등, 다른 run 거부, 동시 경쟁 정확히 1승, 검증-소비 사이 상태 변경 경쟁) + idempotency claim(승리/재생/충돌/다른 actor 비공유/동시 클레임 경쟁) |
| `approval-idempotency-routes.test.ts`(신규) | **10/10 통과** — approve 200+wakeup 1회+재생 시 wakeup 재호출 없음, 만료 410(키 없음/있음 모두), 상태 충돌 409, 다른 approval에 같은 키 재사용 시 409(대상 미변경 확인), 동시 동일 키 요청 2개 중 부수효과 1회만, reject/request-revision 200, 키 없으면 idempotency 테이블 전혀 안 건드림, 응답에 내부 필드(actorIdentity/requestFingerprint) 미노출 |
| `approval-routes-idempotency.test.ts`(기존, `requestRevision` 계약 변경에 맞춰 모킹 갱신) | **11/11 통과** |
| `approvals-service.test.ts`, `agents-pending-approval-config.test.ts`, `cli-auth-routes.test.ts`, `board-key-scope-guard.test.ts`, `agent-auth-middleware.test.ts`, `board-mutation-guard.test.ts` | **전부 통과** (총 97/97, 신규 2개 파일 포함 9개 테스트 파일 일괄 재실행) |
| `git diff --check`(이번 슬라이스 파일 전체) | 에러 없음(LF/CRLF 경고만) |

### 구현 중 발견·수정한 버그 (모두 제 새 코드 자체의 결함, 안전 범위에서 수정)

- `isExpiredAt`(당시 `approvals.ts`)와 `effectiveApprovalStatus`/`fingerprintStatus`(`approval-lifecycle.ts`)가 `expiresAt`/`consumedAt`/`taskFingerprint`가 `undefined`인 행(기존 테스트 픽스처가 이 컬럼들을 아예 갖고 있지 않던 경우)에서 `!== null`/`=== null` 엄격 비교로 인해 `.getTime()` 호출 시 크래시하거나 잘못 분류하던 문제 — `!= null`/`== null` 느슨한 비교로 수정(이 저장소의 기존 관례, `attention.ts`에서 이미 쓰이는 패턴). 기존 `approvals-service.test.ts`(레거시 픽스처)와 새 approve 생성 테스트에서 실제로 재현·확인 후 수정.
- `requestRevision`의 반환 계약이 `ApprovalRecord`(원시 행)에서 `{approval, applied, outcome}`으로 바뀌면서, 이를 모킹하던 기존 `approval-routes-idempotency.test.ts`의 한 테스트가 깨짐 — 모킹 응답을 새 계약에 맞게 갱신(제품 코드가 아니라 테스트의 오래된 목업 수정).
- 신규 라우트 테스트 초기 버전에서 동적 모듈 재-import에 `Math.random()`을 쿼리스트링으로 써서 esbuild 로더 오류가 난 것과, `activityLog` 정리 순서 누락으로 인한 FK 위반 — 둘 다 제 테스트 코드 자체의 실수였고, 필요 없는 동적 import 제거 및 정리 순서 수정으로 해결.

## Antigravity UI 참고용 typed contract (참고 — 이번 슬라이스에서 `packages/shared`에 새 타입 파일을 추가하지는 않음)

```ts
// 실제 응답 shape (server/src/routes/approvals.ts의 projectApprovalResponse 기준)
interface ApprovalResponse {
  // ...기존 approvals 컬럼 전부(redact된 payload 포함)
  expiresAt: string | null;
  taskFingerprint: string | null;
  consumedAt: string | null;
  consumedByRunId: string | null;
  supersededByApprovalId: string | null;
  effectiveStatus: "pending" | "revision_requested" | "approved" | "rejected" | "cancelled" | "expired" | "consumed";
  fingerprintStatus: "current" | "stale" | "not_applicable";
}

interface ResolveApprovalRequest {
  decisionNote?: string | null;
  idempotencyKey?: string; // 선택. 모바일 클라이언트는 탭당 UUID 1개를 생성해 재시도에도 재사용 권장.
}

type ApprovalErrorReason =
  | "approval_expired"              // 410
  | "already_resolved_conflict"     // 409, currentStatus 포함
  | "idempotency_key_reused"        // 409, 같은 키를 다른 approval/action/본문에 재사용
  | "board_key_scope_approval_only"; // 403 (지난 슬라이스에서 이미 구현됨)
```

## heartbeat.ts 통합 전 남은 작업

이번 슬라이스는 **`heartbeat.ts`를 전혀 수정하지 않았다** — 지시대로 보호 파일 경계를 넘지 않았다. 따라서 다음은 실제로 아직 동작하지 않으며, 별도의 명시적 diff 승인을 거쳐야 하는 다음 슬라이스의 범위다:

1. **Risk Guard 승인 생성 시 `expiresAt`/`taskFingerprint`(컬럼) 채우기** — 현재 heartbeat.ts는 여전히 `payload.taskFingerprint`(JSON)만 쓰고 있고, 신규 컬럼에는 아무 것도 쓰지 않는다. 즉 **0219/0220을 라이브에 적용해도, heartbeat.ts가 바뀌기 전까지는 새로 생성되는 Risk Guard 승인에 TTL이 실제로 걸리지 않는다**(0219의 legacy backfill이 적용하는 "기존 pending 건"에는 적용되지만, 그 이후 새로 생성되는 건에는 적용 안 됨).
2. **재개(resume) 시점에 `consumeApproval` 호출** — 현재 재개 로직은 여전히 예전 방식(승인 존재 여부만 확인)으로 동작하며, 새 1회성 소비 메커니즘을 전혀 쓰지 않는다.
3. **`supersededByApprovalId` 채우기** — 대상 내용이 바뀌어 새 승인이 만들어질 때 옛 승인을 명시적으로 연결하는 로직이 아직 없다(현재는 fingerprint 불일치로 조용히 무시될 뿐).
4. 위 세 가지가 적용되기 전까지 `fingerprintStatus`는 사실상 항상 `"current"` 또는 `"not_applicable"`만 반환한다(정직한 반영이지 결함 아님).

## Human 결정 필요 사항

1. **0219/0220을 언제 라이브 DB에 적용할지, 그리고 그 직후 legacy backfill로 기존 오래된 pending 승인(있다면)이 즉시 만료되는 것을 감수할지** — Option A는 이미 승인받았지만 실제 적용 시점은 별도 운영 판단이 필요하다.
2. **heartbeat.ts 통합 슬라이스를 언제 진행할지** — 보호 파일이므로 그때 가서 정확한 diff를 별도로 보여드리고 승인받아야 한다.
3. **idempotency 테이블의 24시간 보존 기간이 적절한지** — 더 짧게/길게 조정할지는 운영 경험에 따라 재검토 가능.
