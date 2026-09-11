# scripts/operations/gate-d-24h-observe-v2.ps1
# NEXORA Gate D 24-hour stability observer v2.
# The observer reads service state and writes only its own evidence files.

[CmdletBinding()]
param(
    [switch]$DryRun,
    [ValidateRange(1, 168)]
    [int]$DurationHours = 24,
    [ValidateRange(1, 1440)]
    [int]$IntervalMinutes = 60,
    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$EvidenceSubdir = "gate-d-supervisor-ebusy-24h-v2",
    [ValidateRange(1, 2147483647)]
    [int]$ExpectedSupervisorPid = 21488,
    [ValidatePattern('^[A-Fa-f0-9]{64}$')]
    [string]$ExpectedSupervisorSha256 = "4C7FEE5A5FB6FB387FB5F1A52039E28FAE194C446358645250DA0899416FE2CE"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repo = "C:\Users\Nexora\paperclip"
$evidenceRoot = Join-Path $repo "docs\investigations\evidence"
$evidenceDir = Join-Path $evidenceRoot $EvidenceSubdir
$instanceDir = Join-Path $env:USERPROFILE ".paperclip\instances\default"
$logsDir = Join-Path $instanceDir "logs"
$supervisorPidFile = Join-Path $logsDir "control-plane-supervisor.pid"
$lifecycleLogFile = Join-Path $logsDir "control-plane-lifecycle.jsonl"
$alertsLogFile = Join-Path $logsDir "control-plane-alerts.jsonl"
$supervisorDiagnosticsLogFile = Join-Path $logsDir "supervisor-diagnostics.jsonl"
$observerPidFile = Join-Path $evidenceDir "gate-d-observe.pid"
$supervisorScriptPath = Join-Path $repo "scripts\operations\paperclip-control-plane-supervisor.mjs"
$taskSchedulerName = "NEXORA-Default-ControlPlane-Service"

$script:ExpectedPorts = [ordered]@{
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

$script:ExpectedProcessNames = [ordered]@{
    API          = "node"
    DefaultDB    = "postgres"
    CanaryDB     = "postgres"
    CanaryClient = "node"
}

$script:ExpectedSupervisorPid = $ExpectedSupervisorPid
$script:ExpectedSupervisorSha256 = $ExpectedSupervisorSha256.ToUpperInvariant()

function Ensure-EvidenceDir {
    if (-not (Test-Path -LiteralPath $evidenceDir)) {
        New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
    }
}

function Get-ProcessOwnerName {
    param([object]$CimProcess)

    if ($null -eq $CimProcess) { return $null }
    try {
        $owner = Invoke-CimMethod -InputObject $CimProcess -MethodName GetOwner -ErrorAction Stop
        if ($owner.ReturnValue -eq 0) {
            return "$($owner.Domain)\$($owner.User)"
        }
    } catch {}
    return $null
}

function Get-SupervisorInfo {
    $pidFromFile = $null
    if (Test-Path -LiteralPath $supervisorPidFile) {
        try {
            $rawPid = (Get-Content -LiteralPath $supervisorPidFile -Raw).Trim()
            if ($rawPid -match '^\d+$') { $pidFromFile = [int]$rawPid }
        } catch {}
    }

    $expectedProcess = Get-Process -Id $script:ExpectedSupervisorPid -ErrorAction SilentlyContinue
    $expectedCimProcess = Get-CimInstance -ClassName Win32_Process `
        -Filter "ProcessId=$($script:ExpectedSupervisorPid)" -ErrorAction SilentlyContinue

    $expectedCommandLine = if ($expectedCimProcess) { [string]$expectedCimProcess.CommandLine } else { $null }
    $expectedIdentityMatches = (
        $null -ne $expectedProcess -and
        $expectedProcess.ProcessName -eq "node" -and
        -not [string]::IsNullOrWhiteSpace($expectedCommandLine) -and
        $expectedCommandLine -like "*paperclip-control-plane-supervisor.mjs*" -and
        $expectedCommandLine -match '(?:^|\s)--watch(?:\s|$)'
    )

    $supervisorProcesses = @(
        Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                -not [string]::IsNullOrWhiteSpace($PSItem.CommandLine) -and
                $PSItem.CommandLine -like "*paperclip-control-plane-supervisor.mjs*" -and
                $PSItem.CommandLine -match '(?:^|\s)--watch(?:\s|$)'
            }
    )

    $observedSha256 = $null
    if (Test-Path -LiteralPath $supervisorScriptPath) {
        try {
            $observedSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $supervisorScriptPath).Hash.ToUpperInvariant()
        } catch {}
    }

    return [ordered]@{
        alive                     = ($null -ne $expectedProcess)
        expectedPid               = $script:ExpectedSupervisorPid
        pidFromFile               = $pidFromFile
        pidMatchesExpected        = ($pidFromFile -eq $script:ExpectedSupervisorPid)
        processIdentityMatches    = $expectedIdentityMatches
        processName               = if ($expectedProcess) { $expectedProcess.ProcessName } else { $null }
        commandLine               = $expectedCommandLine
        owner                     = Get-ProcessOwnerName $expectedCimProcess
        sessionId                 = if ($expectedCimProcess) { $expectedCimProcess.SessionId } else { $null }
        commandLineProcessCount   = $supervisorProcesses.Count
        commandLineProcessIds     = @($supervisorProcesses | ForEach-Object { [int]$PSItem.ProcessId })
        commandLineCountOk        = ($supervisorProcesses.Count -eq 1)
        expectedProcessIsOnlyOne  = (
            $supervisorProcesses.Count -eq 1 -and
            [int]$supervisorProcesses[0].ProcessId -eq $script:ExpectedSupervisorPid
        )
        expectedSha256            = $script:ExpectedSupervisorSha256
        observedSha256            = $observedSha256
        sha256Match               = ($observedSha256 -eq $script:ExpectedSupervisorSha256)
        startTimeUtc              = $(try { $expectedProcess.StartTime.ToUniversalTime().ToString("o") } catch { $null })
        workingSetMb              = $(try { [Math]::Round($expectedProcess.WorkingSet64 / 1MB, 2) } catch { $null })
    }
}

function Get-ProcessMetrics {
    param(
        [int]$ProcessId,
        [string]$RoleName,
        [string]$ExpectedProcessName
    )

    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $process) {
        return [ordered]@{
            role                  = $RoleName
            expectedPid           = $ProcessId
            alive                 = $false
            observedPid           = $null
            processName           = $null
            nameMatchesExpected   = $false
            startTimeUtc          = $null
            workingSetMb          = $null
            privateMemoryMb       = $null
            totalProcessorTimeSec = $null
        }
    }

    return [ordered]@{
        role                  = $RoleName
        expectedPid           = $ProcessId
        alive                 = $true
        observedPid           = $process.Id
        processName           = $process.ProcessName
        nameMatchesExpected   = ($process.ProcessName -eq $ExpectedProcessName)
        startTimeUtc          = $(try { $process.StartTime.ToUniversalTime().ToString("o") } catch { $null })
        workingSetMb          = $(try { [Math]::Round($process.WorkingSet64 / 1MB, 2) } catch { $null })
        privateMemoryMb       = $(try { [Math]::Round($process.PrivateMemorySize64 / 1MB, 2) } catch { $null })
        totalProcessorTimeSec = $(try { [Math]::Round($process.TotalProcessorTime.TotalSeconds, 2) } catch { $null })
    }
}

function Get-PortStatus {
    param(
        [int]$Port,
        [object]$ExpectedOwningPid
    )

    $listeners = @(
        Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    )
    $owningPids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    $ownershipMatchesExpected = if ($null -eq $ExpectedOwningPid) {
        $listeners.Count -eq 0
    } else {
        $owningPids.Count -eq 1 -and [int]$owningPids[0] -eq [int]$ExpectedOwningPid
    }

    return [ordered]@{
        port                     = $Port
        listening                = ($listeners.Count -gt 0)
        listenerCount            = $listeners.Count
        owningPids               = $owningPids
        expectedOwningPid        = if ($null -eq $ExpectedOwningPid) { $null } else { [int]$ExpectedOwningPid }
        ownershipMatchesExpected = $ownershipMatchesExpected
    }
}

function Get-ConnectionCount {
    param([int]$Port, [int]$ClientPid)

    $connections = @(
        Get-NetTCPConnection -ErrorAction SilentlyContinue |
            Where-Object {
                ($PSItem.LocalPort -eq $Port -or $PSItem.RemotePort -eq $Port) -and
                $PSItem.State -eq "Established" -and
                $PSItem.OwningProcess -eq $ClientPid
            }
    )
    return $connections.Count
}

function Get-FileLineCount {
    param([string]$FilePath)

    if (-not (Test-Path -LiteralPath $FilePath)) { return 0 }
    $count = 0
    try {
        foreach ($unusedLine in [System.IO.File]::ReadLines($FilePath)) { $count++ }
        return $count
    } catch {
        return @(Get-Content -LiteralPath $FilePath).Count
    }
}

function Convert-ToUtcTimestamp {
    param([object]$Value)

    if ($null -eq $Value) { return $null }
    try { return [DateTime]::Parse([string]$Value).ToUniversalTime() } catch { return $null }
}

function Get-ObjectPropertyValue {
    param(
        [object]$InputObject,
        [string]$PropertyName
    )

    if ($null -eq $InputObject) { return $null }
    $property = $InputObject.PSObject.Properties[$PropertyName]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Get-NewDiagnosticFindings {
    param([DateTime]$SinceUtc)

    # Observation limit: the supervisor's stderr-only message
    # "diagnostic log dropped after retries" is not captured by the current
    # Task Scheduler launcher. This observer does not claim to verify its absence.
    $findings = [System.Collections.Generic.List[object]]::new()
    $parseFailures = 0

    foreach ($logSpec in @(
        [ordered]@{ path = $lifecycleLogFile; source = "lifecycle" },
        [ordered]@{ path = $alertsLogFile; source = "alerts" }
    )) {
        if (-not (Test-Path -LiteralPath $logSpec.path)) { continue }
        foreach ($line in [System.IO.File]::ReadLines($logSpec.path)) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            try {
                $eventObject = $line | ConvertFrom-Json -ErrorAction Stop
            } catch {
                $parseFailures++
                continue
            }

            $eventTimestamp = Get-ObjectPropertyValue $eventObject "at"
            if ($null -eq $eventTimestamp) {
                $eventTimestamp = Get-ObjectPropertyValue $eventObject "timestampUtc"
            }
            if ($null -eq $eventTimestamp) {
                $eventTimestamp = Get-ObjectPropertyValue $eventObject "timestamp"
            }
            $eventTime = Convert-ToUtcTimestamp $eventTimestamp
            if ($null -eq $eventTime -or $eventTime -le $SinceUtc) { continue }

            $eventText = $line
            if ($eventText -match 'RECOVERY_EXHAUSTED|MANUAL_ATTENTION_REQUIRED|uncaught_exception|process_exit|diagnostic_log_dropped') {
                $eventName = Get-ObjectPropertyValue $eventObject "event"
                $findings.Add([ordered]@{
                    source = $logSpec.source
                    at     = $eventTime.ToString("o")
                    event  = if ($eventName) { $eventName } else { "matched_bad_pattern" }
                    detail = $eventText
                })
            }
        }
    }

    if (Test-Path -LiteralPath $supervisorDiagnosticsLogFile) {
        foreach ($line in [System.IO.File]::ReadLines($supervisorDiagnosticsLogFile)) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            try {
                $eventObject = $line | ConvertFrom-Json -ErrorAction Stop
            } catch {
                $parseFailures++
                continue
            }

            $eventTime = Convert-ToUtcTimestamp (Get-ObjectPropertyValue $eventObject "at")
            if ($null -eq $eventTime -or $eventTime -le $SinceUtc) { continue }

            $eventName = [string](Get-ObjectPropertyValue $eventObject "event")
            $eventPid = Get-ObjectPropertyValue $eventObject "pid"
            $isFailure = $false
            if ($eventName -eq "process_loaded") {
                $isFailure = ($null -eq $eventPid -or [int]$eventPid -ne $script:ExpectedSupervisorPid)
            } elseif ($eventName -in @("process_exit", "uncaught_exception", "warning")) {
                $isFailure = $true
            }

            if ($isFailure) {
                $findings.Add([ordered]@{
                    source = "supervisor-diagnostics"
                    at     = $eventTime.ToString("o")
                    event  = $eventName
                    pid    = $eventPid
                    code   = Get-ObjectPropertyValue $eventObject "code"
                    name   = Get-ObjectPropertyValue $eventObject "name"
                })
            }
        }
    }

    return [ordered]@{
        clean                  = ($findings.Count -eq 0)
        findingCount           = $findings.Count
        findings               = @($findings | Select-Object -First 20)
        parseFailureCount      = $parseFailures
        observationLimit       = "The stderr-only 'diagnostic log dropped after retries' message is not captured by the current launcher."
    }
}

function Get-TaskSchedulerEvidence {
    param([DateTime]$SinceUtc)

    try {
        $events = @(
            Get-WinEvent -FilterHashtable @{
                LogName   = "Microsoft-Windows-TaskScheduler/Operational"
                StartTime = $SinceUtc
            } -ErrorAction Stop |
                Where-Object {
                    $PSItem.Message -and
                    $PSItem.Message -like "*\$taskSchedulerName*"
                }
        )
    } catch {
        return [ordered]@{
            checked           = $false
            note              = $PSItem.Exception.Message
            ignoredId322Count = 0
            otherEventCount   = 0
            otherEventSamples = @()
        }
    }

    if ($events.Count -eq 0) {
        return [ordered]@{
            checked           = $true
            note              = "No relevant events since T0"
            ignoredId322Count = 0
            otherEventCount   = 0
            otherEventSamples = @()
        }
    }

    $id322Events = @($events | Where-Object { $PSItem.Id -eq 322 })
    $otherEvents = @($events | Where-Object { $PSItem.Id -ne 322 })
    return [ordered]@{
        checked           = $true
        note              = "Event ID 322 is expected IgnoreNew duplicate suppression; other events are informational only."
        ignoredId322Count = $id322Events.Count
        otherEventCount   = $otherEvents.Count
        otherEventSamples = @(
            $otherEvents |
                Select-Object -First 10 -Property Id, TimeCreated, LevelDisplayName, Message
        )
    }
}

function Query-ApiHealth {
    $readyStatus = "unreachable"
    try {
        $readyResponse = Invoke-RestMethod -Uri "http://127.0.0.1:3100/api/health/ready" -TimeoutSec 5 -ErrorAction Stop
        $readyStatus = if ($readyResponse.status) { $readyResponse.status } else { "unknown" }
    } catch {
        $readyStatus = "error: " + $PSItem.Exception.Message
    }

    $healthStatus = "unreachable"
    $latestBackup = $null
    try {
        $healthResponse = Invoke-RestMethod -Uri "http://127.0.0.1:3100/api/health" -TimeoutSec 5 -ErrorAction Stop
        $healthStatus = if ($healthResponse.status) { $healthResponse.status } else { "unknown" }
        if ($healthResponse.databaseBackup -and $healthResponse.databaseBackup.latestBackup) {
            $latestBackup = [ordered]@{
                name  = $healthResponse.databaseBackup.latestBackup.name
                mtime = $healthResponse.databaseBackup.latestBackup.mtime
            }
        }
    } catch {
        $healthStatus = "error: " + $PSItem.Exception.Message
    }

    return [ordered]@{
        readyStatus  = $readyStatus
        healthStatus = $healthStatus
        latestBackup = $latestBackup
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
    $temporaryTarget = "$target.tmp-$PID"
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    $json = $Data | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($temporaryTarget, $json, $utf8NoBom)
    Move-Item -LiteralPath $temporaryTarget -Destination $target -Force
}

function Capture-GateDState {
    param(
        [DateTime]$StartUtc,
        [string]$Stage,
        [int]$HourNumber = 0
    )

    $nowUtc = [DateTime]::UtcNow
    $nowLocal = [DateTime]::Now
    $supervisor = Get-SupervisorInfo
    $processes = [ordered]@{
        api = Get-ProcessMetrics $script:ExpectedPids.API "PaperclipAPI" $script:ExpectedProcessNames.API
        defaultDb = Get-ProcessMetrics $script:ExpectedPids.DefaultDB "DefaultPostgres" $script:ExpectedProcessNames.DefaultDB
        canaryDb = Get-ProcessMetrics $script:ExpectedPids.CanaryDB "CanaryPostgres" $script:ExpectedProcessNames.CanaryDB
        canaryClient = Get-ProcessMetrics $script:ExpectedPids.CanaryClient "CanaryClient" $script:ExpectedProcessNames.CanaryClient
    }
    $ports = [ordered]@{
        p3100 = Get-PortStatus $script:ExpectedPorts.API $script:ExpectedPids.API
        p54329 = Get-PortStatus $script:ExpectedPorts.DefaultDB $script:ExpectedPids.DefaultDB
        p54330 = Get-PortStatus $script:ExpectedPorts.CanaryDB $script:ExpectedPids.CanaryDB
        p55432 = Get-PortStatus $script:ExpectedPorts.TargetFree $null
    }
    $connections = [ordered]@{
        defaultDbConnectionsFromApi = Get-ConnectionCount $script:ExpectedPorts.DefaultDB $script:ExpectedPids.API
        canaryDbConnectionsFromClient = Get-ConnectionCount $script:ExpectedPorts.CanaryDB $script:ExpectedPids.CanaryClient
    }
    $apiHealth = Query-ApiHealth
    $diagnostics = Get-NewDiagnosticFindings -SinceUtc $StartUtc
    $taskScheduler = Get-TaskSchedulerEvidence -SinceUtc $StartUtc

    $pass = (
        $supervisor.alive -and
        $supervisor.pidMatchesExpected -and
        $supervisor.processIdentityMatches -and
        $supervisor.commandLineCountOk -and
        $supervisor.expectedProcessIsOnlyOne -and
        $supervisor.sha256Match -and
        $diagnostics.clean -and
        $processes.api.alive -and $processes.api.nameMatchesExpected -and
        $processes.defaultDb.alive -and $processes.defaultDb.nameMatchesExpected -and
        $processes.canaryDb.alive -and $processes.canaryDb.nameMatchesExpected -and
        $processes.canaryClient.alive -and $processes.canaryClient.nameMatchesExpected -and
        $ports.p3100.listening -and $ports.p3100.ownershipMatchesExpected -and
        $ports.p54329.listening -and $ports.p54329.ownershipMatchesExpected -and
        $ports.p54330.listening -and $ports.p54330.ownershipMatchesExpected -and
        (-not $ports.p55432.listening) -and $ports.p55432.ownershipMatchesExpected -and
        ($apiHealth.readyStatus -eq "ready") -and
        ($apiHealth.healthStatus -eq "ok") -and
        ($connections.canaryDbConnectionsFromClient -gt 0)
    )

    return [ordered]@{
        stage                   = $Stage
        hour                    = $HourNumber
        timestampUtc            = $nowUtc.ToString("o")
        timestampLocal          = $nowLocal.ToString("yyyy-MM-dd HH:mm:ss")
        elapsedWallClockSeconds = [Math]::Floor(($nowUtc - $StartUtc).TotalSeconds)
        supervisor              = $supervisor
        processes               = $processes
        ports                   = $ports
        connections             = $connections
        apiHealth               = $apiHealth
        diagnostics             = $diagnostics
        taskScheduler           = $taskScheduler
        diskFreeGb              = Measure-DiskFreeGb
        logMetrics              = [ordered]@{
            lifecycleLines            = Get-FileLineCount $lifecycleLogFile
            alertsLines               = Get-FileLineCount $alertsLogFile
            supervisorDiagnosticsLines = Get-FileLineCount $supervisorDiagnosticsLogFile
        }
        pass                    = $pass
    }
}

function Generate-T24FinalSummary {
    param([DateTime]$StartUtc, [DateTime]$EndUtc, [array]$Snapshots)

    $wallClockSeconds = [Math]::Floor(($EndUtc - $StartUtc).TotalSeconds)
    $failedSnapshots = @($Snapshots | Where-Object { -not $PSItem.pass })
    $summary = [ordered]@{
        stage                    = "gate_d_t24_final_summary"
        startUtc                 = $StartUtc.ToString("o")
        endUtc                   = $EndUtc.ToString("o")
        totalWallClockSeconds    = $wallClockSeconds
        wallClockRequirementMet  = ($wallClockSeconds -ge 86400)
        totalSnapshotsRecorded   = $Snapshots.Count
        snapshotsRequirementMet  = ($Snapshots.Count -eq 24)
        failedSnapshotHours      = @($failedSnapshots | ForEach-Object { $PSItem.hour })
        allHourlySnapshotsPassed = ($failedSnapshots.Count -eq 0)
        observationLimit         = "The stderr-only 'diagnostic log dropped after retries' message is not captured by the current launcher."
        finalVerdict             = if (
            $wallClockSeconds -ge 86400 -and
            $Snapshots.Count -eq 24 -and
            $failedSnapshots.Count -eq 0
        ) { "VERIFIED_PASS" } else { "NOT_VERIFIED" }
    }
    Write-EvidenceJson "25-gate-d-final-summary.json" $summary
    return $summary
}

if ($DryRun) {
    $dryRunStartUtc = [DateTime]::UtcNow
    $baseline = Capture-GateDState -StartUtc $dryRunStartUtc -Stage "gate_d_t0_baseline"
    Write-EvidenceJson "00-gate-d-baseline-t0.json" $baseline
    if (-not $baseline.pass) {
        Write-Error "GATE_D_DRY_RUN_FAIL: baseline contract checks did not all pass."
        exit 2
    }
    Write-Host "GATE_D_DRY_RUN_PASS"
    Write-Host "NO_24H_LOOP_ENTERED"
    exit 0
}

Ensure-EvidenceDir
if (Test-Path -LiteralPath $observerPidFile) {
    $existingPidText = (Get-Content -LiteralPath $observerPidFile -Raw).Trim()
    if ($existingPidText -match '^\d+$') {
        $existingProcess = Get-Process -Id ([int]$existingPidText) -ErrorAction SilentlyContinue
        if ($existingProcess) {
            throw "Gate D Observer is already running for this evidence directory (PID $existingPidText)."
        }
    }
}

[System.IO.File]::WriteAllText($observerPidFile, [string]$PID)
try {
    $startUtc = [DateTime]::UtcNow
    $baseline = Capture-GateDState -StartUtc $startUtc -Stage "gate_d_t0_baseline"
    Write-EvidenceJson "00-gate-d-baseline-t0.json" $baseline
    if (-not $baseline.pass) {
        throw "Gate D T0 baseline failed. The 24-hour loop was not started."
    }

    $snapshots = [System.Collections.Generic.List[object]]::new()
    for ($hour = 1; $hour -le $DurationHours; $hour++) {
        $targetWakeUtc = $startUtc.AddMinutes($IntervalMinutes * $hour)
        $remainingMilliseconds = [Math]::Floor(($targetWakeUtc - [DateTime]::UtcNow).TotalMilliseconds)
        if ($remainingMilliseconds -gt 0) {
            Start-Sleep -Milliseconds ([int][Math]::Min($remainingMilliseconds, [int]::MaxValue))
        }

        $snapshot = Capture-GateDState `
            -StartUtc $startUtc -Stage "gate_d_hourly_snapshot" -HourNumber $hour
        $snapshots.Add($snapshot)
        Write-EvidenceJson ("snapshot-hour-{0:D2}.json" -f $hour) $snapshot
    }

    $finalSummary = Generate-T24FinalSummary `
        -StartUtc $startUtc -EndUtc ([DateTime]::UtcNow) -Snapshots @($snapshots)
    Write-Host "Gate D observation finished: $($finalSummary.finalVerdict)"
} finally {
    if (Test-Path -LiteralPath $observerPidFile) {
        try {
            $recordedPid = (Get-Content -LiteralPath $observerPidFile -Raw).Trim()
            if ($recordedPid -eq [string]$PID) {
                Remove-Item -LiteralPath $observerPidFile -Force -ErrorAction SilentlyContinue
            }
        } catch {}
    }
}
