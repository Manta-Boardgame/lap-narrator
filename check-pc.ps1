param([switch]$PerSlide)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$node = Get-Command node.exe -CommandType Application -TotalCount 1 -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 22 or newer is required. Install Node.js and reopen PowerShell.' }
& $node.Source -e 'process.exit(Number(process.versions.node.split(String.fromCharCode(46))[0]) >= 22 ? 0 : 1)'
if ($LASTEXITCODE -ne 0) { throw 'Node.js 22 or newer is required.' }
& $node.Source --version

$python = $env:NARRATE_PYTHON
if (-not $python) { $python = Join-Path $root '.venv\Scripts\python.exe' }
$python = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($python)
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw 'Python environment not found. See the PC setup guide in docs/pc-setup.md.'
}

$probe = @'
import os
import sys

import av
import numpy

for encoder in ('libx264', 'aac'):
    av.codec.Codec(encoder, 'w')

print('Python', sys.version.split()[0], '| PyAV', av.__version__, '| NumPy', numpy.__version__)
if sys.argv[2] == 'continuous':
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    from faster_whisper import WhisperModel, __version__
    WhisperModel('small', device='cpu', compute_type='int8', download_root=sys.argv[1], local_files_only=True)
    print('faster-whisper', __version__, '| Whisper small: loaded offline | language: Japanese')
'@
$mode = 'continuous'
if ($PerSlide) { $mode = 'per-slide' }
$probe | & $python -I -B - (Join-Path $root 'models') $mode
if ($LASTEXITCODE -ne 0) { throw 'A PC dependency check failed. See docs/pc-setup.md.' }

& $node.Source (Join-Path $root 'cli\narrate.js') --help | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'The narrate CLI could not start.' }
Write-Output 'PC checks passed. PowerPoint and Android are checked separately.'
