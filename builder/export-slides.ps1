# export-slides.ps1 - take pictures and notes out of a pptx (PowerPoint COM).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File builder\export-slides.ps1 -Pptx <copy.pptx> -OutDir <dir>
#
# Output:
#   <OutDir>\slides\0001.png ...   1920x1080 (other aspect ratios: fitted inside 1920x1080)
#   <OutDir>\slides.json           { format, version, pptx, width, height, slides:[ {index, slideId, image,
#                                    title, notes, hidden, mediaShapes, clickEffects} ], warnings:[] }
#       slideId       integer SlideID of PowerPoint (pack makes it "s<SlideID>")
#       notes         notes text, line breaks normalised to LF
#       hidden        true if the slide is hidden in the deck
#       mediaShapes   number of audio/video shapes already on the slide
#       clickEffects  number of animation effects that wait for a click
# stdout: one ASCII JSON line { ok, outDir, slides, powerPointVersion, elapsedMs }
# Exit: 0 ok, 1 failure, 10 PowerPoint has other documents open (nothing touched), 11 timeout.
#
# Pass a COPY of the pptx (it is opened read-only anyway). Windows PowerShell 5.1, UTF-8 with BOM.
param(
    [Parameter(Mandatory = $true)][string]$Pptx,
    [Parameter(Mandatory = $true)][string]$OutDir,
    [int]$TimeoutSec = 300
)

. (Join-Path $PSScriptRoot 'ppt-common.ps1')
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$deadline = (Get-Date).AddSeconds($TimeoutSec)

if (-not (Test-Path -LiteralPath $Pptx)) { Stop-WithError -Code 'pptx-not-found' -Message ('No such file: ' + $Pptx) }
$pptxFull = (Resolve-Path -LiteralPath $Pptx).Path
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir 'slides') | Out-Null
$outFull = (Resolve-Path -LiteralPath $OutDir).Path
$slidesDir = Join-Path $outFull 'slides'
Get-ChildItem -LiteralPath $slidesDir -Filter '*.png' -ErrorAction SilentlyContinue | Remove-Item -Force

function Export-AllSlides {
    param($pres, [string]$slidesDir, [datetime]$deadline, [int]$TimeoutSec)
    $sw = [double]$pres.PageSetup.SlideWidth
    $sh = [double]$pres.PageSetup.SlideHeight
    $ratio = $sw / $sh
    $width = 1920
    $height = 1080
    $warnings = @()
    if ([math]::Abs($ratio - (16.0 / 9.0)) -gt 0.01) {
        if ($ratio -gt (16.0 / 9.0)) { $width = 1920; $height = [int]([math]::Round(1920.0 / $ratio / 2.0) * 2) }
        else { $height = 1080; $width = [int]([math]::Round(1080.0 * $ratio / 2.0) * 2) }
        $warnings += [ordered]@{ code = 'not-16x9'; message = ('Slide size is not 16:9; pictures are ' + $width + 'x' + $height) }
    }

    $list = New-Object System.Collections.ArrayList
    $i = 0
    foreach ($s in $pres.Slides) {
        $i++
        if ((Get-Date) -gt $deadline) {
            Stop-WithError -Code 'timeout' -Message ('Exporting slides exceeded ' + $TimeoutSec + ' s at slide ' + $i) -ExitCode $script:EXIT_TIMEOUT
        }
        $name = ('{0:D4}.png' -f $i)
        $png = Join-Path $slidesDir $name
        $s.Export($png, 'PNG', $width, $height)
        if (-not (Test-Path -LiteralPath $png)) {
            Stop-WithError -Code 'export-failed' -Message ('PowerPoint did not write ' + $name)
        }
        $dim = Get-PngSize -Path $png
        if ($dim[0] -ne $width -or $dim[1] -ne $height) {
            $warnings += [ordered]@{ code = 'png-size'; message = ($name + ' is ' + $dim[0] + 'x' + $dim[1] + ', expected ' + $width + 'x' + $height) }
        }

        $notes = ''
        try {
            foreach ($shp in $s.NotesPage.Shapes) {
                if ($shp.Type -eq 14) {
                    if ($shp.PlaceholderFormat.Type -eq 2 -and $shp.HasTextFrame) { $notes = [string]$shp.TextFrame.TextRange.Text }
                }
            }
        } catch { $notes = '' }
        $notes = $notes -replace "`r`n", "`n"
        $notes = $notes -replace "`r", "`n"
        $notes = $notes -replace [string][char]0x0B, "`n"

        $title = ''
        try { if ($s.Shapes.HasTitle -eq -1) { $title = [string]$s.Shapes.Title.TextFrame.TextRange.Text } } catch { $title = '' }
        $title = ($title -replace "[\r\n\u000B]+", ' ')

        $media = 0
        foreach ($shp in $s.Shapes) { if ($shp.Type -eq 16) { $media++ } }
        $clicks = 0
        try {
            foreach ($eff in $s.TimeLine.MainSequence) { if ([int]$eff.Timing.TriggerType -eq 1) { $clicks++ } }
        } catch { }

        [void]$list.Add([ordered]@{
            index = $i
            slideId = [int]$s.SlideID
            image = ('slides/' + $name)
            title = $title
            notes = $notes
            hidden = ([int]$s.SlideShowTransition.Hidden -eq -1)
            mediaShapes = $media
            clickEffects = $clicks
        })
    }
    return @{ list = $list; width = $width; height = $height; warnings = $warnings }
}

$lock = Enter-PowerPointLock
$session = $null
$pres = $null
try {
    $session = Start-PowerPointSafely
    $pres = Open-MyPresentation -Session $session -Path $pptxFull -ReadOnly $true

    $exp = Export-AllSlides -pres $pres -slidesDir $slidesDir -deadline $deadline -TimeoutSec $TimeoutSec
    $list = $exp.list; $width = $exp.width; $height = $exp.height; $warnings = $exp.warnings

    $doc = [ordered]@{
        format = 'lap-narrator/slides-export'
        version = 1
        pptx = [System.IO.Path]::GetFileName($pptxFull)
        width = $width
        height = $height
        slides = @($list)
        warnings = @($warnings)
    }
    Write-JsonFile -Path (Join-Path $outFull 'slides.json') -Object $doc

    $result = [ordered]@{
        ok = $true
        outDir = $outFull
        slides = $list.Count
        powerPointVersion = $session.Version
        startedPowerPoint = $session.StartedByMe
        elapsedMs = [int]$clock.ElapsedMilliseconds
    }
    [Console]::Out.WriteLine((ConvertTo-AsciiJson -Object $result))
}
finally {
    Close-MyPresentation -Presentation $pres
    Stop-PowerPointSafely -Session $session
    Exit-PowerPointLock -Mutex $lock
}
