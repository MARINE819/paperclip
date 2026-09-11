# Audit Retention "C-lite" 최소 삭제-증거 계약 — 최종 구현 설계 (READ-ONLY)

**작성일:** 2026-09-07
**단계:** READ-ONLY 설계 확정. 코드/스키마/마이그레이션/테스트/DB 변경 없음.
**전제:** A안 테스트 4/4 PASS(`CURRENT_IMPLEMENTATION_CHARACTERIZED`), Policy C(전체 보존) 테스트는 SKIP 유지, Audit retention 판정은 `PARTIAL`, Gate D(PID 17652)는 계속 `OBSERVING`. 이번 작업 중 Gate D·Supervisor/API/DB/Canary/Task Scheduler에는 어떠한 개입도 하지 않았다.
**이 문서는 이전 라운드의 설계를 대체하는 단일 최종본이다** — 이전 라운드가 제시했던 "삭제 전 `SELECT count(*)`" 방식과 "다음 라운드에서 확인 필요"로 남겨뒀던 항목들은 이 문서에서 전부 실제 코드 확인으로 대체·확정했다.

---

## 1. C-lite 구현 가능 여부

**가능하다(CONFIRMED).** `company.remove()`(`server/src/services/companies.ts:440-488`)와 `agent.remove()`(`server/src/services/agents.ts:945-978`)는 이미 각각 하나의 `db.transaction(async (tx) => {...})` 안에서 여러 테이블을 순서대로 `tx.delete(...)`하고 있다. 그 트랜잭션 안의 관련 DELETE 문에 `.returning()`을 추가하고, 트랜잭션 끝에 증거 INSERT 1건을 추가하는 것은 기존 구조를 바꾸지 않는 최소 삽입이다.

## 2. 재사용 가능한 기존 테이블 여부

**없다(CONFIRMED, 검색으로 확인).**
- `packages/db/src/schema/` 전체에서 `delet*`/`audit*`/`removal*`/`forensic*`/`evidence*` 이름의 테이블을 검색했으나 없음.
- `requestId`/`correlationId` 컬럼 컨벤션도 스키마 전체에 없음(신규 도입, nullable로 설계 — §3).
- `activity_log`는 `companyId NOT NULL` + FK가 있어 "FK 없는 독립 테이블" 요구를 만족하지 못해 재사용 불가.
- 결론: **신규 테이블 1개(`entity_deletion_evidence`)가 필요하다.**

## 3. heartbeat 삭제 경로 — 실제 코드 전체 확인 결과

`companies.ts:440-488`, `agents.ts:945-978` 전체를 다시 읽어 `heartbeat_runs`/`heartbeat_run_events`의 정확한 삭제 경로를 확정했다.

### FK 정의 (CONFIRMED, 스키마 직접 확인)
- `packages/db/src/schema/heartbeat_run_events.ts:22-24`: `companyId`/`runId`/`agentId` 모두 `.references()`에 `onDelete` 옵션이 없음 → 기본값 `ON DELETE no action`.
- `packages/db/src/schema/heartbeat_runs.ts:23-24`: `companyId`/`agentId` 역시 `ON DELETE no action`(단, `retryOfRunId`만 `onDelete:"set null"`, 이번 사안과 무관).
- 즉 `activity_log`와 **완전히 동일한 패턴**이다: DB가 자동으로 cascade 삭제하지 않으므로, 애플리케이션 코드가 부모 삭제 전에 명시적으로 먼저 지워야 한다.

### `company.remove()`의 정확한 WHERE 조건 (companies.ts:448-456)
```
1. tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, id))
2. (companyRunIds.length > 0 인 경우만) tx.delete(heartbeatRunEvents).where(inArray(heartbeatRunEvents.runId, companyRunIds))
3. tx.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, id))
```
1번과 2번은 같은 테이블(`heartbeat_run_events`)에 대한 **두 번의 별개 DELETE 문**이다(1번이 `companyId` 기준, 2번이 `runId` 기준인 방어적 이중 조건 — CONFIRMED, 코드에 그렇게 되어 있음). 한 행은 한 번만 물리적으로 삭제될 수 있으므로, 두 DELETE 각각의 `.returning().length`를 **합산**하면 실제 삭제된 총 건수와 정확히 일치한다(이중 계산 위험 없음 — 1번에서 이미 지워진 행은 2번의 WHERE 조건에 더 이상 존재하지 않아 대상이 될 수 없다).

### `agent.remove()`의 정확한 WHERE 조건 (agents.ts:958, 968)
```
1. tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.agentId, id))
2. tx.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, id))
```
company 경로와 달리 각각 단일 DELETE 문 하나뿐이다(`heartbeat_run_events`에 `agentId` 컬럼이 직접 있어 `runId` 경유 조건이 필요 없음).

### DELETE...RETURNING 적용 가능 여부

**가능하다(CONFIRMED)** — 위 4개(company 경로 2문 + agent 경로 2문) 모두 이미 명시적 `tx.delete(table).where(...)` 문이며, 여기에 `.returning({ id: table.id })`만 추가하면 된다. FK cascade에 의존하는 부분이 전혀 없으므로(§5의 `issue_work_products`와 달리) 순서 변경조차 필요 없다 — **`.returning()`만 덧붙이면 끝**이다.

### evidence 필드 확정: `heartbeatRunsDeleted`, `heartbeatRunEventsDeleted` 필요함

**확정: 필요하다.** 근거: 이 Closure 항목의 공식 명칭 자체가 "**감사 로그와 실행 증거** 보존"이며, `docs/investigations/claude-core-v0.1-audit-evidence-closure-audit.md`가 이미 `heartbeat_runs`/`heartbeat_run_events`를 "실행 결과와 재시도 이력이 이미 durable하다"고 인용한 4계층 증거 구조 중 2번째 계층으로 명시하고 있다(**CONFIRMED**, 그 문서 §Existing audit structures 원문). `activity_log`만 증거화하고 `heartbeat_runs`/`heartbeat_run_events`(실행 증거의 핵심)를 빼면 이 Closure 항목의 절반만 다루는 것이 된다. 따라서 `entity_deletion_evidence`에 다음 두 컬럼을 추가한다: `heartbeatRunsDeleted integer not null`, `heartbeatRunEventsDeleted integer not null`.

## 4. 신규 테이블 스키마 (최종)

파일: `packages/db/src/schema/entity_deletion_evidence.ts`(신규, 아직 생성하지 않음)

```ts
import { pgTable, uuid, text, timestamp, integer, index } from "drizzle-orm/pg-core";

export const entityDeletionEvidence = pgTable(
  "entity_deletion_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),                    // = eventId
    entityType: text("entity_type").notNull(),                       // "company" | "agent"
    deletedEntityIdHash: text("deleted_entity_id_hash").notNull(),   // sha256("company:"+uuid 또는 "agent:"+uuid)
    actorType: text("actor_type").notNull(),                         // "user" | "agent" | "system"
    actorIdHash: text("actor_id_hash"),                              // sha256("actor:"+actorId), 없으면 null
    deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().defaultNow(),
    reason: text("reason").notNull(),                                // 서버 고정 상수만 허용, 자유 텍스트 금지
    activityLogRowsDeleted: integer("activity_log_rows_deleted").notNull(),
    heartbeatRunsDeleted: integer("heartbeat_runs_deleted").notNull(),
    heartbeatRunEventsDeleted: integer("heartbeat_run_events_deleted").notNull(),
    workProductRowsDeleted: integer("work_product_rows_deleted").notNull(),
    requestId: text("request_id"),                                   // best-effort 상관관계 ID, nullable
  },
  (table) => ({
    entityTypeDeletedAtIdx: index("entity_deletion_evidence_type_deleted_at_idx")
      .on(table.entityType, table.deletedAt),
  }),
);
```
- **companies/agents를 참조하는 컬럼이 없다** — item 7(FK 부재)을 스키마 정의 자체로 만족.
- `id`(PK)가 곧 `eventId`다(별도 중복 컬럼 없음, `activity_log.id`와 동일 관례).

## 5. 해시 계약

- **domain-separated 입력 문자열**: `company:<uuid>` / `agent:<uuid>` / `actor:<actorId>` — 접두사 없이 원본 ID만 해싱하지 않는다(접두사가 없으면 우연히 같은 문자열을 가진 다른 domain의 ID가 같은 해시로 충돌해 어느 domain인지 구분할 수 없어진다).
- **계산 코드**:
  ```ts
  import { createHash } from "node:crypto";

  const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function canonicalizeIdentifier(raw: string): string {
    return UUID_SHAPE.test(raw) ? raw.toLowerCase() : raw;
  }

  function hashDeletionIdentifier(domain: "company" | "agent" | "actor", raw: string): string {
    return createHash("sha256").update(`${domain}:${canonicalizeIdentifier(raw)}`, "utf8").digest("hex");
  }
  ```
  `createHash("sha256")`는 이미 `server/src/services/decision-retention.ts:64-66`(`hashAttentionArchiveManifest`)에서 같은 목적으로 쓰이는 기존 관례다(**CONFIRMED**).
- **canonicalization 규칙**: UTF-8 인코딩. UUID 형태(위 정규식)인 값만 소문자로 고정(드라이버별 대소문자 차이 제거). UUID가 아닌 임의 문자열은 대소문자를 바꾸지 않는다(이 저장소에 그런 정규화 컨벤션이 없으므로 새로 만들지 않음).
- **명시적 한계**: 이것은 암호화도 완전한 익명화도 아니다 — **가명화(pseudonymization)**다. 이미 후보 UUID를 아는 조사자는 재해싱으로 대조할 수 있고(이것이 설계 목적), 해시값만으로 원본을 무작위 역산하는 것은 UUID 키스페이스상 실질적으로 불가능하다(**CONFIRMED**, SHA-256/UUID 키스페이스의 일반적 성질).
- **저장하지 않는 것**: 원본 UUID, 이름, 이메일, 자유입력 `reason` — 컬럼 자체가 없다. `reason`은 서버 고정 상수만 저장하며(`DELETE /companies/:companyId` 라우트가 요청 바디에서 사유 필드를 파싱하지 않음을 **CONFIRMED**), 사용자 자유 입력이 들어올 경로가 없다.

## 6. actor 경로 — 전체 호출부 전수 확인

### `AuthorizationActor` 정의 (`server/src/services/authorization.ts:32-`)
```ts
export type AuthorizationActor =
  | { type: "board" | "agent" | "none"; userId?: string | null; agentId?: string | null;
      companyId?: string | null; runId?: string | null; keyId?: string | null; ... }
```
이것은 `remove()`가 받을 매개변수(`CompanyActivityActor`/agent 쪽 동등 타입)와는 별개의, 라우트 레벨 권한 판정용 타입이다(**CONFIRMED**, 혼동하지 않도록 구분). `remove()`에 실제로 넘길 값은 이미 `companies.ts:44-56`에 정의된 `CompanyActivityActor`(`{ actorType, actorId, agentId, runId }`)이며, `archive()`/`update()`가 이미 이 타입을 받고 있다(**CONFIRMED**, `companies.ts:401`).

### 전수 검색 결과 — production 호출부는 정확히 2곳뿐 (CONFIRMED, `rg`로 전수 검색)

| 파일:줄 | 함수 | 현재 인자 | 변경 후 인자 |
|---|---|---|---|
| `server/src/routes/companies.ts:1325` | `router.delete("/:companyId", ...)` | `svc.remove(companyId)` (인자 없음) | `svc.remove(companyId, getActorInfo(req))` — **`getActorInfo`는 이미 이 파일에서 import되어 같은 라우터의 `archive()` 호출(`companies.ts:1313`)에 실사용 중인 기존 헬퍼**(`server/src/routes/authz.ts:224`가 정의, `actorType`/`actorId`/`agentId`/`runId`를 정확히 반환). 신규 도입 없이 기존 패턴 재사용 |
| `server/src/routes/agents.ts:4427` | `router.delete("/agents/:id", ...)` | `svc.remove(id)` (인자 없음) | `svc.remove(id, { actorType: "user", actorId: req.actor.userId ?? "board" })` — **바로 다음 줄(`agents.ts:4433-4440`)에 이미 존재하는 `logActivity(db, { actorType:"user", actorId: req.actor.userId ?? "board", action:"agent.deleted", ... })` 호출과 정확히 동일한 패턴**을 그대로 재사용(신규 패턴 발명 없음) |

이 2곳 외 production 코드에서 `companyService(...).remove(`/`agentService(...).remove(`를 호출하는 곳은 없다(**CONFIRMED**, `rg`로 `server/src` 전체를 검색해 테스트 파일(`__tests__/*.test.ts`, `companyService(db).remove`/`agentService(db).remove` 직접 호출) 외 production 호출부가 이 2곳뿐임을 확인). "다음 라운드 확인" 같은 표현은 더 이상 남기지 않는다 — 위 표가 최종 확정값이다.

**부가 발견(정확성을 위해 기록)**: `agents.ts:4433-4440`에는 agent 삭제 직후 `action: "agent.deleted"`라는 `logActivity` 호출이 **이미 존재**한다(**CONFIRMED**). 단, 이것은 `remove()`의 트랜잭션 **바깥**에서, 그리고 `companyId` 스코프로 기록되므로, 나중에 그 company 자체가 하드 삭제되면 이 로그도 함께 사라진다 — `entity_deletion_evidence`(FK 없음)만이 그런 후속 삭제에도 살아남는 유일한 기록이다. `company.remove()` 쪽에는 이런 사후 `logActivity` 호출조차 없다(**CONFIRMED, §7 재확인**) — company 하드 삭제는 현재 어떤 형태로도 기록되지 않는다.

## 7. 최종 트랜잭션 순서

### `company.remove()`
```
db.transaction(async (tx) => {
  1. companyIssueIds = tx.select({id: issues.id}).from(issues).where(eq(issues.companyId, id))
  2. workProductRowsDeleted = (await tx.delete(issueWorkProducts)
       .where(inArray(issueWorkProducts.issueId, companyIssueIds)).returning({id:...})).length
     -- issue_work_products는 issues.id에 ON DELETE cascade FK가 걸려 있어(CONFIRMED,
        issue_work_products.ts:24) 원래는 issues 삭제 시 암묵적으로 함께 지워지지만,
        cascade는 RETURNING 값을 주지 않으므로 여기서 먼저 명시적으로 지워 건수를 관측한다.
        이후 issues 삭제 시 cascade는 더 지울 대상이 없어 no-op.
  3. heartbeatRunEventsDeleted =
       (await tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, id)).returning({id:...})).length
       + (companyRunIds.length > 0
           ? (await tx.delete(heartbeatRunEvents).where(inArray(heartbeatRunEvents.runId, companyRunIds)).returning({id:...})).length
           : 0)
  4. heartbeatRunsDeleted =
       (await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, id)).returning({id:...})).length
  5. activityLogRowsDeleted =
       (await tx.delete(activityLog).where(eq(activityLog.companyId, id)).returning({id:...})).length
  6. (기존 그대로, 순서 유지) agentTaskSessions, agentWakeupRequests, agentApiKeys, agentRuntimeState,
     issueComments, costEvents, financeEvents, approvalComments, approvals, companySecrets,
     joinRequests, invites, principalPermissionGrants, companyMemberships, companySkills,
     routineRuns, routineTriggers, routineRevisions, routines, issueReadStates, documents,
     issues, companyLogos, assets, goals, projects, agents 삭제 — 변경 없음
  7. INSERT INTO entity_deletion_evidence (
       entityType: "company", deletedEntityIdHash: hashDeletionIdentifier("company", id),
       actorType: actor.actorType, actorIdHash: actor.actorId ? hashDeletionIdentifier("actor", actor.actorId) : null,
       reason: "board_hard_delete_api",
       activityLogRowsDeleted, heartbeatRunsDeleted, heartbeatRunEventsDeleted, workProductRowsDeleted,
       requestId: null,
     )
  8. rows = await tx.delete(companies).where(eq(companies.id, id)).returning()   -- 기존 그대로
  9. return rows[0] ?? null
})
```

### `agent.remove()`
동일 원칙, `heartbeatRunEventsDeleted`/`heartbeatRunsDeleted`/`activityLogRowsDeleted`는 각각 §3에서 확인한 agent 경로의 기존 단일 DELETE 문에 `.returning()`을 붙여 얻는다. `workProductRowsDeleted`는 상수 `0`(agent 삭제는 `issues`를 지우지 않으므로 — §3, `agents.ts:953-957`에서 `assigneeAgentId`/`createdByAgentId`를 `null`로 갱신할 뿐임을 재확인). evidence INSERT는 부모(`agents`) DELETE 직전, 다른 자식 테이블 삭제 이후에 위치한다(company 경로와 동일한 상대 순서).

### 왜 항상 전체 롤백인가 (CONFIRMED, Postgres 자체 동작)
6~9단계 전체가 하나의 Postgres 트랜잭션이다. 트랜잭션 내부에서 오류가 발생하면 Postgres는 그 트랜잭션을 즉시 "aborted" 상태로 만들어 이후 어떤 문장도 실행을 거부한다(명시적 `SAVEPOINT` 없이는). Drizzle의 `db.transaction(async (tx) => {...})`은 콜백이 예외를 던지면 `ROLLBACK`, 정상 반환하면 `COMMIT`을 자동 실행한다 — 애플리케이션이 별도 트랜잭션 관리를 추가할 필요가 없다. 따라서 1~9단계 중 **어느 지점에서 실패하든 이미 실행된 모든 DELETE와 evidence INSERT가 함께 롤백**되며, "증거만 남고 삭제는 안 됨" 또는 "삭제는 됐는데 증거가 없음"이라는 부분 성공 상태는 DB 레벨에서 발생할 수 없다.

## 8. 원자성 테스트 — 프로덕션 코드에 훅을 추가하지 않는 설계

**프로덕션 코드(예외를 강제로 던지는 테스트 seam)는 추가하지 않는다.** 대신 테스트 파일 안에서 embedded Postgres에 **테스트 전용 blocker 테이블**을 생성해 부모 DELETE를 자연 실패시킨다.

### 정확한 절차
```ts
// 1. 테스트 DB에만 존재하는 임시 테이블 생성(스키마 패키지에는 추가하지 않음 — 순수 raw SQL)
await db.execute(sql`
  CREATE TABLE test_only_deletion_blocker (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES companies(id)
  )
`);

// 2. 삭제 대상 회사를 참조하는 행을 하나 심는다 — 이 행은 company.remove()의
//    삭제 목록(§7)에 포함되지 않으므로 부모 DELETE 시점에 FK 위반을 일으킨다.
await db.execute(sql`INSERT INTO test_only_deletion_blocker (company_id) VALUES (${companyId})`);

// 3. company.remove()를 호출하면 §7의 8번(companies DELETE)에서
//    "update or delete on table companies violates foreign key constraint" 오류가
//    자연 발생하고, db.transaction이 이를 잡아 전체 ROLLBACK한다.
await expect(companyService(db).remove(companyId)).rejects.toThrow();

// 4. 정리 — 다음 테스트에 영향 주지 않도록 blocker 테이블 제거
await db.execute(sql`DROP TABLE test_only_deletion_blocker`);
```

### 실패 후 확인해야 할 것 (PASS 조건)
1. `companies` 행이 여전히 존재한다(부모가 지워지지 않았음).
2. `activity_log` 행이 삭제 전 건수 그대로 남아있다.
3. `heartbeat_runs`/`heartbeat_run_events` 행이 삭제 전 건수 그대로 남아있다.
4. `issue_work_products` 행이 삭제 전 건수 그대로 남아있다(삭제되지도, evidence로 카운트되지도 않음).
5. `entity_deletion_evidence`에 해당 companyId 관련 행이 **0건**이다(evidence INSERT까지 포함해 전부 롤백됐음을 증명).

이 방법은 프로덕션 `companies.ts`/`agents.ts`에 테스트 전용 조건 분기나 throw 훅을 넣지 않고도, 실제 FK 위반이라는 **진짜 실패 경로**로 원자성을 검증한다.

## 9. append-only 보장

- **서비스/API 계층에 UPDATE/DELETE를 만들지 않는다**: `entity_deletion_evidence`용 서비스 함수는 §7의 INSERT 1건뿐이며, 이 테이블 대상 `update(...)`/`delete(...)` 서비스나 라우트는 작성하지 않는다.
- **정적 검증**: 이 저장소에 이미 소스 트리를 정규식으로 스캔하는 선례가 있다(**CONFIRMED**, `scripts/check-no-git-push.mjs`+`.test.mjs`). 동일한 방식으로 `server/src/**/*.ts`(테스트 파일 자신 제외)를 스캔해 `.update(entityDeletionEvidence`/`.delete(entityDeletionEvidence` 패턴이 없음을 assert하는 테스트를 §11에 포함한다.
- **명시적 한계**: 이 보장은 **애플리케이션 레벨(Core v0.1 범위)**이다. Postgres에 직접 접속하는 DB 관리자나 `psql` 콘솔의 수동 `UPDATE`/`DELETE`까지 막지 못한다(DB 레벨 `REVOKE`/트리거 기반 불변성은 이번 설계에 포함하지 않음) — "DB 관리자로부터도 완전히 보호된다"는 주장은 하지 않는다.

## 10. 마이그레이션 오염 방지 — pre/post 비교 (HEAD git diff 아님, OS 임시 폴더 + SHA-256)

**`git status`/`git diff`(HEAD 기준)로 비교하지 않는다** — 이 저장소는 세션 시작 시점부터 `packages/db/src/migrations/meta/0231_snapshot.json`, `meta/_journal.json`이 이미 커밋되지 않은 상태였고, 앞으로도 이 디렉터리에 무관한 사용자 변경이 섞여 있을 수 있으므로 git 상태만으로는 "신규 생성분"과 "기존 변경분"을 구분할 수 없다. 대신 **db:generate 실행 직전/직후의 파일 스냅샷을 OS 임시 폴더에 직접 복사하고 SHA-256으로 비교**한다.

### 정확한 명령 (승인 후에만 실행)
```bash
# 1. 생성 전 스냅샷
PRE_DIR="$(mktemp -d)"
cp -r packages/db/src/migrations "$PRE_DIR/migrations"
find packages/db/src/migrations -type f | sort | xargs sha256sum > "$PRE_DIR/hashes.txt"

# 2. 마이그레이션 생성
pnpm db:generate

# 3. 생성 후 스냅샷
POST_DIR="$(mktemp -d)"
cp -r packages/db/src/migrations "$POST_DIR/migrations"
find packages/db/src/migrations -type f | sort | xargs sha256sum > "$POST_DIR/hashes.txt"

# 4. 비교
diff "$PRE_DIR/hashes.txt" "$POST_DIR/hashes.txt"
```

### 판정 기준 (기존 사용자 변경과 신규 생성분이 섞이지 않았음을 확인하는 방법)
- `diff` 결과에서 **PRE에도 POST에도 동일 경로로 존재하지만 해시가 다른 파일**은 `meta/_journal.json` **단 하나만** 허용된다. 그 외 어떤 기존 `.sql` 파일이나 기존 `meta/<N>_snapshot.json`의 해시가 조금이라도 달라지면(즉 이미 존재하던 파일이 재작성됐다면) **즉시 중단**하고 적용하지 않는다 — 이것이 "기존 사용자 변경이 신규 생성과 섞였는지"를 가르는 정확한 기준이다.
- **POST에만 존재하는 파일**(PRE에 없던 신규 파일)은 정확히 2개만 허용된다: 신규 `<N>_*.sql` 1개, 신규 `meta/<N>_snapshot.json` 1개. 그 외 신규 파일이 하나라도 더 있으면 중단.
- `meta/_journal.json`은 `diff "$PRE_DIR/migrations/meta/_journal.json" "$POST_DIR/migrations/meta/_journal.json"`로 별도 내용 비교해, `entries` 배열 끝에 객체 1개가 추가되는 hunk만 있는지(기존 entry 수정·삭제 없음) 확인한다.
- 신규 `.sql` 파일 내용은 `CREATE TABLE`/`ALTER TABLE`/`DROP TABLE`/`CREATE INDEX` 문이 전부 `entity_deletion_evidence`(및 그 인덱스)만을 대상으로 하는지 확인한다.
- 이 4개 조건을 전부 통과한 뒤에만, §11의 vitest 실행으로 신규 마이그레이션을 **임시 embedded Postgres에만** 적용한다(`applyPendingMigrations()`가 임시 연결 문자열만 사용 — `packages/db/src/test-embedded-postgres.ts:277`, **CONFIRMED**). 별도의 `pnpm db:migrate` 호출은 하지 않는다(환경변수가 가리키는 대상이 실행 시점 환경설정에 좌우되어 실제 DB를 오염시킬 위험이 있으므로).
- **프로덕션 DB에는 이 계획의 어떤 단계에서도 적용하지 않는다.**

## 11. 테스트 목록 (최종)

기존 `server/src/__tests__/audit-log-retention-contract.test.ts`에 대한 변경 계획(단일 표, 중복 없음):

| # | 테스트 | PASS 조건 |
|---|---|---|
| 1 | company 하드 삭제 증거 및 실제 반환 삭제 건수 | 기존 "documents CURRENT Policy-A behavior..." 케이스에 assertion 추가: `entity_deletion_evidence` 1건 존재, `activityLogRowsDeleted`/`heartbeatRunsDeleted`/`heartbeatRunEventsDeleted`/`workProductRowsDeleted` 각각이 §7의 해당 `.returning().length`와 정확히 일치, `deletedEntityIdHash === hashDeletionIdentifier("company", companyId)` |
| 2 | agent 하드 삭제 증거 및 실제 반환 삭제 건수 | agent 생성 → activity_log/heartbeat_runs/heartbeat_run_events 이벤트 축적 → `agent.remove()` → `entity_deletion_evidence`에 `entityType:"agent"` 1건, 각 카운트 필드가 `.returning().length`와 일치, `workProductRowsDeleted === 0` |
| 3 | §8의 원자성 테스트 | §8 절차대로 blocker 테이블로 부모 DELETE를 자연 실패시킨 뒤, parent/activity_log/heartbeat_runs/heartbeat_run_events/work_products/evidence 6개 전부가 삭제 전 상태로 복구됐음을 확인 |
| 4 | 원본 ID·이름·이메일·자유입력 미저장 | `entity_deletion_evidence` 행의 어떤 컬럼 값에도 원본 companyId 문자열이나 테스트 회사명이 부분 문자열로도 없음을 assert, `reason`이 사전 정의된 고정 상수 집합에 포함되는지 확인 |
| 5 | domain-separated 해시 정확성 | 테스트 코드에서 재계산한 `hashDeletionIdentifier("company", id)`가 DB 값과 일치, `hashDeletionIdentifier("agent", 동일raw)`는 **다른** 해시가 됨을 확인(domain separation 충돌 방지 증명) |
| 6 | evidence용 UPDATE/DELETE API·서비스 부재(정적 검증) | `server/src/**/*.ts`(이 테스트 파일 제외) 스캔에서 `.update(entityDeletionEvidence`/`.delete(entityDeletionEvidence` 미발견 |
| 7 | migration이 깨끗한 임시 DB에 정상 적용 | 이 파일의 `beforeAll`(`startEmbeddedPostgresTestDatabase()` → `applyPendingMigrations()`)이 예외 없이 통과 — 별도 케이스 불필요, `beforeAll` 성공 자체가 PASS 조건 |
| 8 | 기존 Audit retention 테스트 회귀 통과 | 기존 E2E 재구성·archive/reactivate 보존 케이스(현재 4/4 PASS)가 이번 변경 이후에도 그대로 통과 |
| 9 | Policy C 목표(`it.skip`) | 변경 없음 — 전체 `activity_log` 영구 보존은 POST-Closure 백로그이므로 계속 skip 유지 |

**전체 PASS 조건**: 1~8번 활성 케이스 전부 통과 + 9번은 계속 skip.

## 12. 예상 영향과 롤백

- **영향 범위**: 신규 테이블 1개, `companies.ts`/`agents.ts`의 `remove()`에 기존 DELETE 문 뒤에 `.returning()` 추가 + evidence INSERT 1건, 라우트 2곳에서 인자 1개씩 추가(§6). 기존 activity_log/heartbeat 삭제 동작(Policy A) 자체는 바꾸지 않는다.
- **하위 호환성**: 이미 과거에 삭제된 회사/agent에는 소급 증거를 만들 수 없다(범위 밖) — 이 변경 이후의 삭제부터만 증거가 남는다.
- **롤백**:
  - 코드: 일반 git revert로 충분(기존 로직 수정이 아니라 추가이므로 충돌 위험 낮음, **INFERENCE** — 실제 diff 작성 전 확정 불가).
  - 스키마: 이 저장소의 Drizzle 마이그레이션 체계에는 **자동 down 마이그레이션이 없다**(**CONFIRMED**, `packages/db/src/migrations/`는 순방향 `.sql`+`meta/*_snapshot.json`+`_journal.json` 구조만 있음). 프로덕션에 이미 적용된 뒤 되돌려야 한다면 코드 revert + **후속 corrective 마이그레이션**(`DROP TABLE entity_deletion_evidence;`)이 필요하다 — "DROP TABLE로 완전 원복"이라고 단정하지 않는다.
  - 이번 테스트 단계: 프로덕션에 적용하지 않으므로 "롤백"이 아니라 **임시 embedded Postgres 자체가 테스트 종료 시 통째로 폐기되는 것**으로 정리된다(`tempDb.cleanup()`) — (b)의 corrective 마이그레이션 시나리오와 성격이 다름을 구분한다.

## 13. 필요한 변경 파일 (최종)

1. `packages/db/src/schema/entity_deletion_evidence.ts` — 신규(§4)
2. `packages/db/src/schema/index.ts` — `export { entityDeletionEvidence } from "./entity_deletion_evidence.js";` 1줄
3. `packages/db/src/migrations/<N>_*.sql` + `meta/<N>_snapshot.json` — `pnpm db:generate`로 생성(§10 Gate 통과 후)
4. `server/src/services/companies.ts` — `remove(id, actor)`로 시그니처 변경 + §7의 순서 반영. `issueWorkProducts` import 추가 필요(**CONFIRMED**, 현재 import 목록에 없음). `inArray`는 이미 import됨(**CONFIRMED**, `companies.ts:1`)
5. `server/src/services/agents.ts` — `remove(id, actor)`로 시그니처 변경 + §7의 순서 반영
6. `server/src/routes/companies.ts:1325` — `svc.remove(companyId, getActorInfo(req))`로 변경(§6)
7. `server/src/routes/agents.ts:4427` — `svc.remove(id, { actorType: "user", actorId: req.actor.userId ?? "board" })`로 변경(§6)
8. `server/src/__tests__/audit-log-retention-contract.test.ts` — §11의 9개 케이스 반영(신규 파일 아님, 기존 파일 수정)

## 14. 단일 Human Approval 요청 (계획만, 이번 라운드에서 실행하지 않음)

다음을 하나로, 이 순서로만 진행하도록 승인을 요청한다:
1. §13의 8개 파일 작성/수정.
2. §10의 pre/post SHA-256 비교 절차 실행 — 4개 판정 기준을 전부 통과할 때만 다음 단계로 진행, 하나라도 위반되면 즉시 중단·보고.
3. `pnpm exec vitest run server/src/__tests__/audit-log-retention-contract.test.ts` 1회 실행(§10 Gate 통과 후에만) — 별도 `pnpm db:migrate` 호출 없음, 프로덕션 DB 미접촉.
4. 결과를 별도 후속 보고서로 문서화, §11 표의 케이스별 PASS/FAIL을 개별 기록.
5. **이번 승인에 포함하지 않는 것**: 프로덕션 DB 마이그레이션 적용, 프로덕션 배포, 전체 `activity_log` 영구 보존(POST-Closure 백로그), DB 레벨 append-only 강제.

승인 전에는 코드/스키마/마이그레이션/테스트 파일을 작성하지 않는다. Audit retention 최종 판정은 이 승인·실행이 완료되기 전까지 계속 `PARTIAL`이다.
