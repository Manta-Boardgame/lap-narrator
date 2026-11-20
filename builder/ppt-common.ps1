# Shared helpers for the PowerPoint (COM) scripts of lap-narrator (owner: D).
# Dot-source this file:  . (Join-Path $PSScriptRoot 'ppt-common.ps1')
# Windows PowerShell 5.1. Saved as UTF-8 with BOM.
#
# Rules this file enforces (dev/RULES.md 2.7):
#   * only one PowerPoint job at a time (named mutex);
#   * if a PowerPoint is already running and has ANY presentation (or protected-view window) open,
#     we touch nothing and stop with exit code 10 (the user's documents are never disturbed);
#   * we close only the presentation we opened; we quit PowerPoint only if we started it and
#     nothing else is open in it.

$ErrorActionPreference = 'Stop'

$script:EXIT_BUSY = 10      # user has PowerPoint documents open (or unknown state)
$script:EXIT_TIMEOUT = 11   # a wait exceeded its limit
$script:EXIT_FAIL = 1

function ConvertTo-AsciiJson {
    param([Parameter(Mandatory = $true)]$Object, [switch]$Pretty)
    $text = ConvertTo-Json -InputObject $Object -Depth 12
    if (-not $Pretty) { $text = ConvertTo-Json -InputObject $Object -Depth 12 -Compress }
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $text.ToCharArray()) {
        if ([int]$ch -gt 126) { [void]$sb.AppendFormat('\u{0:x4}', [int]$ch) } else { [void]$sb.Append($ch) }
    }
    return $sb.ToString()
}

function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, ($Text -replace "`r`n", "`n"), $enc)
}

function Write-JsonFile {
    param([string]$Path, $Object)
    $text = ConvertTo-Json -InputObject $Object -Depth 12
    Write-Utf8NoBom -Path $Path -Text ($text + "`n")
}

function Stop-WithError {
    param([string]$Code, [string]$Message, [int]$ExitCode = 1, $Extra = $null)
    $err = [ordered]@{ code = $Code; message = $Message }
    if ($null -ne $Extra) { $err['detail'] = $Extra }
    $obj = [ordered]@{ ok = $false; errors = @($err) }
    [Console]::Out.WriteLine((ConvertTo-AsciiJson -Object $obj))
    exit $ExitCode
}

function Get-PythonPath {
    param([string]$Override)
    if ($Override) { return $Override }
    $repo = Split-Path -Parent $PSScriptRoot
    return (Join-Path $repo '.venv\Scripts\python.exe')
}

# ---- one PowerPoint job at a time ------------------------------------------------------------

function Enter-PowerPointLock {
    param([int]$WaitSec = 120)
    $m = New-Object System.Threading.Mutex($false, 'Local\lap-narrator-D-powerpoint')
    $got = $false
    try { $got = $m.WaitOne([TimeSpan]::FromSeconds($WaitSec)) } catch [System.Threading.AbandonedMutexException] { $got = $true }
    if (-not $got) {
        Stop-WithError -Code 'powerpoint-lock-timeout' -Message 'Another lap-narrator PowerPoint job is still running.' -ExitCode $script:EXIT_BUSY
    }
    return $m
}

function Exit-PowerPointLock {
    param($Mutex)
    if ($null -ne $Mutex) { try { $Mutex.ReleaseMutex() } catch { } ; try { $Mutex.Dispose() } catch { } }
}

# ---- starting PowerPoint safely ---------------------------------------------------------------

# Returns @{ App; StartedByMe; Pid; Version; PreexistingRunning }
function Start-PowerPointSafely {
    $running = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
        $app = $null
        try { $app = [System.Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') } catch { $app = $null }
        if ($null -eq $app) {
            Stop-WithError -Code 'powerpoint-unknown-state' -ExitCode $script:EXIT_BUSY `
                -Message 'POWERPNT.EXE is running but cannot be attached to; not touching it.'
        }
        $count = -1
        $pv = -1
        try { $count = [int]$app.Presentations.Count } catch { $count = -1 }
        try { $pv = [int]$app.ProtectedViewWindows.Count } catch { $pv = 0 }
        if ($count -ne 0 -or $pv -ne 0) {
            Stop-WithError -Code 'powerpoint-busy' -ExitCode $script:EXIT_BUSY `
                -Message 'PowerPoint is already running with documents open. No file was touched.' `
                -Extra ([ordered]@{ presentations = $count; protectedViewWindows = $pv })
        }
        return @{ App = $app; StartedByMe = $false; Pid = $null; Version = [string]$app.Version; PreexistingRunning = $true }
    }
    try {
        $app = New-Object -ComObject PowerPoint.Application
    } catch {
        Stop-WithError -Code 'powerpoint-not-available' -Message ('Cannot start PowerPoint: ' + $_.Exception.Message) -ExitCode $script:EXIT_FAIL
    }
    $mine = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | Select-Object -First 1)
    $procId = $null
    if ($mine.Count -gt 0) { $procId = $mine[0].Id }
    return @{ App = $app; StartedByMe = $true; Pid = $procId; Version = [string]$app.Version; PreexistingRunning = $false }
}

function Close-MyPresentation {
    param($Presentation)
    if ($null -eq $Presentation) { return }
    try { $Presentation.Saved = -1 } catch { }
    try { $Presentation.Close() } catch { }
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($Presentation) } catch { }
}

# Quits PowerPoint only if we started it and nothing else is open. Never kills a PowerPoint we did not start.
function Stop-PowerPointSafely {
    param($Session)
    if ($null -eq $Session) { return }
    $app = $Session.App
    $left = 0
    try { $left = [int]$app.Presentations.Count } catch { $left = 0 }
    # drop every COM wrapper we still hold, otherwise PowerPoint lingers after Quit()
    [GC]::Collect(); [GC]::WaitForPendingFinalizers(); [GC]::Collect()
    if ($Session.StartedByMe -and $left -eq 0) {
        try { $app.Quit() } catch { }
        try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch { }
        [GC]::Collect(); [GC]::WaitForPendingFinalizers()
        if ($Session.Pid) {
            $deadline = (Get-Date).AddSeconds(15)
            while ((Get-Date) -lt $deadline -and (Get-Process -Id $Session.Pid -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 300 }
            $p = Get-Process -Id $Session.Pid -ErrorAction SilentlyContinue
            if ($p -and $p.ProcessName -eq 'POWERPNT') { try { Stop-Process -Id $Session.Pid -Force } catch { } }
        }
    } else {
        try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch { }
        [GC]::Collect(); [GC]::WaitForPendingFinalizers()
    }
}

# Opens a pptx without a window. Returns the Presentation.
function Open-MyPresentation {
    param($Session, [string]$Path, [bool]$ReadOnly)
    $ro = 0
    if ($ReadOnly) { $ro = -1 }
    try {
        return $Session.App.Presentations.Open($Path, $ro, 0, 0)
    } catch {
        Stop-WithError -Code 'open-failed' -Message ('PowerPoint could not open the file: ' + $_.Exception.Message) -ExitCode $script:EXIT_FAIL
    }
}

function Get-PngSize {
    param([string]$Path)
    $fs = [System.IO.File]::OpenRead($Path)
    try {
        $buf = New-Object byte[] 24
        [void]$fs.Read($buf, 0, 24)
    } finally { $fs.Dispose() }
    $w = ([int]$buf[16] -shl 24) + ([int]$buf[17] -shl 16) + ([int]$buf[18] -shl 8) + [int]$buf[19]
    $h = ([int]$buf[20] -shl 24) + ([int]$buf[21] -shl 16) + ([int]$buf[22] -shl 8) + [int]$buf[23]
    return @($w, $h)
}
