# NEXORA non-destructive backup restore harness.
# Dry-run is the only mode intended for routine validation. -Execute requires
# a separately issued human approval token and performs destructive writes only
# inside the fixed disposable cluster root.

[CmdletBinding(DefaultParameterSetName = "DryRun")]
param(
    [Parameter(Mandatory, ParameterSetName = "DryRun")]
    [switch]$DryRun,

    [Parameter(Mandatory, ParameterSetName = "Execute")]
    [switch]$Execute,

    [Parameter(ParameterSetName = "Execute")]
    [string]$ApprovalToken,

    [Parameter(ParameterSetName = "DryRun")]
    [switch]$SimulateEngineDrift,

    [Parameter(ParameterSetName = "DryRun")]
    [switch]$SimulateUnexpectedClient,

    [Parameter(ParameterSetName = "DryRun")]
    [switch]$SimulateInitDbTimeoutKill,

    [Parameter(ParameterSetName = "DryRun")]
    [switch]$SimulateCanaryClientDrift,

    # Test seams remain fail-closed: every value is compared with its manifest
    # constant before filesystem, process, or database mutation is possible.
    [string]$BackupPath = "C:\Users\Nexora\.paperclip\instances\default\data\backups\paperclip-20260831-220448.sql.gz",
    [string]$BackupSha256 = "0AA1AA15F6950C669D0175F647D52CBF2296CA9457A6D49AF1112FB1BB460BB9",
    [long]$BackupSize = 5955359,
    [int]$TargetPort = 55432,
    [string]$TempRoot = "C:\Users\Nexora\AppData\Local\Temp\nexora-restore-test-20260831-220448-0aa1aa15-retry8",
    [int]$OperationTimeoutSeconds = 900
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:ManifestBackupPath = "C:\Users\Nexora\.paperclip\instances\default\data\backups\paperclip-20260831-220448.sql.gz"
$script:ManifestBackupSha256 = "0AA1AA15F6950C669D0175F647D52CBF2296CA9457A6D49AF1112FB1BB460BB9"
$script:ManifestBackupSize = 5955359L
$script:ManifestTargetPort = 55432
# Pinned retry-specific root: never the same directory as any prior attempt.
# Both the original real Gate C failure root and the retry1 root below are
# retained, read-only evidence from real (non-simulated) restore attempts and
# must never be reused, written into, or reasoned about as if either were the
# active root.
$script:ManifestTempRoot = "C:\Users\Nexora\AppData\Local\Temp\nexora-restore-test-20260831-220448-0aa1aa15-retry8"
$script:ManifestTempParent = "C:\Users\Nexora\AppData\Local\Temp"
# The exact historical Gate C failure root from the real (non-simulated)
# restore attempt that aborted at initdb. Read-only, retained evidence.
$script:HistoricalRetainedRoot = "C:\Users\Nexora\AppData\Local\Temp\nexora-restore-test-20260831-220448-0aa1aa15"
# The retry1 root from the second real (non-simulated) restore attempt, which
# also aborted at initdb (a different failure: the "--pwfile=-" stdin
# sentinel was not honored by this embedded PostgreSQL Windows build). Also
# read-only, retained evidence as of the retry2 attempt -- never reused.
$script:Retry1RetainedRoot = "C:\Users\Nexora\AppData\Local\Temp\nexora-restore-test-20260831-220448-0aa1aa15-retry1"
# Every root Write-AbortReasonArtifact (and any future writer) must
# defensively refuse to ever target, even if $script:ManifestTempRoot were
# ever misconfigured back to one of these values.
$script:ProtectedRetainedRoots = @($script:HistoricalRetainedRoot, $script:Retry1RetainedRoot)
$script:DefaultInstanceRoot = "C:\Users\Nexora\.paperclip\instances\default"
$script:TargetDatabase = "postgres"
$script:TargetUser = "nexora_restore_test"
$script:ProtectedPorts = @(3100, 54329, 54330)
$script:ExpectedProtectedListeners = [ordered]@{
    3100  = 13548
    54329 = 18716
    54330 = 16208
}
$script:ExpectedCanaryClientPid = 15228
$script:RequiredApprovalToken = "APPROVE-NEXORA-RESTORE-0AA1AA15-55432"
$script:MinimumFreeBytes = 5GB
$script:NativeBin = "C:\Users\Nexora\paperclip\node_modules\.pnpm\@embedded-postgres+windows-x64@18.1.0-beta.16\node_modules\@embedded-postgres\windows-x64\native\bin"
$script:RestoreHelper = "C:\Users\Nexora\paperclip\scripts\operations\nexora-backup-restore-js-engine.mjs"
$script:RestoreHelperSha256 = "9250E02B5E74884C1D042E4ECA75AE0526282AA78ABD1E4A3362548B03561EE7"
$script:RestoreEngineOrigin = "nexora-direct-js-statement-engine-v1"
$script:BinaryManifest = [ordered]@{
    "postgres.exe" = "DE2648A1D982C9CA511C663F3300EF3E381AB5A954174ECEDD4B876E869EC078"
    "initdb.exe"   = "399889A1C85DA62ABE7284CF557407BA256B9FDD2EE1FE1E553FAA3246CACCC4"
    "pg_ctl.exe"   = "4D51E03E9A065825F27843FB6029065AFACD183F7B581195D7B3C8E790FB1BEF"
}
$script:PostgresProcess = $null
$script:DisposablePid = $null
$script:PgData = Join-Path $script:ManifestTempRoot "pgdata"
$script:EvidenceDir = Join-Path $script:ManifestTempRoot "evidence"
$script:RestoreWasCalled = $false
# Ownership flag: true only once THIS run's own New-Item call has created
# $script:ManifestTempRoot. Every evidence/abort-reason writer must check
# this instead of Test-Path, because Test-Path is also true for a directory
# a *different* (earlier, retained) run created -- which is exactly the
# distinction that failed previously and caused ABORT_REASON.json from a
# real Gate C failure to be overwritten by an unrelated later run.
$script:TempRootCreatedByThisRun = $false

function Stop-Harness {
    param([string]$Code, [string]$Message)
    throw [System.InvalidOperationException]::new("$Code`: $Message")
}

function Assert-EqualText {
    param([string]$Actual, [string]$Expected, [string]$Code, [string]$Label)
    if (-not [string]::Equals($Actual, $Expected, [System.StringComparison]::OrdinalIgnoreCase)) {
        Stop-Harness $Code "$Label does not equal the approved manifest value"
    }
}

function Get-CanonicalPath {
    param([string]$Path)
    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Test-PathIsWithin {
    param([string]$Child, [string]$Parent)
    $canonicalChild = Get-CanonicalPath $Child
    $canonicalParent = Get-CanonicalPath $Parent
    return $canonicalChild.StartsWith(
        $canonicalParent + '\',
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Get-TcpRows {
    $rows = @()
    foreach ($line in (& netstat.exe -ano -p tcp)) {
        if ($line -match '^\s*TCP\s+(\S+):(\d+)\s+(\S+):(\d+)\s+(\S+)\s+(\d+)\s*$') {
            $rows += [pscustomobject]@{
                LocalAddress  = $Matches[1]
                LocalPort     = [int]$Matches[2]
                RemoteAddress = $Matches[3]
                RemotePort    = [int]$Matches[4]
                State         = $Matches[5]
                Pid           = [int]$Matches[6]
            }
        }
    }
    return $rows
}

function Get-Listener {
    param([int]$Port)
    $listeners = @(Get-TcpRows | Where-Object {
        $_.LocalPort -eq $Port -and $_.State -eq "LISTENING"
    })
    if ($listeners.Count -ne 1) {
        Stop-Harness "ABORT_LISTENER_UNKNOWN" "Expected exactly one listener on port $Port; observed $($listeners.Count)"
    }
    return $listeners[0]
}

function Test-TcpConnect {
    param([int]$Port, [int]$TimeoutMilliseconds = 1500)
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $task = $client.ConnectAsync("127.0.0.1", $Port)
        if (-not $task.Wait($TimeoutMilliseconds)) { return $false }
        return $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Assert-ApiHealthy {
    try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:3100/api/health/ready" -TimeoutSec 5
        if ($response.status -ne "ready") {
            Stop-Harness "ABORT_API_HEALTH" "API readiness status was not ready"
        }
    } catch {
        Stop-Harness "ABORT_API_HEALTH" "API readiness check failed"
    }
}

function Get-ProtectedBaseline {
    $captured = [ordered]@{}
    foreach ($entry in $script:ExpectedProtectedListeners.GetEnumerator()) {
        $port = [int]$entry.Key
        $listener = Get-Listener $port
        if ($listener.LocalAddress -ne "127.0.0.1") {
            Stop-Harness "ABORT_PROTECTED_ADDRESS" "Protected port $port is not loopback-only"
        }
        if ($listener.Pid -ne [int]$entry.Value) {
            Stop-Harness "ABORT_PROTECTED_PID" "Protected port $port listener PID changed; human review required"
        }
        if (-not (Get-Process -Id $listener.Pid -ErrorAction SilentlyContinue)) {
            Stop-Harness "ABORT_PROTECTED_PID" "Protected port $port listener PID is not alive"
        }
        if (-not (Test-TcpConnect $port)) {
            Stop-Harness "ABORT_PROTECTED_HEALTH" "Protected port $port did not accept a loopback TCP connection"
        }
        $captured[[string]$port] = $listener.Pid
    }

    Assert-ApiHealthy
    Assert-CanaryClientEstablished -Message "Expected Canary client PID is no longer connected; human review required"
    return $captured
}

function Assert-CanaryClientEstablished {
    param(
        # Test seam: when omitted, reads live rows via Get-TcpRows exactly as
        # before. Only a caller explicitly passing -Rows (the DryRun-only
        # -SimulateCanaryClientDrift self-test) ever supplies synthetic rows;
        # production call sites (Get-ProtectedBaseline, Assert-ProtectedBaseline)
        # never pass this and therefore always read the real live table.
        [object[]]$Rows,
        [string]$Message = "Expected Canary client relationship changed or is unknown"
    )
    $rows = if ($null -ne $Rows) { $Rows } else { Get-TcpRows }
    $canaryClientRows = @($rows | Where-Object {
        $_.RemotePort -eq 54330 -and $_.Pid -eq $script:ExpectedCanaryClientPid -and $_.State -eq "ESTABLISHED"
    })
    if ($canaryClientRows.Count -lt 1) {
        Stop-Harness "ABORT_CANARY_CLIENT" $Message
    }
}

function Assert-ProtectedBaseline {
    param([System.Collections.IDictionary]$Baseline)
    foreach ($entry in $Baseline.GetEnumerator()) {
        $listener = Get-Listener ([int]$entry.Key)
        if ($listener.LocalAddress -ne "127.0.0.1" -or $listener.Pid -ne [int]$entry.Value) {
            Stop-Harness "ABORT_PROTECTED_DRIFT" "Protected listener/PID changed on port $($entry.Key)"
        }
        if (-not (Test-TcpConnect ([int]$entry.Key))) {
            Stop-Harness "ABORT_PROTECTED_DRIFT" "Protected port $($entry.Key) stopped accepting connections"
        }
    }
    Assert-ApiHealthy
    Assert-CanaryClientEstablished
}

function Assert-PortUnused {
    param([int]$Port)
    if ($script:ProtectedPorts -contains $Port) {
        Stop-Harness "ABORT_PROTECTED_PORT" "Target port $Port is protected"
    }
    $rows = @(Get-TargetPortConflicts -Rows @(Get-TcpRows) -Port $Port)
    if ($rows.Count -ne 0) {
        Stop-Harness "ABORT_TARGET_PORT_USED" "Target port $Port has bind-conflicting, destination-port, or ambiguous TCP evidence"
    }
}

function Get-TargetPortConflicts {
    param([object[]]$Rows, [int]$Port)

    # Windows TCP endpoint semantics matter here. A row whose REMOTE port is
    # the target is an active use of the target endpoint and remains a
    # fail-closed conflict. A LISTENING/BOUND local endpoint is also a bind
    # conflict (or cannot safely be proved otherwise). For non-listening
    # connections, however, a concrete non-loopback local address using 55432
    # merely as an outbound ephemeral source port does not overlap the exact
    # PostgreSQL bind 127.0.0.1:55432. Treat unknown/wildcard/loopback local
    # addresses as conflicts; never guess when the address is ambiguous.
    return @($Rows | Where-Object {
        if ($_.RemotePort -eq $Port) { return $true }
        if ($_.LocalPort -ne $Port) { return $false }

        $state = ([string]$_.State).ToUpperInvariant()
        if ($state -eq "LISTENING" -or $state -eq "BOUND") { return $true }

        $address = ([string]$_.LocalAddress).Trim().TrimStart('[').TrimEnd(']')
        if ([string]::IsNullOrWhiteSpace($address)) { return $true }
        return $address -eq "127.0.0.1" -or $address -eq "0.0.0.0" -or
            $address -eq "::" -or $address -eq "::1" -or
            $address -eq "::ffff:127.0.0.1"
    })
}

function Assert-DisposablePortState {
    param(
        [object[]]$Rows,
        [int]$PostgresPid,
        [Nullable[int]]$AllowedClientPid
    )
    $listeners = @($Rows | Where-Object {
        $_.LocalPort -eq $script:ManifestTargetPort -and $_.State -eq "LISTENING"
    })
    if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne "127.0.0.1" -or $listeners[0].Pid -ne $PostgresPid) {
        Stop-Harness "ABORT_POSTGRES_IDENTITY" "Disposable listener identity is mismatched or unknown"
    }

    $established = @($Rows | Where-Object {
        $_.State -eq "ESTABLISHED" -and
        ($_.LocalPort -eq $script:ManifestTargetPort -or $_.RemotePort -eq $script:ManifestTargetPort)
    })
    if ($established.Count -eq 0 -and $null -ne $AllowedClientPid) {
        # The exact restore child may not have opened its one connection yet.
        return
    }
    if ($established.Count -eq 0) { return }
    if ($null -eq $AllowedClientPid -or $established.Count -ne 2) {
        Stop-Harness "ABORT_UNEXPECTED_55432_CLIENT" "Unexpected or unidentifiable 55432 client exists"
    }
    # A [Nullable[int]] that HAS a value boxes as a plain System.Int32 in
    # .NET/PowerShell, not as a boxed Nullable<Int32> -- so it has no .Value
    # property once stored in the parameter (previously threw "property
    # 'Value' cannot be found on this object"). Cast to [int] directly
    # instead; the $null check above already proved it is not null.
    $allowedClientPidValue = [int]$AllowedClientPid
    $client = @($established | Where-Object {
        $_.RemotePort -eq $script:ManifestTargetPort -and $_.Pid -eq $allowedClientPidValue
    })
    $server = @($established | Where-Object {
        $_.LocalPort -eq $script:ManifestTargetPort -and $_.Pid -eq $PostgresPid
    })
    if ($client.Count -ne 1 -or $server.Count -ne 1 -or
        $client[0].LocalAddress -ne "127.0.0.1" -or $client[0].RemoteAddress -ne "127.0.0.1" -or
        $server[0].LocalAddress -ne "127.0.0.1" -or $server[0].RemoteAddress -ne "127.0.0.1" -or
        $client[0].LocalPort -ne $server[0].RemotePort -or $client[0].RemotePort -ne $server[0].LocalPort) {
        Stop-Harness "ABORT_UNEXPECTED_55432_CLIENT" "55432 connection identity is mismatched or unknown"
    }
}

function Assert-NoRestoreEngineDrift {
    if ($SimulateEngineDrift) {
        Stop-Harness "ABORT_ENGINE_DRIFT" "Simulated psql discovery"
    }
    if (-not [string]::IsNullOrWhiteSpace($env:PAPERCLIP_PSQL_PATH)) {
        Stop-Harness "ABORT_PSQL_OVERRIDE" "PAPERCLIP_PSQL_PATH is set"
    }
    if (-not [string]::IsNullOrWhiteSpace($env:DATABASE_URL)) {
        Stop-Harness "ABORT_DATABASE_URL" "DATABASE_URL is set; default/config fallback risk is prohibited"
    }
    foreach ($name in @("psql", "psql.exe", "pg_restore", "pg_restore.exe")) {
        if (Get-Command $name -ErrorAction SilentlyContinue) {
            Stop-Harness "ABORT_ENGINE_DRIFT" "$name resolves in the current process"
        }
    }
}

function Assert-ManifestInputs {
    Assert-EqualText $BackupPath $script:ManifestBackupPath "ABORT_BACKUP_PATH" "Backup path"
    Assert-EqualText $BackupSha256 $script:ManifestBackupSha256 "ABORT_HASH_BINDING" "Expected backup SHA-256"
    if ($BackupSize -ne $script:ManifestBackupSize) {
        Stop-Harness "ABORT_SIZE_BINDING" "Expected backup size differs from the manifest"
    }
    if ($TargetPort -ne $script:ManifestTargetPort) {
        Stop-Harness "ABORT_PORT_BINDING" "Target port differs from the manifest"
    }
    Assert-EqualText $TempRoot $script:ManifestTempRoot "ABORT_TEMP_BINDING" "Temp root"
    if ($OperationTimeoutSeconds -lt 30 -or $OperationTimeoutSeconds -gt 900) {
        Stop-Harness "ABORT_TIMEOUT" "Operation timeout must be between 30 and 900 seconds"
    }
}

function Assert-BackupCandidate {
    if (-not (Test-Path -LiteralPath $script:ManifestBackupPath -PathType Leaf)) {
        Stop-Harness "ABORT_BACKUP_MISSING" "Pinned backup candidate is missing"
    }
    $item = Get-Item -LiteralPath $script:ManifestBackupPath
    if ($item.Length -ne $script:ManifestBackupSize) {
        Stop-Harness "ABORT_BACKUP_SIZE" "Pinned backup size mismatch"
    }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $script:ManifestBackupPath).Hash
    Assert-EqualText $hash $script:ManifestBackupSha256 "ABORT_BACKUP_HASH" "Pinned backup SHA-256"

    $stream = [System.IO.File]::OpenRead($script:ManifestBackupPath)
    $reader = $null
    try {
        $gzip = [System.IO.Compression.GZipStream]::new(
            $stream,
            [System.IO.Compression.CompressionMode]::Decompress
        )
        $reader = [System.IO.StreamReader]::new($gzip)
        $sawHeader = $false
        $sawBreakpoint = $false
        while (($line = $reader.ReadLine()) -ne $null) {
            if ($line -eq "-- Paperclip database backup") { $sawHeader = $true }
            if ($line -eq "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900") {
                $sawBreakpoint = $true
            }
        }
        if (-not $sawHeader -or -not $sawBreakpoint) {
            Stop-Harness "ABORT_BACKUP_FORMAT" "Backup is not the approved Paperclip statement format"
        }
    } catch {
        Stop-Harness "ABORT_GZIP" "Full gzip integrity scan failed"
    } finally {
        if ($reader) { $reader.Dispose() } else { $stream.Dispose() }
    }
}

function Assert-Binaries {
    foreach ($entry in $script:BinaryManifest.GetEnumerator()) {
        $path = Join-Path $script:NativeBin $entry.Key
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            Stop-Harness "ABORT_BINARY_MISSING" "$($entry.Key) is missing"
        }
        $item = Get-Item -LiteralPath $path
        if ($item.VersionInfo.ProductVersion -ne "18.1" -or $item.VersionInfo.FileVersion -ne "18.1") {
            Stop-Harness "ABORT_BINARY_VERSION" "$($entry.Key) is not PostgreSQL 18.1"
        }
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash
        Assert-EqualText $actual $entry.Value "ABORT_BINARY_HASH" "$($entry.Key) SHA-256"
    }
    if (-not (Test-Path -LiteralPath $script:RestoreHelper -PathType Leaf)) {
        Stop-Harness "ABORT_HELPER_MISSING" "Pinned direct JavaScript restore helper is missing"
    }
    $helperHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $script:RestoreHelper).Hash
    Assert-EqualText $helperHash $script:RestoreHelperSha256 "ABORT_HELPER_HASH" "Direct JavaScript restore helper SHA-256"
}

function Assert-TempRoot {
    $root = Get-CanonicalPath $TempRoot
    $expected = Get-CanonicalPath $script:ManifestTempRoot
    $parent = Get-CanonicalPath $script:ManifestTempParent
    $defaultRoot = Get-CanonicalPath $script:DefaultInstanceRoot
    Assert-EqualText $root $expected "ABORT_TEMP_PATH" "Canonical temp root"
    if (-not (Test-PathIsWithin $root $parent)) {
        Stop-Harness "ABORT_TEMP_PARENT" "Temp root resolves outside the approved parent"
    }
    if ($root.StartsWith($defaultRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        $root.IndexOf("\.paperclip", [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Stop-Harness "ABORT_TEMP_OVERLAP" "Temp root overlaps a Paperclip instance path"
    }
    if (Test-Path -LiteralPath $root) {
        Stop-Harness "ABORT_TEMP_EXISTS" "Fixed temp root already exists"
    }
    $parentItem = Get-Item -LiteralPath $parent
    if (($parentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        Stop-Harness "ABORT_TEMP_REPARSE" "Approved Temp parent is a reparse point"
    }
    $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($parent))
    if (-not $drive.IsReady -or $drive.AvailableFreeSpace -lt $script:MinimumFreeBytes) {
        Stop-Harness "ABORT_DISK_SPACE" "Temp drive has less than 5 GiB available"
    }
}

function Assert-StaticGuards {
    Assert-ManifestInputs
    Assert-BackupCandidate
    Assert-Binaries
    Assert-TempRoot
    Assert-NoRestoreEngineDrift
    Assert-PortUnused $TargetPort
    if ($SimulateUnexpectedClient) {
        $mockRows = @(
            [pscustomobject]@{ LocalAddress="127.0.0.1"; LocalPort=55432; RemoteAddress="0.0.0.0"; RemotePort=0; State="LISTENING"; Pid=90001 },
            [pscustomobject]@{ LocalAddress="127.0.0.1"; LocalPort=55432; RemoteAddress="127.0.0.1"; RemotePort=62000; State="ESTABLISHED"; Pid=90001 },
            [pscustomobject]@{ LocalAddress="127.0.0.1"; LocalPort=62000; RemoteAddress="127.0.0.1"; RemotePort=55432; State="ESTABLISHED"; Pid=90002 }
        )
        Assert-DisposablePortState $mockRows 90001 ([Nullable[int]]90003)
        Stop-Harness "ABORT_SELF_TEST" "Unexpected-client simulation did not reject the unapproved client"
    }
    if ($SimulateCanaryClientDrift) {
        # No real Canary process is touched: this feeds a synthetic row set
        # (lacking the expected ESTABLISHED 15228->54330 row) directly into
        # the same function production code calls with live rows.
        $mockRowsWithoutCanary = @(
            [pscustomobject]@{ LocalAddress="127.0.0.1"; LocalPort=54330; RemoteAddress="0.0.0.0"; RemotePort=0; State="LISTENING"; Pid=16208 }
        )
        Assert-CanaryClientEstablished -Rows $mockRowsWithoutCanary
        Stop-Harness "ABORT_SELF_TEST" "Canary-client-drift simulation did not reject the missing relationship"
    }
    if ($SimulateInitDbTimeoutKill) {
        # Exercises the exact kill-on-timeout path Invoke-InitDb relies on
        # (Wait-ExactProcess throw -> Stop-ExactNewChild), against a harmless
        # substitute process (Windows' own timeout.exe) instead of a real
        # initdb.exe, so no real initdb is ever spawned by this self-test.
        $timeoutExe = Join-Path $env:SystemRoot "System32\timeout.exe"
        $substitute = New-ExactProcess $timeoutExe @("/t", "30", "/nobreak")
        $substitutePid = $substitute.Id
        $timedOutAsExpected = $false
        try {
            [void](Wait-ExactProcess $substitute 0 "initdb-timeout-self-test")
        } catch {
            $timedOutAsExpected = $true
            Stop-ExactNewChild $substitute $substitutePid "initdb-timeout-self-test"
        }
        if (-not $timedOutAsExpected) {
            Stop-Harness "ABORT_SELF_TEST" "initdb-timeout-kill simulation substitute exited before it could be tested"
        }
        if (Get-Process -Id $substitutePid -ErrorAction SilentlyContinue) {
            Stop-Harness "ABORT_SELF_TEST" "initdb-timeout-kill simulation did not confirm exact termination"
        }
    }
}

function ConvertTo-WindowsCommandLineArgument {
    param([AllowEmptyString()][string]$Value)
    if ($Value.Length -eq 0) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }

    $builder = [System.Text.StringBuilder]::new()
    [void]$builder.Append('"')
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $slashes++
            continue
        }
        if ($character -eq '"') {
            [void]$builder.Append(('\' * (($slashes * 2) + 1)))
            [void]$builder.Append('"')
            $slashes = 0
            continue
        }
        if ($slashes) {
            [void]$builder.Append(('\' * $slashes))
            $slashes = 0
        }
        [void]$builder.Append($character)
    }
    if ($slashes) { [void]$builder.Append(('\' * ($slashes * 2))) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function New-ExactProcess {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [switch]$RedirectInput,
        # Guard 5 defense-in-depth: when set, the child's inherited PATH is
        # replaced with only the executable's own directory plus the Windows
        # system directory (needed for basic OS/CRT functionality). This is
        # additional to, not a substitute for, the restore engine never
        # containing any code path that invokes psql/pg_restore.
        [switch]$RestrictPathToOwnDirectory
    )
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $FilePath
    # The real initdb/postgres/restore spawns always happen after the temp
    # root is created, so this is always the temp root for them. The
    # DryRun-only self-tests (e.g. -SimulateInitDbTimeoutKill) call this
    # before the temp root exists; a nonexistent WorkingDirectory makes
    # Process.Start() throw, so fall back to a directory guaranteed to exist
    # in that case only. The substitute process used by that self-test does
    # not depend on its working directory.
    $info.WorkingDirectory = if (Test-Path -LiteralPath $script:ManifestTempRoot) { $script:ManifestTempRoot } else { $env:SystemRoot }
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = [bool]$RedirectInput
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    if ($RestrictPathToOwnDirectory) {
        $ownDirectory = Split-Path -Path $FilePath -Parent
        $systemDirectory = Join-Path $env:SystemRoot "System32"
        $info.EnvironmentVariables["PATH"] = "$ownDirectory;$systemDirectory"
    }
    # Windows PowerShell 5.1 has no ProcessStartInfo.ArgumentList. Build the
    # command line with the documented Windows argv escaping algorithm.
    $info.Arguments = (($Arguments | ForEach-Object {
        ConvertTo-WindowsCommandLineArgument ([string]$_)
    }) -join ' ')
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $info
    if (-not $process.Start()) {
        Stop-Harness "ABORT_PROCESS_START" "Failed to start approved child executable"
    }
    Add-Member -InputObject $process -NotePropertyName HarnessStdoutTask -NotePropertyValue $process.StandardOutput.ReadToEndAsync()
    Add-Member -InputObject $process -NotePropertyName HarnessStderrTask -NotePropertyValue $process.StandardError.ReadToEndAsync()
    return $process
}

function Wait-ExactProcess {
    param([System.Diagnostics.Process]$Process, [int]$TimeoutSeconds, [string]$Label)
    # Side-channel diagnostics for the caller's catch block, since this
    # function throws (rather than returns) on every failure path and a
    # thrown exception cannot itself carry structured data back to the
    # caller without a custom exception type. This never changes what
    # Wait-ExactProcess returns/throws to its callers -- it is purely
    # additive, read by Invoke-InitDb only to write supplemental failure
    # diagnostics evidence.
    $script:LastProcessDiagnostics = [ordered]@{
        label     = $Label
        processId = $Process.Id
        timedOut  = $false
        exitCode  = $null
        stdout    = $null
        stderr    = $null
    }
    if (-not $Process.WaitForExit($TimeoutSeconds * 1000)) {
        # This function only reports the timeout; it never force-kills here,
        # because it does not know whether $Process's identity is safe to
        # terminate. Guard 9 (initdb) relies on its caller's catch block
        # (Invoke-InitDb) to call Stop-ExactNewChild with the exact recorded
        # PID immediately after this throw, so the spawned child never
        # survives as an orphan. stdout/stderr are not read here: the
        # process has not exited, so blocking on ReadToEndAsync().Result
        # would itself hang. Stop-ExactNewChild captures what it can after
        # confirming the kill succeeded.
        $script:LastProcessDiagnostics.timedOut = $true
        Stop-Harness "ABORT_PROCESS_TIMEOUT" "$Label timed out; caller is responsible for exact-identity termination"
    }
    $stdout = $Process.HarnessStdoutTask.Result
    $stderr = $Process.HarnessStderrTask.Result
    $script:LastProcessDiagnostics.exitCode = $Process.ExitCode
    $script:LastProcessDiagnostics.stdout = $stdout
    $script:LastProcessDiagnostics.stderr = $stderr
    if ($Process.ExitCode -ne 0) {
        Stop-Harness "ABORT_PROCESS_FAILURE" "$Label failed; output retained only in memory and not printed"
    }
    return [pscustomobject]@{ Stdout = $stdout; Stderr = $stderr }
}

function Stop-ExactNewChild {
    param(
        [System.Diagnostics.Process]$Process,
        [int]$RecordedPid,
        [string]$Label
    )
    if ($Process.Id -ne $RecordedPid -or $script:ExpectedProtectedListeners.Values -contains $RecordedPid -or
        $RecordedPid -eq $script:ExpectedCanaryClientPid) {
        Stop-Harness "ABORT_CHILD_IDENTITY" "$Label child identity is mismatched or protected"
    }
    if (-not $Process.HasExited) {
        $Process.Kill()
        if (-not $Process.WaitForExit(5000) -or -not $Process.HasExited) {
            Stop-Harness "ABORT_CHILD_TERMINATION" "$Label exact child termination is unknown"
        }
        # Best-effort: the process is now confirmed exited (its stdout/stderr
        # streams are therefore closed), so it is now safe to read whatever
        # output it produced before being killed -- fills in the timeout
        # diagnostics that Wait-ExactProcess could not safely capture itself.
        if ($script:LastProcessDiagnostics -and $script:LastProcessDiagnostics.processId -eq $Process.Id -and $script:LastProcessDiagnostics.timedOut) {
            try {
                $script:LastProcessDiagnostics.stdout = $Process.HarnessStdoutTask.Result
                $script:LastProcessDiagnostics.stderr = $Process.HarnessStderrTask.Result
            } catch {
                # Leave as null if the streams cannot be read post-kill.
            }
        }
    }
}

function Get-RedactedDiagnosticText {
    param([string]$Text, [string]$Secret)
    if ([string]::IsNullOrEmpty($Text)) { return $Text }
    $redacted = $Text
    if (-not [string]::IsNullOrEmpty($Secret)) {
        $redacted = $redacted.Replace($Secret, "[REDACTED]")
    }
    # Defense-in-depth beyond the exact-string replace above: initdb/postgres
    # diagnostics are not expected to contain credentials at all, but any
    # line that happens to mention password/secret/token, or any URL with an
    # embedded credential, is scrubbed rather than trusted at face value.
    $redacted = $redacted -replace '(?im)^.*\b(password|secret|token)\b.*$', '[REDACTED LINE - matched password/secret/token]'
    $redacted = $redacted -replace '([a-zA-Z][a-zA-Z0-9+.-]*://[^:/\s]+):[^@/\s]+@', '$1:[REDACTED]@'
    return $redacted
}

function Write-InitDbProcessEvidence {
    param(
        [string]$Result,
        [Nullable[int]]$ProcessId,
        [Nullable[int]]$ExitCode,
        [bool]$TimedOut,
        [string]$Stdout,
        [string]$Stderr,
        [string]$Password,
        # False only for the partial-spawn-failure path: New-ExactProcess
        # itself threw (e.g. ABORT_PROCESS_START) before any process object,
        # PID, exit code, or stdout/stderr stream ever existed to observe.
        [bool]$ProcessStarted = $true,
        [string]$ExceptionCategory,
        [string]$ExceptionMessage
    )
    # Supplemental failure-diagnostics artifact only -- distinct from, and
    # never counted against, the official 10-file Evidence Bundle contract
    # (01-preflight-integrity.json .. 10-final-verdict-summary.json).
    # Ownership-gated exactly like Write-AbortReasonArtifact: never write
    # into a temp root this run did not itself create.
    if (-not $script:TempRootCreatedByThisRun) { return }
    $initdbExe = Join-Path $script:NativeBin "initdb.exe"
    $sanitizedArguments = @(
        "--pgdata=<temp-root>\pgdata",
        "--username=$script:TargetUser",
        "--auth-local=scram-sha-256",
        "--auth-host=scram-sha-256",
        "--pwfile=<temp-pwfile>",
        "--encoding=UTF8",
        "--no-instructions"
    )
    $payload = [ordered]@{
        stage                  = "initdb"
        executablePath         = $initdbExe
        sanitizedArguments     = $sanitizedArguments
        processStarted         = $ProcessStarted
        processId              = $ProcessId
        exitCode               = $ExitCode
        timedOut               = $TimedOut
        stdout                 = Get-RedactedDiagnosticText $Stdout $Password
        stderr                 = Get-RedactedDiagnosticText $Stderr $Password
        exceptionCategory      = $ExceptionCategory
        exceptionMessage       = Get-RedactedDiagnosticText $ExceptionMessage $Password
        pgDataPath             = $script:PgData
        workingDirectory       = $script:ManifestTempRoot
        pathRestrictionApplied = $false
        result                 = $Result
    }
    New-Item -ItemType Directory -Path $script:EvidenceDir -Force | Out-Null
    $ordered = [ordered]@{ timestampUtc = [DateTime]::UtcNow.ToString("o") }
    foreach ($key in $payload.Keys) { $ordered[$key] = $payload[$key] }
    $path = Join-Path $script:EvidenceDir "initdb-process-result.json"
    ($ordered | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $path -Encoding utf8
}

function Assert-InitializedPgData {
    $canonicalPgData = Get-CanonicalPath $script:PgData
    $expectedPgData = Get-CanonicalPath (Join-Path $script:ManifestTempRoot "pgdata")
    Assert-EqualText $canonicalPgData $expectedPgData "ABORT_INITDB_PGDATA" "Initialized pgdata path"
    if (-not (Test-Path -LiteralPath $canonicalPgData -PathType Container)) {
        Stop-Harness "ABORT_INITDB_PGDATA" "Exact pgdata directory was not created"
    }
    $item = Get-Item -LiteralPath $canonicalPgData -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        Stop-Harness "ABORT_INITDB_PGDATA" "Exact pgdata directory is a reparse point"
    }
    $versionFile = Join-Path $canonicalPgData "PG_VERSION"
    $configFile = Join-Path $canonicalPgData "postgresql.conf"
    if (-not (Test-Path -LiteralPath $versionFile -PathType Leaf) -or
        -not (Test-Path -LiteralPath $configFile -PathType Leaf) -or
        (Get-Content -LiteralPath $versionFile -Raw).Trim() -ne "18") {
        Stop-Harness "ABORT_INITDB_PGDATA" "Initialized pgdata identity is incomplete or unknown"
    }
}

function New-InitDbPasswordFile {
    # Root-cause fix for the retry1 initdb failure: this embedded PostgreSQL
    # 18.1-beta.16 Windows initdb.exe does not honor "--pwfile=-" as a stdin
    # sentinel -- it treats "-" as a literal filename and fails with
    # "could not open file \"-\" for reading: No such file or directory"
    # (confirmed via initdb-process-result.json from the real retry1 attempt).
    # This replaces stdin delivery with a short-lived, ACL-restricted file
    # whose path (never its content) is passed to --pwfile. The ACL is
    # locked down to the current user BEFORE the secret is written, so the
    # file never has broader-than-owner permissions while it holds the
    # password. Any failure here throws before the caller ever has a path to
    # act on, and this function cleans up its own partial file on failure.
    param([string]$Password)
    $path = Join-Path $script:ManifestTempParent ("nexora-restore-pwfile-" + [Guid]::NewGuid().ToString("N") + ".tmp")
    $created = $false
    try {
        New-Item -ItemType File -Path $path -ErrorAction Stop | Out-Null
        $created = $true
        $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl = [System.Security.AccessControl.FileSecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        $acl.SetOwner($currentUser)
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($currentUser, "FullControl", "Allow"))
        [System.IO.File]::SetAccessControl($path, $acl)
        # Defense-in-depth: read the ACL back and require exactly one
        # non-inherited Allow rule for exactly the current user before the
        # secret is ever written to the file.
        $verify = (Get-Acl -LiteralPath $path).Access | Where-Object { -not $_.IsInherited }
        $currentUserName = $currentUser.Translate([System.Security.Principal.NTAccount]).Value
        if (@($verify).Count -ne 1 -or $verify[0].IdentityReference.Value -ne $currentUserName -or $verify[0].AccessControlType -ne "Allow") {
            Stop-Harness "ABORT_PWFILE_ACL" "Temporary initdb password file ACL could not be restricted to the current user only"
        }
        [System.IO.File]::WriteAllText($path, $Password, [System.Text.UTF8Encoding]::new($false))
        return $path
    } catch {
        if ($created -and (Test-Path -LiteralPath $path)) {
            Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        }
        throw
    }
}

function Remove-InitDbPasswordFile {
    # Deletion is unconditional and fail-closed: whether initdb succeeded or
    # failed, a password-bearing file must never be left on disk. If it
    # cannot be proven deleted, this aborts the run rather than treating the
    # leftover secret file as an acceptable retained artifact.
    param([string]$Path)
    try {
        Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
    } catch {
        Stop-Harness "ABORT_PWFILE_CLEANUP" "Failed to delete the temporary initdb password file; treated as a fail-closed blocker rather than leaving a password-bearing file on disk"
    }
}

function Invoke-InitDb {
    param([string]$Password)
    $initdb = Join-Path $script:NativeBin "initdb.exe"
    $pwFilePath = $null
    $process = $null
    $recordedPid = $null
    $script:LastProcessDiagnostics = $null
    try {
        $pwFilePath = New-InitDbPasswordFile $Password
        $arguments = @(
            "--pgdata=$script:PgData",
            "--username=$script:TargetUser",
            "--auth-local=scram-sha-256",
            "--auth-host=scram-sha-256",
            "--pwfile=$pwFilePath",
            "--encoding=UTF8",
            "--no-instructions"
        )
        # New-ExactProcess is inside this try (previously it sat outside it),
        # because a throw from New-ExactProcess itself -- e.g.
        # ABORT_PROCESS_START, before any process object ever existed -- was
        # previously invisible to this function's own catch, so no
        # initdb-process-result.json was ever written for that failure mode.
        # -RedirectInput is no longer needed: the password now travels only
        # via the ACL-restricted file path above, never via stdin.
        $process = New-ExactProcess $initdb $arguments
        $recordedPid = $process.Id
        [void](Wait-ExactProcess $process 120 "initdb")
        Assert-InitializedPgData
        $diag = $script:LastProcessDiagnostics
        Write-InitDbProcessEvidence -Result "PASS" -ProcessId $diag.processId -ExitCode $diag.exitCode `
            -TimedOut $diag.timedOut -Stdout $diag.stdout -Stderr $diag.stderr -Password $Password `
            -ProcessStarted $true
    } catch {
        $originalError = $_
        if ($process) {
            Stop-ExactNewChild $process $recordedPid "initdb"
        }
        $diag = $script:LastProcessDiagnostics
        if (-not $process) {
            # Partial spawn failure: no process object, no PID, no exit code,
            # no timeout, and no stdout/stderr stream ever existed.
            Write-InitDbProcessEvidence -Result "ABORT" -ProcessId $null -ExitCode $null `
                -TimedOut $false -Stdout $null -Stderr $null -Password $Password `
                -ProcessStarted $false `
                -ExceptionCategory $originalError.Exception.GetType().Name `
                -ExceptionMessage $originalError.Exception.Message
        } else {
            $failResult = if ($diag -and $diag.timedOut) { "ABORT" } elseif ($diag -and $null -ne $diag.exitCode) { "FAIL" } else { "ABORT" }
            Write-InitDbProcessEvidence -Result $failResult `
                -ProcessId $(if ($diag) { $diag.processId } else { $recordedPid }) `
                -ExitCode $(if ($diag) { $diag.exitCode } else { $null }) `
                -TimedOut $(if ($diag) { [bool]$diag.timedOut } else { $false }) `
                -Stdout $(if ($diag) { $diag.stdout } else { $null }) `
                -Stderr $(if ($diag) { $diag.stderr } else { $null }) `
                -Password $Password -ProcessStarted $true
        }
        throw $originalError
    } finally {
        # Runs on every path (PASS, FAIL, ABORT, and even the partial-spawn
        # failure where $process was never assigned) as long as the password
        # file was actually created. A cleanup failure here throws
        # ABORT_PWFILE_CLEANUP, which -- per PowerShell finally semantics --
        # supersedes any exception already in flight from the try/catch
        # above; that is the intended fail-closed priority: a password file
        # that cannot be proven deleted is a more urgent condition than
        # whatever initdb error preceded it.
        if ($pwFilePath) {
            Remove-InitDbPasswordFile $pwFilePath
        }
    }
}

function Start-DisposablePostgres {
    $postgres = Join-Path $script:NativeBin "postgres.exe"
    $process = New-ExactProcess $postgres @(
        "-D", $script:PgData,
        "-h", "127.0.0.1",
        "-p", "$script:ManifestTargetPort"
    )
    $script:PostgresProcess = $process
    $script:DisposablePid = $process.Id
    if ($script:ExpectedProtectedListeners.Values -contains $script:DisposablePid -or
        $script:DisposablePid -eq $script:ExpectedCanaryClientPid) {
        Stop-Harness "ABORT_DISPOSABLE_PID" "New PostgreSQL PID collides with a protected PID"
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
        if ($process.HasExited) {
            Stop-Harness "ABORT_POSTGRES_EXIT" "Disposable PostgreSQL exited before readiness"
        }
        $rows = @(Get-TcpRows)
        $listeners = @($rows | Where-Object {
            $_.LocalPort -eq $script:ManifestTargetPort -and $_.State -eq "LISTENING"
        })
        if ($listeners.Count -eq 1) {
            Assert-DisposablePortState $rows $script:DisposablePid $null
            $postmasterPidFile = Join-Path $script:PgData "postmaster.pid"
            $postmasterLines = if (Test-Path -LiteralPath $postmasterPidFile -PathType Leaf) { @(Get-Content -LiteralPath $postmasterPidFile) } else { @() }
            Write-PsEvidence "02-disposable-cluster-lifecycle.json" ([ordered]@{
                stage             = "disposable_cluster_lifecycle"
                disposablePid     = $script:DisposablePid
                listenerAddress   = $listeners[0].LocalAddress
                listenerPort      = $listeners[0].LocalPort
                pgDataPath        = $script:PgData
                postmasterPidFileLineCount = $postmasterLines.Count
                nonLoopbackListenerFound = ($listeners[0].LocalAddress -ne "127.0.0.1")
                pass              = ($listeners[0].LocalAddress -eq "127.0.0.1" -and $listeners[0].Pid -eq $script:DisposablePid -and $postmasterLines.Count -ge 6)
            })
            return
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    Stop-Harness "ABORT_POSTGRES_TIMEOUT" "Disposable PostgreSQL readiness timed out"
}

function Invoke-RestoreWithMonitoring {
    param([string]$Password, [System.Collections.IDictionary]$Baseline)
    Assert-NoRestoreEngineDrift
    Assert-ProtectedBaseline $Baseline
    Assert-DisposablePortState @(Get-TcpRows) $script:DisposablePid $null
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $process = New-ExactProcess $node @(
        $script:RestoreHelper,
        $script:ManifestBackupPath,
        $script:PgData,
        "$script:DisposablePid",
        $script:EvidenceDir
    ) -RedirectInput -RestrictPathToOwnDirectory
    $process.StandardInput.WriteLine($Password)
    $process.StandardInput.Close()
    $script:RestoreWasCalled = $true

    $deadline = [DateTime]::UtcNow.AddSeconds($OperationTimeoutSeconds)
    while (-not $process.HasExited) {
        try {
            Assert-ProtectedBaseline $Baseline
            Assert-DisposablePortState @(Get-TcpRows) $script:DisposablePid ([Nullable[int]]$process.Id)
        } catch {
            Stop-ExactNewChild $process $process.Id "restore"
            Stop-Harness "ABORT_PROTECTED_DURING_RESTORE" "Protected service drifted; exact restore child was terminated"
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            Stop-ExactNewChild $process $process.Id "restore"
            Stop-Harness "ABORT_RESTORE_TIMEOUT" "Restore exceeded the approved timeout"
        }
        Start-Sleep -Seconds 2
    }
    $stdout = $process.HarnessStdoutTask.Result
    $stderr = $process.HarnessStderrTask.Result
    # Parsed before the exit-code check (but never used to bypass it): a
    # Guard 16 verification failure inside the .mjs still exits non-zero (by
    # design, so no automatic success path exists), but it writes its JSON
    # result to stdout first -- reading it here lets a verification failure
    # be reported distinctly from a genuine restore/SQL-execution failure,
    # instead of collapsing both into the same generic message.
    $parsedResult = $null
    try { $parsedResult = $stdout | ConvertFrom-Json } catch { $parsedResult = $null }

    if ($process.ExitCode -ne 0) {
        if ($parsedResult -and $parsedResult.verdict -ceq "VERIFICATION_FAILED") {
            Stop-Harness "ABORT_GUARD16_VERIFICATION_FAILED" "Restore executed with zero SQL errors, but Guard 16 schema/data/Approval-TTL verification failed; evidence retained under $script:EvidenceDir for review"
        }
        Stop-Harness "ABORT_RESTORE_FAILURE" "Pinned direct JavaScript restore child failed; sensitive output was suppressed"
    }
    if (-not $parsedResult) {
        Stop-Harness "ABORT_ENGINE_ORIGIN" "Restore engine origin result was missing or invalid"
    }
    if ($parsedResult.engineOrigin -cne $script:RestoreEngineOrigin -or [long]$parsedResult.statementCount -lt 1 -or
        [long]$parsedResult.jitElapsedMs -gt 1000 -or $parsedResult.verdict -cne "VERIFIED_PASS") {
        Stop-Harness "ABORT_ENGINE_ORIGIN" "Restore engine origin, JIT result, or Guard 16 verdict was not exact"
    }
    Assert-ProtectedBaseline $Baseline
    return $parsedResult
}

function Get-ValidatedPostmasterIdentity {
    if (-not $script:DisposablePid) {
        Stop-Harness "ABORT_CLEANUP_PID" "No disposable PID was recorded"
    }
    $pidFile = Join-Path $script:PgData "postmaster.pid"
    if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) {
        Stop-Harness "ABORT_CLEANUP_PIDFILE" "Disposable postmaster.pid is missing"
    }
    $lines = @(Get-Content -LiteralPath $pidFile)
    if ($lines.Count -lt 6) {
        Stop-Harness "ABORT_CLEANUP_PIDFILE" "Disposable postmaster.pid is malformed"
    }
    $pidValue = 0
    $portValue = 0
    if (-not [int]::TryParse($lines[0].Trim(), [ref]$pidValue) -or
        -not [int]::TryParse($lines[3].Trim(), [ref]$portValue)) {
        Stop-Harness "ABORT_CLEANUP_PIDFILE" "Disposable PID or port is unknown"
    }
    Assert-EqualText (Get-CanonicalPath $lines[1].Trim()) (Get-CanonicalPath $script:PgData) "ABORT_CLEANUP_DATADIR" "postmaster data directory"
    if ($pidValue -ne $script:DisposablePid -or $portValue -ne $script:ManifestTargetPort) {
        Stop-Harness "ABORT_CLEANUP_IDENTITY" "Disposable PID/port identity mismatch"
    }
    if ($script:ExpectedProtectedListeners.Values -contains $pidValue -or $pidValue -eq $script:ExpectedCanaryClientPid) {
        Stop-Harness "ABORT_CLEANUP_PROTECTED" "Disposable PID matches a protected PID"
    }
    $listener = Get-Listener $script:ManifestTargetPort
    if ($listener.LocalAddress -ne "127.0.0.1" -or $listener.Pid -ne $pidValue) {
        Stop-Harness "ABORT_CLEANUP_LISTENER" "Disposable listener identity mismatch"
    }
    return [pscustomobject]@{ Pid = $pidValue; Port = $portValue; DataDir = $lines[1].Trim() }
}

function Stop-DisposablePostgresRetainArtifacts {
    [void](Get-ValidatedPostmasterIdentity)
    $pgCtl = Join-Path $script:NativeBin "pg_ctl.exe"
    $process = New-ExactProcess $pgCtl @(
        "-D", $script:PgData,
        "-m", "fast",
        "-w", "stop"
    )
    [void](Wait-ExactProcess $process 60 "pg_ctl stop")
    $remaining = @(Get-TargetPortConflicts -Rows @(Get-TcpRows) -Port $script:ManifestTargetPort)
    if ($remaining.Count -ne 0) {
        Stop-Harness "ABORT_CLEANUP_PORT" "55432 remains present after pg_ctl stop"
    }
    $script:DisposablePid = $null
}

function Write-PsEvidence {
    param([string]$Name, [System.Collections.IDictionary]$Payload)
    # Mirrors the .mjs helper's writeEvidence(): the evidence directory is
    # only ever created once the mutating boundary is already crossed (this
    # is called after New-Item on $script:ManifestTempRoot in the -Execute
    # path), and every field written here is a value this script itself just
    # observed -- never an assumed/self-authored "ok". The ownership check is
    # a pure safety net (every real call site already runs strictly after
    # New-Item succeeds) that fails loud rather than silently writing into a
    # temp root this run did not itself create.
    if (-not $script:TempRootCreatedByThisRun) {
        Stop-Harness "ABORT_EVIDENCE_OWNERSHIP" "Refusing to write $Name outside a temp root this run created"
    }
    New-Item -ItemType Directory -Path $script:EvidenceDir -Force | Out-Null
    $ordered = [ordered]@{ timestampUtc = [DateTime]::UtcNow.ToString("o") }
    foreach ($key in $Payload.Keys) { $ordered[$key] = $Payload[$key] }
    $path = Join-Path $script:EvidenceDir $Name
    ($ordered | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $path -Encoding utf8
}

function Write-AbortReasonArtifact {
    param([string]$Message)
    # Fail-closed ownership check: only the run that itself created this temp
    # root (via the New-Item call in the main flow, which sets
    # $script:TempRootCreatedByThisRun immediately after succeeding) may
    # write into it. The previous check here was merely Test-Path -- true
    # for a directory *any* earlier run left behind -- which is exactly how
    # a real Gate C failure's ABORT_REASON.json was later overwritten by an
    # unrelated regression-test run that never got past Assert-TempRoot.
    # A run that fails before ever reaching New-Item (including one that
    # fails exactly because the root already exists) now writes nothing.
    if (-not $script:TempRootCreatedByThisRun) { return }

    # Defense-in-depth: even if the ownership flag above were ever wrong,
    # never write into any retained-evidence root from a prior real
    # (non-simulated) restore attempt (historical and retry1). Neither is
    # ever the active manifest root for any current run.
    $canonicalTarget = Get-CanonicalPath $script:ManifestTempRoot
    foreach ($retainedRoot in $script:ProtectedRetainedRoots) {
        if ([string]::Equals($canonicalTarget, (Get-CanonicalPath $retainedRoot), [System.StringComparison]::OrdinalIgnoreCase)) {
            [Console]::Error.WriteLine("BLOCKED: refusing to write into a retained evidence root ($retainedRoot)")
            return
        }
    }

    try {
        $reasonPath = Join-Path $script:ManifestTempRoot "ABORT_REASON.json"
        if (Test-Path -LiteralPath $reasonPath) {
            # Append-only, never overwrite: if ABORT_REASON.json already
            # exists for any reason, this run's message goes to a distinct,
            # timestamped filename instead of destroying what is there.
            $reasonPath = Join-Path $script:ManifestTempRoot ("ABORT_REASON-{0}.json" -f ([DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")))
        }
        $record = [ordered]@{
            timestampUtc = [DateTime]::UtcNow.ToString("o")
            message      = $Message
        }
        ($record | ConvertTo-Json) | Set-Content -LiteralPath $reasonPath -Encoding utf8
        [Console]::Error.WriteLine("RETAINED: failure artifacts preserved at $script:ManifestTempRoot (see $(Split-Path -Leaf $reasonPath))")
    } catch {
        [Console]::Error.WriteLine("RETAINED: failure artifacts preserved at $script:ManifestTempRoot (ABORT_REASON.json could not be written)")
    }
}

function Remove-DisposableArtifactsAfterFinalPass {
    param([switch]$FinalPass)
    if (-not $FinalPass) {
        Stop-Harness "ABORT_ARTIFACT_RETENTION" "Temp artifacts may be removed only after the future Phase B final PASS"
    }
    $canonicalRoot = Get-CanonicalPath $script:ManifestTempRoot
    Assert-EqualText $canonicalRoot (Get-CanonicalPath $TempRoot) "ABORT_CLEANUP_ROOT" "Cleanup root"
    if (-not (Test-PathIsWithin $canonicalRoot $script:ManifestTempParent)) {
        Stop-Harness "ABORT_CLEANUP_PARENT" "Cleanup root escaped approved Temp parent"
    }
    Remove-Item -LiteralPath $canonicalRoot -Recurse -Force
}

try {
    if ($Execute -and $ApprovalToken -cne $script:RequiredApprovalToken) {
        Stop-Harness "ABORT_HUMAN_APPROVAL" "Exact human approval token is required"
    }

    Assert-StaticGuards
    $baseline = Get-ProtectedBaseline
    Assert-ProtectedBaseline $baseline

    if ($DryRun) {
        if ($script:RestoreWasCalled) {
            Stop-Harness "ABORT_DRY_RUN_MUTATION" "Restore path was unexpectedly called"
        }
        Write-Output "DRY_RUN_PASS"
        Write-Output "STATIC_GUARDS_PASS"
        Write-Output "PROTECTED_BASELINE_PASS"
        Write-Output "RESTORE_NOT_CALLED"
        exit 0
    }

    # Mutating execution begins only below this line after every static and
    # read-only preflight guard has passed and exact human approval was bound.
    New-Item -ItemType Directory -Path $script:ManifestTempRoot | Out-Null
    $script:TempRootCreatedByThisRun = $true
    Write-PsEvidence "01-preflight-integrity.json" ([ordered]@{
        stage             = "preflight_integrity"
        backupPath        = $script:ManifestBackupPath
        backupSha256      = $script:ManifestBackupSha256
        backupSizeBytes   = $script:ManifestBackupSize
        selectedPort      = $script:ManifestTargetPort
        tempRoot          = $script:ManifestTempRoot
        binaryHashes      = $script:BinaryManifest
        restoreHelperSha256 = $script:RestoreHelperSha256
        protectedBaselineAtStart = $baseline
        humanApprovalTokenReference = "provided (value not recorded)"
        pass              = $true
    })
    $securePassword = Read-Host "Disposable PostgreSQL password" -AsSecureString
    $credential = [System.Management.Automation.PSCredential]::new($script:TargetUser, $securePassword)
    $password = $credential.GetNetworkCredential().Password
    if ([string]::IsNullOrWhiteSpace($password)) {
        Stop-Harness "ABORT_PASSWORD" "Disposable password is empty"
    }

    Invoke-InitDb $password
    Assert-ProtectedBaseline $baseline
    Assert-PortUnused $script:ManifestTargetPort
    Start-DisposablePostgres
    Assert-ProtectedBaseline $baseline
    $restoreResult = Invoke-RestoreWithMonitoring $password $baseline
    # Guard 16 already ran and passed inside Invoke-RestoreWithMonitoring (it
    # throws otherwise); stop only the identity-proven disposable server.
    Stop-DisposablePostgresRetainArtifacts

    $postCleanupPortRows = @(Get-TargetPortConflicts -Rows @(Get-TcpRows) -Port $script:ManifestTargetPort)
    Write-PsEvidence "09-cleanup-verification.json" ([ordered]@{
        stage                    = "cleanup_verification"
        stoppedDisposablePid     = $script:DisposablePid
        targetPortResidualRows   = $postCleanupPortRows.Count
        pass                     = ($postCleanupPortRows.Count -eq 0)
    })
    Assert-ProtectedBaseline $baseline
    $postBaseline = Get-ProtectedBaseline
    $protectedUnchanged = $true
    foreach ($entry in $baseline.GetEnumerator()) {
        if ($postBaseline[$entry.Key] -ne $entry.Value) { $protectedUnchanged = $false }
    }
    Write-PsEvidence "08-protected-services-baseline-comparison.json" ([ordered]@{
        stage       = "protected_services_baseline_comparison"
        before      = $baseline
        after       = $postBaseline
        unchanged   = $protectedUnchanged
        pass        = $protectedUnchanged
    })

    $overallPass = $protectedUnchanged -and ($postCleanupPortRows.Count -eq 0) -and
        $restoreResult.verdict -ceq "VERIFIED_PASS" -and
        $restoreResult.guard16.schemaPass -and $restoreResult.guard16.dataPass -and $restoreResult.guard16.ttlPass
    Write-PsEvidence "10-final-verdict-summary.json" ([ordered]@{
        stage                = "final_verdict_summary"
        restoreEngineOrigin  = $restoreResult.engineOrigin
        statementCount       = $restoreResult.statementCount
        jitElapsedMs         = $restoreResult.jitElapsedMs
        guard16              = $restoreResult.guard16
        protectedServicesUnchanged = $protectedUnchanged
        disposableCleanupVerified  = ($postCleanupPortRows.Count -eq 0)
        overallPass          = $overallPass
        note                 = "Evidence and temp root retained regardless of this verdict, pending a separate independent audit and explicit human decision before any cleanup or live execution approval."
    })

    if (-not $overallPass) {
        # Every sub-check above already throws on its own failure; this is a
        # final defense-in-depth check, not the primary enforcement path.
        Stop-Harness "ABORT_FINAL_VERDICT" "Aggregate Phase B verdict was not an exact PASS despite no individual guard throwing; evidence retained"
    }
    Write-Output "RESTORE_PHASE_B_VERIFIED_PASS_ARTIFACTS_RETAINED_PENDING_INDEPENDENT_AUDIT"
} catch {
    $failure = $_
    # On failure, stop only an identity-proven disposable server. Never delete
    # the temp root or evidence; unknown identity retains process and artifacts.
    if ($script:DisposablePid) {
        try {
            Stop-DisposablePostgresRetainArtifacts
        } catch {
            [Console]::Error.WriteLine("BLOCKED: disposable identity/pg_ctl cleanup could not be proven; temp artifacts were retained")
        }
    }
    Write-AbortReasonArtifact $failure.Exception.Message
    [Console]::Error.WriteLine($failure.Exception.Message)
    if ($DryRun) { [Console]::Error.WriteLine($failure.ScriptStackTrace) }
    exit 1
}
