# Audit Log / Evidence Retention — A안 격리 테스트 실행 결과

**작성일:** 2026-09-07
**범위:** 승인된 A안만 실행(신규 테스트 파일 작성 + 1회 실행). B안(정책 C 스키마/코드 구현)은 실행하지 않았다.
**Gate D:** PID 17652 계속 `OBSERVING`. 이번 작업 중 Gate D Observer·Supervisor·API·DB·Canary·Task Scheduler에는 어떤 방식으로도 개입하지 않았다.

---

## 1. 실행한 명령

```
pnpm exec vitest run server/src/__tests__/audit-log-retention-contract.test.ts
```

1회만 실행했다(재실행 없음).

## 2. 결과 원문

```
 Test Files  1 passed (1)
      Tests  4 passed | 1 skipped (5)
   Duration  39.93s (transform 7.11s, setup 2.42s, import 27.13s, tests 9.46s)
```

## 3. 테스트별 결과

| # | 테스트명 | 결과 | 검증 내용 |
|---|---|---|---|
| 1 | 단일 E2E 재구성 가능성(issue.created → approval.created → approval.approved → issue.updated) | **PASS** | activity_log만 조회해 4개 이벤트가 정확한 시간순·actor·entity로 재구성됨을 확인 |
| 2 | company archive/reactivate 시 activity_log 보존 | **PASS** | archive 후 1건, reactivate 후 2건(`company.archived`, `company.reactivated`) 존재 — 어떤 행도 삭제되지 않음 |
| 3 | "documents CURRENT Policy-A behavior — hard delete removes activity_log regardless of row age" | **PASS** | 400일 전 행 1건 + 방금 생성된 행 1건을 넣고 `company.remove()` 실행 → 나이와 무관하게 2건 모두 삭제됨을 확인. **이 PASS는 "바람직한 보존 정책이 통과했다"는 뜻이 아니라 "현재 Policy A 동작이 코드와 일치함을 확인했다"는 뜻으로만 기록한다** |
| 4 | Policy C 목표(삭제 사실 기록 + 기존 행 보존) | **SKIP(의도된 상태)** | 아직 구현되지 않은 목표 계약을 고정해 둔 placeholder — 활성화하지 않음, B안 승인 전까지 계속 skip 유지 |
| 5 | decision-retention 90일 경계값(정확히 90일 vs 89일) | **PASS** | 90일째 항목만 아카이브되고 89일째 항목은 아카이브되지 않음을 확인 |

## 4. 임시 리소스 및 정리

- **임시 DB**: embedded PostgreSQL(테스트 프로세스가 새로 기동, `paperclip-audit-retention-` 접두사)
- **임시 디렉터리**: OS 임시 디렉터리 하위(`%TEMP%\paperclip-audit-retention-*`) — 테스트 종료 시 자동 정리됨. 실행 직후 확인한 결과 잔여 폴더 **없음**(`NO_LEFTOVER_TEMP_DIRS_FOUND`).
- **임시 포트**: OS가 실행 시점에 배정한 임시 빈 포트(고정값 없음, 기본 개발 포트 54329 및 예약 포트는 사용하지 않음).
- **프로덕션 DB**: 전혀 접속하지 않음(연결 문자열이 임시 embedded 인스턴스만 가리킴).

## 5. 프로덕션/Gate D 영향

- 프로덕션 코드·스키마·마이그레이션: **변경 없음**.
- 프로덕션 DB: **접근·변경 없음**.
- Gate D Observer(PID 17652), Supervisor, API, DB, Canary, Task Scheduler: **조회·개입 없음**. Gate D는 이 작업과 완전히 독립적으로 계속 `OBSERVING` 상태다.
- Git: commit/reset/checkout 등 어떤 작업도 수행하지 않았다.

## 6. 판정에 대한 명시적 기록 규칙 적용

- 활성 테스트(1·2·3·5) 전부 통과했지만, 이 결과의 공식 명칭은 **`CURRENT_IMPLEMENTATION_CHARACTERIZED`**이다.
- 이 결과를 `AUDIT_RETENTION_VERIFIED_PASS`로도, Core v0.1 Closure 충족으로도 기록하지 않는다.
- 3번 테스트의 통과는 "바람직한 보존 정책 통과"가 아니라 "현재 Policy A 동작이 코드와 일치함을 확인"으로만 기록한다.
- Policy C 테스트(4번)가 `skip` 상태로 남아있는 한, Audit retention의 Core v0.1 Closure 최종 판정은 계속 **`PARTIAL`**이다(정책 A/C 중 무엇을 Closure 시점 계약으로 채택할지는 여전히 `reports/operations/audit-retention-c-lite-implementation-plan-2026-09-07.md` §15의 CEO/Human 결정 사항으로 남아 있다 — 이 결과 실행으로 그 결정이 대신 내려진 것은 아니다).

## 7. 보존 파일

- 신규 테스트 파일 `server/src/__tests__/audit-log-retention-contract.test.ts`는 (실패하지 않았지만) 삭제하지 않고 그대로 보존한다 — 향후 Policy 결정 후 4번 케이스의 `skip`을 해제할 기반이 된다.
