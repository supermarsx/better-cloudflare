[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$FilePath,

  [string[]]$CommandArguments = @(),

  [string]$CommandArgumentsJson = "",

  [string]$WorkingDirectory = (Get-Location).Path,

  [ValidateRange(0, 1048576)]
  [long]$MemoryLimitMiB = 0,

  [ValidateRange(1, 86400)]
  [int]$TimeoutSeconds = 300,

  [ValidateRange(25, 10000)]
  [int]$PollIntervalMilliseconds = 100
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) {
  throw "Working directory does not exist: $WorkingDirectory"
}

if (-not ("BetterCloudflare.ProcessJob" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace BetterCloudflare
{
    public sealed class ProcessJob : IDisposable
    {
        private const int JobObjectBasicProcessIdList = 3;
        private const int JobObjectExtendedLimitInformationClass = 9;
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;
        private IntPtr handle;

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectBasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectExtendedLimitInformation
        {
            public JobObjectBasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(
            IntPtr jobAttributes,
            string name
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint informationLength
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool QueryInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint informationLength,
            out uint returnLength
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(
            IntPtr job,
            IntPtr process
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(
            IntPtr job,
            uint exitCode
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        public ProcessJob()
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero)
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "CreateJobObject failed"
                );
            }

            JobObjectExtendedLimitInformation limits =
                new JobObjectExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags =
                JobObjectLimitKillOnJobClose;

            int length = Marshal.SizeOf(limits);
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(limits, buffer, false);
                if (!SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformationClass,
                    buffer,
                    (uint)length
                ))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "SetInformationJobObject failed"
                    );
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        public void Assign(Process process)
        {
            if (!AssignProcessToJobObject(handle, process.Handle))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "AssignProcessToJobObject failed"
                );
            }
        }

        public int[] GetProcessIds()
        {
            const int capacity = 4096;
            int length = 8 + (capacity * IntPtr.Size);
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try
            {
                uint returnLength;
                if (!QueryInformationJobObject(
                    handle,
                    JobObjectBasicProcessIdList,
                    buffer,
                    (uint)length,
                    out returnLength
                ))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "QueryInformationJobObject failed"
                    );
                }

                uint count = (uint)Marshal.ReadInt32(buffer, 4);
                int[] processIds = new int[count];
                for (uint index = 0; index < count; index++)
                {
                    int offset = 8 + ((int)index * IntPtr.Size);
                    long processId = IntPtr.Size == 8
                        ? Marshal.ReadInt64(buffer, offset)
                        : Marshal.ReadInt32(buffer, offset);
                    processIds[index] = checked((int)processId);
                }
                return processIds;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        public void Terminate(uint exitCode)
        {
            if (handle != IntPtr.Zero && !TerminateJobObject(handle, exitCode))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "TerminateJobObject failed"
                );
            }
        }

        public void Dispose()
        {
            if (handle != IntPtr.Zero)
            {
                CloseHandle(handle);
                handle = IntPtr.Zero;
            }
            GC.SuppressFinalize(this);
        }

        ~ProcessJob()
        {
            Dispose();
        }
    }

    public sealed class ProcessOutputPump : IDisposable
    {
        private readonly Process process;
        private readonly System.Threading.ManualResetEventSlim outputClosed;
        private readonly System.Threading.ManualResetEventSlim errorClosed;
        private readonly DataReceivedEventHandler outputHandler;
        private readonly DataReceivedEventHandler errorHandler;

        public ProcessOutputPump(Process process)
        {
            this.process = process;
            outputClosed = new System.Threading.ManualResetEventSlim(false);
            errorClosed = new System.Threading.ManualResetEventSlim(false);
            outputHandler = delegate(object sender, DataReceivedEventArgs args)
            {
                if (args.Data == null)
                {
                    outputClosed.Set();
                    return;
                }
                Console.Out.WriteLine(args.Data);
                Console.Out.Flush();
            };
            errorHandler = delegate(object sender, DataReceivedEventArgs args)
            {
                if (args.Data == null)
                {
                    errorClosed.Set();
                    return;
                }
                Console.Error.WriteLine(args.Data);
                Console.Error.Flush();
            };
            process.OutputDataReceived += outputHandler;
            process.ErrorDataReceived += errorHandler;
        }

        public void Start()
        {
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
        }

        public void WaitForDrain(int timeoutMilliseconds)
        {
            if (
                !outputClosed.Wait(timeoutMilliseconds) ||
                !errorClosed.Wait(timeoutMilliseconds)
            )
            {
                throw new TimeoutException(
                    "Timed out draining child process output."
                );
            }
        }

        public void Dispose()
        {
            process.OutputDataReceived -= outputHandler;
            process.ErrorDataReceived -= errorHandler;
            outputClosed.Dispose();
            errorClosed.Dispose();
        }
    }
}
"@
}

$resolvedFilePath = (Get-Command -Name $FilePath -ErrorAction Stop).Source
$resolvedWorkingDirectory = (Resolve-Path -LiteralPath $WorkingDirectory).Path
$effectiveCommandArguments = if ($CommandArgumentsJson.Length -gt 0) {
  $decodedArguments = ConvertFrom-Json -InputObject $CommandArgumentsJson
  @($decodedArguments | ForEach-Object { $_ })
}
else {
  @($CommandArguments)
}
$gateName = "BetterCloudflareWatchdog-$([Guid]::NewGuid().ToString('N'))"
$gate = New-Object System.Threading.EventWaitHandle(
  $false,
  [System.Threading.EventResetMode]::ManualReset,
  $gateName
)
$completionGateName = (
  "BetterCloudflareWatchdogCompletion-$([Guid]::NewGuid().ToString('N'))"
)
$completionGate = New-Object System.Threading.EventWaitHandle(
  $false,
  [System.Threading.EventResetMode]::ManualReset,
  $completionGateName
)
$exitCodeMapName = (
  "BetterCloudflareWatchdogExitCode-$([Guid]::NewGuid().ToString('N'))"
)
$exitCodeMap = [System.IO.MemoryMappedFiles.MemoryMappedFile]::CreateNew(
  $exitCodeMapName,
  4
)
$exitCodeAccessor = $exitCodeMap.CreateViewAccessor()
$job = New-Object BetterCloudflare.ProcessJob
$process = $null
$outputPump = $null
$status = "starting"
$exitCode = 1
$peakSingleRssBytes = [long]0
$peakAggregateRssBytes = [long]0
$samples = 0
$startedAt = [DateTimeOffset]::UtcNow
$deadline = $startedAt.AddSeconds($TimeoutSeconds)
$memoryLimitBytes = $MemoryLimitMiB * 1MB

$bootstrap = @'
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function ConvertTo-NativeArgument {
  param([AllowEmptyString()][string]$Value)

  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
    return $Value
  }

  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') {
      $backslashes += 1
      continue
    }
    if ($character -eq '"') {
      [void]$builder.Append(('\' * (($backslashes * 2) + 1)))
      [void]$builder.Append('"')
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) {
      [void]$builder.Append(('\' * $backslashes))
      $backslashes = 0
    }
    [void]$builder.Append($character)
  }
  if ($backslashes -gt 0) {
    [void]$builder.Append(('\' * ($backslashes * 2)))
  }
  [void]$builder.Append('"')
  return $builder.ToString()
}

$outputPumpSource = @"
using System;
using System.Diagnostics;
using System.Threading;

namespace BetterCloudflareBootstrap
{
    public sealed class ProcessOutputPump : IDisposable
    {
        private readonly Process process;
        private readonly ManualResetEventSlim outputClosed;
        private readonly ManualResetEventSlim errorClosed;
        private readonly DataReceivedEventHandler outputHandler;
        private readonly DataReceivedEventHandler errorHandler;

        public ProcessOutputPump(Process process)
        {
            this.process = process;
            outputClosed = new ManualResetEventSlim(false);
            errorClosed = new ManualResetEventSlim(false);
            outputHandler = delegate(object sender, DataReceivedEventArgs args)
            {
                if (args.Data == null)
                {
                    outputClosed.Set();
                    return;
                }
                Console.Out.WriteLine(args.Data);
                Console.Out.Flush();
            };
            errorHandler = delegate(object sender, DataReceivedEventArgs args)
            {
                if (args.Data == null)
                {
                    errorClosed.Set();
                    return;
                }
                Console.Error.WriteLine(args.Data);
                Console.Error.Flush();
            };
            process.OutputDataReceived += outputHandler;
            process.ErrorDataReceived += errorHandler;
        }

        public void Start()
        {
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
        }

        public void WaitForDrain(int timeoutMilliseconds)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(
                timeoutMilliseconds
            );
            outputClosed.Wait(timeoutMilliseconds);
            int remainingMilliseconds = Math.Max(
                0,
                (int)(deadline - DateTime.UtcNow).TotalMilliseconds
            );
            errorClosed.Wait(remainingMilliseconds);
        }

        public void Dispose()
        {
            process.OutputDataReceived -= outputHandler;
            process.ErrorDataReceived -= errorHandler;
            outputClosed.Dispose();
            errorClosed.Dispose();
        }
    }
}
"@

$gate = [System.Threading.EventWaitHandle]::OpenExisting(
  $env:BETTER_CLOUDFLARE_WATCHDOG_GATE
)
$completionGate = [System.Threading.EventWaitHandle]::OpenExisting(
  $env:BETTER_CLOUDFLARE_WATCHDOG_COMPLETION_GATE
)
$exitCodeMap = [System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting(
  $env:BETTER_CLOUDFLARE_WATCHDOG_EXIT_CODE_MAP
)
$exitCodeAccessor = $exitCodeMap.CreateViewAccessor()
try {
  [void]$gate.WaitOne()
  Add-Type -TypeDefinition $outputPumpSource
  $decodedArguments = ConvertFrom-Json `
    -InputObject $env:BETTER_CLOUDFLARE_WATCHDOG_ARGUMENTS
  $arguments = @($decodedArguments | ForEach-Object { $_ })

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $env:BETTER_CLOUDFLARE_WATCHDOG_FILE
  $startInfo.Arguments = (
    @(
      $arguments | ForEach-Object {
        ConvertTo-NativeArgument -Value ([string]$_)
      }
    ) -join ' '
  )
  $startInfo.WorkingDirectory = $env:BETTER_CLOUDFLARE_WATCHDOG_CWD
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
  $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
  $commandProcess = New-Object System.Diagnostics.Process
  $commandProcess.StartInfo = $startInfo
  $outputPump = $null
  try {
    if (-not $commandProcess.Start()) {
      throw "Failed to start guarded command."
    }
    $outputPump = New-Object `
      -TypeName BetterCloudflareBootstrap.ProcessOutputPump `
      -ArgumentList @(,$commandProcess)
    $outputPump.Start()
    while (-not $commandProcess.HasExited) {
      # Wait on the process handle, not inherited stdout/stderr pipe closure.
      Start-Sleep -Milliseconds 100
      $commandProcess.Refresh()
    }
    $outputPump.WaitForDrain(1000)
    $exitCodeAccessor.Write(0, [int]$commandProcess.ExitCode)
    $exitCodeAccessor.Flush()
    [void]$completionGate.Set()
    while ($true) {
      # The outer watchdog terminates this bootstrap and every descendant.
      Start-Sleep -Seconds 1
    }
  }
  finally {
    if ($null -ne $outputPump) {
      $outputPump.Dispose()
    }
    $commandProcess.Dispose()
  }
}
finally {
  $exitCodeAccessor.Dispose()
  $exitCodeMap.Dispose()
  $completionGate.Dispose()
  $gate.Dispose()
}
'@
$encodedBootstrap = [Convert]::ToBase64String(
  [Text.Encoding]::Unicode.GetBytes($bootstrap)
)

try {
  $processStartInfo = New-Object System.Diagnostics.ProcessStartInfo
  $processStartInfo.FileName = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $processStartInfo.Arguments = (
    "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass " +
    "-OutputFormat Text -EncodedCommand $encodedBootstrap"
  )
  $processStartInfo.WorkingDirectory = $resolvedWorkingDirectory
  $processStartInfo.UseShellExecute = $false
  $processStartInfo.CreateNoWindow = $true
  $processStartInfo.RedirectStandardOutput = $true
  $processStartInfo.RedirectStandardError = $true
  $processStartInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
  $processStartInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
  $processStartInfo.EnvironmentVariables["BETTER_CLOUDFLARE_WATCHDOG_GATE"] = $gateName
  $processStartInfo.EnvironmentVariables["BETTER_CLOUDFLARE_WATCHDOG_COMPLETION_GATE"] = $completionGateName
  $processStartInfo.EnvironmentVariables["BETTER_CLOUDFLARE_WATCHDOG_EXIT_CODE_MAP"] = $exitCodeMapName
  $processStartInfo.EnvironmentVariables["BETTER_CLOUDFLARE_WATCHDOG_CWD"] = $resolvedWorkingDirectory
  $processStartInfo.EnvironmentVariables["BETTER_CLOUDFLARE_WATCHDOG_FILE"] = $resolvedFilePath
  $processStartInfo.EnvironmentVariables["BETTER_CLOUDFLARE_WATCHDOG_ARGUMENTS"] = (
    ConvertTo-Json -Compress -InputObject @($effectiveCommandArguments)
  )

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $processStartInfo
  if (-not $process.Start()) {
    throw "Failed to start watchdog bootstrap process."
  }
  $outputPump = New-Object `
    -TypeName BetterCloudflare.ProcessOutputPump `
    -ArgumentList @(,$process)
  $outputPump.Start()

  try {
    $job.Assign($process)
  }
  catch {
    try {
      $process.Kill()
    }
    catch {
      # The bootstrap may already have exited. Preserve the assignment error.
    }
    throw
  }

  $status = "running"
  [void]$gate.Set()

  $commandCompleted = $false
  while (-not $process.HasExited -and -not $commandCompleted) {
    $aggregateRssBytes = [long]0
    foreach ($processId in $job.GetProcessIds()) {
      try {
        $treeProcess = [System.Diagnostics.Process]::GetProcessById($processId)
        $workingSet = [long]$treeProcess.WorkingSet64
        $aggregateRssBytes += $workingSet
        if ($workingSet -gt $peakSingleRssBytes) {
          $peakSingleRssBytes = $workingSet
        }
        $treeProcess.Dispose()
      }
      catch [System.ArgumentException] {
        # The process exited between the job snapshot and RSS sampling.
      }
    }

    if ($aggregateRssBytes -gt $peakAggregateRssBytes) {
      $peakAggregateRssBytes = $aggregateRssBytes
    }
    $samples += 1

    if ($MemoryLimitMiB -gt 0 -and $aggregateRssBytes -gt $memoryLimitBytes) {
      $status = "memory-limit"
      $exitCode = 137
      $job.Terminate([uint32]$exitCode)
      break
    }

    if ([DateTimeOffset]::UtcNow -ge $deadline) {
      $status = "timeout"
      $exitCode = 124
      $job.Terminate([uint32]$exitCode)
      break
    }

    Start-Sleep -Milliseconds $PollIntervalMilliseconds
    $process.Refresh()
    $commandCompleted = $completionGate.WaitOne(0)
  }

  if ($commandCompleted) {
    $exitCode = $exitCodeAccessor.ReadInt32(0)
    $status = if ($exitCode -eq 0) { "passed" } else { "failed" }
    $job.Terminate([uint32]1)
  }

  $process.WaitForExit()
  if ($status -eq "running") {
    $exitCode = $process.ExitCode
    $status = if ($exitCode -eq 0) { "passed" } else { "failed" }
  }

  $remainingProcessIds = @($job.GetProcessIds())
  if ($remainingProcessIds.Count -gt 0) {
    $job.Terminate([uint32]1)
    $releaseDeadline = [DateTimeOffset]::UtcNow.AddSeconds(5)
    do {
      Start-Sleep -Milliseconds 25
      $remainingProcessIds = @($job.GetProcessIds())
    }
    while (
      $remainingProcessIds.Count -gt 0 -and
      [DateTimeOffset]::UtcNow -lt $releaseDeadline
    )
    if ($remainingProcessIds.Count -gt 0) {
      throw (
        "Watchdog failed to release descendant process IDs: " +
        ($remainingProcessIds -join ", ")
      )
    }
  }
  $outputPump.WaitForDrain(5000)
}
finally {
  if ($null -ne $outputPump) {
    $outputPump.Dispose()
  }
  if ($null -ne $process) {
    $process.Dispose()
  }
  $job.Dispose()
  $exitCodeAccessor.Dispose()
  $exitCodeMap.Dispose()
  $completionGate.Dispose()
  $gate.Dispose()
}

$finishedAt = [DateTimeOffset]::UtcNow
$result = [ordered]@{
  status = $status
  exitCode = $exitCode
  timeoutSeconds = $TimeoutSeconds
  memoryLimitMiB = $MemoryLimitMiB
  pollIntervalMilliseconds = $PollIntervalMilliseconds
  samples = $samples
  elapsedMilliseconds = [long]($finishedAt - $startedAt).TotalMilliseconds
  peakSingleRssBytes = $peakSingleRssBytes
  peakSingleRssMiB = [Math]::Round($peakSingleRssBytes / 1MB, 2)
  peakAggregateRssBytes = $peakAggregateRssBytes
  peakAggregateRssMiB = [Math]::Round($peakAggregateRssBytes / 1MB, 2)
}

Write-Output "PROCESS_TREE_WATCHDOG_RESULT $(ConvertTo-Json -Compress -InputObject $result)"
exit $exitCode
