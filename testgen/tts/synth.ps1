# 音声合成をファイルにだけ書き出す（スピーカーからは鳴らさない）。
# 使い方：powershell -NoProfile -ExecutionPolicy Bypass -File synth.ps1 -JobFile <jobs.json>
# jobs.json（UTF-8）：[{ "voice": "...", "text": "...", "out": "path.wav", "rate": 0 }]
# 出力は 48000Hz／16 ビット／モノラルの WAV。SetOutputToDefaultAudioDevice は使わない。
param([Parameter(Mandatory = $true)][string]$JobFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$json = [System.IO.File]::ReadAllText($JobFile, [System.Text.Encoding]::UTF8)
$jobs = ConvertFrom-Json -InputObject $json
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($job in $jobs) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try {
    $s.SelectVoice([string]$job.voice)
    if ($null -ne $job.rate) { $s.Rate = [int]$job.rate }
    $s.SetOutputToWaveFile([string]$job.out, $fmt)   # 先にファイル出力にしてから話す
    $s.Speak([string]$job.text)
    $s.SetOutputToNull()
    Write-Output ("OK`t" + $job.out)
  } catch {
    Write-Output ("NG`t" + $job.out + "`t" + $_.Exception.Message)
  } finally {
    $s.Dispose()
  }
}
