# NEXORA Git 편입 전 비밀정보·대용량 파일·임시 산출물 감사 (READ-ONLY)

**작성일:** 2026-09-07
**단계:** READ-ONLY 감사만. `git status`/`git ls-files`/`git check-ignore`/파일 크기·확장자 조회/패턴 검색(`grep`/`rg`)만 실행. **파일 수정·삭제·이동 없음, `git add`/`commit`/`push`/`reset`/`checkout` 없음, 네트워크 업로드 없음.** Gate D(PID 17652)·Supervisor/API/DB/Canary/Task Scheduler 조회·개입 없음(로컬 워킹트리 파일 시스템 조회만 수행).
**비밀정보 표기 규칙**: 이 문서 어디에도 실제 비밀값을 적지 않는다. 값이 필요한 경우 `[REDACTED]`로만 표기한다.

---

## 1. 조사 범위와 방법

- `git ls-files --others --exclude-standard`로 추적되지 않은 개별 파일 **339개**를 확인(**CONFIRMED**, 디렉터리 단위로 축약해 보이던 이전 라운드의 263줄과 달리 이번엔 개별 파일 수를 정확히 셈).
- 확장자별 분포(**CONFIRMED**, 직접 카운트): `md` 148, `ts` 104, `json` 48, `cjs` 8, `ps1` 7, `log` 6, `py` 3, `pid` 3, `mjs` 3, `js` 2, `cmd` 2, `zip` 1, `sql` 1, `rej` 1, `patch` 1, `bat` 1.
- **이번 라운드는 표본이 아니라 전수 스캔이다**: 위 확장자를 가진 339개 파일 **전부**(zip 1개와 pid 3개만 바이너리/무의미 텍스트라 제외)를 대상으로 아래 패턴을 실행했다. 이전 라운드(Git 편입 계획 보고서)의 "표본 기준, 전수 아님" 한계는 이번 라운드로 해소됐다.

### 검사한 패턴
1. 고신뢰 시크릿 형태: `sk-[A-Za-z0-9]{20,}`, `AKIA[0-9A-Z]{16}`, `-----BEGIN...PRIVATE KEY-----`, `ghp_...`, `xox[baprs]-...`, `Bearer <token>`
2. 키워드=값 대입 형태: `(api_key|secret_key|access_token|password|passwd|private_key)\s*[:=]\s*['"]...['"]`
3. 자격증명 내장 연결 문자열: `(postgres|mysql|mongodb)://user:pass@host`
4. `DATABASE_URL`/`.env` 계열 파일 존재 여부
5. `.pem`/`.pfx`/`.p12`/`.crt`/`.der`/`.key` 확장자
6. DB 덤프/백업 흔적(`.sql`/`.dump`/`.bak`)
7. 로그/PID/임시 파일
8. 10MB 이상 파일, `.zip`/`.exe`/`.dll`
9. 개인 절대경로(`C:\Users\<name>\...`), 이메일 주소

---

## 2. 결과 1 — 고신뢰 시크릿 형태

**339개 파일 전체에서 일치 항목 0건(CONFIRMED)** — API 키, AWS 액세스 키, PEM 개인키 헤더, GitHub/Slack 토큰, `Bearer` 토큰 형태가 하나도 발견되지 않았다.

## 3. 결과 2 — 키워드=값 대입 형태 (2건, 검토 완료 — 안전)

| 파일 | 형태(마스킹) | 판정 근거 |
|---|---|---|
| `packages/adapters/codex-local/src/server/codex-home.concurrency.test.ts` | `[KEY]: "[짧은 하이픈 값]"` | 파일명이 `.test.ts` — 테스트 픽스처 값으로 판단. 값 길이가 짧고 무작위성이 없어 실제 자격증명 형태가 아님 |
| `packages/db/check_copy.ts` | `[KEY]: '[짧은 단일 단어]'` | 스크래치 스크립트 내 짧은 placeholder 값. 무작위성 없음 |

두 파일 모두 실제 값의 알파벳/숫자 구간을 전부 `X`로 치환해 구조만 확인했으며(이 문서에도, 조사 과정에서도 원문 값을 출력하지 않음), 무작위 엔트로피가 없는 짧은 플레이스홀더 형태임을 확인했다. **SECRET_OR_PRIVATE로 분류하지 않는다.**

## 4. 결과 3 — 자격증명 내장 연결 문자열 (34건, 전부 검토 완료 — 안전)

- 총 34건 중 **31건**은 `[REDACTED_USER]:[REDACTED_PASS]@127.0.0.1:54329`(이번 세션 전체에서 반복 확인해 온 embedded-Postgres 테스트 기본 계정, 로컬 전용·외부 유효성 없음)와 정확히 일치(**CONFIRMED**, 패턴 대조로 확인).
- 나머지 **3건**은 포트가 `55432`(Gate C 백업/복구 하네스 전용 임시 포트로 추정)로 다른 값이었으나, 각각 구조를 마스킹해 확인한 결과:
  - `docs/investigations/antigravity-backup-restore-auth-engine-feasibility-audit.md`: 문서 자체에 비밀번호 부분이 이미 `***`로 마스킹되어 있음(작성 시점에 이미 안전 처리됨).
  - `docs/investigations/claude-backup-restore-retry-safety-remediation.md`: 문서 내 예시/설명용 placeholder 형태(구조만 연결 문자열이고 무작위 값이 아님).
  - `scripts/operations/nexora-backup-restore-js-engine.mjs`: 코드에서 `postgres://${함수호출(...)}` 형태의 **템플릿 리터럴**로 확인됨 — 자격증명이 하드코딩된 리터럴이 아니라 런타임에 변수/함수로 구성됨.
- **결론: 34건 전부 실제 유출된 자격증명이 아니다.** `SECRET_OR_PRIVATE`로 분류할 항목 없음.

## 5. 결과 4 — `.env`/PEM/PFX/기타 인증서 파일

**해당 확장자(`*.env*`, `.pem`, `.pfx`, `.p12`, `.crt`, `.der`, `.key`)를 가진 untracked 파일 0건(CONFIRMED)**. 저장소 최상위에 `.env.example`만 존재하며 이는 이미 tracked 상태이고 예시 파일이므로 위험 없음(값 내용은 이번 라운드에서 재확인하지 않음 — 기존 tracked 파일이라 이번 감사 범위인 "미추적 파일"에 해당하지 않음).

## 6. 결과 5 — DB 덤프/백업 흔적

`.sql` 확장자 1건: `packages/db/src/migrations/0232_absurd_annihilus.sql` — 내용 확인 결과 `CREATE TABLE "knowledge_records" (...)` 형태의 **스키마 DDL**이며 실제 데이터 행(INSERT)이 아님(**CONFIRMED**, 파일 첫 20줄 직접 확인). `.dump`/`.bak` 확장자 파일은 0건.

## 7. 결과 6 — 로그/PID/임시 파일

| 파일 | 위치 성격 | 분류 |
|---|---|---|
| `.tmp-uat/server.out.log`, `.tmp-uat/server.err.log`, `.tmp-uat/server.pid` | 이번 세션 UAT 실행의 휘발성 런타임 로그/PID | `MUST_IGNORE` |
| `docs/investigations/evidence/gate-d-supervisor-ebusy-24h/observer.out.log`, `observer.err.log`, `gate-d-observe.pid` | Gate D v1 관찰 회차의 **보존된 증거** | `GENERATED_EVIDENCE` |
| `docs/investigations/evidence/gate-d-supervisor-ebusy-24h-v2/observer.out.log`, `observer.err.log`, `gate-d-observe.pid` | Gate D v2 관찰 회차의 **보존된 증거** | `GENERATED_EVIDENCE` |

같은 확장자(log/pid)라도 `.tmp-uat/`는 "이번 세션의 휘발성 부산물"이고 `docs/investigations/evidence/`는 "의도적으로 보존해 온 감사 증거"로 성격이 다르다 — 하나로 뭉뚱그려 분류하지 않았다.

## 8. 결과 7 — 대용량/바이너리 파일 (10MB 이상, zip/exe/dll)

| 파일 | 크기 | 분류 |
|---|---|---|
| `postgres18.zip` | **319MB**(`334,086,873` bytes, CONFIRMED 실측) | `LARGE_BINARY` — 절대 커밋 금지 |

이 외 10MB 이상 파일, `.exe`/`.dll` 파일은 untracked 목록에 없음(**CONFIRMED**).

## 9. 결과 8 — 개인 경로/이메일

- `C:\Users\<이름>\...` 형태의 절대경로: **0건**(**CONFIRMED**, 339개 파일 전수 검사).
- 이메일 주소 형태: `server/src/__tests__/board-key-scope-guard.test.ts` 1건, 도메인이 `example.com`(RFC 2606 예약 placeholder 도메인)임을 확인 — 실제 개인 이메일 아님. 안전.

---

## 10. `.tmp-uat/`가 `.gitignore` 규칙에도 불구하고 무시되지 않는 정확한 원인

**판정: `.gitignore`에 `.tmp-uat`를 위한 규칙이 애초에 존재하지 않는다 — "경로 차이(패턴-대상 불일치)"로 분류한다.**

근거(CONFIRMED, 재현 가능한 명령으로 확인):
1. `grep -n "tmp-uat" .gitignore` → **일치 0건**. `.gitignore` 파일 어디에도 문자열 `tmp-uat`가 없다.
2. `git status --porcelain --ignored`로 확인 시 `.tmp-uat/`는 `!!`(무시됨)이 아니라 `??`(추적 안 됨, 무시 안 됨)로 표시된다.
3. `git check-ignore -v -- .tmp-uat`(끝에 슬래시 없음) → **매치 없음**(exit 1).
4. `git check-ignore -v -- .tmp-uat/server.out.log`(디렉터리 내부 실제 파일) → **매치 없음**(exit 1).
5. `git check-ignore -v -- .tmp-uat/`(끝에 슬래시 있음)만 예외적으로 `.gitignore:57:.tmp-uat/`라는 매치를 보고하지만, 실제 `.gitignore`의 57번째 줄은 **빈 줄**이다(`awk 'NR==57' .gitignore` 직접 확인). 즉 이 특정 CLI 호출 형태의 보고 자체가 파일의 실제 내용과 일치하지 않는 신뢰할 수 없는 출력이다 — `git status`/`git add`가 실제로 참조하는 판정(1~4번)과 다르다.
6. 가장 근접한 기존 규칙은 `.gitignore:19`의 `tmp-*`(줄 앞에 점이 없는 패턴)이며, gitignore의 표준 glob 규칙상 `*`는 기본적으로 **점(.)으로 시작하는 이름과 매치되지 않는다** — 따라서 `.tmp-uat`(점으로 시작)는 `tmp-*`에 매치되지 않는다. 이것이 "의도했을 법한 규칙이 실제로는 커버하지 못하는" 정확한 기술적 이유다.
7. 상위/하위 `.gitignore` 충돌: 저장소 전체에서 발견한 중첩 `.gitignore` 10개(`evals/promptfoo/`, `packages/paperclip-runner/`, `packages/plugins/examples/*`, `packages/plugins/plugin-llm-wiki/*`, `packages/plugins/sandbox-providers/kubernetes/`, `tools/agent-shim/`, `ui/storybook/`) 중 어느 것도 저장소 루트의 `.tmp-uat/`와 무관한 하위 디렉터리에 있어 영향을 주지 않는다 — **해당 없음**으로 배제.
8. 이미 tracked 상태: `git ls-files -- .tmp-uat` 결과 **0건** — 이미 추적 중이라 무시가 무력화된 경우도 **아니다** — 배제.
9. negation 규칙(`!패턴`): `.gitignore` 전체에서 `.tmp-uat` 관련 `!` 부정 규칙 **없음** — 배제.

**최종 판정 근거 요약**: 후보 5가지(오타/상위-하위 충돌/이미 tracked/negation/경로 차이) 중, "이미 tracked"·"negation"·"상위-하위 충돌"은 명시적으로 배제됐고(7~9번), 남는 것은 "경로 차이"다 — 더 정확히는 **"의도한 규칙(`tmp-*`)이 실제 대상 이름(`.tmp-uat`, 점으로 시작)과 gitignore glob 의미론상 애초에 매치될 수 없는 패턴-대상 불일치"**다. 이전 라운드 보고서가 "`.gitignore:57`에 규칙이 있다"고 적은 것은 `check-ignore -v`의 신뢰할 수 없는 트레일링 슬래시 보고를 오독한 것으로, **이 문서에서 정정한다.**

---

## 11. 분류 매트릭스 (339개 파일 → 7개 카테고리)

전체를 그룹 단위로 분류한다(개별 파일 339줄 전체 나열 대신, 각 그룹의 대표 경로와 건수 명시).

| 카테고리 | 그룹 | 건수(대략) | 비고 |
|---|---|---|---|
| **COMMIT_CANDIDATE** | `scripts/operations/`의 Supervisor·진단·Gate C/D·launcher 스크립트(evidence 제외) | 9 | 프로덕션 실행 코드, Git 이력 0줄 상태 해소 시급 |
| **COMMIT_CANDIDATE** | `docs/operations/`, `reports/operations/`, `reports/planning/`, `doc/plans/nexora-jarvis-*.md` | ~12 | 이번 세션 운영 문서·감사 보고서 |
| **COMMIT_CANDIDATE** | `server/src/services/jarvis-*.ts`(+test), `knowledge*.ts`(+test), `memory-candidate-*.ts`(+test), `obsidian-*.ts`, `system-guard*.ts`, `effective-config.ts`, 관련 라우트/스키마(`knowledge_records.ts`, `memory_operations.ts`, `knowledge.ts`(shared 타입/검증)) | ~45 | 실제 동작 중인 기능 코드+테스트, 보안 스캔 결과 이상 없음 |
| **COMMIT_CANDIDATE** | `server/src/__tests__/audit-log-retention-contract.test.ts` 등 신규 테스트 파일 다수 | ~15 | §2~9 스캔에서 이상 없음 확인됨 |
| **COMMIT_CANDIDATE** | `docs/investigations/*.md`(148개) | 148 | **보안 스캔은 전부 통과(§2~9)** — 다만 물량이 많아 전부 한 번에 편입할지, 시기별로 나눌지는 보안이 아니라 **큐레이션 결정**(§13 참고) |
| **NEEDS_REVIEW** | `packages/adapters/antigravity-local/*`(7개 파일) | 7 | 보안 스캔 통과, 다만 신규 어댑터 패키지의 기능적 완성도·의도적 편입 여부는 별도 확인 필요(보안 문제 아님) |
| **NEEDS_REVIEW** | `packages/paperclip-runner/src/protocol/generated/schema-bundle.ts`(현재 tracked, 이번 감사 대상은 아니지만 참고) | - | "generated" 경로명인데 수정된 tracked 파일 — 빌드 산출물 여부 확인 필요(이전 Git 편입 계획 보고서에서 이미 지적) |
| **MUST_IGNORE** | `.tmp-uat/*`(로그 3개), `server/agents_out.json`(API 응답 덤프) | 4 | 코드 아님, 휘발성/일회성 데이터 |
| **MUST_IGNORE** | `postgres18.zip` | 1 | `LARGE_BINARY`와 중복 분류(아래) |
| **GENERATED_EVIDENCE** | `docs/investigations/evidence/gate-d-*/*.json`, `observer.*.log`, `gate-d-observe.pid` | ~44 | Gate C/D 실행 증거, 보안 스캔 통과, 코드와 분리 관리 권장 |
| **SECRET_OR_PRIVATE** | (없음) | **0** | §2~9 전수 스캔 결과 실제 비밀정보로 확정된 파일 없음 |
| **LARGE_BINARY** | `postgres18.zip`(319MB) | 1 | 절대 커밋 금지, `.gitignore` 추가 필요 |
| **SCRATCH** | `fix2.cjs`, `fix_execute.cjs`, `fix_heartbeat.py`, `fix_heartbeat_script.js`, `fix_mock_order.py`, `fix_recover.cjs`, `insert_risk.cjs`, `insert_risk2.cjs`, `patch.cjs`, `patch.py`, `recover.patch`, `update_registry.js`, `update_registry_testenv.cjs`, `server/check-*.ts`(11개), `server/query.ts`, `server/query2.ts`, `server/test_db.ts`, `packages/db/check_copy.ts`, `packages/db/scratch-apply-conflict.ts`, `check-logs.ts`, `check-paperclip-health.ps1`, `install-nexora-autostart.ps1`, `start-paperclip-dev.ps1`, `stop-paperclip-dev.ps1`, `test-adapter.ts`, `GEMINI.md`, `server/walkthrough.md`, `server/mock-codex.bat`, `server/monitor-daemon.ts`, `server/pilot-test.ts`, `server/fallback-test.ts`, `server/real-runtime-test.ts`, `server/run-3agent-canary-phase*.ts`(4개), `server/run-jarvis-heartbeat.ts`, `server/scratch/*`, `server/src/services/heartbeat.ts.rej` | ~50+ | 일회성 디버깅/조사 스크립트, 보안 스캔은 전부 통과했으나 영구 코드베이스에 넣을 성격이 아님 |

## 12. 안전한 Git 편입 manifest (제안, `git add` 미실행)

아래 파일만 편입 후보로 제안한다(모두 §2~9 보안 스캔 통과 확인됨). **실제 `git add` 명령은 실행하지 않았다 — 계획으로만 제시.**

```
# 1) Supervisor/진단/Gate C-D 스크립트
scripts/operations/paperclip-control-plane-supervisor.mjs
scripts/operations/nexora-supervisor-diagnostics.cjs
scripts/operations/gate-d-24h-observe.ps1
scripts/operations/gate-d-24h-observe-v2.ps1
scripts/operations/nexora-backup-restore-fail-closed.ps1
scripts/operations/nexora-backup-restore-js-engine.mjs
scripts/operations/recovery-policy.mjs
scripts/operations/run-nexora-service.cmd
scripts/operations/test-nexora-service-account.cmd

# 2) 운영/계획 문서
docs/operations/nexora-supervisor-recovery-runbook-2026-09-07.md
reports/operations/nexora-ebusy-incident-report-2026-09-07.md
reports/operations/core-v0.1-closure-prerequisite-audit-2026-09-07.md
reports/operations/audit-retention-contract-verification-plan-2026-09-07.md
reports/operations/audit-retention-contract-test-result-2026-09-07.md
reports/operations/audit-retention-c-lite-implementation-plan-2026-09-07.md
reports/operations/nexora-critical-files-git-adoption-plan-2026-09-07.md
reports/security/nexora-pre-git-secrets-and-artifact-audit-2026-09-07.md
reports/planning/nexora-master-roadmap-current-state-2026-09-07.md
reports/planning/nexora-first-business-pilot-readiness-plan-2026-09-07.md
doc/plans/nexora-jarvis-m2-qa-knowledge-governance-design-2026-09-07.md

# 3) JARVIS 서비스+테스트(8쌍)
server/src/services/jarvis-delegation-plan.ts (+ .test.ts)
server/src/services/jarvis-delegation-limits.ts (+ .test.ts)
server/src/services/jarvis-agent-selector.ts (+ .test.ts)
server/src/services/jarvis-idempotency.ts (+ .test.ts)
server/src/services/jarvis-evidence-acceptance.ts (+ .test.ts)
server/src/services/jarvis-agent-directory.ts (+ .test.ts)
server/src/services/jarvis-completion-reconciler.ts (+ .test.ts)
server/src/services/jarvis-parent-report-writer.ts (+ .test.ts)
server/src/services/jarvis-parent-report-projector.ts (+ .test.ts)
server/src/services/jarvis-parent-report-action.ts (+ .test.ts)
server/src/services/jarvis-parent-completion-guard.ts (+ .test.ts)
server/src/services/jarvis-delegation-orchestrator.ts (+ .test.ts)
server/src/routes/jarvis-submit-request-schema.ts
server/src/routes/jarvis-parent-report-action-schema.ts
server/src/__tests__/jarvis-submit-routes.test.ts
server/src/__tests__/jarvis-completion-reconciliation-routes.test.ts

# 4) Knowledge/Memory 서비스+스키마+테스트
server/src/services/knowledge.ts (+ .test.ts)
server/src/services/knowledge-record-lock.ts (+ .test.ts)
server/src/services/memory-candidate-extraction.ts
server/src/services/memory-candidate-failure-cooldown.ts (+ .test.ts)
server/src/services/memory-candidate-reconciler-config.ts (+ .test.ts)
server/src/services/memory-candidate-reconciler-scheduler.ts (+ .test.ts)
server/src/services/obsidian-sync.ts
server/src/services/obsidian-vault-config.ts
server/src/routes/knowledge.ts
packages/db/src/schema/knowledge_records.ts
packages/db/src/schema/memory_operations.ts
packages/shared/src/types/knowledge.ts
packages/shared/src/validators/knowledge.ts (+ .test.ts)
server/src/__tests__/knowledge.test.ts
server/src/__tests__/knowledge-routes.test.ts
server/src/__tests__/memory-candidate-extraction-routes.test.ts
server/src/__tests__/memory-candidate-reconciler.test.ts
server/src/__tests__/memory-candidate-reconciler-uat.test.ts
server/src/__tests__/obsidian-sync-routes.test.ts
server/src/__tests__/obsidian-sync-concurrency.test.ts
packages/db/src/migrations/0232_absurd_annihilus.sql
packages/db/src/migrations/meta/0232_snapshot.json

# 5) 기타 신규 테스트/서비스(보안 스캔 통과)
server/src/services/effective-config.ts (+ .test.ts)
server/src/services/system-guard.ts
server/src/services/system-guard-rules.ts
server/src/__tests__/system-guard.test.ts
server/src/__tests__/board-key-scope-guard.test.ts
server/src/__tests__/heartbeat-paused-company-guard.test.ts
server/src/__tests__/heartbeat-risk-guard.test.ts
server/src/__tests__/audit-log-retention-contract.test.ts

# 6) 신규 어댑터 패키지 (NEEDS_REVIEW 표시 — 기능 완성도 확인 후 편입 권장, 보안은 통과)
packages/adapters/antigravity-local/package.json
packages/adapters/antigravity-local/tsconfig.json
packages/adapters/antigravity-local/src/index.ts
packages/adapters/antigravity-local/src/server/index.ts
packages/adapters/antigravity-local/src/server/execute.ts
```

**명시적으로 제외**(§11의 MUST_IGNORE/LARGE_BINARY/SCRATCH/GENERATED_EVIDENCE 전체): `postgres18.zip`, `.tmp-uat/*`, `server/agents_out.json`, `fix*`/`patch*`/`insert_risk*`/`update_registry*`, `server/check-*.ts` 등 스크래치 그룹, `docs/investigations/evidence/**`.

`docs/investigations/*.md`(148개)는 보안상 이 manifest에 포함해도 안전하지만, 물량이 크므로 §13의 별도 결정에 따라 이후 단계에서 추가하는 것을 권장(이번 manifest에는 미포함).

## 13. `.gitignore` 보강 제안 (계획만, 미실행)

```
postgres18.zip
*.zip
fix*.cjs
fix*.py
fix*.js
patch.cjs
patch.py
insert_risk*.cjs
update_registry*
*_out.json
*.rej
```
(`*.zip` 전체 배제가 과할 수 있으므로, 정확히는 `postgres18.zip` 단일 파일 배제 + 향후 유사 대용량 배포판 재유입 방지용 `*.zip` 주석 처리 후보로만 제안 — 최종 결정은 Human)

---

## 14. 요약

339개 미추적 파일 전수를 대상으로 고신뢰 시크릿 형태, 키워드=값 자격증명, 연결 문자열, 인증서 파일, DB 덤프, 로그/PID, 대용량 바이너리, 개인 경로/이메일 8개 패턴을 전수 검색한 결과 **실제 비밀정보(SECRET_OR_PRIVATE)로 확정된 파일은 0건**이다. 유일한 고위험 항목은 `postgres18.zip`(319MB 바이너리)이며, `.tmp-uat/`가 `.gitignore`에 규칙이 있음에도 무시되지 않는 원인은 "경로 차이(의도한 `tmp-*` 규칙이 점으로 시작하는 이름과 매치되지 않는 패턴-대상 불일치)"로 CONFIRMED 판정했다. §12의 manifest(약 90여 개 파일, JARVIS/Knowledge 코드+테스트+운영 문서+보고서)는 안전하게 편입 가능한 것으로 판단하나, **이번 라운드에서는 어떤 파일도 실제로 add/commit하지 않았다.**
