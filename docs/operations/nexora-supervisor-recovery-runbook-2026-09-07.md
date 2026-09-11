# NEXORA Supervisor 장애 대응 Runbook

**작성일:** 2026-09-07
**적용 대상:** `paperclip-control-plane-supervisor.mjs` (Windows, Task Scheduler `\NEXORA-Default-ControlPlane-Service`로 기동)

## 1. 문서 목적과 적용 범위
Supervisor 프로세스에 이상이 의심될 때, 다른 운영자나 AI Agent가 API/DB/Canary를 포함한 전체 서비스를 불필요하게 재시작하지 않고, Supervisor 하나만 안전하게 진단·복구할 수 있도록 재현 가능한 순서를 제공한다. 이 문서는 Supervisor에만 적용되며, API/DB/Canary 자체의 장애 대응은 범위 밖이다.

## 1-A. PID 값에 대한 필수 주의사항
이 문서에 등장하는 모든 PID(Supervisor=21488, API=13548, DefaultDB=18716, CanaryDB=16208, CanaryClient=15228)는 **2026-09-07 기준 관측값일 뿐, 영구 고정값이 아니다.** 재부팅, 재기동, Windows 업데이트 등으로 언제든 바뀔 수 있다. **이 Runbook을 실행할 때마다 §5(READ-ONLY 초기 점검)로 현재 실제 PID를 매번 새로 조회해야 하며, 이 문서에 적힌 숫자를 그대로 신뢰하고 조치하지 않는다.**

## 2. 절대 금지사항
- PID 숫자 하나만 보고 그것이 맞다고 가정하지 않는다.
- 명령줄/소유자/생성시각/SHA-256 중 하나라도 확인하지 않은 채 프로세스를 종료하지 않는다.
- Supervisor 문제인데 API/DB/Canary까지 재시작 범위를 확대하지 않는다.
- 관리자 권한이 없는 세션에서 우회 방법을 찾지 않는다 — 중단하고 보고한다.
- Task Scheduler 설정을 별도 승인 없이 변경하지 않는다.
- Human Approval 없이 실제 종료/재기동 명령을 실행하지 않는다.
- Gate D 관찰이 진행 중이면 그 Observer 프로세스 자체를 건드리지 않는다(증거 파일만 읽는다).

## 3. 장애 등급
| 등급 | 정의 | 예시 |
|---|---|---|
| P1 | Supervisor 완전 부재, API/DB에 실질적 영향 발생 중 | 크래시 루프 + API 응답 없음 |
| P2 | Supervisor 부재이나 API/DB/Canary는 정상 | 단순 supervisor 프로세스만 다운 |
| P3 | Supervisor 정체성/무결성 의심(중복, SHA 불일치, PID 파일 불일치) | 명령줄 프로세스 카운트 ≠ 1 |
| P4 | 정보성 이상(Task Scheduler 반복 실행 이력 등, 현재 서비스 영향 없음) | Event ID 322 다수, 서비스 정상 |

## 4. 주요 증상
- **Supervisor 부재**: pid 파일 PID에 대해 `Get-Process`가 아무것도 반환하지 않음.
- **Supervisor 중복**: 명령줄 기준(`*paperclip-control-plane-supervisor.mjs*` 포함 + `--watch` 포함) 프로세스가 2개 이상.
- **EBUSY/EPERM/EACCES**: `supervisor-diagnostics.jsonl`에 `uncaught_exception`(code가 이 셋 중 하나) 반복 기록.
- **PID 파일 불일치**: pid 파일 내용과 실제 살아있는 프로세스 PID가 다름.
- **API 3100 비정상**: `/api/health`/`/api/health/ready` 실패 또는 포트 3100 소유 PID가 기대값(13548)과 다름.
- **Default DB 54329 비정상**: 포트 54329 소유 PID가 기대값(18716)과 다름 또는 리스닝 안 함.
- **Canary DB 54330 비정상**: 포트 54330 소유 PID가 기대값(16208)과 다름 또는 리스닝 안 함.
- **Task Scheduler 반복 실행/IgnoreNew**: `\NEXORA-Default-ControlPlane-Service`에 대해 짧은 간격의 반복 시작 이벤트 — Event ID 322만 있으면 정상(§12), 그 외 이벤트가 반복되면 P3/P4로 취급.

## 5. READ-ONLY 초기 점검 절차
어떤 조치도 하기 전에, 다음을 **하나의 명령 블록**으로 실행해 현재 상태를 스냅샷한다.
```powershell
# READ-ONLY. 아무것도 변경하지 않음.
Get-Content "$env:USERPROFILE\.paperclip\instances\default\logs\control-plane-supervisor.pid" -Raw
Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $PSItem.CommandLine -like "*paperclip-control-plane-supervisor.mjs*" } |
    Select-Object ProcessId, CreationDate, CommandLine
Get-NetTCPConnection -LocalPort 3100,54329,54330 -State Listen -ErrorAction SilentlyContinue |
    Select-Object LocalPort, OwningProcess
try { (Invoke-RestMethod -Uri "http://127.0.0.1:3100/api/health" -TimeoutSec 5).status } catch { "unreachable: $($PSItem.Exception.Message)" }
```

## 6. 현재 프로세스 신원·소유자·세션 확인 절차
```powershell
$candidatePid = <pid파일에서_읽은_값>
$proc = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$candidatePid"
$proc | Select-Object ProcessId, Name, CommandLine, SessionId
if ($proc) { Invoke-CimMethod -InputObject $proc -MethodName GetOwner }
```
**PID만으로 판단하지 않는다** — `Name=node.exe`, `CommandLine`에 정확한 스크립트 경로 포함, 소유 계정이 예상 서비스 계정(`NexoraPaperclipSvc`)인지까지 함께 확인한다.

## 7. PID 재사용 방지 확인 절차
Windows는 종료된 프로세스의 PID를 재사용할 수 있다. 과거에 기록된 PID를 보고 "살아있으니 맞다"고 판단하지 않는다. **실행 가능한 READ-ONLY 검증(예시, 그대로 복사해 사용 가능):**
```powershell
# READ-ONLY. 아무것도 변경하지 않음.
$candidatePid = <pid파일에서_읽은_값>
$expectedNotBeforeUtc = [DateTime]::Parse("<이전에 기록해 둔 '이 PID가 이 시각 이후여야 한다'는 기준시각, UTC>")
$expectedCommandFragment = "*paperclip-control-plane-supervisor.mjs*"

$proc = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$candidatePid" -ErrorAction SilentlyContinue
if (-not $proc) {
    "REUSE_CHECK: FAIL - process not found"
} else {
    $creationUtc = $proc.CreationDate  # CIM_DateTime, 자동으로 DateTime으로 변환됨
    $cmdOk = $proc.CommandLine -and ($proc.CommandLine -like $expectedCommandFragment)
    $timeOk = $creationUtc -ge $expectedNotBeforeUtc
    if ($cmdOk -and $timeOk) { "REUSE_CHECK: PASS - same identity" }
    else { "REUSE_CHECK: FAIL - cmdOk=$cmdOk timeOk=$timeOk (creation=$creationUtc)" }
}
```
CreationDate가 기대 범위를 벗어나거나 CommandLine이 다르면 **다른 프로세스가 같은 번호를 재사용한 것**으로 간주하고 §14로 진행하지 않는다.

## 8. Supervisor 명령줄 검증
```powershell
$cmd = (Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$candidatePid").CommandLine
$cmd -like "*paperclip-control-plane-supervisor.mjs*" -and $cmd -match '(?:^|\s)--watch(?:\s|$)'
```
`--watch` 플래그 부재는 다른 방식으로 기동된 프로세스일 가능성을 의미하므로 P3로 취급한다.

## 9. Supervisor 소스 SHA-256 검증
```powershell
(Get-FileHash -Algorithm SHA256 -LiteralPath "C:\Users\Nexora\paperclip\scripts\operations\paperclip-control-plane-supervisor.mjs").Hash
```
**Supervisor 버전 기준 기대값(2026-09-07 확인)**:
```
4C7FEE5A5FB6FB387FB5F1A52039E28FAE194C446358645250DA0899416FE2CE
```
불일치 시 **파일이 승인 없이 변경되었을 가능성** — 즉시 중단하고 보고, Human 확인 전까지 재기동하지 않는다. (이 값도 §1-A와 동일하게, Supervisor 소스가 정식으로 갱신되면 함께 갱신되어야 하는 값이다 — 영구 고정이 아니다.)

## 10. 포트와 소유 PID 검증 (IPv4/IPv6 전체 비교)
`Get-NetTCPConnection`은 IPv4/IPv6 리스너를 별도 행으로 반환할 수 있다 — **첫 번째 결과만 보지 말고, 해당 포트의 모든 리스닝 소유 PID를 중복 제거 후 전부 비교**한다.
```powershell
foreach ($p in 3100,54329,54330) {
    $listeners = @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
    $owningPids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    "$p -> owningPids=[$($owningPids -join ',')] addressFamilies=[$($listeners.AddressFamily -join ',')]"
}
```
**정상 조건**: `$owningPids`가 정확히 1개 값만 가지며(IPv4/IPv6 두 줄이 나오더라도 같은 PID여야 함), 그 값이 기대 PID(API=13548, DefaultDB=18716, CanaryDB=16208 — §1-A 기준 재조회 필요)와 정확히 일치해야 한다. `$owningPids.Count -gt 1`이면 **서로 다른 프로세스가 같은 포트를 나눠 갖고 있다는 이상 신호**이므로 즉시 중단·보고한다.

## 11. API health/ready 검증
```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3100/api/health" -TimeoutSec 5
Invoke-RestMethod -Uri "http://127.0.0.1:3100/api/health/ready" -TimeoutSec 5
```
`status: "ok"` / `status: "ready"` 확인.

## 12. Task Scheduler 상태·Action·Trigger·Principal 확인
```powershell
Get-ScheduledTask -TaskName "NEXORA-Default-ControlPlane-Service" |
    Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName "NEXORA-Default-ControlPlane-Service"
Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-TaskScheduler/Operational'} -MaxEvents 20 |
    Where-Object { $PSItem.Message -like "*NEXORA-Default-ControlPlane-Service*" } |
    Select-Object TimeCreated, Id, LevelDisplayName, Message
```
**Event ID 322는 `IgnoreNew`(이미 실행 중이므로 새 인스턴스 시작 안 함)에 의한 정상 중복 억제 기록으로 분류한다 — 장애로 취급하지 않는다.** 그 외 ID(특히 비정상 반환 코드를 포함하는 종료 이벤트)는 정보성으로 기록하되, 반복적이거나 명확한 실행 실패 패턴이면 P3/P4로 승격한다.

## 13. Human Approval Gate 요청 양식
```
[Supervisor 복구 승인 요청]
장애 등급: P_
현재 확인된 사실: (§5~12 결과 요약)
제안 조치: (예: Supervisor 프로세스 1개만 재기동)
영향 범위: (Supervisor만 / API/DB/Canary는 무영향 예상)
중단 조건: (재기동 후 §17 항목 중 하나라도 실패 시 즉시 중단)
검증 방법: (§17 목록)
승인 요청: YES/NO
```

## 14. Supervisor 단일 프로세스만 재기동하는 조건
다음이 **모두** 확인되어야 재기동을 제안할 수 있다:
- §5~11 점검에서 Supervisor **부재** 또는 **명확한 크래시 루프**가 확인됨(P1/P2).
- API(13548)/DefaultDB(18716)/CanaryDB(16208)/CanaryClient(15228)가 전부 정상(포트/health 기준).
- Supervisor 소스 SHA-256이 기대값과 일치(§9) — 파일 자체는 손상되지 않음.
- Human Approval을 받음(§13).

## 15. 절대 서비스 전체 재시작으로 확대하면 안 되는 이유
API/DB/Canary가 정상인 상태에서 이들까지 재시작하면 (1) 정상 서비스에 불필요한 중단을 야기하고, (2) Gate D 관찰이 진행 중이라면 그 증거를 오염시키며, (3) 실제 근본 원인이 Supervisor 국소 문제인 경우 문제 범위를 부풀려 진단을 어렵게 만든다. 최소 권한/최소 영향 원칙에 따라 Supervisor 단독 재기동만 승인 범위로 삼는다.

## 16. 재기동 전 사전검증
§5~12 전체를 재실행하고 결과를 승인 요청서(§13)에 첨부한다. 이 시점의 API/DB/Canary PID를 "재기동 후 비교 기준값"으로 별도 기록해 둔다.

## 16-A. Supervisor 단일 종료·Watchdog 재생성·신규 PID 검증 (예시 — **승인 후 실행**, 이번 문서에서 직접 실행하지 않음)
Supervisor는 Task Scheduler(`\NEXORA-Default-ControlPlane-Service`)가 Watchdog 역할을 하므로, Supervisor 프로세스 하나만 종료하면 Task Scheduler가 새 인스턴스를 자동으로 재기동한다 — **API/DB/Canary는 이 과정에서 건드리지 않는다.**

```powershell
# ⚠ 승인 후 실행. §13 승인 요청서로 Human Approval을 먼저 받을 것.
# ⚠ §5~12, §16의 사전검증이 전부 완료된 뒤에만 실행할 것.

$oldPid = <§6~7에서 확인한 현재 Supervisor PID>
$expectedCorePids = @{ API = <재조회값>; DefaultDB = <재조회값>; CanaryDB = <재조회값>; CanaryClient = <재조회값> }

# 1) Supervisor 단일 프로세스만 종료 (API/DB/Canary는 대상 아님)
Stop-Process -Id $oldPid -Force

# 2) Task Scheduler(IgnoreNew Watchdog)가 새 인스턴스를 재기동할 시간을 둔다 (최대 60초, 2초 간격 폴링)
$newProc = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    $candidate = Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*paperclip-control-plane-supervisor.mjs*" -and $_.ProcessId -ne $oldPid }
    if ($candidate) { $newProc = $candidate; break }
}
if (-not $newProc) { "FAIL: no new Supervisor process appeared within 60s" }
else { "New Supervisor PID: $($newProc.ProcessId)" }

# 3) 신규 PID 신원 검증 (§7~9 재적용)
$newPid = $newProc.ProcessId
(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$newPid").CommandLine -like "*--watch*"
(Get-Content "$env:USERPROFILE\.paperclip\instances\default\logs\control-plane-supervisor.pid" -Raw).Trim() -eq [string]$newPid
(Get-FileHash -Algorithm SHA256 -LiteralPath "C:\Users\Nexora\paperclip\scripts\operations\paperclip-control-plane-supervisor.mjs").Hash

# 4) 명령줄 기준 중복 Supervisor 프로세스가 정확히 1개인지 (§18)
@(Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*paperclip-control-plane-supervisor.mjs*" }).Count

# 5) API/DB/Canary PID가 재기동 전(§16 기준값)과 동일한지 — 바뀌었다면 즉시 중단·보고
foreach ($role in $expectedCorePids.Keys) {
    Get-Process -Id $expectedCorePids[$role] -ErrorAction SilentlyContinue
}
```
**하나라도 실패하면 §20(실패 시 즉시 중단 조건)에 따라 중단하고 원상 보존한 채 보고한다. API/DB/Canary 자체를 재시작하는 방향으로 확대하지 않는다(§15).**

## 17. 재기동 후 필수 검증
- 새 Supervisor PID가 살아있고 CommandLine이 §8 조건 충족.
- 명령줄 기준 Supervisor 프로세스가 정확히 1개(§18).
- pid 파일 내용이 새 PID와 일치.
- SHA-256이 여전히 기대값과 일치.
- API/DB/Canary PID가 §16에서 기록한 값과 **동일**(재기동으로 인해 이들이 바뀌지 않았어야 함).
- API health=ok, ready=ready.
- `supervisor-diagnostics.jsonl`에 재기동 이후 새로운 `uncaught_exception`/`process_exit`가 없음(최소 수 분 관찰).

## 18. 중복 프로세스 탐지
```powershell
@(Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $PSItem.CommandLine -like "*paperclip-control-plane-supervisor.mjs*" -and $PSItem.CommandLine -match '(?:^|\s)--watch(?:\s|$)' }).Count
```
결과가 1이 아니면 즉시 중단·보고(추가 인스턴스를 임의로 종료하지 않는다 — 어느 것이 "진짜"인지 오판할 위험).

## 19. 진단 로그 확인
```powershell
Get-Content "$env:USERPROFILE\.paperclip\instances\default\logs\supervisor-diagnostics.jsonl" -Tail 20
```
`process_loaded`의 pid가 기대 PID와 일치하는지, `process_exit`/`uncaught_exception`이 재기동 이후 발생했는지 확인한다. **주의(관찰 한계)**: supervisor stderr 전용 메시지("diagnostic log dropped after retries")는 현재 launcher 구조상 이 파일에 캡처되지 않는 것으로 알려져 있다 — 이 파일이 깨끗하다고 해서 그 특정 실패 모드가 없었다고 단정하지 않는다.

## 20. 실패 시 즉시 중단 조건
- §17 항목 중 하나라도 실패.
- API/DB/Canary PID가 재기동 전과 달라짐(예상치 못한 연쇄 효과).
- SHA-256 불일치가 재기동 후 새로 발견됨.
- 관리자 권한이 없어 명령줄/CIM 조회가 빈 값으로만 반환됨(→ 관리자 세션으로 전환하거나 중단).

## 21. 롤백 또는 안전한 보존 방법
Supervisor에는 "이전 버전으로 롤백"할 별도 아티팩트가 문서화되어 있지 않다(소스가 git 미추적 상태, 이 Runbook 작성 시점 기준 — §참고: EBUSY 인시던트 보고서 §16). 문제가 재발하면 **현재 실패 상태를 그대로 보존**(로그/증거 삭제 금지)하고, 파일을 임의로 수정하지 않은 채 원인 조사를 우선한다.

## 22. Gate D 재관찰이 필요한 조건
Supervisor를 실제로 재기동했다면(§14~17), 그 재기동은 Gate D 계약이 요구하는 "PID 연속성"을 깨뜨리므로 **진행 중이던 Gate D 관찰은 무효가 되며 새 T0로 재시작해야 한다.**

**구분 주의**: 2026-09-07의 실제 v1→v2 Observer 교체 사례는 이 조건과는 다른 사유였다 — 그때는 **Supervisor 자체를 재기동한 것이 아니라, Observer 스크립트(감시 도구) 자체의 계약 결함이 감사로 발견되어 더 엄격한 버전으로 교체**한 것이며, Supervisor PID(21488)는 그 교체 전후로 전혀 바뀌지 않았다. 즉 Gate D 재시작이 필요한 경우는 최소 두 가지로 구분해야 한다: (a) 이 절차서에 따라 **Supervisor 자체를 재기동**한 경우(§14~17), (b) **Observer 스크립트 자체에서 계약 결함이 발견**되어 더 나은 버전으로 교체하는 경우(Supervisor는 무관) — 둘 다 "새 T0로 재시작" 결론은 같지만 원인이 다르므로 보고서에 정확히 구분해 기록해야 한다.

## 23. 최종 보고 양식
```
[Supervisor 복구 완료 보고]
장애 등급:
근본 원인(CONFIRMED/INFERENCE/UNVERIFIED):
조치 내용:
재기동 전/후 PID:
검증 결과(§17 각 항목):
Gate D 영향: 재관찰 필요/불필요
잔여 위험:
```

## 24. 빠른 체크리스트
- [ ] §5 READ-ONLY 초기 점검 완료
- [ ] §6~9 신원/SHA-256 확인 완료
- [ ] §10~11 포트/API 확인 완료
- [ ] §12 Task Scheduler 확인(322는 정상 처리)
- [ ] 장애 등급 산정(§3)
- [ ] Human Approval 획득(§13) — **승인 후 실행**
- [ ] §14 조건 전부 충족 확인 후에만 재기동
- [ ] §17 재기동 후 검증 전부 PASS
- [ ] §22 Gate D 재관찰 필요 여부 판단 및 조치
- [ ] §23 최종 보고 작성
