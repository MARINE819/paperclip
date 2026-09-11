# NEXORA Git 편입 준비도 — COMMIT_CANDIDATE 파일별 정밀 분류 (READ-ONLY)

**작성일:** 2026-09-07
**단계:** READ-ONLY 조사·분류만. 파일 수정·삭제·이동 없음, `.gitignore` 수정 없음, `git add`/`commit`/`push`/`reset`/`checkout` 없음, 테스트/빌드/`db:generate`/migration 실행 없음. Gate D(PID 17652)·Supervisor/API/DB/Canary/Task Scheduler 조회·개입 없음(로컬 `git`/파일시스템 읽기 전용 조회만 수행).
**대상**: `reports/security/nexora-pre-git-secrets-and-artifact-audit-2026-09-07.md` §12 COMMIT_CANDIDATE manifest.

---

## 0. 이번 조사에서 발견한 가장 중요한 사실 (요약 먼저)

**현재 Git HEAD(`ffa16c5b6`)의 `server/src/routes/issues.ts`는 이미 커밋된 상태이며, 그 안에 `jarvis-completion-reconciler.js`, `jarvis-parent-report-action.js`, `jarvis-parent-completion-guard.js`, `jarvis-delegation-orchestrator.js`, `jarvis-parent-report-action-schema.js`, `jarvis-submit-request-schema.js`를 import하는 코드가 12곳 존재한다(CONFIRMED, `git show HEAD:server/src/routes/issues.ts`로 직접 확인). 그런데 이 import 대상 파일들은 전부 **현재 untracked 상태**다.** 즉 **이 저장소를 지금 이 순간 새로 clone하면 빌드가 즉시 실패한다** — 이것은 이번 계획이 만드는 위험이 아니라 **이미 존재하는 저장소 무결성 결함**이며, JARVIS 서비스 파일 편입은 "하면 좋은 정리"가 아니라 "깨진 HEAD를 고치는 긴급 조치"로 재분류해야 한다. 아래 §5에서 상세히 다룬다.

---

## 1. Supervisor 관련 그룹 (별도 분리)

| 경로 | 역할 | 상태 | 함께 커밋할 의존 파일 | 관련 테스트 | 테스트 증거 | 런타임 영향 | 권장 그룹 | 분류 |
|---|---|---|---|---|---|---|---|---|
| `scripts/operations/paperclip-control-plane-supervisor.mjs` | **Supervisor source** — 현재 PID 21488로 실제 실행 중인 프로덕션 코드 | untracked | 없음(독립 실행 파일) | 없음(전용 단위테스트 부재) | **활성화 증거 있음**: 파일 mtime `2026-09-06T13:03:57.5314432Z`(CONFIRMED, `Get-Item`), T0 SHA-256이 v2 Observer DryRun에서 `sha256Match:true`로 CONFIRMED, 명령줄(CommandLine)은 비관리자 세션 한계로 UNVERIFIED(이전 EBUSY 보고서 §8-A 그대로 인용) | **없음** — git add는 디스크의 현재 파일을 그대로 인덱스에 넣을 뿐, 실행 중인 프로세스나 API PID를 건드리지 않음(git은 파일시스템 메타데이터만 다룸) | 그룹 A(Supervisor) | READY_TO_COMMIT — 단, 반드시 "지금 add하려는 파일 = 지금 PID 21488이 실행 중인 그 파일"인지 SHA-256으로 재대조 후 진행(§9 순서 참고) |
| `scripts/operations/nexora-supervisor-diagnostics.cjs` | **diagnostics** — `supervisor-diagnostics.jsonl` 구조화 이벤트 로그 기록 모듈 | untracked | Supervisor source와 강하게 결합(같은 프로세스가 require) | 없음 | 없음(전용 실행 로그만 존재, 이전 세션에서 이미 인용) | 없음(위와 동일 이유) | 그룹 A | READY_TO_COMMIT(Supervisor source와 동일 커밋) |
| `scripts/operations/run-nexora-service.cmd` | **launcher** — Windows 서비스 기동 스크립트 | untracked | Supervisor source를 호출하는 대상이므로 논리적 의존, 파일 자체 의존은 없음 | 없음 | 없음 | 없음(서비스가 이미 등록/실행 중이며 스크립트 파일 자체를 커밋해도 재실행되지 않음) | 그룹 A | READY_TO_COMMIT |
| `scripts/operations/test-nexora-service-account.cmd` | 서비스 계정 테스트용 cmd | untracked | 없음 | 없음 | 없음 | 없음 | 그룹 A(부속) | NEEDS_CODE_REVIEW — 이름이 "test"이나 자동화 테스트가 아니라 수동 점검 스크립트로 보임, 내용 확인 없이 이번 라운드에서 성격만 추정 |
| `scripts/operations/gate-d-24h-observe.ps1` | **Gate C/D observer (v1)** | untracked | 없음(v2와 별개 파일) | 없음 | 이전 세션에서 v1 계약 결함 감사로 v2로 대체됨(v1 자체는 실사용 중단) | 없음 | 그룹 C(Gate C/D) | READY_TO_COMMIT(이력 보존 목적, 커밋 메시지에 "v1, superseded by v2" 명시 권장) |
| `scripts/operations/gate-d-24h-observe-v2.ps1` | **Gate C/D observer (v2, 현재 유효본)** | untracked | 없음 | 없음(PowerShell 스크립트, vitest 대상 아님) | **활성화 증거 있음**: 이번 세션에서 SHA-256 `9BC6633C...` 대조 CONFIRMED, `[Parser]::ParseFile` 구문검사 통과 CONFIRMED, 격리 DryRun 실행 CONFIRMED(비관리자 세션 한계로 3개 필드만 blank) | 없음(스크립트 자체는 커밋해도 실행 중인 Observer PID 17652에 영향 없음) | 그룹 C | READY_TO_COMMIT |
| `scripts/operations/nexora-backup-restore-fail-closed.ps1` | Gate C 백업/복구 fail-closed 정책 스크립트 | untracked | `nexora-backup-restore-js-engine.mjs`, `recovery-policy.mjs`와 논리적으로 한 세트 | 별도 vitest 없음(PowerShell) | 이전 세션 Gate C retry8 등에서 실행 증거 있음(간접 인용, 이번 라운드 재실행 없음) | 없음 | 그룹 C | READY_TO_COMMIT |
| `scripts/operations/nexora-backup-restore-js-engine.mjs` | Gate C 백업/복구 JS 엔진 | untracked | 위와 동일 세트 | 없음 | 위와 동일 | 없음 | 그룹 C | READY_TO_COMMIT |
| `scripts/operations/recovery-policy.mjs` | 복구 정책 모듈 | untracked | 위와 동일 세트 | 없음 | 위와 동일 | 없음 | 그룹 C | READY_TO_COMMIT |
| `docs/operations/nexora-supervisor-recovery-runbook-2026-09-07.md` | **recovery runbook** | untracked | 논리적으로 Supervisor source/diagnostics를 서술하지만 파일 의존은 없음(문서일 뿐) | 해당 없음 | 해당 없음(문서) | 없음 | 그룹 B(문서) | DOCUMENTATION_ONLY |
| `reports/operations/nexora-ebusy-incident-report-2026-09-07.md` | **incident report** — EBUSY 사고 타임라인+SHA-256/PID 활성화 증거 인용 | untracked | 없음 | 해당 없음 | 해당 없음(문서, 단 문서 안에 §8-A로 4종 증거 CONFIRMED/UNVERIFIED 구분 인용됨) | 없음 | 그룹 B | DOCUMENTATION_ONLY |

**그룹 A/C/B 결합 원칙**: Supervisor source+diagnostics+launcher(그룹 A)는 "지금 실행 중인 바로 그 코드"이므로 한 커밋으로 묶어 이력을 한 번에 연다. Gate C/D 스크립트(그룹 C)는 A와 별개 관심사(관찰 도구 vs 관찰 대상)이므로 분리 커밋. Runbook/incident report(그룹 B)는 코드가 아니라 문서이므로 또 분리 — 세 그룹을 한 커밋에 섞으면 "코드 변경"과 "운영 문서 추가"가 diff에서 뒤섞여 리뷰가 어려워진다.

## 2. Audit retention 관련 그룹 — DESIGN_READY와 IMPLEMENTED 명확히 분리

| 경로 | 역할 | 상태 | 의존 파일 | 관련 테스트 | 테스트 증거 | 런타임 영향 | 권장 그룹 | 분류 |
|---|---|---|---|---|---|---|---|---|
| `server/src/__tests__/audit-log-retention-contract.test.ts` | A안(현재 계약) 특성화 테스트 | untracked | 없음(embedded Postgres 자체 기동) | 자기 자신이 테스트 | **PASS 증거 있음**: 이번 세션에서 `pnpm exec vitest run` 1회 실행, 4 passed / 1 skipped 결과 직접 확인(CONFIRMED) | 없음(순수 테스트 파일, 프로덕션 코드 아님) | 그룹 D(Audit retention) | READY_TO_COMMIT — **IMPLEMENTED**(A안은 실행·검증까지 끝난 상태) |
| `reports/operations/audit-retention-contract-verification-plan-2026-09-07.md` | A안 계획 문서 | untracked | 없음 | 해당 없음 | 해당 없음 | 없음 | 그룹 D | DOCUMENTATION_ONLY |
| `reports/operations/audit-retention-contract-test-result-2026-09-07.md` | A안 실행 결과 보고서 | untracked | 위 계획 문서와 논리적 쌍 | 해당 없음 | 문서 자체가 테스트 증거를 인용 | 없음 | 그룹 D | DOCUMENTATION_ONLY |
| `reports/operations/core-v0.1-closure-prerequisite-audit-2026-09-07.md` | Core Closure 4항목 감사(Gate C/D/Emergency Stop/Audit retention) | untracked | 없음 | 해당 없음 | 해당 없음 | 없음 | 그룹 D | DOCUMENTATION_ONLY |
| `reports/operations/audit-retention-c-lite-implementation-plan-2026-09-07.md` | **C-lite 설계 문서** — `entity_deletion_evidence` 테이블·서비스 변경 설계 | untracked | 없음 | 해당 없음 | 해당 없음 | 없음 | 그룹 D | DOCUMENTATION_ONLY — **명시: 이 문서가 기술하는 `entity_deletion_evidence.ts`, `companies.ts`/`agents.ts`의 DELETE...RETURNING 변경 코드는 이 세션에서 단 한 줄도 작성되지 않았다. `DESIGN_READY`이지 `IMPLEMENTED`가 아니다.** |
| `reports/security/nexora-pre-git-secrets-and-artifact-audit-2026-09-07.md` | 비밀정보 감사 보고서(직전 라운드 산출물) | untracked | 없음 | 해당 없음 | 해당 없음 | 없음 | 그룹 D(문서) | DOCUMENTATION_ONLY |

**C-lite 관련 코드 파일은 이 manifest에 존재하지 않는다** — `packages/db/src/schema/entity_deletion_evidence.ts`, 그에 대응하는 마이그레이션, `companies.ts`/`agents.ts`의 수정본은 **아직 파일 자체가 생성되지 않았으므로** COMMIT_CANDIDATE 목록에도, 이 분류표에도 등장하지 않는다. C-lite는 오직 **설계 문서 1건**만 존재하며 `DESIGN_READY / NOT_IMPLEMENTED` 상태를 유지한다(사용자가 이전에 명시한 상태와 정확히 일치, 이번 조사로 재확인).

## 3. `.gitignore` 확인용 참고: `postgres18.zip`

**UNVERIFIED로 판정한다.** 근거:
- `packages/db/package.json`이 `embedded-postgres@^18.1.0-beta.16`를 `bundleDependencies`로 선언하고 있어(CONFIRMED), 파일명의 "18"이 이 패키지의 PostgreSQL 메이저 버전과 일치하는 것으로 **추정**할 수 있다.
- 그러나 `packages/db/src`, `server/src`, `scripts/` 전체를 검색한 결과 **`postgres18.zip`이라는 파일명을 코드에서 참조하는 곳이 없다**(CONFIRMED, 검색 결과 0건) — 즉 "이 파일이 없으면 어떤 스크립트가 자동으로 다시 받는다"는 코드 경로가 이번 조사에서는 발견되지 않았다.
- `packages/db/src/embedded-postgres-native.ts`(다운로드/캐시 로직이 있을 것으로 예상되는 파일)를 전체 확인한 결과, 이 파일은 **Linux 전용**(`if (process.platform !== "linux") return null`) 공유 라이브러리 심볼릭 링크 처리만 하며, Windows용 바이너리 압축 해제나 `postgres18.zip`과 무관하다(CONFIRMED).
- 따라서 이 zip이 "embedded Postgres 테스트 실행에 필요한 로컬 캐시"인지, 아니면 과거 어느 시점에 수동으로 내려받아 방치된 것인지는 **이번 READ-ONLY 조사로 확정할 수 없다 — UNVERIFIED**.
- **권장**: 삭제하지 않는다(지시대로). Git에서는 제외한다(§7). 실제로 필요한지 확인하려면 이 파일을 이름을 바꾸지 않고 그대로 둔 채 `pnpm exec vitest run <embedded-postgres 테스트>`를 한 번 실행해 성공 여부를 관찰해야 하는데, 이는 "테스트 실행 금지"라는 이번 라운드 제약과 충돌하므로 **다음 라운드 이후에만 확인 가능**.

## 4. JARVIS 관련 그룹 — 코드/문서 분리, "이미 HEAD가 참조 중" 위험 반영

### 4.1 코드 (전부 §0의 긴급 사유로 READY_TO_COMMIT 후보, 단 실행 검증은 이번 세션에서 재실행하지 않음 — NEEDS_TEST 성격 병기)

| 경로 | 역할 | 상태 | 의존 파일 | 관련 테스트 | 테스트 증거 | 분류 |
|---|---|---|---|---|---|---|
| `server/src/services/jarvis-delegation-orchestrator.ts` | `submitToJarvis` 등 위임 오케스트레이션 본체 | untracked | `issues.ts`(HEAD, tracked)가 이미 이 파일을 import — **역방향 의존**(issues.ts→이 파일) | `jarvis-delegation-orchestrator.test.ts` | **PASS 여부 미재실행**(이번 세션에서 vitest 실행 안 함, 존재만 CONFIRMED) | NEEDS_TEST(+ HEAD 무결성 긴급복구 사유로 최우선) |
| `server/src/services/jarvis-completion-reconciler.ts` | 위임 완료 상태 조정자 | untracked | 위와 동일(issues.ts가 import) | `jarvis-completion-reconciler.test.ts` | 미재실행 | NEEDS_TEST |
| `server/src/services/jarvis-parent-report-action.ts` | parent report 액션 처리 | untracked | issues.ts가 import | `jarvis-parent-report-action.test.ts` | 미재실행 | NEEDS_TEST |
| `server/src/services/jarvis-parent-completion-guard.ts` | 부모 자기완료 차단 가드(403 라이브 검증됨) | untracked | issues.ts가 import | `jarvis-parent-completion-guard.test.ts` | **라이브 UAT 증거 있음**(NEX-100 등, 이전 세션 문서 인용) + 단위테스트 미재실행 | NEEDS_TEST(단, 기능 자체는 라이브 검증됨) |
| `server/src/routes/jarvis-parent-report-action-schema.ts` | 요청 스키마 검증 | untracked | issues.ts가 import | 별도 테스트 파일 없음(스키마만) | 해당 없음 | NEEDS_TEST(간접 — jarvis-submit-routes.test.ts가 경유 검증) |
| `server/src/routes/jarvis-submit-request-schema.ts` | 요청 스키마 검증 | untracked | issues.ts가 import | 위와 동일 | 해당 없음 | NEEDS_TEST |
| `server/src/services/jarvis-delegation-plan.ts` | 위임 계획 검증 | untracked | 다른 jarvis 서비스와 함께 사용(직접 issues.ts import 여부 미확인) | `jarvis-delegation-plan.test.ts` | 미재실행 | NEEDS_TEST |
| `server/src/services/jarvis-delegation-limits.ts` | 위임 한도(깊이/자식 수) 정책 | untracked | 위와 동일 | `jarvis-delegation-limits.test.ts` | 미재실행 | NEEDS_TEST |
| `server/src/services/jarvis-agent-selector.ts` | 결정론적 agent 선정 | untracked | 위와 동일 | `jarvis-agent-selector.test.ts` | 미재실행 | NEEDS_TEST |
| `server/src/services/jarvis-agent-directory.ts` | agent 후보 조회 | untracked | 위와 동일 | `jarvis-agent-directory.test.ts` | 미재실행 | NEEDS_TEST |
| `server/src/services/jarvis-idempotency.ts` | intake 멱등성 키 처리 | untracked | 위와 동일 | `jarvis-idempotency.test.ts` | 미재실행 | NEEDS_TEST |
| `server/src/services/jarvis-evidence-acceptance.ts` | 증거 등록 검증 | untracked | 위와 동일 | `jarvis-evidence-acceptance.test.ts` | 미재실행 | NEEDS_TEST |
| `server/src/services/jarvis-parent-report-writer.ts` | 최종 보고서 작성 | untracked | 위와 동일 | `jarvis-parent-report-writer.test.ts` | 미재실행 | NEEDS_TEST |
| `server/src/services/jarvis-parent-report-projector.ts` | 보고서 프로젝션 | untracked | 위와 동일 | `jarvis-parent-report-projector.test.ts` | 미재실행 | NEEDS_TEST |
| `server/src/__tests__/jarvis-submit-routes.test.ts` | intake 라우트 통합 테스트 | untracked | 위 서비스 전부에 의존 | 자기 자신 | 미재실행 | NEEDS_TEST |
| `server/src/__tests__/jarvis-completion-reconciliation-routes.test.ts` | 완료 조정 라우트 통합 테스트 | untracked | 위와 동일 | 자기 자신 | 미재실행 | NEEDS_TEST |
| 각 `*.test.ts` 12개(위 표에 이미 개별 표기됨) | — | untracked | 대응 서비스 파일과 1:1 | — | — | NEEDS_TEST |

**중요한 재해석**: 통상적인 "테스트 증거 없음 → 신중하게 나중에 커밋"이라는 순서를 이 그룹에는 그대로 적용할 수 없다. §0에서 확인했듯 **이 파일들이 없으면 이미 커밋된 `issues.ts`가 깨진다.** 따라서 "NEEDS_TEST"라는 분류는 유지하되, **커밋 우선순위는 최상위**로 올린다(§9) — "검증 전이라 미룬다"가 아니라 "지금 당장 넣지 않으면 저장소가 이미 깨져 있다"는 뜻으로 읽어야 한다. 실제 vitest 재실행은 이번 라운드에서 금지되어 있으므로, 커밋 자체는 가능하나 **커밋 직후(별도 승인 후) 반드시 대상 지정 vitest 재실행으로 현재 통과 여부를 확인**해야 한다.

### 4.2 JARVIS 문서 (PROPOSED 표시 유지)

| 경로 | 역할 | 상태 | 분류 근거 |
|---|---|---|---|
| `doc/plans/nexora-jarvis-m2-qa-knowledge-governance-design-2026-09-07.md` | M1 CONFIRMED / M2 PROPOSED 구분 설계 문서(직전 라운드 산출물) | untracked | DOCUMENTATION_ONLY — 문서 자신이 이미 "M2 기능은 코드로 존재하지 않는다"고 PROPOSED로 명시함(재확인 완료, 혼동 없음) |

`docs/architecture/jarvis-delegation-loop-design.md`, `jarvis-delegation-loop-mvp-plan.md`는 이번 manifest(§12)에 포함되지 않았던 파일이나, JARVIS 그룹과 강하게 연관되므로 별도 승인 시 함께 검토 권장(이번 라운드에서 새로 추가하지 않음, 원 manifest 범위 유지).

## 5. Knowledge/Memory 관련 그룹 — 코드/문서 분리

| 경로 | 역할 | 상태 | 의존 파일 | 관련 테스트 | 테스트 증거 | 런타임 영향 | 분류 |
|---|---|---|---|---|---|---|---|
| `server/src/services/knowledge.ts` | Knowledge 핵심 서비스 | untracked | **`server/src/services/index.ts`(tracked, modified, +1줄)가 이미 이 파일을 export하도록 수정되어 있음** — 강한 순방향 의존 | `knowledge.test.ts` | 미재실행 | app.ts가 이미 `knowledgeRoutes(db)`를 등록 중(작업 트리 기준, 아직 미커밋) → **이 파일 없이 `services/index.ts`/`app.ts`만 커밋하면 즉시 빌드 깨짐** | NEEDS_DEPENDENCY(최우선, `services/index.ts`/`app.ts`와 원자적 동시 커밋 필수) |
| `server/src/routes/knowledge.ts` | Knowledge HTTP 라우트 | untracked | `app.ts`(tracked, modified)가 이미 `import { knowledgeRoutes } from "./routes/knowledge.js"` | `knowledge-routes.test.ts` | 미재실행 | 위와 동일 | NEEDS_DEPENDENCY |
| `packages/db/src/schema/knowledge_records.ts` | `knowledge_records` 테이블 정의 | untracked | `packages/db/src/schema/index.ts`(tracked, modified)가 이미 `export { knowledgeRecords }` | 전용 단위테스트 없음(스키마) | 마이그레이션 0232가 이 테이블 CREATE(§6에서 확인) | 위와 동일 | NEEDS_DEPENDENCY |
| `packages/db/src/schema/memory_operations.ts` | `memory_operations` 테이블 정의 | untracked | 위와 동일(`schema/index.ts`가 export) | 없음 | 위와 동일 | NEEDS_DEPENDENCY |
| `packages/shared/src/types/knowledge.ts` | 공유 타입 | untracked | `packages/shared/src/index.ts`(tracked, modified, +26줄)가 이미 이 타입들을 re-export | 없음(타입 전용) | 해당 없음 | NEEDS_DEPENDENCY |
| `packages/shared/src/validators/knowledge.ts` | 공유 zod 검증기 | untracked | 위와 동일 | `knowledge.test.ts`(validators) | 미재실행 | NEEDS_DEPENDENCY |
| `packages/shared/src/validators/knowledge.test.ts` | 검증기 테스트 | untracked | 위 validators와 1:1 | 자기 자신 | 미재실행 | NEEDS_TEST |
| `server/src/services/memory-candidate-extraction.ts` | 자동 후보 추출 로직 | untracked | **`app.ts`가 이미 `reconcileAutomaticMemoryOperationCandidates`를 import해 startup 스케줄러에 연결** | 전용 테스트 파일 미확인(다른 파일이 간접 커버 가능성) | 미확인 | NEEDS_DEPENDENCY |
| `server/src/services/memory-candidate-failure-cooldown.ts` | 실패 쿨다운 트래커 | untracked | `app.ts`가 `createFailureCooldownTracker` import | `memory-candidate-failure-cooldown.test.ts` | 미재실행 | NEEDS_DEPENDENCY |
| `server/src/services/memory-candidate-reconciler-config.ts` | 스케줄러 설정 해석 | untracked | `app.ts`가 `resolveMemoryCandidateReconcilerConfig` import | `memory-candidate-reconciler-config.test.ts` | 미재실행 | NEEDS_DEPENDENCY |
| `server/src/services/memory-candidate-reconciler-scheduler.ts` | 스케줄러 본체 | untracked | `app.ts`가 `createMemoryCandidateReconcilerScheduler` import | `memory-candidate-reconciler-scheduler.test.ts` | 미재실행 | NEEDS_DEPENDENCY |
| `server/src/services/knowledge-record-lock.ts` | 레코드 락 | untracked | knowledge.ts와 연관 추정(직접 import 여부 이번 라운드 미확인) | `knowledge-record-lock.test.ts` | 미재실행 | NEEDS_TEST |
| `server/src/services/obsidian-sync.ts` | Obsidian 동기화 | untracked | knowledge 그룹과 연관(정확한 import 그래프는 이번 라운드에서 전수 대조하지 않음) | 관련 테스트 2개(아래) | 미재실행 | NEEDS_CODE_REVIEW(의존 그래프 미확정) |
| `server/src/services/obsidian-vault-config.ts` | Obsidian vault 설정 | untracked | 위와 동일 | 없음 확인 | 미재실행 | NEEDS_CODE_REVIEW |
| `server/src/__tests__/knowledge.test.ts` | Knowledge 통합 테스트 | untracked | knowledge.ts, routes/knowledge.ts | 자기 자신 | 미재실행 | NEEDS_TEST |
| `server/src/__tests__/knowledge-routes.test.ts` | Knowledge 라우트 테스트 | untracked | 위와 동일 | 자기 자신 | 미재실행 | NEEDS_TEST |
| `server/src/__tests__/memory-candidate-extraction-routes.test.ts` | 후보 추출 라우트 테스트 | untracked | memory-candidate-extraction.ts | 자기 자신 | 미재실행 | NEEDS_TEST |
| `server/src/__tests__/memory-candidate-reconciler.test.ts` | 스케줄러 통합 테스트 | untracked | 스케줄러 그룹 | 자기 자신 | 미재실행 | NEEDS_TEST |
| `server/src/__tests__/memory-candidate-reconciler-uat.test.ts` | UAT 성격 테스트 | untracked | 위와 동일 | 자기 자신 | 미재실행 | NEEDS_TEST |
| `server/src/__tests__/obsidian-sync-routes.test.ts` | Obsidian 라우트 테스트 | untracked | obsidian-sync.ts | 자기 자신 | 미재실행 | NEEDS_TEST |
| `server/src/__tests__/obsidian-sync-concurrency.test.ts` | Obsidian 동시성 테스트 | untracked | 위와 동일 | 자기 자신 | 미재실행 | NEEDS_TEST |
| `server/src/services/effective-config.ts` | 회사별 유효 설정 해석(memory-candidate reconciler enable 플래그 등과 연관 추정) | untracked | 명확한 import 그래프 미대조 | `effective-config.test.ts` | 미재실행 | NEEDS_CODE_REVIEW |
| `server/src/services/system-guard.ts`, `system-guard-rules.ts` | 시스템 가드 규칙 | untracked | 서로 의존 | `system-guard.test.ts` | 미재실행 | NEEDS_CODE_REVIEW(역할 범위를 이번 라운드에서 코드 내부까지 읽지 않음) |

**중요**: `packages/db/src/migrations/0232_absurd_annihilus.sql` + `packages/db/src/migrations/meta/0232_snapshot.json`(§6에서 확인한 대로 `knowledge_records` CREATE TABLE 포함)는 `knowledge_records.ts`/`memory_operations.ts` 스키마 파일과 **원자적으로 함께 커밋해야** DB 마이그레이션과 Drizzle 스키마 정의가 어긋나지 않는다.

## 6. `doc/memory-candidate-extraction.md`, `doc/obsidian-knowledge-sync.md`

이 두 문서는 원래 §12 manifest에는 없었으나 `app.ts`의 새 주석이 `doc/memory-candidate-extraction.md`를 직접 인용하고 있어(CONFIRMED, diff 인용문 "see doc/memory-candidate-extraction.md") 함께 검토 대상임을 기록한다. untracked 상태. **DOCUMENTATION_ONLY**, memory-candidate 그룹과 함께 커밋 권장.

## 7. `.gitignore` 최소 후보 (좁은 정확한 경로만, 광범위 패턴 금지)

```
/postgres18.zip
/.tmp-uat/
/server/agents_out.json
/fix2.cjs
/fix_execute.cjs
/fix_heartbeat.py
/fix_heartbeat_script.js
/fix_mock_order.py
/fix_recover.cjs
/insert_risk.cjs
/insert_risk2.cjs
/patch.cjs
/patch.py
/recover.patch
/update_registry.js
/update_registry_testenv.cjs
/check-logs.ts
/check-paperclip-health.ps1
/test-adapter.ts
/GEMINI.md
/server/agents_out.json
/server/analyze_agents.ts
/server/capture-baseline.ts
/server/check-agent.ts
/server/check-db.ts
/server/check-issue-comments.ts
/server/check-logs.ts
/server/check-run-error.ts
/server/check-run-status.ts
/server/check-run-stdout.ts
/server/check-run.ts
/server/check_ids.ts
/server/check_restored_db.ts
/server/classify_agents.ts
/server/fallback-test.ts
/server/mock-codex.bat
/server/monitor-daemon.ts
/server/pilot-test.ts
/server/query.ts
/server/query2.ts
/server/real-runtime-test.ts
/server/run-3agent-canary-phase1.ts
/server/run-3agent-canary-phase2.ts
/server/run-3agent-canary-phase3.ts
/server/run-3agent-canary-phase4.ts
/server/run-jarvis-heartbeat.ts
/server/test_db.ts
/server/walkthrough.md
/server/scratch/
/packages/db/check_copy.ts
/packages/db/scratch-apply-conflict.ts
/server/src/services/heartbeat.ts.rej
```
(광범위 패턴인 `fix*`, `patch*`, `*_out.json`, `*.zip`은 제안하지 않는다 — 지시대로 이번 조사에서 실제로 확인된 개별 경로만 나열했다. `server/constitution-manager.ts`, `server/phase2-agent-org-assignment.ts`는 org 템플릿 정의 코드로 실제 가치가 있어 **이 목록에서 의도적으로 제외**했다 — Pilot 준비 문서(직전 라운드)에서 이미 실사용 근거로 인용됨.)

## 8. 남은 미분류/애매 항목

- `server/constitution-manager.ts`, `server/phase2-agent-org-assignment.ts`: 원 manifest(§12)에는 없었으나 이번 조사에서 실사용 근거(agent org 템플릿)로 재확인됨 — **NEEDS_CODE_REVIEW**로 추가 권고(운영 가치는 있으나 이번 manifest 승인 범위 밖이므로 별도 승인 필요).
- `packages/adapters/antigravity-local/*`(7개): 보안 통과, 기능 완성도 미검증 — **NEEDS_CODE_REVIEW** 유지(직전 라운드와 동일 판단).
- `docs/investigations/*.md`(148개): 보안 통과, 전부 **DOCUMENTATION_ONLY**이나 물량 문제로 이번 라운드 manifest·커밋 순서에는 포함하지 않는다(§9).
- `docs/investigations/evidence/**`: 전부 **GENERATED_EVIDENCE** — 코드 커밋과 분리해 별도 결정.

## 9. 추천 커밋 순서 (계획만, 미실행)

### 1) 운영 복구 문서
```
git commit -m "docs: add supervisor recovery runbook and EBUSY incident report"
docs/operations/nexora-supervisor-recovery-runbook-2026-09-07.md
reports/operations/nexora-ebusy-incident-report-2026-09-07.md
```

### 2) Supervisor 소스와 진단 (§1 그룹 A) — SHA-256 재대조 후
```
git commit -m "ops: bring production control-plane supervisor and diagnostics under version control"
scripts/operations/paperclip-control-plane-supervisor.mjs
scripts/operations/nexora-supervisor-diagnostics.cjs
scripts/operations/run-nexora-service.cmd
```

### 3) Gate C/D 검증 도구 (§1 그룹 C)
```
git commit -m "ops: add Gate C/D observer and backup-restore verification scripts"
scripts/operations/gate-d-24h-observe.ps1
scripts/operations/gate-d-24h-observe-v2.ps1
scripts/operations/nexora-backup-restore-fail-closed.ps1
scripts/operations/nexora-backup-restore-js-engine.mjs
scripts/operations/recovery-policy.mjs
```

### 4) JARVIS 코드 전체 (§0의 긴급 HEAD 정합성 복구 — 가능한 한 이른 순번 권장, 실제로는 2)/3)보다 먼저 진행해도 무방)
```
git commit -m "fix: restore missing JARVIS delegation-loop service modules referenced by already-committed issues.ts"
server/src/services/jarvis-delegation-plan.ts (+.test.ts)
server/src/services/jarvis-delegation-limits.ts (+.test.ts)
server/src/services/jarvis-agent-selector.ts (+.test.ts)
server/src/services/jarvis-agent-directory.ts (+.test.ts)
server/src/services/jarvis-idempotency.ts (+.test.ts)
server/src/services/jarvis-evidence-acceptance.ts (+.test.ts)
server/src/services/jarvis-completion-reconciler.ts (+.test.ts)
server/src/services/jarvis-parent-report-writer.ts (+.test.ts)
server/src/services/jarvis-parent-report-projector.ts (+.test.ts)
server/src/services/jarvis-parent-report-action.ts (+.test.ts)
server/src/services/jarvis-parent-completion-guard.ts (+.test.ts)
server/src/services/jarvis-delegation-orchestrator.ts (+.test.ts)
server/src/routes/jarvis-submit-request-schema.ts
server/src/routes/jarvis-parent-report-action-schema.ts
server/src/__tests__/jarvis-submit-routes.test.ts
server/src/__tests__/jarvis-completion-reconciliation-routes.test.ts
```
**커밋 메시지를 "fix:"로 둔 이유**: 이것은 신규 기능 추가가 아니라 이미 깨진 채로 커밋되어 있는 `issues.ts`(HEAD)를 다시 유효하게 만드는 정정 커밋이다.

### 5) Audit retention 현재 완료분 (A안만, C-lite 제외)
```
git commit -m "test: add audit log retention contract characterization tests (Policy A, 4/4 passing)"
server/src/__tests__/audit-log-retention-contract.test.ts

git commit -m "docs: add audit retention verification plan, test result, and Core v0.1 closure prerequisite audit"
reports/operations/audit-retention-contract-verification-plan-2026-09-07.md
reports/operations/audit-retention-contract-test-result-2026-09-07.md
reports/operations/core-v0.1-closure-prerequisite-audit-2026-09-07.md
reports/operations/audit-retention-c-lite-implementation-plan-2026-09-07.md
reports/security/nexora-pre-git-secrets-and-artifact-audit-2026-09-07.md
```

### 6) JARVIS/Knowledge 독립 기능(Knowledge/Memory, `app.ts`/`services/index.ts`/`shared/index.ts`/`schema/index.ts`의 기존 수정분과 원자적 동시 커밋 필수)
```
git commit -m "feat: add Knowledge Layer and Memory Candidate extraction services, wire into app bootstrap"
server/src/app.ts                              (기존 수정분)
server/src/services/index.ts                   (기존 수정분)
packages/shared/src/index.ts                   (기존 수정분)
packages/db/src/schema/index.ts                (기존 수정분)
packages/db/src/migrations/0232_absurd_annihilus.sql
packages/db/src/migrations/meta/0232_snapshot.json
packages/db/src/migrations/meta/_journal.json  (기존 수정분, 0232 append 확인 후)
packages/db/src/schema/knowledge_records.ts
packages/db/src/schema/memory_operations.ts
packages/shared/src/types/knowledge.ts
packages/shared/src/validators/knowledge.ts (+.test.ts)
server/src/services/knowledge.ts (+.test.ts)
server/src/routes/knowledge.ts
server/src/services/memory-candidate-extraction.ts
server/src/services/memory-candidate-failure-cooldown.ts (+.test.ts)
server/src/services/memory-candidate-reconciler-config.ts (+.test.ts)
server/src/services/memory-candidate-reconciler-scheduler.ts (+.test.ts)
server/src/services/knowledge-record-lock.ts (+.test.ts)
server/src/services/obsidian-sync.ts
server/src/services/obsidian-vault-config.ts
server/src/__tests__/knowledge.test.ts
server/src/__tests__/knowledge-routes.test.ts
server/src/__tests__/memory-candidate-extraction-routes.test.ts
server/src/__tests__/memory-candidate-reconciler.test.ts
server/src/__tests__/memory-candidate-reconciler-uat.test.ts
server/src/__tests__/obsidian-sync-routes.test.ts
server/src/__tests__/obsidian-sync-concurrency.test.ts
doc/memory-candidate-extraction.md
doc/obsidian-knowledge-sync.md
```
**하나라도 빠지면 안 되는 이유**: `app.ts`/`services/index.ts`/`shared/index.ts`/`schema/index.ts`는 이미 이 파일들을 import하도록 수정돼 있다(§0과 동일한 성격의 위험, 다만 아직 HEAD에는 안 들어갔으므로 "지금 당장 급함"은 아니고 "이 커밋 하나에서 빠뜨리면 안 됨"의 문제).

### 7) 로드맵/계획 문서
```
git commit -m "docs: add roadmap status, JARVIS M2 design notes, and first pilot readiness plan"
reports/planning/nexora-master-roadmap-current-state-2026-09-07.md
reports/planning/nexora-first-business-pilot-readiness-plan-2026-09-07.md
doc/plans/nexora-jarvis-m2-qa-knowledge-governance-design-2026-09-07.md
```

**이번 라운드 이후 남는 것**: `packages/adapters/antigravity-local/*`(기능검토 필요), `server/constitution-manager.ts`/`phase2-agent-org-assignment.ts`(별도 승인 필요), `docs/investigations/*.md` 148개(큐레이션 결정 필요), `docs/investigations/evidence/**`(증거 보존 정책 결정 필요), `.gitignore` 자체 수정(§7, 실제 파일 수정 승인 필요), `postgres18.zip` 실제 필요성 확인(테스트 실행 승인 필요) — **전부 이번 승인 범위 밖으로 명시적으로 남겨둔다.**

---

## 10. 요약

가장 중요한 발견은 **현재 Git HEAD에 이미 커밋된 `issues.ts`가 존재하지 않는(untracked) JARVIS 서비스 파일들을 import하고 있어, 지금 이 저장소를 새로 clone하면 빌드가 깨진다**는 것이다. 이 때문에 JARVIS 코드 그룹의 커밋 우선순위는 "테스트 증거 없음"에도 불구하고 최상위로 올렸다(§9-4). Audit retention은 A안(테스트+보고서, IMPLEMENTED)과 C-lite(설계 문서 1건만 존재, DESIGN_READY/NOT_IMPLEMENTED)를 명확히 분리했고, Knowledge/Memory 그룹은 4개 tracked 파일(`app.ts` 등)의 기존 수정분과 원자적으로 묶어야 하는 강한 의존관계를 확인했다. `postgres18.zip`의 실제 필요성은 코드에서 참조를 찾지 못해 **UNVERIFIED**로 남겼다. 이번 라운드에서는 어떤 파일도 add/commit하지 않았다.
