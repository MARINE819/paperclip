# NEXORA 첫 Business Pilot 준비 계획 — "CEO용 일일 요약 보고서" (READ-ONLY 설계)

**작성일:** 2026-09-07
**단계:** 설계 문서 작성만. 코드/스키마/프로세스/DB/Approval/Issue 상태 변경 없음. Gate D(PID 17652)·핵심 프로세스 조회·개입 없음.
**전제 조건(절대)**: 이 Pilot은 **Gate D 완료(24시간 관찰 종료, T24=2026-09-08 01:25:44 KST) AND Audit retention 판정이 `PARTIAL`에서 벗어난 뒤에만 실행한다.** 현재 두 조건 모두 미충족(Gate D=OBSERVING, Audit retention=PARTIAL) — 이 문서는 실행 계획이 아니라 **실행 전 준비 문서**다.

---

## 1. Pilot 목표

회사 내부 Issue·운영 문서·작업 증거(work product)를 수집해 CEO가 매일 훑어볼 수 있는 1건의 요약 보고서를 자동 생성한다. 성공 기준은 "사람이 손으로 모으던 정보를 Agent가 대신 모아, 근거 링크가 달린 요약을 하루 1회 만들어낸다"는 것이지, 판단·의사결정을 대신하는 것이 아니다(요약과 사실 수집에 한정, 전략적 권고는 범위 밖).

## 2. 입력 자료

- `issues`: 최근 24시간(또는 지정 기간) 내 상태 변경·생성·완료된 Issue(우선순위/담당자/상태 포함).
- `activity_log`: 같은 기간의 주요 action(승인, 완료, 차단, 재시도 등) — 이미 이번 세션에서 정밀 감사한 `activity_log` 인프라를 그대로 재사용(CONFIRMED, 72개 파일에서 사용 중인 표준 경로).
- `issue_work_products`: 같은 기간 등록된 증거/산출물 링크.
- `approvals`/`issue_approvals`: 대기 중이거나 처리된 승인 목록.
- (선택) `heartbeat_runs` 실패/재시도 요약 — "무엇이 막혀 있는가"를 보여주기 위함.

읽기 범위는 **해당 회사(companyId) 스코프로만 제한**하며(§7 activity_log의 companyId FK 스코프 원칙 재사용), 다른 회사 데이터를 넘나들지 않는다.

## 3. 예상 출력 보고서

1건의 구조화된 Markdown(또는 Issue 코멘트) 보고서, 다음 절을 포함:
- 오늘 완료된 Issue 목록(담당자·소요시간·근거 링크)
- 오늘 새로 생성/차단된 Issue와 그 사유
- 대기 중인 Human 승인 목록(있으면 최우선 노출)
- 실패/재시도 중인 작업과 원인 요약
- 등록된 증거(work product) 링크 색인
- "CEO가 오늘 결정해야 할 것" 섹션(사실 나열, 권고 아님)

## 4. 담당 Agent 역할

- **CONFIRMED(저장소 근거 있음)**: `server/phase2-agent-org-assignment.ts:101-111`에 이름 "백지수", `orgName: '지식·문서팀'`, `title: '지식·문서팀장'`, `reportsTo: JARVIS_ID`로 정의된 org 템플릿이 실제로 존재하며, 역할 설명이 "지식 관리(Durable Knowledge Base) 보존 및 문서 인덱싱을 담당"으로 명시되어 있어 이 Pilot의 성격(문서 수집·정리·요약)과 정확히 부합한다.
- **PROPOSED(재확인 필요)**: 이 역할 템플릿이 대상 회사 인스턴스에 실제로 프로비저닝되어 "active" 상태로 살아있는지, 정확한 live agent UUID가 무엇인지는 이번 라운드에서 **API 조회가 금지**되어 있어 재확인하지 못했다. (과거 세션의 한 시점에는 UUID `528bfd19-...`로 조회된 기록이 있었으나, 그 스냅샷은 이번 라운드의 저장소 파일 근거가 아니라 이전 라운드의 live API 응답이었으므로 시간 경과에 따라 stale할 수 있다 — Closure 이후 실행 직전에 **READ-ONLY GET으로 반드시 재조회**할 것.)
- 대안 담당자 부재 시: JARVIS가 기존 역할 정의에서 "지식/문서" 카테고리에 해당하는 active agent를 §6의 배분 방식대로 선택하도록 위임(고정된 이름에 의존하지 않는 설계).

## 5. JARVIS 업무 분배 방식

`doc/plans/nexora-jarvis-m2-qa-knowledge-governance-design-2026-09-07.md`에서 확정한 **NOW(CONFIRMED)** 범위 안에서만 설계한다 — 즉 M1 단일-전문가 위임 루프만 사용하고, 아직 PROPOSED인 M2 다중-자식/독립 QA 레인에는 의존하지 않는다.
- Human이 "오늘의 CEO 요약 보고서 만들기" 요청을 1회 제출(JARVIS intake, `submitToJarvis` 경로 — CONFIRMED 코드 존재).
- JARVIS가 parent Issue를 만들고, 지식/문서 담당 agent(§4)에게 **단일 child Issue**로 위임(M1 검증된 단일-전문가 경로 재사용, 다중 child 분해는 이번 Pilot 범위에서 굳이 필요하지 않음 — 데이터 수집·요약은 한 agent가 끝까지 수행 가능한 작업 크기로 설계).
- Agent가 §2의 자료를 읽어 §3의 보고서를 작성하고, `issue_work_products`에 산출물(보고서 문서)을 등록.
- JARVIS가 evidence-acceptance(코드 존재 확인됨, CONFIRMED)로 산출물 등록 여부를 검증한 뒤 parent를 aggregate·보고.

## 6. Human Approval이 필요한 단계

- **불필요(JARVIS/agent 자율 범위)**: Issue/activity_log/work_products **읽기**, 보고서 **초안 작성**, 보고서를 parent Issue 코멘트로 게시.
- **필요(Human Approval Gate)**: 이 Pilot을 정기 자동 실행(예: 매일 자동 트리거)으로 전환하는 결정 — 최초 1회는 수동 트리거로 실행하고, 자동화 여부는 별도 Human 승인 사항으로 분리한다. 보고서에 회사 재무·인사 등 민감 범주 데이터가 섞여 나올 가능성이 있다면 그 항목만 별도 마스킹 여부를 Human이 결정.
- **CEO 열람 자체는 승인 대상 아님** — 이 Pilot의 출력은 정보 제공용이며 governed action이 아니므로(§6.1 JARVIS 설계 문서의 "JARVIS may decide autonomously" 범주: "retrieve relevant company-visible context", "aggregate results and register/link evidence"에 해당).

## 7. 성공/실패 판정

- **성공**: 보고서 1건이 생성되고, §3의 필수 절이 모두 채워지며, 언급된 모든 Issue/증거 링크가 실제로 열람 가능(evidence-acceptance 통과)하고, 보고서 작성 자체가 activity_log에 기록된다.
- **부분 성공**: 일부 섹션에 데이터가 없어 비어 있음(예: 오늘 실패한 작업이 없음)은 실패가 아니라 정상 — 반드시 "해당 없음"으로 명시해야 하며, 조용히 섹션을 생략하면 실패로 간주.
- **실패**: 보고서가 생성되지 않음, 링크가 깨짐(work product 미등록 텍스트만 존재), 다른 회사 데이터가 섞여 들어감, 또는 agent가 스스로 parent를 `done`으로 완료(§6.4 JARVIS 설계 문서가 금지하는 자기 완료 — 이 Pilot도 예외 없이 적용).

## 8. Evidence/Artifact

- 최종 보고서 자체를 `issue_work_products`에 artifact로 등록(단순 코멘트 텍스트로만 남기지 않음 — `jarvis-delegation-loop-design.md` §9.4 "Filenames in comments are descriptions, not registered evidence" 원칙 재사용).
- 보고서 생성 행위 자체가 `activity_log`에 남아야 한다(누가/언제 생성했는지 사후 재구성 가능해야 함 — 이번 세션의 Audit retention 감사 원칙과 동일 기준 적용).

## 9. 중단 조건

- 대상 회사의 `status`가 `active`가 아님(archived/paused) — Emergency Stop 가드(이번 세션에서 이미 검증된 `companies.status === "active"` heartbeat 가드)에 의해 자동으로 실행되지 않음, 이 Pilot이 별도로 우회하지 않는다.
- 필요한 최소 데이터(예: 지난 24시간 activity_log가 전혀 없음)가 없으면 "데이터 없음" 보고서를 내고 종료 — 억지로 내용을 만들어내지 않는다.
- 담당 agent가 §4의 역할과 맞지 않거나 invokable하지 않으면 JARVIS가 blocked로 보고하고 Human에게 대안 agent 지정을 요청.
- 개인정보/민감정보로 의심되는 원문이 그대로 보고서에 노출되면 즉시 중단하고 마스킹 재작업.

## 10. 재시도 및 Resume

- M1에서 이미 검증된 `heartbeat_runs.scheduledRetryAttempt`/`scheduledRetryReason`/`retryOfRunId` 계보를 그대로 사용(신규 재시도 메커니즘을 만들지 않음).
- 재시도는 "일시적 실패"(예: 일시적 DB 조회 오류)에 한정하고, 정책적으로 유한 횟수로 제한한다(이 Pilot 전용 상한을 명시적으로 정의하는 것을 실행 전 체크리스트 항목으로 둔다 — 이번 문서에서 구체적 숫자는 확정하지 않음, PROPOSED).
- 데이터 자체가 불충분해서 실패한 경우(재시도해도 달라지지 않는 경우)는 재시도 대상이 아니다 — 즉시 "데이터 없음" 보고로 종료.

## 11. 비용·시간 한도

- **PROPOSED(확정 필요)**: 이 Pilot 1회 실행의 토큰/비용/소요시간 상한은 이번 문서에서 구체적 수치를 확정하지 않는다 — 담당 agent가 읽어야 할 데이터 양(회사 규모에 비례)에 따라 달라지므로, 실행 전 체크리스트(§13)에서 최초 1회는 상한 없이 실행해 실측한 뒤, 그 실측값을 기준으로 상한을 정하는 것을 권장한다.
- `cost_events.heartbeatRunId`가 이미 각 실행의 비용을 run 단위로 추적하는 인프라이므로(CONFIRMED, 이번 세션 Task 1 문서에서 재확인), 별도 신규 비용 추적 장치를 만들 필요는 없다 — 기존 인프라로 사후 집계 가능.

## 12. 개인정보·보안 제한

- 보고서는 **회사 내부 운영 데이터**만 다루며, 개인 식별 정보(직원 이메일/실명 등)를 CEO 요약에 그대로 노출할지는 이 회사의 기존 마스킹 정책(`activity-log.ts`의 `redactActivityDetails`가 저장 시점에 이미 적용하는 것과 동일한 원칙)을 재사용해 최소화한다.
- 시크릿/토큰/API 키 값은 원문이든 요약이든 절대 포함하지 않는다 — 이 Pilot의 입력 자료(§2)에는 애초에 시크릿 테이블을 포함하지 않는다(설계 단계에서 배제).
- 보고서는 해당 회사 스코프를 벗어나 다른 회사나 외부로 전송되지 않는다(companyId 경계 준수, 이번 세션에서 반복 확인한 원칙).

## 13. 실행 전 체크리스트 (Closure 이후, 실제 트리거 전에 확인)

1. Gate D `pass=true`로 24시간 관찰 완료(현재 미충족).
2. Audit retention 판정이 `PARTIAL`에서 벗어남(최소한 C-lite 구현·검증 완료, 또는 별도 Human이 현재 PARTIAL 상태를 "Pilot 실행에는 지장 없음"으로 명시적으로 승인).
3. §4의 담당 agent가 대상 회사에서 실제로 active/invokable한지 READ-ONLY GET으로 재조회(이번 라운드에서 하지 않음, Closure 이후 별도 수행).
4. 대상 회사의 `status === "active"` 확인.
5. §11의 비용·시간 상한을 실측 기반으로 확정(최초 1회 실행 후).
6. §9의 중단 조건과 §10의 재시도 상한을 코드/정책으로 명문화(현재는 설계 문서 단계).
7. Human이 "최초 1회 수동 트리거"를 명시적으로 승인(자동화 전환은 별도 승인).

## 14. Gate D와 Audit retention 완료 전 미실행 조건 (재확인)

이 문서 자체가 Gate D `OBSERVING` 및 Audit retention `PARTIAL` 상태에서 작성되었으며, **두 조건이 해소되기 전까지 이 Pilot을 실제로 트리거하지 않는다.** 이 문서는 준비 계획이며, 승인·실행 요청이 아니다.
