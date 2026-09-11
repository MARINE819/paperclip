# NEXORA Master Roadmap — Current State (2026-09-07)

**기준 문서:** `doc/plans/nexora-master-roadmap.md`(작성 2026-08-31, "ROADMAP STATUS: READY") — 본 보고서는 이 문서를 실제 실행·테스트 증거 우선순위(§9)에 따라 갱신한 것이다.

## 1. 질문 해석
저장소 내 실제 문서·Git 상태·이번 세션의 Gate C/D 작업 증거를 근거로, NEXORA 전체 개발계획에서 현재 정확한 위치와 다음 단계를 정리한다.

## 2. 질문 목적
CEO가 현재 상태와 다음 행동을 명확히 판단할 수 있도록, 추측이 아닌 근거 기반의 현재 상태 스냅샷을 제공한다.

## 3. Executive Summary
2026-08-31 기준 Master Roadmap의 "Current Task"는 **Deployment Gate C(백업 복원 검증)**였다. 이번 세션에서 **Gate C는 실제로 실행되어 VERIFIED PASS로 확정되었다(CONFIRMED — 이 세션 자체가 그 실행 기록, retry8 최종 판정 `overallPass: true`)**. 이어서 **Gate D(24시간 연속 안정성 관찰)가 시작되었다(v1, T0 2026-09-06 23:52:05).** Gate D v1 **Observer 스크립트 자체에 대한 READ-ONLY 계약 감사**에서 여러 결함(Supervisor PID 연속성/SHA-256/명령줄 중복 미검증 등)이 발견되어, **Supervisor 자체의 재장애와 무관하게** 더 엄격한 v2 Observer로 계획적으로 교체되었다(T0 2026-09-07 01:25:44, CONFIRMED — Supervisor PID 21488은 교체 전후 동일). 현재 Gate D는 **`OBSERVING`**이며 24시간/24개 스냅샷이 완료되기 전까지 PASS가 아니다. **또한 이번 세션에서 새로 확인된 중요한 사실: 8/31 로드맵이 "NOT STARTED"로 기록한 Emergency Stop 서버 가드(heartbeat.ts)는, 같은 날짜에 작성된 별도 검증 문서(`claude-emergency-stop-heartbeat-guard-verification.md`)에 의해 실제로는 기존 프로덕션 코드로 이미 충족되어 있음이 PASS로 검증되어 있었다(CONFIRMED, §18) — 로드맵 원본이 이 검증 결과를 반영하지 못한 문서 간 불일치다.** 이 세션에서 이 외에도 JARVIS/Knowledge/QA/Permission/Workspace 등 다수 영역에 대한 광범위한 READ-ONLY 설계·감사 작업이 수행되었으나, **이 결과물은 파일로 저장되지 않고 대화 내에만 존재하므로 저장소 관점에서는 "문서화된 진행"으로 집계할 수 없다(§18)**.

## 4. NEXORA 전체 목표
`nexora-integrated-roadmap.md`(2026-08-27) 기준 5단계 우선순위 체계(1순위 Core Stability ~ 5순위 JARVIS 자율 운영 확대)가 유지되고 있다(CONFIRMED, 8월 31일 로드맵이 이를 그대로 인용).

## 5. Master Roadmap 단계표
| 단계 | 작업 | 상태(8/31 기준) | 상태(9/7 갱신) | 근거 | 차단요인 | 다음 조건 |
|---|---|---|---|---|---|---|
| 1 | Core Foundation | NOT TRACKED | 변경 없음 | 로드맵 §1 | — | — |
| 2 | Knowledge Layer v0.1(Local) | DONE(10/10), Deployment Gate PENDING | 변경 없음(이번 세션 미추적) | 로드맵 §2 | Gate A 미시작 | Gate A 착수 |
| 3 | Core Stability | 6/12 DONE | **갱신**: Gate C DONE(신규), Gate D IN PROGRESS(신규), **항목 9(Emergency Stop 서버 가드) DONE으로 재분류(8/31 같은 날 작성된 별도 검증 문서 근거, §18)** | 이번 세션 Gate C/D 작업 + `claude-emergency-stop-heartbeat-guard-verification.md` | 없음(Emergency Stop) / Gate D 완료 대기 | Gate D 완료 |
| 4 | Model Router | NOT STARTED | 변경 없음 | 로드맵 §4 | — | — |
| 5 | Agent Organization/Multi-Agent | IN PROGRESS(delegation loop) | 변경 없음(문서 기준), **단 이번 세션에서 M2 fan-in/QA 설계가 대화 내에서 상세화됨(미문서화)** | 로드맵 §5, 이번 세션 | 문서화 안 됨 | 설계를 파일로 저장 |
| 6 | Skills/Tools/MCP | IN PROGRESS(contract) | 변경 없음 | 로드맵 §6 | — | — |
| 7 | Security/Governance | PARTIALLY DONE | 변경 없음 | 로드맵 §7 | — | — |
| 8 | Research/Browser | NOT STARTED/LATER | 변경 없음 | 로드맵 §8 | — | — |
| 9 | AI Office | NOT STARTED(narrow)/LATER(full) | 변경 없음 | 로드맵 §9 | — | — |
| 10 | Voice | NOT STARTED(narrow)/LATER(full) | 변경 없음 | 로드맵 §10 | — | — |
| 11 | Mobile | 2/5 DONE | 변경 없음 | 로드맵 §11 | — | — |
| 12 | Server/Deployment | Core Stability에 포함 | Gate C/D 갱신 반영 | 아래 §Deployment Gates | — | — |
| 13 | Business Modules | NOT TRACKED | 변경 없음 | 로드맵 §13 | — | — |
| 14 | SaaS/Productization | LATER | 변경 없음 | 로드맵 §14 | — | — |
| 15 | Real-world UAT/Operations | NOT STARTED/IN PROGRESS | **Gate C DONE, Gate D IN PROGRESS로 갱신** | 이번 세션 | — | Gate D 완료 |

## 6. 각 단계 상태 (완료/진행중/차단됨/미착수/LATER) — 요약
- **완료(신규)**: Deployment Gate C(백업 복원 검증), Emergency Stop 서버 가드(heartbeat.ts — 기존 프로덕션 코드로 이미 충족, 별도 검증 문서로 확인됨, §18).
- **진행 중(신규)**: Deployment Gate D(24시간 안정성 관찰, `OBSERVING`, v2 Observer로 계획적 교체됨 — EBUSY 재발 아님, §10).
- **진행 중(기존, 문서 기준)**: JARVIS delegation loop core, Skills/MCP contract, Security 일부.
- **차단됨**: 없음(현재 확인된 범위에서 명시적 BLOCKED 항목 없음).
- **미착수**: Model Router 구현, 24시간 시험(이제 진행 중으로 전환), AI Office/Voice 본체, WebAuthn 실서명, 실시간 push. (**Emergency Stop 서버 강제는 이 목록에서 제외 — §18에서 확인된 대로 이미 DONE**)
- **LATER**: AI Office 풀버전, Voice 풀버전, Knowledge Graph/Vector DB, AI Browser, SaaS/ClipHub 등(로드맵 §LATER 그대로).

## 7. 현재 정확한 위치
**Gate D 24시간 연속 안정성 관찰, `OBSERVING` 상태(v2, T0 2026-09-07 01:25:44 KST).** 이는 8/31 로드맵의 "Next"(Gate D)가 실제로 착수된 것이며, Core Stability 트랙 최종 단계에 해당한다.

## 8. 현재 Gate D의 역할
Core v0.1 Closure(이 세션 초반에 확립된 4개 체크리스트: Gate C, Gate D, Emergency Stop guard, Audit log retention)의 두 번째 항목. Gate D PASS 없이는 Core Closure를 선언할 수 없고, Core Closure 없이는 이번 세션에서 설계된 "첫 Business Pilot"도 실행 준비 완료로 판정되지 않는다(이 세션 전체에서 일관되게 적용된 순서).

## 9. 현재 진행률
| 영역 | 완료/전체 | 비고 |
|---|---|---|
| Knowledge Layer v0.1(Local) | 10/10 | Deployment Gate 별도 |
| Core Stability | 6/12(8/31 기준) → **Gate C 완료로 Deployment Gate 1개 추가 확정, 항목 12(24h 시험)는 미완료→진행중 전환**(항목 자체의 DONE 카운트는 24h 완료 후 갱신) | 근거: 이번 세션 |
| Mobile Remote Approval | 2/5 | 변경 없음(이번 세션에서 재조사 안 함) |
| **전체 제품 진행률** | **산정 불가(기존 로드맵과 동일 원칙 유지)** | 임의 백분율 금지 원칙 유지 |

## 10. 최근 완료된 주요 작업 (이번 세션, 9/6~9/7)
- Gate C(백업 복원) VERIFIED PASS 확정(SHA-256 고정, disposable target, Guard 16 등 다수 하위 검증 포함).
- Gate C의 legacy 하드코딩 스키마 가드를 백업-유도 identity 검증으로 교체.
- Gate D v1 Observer 실행 및 T0~Hour1 스냅샷 확보.
- **v1 Observer 스크립트 자체에 대한 READ-ONLY 계약 감사 수행**(Supervisor 자체의 재장애가 아니라 감시 도구 자신의 결함 발견) → PID 연속성/SHA-256/명령줄 중복 검사 등을 보강한 v2 Observer로 **계획적 무중단 교체**(Supervisor PID 21488은 변경 없음).
- EBUSY(9/6 10:18–10:24Z, 별개의 더 이른 사건) 근본원인 확인 및 인시던트 보고서 작성(본 보고서와 별개 파일).
- Supervisor 장애 대응 Runbook 작성.
- **Emergency Stop 서버 가드 항목의 실제 상태를 저장소 문서(`claude-emergency-stop-heartbeat-guard-verification.md`)로 재확인** — 8/31 로드맵의 "NOT STARTED" 표기가 같은 날 작성된 검증 문서와 불일치함을 발견(§18).

## 11. 현재 진행 중인 작업
Gate D v2 24시간 관찰(`OBSERVING`, 완료 예정 2026-09-08 01:25:44 KST).

## 12. 현재 차단요인
Core v0.1 Closure 선언 관점에서 **선행조건이 정확히 두 가지 남아 있다**(별도 파일 `core-v0.1-closure-prerequisite-audit-2026-09-07.md` §6, 판정: `CLOSURE_NOT_READY`):
1. **Gate D 완료**(24시간 경과 + 24개 스냅샷 전부 PASS) — 현재 `OBSERVING`.
2. **Audit log/evidence retention 계약 충분성 검증** — 실제 근거는 `activity_log`+`heartbeat_runs`/`heartbeat_run_events`이며(`decision-retention.ts`는 별개 기능으로, 이 항목의 근거가 아님이 후속 감사에서 정정됨 — `audit-retention-contract-verification-plan-2026-09-07.md` §4), 이후 특성화 테스트(`CURRENT_IMPLEMENTATION_CHARACTERIZED`, 4/4 PASS)까지 진행됐으나 계약 충분성에 대한 CEO/Human의 명시적 승인은 아직 없어 **PARTIAL** 상태다. C-lite 설계(삭제-증거 보강안)는 `DESIGN_READY / NOT_IMPLEMENTED`.
(이 세션의 이후 대화에서 진행된 JARVIS Pilot/Knowledge/QA 설계 작업들도 "Gate D 완료 후 착수"라는 순서를 스스로 전제로 삼고 있었으나, 그것과 별개로 위 2개 조건이 Closure 자체의 선행조건이다.)

## 13. Closure 선언 전 금지되는 다음 작업
- 첫 Business Pilot의 실제 실행(이 세션에서 설계된 "회사 내부 Issue/문서 정리 및 요약 보고서" Pilot).
- Core v0.1 Closure 공식 선언 — **Gate D 완료만으로는 불충분, §12의 두 조건이 모두 충족되어야 함.**
- 위 선언을 전제로 하는 어떤 후속 Wave(Track 17B의 Wave 2 이후)의 실제 코드 변경.

## 14. Gate D 완료 후 수행할 작업 (Closure 선언은 별도 조건 충족 후)
1. Gate D 완료 확인(24h/24스냅샷 PASS).
2. **Audit log/evidence retention 계약 충분성 검증**(§12 조건 2) — 전용 특성화 테스트는 이미 작성·실행되어 있음(`CURRENT_IMPLEMENTATION_CHARACTERIZED`, `audit-retention-contract-test-result-2026-09-07.md`); 남은 것은 C-lite 설계(`DESIGN_READY / NOT_IMPLEMENTED`)의 실제 구현 여부와, 계약 충분성 자체에 대한 CEO의 명시적 승인(현재 상태로 충분하다고 볼지, C-lite 구현을 기다릴지).
3. 위 1·2가 모두 충족된 경우에만 Core v0.1 Closure 선언(문서화).
4. Closure 선언 후 첫 Business Pilot 실행 승인 및 진행.
5. Track 17B에서 설계된 Wave 2(Agent-callable usage/run read tool, work-product 자기승인/삭제 보안 수정) 착수.

## 15. 다음 3개 우선순위
1. Gate D 24시간 관찰 완료 대기(개입 없이).
2. Audit log/evidence retention 계약 충분성 검증(§12 조건 2) — Gate D 완료와 병행 준비 가능, Closure 선언의 두 번째 필수 조건.
3. 위 두 조건이 모두 충족된 후 Core Closure 문서화 및 첫 Pilot 실행 — Pilot 자체는 `PREPARED / NOT_EXECUTED`(`nexora-first-business-pilot-readiness-plan-2026-09-07.md`). 담당 Agent 후보는 "백지수/지식·문서팀장"이며, 그 역할 정의는 저장소 파일(`server/phase2-agent-org-assignment.ts`)로 CONFIRMED이나, 대상 회사에서의 실제 live 활성 상태는 재조회 전까지 PROPOSED로 남는다(과확정하지 않음).

## 16. NOW / NEXT / LATER
- **NOW**: Gate D 관찰(개입 없이 대기), Audit retention 검증 준비.
- **NEXT**: (Gate D 완료 **및** Audit retention 검증 완료) → Core Closure 선언 → 첫 Pilot 실행 → Wave 2(usage tool, self-approval 보안수정).
- **LATER**: Model Router, Knowledge Retrieval 구현, Semantic QA 구현, M2 실구현, hired JARVIS targeting, AI Office/Mobile/Voice, SaaS.

## 17. 기존 계획과 현재 구현의 차이
8/31 로드맵은 Gate C/D를 "설계되었으나 미실행"으로 기록했다. 이번 세션에서 **둘 다 실제로 착수**되어 Gate C는 완료, Gate D는 진행 중으로 실질적 진전이 있었다 — 이는 로드맵 원본 문서 자체에는 아직 반영되어 있지 않다(원본 문서 갱신은 이번 보고서의 승인 범위 밖). **추가로, Emergency Stop 서버 가드는 로드맵 작성 시점(8/31)에 이미 별도 문서로 DONE이 검증되어 있었음에도 로드맵 본문에는 "NOT STARTED"로 잘못 남아 있었다 — 이는 "미실행 항목이 나중에 완료된 것"이 아니라 "이미 완료된 항목이 로드맵에 반영되지 않았던 것"이라는 점에서 위 Gate C/D의 성격과 다르다(§18).**

## 18. 발견된 문서 간 충돌
| 항목 | 문서 A | 문서 B | 판정 |
|---|---|---|---|
| Gate C 상태 | `nexora-master-roadmap.md`(8/31): "NOT STARTED — this is the current task" | 이번 세션 실행 기록: VERIFIED PASS | **이번 세션 실행 증거 우선(우선순위 1) — Gate C는 DONE으로 갱신되어야 함** |
| Gate D 상태 | 동일 문서: "NOT STARTED" | 이번 세션: v1 실행 후 v2로 교체, 현재 `OBSERVING` | **실행 증거 우선 — IN PROGRESS로 갱신** |
| Emergency Stop 서버 가드(heartbeat.ts) | `nexora-master-roadmap.md`(8/31) 및 `claude-core-v0.1-boundary-audit.md`: "NOT STARTED" | `claude-emergency-stop-heartbeat-guard-verification.md`(**같은 날짜** 2026-08-31): "PASS — existing production guard verified... requires no production-code change", 실제 테스트 14/14 PASS, 라이브 코드에도 `companies.status === "active"` 가드 4곳 확인(CONFIRMED, 이번 세션 직접 grep) | **최신/더 구체적인 검증 문서 우선 — DONE으로 갱신.** 두 "NOT STARTED" 문서 모두 이 검증 문서의 존재를 반영하지 못한 것으로 보이며, 검증 문서 자신도 "공식 상태 문서 갱신은 범위 밖 — 별도 승인 필요"라고 명시해 둔 상태였다 |
| JARVIS M2/QA/Knowledge Retrieval 설계 상세 | 8/31 로드맵: "delegation loop core"만 IN PROGRESS로 기록, M2/QA/Knowledge Retrieval에 대한 구체 설계 문서 없음 | 이번 세션 대화: Track 3~5D/16/17에서 매우 상세한 설계 산출 | **이 설계는 어떤 파일에도 저장되지 않았으므로, 로드맵 갱신의 근거로 채택하지 않음(원칙 위반 방지) — "대화 중 존재했다"는 사실만 기록하고, 문서화되기 전까지는 로드맵 상태를 바꾸지 않는다.** |

## 19. 미확인 사항
- Supervisor 스크립트 자체의 git 커밋 이력(UNVERIFIED — untracked 파일).
- (해소됨) Emergency Stop 서버 강제(heartbeat.ts guard) 상태 — 이번 세션에서 재확인 완료, DONE으로 확정(§18). 단, `claude-core-v0.1-boundary-audit.md`/`nexora-master-roadmap.md` 원본 문서 자체의 공식 갱신은 별도 Human 승인 필요(범위 밖).
- 13076→21488 Supervisor 교체의 정확한 트리거(EBUSY 인시던트 보고서 §12/18 참조).

## 20. CEO가 결정해야 할 항목
1. Gate D 완료와 Audit log/evidence retention 계약 충분성 검증(§12)이 **모두** 끝난 뒤 Core Closure를 공식 문서(로드맵 원본 갱신 포함)로 선언할지.
2. 이번 세션에서 대화로만 존재하는 JARVIS M2/QA/Knowledge/Skill/Permission 설계 산출물을 정식 계획 문서로 저장할지(§18에서 지적된 "미문서화" 갭 해소).
3. Supervisor 스크립트를 git에 편입할지(EBUSY 인시던트 보고서 §17 제안).
4. 첫 Business Pilot의 실행 승인 시점.

## 21. 권장 다음 행동
1. Gate D 관찰이 끝날 때까지 개입 없이 대기.
2. 완료 즉시 `nexora-master-roadmap.md` 원본을 이번 보고서 근거로 갱신(Gate C DONE, Gate D DONE/PASS 또는 NOT_VERIFIED 반영).
3. 이 세션의 JARVIS/Knowledge/QA/Permission 설계 내용을 `doc/plans/` 아래 정식 문서로 저장할지 CEO 결정 후 진행.

## 22. 최종 결론
2026-08-31 로드맵의 "Current Task"였던 Gate C는 이번 세션에서 실제로 완료되었고(**CONFIRMED**), Gate D는 **v1 Observer 스크립트 자체의 계약 결함이 감사로 발견되어(EBUSY 재발이 아님) v2로 계획적으로 교체**된 뒤 현재 `OBSERVING` 중이다(**CONFIRMED**, Supervisor PID 21488은 교체 전후 불변). 24시간 및 24개 스냅샷이 모두 완료되기 전까지 Gate D는 PASS로 기록하지 않는다. **Core v0.1 Closure는 `CLOSURE_NOT_READY`이며, Gate D 완료 하나만으로는 선언할 수 없다 — Audit log/evidence retention 계약 충분성 검증(현재 PARTIAL)이 함께 충족되어야 한다(§12).** 이 세션에서 이루어진 그 외 방대한 설계 작업(JARVIS M2, QA, Knowledge, Skill, Permission, Workspace 등)은 저장소에 문서화되지 않은 상태이며, 이는 로드맵 갱신의 근거로 아직 사용할 수 없다는 것이 이번 조사의 중요한 발견이다.
