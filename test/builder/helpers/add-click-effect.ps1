# add-click-effect.ps1 - test helper (owner: D). Adds a click-triggered fade animation to the first shape of one
# slide of a COPY, so that build-a.ps1 has to report it as "unset". Same PowerPoint safety rules as the builders.
# Windows PowerShell 5.1, UTF-8 with BOM.
param(
    [Parameter(Mandatory = $true)][string]$Pptx,
    [int]$SlideIndex = 2
)
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
. (Join-Path $root 'builder\ppt-common.ps1')
$lock = Enter-PowerPointLock
$session = $null
$pres = $null
try {
    $session = Start-PowerPointSafely
    $pres = Open-MyPresentation -Session $session -Path (Resolve-Path -LiteralPath $Pptx).Path -ReadOnly $false
    $slide = $pres.Slides.Item($SlideIndex)
    $shape = $slide.Shapes.Item(1)
    $eff = $slide.TimeLine.MainSequence.AddEffect($shape, 10, 0, 1)   # msoAnimEffectFade, on page click
    $n = [int]$slide.TimeLine.MainSequence.Count
    $pres.Save()
    [Console]::Out.WriteLine((ConvertTo-AsciiJson -Object ([ordered]@{ ok = $true; slide = $SlideIndex; effects = $n; trigger = [int]$eff.Timing.TriggerType })))
}
finally {
    Close-MyPresentation -Presentation $pres
    Stop-PowerPointSafely -Session $session
    Exit-PowerPointLock -Mutex $lock
}
