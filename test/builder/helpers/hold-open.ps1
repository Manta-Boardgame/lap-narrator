# hold-open.ps1 - test helper (owner: D). Plays the part of "the user has a document open in PowerPoint".
# Starts PowerPoint (only if none is running), opens a COPY from work\D (read-only, no window), prints READY,
# then waits for the signal file. Before closing it reports what state its presentation is in, so the test
# can prove that the builder scripts did not touch it. Closes only its own presentation; quits PowerPoint
# only because it started it.
# Windows PowerShell 5.1, UTF-8 with BOM.
param(
    [Parameter(Mandatory = $true)][string]$Pptx,
    [Parameter(Mandatory = $true)][string]$SignalFile,
    [int]$MaxSec = 120
)
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
. (Join-Path $root 'builder\ppt-common.ps1')

$session = Start-PowerPointSafely
$pres = Open-MyPresentation -Session $session -Path (Resolve-Path -LiteralPath $Pptx).Path -ReadOnly $true
$name = [string]$pres.Name
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
$deadline = (Get-Date).AddSeconds($MaxSec)
while (-not (Test-Path -LiteralPath $SignalFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
$state = [ordered]@{
    presentationsAtEnd = [int]$session.App.Presentations.Count
    nameUnchanged = ([string]$session.App.Presentations.Item(1).Name -eq $name)
    slidesAtEnd = [int]$session.App.Presentations.Item(1).Slides.Count
}
Close-MyPresentation -Presentation $pres
Stop-PowerPointSafely -Session $session
[Console]::Out.WriteLine((ConvertTo-AsciiJson -Object $state))
