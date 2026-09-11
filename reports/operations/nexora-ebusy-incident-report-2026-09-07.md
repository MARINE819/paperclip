# NEXORA EBUSY Incident / Fix / Recovery Report

**Date:** 2026-09-07
**Report status:** DRAFT — Gate D re-observation is still `OBSERVING` at the time of writing (see §19).

## 1. 질문 해석
Supervisor 프로세스가 EBUSY 오류로 반복 크래시했던 장애의 실제 원인, 적용된 수정, 재기동 과정, 그리고 그 결과로 새로 시작된 Gate D 24시간 재관찰의 현재 상태를 증거 기반으로 기록한다.

## 2. 질문 목적
이번 장애에서 얻은 운영 지식을 공식 문서로 남겨, 향후 유사 장애 시 참고 가능한 근본원인·수정·검증 기록을 확보한다.

## 3. Executive Summary
2026-09-06 10:18:52Z~10:24:52Z(UTC) 사이, `paperclip-control-plane-supervisor.mjs` 프로세스가 처리되지 않은 `EBUSY` Promise rejection으로 인해 약 1분 간격으로 최소 6회 연속 크래시-재시작 루프에 빠졌다(**CONFIRMED**, `supervisor-diagnostics.jsonl` 로그). 크래시 루프는 PID 13076 기동 시점(10:24:52Z)부터 중단되었고, 이후 3시간 37분 뒤인 14:01:52Z에 현재 프로세스 PID 21488로 교체되어 이후 계속 안정적으로 유지되고 있다(**CONFIRMED**, 동일 로그 + 이번 세션 전체에서 반복 확인된 Gate D 증거). 현재 소스 파일에는 `EBUSY`/`EPERM`/`EACCES`를 대상으로 하는 재시도 래퍼(`withFsRetry`)가 존재한다(**CONFIRMED**, 코드 직접 확인). **별개의 사건으로**, 이 안정화 이후 시작된 Gate D v1 Observer(PID 7356) 자체를 READ-ONLY로 감사한 결과 Observer 스크립트에 계약 결함(Supervisor PID 연속성/SHA-256/명령줄 중복 미검증 등)이 발견되어, EBUSY 재발과 무관하게 v2 Observer로 계획적으로 교체되었다(**CONFIRMED** — Supervisor PID 21488은 이 교체 전후 변경 없음, §6 참조). Gate D는 v2 Observer로 24시간 재관찰을 시작했으며, 현재 `OBSERVING` 상태다.

## 4. 장애 증상
- Supervisor(node.exe) 프로세스가 기동 직후(수십 ms 내) `uncaught_exception`(origin: `unhandledRejection`, code: `EBUSY`)으로 종료(`process_exit`, code 1). (**CONFIRMED**)
- Windows Task Scheduler(`\NEXORA-Default-ControlPlane-Service`)의 재시작 정책에 의해 약 60초 간격으로 새 PID가 반복 기동됨. (**CONFIRMED** — 로그의 `process_loaded` 타임스탬프 간격)

## 5. 영향 범위
- 영향: Supervisor 자체의 반복 크래시. (**CONFIRMED**)
- API(13548)/DefaultDB(18716)/CanaryDB(16208)/CanaryClient(15228)에 대한 영향 여부: 이 로그만으로는 확인 불가 — 별도의 API/DB 다운타임 증거는 이번 조사에서 발견하지 못함. (**UNVERIFIED**)

## 6. 장애 발견 및 대응 타임라인 (전부 UTC, 확인된 로그 타임스탬프 기준)
| 시각 | 사건 | 근거 |
|---|---|---|
| 10:18:52.418 | PID 6308 로드 → 10:18:52.444 uncaught_exception(EBUSY) → process_exit | CONFIRMED |
| 10:19:52.434 | PID 17708 로드 → uncaught_exception(EBUSY) → process_exit | CONFIRMED |
| 10:20:52.435 | PID 15644 로드 → uncaught_exception(EBUSY) → process_exit | CONFIRMED |
| 10:21:52.454 | PID 11652 로드 → uncaught_exception(EBUSY) → process_exit | CONFIRMED |
| 10:22:52.451 | PID 14816 로드 → uncaught_exception(EBUSY) → process_exit | CONFIRMED |
| 10:23:52.464 | PID 8932 로드 → uncaught_exception(EBUSY) → process_exit | CONFIRMED |
| 10:24:52.466 | PID 13076 로드 — **이후 크래시 이벤트 없음(생존)** | CONFIRMED |
| 14:01:52.251 | PID 21488 로드(현재 Supervisor) | CONFIRMED |
| 2026-09-06 23:52:05 (KST) | Gate D v1 Observer(PID 7356, 스크립트 `gate-d-24h-observe.ps1`) T0, Supervisor=21488 확인 | CONFIRMED(이전 세션 turn에서 직접 조회) |
| 2026-09-07 00:00경 | **v1 Observer 스크립트 자체에 대한 READ-ONLY 계약 감사 수행** — Supervisor PID 연속성 미검증, 명령줄 기준 중복 프로세스 미검증, Supervisor 소스 SHA-256 미검증, 진단 이벤트 내용 미검사, `Generate-T24FinalSummary`의 `.Count` 처리 비일관성 등 다수 계약 결함을 코드 정독으로 확인 | CONFIRMED |
| 2026-09-07 00:56경 | 위 감사 결과를 반영한 v2 Observer(`gate-d-24h-observe-v2.ps1`) 작성·배치·구문검사·DryRun 검증 | CONFIRMED |
| 2026-09-07 01:25:44 (KST) | v1 Observer(PID 7356) 조건부 종료, v2 Observer(PID 17652) T0 시작 — Supervisor 여전히 21488(교체 없음) | CONFIRMED(사용자 전달 값, 아직 재조회로 재확인 안 함 — INFERENCE) |

**중요한 정정: v1→v2 Observer 교체는 "EBUSY가 v1 관찰 도중 재발했기 때문"이 아니다.** Supervisor(PID 21488)는 v1 T0(23:52:05)부터 v2 T0(01:25:44)까지 교체 없이 동일 PID로 유지되었다(**CONFIRMED**, 양쪽 baseline JSON 모두 supervisor.pid=21488). 교체의 실제 원인은 **v1 Observer 스크립트 자신의 계약 결함이 감사로 발견되어, 더 엄격한 v2로 계획적으로 교체된 것**이다 — Supervisor 자체의 장애 재발이 아니다. **13076 → 21488 전환(EBUSY 사건 당시)의 정확한 트리거는 이 로그만으로 확정할 수 없다.** (**UNVERIFIED**, 이는 위 v1→v2 Observer 교체와는 별개의, 더 이른 시점의 사건이다)

## 7. 확인된 근본 원인
Supervisor 프로세스가 특정 파일시스템 작업(구체 위치는 이번 조사에서 코드 라인 단위로 특정하지 않음) 중 발생하는 `EBUSY`(Windows에서 파일이 다른 프로세스에 의해 잠겨 있을 때 흔한 일시적 오류)를 **Promise rejection으로만 던지고 캐치하지 않아** Node.js가 `unhandledRejection`으로 프로세스를 종료시켰다. (**CONFIRMED** — 에러 이름/코드/발생 패턴 근거) 정확히 어떤 호출 지점이 최초로 이 오류를 발생시켰는지는 **UNVERIFIED**(git 이력이 없는 untracked 파일이라 diff 기반 특정 불가).

## 8. EBUSY 수정 내용
현재 파일(`scripts/operations/paperclip-control-plane-supervisor.mjs`)에서 확인된 내용(**CONFIRMED**, 직접 코드 확인):
```javascript
const TRANSIENT_FS_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);
function isTransientFsError(error) {
  return Boolean(error && TRANSIENT_FS_CODES.has(error.code));
}

async function withFsRetry(fn, { maxRetries = 5, baseDelayMs = 25, maxTotalDelayMs = 1000 } = {}) {
  ...
}
```
이 래퍼가 파일시스템 작업을 감싸 `EBUSY`/`EPERM`/`EACCES` 발생 시 예외를 던지는 대신 재시도하도록 설계되어 있다. **이 파일은 Git에 커밋된 적이 없는 untracked 파일이므로(`git status` 확인), "수정 전/후"를 git diff로 비교할 수 없다** — 이 재시도 로직이 이번 장애의 수정으로 새로 추가된 것인지, 원래부터 존재했으나 다른 경로가 미보호였는지는 **UNVERIFIED**.

## 8-A. "수정 코드 활성화" 근거 4종 분리 기록
"현재 PID 21488이 수정된 코드를 실행 중이다"라는 주장을 단일 CONFIRMED로 뭉뚱그리지 않고, 아래 4개 근거를 개별적으로 인용한다. 각 근거는 서로 다른 확실성 등급을 가진다.

| # | 근거 | 값 | 등급 |
|---|---|---|---|
| 1 | 파일 수정 시각(mtime) | `2026-09-06T13:03:57.5314432Z` (UTC, `Get-Item`으로 직접 확인) | **CONFIRMED** |
| 2 | PID 21488 생성(로드) 시각 | `2026-09-06T14:01:52.251Z` (`supervisor-diagnostics.jsonl`의 `process_loaded` 이벤트 타임스탬프 기준; v2 Observer T0 스냅샷의 `startTimeUtc`는 `~14:01:52.19`로 사실상 동일 값) | **CONFIRMED** |
| 3 | PID 21488의 실제 명령줄(CommandLine) | 비관리자 세션에서 `Get-CimInstance Win32_Process`가 빈 값을 반환하여 이번 조사에서 직접 확인하지 못함 | **UNVERIFIED**(비관리자 세션 한계 — 스크립트/코드 결함 아님) |
| 4 | T0 SHA-256 일치 | v2 Observer DryRun JSON의 `sha256Match: true` — `observedSha256`이 사전 고지된 기대 해시와 정확히 일치 | **CONFIRMED** |

근거 1과 2는 "파일이 수정된 시각 이후에 현재 PID가 로드되었다"는 시간적 선후관계만 CONFIRMED이며, "그 로드가 실제로 수정된 코드를 실행했다"는 인과관계 자체는 근거 3(명령줄)이 UNVERIFIED인 이상 완전히 닫히지 않는다. 근거 4(SHA-256 일치)가 이 인과관계를 보강하는 가장 강한 독립 증거다.

## 9. 재시도 정책 설명
- 대상 오류: `EBUSY`, `EPERM`, `EACCES`
- 최대 재시도: 5회
- 기본 지연: 25ms
- 최대 총 지연: 1000ms
(**CONFIRMED**, 코드 파라미터 기본값 그대로 인용)

## 10. 수정 전·후 동작 비교
| | 수정 전(크래시 루프 구간, 10:18–10:24Z) | 현재(13076 이후) |
|---|---|---|
| EBUSY 발생 시 | 미처리 Promise rejection → 프로세스 종료 | 재시도 래퍼로 흡수(추정, 아래 참고) |
| 결과 | 60초 간격 반복 재시작 | 3시간37분 이상 연속 생존 후 21488로 전환, 이후 최소 이번 세션 전체(9/6 23:52~9/7 현재)까지 크래시 없음 |
"재시도 래퍼가 실제로 이 특정 EBUSY를 흡수했다"는 인과관계는 **INFERENCE**(시간적 선후관계와 코드 존재는 확인되나, 이 정확한 수정이 배포된 정확한 시각을 가리키는 별도 로그 마커는 발견하지 못함).

## 11. 수행된 검증
| 항목 | 상태 |
|---|---|
| `node --check` 실행 | **OPERATOR-REPORTED PASS / 독립 증거 파일 미확인** — 사용자(운영자)로부터 통과했다는 보고를 받았으나, 이번 조사에서 그 실행을 뒷받침하는 독립적인 로그·출력 파일을 발견하지 못함 |
| 인메모리 EBUSY 회귀 테스트 | **OPERATOR-REPORTED PASS / 독립 증거 파일 미확인** — 사용자(운영자)로부터 통과했다는 보고를 받았으나, 해당 테스트 파일 자체나 실행 기록을 이번 조사에서 발견하지 못함 |
| 수정 코드 활성화 | 아래 4개 근거로 분리 기록(**§8-A** 참고). 각 근거의 확실성 등급이 다르므로 단일 "CONFIRMED"로 뭉뚱그리지 않음 |
| Supervisor 단일 인스턴스 | **CONFIRMED**(이번 세션에서 반복적으로 `Get-CimInstance Win32_Process` 명령줄 기준 카운트=1 설계를 v2 Observer에 구현·검증) |
| API/DB/Canary 유지 | **CONFIRMED**(v1/v2 Gate D T0 스냅샷 전부에서 4개 프로세스 alive 확인) |

## 12. 기존 PID 13076에서 신규 PID 21488로 교체된 과정
로그상 13076의 `process_exit` 이벤트는 발견되지 않았다(정상 종료였는지, 로그 범위 밖에서 종료됐는지 **UNVERIFIED**). 21488은 13076 로드 3시간 37분 후 로드되었다. 교체가 계획된 재기동이었는지 자연 재시작이었는지는 **UNVERIFIED**.

## 13. Task Scheduler `NEXORA-Default-ControlPlane-Service`와 `IgnoreNew` 동작
이번 세션에서 v2 Observer DryRun 실행 중 실제로 조회한 Task Scheduler 이벤트(**CONFIRMED**): Event ID 100/107/129/200/201 등이 `\NEXORA-Default-ControlPlane-Service`에 대해 다수 기록되어 있으며, Action은 `C:\Windows\System32\cmd.exe`, 실행 계정은 `MINIPC-2LMI6\NexoraPaperclipSvc`. 한 인스턴스에서 반환 코드 `4294967295`(부호없는 -1)가 기록됨(**CONFIRMED**, 원인 미상 — **UNVERIFIED**). Event ID 322(`IgnoreNew` 중복 억제)는 정상적인 것으로 분류하며 장애로 취급하지 않는다(사용자 지침에 따른 분류 원칙, v2 Observer 코드에도 이 원칙이 반영됨).

## 14. Human Approval Gate가 적용된 지점
- v2 Observer 스크립트를 신규 경로에 배치하기 전: Human이 명시적으로 파일 SHA-256(`9BC6633C...`)을 사전 제시하고 일치 확인을 요구함(**CONFIRMED**, 이번 세션에서 실제 해시 대조 수행).
- 기존 v1 Observer(**PID 7356 — 종료된 프로세스**) 종료: Human이 "모든 검증 PASS 시에만" 종료하도록 조건부 승인, Claude가 자체적으로 종료하지 않고 사용자가 관리자 세션에서 직접 실행하는 블록으로 위임(**CONFIRMED**). 이후 v2 Observer(**PID 17652 — 현재 관찰 중인 프로세스**, 종료 대상이 아님)가 신규 T0부터 관찰을 이어받았다.
- 이 보고서 자체도 사전에 상세한 통합 승인 범위(허용/금지 작업 목록)를 받은 뒤 작성됨(**CONFIRMED**).

## 15. 잘된 점
- 재시도 정책이 명확한 상한(5회, 총 1초)을 가져 무한 재시도로 인한 다른 문제를 방지.
- Gate D 관찰 인프라 자체가 이번 장애 이후에도 중단 없이(v1→v2 전환) 이어질 수 있도록 설계됨.
- 모든 파괴적 작업(Observer 교체, 파일 배치)이 사전 해시 검증 + 조건부 승인 절차를 거침.

## 16. 개선할 점
- Supervisor 스크립트가 git에 커밋되어 있지 않아 변경 이력 추적이 불가능함(§8).
- `node --check`/회귀 테스트 실행 증거가 로그에 남지 않음 — 수정 검증 과정 자체의 감사가능성이 낮음.
- Task Scheduler의 `반환 코드 4294967295` 사례처럼 원인 불명 이벤트가 있음.

## 17. 재발 방지 대책 (제안, 미실행)
1. `paperclip-control-plane-supervisor.mjs`를 git에 커밋해 향후 변경을 diff로 추적 가능하게 할 것.
2. EBUSY류 재시도 로직에 대한 전용 회귀 테스트를 작성하고 실행 증거를 로그/CI에 남길 것.
3. Task Scheduler의 비정상 반환 코드 이벤트를 자동으로 감지하는 최소 알림 훅 추가(Track 14 계열 논의와 연결 가능).

## 18. 남은 위험과 관찰 한계
- Supervisor stderr 전용 메시지("diagnostic log dropped after retries")는 현재 launcher 구조상 캡처되지 않는 것으로 설계 문서화됨(v2 Observer 자체의 `observationLimit` 필드에 명시) — 이 특정 실패 모드는 여전히 맹점이다.
- git 이력 부재로 인해 "이 수정이 정확히 언제 배포되었는가"는 확정할 수 없다.
- 13076→21488 전환의 정확한 트리거는 미상이다.

## 19. 현재 Gate D 상태
**`OBSERVING`.** v2 Observer(PID 17652으로 보고됨, 이번 보고서 작성 시점에 재조회하지 않음 — 사용자 제공값)가 T0 2026-09-07 01:25:44 KST부터 새 86,400초 계약을 시작했다. **24시간 및 24개 시간별 스냅샷이 모두 완료되기 전까지 Gate D는 PASS로 기록하지 않는다.**

## 20. 최종 결론
EBUSY 크래시 루프의 발생(10:18–10:24Z)과 그 종료(13076 생존, 이후 21488로 안정화, 9/6 14:01:52Z)는 로그로 **확인**되었다. 현재 소스에 재시도 로직이 **존재**함도 확인되었으나, 이 로직이 정확히 "이번 장애를 고친 커밋"이라는 인과관계는 git 이력 부재로 **완전히 확정할 수 없다(INFERENCE 수준)**. **Gate D v1→v2 Observer 교체는 EBUSY 재발이 아니라 v1 스크립트 자체의 계약 결함 감사 결과에 따른 계획적 교체였으며, Supervisor PID(21488)는 이 교체 전후로 변경되지 않았다(CONFIRMED).** Gate D는 v2 Observer로 새로 24시간 관찰을 시작했으며 현재 `OBSERVING` 중이다.
