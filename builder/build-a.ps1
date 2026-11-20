# build-a.ps1 - method A: build an MP4 from a pptx and timeline.json with PowerPoint (COM CreateVideo).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File builder\build-a.ps1 `
#       -Pptx <deck.pptx> -Timeline <timeline.json> -OutDir <dir> [-Mode both|linked|embedded] [-GridMs 0]
#
# What it does (design 8.3), on a COPY of the pptx made under <OutDir>\_work (the original is never opened):
#   * puts each slide's WAV on its slide (linked to the file, or embedded), starts it automatically with a
#     delay of (audioStart - showStart) seconds, hides the speaker icon ("hide during show");
#   * sets AdvanceOnTime / AdvanceTime = (showEnd - showStart) seconds, AdvanceOnClick off;
#   * hides every slide that is not in the timeline, un-hides the ones that are;
#   * CreateVideo: 1080p, timeline fps, "use timings and narrations", quality 100, polled with a time limit;
#   * decodes the MP4 with checker\video\verify.py and records whether the audio really is in it.
# -Mode both builds the linked and the embedded version (default); the linked version is the one used
# for <OutDir>\video.mp4 when its audio is in the MP4, otherwise the embedded one.
# -GridMs N (default 0 = off): optional timing compensation. PowerPoint renders on a 33 ms frame grid and
#   rounds every slide time and audio delay UP to the grid, so literal times drift (measured, see report).
#   With -GridMs 33 the script picks grid multiples from the cumulative sample positions instead.
#
# Output: <OutDir>\video-a-linked.mp4, video-a-embedded.mp4, video.mp4, build-report.json
#   build-report.json: CONTRACTS section 4 fields (method, elapsedMs, fps, width, height, notes[]) for the
#   chosen version, plus video, variants[] (the same fields for each version, audioInVideo, verify summary),
#   unsetClickAnimations[], totalElapsedMs.
# stdout: the same report as one ASCII JSON line.
# Exit: 0 ok, 1 failure, 10 PowerPoint has other documents open (nothing touched), 11 a wait timed out.
# Windows PowerShell 5.1, UTF-8 with BOM.
param(
    [Parameter(Mandatory = $true)][string]$Pptx,
    [Parameter(Mandatory = $true)][string]$Timeline,
    [Parameter(Mandatory = $true)][string]$OutDir,
    [ValidateSet('both', 'linked', 'embedded')][string]$Mode = 'both',
    [int]$GridMs = 0,
    [int]$TimeoutSec = 300,
    [int]$VertResolution = 1080,
    [string]$Python = '',
    [switch]$KeepWork
)

. (Join-Path $PSScriptRoot 'ppt-common.ps1')
$totalClock = [System.Diagnostics.Stopwatch]::StartNew()

if (-not (Test-Path -LiteralPath $Pptx)) { Stop-WithError -Code 'pptx-not-found' -Message ('No such file: ' + $Pptx) }
if (-not (Test-Path -LiteralPath $Timeline)) { Stop-WithError -Code 'timeline-not-found' -Message ('No such file: ' + $Timeline) }
$pptxFull = (Resolve-Path -LiteralPath $Pptx).Path
$timelineFull = (Resolve-Path -LiteralPath $Timeline).Path
$timelineDir = Split-Path -Parent $timelineFull
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$outFull = (Resolve-Path -LiteralPath $OutDir).Path
$workDir = Join-Path $outFull '_work'
New-Item -ItemType Directory -Force -Path $workDir | Out-Null
$py = Get-PythonPath -Override $Python
$verifyPy = Join-Path (Split-Path -Parent $PSScriptRoot) 'checker\video\verify.py'
if (-not (Test-Path -LiteralPath $py)) { Stop-WithError -Code 'python-not-found' -Message ('No Python at ' + $py) }

# ---- timeline --------------------------------------------------------------------------------
$tl = Get-Content -Raw -Encoding UTF8 -LiteralPath $timelineFull | ConvertFrom-Json
if ($tl.format -ne 'lap-narrator/timeline' -or $tl.version -ne 1) { Stop-WithError -Code 'bad-timeline' -Message 'not a lap-narrator/timeline version 1 file' }
$rate = [double]$tl.sampleRate
$fps = [int]$tl.fps
$tlSlides = @($tl.slides)
if ($tlSlides.Count -eq 0) { Stop-WithError -Code 'bad-timeline' -Message 'timeline has no slides' }
foreach ($ts in $tlSlides) {
    if ($ts.audio -isnot [string]) {
        Stop-WithError -Code 'multi-part-audio' -Message ('Slide ' + $ts.slideId + ' has split audio; method A cannot use it (use method B).')
    }
    $a = $ts.audio
    if (-not [System.IO.Path]::IsPathRooted($a)) { $a = Join-Path $timelineDir ($a -replace '/', '\') }
    if (-not (Test-Path -LiteralPath $a)) { Stop-WithError -Code 'audio-not-found' -Message ('No such audio file: ' + $a) }
    Add-Member -InputObject $ts -NotePropertyName audioFull -NotePropertyValue ((Resolve-Path -LiteralPath $a).Path) -Force
}

# ---- planned times (seconds) per slide ----------------------------------------------------------
# Literal: advance = (showEnd - showStart) / rate, delay = (audioStart - showStart) / rate.
# Grid mode: multiples of the grid chosen from cumulative positions (nearest, no accumulating error).
function Get-Plan {
    param($Slides, [double]$Rate, [int]$GridMs)
    $plan = @()
    $prevFrames = 0
    $grid = $GridMs / 1000.0
    foreach ($ts in $Slides) {
        if ($GridMs -le 0) {
            $adv = ([double]$ts.showEnd - [double]$ts.showStart) / $Rate
            $dly = ([double]$ts.audioStart - [double]$ts.showStart) / $Rate
        } else {
            $endFrames = [int][math]::Round(([double]$ts.showEnd / $Rate) / $grid, [MidpointRounding]::AwayFromZero)
            if ($endFrames -le $prevFrames) { $endFrames = $prevFrames + 1 }
            $dFrames = [int][math]::Round((([double]$ts.audioStart / $Rate) - $prevFrames * $grid) / $grid, [MidpointRounding]::AwayFromZero)
            if ($dFrames -lt 0) { $dFrames = 0 }
            # 1 ms below the grid multiple, so that PowerPoint's round-up lands on that multiple
            $adv = ($endFrames - $prevFrames) * $grid - 0.001
            $dly = $dFrames * $grid
            if ($dFrames -gt 0) { $dly = $dly - 0.001 }
            $prevFrames = $endFrames
        }
        $plan += [ordered]@{ advance = $adv; delay = $dly }
    }
    return $plan
}

# ---- apply the timeline to one open presentation -------------------------------------------------
# Returns @{ notes; unsetClickAnimations; hiddenSlides }. Everything COM stays inside this function.
function Set-TimelineOnPresentation {
    param($Pres, $TlSlides, $Plan, [string]$Variant)
    $notes = New-Object System.Collections.ArrayList
    $unset = New-Object System.Collections.ArrayList
    $count = [int]$Pres.Slides.Count
    $byId = @{}
    for ($i = 1; $i -le $count; $i++) { $byId[[int]$Pres.Slides.Item($i).SlideID] = $i }

    # timeline slide -> pptx slide index
    $map = @()
    $last = 0
    foreach ($ts in $TlSlides) {
        $idx = 0
        if ($ts.slideId -match '^s(\d+)$') {
            $n = [int]$Matches[1]
            if ($byId.ContainsKey($n)) { $idx = $byId[$n] }
            elseif ($ts.slideId -match '^s\d{4}$' -and $n -ge 1 -and $n -le $count) { $idx = $n }
        }
        if ($idx -eq 0) { Stop-WithError -Code 'slide-not-found' -Message ('Timeline slide ' + $ts.slideId + ' has no matching slide in the pptx.') }
        if ($idx -le $last) { Stop-WithError -Code 'slide-order-mismatch' -Message ('Timeline order differs from the pptx order at ' + $ts.slideId + '.') }
        $last = $idx
        $map += $idx
    }

    $inTimeline = @{}
    foreach ($idx in $map) { $inTimeline[$idx] = $true }
    for ($i = 1; $i -le $count; $i++) {
        $s = $Pres.Slides.Item($i)
        if ($inTimeline.ContainsKey($i)) {
            if ([int]$s.SlideShowTransition.Hidden -eq -1) { [void]$notes.Add(('slide ' + $i + ' was hidden in the deck but is in the timeline; un-hidden')) }
            $s.SlideShowTransition.Hidden = 0
        } else {
            $s.SlideShowTransition.Hidden = -1
        }
    }
    $hiddenCount = $count - $map.Count

    $slideW = [double]$Pres.PageSetup.SlideWidth
    for ($k = 0; $k -lt $map.Count; $k++) {
        $ts = $TlSlides[$k]
        $s = $Pres.Slides.Item($map[$k])
        $seq = $s.TimeLine.MainSequence

        # what is already there (never guessed at, only reported)
        $clicks = 0
        foreach ($eff in $seq) { if ([int]$eff.Timing.TriggerType -eq 1) { $clicks++ } }
        if ($clicks -gt 0) {
            [void]$unset.Add([ordered]@{ slideId = [string]$ts.slideId; clickEffects = $clicks })
            [void]$notes.Add(('unset: slide ' + $ts.slideId + ' has ' + $clicks + ' animation(s) that wait for a click; no timing was invented'))
        }
        $media = 0
        foreach ($shp in $s.Shapes) { if ($shp.Type -eq 16) { $media++ } }
        if ($media -gt 0) { [void]$notes.Add(('slide ' + $ts.slideId + ' already has ' + $media + ' audio/video shape(s); left as they are')) }
        if ([int]$s.SlideShowTransition.EntryEffect -ne 0) { [void]$notes.Add(('slide ' + $ts.slideId + ' has a slide transition; kept (it may change the timing)')) }

        # audio: linked or embedded
        $link = 0; $save = -1
        if ($Variant -eq 'linked') { $link = -1; $save = 0 }
        $shp = $s.Shapes.AddMediaObject2($ts.audioFull, $link, $save, 10, 10, 50, 50)
        $eff = $seq.AddEffect($shp, 83, 0, 3, 1)      # msoAnimEffectMediaPlay, after previous, first in the sequence
        # hide the icon. This rebuilds the effect, so fetch it again before setting the delay.
        $shp.AnimationSettings.PlaySettings.HideWhileNotPlaying = -1
        if ([int]$shp.AnimationSettings.PlaySettings.HideWhileNotPlaying -ne -1) {
            $shp.Left = $slideW + 20
            [void]$notes.Add(('slide ' + $ts.slideId + ': hide-during-show did not stick; the icon was moved off the slide'))
        }
        $eff = $s.TimeLine.MainSequence.Item(1)
        $eff.Timing.TriggerDelayTime = [single]$Plan[$k].delay
        if ([math]::Abs([double]$eff.Timing.TriggerDelayTime - [double]$Plan[$k].delay) -gt 0.002) {
            Stop-WithError -Code 'delay-not-set' -Message ('Could not set the audio delay on slide ' + $ts.slideId)
        }

        # switching time
        $s.SlideShowTransition.AdvanceOnClick = 0
        $s.SlideShowTransition.AdvanceOnTime = -1
        $s.SlideShowTransition.AdvanceTime = [single]$Plan[$k].advance
    }
    return @{ notes = $notes; unset = $unset; hidden = $hiddenCount }
}

function Wait-FileStable {
    param([string]$Path, [int]$MaxSec = 30)
    $deadline = (Get-Date).AddSeconds($MaxSec)
    $prev = -1
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $Path) {
            $len = (Get-Item -LiteralPath $Path).Length
            if ($len -gt 0 -and $len -eq $prev) {
                try {
                    $fs = [System.IO.File]::Open($Path, 'Open', 'Read', 'None'); $fs.Dispose()
                    return $true
                } catch { }
            }
            $prev = $len
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

# ---- one variant -----------------------------------------------------------------------------
function Build-Variant {
    param($Session, [string]$Variant)
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $video = Join-Path $outFull ('video-a-' + $Variant + '.mp4')
    if (Test-Path -LiteralPath $video) { Remove-Item -LiteralPath $video -Force }
    $copy = Join-Path $workDir ('deck-' + $Variant + '.pptx')
    Copy-Item -LiteralPath $pptxFull -Destination $copy -Force
    $plan = Get-Plan -Slides $tlSlides -Rate $rate -GridMs $GridMs
    $pres = $null
    $res = $null
    $createMs = 0
    $failure = $null
    try {
        $pres = Open-MyPresentation -Session $Session -Path $copy -ReadOnly $false
        $res = Set-TimelineOnPresentation -Pres $pres -TlSlides $tlSlides -Plan $plan -Variant $Variant
        $pres.Save()
        $cv = [System.Diagnostics.Stopwatch]::StartNew()
        $pres.CreateVideo($video, -1, 5, $VertResolution, $fps, 100)
        $deadline = (Get-Date).AddSeconds($TimeoutSec)
        $status = 2
        while ($true) {
            $status = [int]$pres.CreateVideoStatus
            if ($status -eq 3 -or $status -eq 4 -or $status -eq 0) { break }
            if ((Get-Date) -gt $deadline) { $status = -1; break }
            Start-Sleep -Milliseconds 250
        }
        $createMs = [int]$cv.ElapsedMilliseconds
        if ($status -eq -1) { $failure = [ordered]@{ code = 'createvideo-timeout'; message = ('CreateVideo did not finish within ' + $TimeoutSec + ' s (' + $Variant + ')') } }
        elseif ($status -eq 4) { $failure = [ordered]@{ code = 'createvideo-failed'; message = ('PowerPoint reported CreateVideo failed (' + $Variant + ')') } }
        elseif ($status -eq 0) { $failure = [ordered]@{ code = 'createvideo-not-started'; message = ('CreateVideoStatus stayed at none (' + $Variant + ')') } }
    } finally {
        if ($failure -and $failure.code -eq 'createvideo-timeout') {
            # leave the export: closing the presentation below cancels it
        }
        Close-MyPresentation -Presentation $pres
        $pres = $null
    }
    if ($failure) { return @{ variant = $Variant; failure = $failure; elapsedMs = [int]$clock.ElapsedMilliseconds; createVideoMs = $createMs; res = $res } }
    if (-not (Wait-FileStable -Path $video -MaxSec 30)) {
        return @{ variant = $Variant; failure = [ordered]@{ code = 'video-not-written'; message = ('No stable MP4 appeared for ' + $Variant) }; elapsedMs = [int]$clock.ElapsedMilliseconds; createVideoMs = $createMs; res = $res }
    }
    return @{ variant = $Variant; video = $video; failure = $null; elapsedMs = [int]$clock.ElapsedMilliseconds; createVideoMs = $createMs; res = $res }
}

function Measure-Variant {
    param([string]$Video)
    $verifyOut = [System.IO.Path]::ChangeExtension($Video, 'verify.json')
    $text = & $py -I $verifyPy --video $Video --timeline $timelineFull --method A --out $verifyOut | Out-String
    try { return ($text | ConvertFrom-Json) } catch { return $null }
}

# ---- main --------------------------------------------------------------------------------------
$variants = @()
if ($Mode -eq 'both' -or $Mode -eq 'linked') { $variants += 'linked' }
if ($Mode -eq 'both' -or $Mode -eq 'embedded') { $variants += 'embedded' }

$lock = Enter-PowerPointLock
$session = $null
$built = @()
try {
    $session = Start-PowerPointSafely
    foreach ($v in $variants) { $built += , (Build-Variant -Session $session -Variant $v) }
}
finally {
    Stop-PowerPointSafely -Session $session
    Exit-PowerPointLock -Mutex $lock
}

$reports = @()
foreach ($b in $built) {
    $r = [ordered]@{
        method = ('A-' + $b.variant)
        elapsedMs = $b.elapsedMs
        createVideoMs = $b.createVideoMs
        fps = $null
        width = $null
        height = $null
        notes = @()
        video = $null
        audioInVideo = $false
        gridMs = $GridMs
    }
    $notes = New-Object System.Collections.ArrayList
    if ($b.res) { foreach ($n in $b.res.notes) { [void]$notes.Add($n) } }
    if ($b.failure) {
        $r['error'] = $b.failure
        [void]$notes.Add($b.failure.message)
    } else {
        $r['video'] = [System.IO.Path]::GetFileName($b.video)
        $m = Measure-Variant -Video $b.video
        if ($null -eq $m -or $null -ne $m.PSObject.Properties['error']) {
            [void]$notes.Add('verify could not read the MP4')
        } else {
            $r['fps'] = [math]::Round([double]$m.video.fps, 3)
            $r['width'] = [int]$m.video.width
            $r['height'] = [int]$m.video.height
            # "audio in the video" = there is an audio stream, no slide's sound is missing where the timeline puts
            # it, and at least one slide's position could be measured (cue tone or cross-correlation with the WAV)
            $measuredAudio = @($m.slides | Where-Object { $null -ne $_.measured.audioStartMs }).Count
            $missingAudio = @($m.slides | Where-Object { $_.detail.audio -eq 'missing' }).Count
            $unmeasAudio = @($m.slides | Where-Object { $_.detail.audio -eq 'unmeasurable' })
            $r['audioInVideo'] = ($m.audio.present -eq $true -and $missingAudio -eq 0 -and $measuredAudio -ge 1)
            $maxShow = 0.0; $maxAudio = 0.0
            foreach ($sl in $m.slides) {
                if ($null -ne $sl.diffMs.show) { $maxShow = [math]::Max($maxShow, [math]::Abs([double]$sl.diffMs.show)) }
                if ($null -ne $sl.diffMs.audio) { $maxAudio = [math]::Max($maxAudio, [math]::Abs([double]$sl.diffMs.audio)) }
            }
            $r['verify'] = [ordered]@{
                pass = [bool]$m.pass
                counts = $m.counts
                maxAbsDiffMs = [ordered]@{ show = [math]::Round($maxShow, 3); audio = [math]::Round($maxAudio, 3) }
                totalMs = $m.totalMs
                expectedTotalMs = $m.expectedTotalMs
                totalDiffMs = $m.totalDiffMs
                audioSampleRate = $m.audio.sampleRate
                audioChannels = $m.audio.channels
                audioPtsDriftMs = $m.audio.ptsDriftMs
            }
            if ($m.audio.present -ne $true) {
                [void]$notes.Add('the MP4 has no audio stream')
            } elseif ($missingAudio -gt 0) {
                [void]$notes.Add(('audio of ' + $missingAudio + ' slide(s) is missing from the MP4 (nothing found where the timeline puts it)'))
            }
            if ($m.audio.present -eq $true -and $unmeasAudio.Count -gt 0) {
                $why = @($unmeasAudio | ForEach-Object { $_.reasons } | Where-Object { $_ -and $_ -notlike 'same-picture*' } | Select-Object -Unique) -join ', '
                [void]$notes.Add(('audio is in the MP4, but the position of ' + $unmeasAudio.Count + ' slide(s) could not be measured (' + $why + ')'))
            }
            if ($m.audio.present -eq $true -and $null -ne $m.audio.ptsDriftMs -and [math]::Abs([double]$m.audio.ptsDriftMs) -ge 20) {
                [void]$notes.Add(('the MP4 audio time stamps run ' + [math]::Round([double]$m.audio.ptsDriftMs, 1) + ' ms ahead of its sample count over ' + [math]::Round([double]$m.audio.durationMs / 1000.0, 1) + ' s (positions are reported in the container time)'))
            }
            if ($m.video.fps -and [math]::Abs([double]$m.video.fps - $fps) -gt 0.05) {
                [void]$notes.Add(('video frame rate is ' + [math]::Round([double]$m.video.fps, 3) + ' fps, not ' + $fps + ' (PowerPoint frame grid about ' + [math]::Round(1000.0 / [double]$m.video.fps, 1) + ' ms)'))
            }
        }
    }
    if ($b.res -and $b.res.unset.Count -gt 0) { $r['unsetClickAnimations'] = @($b.res.unset) }
    $r['notes'] = @($notes)
    $reports += , $r
}

# choose: linked when its audio is in the MP4, otherwise embedded
$chosen = $null
foreach ($r in $reports) { if ($r.method -eq 'A-linked' -and $r.audioInVideo) { $chosen = $r } }
if ($null -eq $chosen) { foreach ($r in $reports) { if ($r.method -eq 'A-embedded' -and $r.audioInVideo) { $chosen = $r } } }
if ($null -eq $chosen -and $reports.Count -gt 0) { $chosen = $reports[0] }

$final = [ordered]@{
    ok = ($null -ne $chosen -and $null -ne $chosen['video'])
    method = $null
    elapsedMs = $null
    fps = $null
    width = $null
    height = $null
    notes = @()
    video = $null
    variants = @($reports)
    totalElapsedMs = [int]$totalClock.ElapsedMilliseconds
}
if ($null -ne $chosen) {
    $final['method'] = $chosen['method']
    $final['elapsedMs'] = $chosen['elapsedMs']
    $final['fps'] = $chosen['fps']
    $final['width'] = $chosen['width']
    $final['height'] = $chosen['height']
    $final['notes'] = $chosen['notes']
    $final['video'] = $chosen['video']
    if ($chosen['video']) { Copy-Item -LiteralPath (Join-Path $outFull $chosen['video']) -Destination (Join-Path $outFull 'video.mp4') -Force }
    if ($chosen.Contains('unsetClickAnimations')) { $final['unsetClickAnimations'] = $chosen['unsetClickAnimations'] }
}
Write-JsonFile -Path (Join-Path $outFull 'build-report.json') -Object $final
if (-not $KeepWork) { Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue }
[Console]::Out.WriteLine((ConvertTo-AsciiJson -Object $final))
if ($final['ok']) { exit 0 } else { exit 1 }
