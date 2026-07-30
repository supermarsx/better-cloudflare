param(
    [Parameter(Mandatory = $true)]
    [string[]]$NodeArguments,
    [ValidateRange(128, 4096)]
    [int]$HeapLimitMiB = 1024,
    [ValidateRange(256, 8192)]
    [int]$ProcessTreeLimitMiB = 1536,
    [ValidateRange(1, 1800)]
    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
$stdoutPath = [System.IO.Path]::GetTempFileName()
$stderrPath = [System.IO.Path]::GetTempFileName()
$previousNodeOptions = $env:NODE_OPTIONS
$nodeProcess = $null

try {
    $env:NODE_OPTIONS = "--max-old-space-size=$HeapLimitMiB"
    $nodeProcess = Start-Process `
        -FilePath "node" `
        -ArgumentList $NodeArguments `
        -WorkingDirectory (Get-Location).Path `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    # Windows retains the numeric parent PID after a parent exits. A later PID
    # reuse must not make an older, unrelated process look like our descendant.
    $rootStartedAt = $nodeProcess.StartTime.ToUniversalTime().AddSeconds(-1)
    $peakBytes = [int64]0
    $limitBytes = [int64]($ProcessTreeLimitMiB * 1MB)
    $terminationReason = $null

    while (-not $nodeProcess.HasExited) {
        $processRows = @(
            Get-CimInstance Win32_Process |
                Select-Object ProcessId, ParentProcessId, CreationDate
        )
        $treeIds = [System.Collections.Generic.HashSet[int]]::new()
        [void]$treeIds.Add([int]$nodeProcess.Id)

        $changed = $true
        while ($changed) {
            $changed = $false
            foreach ($row in $processRows) {
                if (
                    $row.CreationDate -and
                    $row.CreationDate.ToUniversalTime() -ge $rootStartedAt -and
                    $treeIds.Contains([int]$row.ParentProcessId) -and
                    $treeIds.Add([int]$row.ProcessId)
                ) {
                    $changed = $true
                }
            }
        }

        $treeBytes = [int64]0
        foreach ($processId in $treeIds) {
            $ownedProcess = Get-Process -Id $processId -ErrorAction SilentlyContinue
            if ($ownedProcess) {
                $treeBytes += [int64]$ownedProcess.WorkingSet64
            }
        }
        if ($treeBytes -gt $peakBytes) {
            $peakBytes = $treeBytes
        }

        if ($treeBytes -gt $limitBytes) {
            $terminationReason = "Process tree exceeded $ProcessTreeLimitMiB MiB."
        } elseif ([DateTime]::UtcNow -gt $deadline) {
            $terminationReason = "Watchdog exceeded $TimeoutSeconds seconds."
        }

        if ($terminationReason) {
            foreach ($processId in @($treeIds | Sort-Object -Descending)) {
                Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
            }
            break
        }

        Start-Sleep -Milliseconds 200
        $nodeProcess.Refresh()
    }

    $nodeProcess.WaitForExit()
    Get-Content -LiteralPath $stdoutPath
    Get-Content -LiteralPath $stderrPath
    Write-Output "WATCHDOG_PEAK_MIB=$([Math]::Round($peakBytes / 1MB, 1))"

    if ($terminationReason) {
        throw $terminationReason
    }
    exit $nodeProcess.ExitCode
} finally {
    if ($null -eq $previousNodeOptions) {
        Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    } else {
        $env:NODE_OPTIONS = $previousNodeOptions
    }
    Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
}
