> ⚠️ **LEGACY / NON-CANONICAL DOCUMENT**
> This document uses a 15-phase structure that is **not** the canonical NEXORA Master 1차 Stage 1–10 framework fixed by the 2026-09-17 CEO decision. For current Master 1 Stage 1–10 closure status, see `doc/plans/nexora-master1-canonical-status.md`. This document's body is preserved as-is for historical reference and is not updated further as a closure source of truth.

# NEXORA Master Roadmap

**Created:** 2026-08-31
**Status:** Active — baseline document, update on every major phase completion
**Purpose:** One document answering "where is the whole NEXORA project right now, and what comes next" — synthesized from existing plan/status/investigation documents only. No task below is marked DONE without a cited source document.

**Sources consulted (read-only):**
- `docs/investigations/nexora-integrated-roadmap.md` (2026-08-27) — master priority list
- `docs/investigations/nexora-operational-stability-baseline-and-next-slice.md` (2026-08-27)
- `docs/investigations/nexora-unexpected-commit-and-live-migration-recovery-plan.md` (2026-08-27)
- `docs/investigations/mobile-remote-approval-*.md` (2026-08-26/27, 12 files)
- `docs/investigations/jarvis-delegation-loop-*.md`, `jarvis-canonical-plan-*.md`, `jarvis-nex103-*.md`, `jarvis-pure-readonly-*.md`, `jarvis-delegation-loop-status-and-human-decisions.md` (2026-08-24/25)
- `docs/architecture/jarvis-delegation-loop-design.md`, `jarvis-delegation-loop-mvp-plan.md`, `nexora-agent-continuity-system-design.md`, `nexora-agent-handoff-v1.md`
- `doc/plans/2026-08-28-nexora-knowledge-layer-v0.1-status.md` (all entries through the 2026-08-31 Local Scope Closure decision)
- `doc/plans/2026-04-06-smart-model-routing.md`, `2026-06-05-agent-access-mcp-runtime-slots-adr.md`, `2026-05-26-skills-cli-catalog-contract.md`, `2026-05-06-llm-wiki-paperclip-asset-security-gate.md`, `2026-04-08-agent-browser-process-cleanup-plan.md`
- `docs/specs/cliphub-plan.md`
- Git log/repository state (`git log`, `git ls-files`) used only to confirm whether a documented incident (missing 0217/0218 migration files) was later resolved — not used to invent new completed work.

**Ground rule applied throughout:** a status of `DONE` requires an explicit pass/completion statement in a cited document (or, for one item, direct confirmation in the current repository state that a documented incident was resolved by a later commit). Where no such evidence exists, the item is marked `NOT STARTED`, `IN PROGRESS`, or noted as "no completion evidence found" rather than guessed.

---

## 1. Core Foundation

The underlying Paperclip platform (agents, issues, workspace model, auth, billing, skills catalog) that every NEXORA-specific layer below is built on top of.

| Task | Status | Evidence |
| --- | --- | --- |
| Agent authentication & management | No dedicated completion doc found | `doc/plans/2026-02-18-agent-authentication*.md` (design-stage headers only) |
| Workspace / work-product model | No dedicated completion doc found | `doc/plans/2026-03-13-workspace-product-model-and-work-product.md` |
| Billing ledger & budget enforcement | No dedicated completion doc found | `doc/plans/2026-03-14-billing-ledger-and-reporting.md`, `2026-03-14-budget-policies-and-enforcement.md` |
| Skills/CLI catalog contract | Contract accepted, implementation completion not confirmed | `doc/plans/2026-05-26-skills-cli-catalog-contract.md` ("Status: Phase A engineering contract") |

**Note:** These are older (Feb–June 2026) plan documents whose own status headers mostly read "Proposed"/"Draft"/"contract" — that reflects the plan document itself not being updated after shipping, not necessarily that the feature is unbuilt (this platform is visibly live and in daily use by every NEXORA-specific track below). No single canonical "Core Foundation checklist" document exists, so **no task fraction is claimed here** — marking this DONE outright would be guessing beyond the cited evidence.

**Status: NOT TRACKED AS A CHECKLIST (no dedicated status doc — treated as the working substrate under everything below)**

---

## 2. Memory / Knowledge (Knowledge Layer v0.1)

Fully tracked in `doc/plans/2026-08-28-nexora-knowledge-layer-v0.1-status.md`.

| Phase | Status |
| --- | --- |
| 1.1 Migration metadata drift repair | DONE |
| 2.0 Memory Operations / Knowledge Records minimum E2E | DONE |
| 2.1 Board-only review and promotion | DONE |
| 2.2 Manual Obsidian synchronization | DONE |
| 2.3 Per-record sync serialization/concurrency | DONE |
| 3.0A Board-triggered explicit extraction | DONE |
| 3.0B Durable automatic extraction (functional UAT) | DONE (performance/operational readiness: CONDITIONAL PASS; production activation: NO) |
| 3.0C Deployment topology investigation & canary design | DONE |
| 3.0C-1 Canary observability hardening | DONE |
| 3.0C-4 Local isolated-canary Controlled Retry | DONE |
| Local Scope Closure decision | DONE (2026-08-31) |

**Local: 10 / 10 tracked phases complete.**

**Status: LOCAL VALIDATION CLOSED — DEPLOYMENT GATE PENDING** (see section 8). Production feature flag `PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_ENABLED` default remains `false`.

---

## 3. Core Stability (NEXORA 1순위 — 운영 기반 안정화)

Checklist taken verbatim from `docs/investigations/nexora-integrated-roadmap.md` §1순위, cross-checked against `nexora-operational-stability-baseline-and-next-slice.md`, `mobile-remote-approval-e2e-report.md`, `mobile-remote-approval-migration-0219/0220-review.md`, and `jarvis-delegation-loop-status-and-human-decisions.md`.

| # | Task | Status | Evidence |
| --- | --- | --- | --- |
| 1 | 재부팅 후 서버·DB 자동 시작 및 복구 | DONE | `nexora-operational-stability-baseline-and-next-slice.md` §3–4 |
| 2 | `database_unreachable`, 포트 충돌, 중복 실행 방지 | DONE | same doc §6 |
| 3 | 타입체크와 핵심 회귀 테스트 | IN PROGRESS (continuous, not a one-time deliverable) | recurring `tsc --noEmit` / migration-safety passes cited across every phase entry |
| 4 | Approval 만료·충돌·중복 실행 방지 | DONE | `mobile-remote-approval-e2e-report.md` E2E-04, E2E-06 |
| 5 | idempotency key, fingerprint, consume, superseded 처리 | DONE | same doc E2E-04, E2E-07, E2E-08, E2E-09 |
| 6 | migration 0219/0220 검증 후 라이브 적용 | DONE | `mobile-remote-approval-migration-0219-review.md`, `-0220-review.md`; `nexora-unexpected-commit-and-live-migration-recovery-plan.md` §2 confirms both are live-applied |
| 7 | JARVIS 실패·재시도·중단 복구 | IN PROGRESS | Core loop mechanisms tested and PASS at the UAT level (`jarvis-canonical-plan-and-human-completion-uat.md`, `jarvis-pure-readonly-delegation-uat.md`: decomposition contract, parent-completion guard verified). **This core-test PASS is a separate fact from live-Issue closure**: `jarvis-delegation-loop-status-and-human-decisions.md` lists 5 still-open Human-decision items on real Issues (1 HIGH-risk approval pending, 2 parent-Issue completions pending, 1 optional test-file cleanup, 1 optional sandbox investigation) — none of these are code defects, all are pending a Human/Board decision |
| 8 | 감사 로그와 실행 증거 보존 | IN PROGRESS | activity-log pattern exists and is used across features (e.g. Knowledge Layer, mobile approval); no dedicated completion doc confirms this specific 1순위 item as closed |
| 9 | 긴급 중지의 서버 기반 | NOT STARTED | `mobile-remote-approval-pwa-ui-implementation.md` §4 explicitly lists "Emergency Stop 브로드캐스트: 회사 status가 paused로 변경 시 heartbeat.ts 틱 스케줄러가 즉시 중단하는 조건 가드 활성화" as a **pending backend-integration task** — the mobile PWA toggle UI exists, but the server-side enforcement is not yet wired |
| 10 | 백업 및 실제 복원 시험 | NOT STARTED | `nexora-operational-stability-baseline-and-next-slice.md` §9 — procedure designed, not executed. **Backup files existing/being generated (confirmed: automatic daily backups are current, e.g. a `paperclip-YYYYMMDD-HHMMSS.sql.gz` file from the same day exists) is a separate fact from an actual restore having been run and verified — no restore has been executed, so this is NOT STARTED, not DONE. This is CURRENT TASK, see section 6.** |
| 11 | Health Check와 장애 알림 | DONE | same doc §7, `check-paperclip-health.ps1` |
| 12 | 24시간 연속 실행 안정성 시험 | NOT STARTED | same doc §10 — plan only, not executed. **This is the expected NEXT after item 10.** |

**Core Stability: 6 / 12 confirmed DONE, 3 IN PROGRESS, 3 NOT STARTED.**

### AI Runtime 라우팅·비용 통제 (Model Router — sub-item of Core Stability)
`doc/plans/2026-04-06-smart-model-routing.md` — Status: **Proposed**. `nexora-integrated-roadmap.md` frames this as "현재 조사 중" (Hermes runtime evaluation, tiered model routing by task risk/cost). No implementation-completion evidence found.

**Status: NOT STARTED (design/proposal stage)**

---

## 4. Model Router

See "AI Runtime 라우팅·비용 통제" above (section 3) — this is the only Model Router material found in the repository. No separate implementation has been documented beyond the proposal.

**Status: NOT STARTED**

---

## 5. Agent Organization / Multi-Agent

| Track | Status | Evidence |
| --- | --- | --- |
| JARVIS delegation loop (task decomposition, plan-document contract, parent-completion guard, expert auto-assignment) | IN PROGRESS | Extensive `jarvis-delegation-loop-*` and `jarvis-canonical-plan-*` investigation trail (2026-08-24/25); core mechanisms built and UAT-verified; `jarvis-delegation-loop-status-and-human-decisions.md` lists 5 still-open Human-decision items (see Core Stability item 7 above) |
| Agent continuity / model-runtime handoff system (session recovery across model/adapter switches) | NOT STARTED | `docs/architecture/nexora-agent-continuity-system-design.md` — "Status: Architecture design; no implementation changes" |
| Agent handoff v1 | See `docs/architecture/nexora-agent-handoff-v1.md` | Design-stage document; no completion evidence found |

**Status: IN PROGRESS (delegation loop core), NOT STARTED (continuity/handoff system)**

---

## 6. Skills / Tools / MCP

| Item | Status | Evidence |
| --- | --- | --- |
| Agent access / MCP runtime slots ADR | Accepted for MVP contracts, pending validation gates | `doc/plans/2026-06-05-agent-access-mcp-runtime-slots-adr.md` — "Status: Accepted for MVP implementation contracts, pending SecurityEngineer and UXDesigner validation gates" |
| Skills CLI catalog contract | Contract stage | `doc/plans/2026-05-26-skills-cli-catalog-contract.md` — "Status: Phase A engineering contract" |

No document confirms full implementation completion for either item.

**Status: IN PROGRESS (contracts accepted, implementation/validation not confirmed complete)**

---

## 7. Security / Governance

| Item | Status | Evidence |
| --- | --- | --- |
| LLM/Wiki/Paperclip asset security gate | Accepted policy | `doc/plans/2026-05-06-llm-wiki-paperclip-asset-security-gate.md` — "Status: accepted Phase 5 policy" |
| Approval Risk Guard, WebAuthn challenge, TTL/expiry, fingerprint mismatch detection | DONE (backend logic) | `mobile-remote-approval-e2e-report.md` E2E-01–E2E-10 (see section 11 for the caveat that this is the *backend logic*; real device-level WebAuthn signature verification is separate, see section 11) |
| Repository/migration integrity (missing 0217/0218 migration files after commit `105daf480`) | RESOLVED | `nexora-unexpected-commit-and-live-migration-recovery-plan.md` (2026-08-27) documented the gap and proposed restoring the missing files at slots `0217`/`0218`. **Newer evidence supersedes that plan's exact slot numbers**: commit `30883e3d8` first restored the content as `0217_natural_ravenous.sql`/`0218_stormy_meggan.sql`, but a later dual-generation numbering conflict (resolved by merge `ffa16c5b6`) renumbered that same content to `0228_natural_ravenous.sql`/`0229_stormy_meggan.sql` to make room for a different, separately-created `0217_yielding_starbolt.sql`/`0218_mushy_jack_murdock.sql`. Current repository state (`git ls-files`) confirms migrations `0200`–`0231` are present with no gap or duplicate slot — the incident is resolved, just not at the file names the original recovery plan assumed. |
| Approval/heartbeat schema migrations `0219`/`0220` | DONE (live-applied) | `mobile-remote-approval-migration-0219-review.md`, `-0220-review.md`; `nexora-unexpected-commit-and-live-migration-recovery-plan.md` §2 independently confirms both are already applied on the live DB (migration-history table registered) — no conflicting newer evidence found for these two |

**Status: PARTIALLY DONE — no single comprehensive security checklist document exists across the whole product, so this is reported item-by-item rather than as a fraction.**

---

## 8. Research / Browser

| Item | Status | Evidence |
| --- | --- | --- |
| Agent browser process cleanup | Proposed only | `doc/plans/2026-04-08-agent-browser-process-cleanup-plan.md` — "Status: Proposed" |
| JARVIS autonomous web research / browser automation | LATER | `nexora-integrated-roadmap.md` §4순위 ("AI 브라우저") — explicitly the 4th priority tier, not yet started |

**Status: NOT STARTED / LATER**

---

## 9. AI Office

| Item | Status | Evidence |
| --- | --- | --- |
| Full AI Office 2D dashboard (company/department/agent status, chat, delegation, mobile-responsive) | LATER | `nexora-integrated-roadmap.md` §2순위 — vision-level bullets only, no implementation doc |
| Narrow "AI Office 운영 상태 API" (read-only supervisor/DB/server/backup status contract) | NOT STARTED (designed, not implemented) | `nexora-operational-stability-baseline-and-next-slice.md` §11 — full typed contract and file boundaries defined, no implementation evidence |

**Status: NOT STARTED (narrow status-API slice), LATER (full AI Office product)**

---

## 10. Voice / JARVIS Interface

| Item | Status | Evidence |
| --- | --- | --- |
| Full voice command control (task creation/delegation via voice, HIGH-risk actions) | LATER | `nexora-integrated-roadmap.md` §2순위 ("음성 컨트롤") — explicitly excludes payment/deletion/external-transfer/HIGH-approval/emergency-stop-release from voice-only execution |
| Narrow read-only voice query console (2 commands: server status, latest backup time; login-session-gated, no state mutation) | NOT STARTED (designed, not implemented) | `nexora-operational-stability-baseline-and-next-slice.md` §12 |

**Status: NOT STARTED (narrow read-only slice), LATER (full voice control)**

---

## 11. Mobile

| Item | Status | Evidence |
| --- | --- | --- |
| Mobile remote-approval backend logic (create/approve/reject/expire/idempotency/fingerprint/crash-retry/cross-run block) | DONE | `mobile-remote-approval-e2e-report.md` — E2E-01 through E2E-10 all PASS |
| Mobile PWA UI (pairing, approval console/detail, settings, risk visualization) | DONE (frontend only) | `mobile-remote-approval-pwa-ui-implementation.md` — built and passes `tsc`/production build |
| Real WebAuthn signature verification (backend) | NOT STARTED | same doc §4, item 1 — explicitly listed as pending backend integration |
| Real-time web push notifications (VAPID/service worker) | NOT STARTED | same doc §4, item 2 |
| Emergency Stop server-side enforcement (`heartbeat.ts` guard on company `paused` status) | NOT STARTED | same doc §4, item 3 — the mobile PWA's Emergency Stop **toggle UI** exists (`MobileApprovalConsole.tsx`); the **server-side guard that actually halts the heartbeat scheduler** on a paused company is a separate, not-yet-wired piece — UI existing and server enforcement existing are two different facts |

**Mobile: 2 / 5 tracked items DONE, 3 NOT STARTED.**

**Important separation:** the E2E-01–E2E-10 PASS result and the PWA UI build/typecheck PASS both used **mock** WebAuthn/pairing adapters (`webauthn-mock.ts`, `mobile-pairing-mock.ts`) for the device-authentication step. That PASS covers the approval lifecycle logic (expiry, idempotency, fingerprint, crash-retry, cross-run rejection) correctly and is not weakened by the mock — but it does not itself constitute evidence that real device-level WebAuthn signature verification is implemented; that remains a separate NOT STARTED item above.

---

## 12. Server / Deployment

Covered by Core Stability items 1, 2, 11 (auto-restart/recovery, port-conflict prevention, health check — all DONE) and by the repository/migration-integrity resolution in section 7. No additional dedicated Server/Deployment plan document was found beyond what is already listed in sections 3 and 7. The Knowledge Layer's own Deployment Canary Gate (section 2) is tracked in the **Deployment Gates** section near the end of this document.

**Status: See Core Stability (section 3) and Deployment Gates (end of document) — no separate checklist.**

---

## 13. Business Modules

| Item | Status | Evidence |
| --- | --- | --- |
| Billing ledger & reporting | No completion evidence found | `doc/plans/2026-03-14-billing-ledger-and-reporting.md` |
| Budget policies & enforcement | No completion evidence found | `doc/plans/2026-03-14-budget-policies-and-enforcement.md` |
| Company import/export v2 | Proposed implementation plan | `doc/plans/2026-03-13-company-import-export-v2.md` — "Status: Proposed implementation plan" |

**Status: NOT TRACKED AS A CHECKLIST — pre-existing Paperclip platform features without a NEXORA-specific completion doc; not re-verified in this pass.**

---

## 14. SaaS / Productization

| Item | Status | Evidence |
| --- | --- | --- |
| ClipHub team-configuration marketplace | LATER / superseded vision doc | `docs/specs/cliphub-plan.md` — carries its own "Supersession note" pointing to the company import/export v2 direction as current; no implementation evidence |

Not mentioned anywhere in `nexora-integrated-roadmap.md`'s 5-priority list — confirms this sits beyond the current planning horizon.

**Status: LATER**

---

## 15. Real-world UAT / Operations

| Item | Status | Evidence |
| --- | --- | --- |
| Non-destructive backup restore test | NOT STARTED | see section 3, item 10 |
| 24-hour continuous stability test | NOT STARTED | see section 3, item 12 |
| Knowledge Layer real (non-local) canary, 72h/200 ticks | DEPLOYMENT GATE (pending) | see Deployment Gates, Gate A, near the end of this document |
| JARVIS live-Issue UAT (NEX-100/102/103/104/105) | IN PROGRESS / Human decision pending | `jarvis-delegation-loop-status-and-human-decisions.md` |

**Status: NOT STARTED / DEPLOYMENT GATE / IN PROGRESS — no single unified operations checklist exists; each item tracked at its source.**

---

## Progress

Fractions are given only where a document provides an explicit, countable checklist. No project-wide percentage is fabricated.

| Area | Complete / Total | Note |
| --- | --- | --- |
| Knowledge Layer v0.1 (Local) | 10 / 10 | Deployment Gate tracked separately, not counted against this fraction |
| Core Stability (NEXORA 1순위) | 6 / 12 | 3 IN PROGRESS, 3 NOT STARTED |
| Mobile Remote Approval | 2 / 5 | 3 NOT STARTED (WebAuthn backend, push notifications, Emergency Stop enforcement) |

**전체 제품 진행률: 아직 기준선 확정 중** — Core Foundation, Security, Business Modules, and every LATER-tier area (AI Office, Voice, full Browser automation, SaaS) have no confirmed total task count in any existing document, so no overall NEXORA percentage is computed. This roadmap will start reporting one only once those areas have their own checklist documents.

---

## Roadmap Operating Rules

- Update this document whenever a large Phase completes (a Knowledge-Layer-style phase, a Core Stability checklist item, or a Deployment Gate).
- Update **Current Position** every time.
- Update the completed-task counts in **Progress** every time — never leave a stale fraction.
- Update **NEXT** every time, and only from what an existing document actually names next; do not predict a phase name that no document defines.
- Check whether any **Deployment Gate** was newly introduced or newly satisfied whenever a phase completes — a Gate must never silently disappear from this document.
- New ideas go into **LATER**, not directly into a NOW section, per the project's Stability First principle — promote an item out of LATER only when a real plan document justifies it.
- Never mark an item `DONE` without a citable source document (or, exceptionally, direct current-repository confirmation that a previously-documented gap was resolved, as done once in section 7 for the migration-file incident).
- Where newer evidence (a later commit, a later review doc) contradicts an older plan document's specifics, the newer evidence wins for status purposes — the older document is left unedited as a historical record, but this roadmap cites the newer evidence (see section 7's 0217/0218 renumbering entry for the pattern to follow).

---

## Current Position

```
Core v0.1:                            VERIFIED / CLOSED (2026-09-09)
Knowledge Layer v0.1:                 COMMITTED / CLOSED (aa1fa8862, 33 files)
Gate C (Backup Restore):              VERIFIED_PASS (retry8, SHA-256 pinned)
Gate D (24h Stability):               VERIFIED_PASS (24/24 snapshots, PID 17652/7404)
Emergency Stop Server Guard:          VERIFIED_PASS (14/14 tests, heartbeat.ts)
Audit Retention:                      Policy A Adopted for v0.1 Closure
Current Phase:                        Post-Core / Wave 2 Governance & Operations
```

NEXORA has closed **Core v0.1** and transitioned to post-core governance hardening, operational status APIs, and pilot execution stabilization.

## Completed

High-level list only — see the numbered sections above for full evidence per item.

- Core v0.1 — VERIFIED / CLOSED. All closure prerequisites satisfied.
- Knowledge Layer v0.1 — all 10 tracked local phases (1.1 → 3.0C-4) DONE; committed atomically in `aa1fa8862` (33 files, +5,854 lines).
- Deployment Gate C — Non-destructive backup restore verification DONE / VERIFIED_PASS (retry 8, disposable target).
- Deployment Gate D — 24-hour continuous stability observation DONE / VERIFIED_PASS (v2 observer, 24/24 hourly snapshots PASS).
- Emergency Stop Server Guard — heartbeat.ts pause guard DONE / VERIFIED_PASS (14/14 tests PASS).
- Audit Log Retention — Policy A (preserving `activity_log`, `heartbeat_runs`, `heartbeat_run_events`) verified and adopted for v0.1 closure.
- Core Stability Baseline — reboot auto-recovery, port-conflict/duplicate-process prevention, Approval expiry/conflict prevention, idempotency/fingerprint/consume/superseded handling, migration 0219/0220 review and live application, Health Check tooling.
- Mobile Remote Approval — backend approval-lifecycle logic (E2E-01–E2E-10 PASS), PWA UI (frontend build/typecheck PASS).
- Security/Governance — LLM/Wiki/Paperclip asset security gate policy accepted; repository/migration-file integrity incident (0217/0218) resolved by later commits.
- JARVIS delegation loop — core mechanisms UAT PASS (decomposition contract, parent-completion guard `403`).

## POST-CORE UNRESOLVED / FOLLOW-UP BACKLOG

### 1. Work Product Self-Action Guard
- **Status:** `DONE BUT UNCOMMITTED`
- **Priority:** `P1`
- **Summary:** Complete implementation and verification of work product self-action security guards:
  - Self-delete Guard: VERIFIED
  - Self-review Guard: VERIFIED
  - Different-run modification: VERIFIED
  - Human/Board authorization: VERIFIED
- **Current Uncommitted State:** 5 approved files currently residing in the working tree without git add / commit:
  - `server/src/services/work-product-self-action-guard.ts`
  - `server/src/services/work-product-self-action-guard.test.ts`
  - `server/src/routes/issues.ts`
  - `server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts`
  - `server/src/__tests__/artifact-review-document-routes.test.ts`
- **Blocking:** No
- **Requires Human Approval:** Yes (commit/push approval)
- **Next Action:** Review working tree exact diff and execute atomic commit.

### 2. Pre-existing Test Failures
- **Status:** `NEEDS READ-ONLY INVESTIGATION`
- **Priority:** `P1`
- **Summary:** 3 pre-existing test failures in `server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts` related to `status: "done"` PATCH and missing `listAcceptedPlanDecompositions` mock. Completely unrelated to the current Work Product Guard changes.
- **Blocking:** No
- **Requires Human Approval:** Yes
- **Next Action:** READ-ONLY isolation of the 3 failing test cases; request human approval for targeted test mock fix.

### 3. First Business Pilot — CEO Daily Operational Digest
- **Status:** `BLOCKED` (Pilot execution blocker; P0 within Pilot scope, P1 within system backlog)
- **Priority:** `P1`
- **Summary:** Pilot execution started and verified, but blocked during autonomous agent execution.
  - Confirmed Blocker: 백지수 agent run failed with `codex_local adapter_failed` (2 consecutive runs failed at adapter invocation level).
  - Root Cause: `UNCONFIRMED` (adapter execution / token / environment injection defect).
  - Scope Isolation: Strictly decoupled from Core v0.1 (Core remains CLOSED).
  - Resumption Sequence: READ-ONLY root-cause investigation → exact cause confirmed → CEO approval → necessary mutations → recovery/retry → resume Pilot E2E.
- **Blocking:** Yes (blocks First Business Pilot completion)
- **Requires Human Approval:** Yes
- **Next Action:** READ-ONLY root-cause investigation of `codex_local adapter_failed` without running mutations.

### 4. AI Office Status API (`/api/ai-office/status`)
- **Status:** `READY`
- **Priority:** `P1`
- **Summary:** Read-only operational telemetry API aggregating Supervisor, Database, Server, and Backup status.
  - READ-ONLY preflight and final correction checks complete; implementation not yet started.
  - Verified Design:
    - Windows PID check: `EPERM` = alive (service account), `ESRCH` = dead, unexpected = `unknown`.
    - Supervisor status: `"running" | "stopped" | "recovering" | "unknown"`.
    - Recovering detection: Evaluates both API and DB health, recovery state freshness (<5 min), and lifecycle events (prevents stale recovery false-positives).
    - Secret Masking: Database URL password strictly sanitized to `'***'`.
    - Authz: Canonical `assertAuthenticated` and `assertBoard` reuse.
    - Zero DB schema/migration impact.
  - Minimal File Set (6 files, 3 lines diff):
    1. `packages/shared/src/types/ai-office.ts` (new)
    2. `packages/shared/src/index.ts` (+1 line)
    3. `server/src/services/ai-office-status.ts` (new)
    4. `server/src/routes/ai-office.ts` (new)
    5. `server/src/app.ts` (+2 lines)
    6. `server/src/__tests__/ai-office-status.test.ts` (new)
- **Blocking:** No
- **Requires Human Approval:** Yes (CEO implementation approval)
- **Next Action:** Await CEO implementation approval, then implement 6-file minimal diff.

### 5. Old Pending Risk Guard Approvals
- **Status:** `NEEDS READ-ONLY INVESTIGATION`
- **Priority:** `P2`
- **Summary:** Historical approval requests remain pending in the database. Bulk approve or bulk reject is strictly prohibited.
- **Blocking:** No
- **Requires Human Approval:** Yes
- **Next Action:** READ-ONLY classification into obsolete/completed UAT, still-valid, and current Pilot-related; execute individual resolution under CEO approval.

### 6. Agent Capabilities Provisioning Gap
- **Status:** `DEFERRED`
- **Priority:** `P2`
- **Summary:** Organization-wide agent provisioning scripts currently do not populate agent capabilities. Only 백지수 was manually patched for Pilot execution.
- **Blocking:** No
- **Requires Human Approval:** Yes
- **Next Action:** Design org-wide agent capability provisioning migration and script.

### 7. Supervisor Operational Follow-ups
- **Status:** `NON-BLOCKING`
- **Priority:** `P2`
- **Summary:** Operational findings from the 2026-09-08 reboot investigation:
  - Dual startup paths (`\NEXORA-Default-ControlPlane-Service` vs `\Paperclip-ControlPlane-Supervisor`).
  - Stderr diagnostic capture blind spot during rapid restarts.
  - Task Scheduler Event ID 322 IgnoreNew log accumulation.
  - Non-blocking for Core stability; Supervisor PID 7404 is stable.
- **Blocking:** No
- **Requires Human Approval:** Yes (Windows Scheduled Task consolidation)
- **Next Action:** Draft single-task consolidation script and error stream redirection.

### 8. DB / Migration Follow-up
- **Status:** `NON-BLOCKING`
- **Priority:** `P2`
- **Summary:** Pre-existing drift in `packages/db/src/migrations/meta/0231_snapshot.json`. Drizzle schema and migrations `0200`–`0231` are functionally aligned and live-applied.
- **Blocking:** No
- **Requires Human Approval:** Yes
- **Next Action:** READ-ONLY schema-to-snapshot audit to align metadata cleanly in next migration wave.

### 9. Performance Follow-up
- **Status:** `DEFERRED`
- **Priority:** `P2`
- **Summary:** `activity-log.ts` triggers repeated `instanceSettingsService.getGeneral()` queries. Candidate for in-memory TTL caching to eliminate N+1 query pattern.
- **Blocking:** No
- **Requires Human Approval:** No
- **Next Action:** Profile query load and implement in-memory cached settings read.

### 10. Governance NEXT (Audit Retention Policy C-lite)
- **Status:** `DEFERRED`
- **Priority:** `P3`
- **Summary:** Enterprise audit retention upgrade from Policy A to Policy C-lite. Implements append-only `entity_deletion_evidence` table (migration `0232`) to capture company/agent deletions. Fully designed in `reports/operations/audit-retention-c-lite-implementation-plan-2026-09-07.md`.
- **Blocking:** No
- **Requires Human Approval:** Yes (schema migration)
- **Next Action:** Defer to Core v0.2 milestone.

### 11. Documentation Drift Remediation
- **Status:** `NON-BLOCKING`
- **Priority:** `P2`
- **Summary:** Legacy documents such as `claude-core-v0.1-boundary-audit.md` retain stale "NOT STARTED" notations for Emergency Stop, which has been verified PASS (14/14 tests).
- **Blocking:** No
- **Requires Human Approval:** No
- **Next Action:** Non-blocking doc update to harmonize status to VERIFIED across historical audit notes.

### 12. JARVIS NEXT (M2 Multi-Agent Architecture)
- **Status:** `DEFERRED`
- **Priority:** `P3`
- **Summary:** Advanced multi-agent orchestration including M2 multi-child parallel delegation scheduler and independent QA review lane.
- **Blocking:** No
- **Requires Human Approval:** Yes
- **Next Action:** Architecture specification and phase planning for post-v0.1 expansion.

---

## NEXORA POST-CORE MASTER BACKLOG

| Priority | Item | Status | Blocking | Requires Human Approval | Next Action |
|---|---|---|---|---|---|
| **P1** | **Work Product Self-Action Guard** | `DONE BUT UNCOMMITTED` | No | Yes | Review working tree diff (5 files) & commit |
| **P1** | **AI Office Status API** | `READY` | No | Yes | Await CEO approval → apply 6-file minimal diff |
| **P1** | **Pre-existing Test Failures (3 tests)** | `NEEDS READ-ONLY INVESTIGATION` | No | Yes | READ-ONLY test isolation → approval for mock fix |
| **P1 (Pilot P0)** | **First Business Pilot (`codex_local`)** | `BLOCKED` | **Yes** (Pilot) | Yes | READ-ONLY root cause investigation (UNCONFIRMED) |
| **P2** | **Risk Guard Pending Approvals** | `NEEDS READ-ONLY INVESTIGATION` | No | Yes | READ-ONLY triage/classification → individual resolution |
| **P2** | **Supervisor Dual Startup Hardening** | `NON-BLOCKING` | No | Yes | Consolidate scheduled tasks & fix stderr blind spot |
| **P2** | **0231 Migration Snapshot Drift** | `NON-BLOCKING` | No | Yes | READ-ONLY schema audit → snapshot synchronization |
| **P2** | **Activity Log Repeated Query** | `DEFERRED` | No | No | In-memory TTL cache for instance settings |
| **P2** | **Documentation Drift (Emergency Stop)** | `NON-BLOCKING` | No | No | Align legacy audit docs to reflect VERIFIED status |
| **P2** | **Agent Capabilities Org Provisioning** | `DEFERRED` | No | Yes | Design org-wide auto-provisioning migration |
| **P3** | **Governance: Audit Retention C-lite** | `DEFERRED` | No | Yes | Schedule migration 0232 for Core v0.2 |
| **P3** | **JARVIS M2 Parallel / QA Lane** | `DEFERRED` | No | Yes | Defer to post-v0.1 multi-agent milestone |

---

## Deployment Gates

Verification steps that must pass in a real (non-local) environment before certain production behavior may change. These must not be forgotten during ordinary development.

### Gate A — Knowledge Layer Memory Candidate Reconciler activation
- **Source:** `doc/plans/2026-08-28-nexora-knowledge-layer-v0.1-status.md`, Phase 3.0C §9–10 and the 2026-08-31 Local Scope Closure decision.
- **Required:** a dedicated canary environment (separate from staging/production), deploy freeze during the window, `batchSize=5`, `intervalMs=300000`, minimum 72 hours or 200 ticks (whichever is longer), existing Go/No-Go criteria (candidate/activity mismatch, cross-company candidate, duplicate candidate, overlapping-`hostname` tick logs → immediate stop).
- **Precondition:** operator confirmation of the real production deployment topology (ECS desired-count/autoscaling presence, or Quadlet host duplication).
- **Blocks:** changing `PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_ENABLED` production default away from `false`.
- **Current state:** PENDING — not started.

### Gate B — Migration-before-code deployment ordering
- **Source:** `mobile-remote-approval-lifecycle-security-integration-checklist.md` §3.
- **Required:** migration files (e.g. `0219`/`0220`-style schema additions) must be applied to a database before the application code that references the new columns is deployed; deploying code first produces an immediate runtime SQL error.
- **Current state:** documented as a rule for future migrations; no automated enforcement confirmed in any document.

### Gate C — Non-destructive backup restore verification (also section 3 item 10 / section 15)
- **Source:** `nexora-operational-stability-baseline-and-next-slice.md` §9.
- **Required:** restore the latest backup into an isolated, temporary database and verify table counts and the Approvals TTL schema, then discard the temporary database.
- **Current state:** VERIFIED_PASS (completed on 2026-09-06, retry 8).

### Gate D — 24-hour continuous stability observation
- **Source:** same doc §10.
- **Current state:** VERIFIED_PASS (completed on 2026-09-08, v2 observer, 24/24 snapshots PASS).

## LATER

Does not block current Core development. Nothing already classified as NOW anywhere in the sections above has been moved here.

- AI Office — full 2D dashboard, chat/delegation UI (`nexora-integrated-roadmap.md` §2순위)
- Voice — full command execution beyond the narrow read-only query console (`nexora-integrated-roadmap.md` §2순위)
- Model Router 고도화 — Hermes runtime rollout beyond the current proposal stage (`nexora-integrated-roadmap.md` §1순위 sub-section, `2026-04-06-smart-model-routing.md`)
- Knowledge Graph / Vector DB for the Knowledge Layer — explicitly deferred in `nexora-integrated-roadmap.md` §3순위 ("복잡한 Knowledge Graph DB와 Vector DB는 현재 확정 작업이 아니며 필요성이 검증될 때만 검토")
- AI Browser (autonomous web research/automation) — `nexora-integrated-roadmap.md` §4순위
- JARVIS 자율 운영 확대 (parallel delegation at scale, night/away-mode policy) — `nexora-integrated-roadmap.md` §5순위
- Additional Business Modules beyond what already exists — section 13
- SaaS / ClipHub marketplace — section 14
- Agent continuity/model-handoff system — `docs/architecture/nexora-agent-continuity-system-design.md` (design only)
- Knowledge Layer v0.1's own explicitly out-of-scope items (these belong to the Knowledge Layer's own boundary, not to Core Stability's remaining work — kept here for visibility only, not counted against any Core Stability fraction): Obsidian reverse synchronization, file watching, bulk synchronization, search, conflict merging; Knowledge Graph enhancement; automatic-promotion enhancement beyond the existing Board-only path — per `doc/plans/2026-08-28-nexora-knowledge-layer-v0.1-status.md` "Known residual limitations" and the 2026-08-31 Local Scope Closure decision §6

## ROADMAP STATUS: READY (POST-CORE BACKLOG INTEGRATED)
