# NEXORA Core v0.1 Closure — Prerequisite Audit (2026-09-07)

**감사 방식:** READ-ONLY. 저장소 파일, Git 상태, 실제 코드, 기존 증거 디렉터리만 조사. Gate D Observer(v2, PID 17652 보고값) 및 Supervisor/API/DB/Canary 프로세스에는 어떠한 개입도 하지 않았다.

**Core v0.1 Closure 체크리스트(이 세션 전체에서 일관되게 적용된 4개 항목):**
1. Gate C — 비파괴 백업 복원 검증
2. Gate D — 24시간 연속 안정성 관찰
3. Emergency Stop — heartbeat.ts 서버 가드
4. Audit log / evidence retention

각 결론은 `CONFIRMED` / `INFERENCE` / `UNVERIFIED`로 구분한다.

---

## 1. Gate C — 비파괴 백업 복원 검증

**판정: CONFIRMED DONE.**

- 증거 디렉터리 실재 확인(READ-ONLY, 삭제/수정 없음): `C:\Users\Nexora\AppData\Local\Temp\nexora-restore-test-20260831-220448-0aa1aa15` 및 `-retry1`~`-retry8` 전부 디스크에 존재함(CONFIRMED, 이번 세션에서 `find` 명령으로 직접 재확인).
- 최종 판정 파일(`-retry8\evidence\10-final-verdict-summary.json`, 이 세션 초반에 직접 읽은 내용): `"overallPass": true`, `"guard16": {"schemaPass": true, "dataPass": true, "ttlPass": true}`, `"protectedServicesUnchanged": true`, `"disposableCleanupVerified": true` (CONFIRMED — 이 세션 자체의 실행 기록).
- `docs/investigations/` 아래 Gate C 관련 감사 문서 다수 존재(`antigravity-gate-c-*`, `claude-gate-c-*`, `claude-backup-restore-gate-c-*` 등, 이번 세션에서 파일 목록으로 재확인) — 다단계 독립 검증 이력이 저장소에 남아 있음(CONFIRMED, 목록 존재만 재확인, 각 파일 내용 전체를 이번 감사에서 재독하지는 않음).

**결론: Gate C는 실행되었고, 최종 증거가 PASS로 확정되어 있으며, 이 증거는 디스크에 보존되어 있다.**

---

## 2. Gate D — 24시간 연속 안정성 관찰

**판정: IN PROGRESS(`OBSERVING`) — 아직 PASS 아님.**

- v1 Observer(PID 7356, 스크립트 `gate-d-24h-observe.ps1`): T0 2026-09-06 23:52:05 KST, 증거 디렉터리 `gate-d-supervisor-ebusy-24h`에 `00-gate-d-baseline-t0.json`과 `snapshot-hour-01.json`만 존재(CONFIRMED, 이번 세션 `ls` 결과) — **Hour 1까지만 진행되고 중단됨.**
- v1 스크립트 자체의 계약 감사(이번 세션에서 코드 정독으로 수행)에서 발견된 결함: Supervisor PID 연속성 미검증, 명령줄 기준 중복 프로세스 미검증, Supervisor 소스 SHA-256 미검증, `Generate-T24FinalSummary`의 `.Count` 처리 비일관성(CONFIRMED — 이 세션에서 원본 파일을 직접 읽고 확인한 코드 결함).
- v2 Observer(`gate-d-24h-observe-v2.ps1`)를 위 결함을 보강해 신규 작성, 사용자 제공 원본과 SHA-256 대조 후(`9BC6633C...` 일치 확인) 신규 경로에 배치, PowerShell Parser 구문검사 PASS, 격리 DryRun 실행 결과 대부분 조건 충족(비관리자 세션 제약으로 명령줄 의존 필드 3개만 미확인)(CONFIRMED, 이번 세션 직접 실행 기록).
- 현재 v2 증거 디렉터리(`gate-d-supervisor-ebusy-24h-v2`)에는 T0 baseline만 존재, 아직 시간별 스냅샷 없음(CONFIRMED, `ls` 결과) — v2 T0(2026-09-07 01:25:44 KST) 이후 경과 시간이 짧기 때문으로 판단됨(INFERENCE).
- v1→v2 교체는 **Supervisor 자체의 EBUSY 재발이 아니라 Observer 스크립트 자신의 계약 결함 발견에 따른 계획적 교체**였다(CONFIRMED — Supervisor PID 21488은 양쪽 baseline에서 동일).

**결론: 24시간·24개 스냅샷 요건이 아직 충족되지 않았으므로 Gate D는 Closure 전제조건을 아직 만족하지 못한다.**

---

## 3. Emergency Stop — heartbeat.ts 서버 가드

**판정: CONFIRMED DONE — 단, 문서 간 불일치가 있었음(이번 감사로 해소).**

이번 감사에서 새로 발견한 핵심 사실: `docs/investigations/claude-core-v0.1-boundary-audit.md`(Core Closure 체크리스트 원본)와 `doc/plans/nexora-master-roadmap.md`(2026-08-31)는 이 항목을 **"NOT STARTED"**로 기록하고 있으나, **같은 날짜(2026-08-31)에 작성된 별도 문서** `docs/investigations/claude-emergency-stop-heartbeat-guard-verification.md`는 이를 다음과 같이 검증 완료로 기록하고 있다:

> **FINAL VERDICT: PASS — existing production guard verified.** "Emergency Stop server-side heartbeat guard requires no production-code change."

이 문서가 제시하는 근거(CONFIRMED, 문서 직접 읽음):
- 기존 프로덕션 코드에 이미 3개 가드 지점 존재: `enqueueWakeup`(`heartbeat.ts:18140` 부근), `tickTimers`(`heartbeat.ts:20001` 부근), `resumeQueuedRuns`(`heartbeat.ts:13897` 부근) — 전부 `company.status !== "active"`(즉 `"paused"`)일 때 새 실행을 시작하지 않음.
- 신규 테스트 파일 1개(`heartbeat-paused-company-guard.test.ts`)로 embedded PostgreSQL 위에서 실제 경로를 mock 없이 검증, 기존 `archived` 회귀 테스트 8건과 함께 **14/14 PASS**.
- 프로덕션 코드 변경 **0건**(테스트 파일 1개 + 보고서 1개만 추가).

**이번 세션에서 라이브 코드로 재확인(CONFIRMED)**: `server/src/services/heartbeat.ts`에서 `eq(companies.status, "active")` 패턴이 4곳(약 8309, 13907, 18204, 20015행)에서 실제로 발견됨 — 검증 문서가 인용한 가드 지점 수와 정합적이다.

**남은 한계**: (1) "이미 실행 중인 run을 강제 중단"하는 기능은 검증 문서 자체가 "존재하지 않으며 검증 대상도 아니었다"고 명시함(범위 밖, 의도된 설계) — **새 실행을 막는 것까지만 Emergency Stop의 정의**라는 전제 위에서의 PASS이다. (2) 이 검증 결과가 `claude-core-v0.1-boundary-audit.md`/`nexora-master-roadmap.md` 원본 문서에 공식 반영되지는 않았다(검증 문서 자신이 "공식 상태 문서 갱신은 범위 밖 — 별도 승인 필요"라고 명시) — 이번 감사도 그 원본 문서를 수정하지 않았다(승인 범위 밖).

**결론: Emergency Stop 항목은 실질적으로 DONE이며, 남은 것은 공식 체크리스트 문서 자체의 표기 갱신(Human 승인 필요)뿐이다.**

---

## 4. Audit log / evidence retention

**판정: PARTIAL(CONFIRMED 존재, 완전성은 INFERENCE).**

> **후속 정정(2026-09-07, 별도 라운드)**: 이 절이 원래 근거로 인용했던 `decision-retention.ts`는 **이 Closure 항목의 잘못된 대상이었음이 후속 감사에서 확인됐다** — `decision-retention.ts`는 "attention 피드"(결정 대기함 UI)의 Keep/Archive 수명주기 기능이며, "감사 로그와 실행 증거 보존"이 실제로 가리키는 구현은 `activity_log`+`heartbeat_runs`/`heartbeat_run_events`+`issue_work_products`다. 상세 정정 근거는 `reports/operations/audit-retention-contract-verification-plan-2026-09-07.md` §4, 실행된 특성화 테스트는 `reports/operations/audit-retention-contract-test-result-2026-09-07.md`(결과: `CURRENT_IMPLEMENTATION_CHARACTERIZED`), 남은 정책 설계는 `reports/operations/audit-retention-c-lite-implementation-plan-2026-09-07.md`(`DESIGN_READY / NOT_IMPLEMENTED`)를 참고. **판정 자체(PARTIAL)는 이 정정 이후에도 바뀌지 않는다** — 근거 대상만 정정한다.

- ~~`server/src/services/decision-retention.ts` 실재 확인(CONFIRMED, 코드 직접 읽음): `DEFAULT_DECISION_SHELF_DAYS = 30`, `DEFAULT_DECISION_ARCHIVE_DAYS = 90` 상수와, `decisionRetention`/`decisionArchiveNotificationOutbox` 등 전용 DB 테이블을 사용하는 실제 아카이브 매니페스트 로직(`canonicalManifest`, 버전 기반 정합성 체크)이 존재한다.~~ *(위 정정 참고 — 이 항목의 근거로는 부적절함)*
- ~~이 서비스가 `decisions`, `approvals`, `issueApprovals`, `issueRecoveryActions`, `issueThreadInteractions`, `heartbeatRuns`, `issues`, `agents`를 참조 대상으로 다루는 것으로 보아(CONFIRMED, import 목록), **의사결정/승인/실행 이력에 대한 실제 보존(retention) 계층이 프로덕션에 존재**한다.~~ *(같은 이유로 이 항목의 근거로는 부적절함 — `decision-retention.ts` 자체는 실재하는 별개 기능이지만 이 Closure 항목의 증거는 아니다)*
- **정정된 근거**: `activity_log`(72개 파일에서 표준 감사 경로로 사용됨, CONFIRMED)와 `heartbeat_runs`/`heartbeat_run_events`(실행 이력/재시도 계보)가 이 항목의 실제 구현이다. **이 서비스가 Core Closure 체크리스트가 원래 의도한 "감사 로그/evidence 보존" 전체를 충족하는지에 대한 전용 검증 문서(Emergency Stop 사례처럼 명시적 PASS 판정을 내린 별도 문서)는 이번 감사(2026-09-07 최초 라운드) 시점에는 발견하지 못했으나, 그 공백은 이후 라운드에서 `audit-log-retention-contract.test.ts`(4/4 PASS, `CURRENT_IMPLEMENTATION_CHARACTERIZED`)로 부분적으로 메워졌다 — 단 이 결과는 "현재 구현의 특성 확인"이지 "계약 충분성의 최종 PASS 승인"이 아니므로 판정은 여전히 PARTIAL이다.**

**결론: 관련 코드는 실재하고 프로덕션 품질로 보이나, "이 항목이 Closure 기준을 충족한다"는 명시적 PASS 판정 문서는 아직 없다 — 이 항목만 Emergency Stop과 달리 "이미 검증된 문서가 있는데 로드맵에 반영 안 된 경우"가 아니라 "검증 자체가 진행 중이며 아직 최종 승인 문서가 없는 경우"로 보인다.**

---

## 5. 종합 판정표

| # | 체크리스트 항목 | Closure 판정 | 근거 등급 | 비고 |
|---|---|---|---|---|
| 1 | Gate C | **DONE** | CONFIRMED | retry8 최종 증거 PASS |
| 2 | Gate D | **IN PROGRESS** | CONFIRMED | v2 Observer `OBSERVING`, 24h/24스냅샷 미완료 |
| 3 | Emergency Stop | **DONE** | CONFIRMED | 별도 검증 문서 + 라이브 코드 재확인, 단 원본 체크리스트 문서 미갱신 |
| 4 | Audit log/evidence retention | **PARTIAL** | CONFIRMED(코드 존재) / INFERENCE(충분성) | 전용 PASS 검증 문서 부재 |

## 6. Core v0.1 Closure 선언 가능 여부

### `CLOSURE_NOT_READY`

Audit retention이 PARTIAL인 이상, "Gate D만 완료되면 Closure 가능"이라고 쓸 수 없다 — **남은 조건은 정확히 두 가지**이며 둘 다 충족되어야 한다:

1. **Gate D 완료** — 24시간 경과 및 24개 시간별 스냅샷 전부 PASS(§2).
2. **Audit retention 계약 충분성 검증** — 정정된 근거(`activity_log`+`heartbeat_runs`/`heartbeat_run_events`, §4 정정 참고)의 코드 존재(CONFIRMED)와 이후 라운드의 특성화 테스트(`CURRENT_IMPLEMENTATION_CHARACTERIZED`)만으로는 부족하며, Emergency Stop 사례(§3)와 동등한 수준의 **명시적 계약-충분성 PASS 승인**은 아직 CEO/Human이 내리지 않았다(§4, C-lite 설계 문서 `DESIGN_READY / NOT_IMPLEMENTED` 참고). **PARTIAL 판정을 유지한다.**

Emergency Stop 항목은 이미 별도 문서로 PASS가 검증되어 있어(§3) 이 두 조건에는 포함하지 않는다 — 남은 것은 체크리스트 문서 자체의 표기 갱신(Human 승인)뿐이며, 이는 Closure 실질 조건이 아니라 문서 정합성 조건이다.

## 7. CEO가 결정해야 할 항목
1. Emergency Stop 항목을 `claude-core-v0.1-boundary-audit.md`/`nexora-master-roadmap.md`에 공식 DONE으로 갱신할지.
2. Audit log/evidence retention 항목에 대해 Emergency Stop과 동일 수준의 전용 검증(테스트 작성·실행·PASS 문서화)을 별도로 요구할지, 아니면 현재 코드 존재만으로 충분하다고 판단할지.
3. Gate D 완료 후 Core v0.1 Closure를 공식 선언할지.

## 8. 이번 감사에서 수행하지 않은 것 (명시적 한계)
- Gate D Observer(v1 PID 7356/v2 PID 17652) 및 Supervisor/API/DB/Canary 프로세스에 대한 어떠한 조회·개입도 하지 않았다(요청된 금지사항 준수).
- `activity_log` 테이블 자체의 보존 정책 세부는 별도로 조사하지 않았다(UNVERIFIED로 남김).
- `docs/investigations/*gate-c*` 개별 문서 전체를 재독하지 않았다(파일 목록 존재만 재확인).
