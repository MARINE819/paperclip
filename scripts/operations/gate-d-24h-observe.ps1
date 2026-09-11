# scripts/operations/gate-d-24h-observe.ps1
# NEXORA Core Stability: Gate D 24-Hour Continuous Stability Observation Harness
# Strictly non-invasive, READ-ONLY observer. No process killing, no service modification.

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Background,
    [int]$DurationHours = 24,
    [int]$IntervalMinutes = 60,
    [string]$EvidenceSubdir = "gate-d-24h-stability"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repo = "C:\Users\Nexora\paperclip"
$evidenceDir = Join-Path (Join-Path $repo "docs\investigations\evidence") $EvidenceSubdir
$instanceDir = Join-Path $env:USERPROFILE ".paperclip\instances\default"
$logsDir = Join-Path $instanceDir "logs"
$supervisorPidFile = Join-Path $logsDir "control-plane-supervisor.pid"
$lifecycleLogFile = Join-Path $logsDir "control-plane-lifecycle.jsonl"
$alertsLogFile = Join-Path $logsDir "control-plane-alerts.jsonl"
$observerPidFile = Join-Path $evidenceDir "gate-d-observe.pid"

# Pinned expected baseline constants for Gate D
$script:ExpectedPorts = @{
    API        = 3100
    DefaultDB  = 54329
    CanaryDB   = 54330
    TargetFree = 55432
}
$script:ExpectedPids = [ordered]@{
    API          = 13548
    DefaultDB    = 18716
    CanaryDB     = 16208
    CanaryClient = 15228
}

function Ensure-EvidenceDir {
    if (-not (Test-Path -LiteralPath $evidenceDir)) {
        New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
    }
}

function Get-SupervisorInfo {
    $alive = $false
    $pidNum = $null
    $proc = $null
    if (Test-Path -LiteralPath $supervisorPidFile) {
        $val = (Get-Content -LiteralPath $supervisorPidFile -Raw).Trim()
        if ($val -match '^\d+$') {
            $pidNum = [int]$val
            $proc = Get-Process -Id $pidNum -ErrorAction SilentlyContinue
            $alive = $null -ne $proc
        }
    }
    return [ordered]@{
        alive        = $alive
        pid          = $pidNum
        startTimeUtc = $(try { if ($proc.StartTime) { $proc.StartTime.ToUniversalTime().ToString("o") } else { $null } } catch { $null })
        workingSetMb = $(try { [Math]::Round($proc.WorkingSet64 / 1MB, 2) } catch { $null })
    }
}

function Get-ProcessMetrics {
    param([int]$ProcessId, [string]$RoleName)
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $proc) {
        return [ordered]@{
            role                 = $RoleName
            expectedPid          = $ProcessId
            alive                = $false
            observedPid          = $null
            processName          = $null
            startTimeUtc         = $null
            workingSetMb         = $null
            privateMemoryMb      = $null
            totalProcessorTimeSec = $null
        }
    }
    return [ordered]@{
        role                 = $RoleName
        expectedPid          = $ProcessId
        alive                = $true
        observedPid          = $proc.Id
        processName          = $proc.ProcessName
        startTimeUtc         = $(try { if ($proc.StartTime) { $proc.StartTime.ToUniversalTime().ToString("o") } else { $null } } catch { $null })
        workingSetMb         = $(try { [Math]::Round($proc.WorkingSet64 / 1MB, 2) } catch { $null })
        privateMemoryMb      = $(try { [Math]::Round($proc.PrivateMemorySize64 / 1MB, 2) } catch { $null })
        totalProcessorTimeSec = $(try { if ($proc.TotalProcessorTime) { [Math]::Round($proc.TotalProcessorTime.TotalSeconds, 2) } else { $null } } catch { $null })
    }
}

function Get-PortStatus {
    param([int]$Port)
    $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    $firstPid = if ($listeners) { @($listeners)[0].OwningProcess } else { $null }
    return [ordered]@{
        port         = $Port
        listening    = ($null -ne $listeners -and @($listeners).Count -gt 0)
        owningPid    = $firstPid
        listenerCount = if ($listeners) { @($listeners).Count } else { 0 }
    }
}

function Get-ConnectionCount {
    param([int]$Port, [int]$ClientPid)
    $conns = Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object {
        ($_.LocalPort -eq $Port -or $_.RemotePort -eq $Port) -and
        $_.State -eq "Established" -and
        $_.OwningProcess -eq $ClientPid
    }
    if ($conns) { return @($conns).Count } else { return 0 }
}

function Get-FileLineCount {
    param([string]$FilePath)
    if (-not (Test-Path -LiteralPath $FilePath)) { return 0 }
    try {
        return [System.IO.File]::ReadLines($FilePath).Count
    } catch {
        return (Get-Content -LiteralPath $FilePath).Count
    }
}

function Query-ApiHealth {
    $readyStatus = "unreachable"
    $readyBody = $null
    try {
        $readyRes = Invoke-RestMethod -Uri "http://127.0.0.1:3100/api/health/ready" -TimeoutSec 5 -ErrorAction Stop
        $readyStatus = if ($readyRes.status) { $readyRes.status } else { "unknown" }
        $readyBody = $readyRes
    } catch {
        $readyStatus = "error: " + $_.Exception.Message
    }

    $healthStatus = "unreachable"
    $healthBody = $null
    $latestBackup = $null
    try {
        $healthRes = Invoke-RestMethod -Uri "http://127.0.0.1:3100/api/health" -TimeoutSec 5 -ErrorAction Stop
        $healthStatus = if ($healthRes.status) { $healthRes.status } else { "unknown" }
        $healthBody = $healthRes
        if ($healthRes.databaseBackup -and $healthRes.databaseBackup.latestBackup) {
            $latestBackup = [ordered]@{
                name      = $healthRes.databaseBackup.latestBackup.name
                mtime     = $healthRes.databaseBackup.latestBackup.mtime
            }
        }
    } catch {
        $healthStatus = "error: " + $_.Exception.Message
    }

    return [ordered]@{
        readyStatus   = $readyStatus
        healthStatus  = $healthStatus
        latestBackup  = $latestBackup
    }
}

function Measure-DiskFreeGb {
    try {
        $drive = Get-PSDrive -Name C -ErrorAction SilentlyContinue
        if ($drive) { return [Math]::Round($drive.Free / 1GB, 2) }
    } catch {}
    return $null
}

function Write-EvidenceJson {
    param([string]$Filename, [object]$Data)
    Ensure-EvidenceDir
    $target = Join-Path $evidenceDir $Filename
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    $json = $Data | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($target, $json, $utf8NoBom)
}

function Capture-T0Baseline {
    $nowUtc = [DateTime]::UtcNow
    $nowLocal = [DateTime]::Now

    Write-Host "[Gate D T0] Capturing Baseline at $($nowLocal.ToString('yyyy-MM-dd HH:mm:ss'))..." -ForegroundColor Cyan

    $sup = Get-SupervisorInfo
    $pids = [ordered]@{
        supervisor   = $sup
        api          = (Get-ProcessMetrics $script:ExpectedPids.API "PaperclipAPI")
        defaultDb    = (Get-ProcessMetrics $script:ExpectedPids.DefaultDB "DefaultPostgres")
        canaryDb     = (Get-ProcessMetrics $script:ExpectedPids.CanaryDB "CanaryPostgres")
        canaryClient = (Get-ProcessMetrics $script:ExpectedPids.CanaryClient "CanaryClient")
    }

    $ports = [ordered]@{
        p3100 = (Get-PortStatus $script:ExpectedPorts.API)
        p54329 = (Get-PortStatus $script:ExpectedPorts.DefaultDB)
        p54330 = (Get-PortStatus $script:ExpectedPorts.CanaryDB)
        p55432 = (Get-PortStatus $script:ExpectedPorts.TargetFree)
    }

    $conns = [ordered]@{
        defaultDbConnectionsFromApi = (Get-ConnectionCount $script:ExpectedPorts.DefaultDB $script:ExpectedPids.API)
        canaryDbConnectionsFromClient = (Get-ConnectionCount $script:ExpectedPorts.CanaryDB $script:ExpectedPids.CanaryClient)
    }

    $apiHealth = Query-ApiHealth
    $diskFreeGb = Measure-DiskFreeGb

    $logOffsets = [ordered]@{
        lifecycleLines = (Get-FileLineCount $lifecycleLogFile)
        alertsLines    = (Get-FileLineCount $alertsLogFile)
    }

    $baseline = [ordered]@{
        stage                     = "gate_d_t0_baseline"
        timestampUtc              = $nowUtc.ToString("o")
        timestampLocal            = $nowLocal.ToString("yyyy-MM-dd HH:mm:ss")
        supervisor                = $sup
        processes                 = $pids
        ports                     = $ports
        connections               = $conns
        apiHealth                 = $apiHealth
        diskFreeGb                = $diskFreeGb
        logOffsets                = $logOffsets
        expectedBaselineMatched   = (
            $sup.alive -and
            $pids.api.alive -and
            $pids.defaultDb.alive -and
            $pids.canaryDb.alive -and
            $pids.canaryClient.alive -and
            $ports.p3100.listening -and
            $ports.p54329.listening -and
            $ports.p54330.listening -and
            (-not $ports.p55432.listening) -and
            ($apiHealth.readyStatus -eq "ready") -and
            ($apiHealth.healthStatus -eq "ok")
        )
    }

    Write-EvidenceJson "00-gate-d-baseline-t0.json" $baseline
    Write-Host "[Gate D T0] Baseline captured successfully. ExpectedMatched: $($baseline.expectedBaselineMatched)" -ForegroundColor Green
    return $baseline
}

function Capture-HourlySnapshot {
    param([int]$HourNumber, [DateTime]$StartUtc)
    $nowUtc = [DateTime]::UtcNow
    $nowLocal = [DateTime]::Now
    $elapsedSec = [Math]::Round(($nowUtc - $StartUtc).TotalSeconds)

    $sup = Get-SupervisorInfo
    $pids = [ordered]@{
        supervisor   = $sup
        api          = (Get-ProcessMetrics $script:ExpectedPids.API "PaperclipAPI")
        defaultDb    = (Get-ProcessMetrics $script:ExpectedPids.DefaultDB "DefaultPostgres")
        canaryDb     = (Get-ProcessMetrics $script:ExpectedPids.CanaryDB "CanaryPostgres")
        canaryClient = (Get-ProcessMetrics $script:ExpectedPids.CanaryClient "CanaryClient")
    }

    $ports = [ordered]@{
        p3100 = (Get-PortStatus $script:ExpectedPorts.API)
        p54329 = (Get-PortStatus $script:ExpectedPorts.DefaultDB)
        p54330 = (Get-PortStatus $script:ExpectedPorts.CanaryDB)
        p55432 = (Get-PortStatus $script:ExpectedPorts.TargetFree)
    }

    $conns = [ordered]@{
        defaultDbConnectionsFromApi = (Get-ConnectionCount $script:ExpectedPorts.DefaultDB $script:ExpectedPids.API)
        canaryDbConnectionsFromClient = (Get-ConnectionCount $script:ExpectedPorts.CanaryDB $script:ExpectedPids.CanaryClient)
    }

    $apiHealth = Query-ApiHealth
    $diskFreeGb = Measure-DiskFreeGb

    $logMetrics = [ordered]@{
        lifecycleLines = (Get-FileLineCount $lifecycleLogFile)
        alertsLines    = (Get-FileLineCount $alertsLogFile)
    }

    $pass = (
        $sup.alive -and
        $pids.api.alive -and
        $pids.defaultDb.alive -and
        $pids.canaryDb.alive -and
        $pids.canaryClient.alive -and
        $ports.p3100.listening -and
        $ports.p54329.listening -and
        $ports.p54330.listening -and
        (-not $ports.p55432.listening) -and
        ($apiHealth.readyStatus -eq "ready") -and
        ($apiHealth.healthStatus -eq "ok") -and
        ($conns.canaryDbConnectionsFromClient -gt 0)
    )

    $snapshot = [ordered]@{
        stage                     = "gate_d_hourly_snapshot"
        hour                      = $HourNumber
        timestampUtc              = $nowUtc.ToString("o")
        timestampLocal            = $nowLocal.ToString("yyyy-MM-dd HH:mm:ss")
        elapsedWallClockSeconds   = $elapsedSec
        supervisor                = $sup
        processes                 = $pids
        ports                     = $ports
        connections               = $conns
        apiHealth                 = $apiHealth
        diskFreeGb                = $diskFreeGb
        logMetrics                = $logMetrics
        hourlyPass                = $pass
    }

    $fname = "snapshot-hour-{0:D2}.json" -f $HourNumber
    Write-EvidenceJson $fname $snapshot
    return $snapshot
}

function Generate-T24FinalSummary {
    param([DateTime]$StartUtc, [DateTime]$EndUtc, [array]$Snapshots)
    $wallClockSec = [Math]::Round(($EndUtc - $StartUtc).TotalSeconds)
    $hoursCompleted = $Snapshots.Count
    $allHourlyPass = ($Snapshots | Where-Object { -not $_.hourlyPass }).Count -eq 0

    $summary = [ordered]@{
        stage                     = "gate_d_t24_final_summary"
        startUtc                  = $StartUtc.ToString("o")
        endUtc                    = $EndUtc.ToString("o")
        totalWallClockSeconds     = $wallClockSec
        wallClockRequirementMet   = ($wallClockSec -ge 86400)
        totalSnapshotsRecorded    = $hoursCompleted
        snapshotsRequirementMet   = ($hoursCompleted -eq 24)
        allHourlySnapshotsPassed  = $allHourlyPass
        finalVerdict              = if ($wallClockSec -ge 86400 -and $hoursCompleted -eq 24 -and $allHourlyPass) {
            "VERIFIED_PASS"
        } else {
            "NOT_VERIFIED"
        }
    }

    Write-EvidenceJson "25-gate-d-final-summary.json" $summary
    return $summary
}

# --- Main Entry Point ---

if ($DryRun) {
    Write-Host "==================================================" -ForegroundColor Cyan
    Write-Host " NEXORA Gate D Stability Observer: DRY-RUN MODE   " -ForegroundColor Cyan
    Write-Host "==================================================" -ForegroundColor Cyan
    Write-Host "Executing single READ-ONLY T0 Baseline capture..." -ForegroundColor Yellow
    
    $baseline = Capture-T0Baseline
    
    Write-Host ""
    Write-Host "DRY-RUN EXECUTION SUMMARY:" -ForegroundColor Green
    Write-Host "  Stage:                  $($baseline.stage)"
    Write-Host "  Timestamp:              $($baseline.timestampLocal)"
    Write-Host "  Supervisor (PID):       $($baseline.supervisor.pid) (Alive: $($baseline.supervisor.alive))"
    Write-Host "  API (PID 13548):        Alive: $($baseline.processes.api.alive), WS: $($baseline.processes.api.workingSetMb) MB"
    Write-Host "  Default DB (PID 18716): Alive: $($baseline.processes.defaultDb.alive), WS: $($baseline.processes.defaultDb.workingSetMb) MB"
    Write-Host "  Canary DB (PID 16208):  Alive: $($baseline.processes.canaryDb.alive)"
    Write-Host "  Canary Client (15228):  Alive: $($baseline.processes.canaryClient.alive), Active Sockets: $($baseline.connections.canaryDbConnectionsFromClient)"
    Write-Host "  Target Port 55432:      Listening: $($baseline.ports.p55432.listening) (Expected: False)"
    Write-Host "  API /health/ready:      $($baseline.apiHealth.readyStatus)"
    Write-Host "  API /health:            $($baseline.apiHealth.healthStatus)"
    $backupDisplay = if ($baseline.apiHealth.latestBackup) { "$($baseline.apiHealth.latestBackup.name) ($($baseline.apiHealth.latestBackup.mtime))" } else { "none" }
    Write-Host "  Latest Backup:          $backupDisplay"
    Write-Host "  Expected Baseline:      Matched = $($baseline.expectedBaselineMatched)"
    Write-Host "  Output File:            $evidenceDir\00-gate-d-baseline-t0.json"
    Write-Host ""
    Write-Host "GATE_D_DRY_RUN_PASS" -ForegroundColor Green
    Write-Host "NO_24H_LOOP_ENTERED: Dry-run completed cleanly without entering the observation loop." -ForegroundColor Cyan
    exit 0
}

# Real 24-Hour Continuous Observation Loop (Requires explicit human execution approval)
Write-Host "[Gate D] Real 24-hour continuous observation starting..." -ForegroundColor Cyan
Ensure-EvidenceDir

if (Test-Path -LiteralPath $observerPidFile) {
    $existing = (Get-Content -LiteralPath $observerPidFile -Raw).Trim()
    if ($existing -match '^\d+$') {
        $p = Get-Process -Id ([int]$existing) -ErrorAction SilentlyContinue
        if ($p) {
            Write-Error "Gate D Observer is already running (PID $existing)."
            exit 1
        }
    }
}

[System.IO.File]::WriteAllText($observerPidFile, [string]$PID)

$startUtc = [DateTime]::UtcNow
$t0 = Capture-T0Baseline
$snapshots = [System.Collections.Generic.List[object]]::new()

try {
    for ($i = 1; $i -le $DurationHours; $i++) {
        $targetWakeUtc = $startUtc.AddMinutes($IntervalMinutes * $i)
        $now = [DateTime]::UtcNow
        $sleepMs = [Math]::Max(0, [int](($targetWakeUtc - $now).TotalMilliseconds))
        
        Write-Host "[Gate D] Waiting until $($targetWakeUtc.ToString('yyyy-MM-dd HH:mm:ss UTC')) for Hour $i snapshot..." -ForegroundColor Cyan
        if ($sleepMs -gt 0) {
            Start-Sleep -Milliseconds $sleepMs
        }
        
        $snap = Capture-HourlySnapshot -HourNumber $i -StartUtc $startUtc
        $snapshots.Add($snap)
        Write-Host "[Gate D] Hour $i/24 snapshot captured. Pass: $($snap.hourlyPass)" -ForegroundColor Green
    }

    $endUtc = [DateTime]::UtcNow
    $final = Generate-T24FinalSummary -StartUtc $startUtc -EndUtc $endUtc -Snapshots $snapshots
    Write-Host "[Gate D] 24-Hour observation completed. Final Verdict: $($final.finalVerdict)" -ForegroundColor Green
} finally {
    if (Test-Path -LiteralPath $observerPidFile) {
        Remove-Item -LiteralPath $observerPidFile -Force -ErrorAction SilentlyContinue
    }
}
