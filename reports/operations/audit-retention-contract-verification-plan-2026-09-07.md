# Audit Log / Evidence Retention 계약 감사 및 독립 검증 테스트 계획

**작성일:** 2026-09-07
**단계:** READ-ONLY 감사 + 테스트 계획 수립만. 코드/DB/설정/프로세스/Task Scheduler 변경 없음, 테스트 미실행.
**대상:** Core v0.1 Closure 남은 두 조건 중 하나 — "Audit retention 계약 충분성 검증"
(다른 하나인 Gate D 관찰은 이 작업과 무관하며, 이 작업 중 Gate D Observer(PID 17652)·Supervisor·API·DB·Canary·Task Scheduler에는 어떤 방식으로도 개입하지 않았다.)

---

## 1. 질문 해석

Core v0.1 Closure의 남은 조건인 "Audit log/evidence retention"의 실제 구현과 계약을 저장소에서 READ-ONLY로 정밀 감사하고, 이를 안전하게(프로덕션 DB에 영향 없이) 독립 검증할 정확한 테스트 계획을 세운다.

## 2. 질문 목적

Gate D가 진행되는 동안 이 검증 준비를 끝내, Gate D 완료 후 Core Closure가 "다음 감사 대기"로 다시 지연되지 않도록 한다.

## 3. 조사 방법

`decision-retention.ts`와 직접 연결된 코드, DB 스키마/마이그레이션, 보존기간 설정, 삭제/정리/회전 경로, 기존 테스트, 관련 Roadmap/Closure 문서, 기존 PASS/FAIL 증거를 READ-ONLY로 읽었다. 코드 실행·DB 쿼리·프로세스 조회는 전혀 수행하지 않았다(순수 파일 읽기 기반 감사).

---

## 4. 핵심 정정 사항 — "Audit log/evidence retention"의 실제 정의는 `decision-retention.ts`가 아니다

이전 라운드(`reports/operations/core-v0.1-closure-prerequisite-audit-2026-09-07.md`)는 이 Closure 항목의 증거로 `decision-retention.ts`(30일 shelf / 90일 archive)를 인용하고 PARTIAL로 판정했다. 이번 정밀 조사 결과 **이는 잘못된 대응이었다는 것이 CONFIRMED로 확인된다** — 이 파일은 별도 정정 승인 없이는 수정하지 않으므로, 이 문서에만 정정 사실을 기록한다.

- 이 Closure 항목의 원문 요구는 `docs/investigations/claude-core-v0.1-boundary-audit.md` §1 항목 4 "감사 로그와 실행 증거 보존"이며, 그 정의는 `docs/investigations/claude-core-v0.1-audit-evidence-closure-audit.md`(2026-08-31)가 명시한 대로 **"Core v0.1의 단일 E2E 업무를 사후에 누가/무엇을/언제 했는지 재구성할 수 있는 최소 수준"**이다(**CONFIRMED**, 원문 인용: "판단 기준: '완벽한 전사 Audit 시스템'이 아니라... 최소 수준인지만 판단한다").
- 이 정의를 충족하는 실제 구현은 `activity_log`(`packages/db/src/schema/activity_log.ts`) + `heartbeat_runs`/`heartbeat_run_events` + `issue_work_products`이며, `logActivity`/`publishActivity`(`server/src/services/activity-log.ts`)가 저장소 전역 72개 파일에서 호출된다(**CONFIRMED**, 위 문서에서 직접 인용, 이번 조사에서 재확인 가능한 범위 내 확인).
- `decision-retention.ts`(`decisionRetention`/`decisionArchiveNotificationOutbox` 테이블)는 이것과 **다른 기능**이다 — "attention 피드"(결정 대기함/승인함에 뜨는 항목)의 UI 정리용 **Keep/Archive(가역적) 수명주기**이지, 감사 로그의 보존·삭제 계약이 아니다(**CONFIRMED**, `server/src/services/decision-retention.ts` 전체 코드 확인 — `archive`가 `archivedAt`을 세팅할 뿐 행을 삭제하지 않고, `revive`로 되돌릴 수 있음).
- 따라서 "Audit retention이 PARTIAL"이라는 이전 판정의 근거 자체가 틀렸다. 올바른 근거로 재평가하면 아래 §10의 판정이 나온다.

## 5. "반드시 확인할 항목" 10개 — 항목별 확인 결과

**대상: 실제 Closure 계약(`activity_log` + `heartbeat_run_events` + `issue_work_products`)**

| # | 항목 | 판정 | 근거 |
|---|---|---|---|
| 1 | 공식 retention 계약이 무엇인가 | **CONFIRMED** | 별도 상세 스펙 문서 없음, "감사 로그와 실행 증거 보존"(단일 E2E 업무 사후 재구성 가능성)이 요구사항 전문. `docs/investigations/claude-core-v0.1-audit-evidence-closure-audit.md` §Core requirement에서 직접 인용 확인 |
| 2 | 어떤 데이터가 몇 일간 보존되는가 | **INFERENCE / 부분 UNVERIFIED** | `activity_log`에는 TTL/만료 컬럼이 존재하지 않는다(`packages/db/src/schema/activity_log.ts` 스키마 확인 — `createdAt`만 있고 삭제 예정 시각 필드 없음). 즉 "명시적 N일" 계약은 **존재하지 않으며, 사실상 무기한 보존이 기본값**이다(단, §7 참고 — 상위 엔터티 삭제 시 동반 삭제됨) |
| 3 | 보존기간이 지난 데이터만 삭제되는가 | **N/A(계약 자체가 시간 기반 삭제를 정의하지 않음)** | activity_log에는 시간 기반 자동 삭제 스윕이 아예 없다(§7 grep 결과 — activity_log에 대한 DELETE는 오직 상위 company/agent 삭제 트랜잭션 내부에만 존재, 시간 조건 없음) |
| 4 | 보존 대상과 삭제 대상이 명확히 분리되는가 | **PARTIAL — CONFIRMED 간극 발견** | §7 참고. company/agent가 **하드 삭제**되면 그 activity_log 행도 **나이(age)와 무관하게** 함께 삭제된다 — "방금 생긴 로그"와 "1년 된 로그"가 구분 없이 삭제된다 |
| 5 | Audit log가 임의 수정·조기 삭제되지 않도록 보호되는가 | **PARTIAL** | **수정(UPDATE)** 경로는 저장소 전체에서 발견되지 않음(**CONFIRMED**, `logActivity`/`persistActivity`는 오직 INSERT만 수행) → 사실상 append-only. 하지만 **삭제(DELETE)** 는 company/agent 하드 삭제 시 무조건 발생하며 이를 막는 별도 가드나 최소 보존기간 체크가 없음(§7) |
| 6 | 정리 작업이 실제 실행 경로에 연결되어 있는가 | **CONFIRMED(대상: decision-retention 자동 아카이브)** | `server/src/index.ts:1411-1428`의 `runRetentionSweep`이 서버 기동 시 1회, 이후 `startHeartbeatSchedulerInterval` 콜백(`server/src/index.ts:1439`) 안에서 매 heartbeat tick마다 반복 실행되어 `retentionExecutor.autoArchive`/`deliverNotifications`를 호출함을 직접 확인. (단, activity_log 자체에는 이런 시간 기반 정리 스윕이 없음 — §5) |
| 7 | 회사·인스턴스 간 데이터 경계가 유지되는가 | **CONFIRMED** | `activity_log.company_id`가 `companies.id` FK이며, 저장소에서 확인한 모든 activity_log 쿼리(`logActivity` 호출부, `companies-service.test.ts`의 조회 쿼리 등)가 예외 없이 `eq(activityLog.companyId, companyId)`로 스코프됨 |
| 8 | 실패 시 로그·증거가 남는가 | **PARTIAL** | `decision-retention.ts`의 `deliverNotifications`는 알림 발송 실패 시 상태를 `pending`으로 되돌리고 `attemptCount`를 증가시킬 뿐(`server/src/services/decision-retention.ts:458-467`), 실패 자체를 `logActivity`로 별도 기록하지 않음 — 카운터 기반 관측은 되지만 "실패했다"는 감사 로그 자체는 없음 |
| 9 | 기존 테스트가 실제 계약을 충분히 검증하는가 | **PARTIAL — 이것이 유일한 실질적 공백** | `docs/investigations/claude-core-v0.1-closure-readiness-refresh.md`가 이미 명시: "자체 판정만 존재, 독립 감사는 아직 없음"(**CONFIRMED**, 원문 인용). 이번 조사에서도 activity_log/heartbeat_run_events/issue_work_products의 "단일 E2E 사후 재구성 가능성"을 직접 assert하는 전용 테스트 파일은 발견하지 못했다(기존 72개 파일은 각자의 기능을 검증하며 activity_log를 부산물로 남길 뿐, "이 로그만으로 감사관이 재구성할 수 있는가"를 목적으로 하는 테스트는 없음) |
| 10 | Core Closure 조건을 충족하려면 무엇이 더 필요한가 | **CONFIRMED(아래 §9 테스트 계획으로 직접 답함)** | (a) "단일 E2E 재구성" 주장에 대한 독립 실행 테스트 1건, (b) §7에서 발견한 "하드 삭제 시 무조건 동반 삭제" 간극을 Closure 판정에 명시적으로 반영할지에 대한 CEO/Human 결정 |

## 6. `decision-retention.ts` 자체 계약 확인 (별개 기능이지만 부가 조사로 확인)

Closure 항목의 본체는 아니지만, 이전 라운드가 이를 근거로 인용했으므로 그 자체 계약도 확인해 둔다.

- 기본 계약: `DEFAULT_DECISION_SHELF_DAYS = 30`(피드에 "shelf" 배지가 붙는 기준), `DEFAULT_DECISION_ARCHIVE_DAYS = 90`(자동 아카이브 기준) — `server/src/services/decision-retention.ts:29-30`(**CONFIRMED**, 코드 직접 확인).
- 큐(`decision_queues.retentionDays`)에 오버라이드가 있으면 그 중 **최솟값**을 shelf 기준으로 사용, 없으면 기본 30일 — `server/src/services/attention.ts:577-643`(**CONFIRMED**).
- "삭제"가 아니라 "아카이브"다: `autoArchive`는 `archivedAt`/`archivedReason: "idle_ttl"`을 세팅할 뿐 행을 지우지 않으며, `revive()`로 원복 가능 — `server/src/services/decision-retention.ts:343-395`(**CONFIRMED**). 즉 이 기능은 "삭제 계약"이 아니라 "UI 노출 여부 계약"이다.
- 자동 아카이브는 `keep=true`로 표시된 항목을 제외한다(`eq(decisionRetention.keep, false)` 조건) — **CONFIRMED**, `server/src/services/decision-retention.ts:366`.
- 회사 경계: 모든 쿼리가 `companyId`로 스코프됨 — **CONFIRMED**.
- 실행 경로 연결: §5-6에서 이미 확인한 대로 heartbeat 스케줄러 tick마다 실행 — **CONFIRMED**.
- 테스트 커버리지: `server/src/__tests__/decision-retention-service.test.ts`가 (a) 자동 아카이브 후 피드 제외/복구, (b) `keep` 예외 + 알림 배치, (c) 낙관적 버전 충돌 시 전체 롤백을 검증한다(**CONFIRMED**, 전체 파일 읽음). 다만 **90일 경계값 자체**(89일째 vs 91일째)를 직접 비교하는 테스트는 없다 — 테스트는 4월 데이터 + 8월 `now`(약 123일 차)만 사용해 "충분히 오래된 경우"만 검증하고 "아직 안 된 경우"의 부정 사례(negative case)는 별도로 assert하지 않는다(**CONFIRMED**, 파일 전체 읽기로 확인 — 부재의 확인).

## 7. 위험 발견: 하드 삭제 시 activity_log 나이 무관 동반 삭제 (새로 발견, CONFIRMED)

- `server/src/services/companies.ts:455` — `company.remove()` 트랜잭션이 `tx.delete(activityLog).where(eq(activityLog.companyId, id))`를 실행 — 해당 회사의 모든 activity_log 행을 **생성 시각과 무관하게** 삭제한다.
- `server/src/services/agents.ts:960-965` — `agent.remove()` 트랜잭션이 `tx.delete(activityLog).where(or(eq(activityLog.agentId, id), <해당 agent의 run에 연결된 activityLog>))`를 실행 — 해당 agent 관련 activity_log 행도 동일하게 나이 무관 삭제된다.
- 완화 요인(중요): 이것은 **"보관(archive)"이 아니라 "완전 삭제(hard delete)"** 경로이며, 라우트 확인 결과 `DELETE /companies/:companyId`는 `assertBoard(req)`로 Board 권한이 필요하다(`server/src/routes/companies.ts:1321-1331`, **CONFIRMED**). 평시 운영 경로인 "회사 일시 정지"(Emergency Stop과 연관된 `company.archived`/`company.reactivated`)는 **상태 변경일 뿐 activity_log를 건드리지 않는다** — `companies-service.test.ts`에서 확인한 대로 archived/reactivated 이벤트 자체가 activity_log에 남고 조회된다(**CONFIRMED**, 위 §5-2 grep 결과).
- 결론: "일반적인 운영(회사 archive/pause)"에서는 audit log가 보호되지만, "회사/agent를 완전히 삭제"하는 드물고 권한이 강한 작업에서는 **age 기반 최소 보존기간 없이** audit log가 사라진다. 이는 "Audit log가 임의 조기 삭제되지 않도록 보호되는가"라는 §5-항목5 질문에 대한 **PARTIAL** 판정의 직접 근거다. 의도된 설계(entity 자체가 사라지면 그 로그도 필요 없다는 판단)일 수도 있으나, **그렇게 명시적으로 결정한 문서를 찾지 못했다**(UNVERIFIED — 의도 여부).

## 8. 기존 테스트 커버리지 총평

- `activity_log`/`heartbeat_run_events`/`issue_work_products` 자체의 "감사 목적 충분성"을 독립적으로 assert하는 전용 테스트는 **없음**(CONFIRMED, 부재 확인).
- `decision-retention-service.test.ts`는 자기 기능(Keep/Archive UI 수명주기)은 잘 덮지만, 90일 경계값 부정 사례가 없고애초에 이것은 Closure 항목의 본체가 아니다.
- `companies-service.test.ts`는 `company.archived`/`company.reactivated`가 activity_log에 남는 것은 검증하지만, `company.remove()`가 activity_log를 **삭제한다는 사실 자체를 검증하는 테스트**는 발견하지 못했다(이 삭제 동작이 "의도된 스펙"인지 "우연히 그렇게 짜인 구현"인지조차 테스트로 고정되어 있지 않다는 뜻).

---

## 9. 독립 검증 테스트 계획 (미실행 — 승인 후 실행 대상)

아래는 **제안**이며, 이번 작업에서 실행하지 않는다. 실행하려면 §11의 단일 Human Approval이 필요하다.

### 9-A. 신규 테스트 파일 (제안, 아직 생성하지 않음)
`server/src/__tests__/audit-log-retention-contract.test.ts`

### 9-B. 검증할 계약 (3개 케이스)
1. **단일 E2E 재구성 가능성**: Issue 생성 → 승인 요청 → 승인 → 완료까지의 흐름을 만든 뒤, `activity_log`만 조회해서 "누가/무엇을/언제" 순서를 재구성할 수 있는지 assert (`entityType/entityId`, `actorType/actorId`, `createdAt` 오름차순).
2. **회사 archive/reactivate는 activity_log를 보존한다**: `company.archived`/`company.reactivated` 전후로 기존 activity_log 행 수가 줄지 않음을 assert(§7에서 확인한 "평시 운영은 안전하다"는 주장을 코드가 아니라 테스트로 고정).
3. **하드 삭제의 실제 범위를 명시적으로 고정**: `company.remove()` 호출 후 해당 companyId의 activity_log 행이 0건임을 assert — 이것이 "버그"가 아니라 "현재 계약"임을 회귀 테스트로 못박는다(향후 누군가 실수로 "삭제 안 되게" 바꾸거나 반대로 "일부만 삭제되게" 바꾸는 것을 모두 잡아낸다).

### 9-C. 대상 파일 (읽기/참조만, 수정 대상 아님)
- `server/src/services/activity-log.ts`
- `server/src/services/companies.ts`(`remove`)
- `packages/db/src/schema/activity_log.ts`

### 9-D. 테스트가 사용하는 DB/포트/임시 디렉터리
- **격리 방식**: `packages/db/src/test-embedded-postgres.ts`의 `startEmbeddedPostgresTestDatabase()` 사용(기존 `decision-retention-service.test.ts`와 동일 패턴, **CONFIRMED** 코드 확인).
- **DB**: 테스트 프로세스가 그때그때 새로 초기화하는 **embedded PostgreSQL 인스턴스**(패키지 `embedded-postgres`). 프로덕션 PostgreSQL과 완전히 다른 프로세스.
- **데이터 디렉터리**: `fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-audit-retention-"))` — OS 임시 디렉터리 하위에 매 실행마다 새로 생성되는 고유 폴더. `cleanup()` 호출 시 `fs.rmSync(..., { recursive: true, force: true })`로 완전 삭제(`test-embedded-postgres.ts:108-133`).
- **포트**: `getAvailablePort()`가 OS에 포트 0을 요청해 커널이 배정한 **임시 빈 포트**를 사용하며, 실제 개발용 기본 포트(`54329`)와 `PAPERCLIP_TEST_POSTGRES_RESERVED_PORTS` 환경변수로 지정된 포트들은 명시적으로 제외한다(`test-embedded-postgres.ts:41-52, 77-106`, **CONFIRMED**).
- **마이그레이션**: 새 임시 DB에 `applyPendingMigrations()`로 저장소의 실제 마이그레이션 전체를 처음부터 적용(운영 DB의 데이터는 전혀 관여하지 않음, 스키마 정의만 재사용).

### 9-E. 프로덕션 DB와 완전히 격리되는 근거
1. 연결 문자열이 `postgres://paperclip:paperclip@127.0.0.1:<임시포트>/paperclip`로, 프로덕션 연결 문자열(별도 env `DATABASE_URL`)과 전혀 다른 소켓·포트·프로세스를 가리킨다.
2. 임시 포트 할당 로직이 알려진 실제 사용 포트(기본 54329 등)를 명시적으로 회피한다.
3. 테스트 프로세스 자체가 별도의 `embedded-postgres` 자식 프로세스를 새로 기동하며, `afterAll`에서 `instance.stop()` + 데이터 디렉터리 삭제로 완전히 소멸시킨다 — 기존 `decision-retention-service.test.ts`가 동일 패턴으로 이미 반복 실행되고 있다(**CONFIRMED**, 다른 테스트에서 실사용 중인 검증된 패턴).
4. Gate D가 관찰 중인 실제 Supervisor/API/DB/Canary 프로세스와는 PID·포트·데이터 디렉터리가 전혀 겹치지 않는다 — 새 테스트는 그 무엇도 조회하거나 신호를 보내지 않는다.

### 9-F. 생성·수정될 파일 (실행 시)
- 신규 생성: `server/src/__tests__/audit-log-retention-contract.test.ts` (1개)
- 수정: 없음 (기존 production 코드는 변경하지 않음 — 순수 신규 테스트 파일 추가만)
- 실행 중 임시로 생성: OS 임시 디렉터리 하위 폴더(테스트 종료 시 자동 삭제) — 저장소 내부에는 아무 흔적도 남지 않음

### 9-G. 예상 소요 시간
- embedded Postgres 기동 + 마이그레이션 적용: 기존 `decision-retention-service.test.ts`의 `beforeAll` 타임아웃이 30초로 설정된 것을 근거로 유사 규모 예상(**INFERENCE**, 실측 아님) — 총 3개 케이스 기준 **약 30~60초** 예상.

### 9-H. PASS 조건
- 케이스 1: `activity_log`에서 시간순으로 조회한 이벤트 시퀀스가 (issue 생성 → 승인요청 → 승인 → 완료) 순서와 정확히 일치하고, 각 행의 `actorType/actorId`가 기대값과 일치.
- 케이스 2: archive/reactivate 전후 `activity_log` 총 행 수가 감소하지 않음(`>=` 기존 값).
- 케이스 3: `company.remove()` 이후 `SELECT count(*) FROM activity_log WHERE company_id = :id`가 정확히 0.
- 3개 케이스 전부 통과해야 "PASS"로 간주.

### 9-I. 실패 시 영향과 중단 방법
- **영향 범위**: 신규 테스트 파일과 그 안에서 새로 기동한 임시 embedded Postgres 인스턴스에 한정됨. 프로덕션 DB, Gate D Observer, Supervisor/API/DB/Canary, 다른 테스트 파일에는 어떠한 영향도 없음(9-E 근거).
- **실패 시 즉시 조치**: 테스트 러너가 자동으로 non-zero exit code 반환 → 커밋/배포로 이어지지 않음(별도 승인 절차 없이는 이 결과가 프로덕션에 반영될 경로 자체가 없음).
- **중단 방법**: 실행 중인 터미널에서 `Ctrl+C` — vitest는 `afterAll`을 실행해 embedded Postgres 프로세스 정리 및 임시 디렉터리 삭제를 시도한다(단, 강제 종료 시 정리가 불완전할 수 있으므로, 중단 후 `%TEMP%\paperclip-audit-retention-*` 잔여 폴더를 수동 확인/삭제 권장 — 이 문서가 하지 않고 사용자가 승인 후 직접 확인).

### 9-J. 실행할 테스트 명령 (승인 후, 예시로만 제시 — 이번 작업에서 실행하지 않음)
```
pnpm exec vitest run server/src/__tests__/audit-log-retention-contract.test.ts
```

---

## 10. 판정

### `PARTIAL`

- 각 결론의 등급:
  - "핵심 구현(72개 파일에 걸친 activity_log 표준 경로, 단일 E2E 사후 재구성 가능)이 실재한다" — **CONFIRMED**.
  - "이 항목에 대한 독립 실행 검증 테스트는 지금까지 존재하지 않는다" — **CONFIRMED**(자체 판정 문서가 스스로 이렇게 명시함).
  - "하드 삭제 시 activity_log가 나이와 무관하게 동반 삭제된다" — **CONFIRMED**(코드 직접 확인), 이것이 "의도된 설계"인지는 **UNVERIFIED**.
  - "이 간극이 Core v0.1 Closure를 막을 만큼 심각한가" — **INFERENCE**: 평시 운영(archive/pause)에서는 안전하고, 하드 삭제는 Board 권한으로 제한되어 있어 우발적 위험은 낮다고 보이나, 이는 판단(INFERENCE)이지 확정된 정책 문서에 근거한 CONFIRMED 결론은 아니다.
- `VERIFIED_IMPLEMENTED`가 아닌 이유: 독립 검증이 전무하고, 삭제/보존 경계 관련 간극이 실제로 발견되었다.
- `NOT_IMPLEMENTED`가 아닌 이유: 핵심 인프라(activity_log 등)는 72개 파일에서 실사용 중이며 견고하다.
- `UNABLE_TO_VERIFY`가 아닌 이유: 코드/문서 직접 확인으로 구체적 CONFIRMED 근거를 다수 확보했다.

---

## 11. Human Approval 요청 (통합) — **상태 업데이트: 이후 라운드에서 승인·실행 완료**

당시(이 절 작성 시점) 다음을 하나로 묶어 승인을 요청했다:
1. §9의 신규 테스트 파일 `server/src/__tests__/audit-log-retention-contract.test.ts` 작성.
2. §9-J 명령으로 그 파일만 격리 실행(embedded Postgres, 프로덕션 DB 미접촉).
3. 결과(PASS/FAIL)를 이 보고서 또는 별도 후속 보고서에 반영.

**이 승인은 이후 라운드에서 실제로 이루어졌다**: 위 3개 항목 모두 실행 완료 — 결과는 `reports/operations/audit-retention-contract-test-result-2026-09-07.md`에 기록되어 있다(활성 케이스 4/4 PASS, 공식 판정명 `CURRENT_IMPLEMENTATION_CHARACTERIZED` — "Audit retention 문제 없음"이 아님에 주의). Audit retention 전체 판정은 그 실행 이후에도 계속 `PARTIAL`이다.

## 12. 요약

"Audit log/evidence retention" Closure 항목의 실제 대상은 `decision-retention.ts`가 아니라 `activity_log`+`heartbeat_run_events`+`issue_work_products`이며, 그 구현 자체는 견고하지만(72개 파일 실사용) **독립 검증이 없다는 공백**과 **하드 삭제 시 나이 무관 동반 삭제라는 새로 발견된 간극**이 있어 판정은 `PARTIAL`이다. §9의 3-케이스 테스트 계획이 이 공백을 승인 후 즉시 메울 수 있도록 구체적으로 준비되어 있다.

**2026-09-07 이후 경과**: §7의 발견(하드 삭제 시 activity_log 나이 무관 동반 삭제)을 근거로, FK/`ON DELETE` 규칙 정밀 추적, 정책 A/B/C 비교, 권장안 선정, 트랜잭션 설계(DELETE...RETURNING 기반), 테스트 목록, 마이그레이션 오염 방지 절차까지 전부 별도 문서 `reports/operations/audit-retention-c-lite-implementation-plan-2026-09-07.md`로 **완전히 재작성되어 이전**되었다(그 문서의 최종본이 이 절의 초기 초안보다 정확함 — 예: 초안의 "SELECT COUNT 선조회" 설계는 그 문서에서 "DELETE...RETURNING"으로 교정됨, 3-케이스 테스트가 9-케이스로 확장됨). **중복을 피하기 위해 이 문서에서는 해당 상세 내용을 제거하고, 최신·정확한 버전이 있는 위치만 가리킨다. 아래 §13은 그 최종 문서로의 안내로 대체한다.**

---

## 13. 정책 A/B/C 비교·권장안·테스트 목록·마이그레이션 절차 — 최종 버전 위치 안내

이 절(원래 §13~§19)의 상세 내용(FK/`ON DELETE` 원인 추적, 정책 A/B/C 비교표, 권장 정책 C 선정 근거, 권장 계약의 PASS 조건, 테스트 목록, 격리 테스트 환경, Human Approval 요청)은 **`reports/operations/audit-retention-c-lite-implementation-plan-2026-09-07.md`에 최종·정확한 형태로 존재한다.** 이 문서와 내용이 중복되지 않도록 상세본은 그쪽에만 남기고 여기서는 요지만 기록한다:

- **권장 정책**: C(감사 로그 전체 보존 + 삭제 사실을 별도 append-only 이벤트로 기록) — 근거와 한계는 원 문서 §5·§15 참고.
- **구현 상태**: `DESIGN_READY / NOT_IMPLEMENTED` — 설계 문서만 존재하며, `entity_deletion_evidence` 테이블·서비스 코드는 이 세션에서 단 한 줄도 작성되지 않았다.
- **채택 여부(경로 1 vs 경로 2)는 여전히 CEO/Human 결정 사항으로 미결**이다 — 이 문서도, C-lite 문서도 대신 결정하지 않는다.
- 이 절이 원래 제안했던 마이그레이션/테스트 작업은 **실행되지 않았다.** 실행하려면 C-lite 문서 §14의 단일 Human Approval 절차를 따른다.
