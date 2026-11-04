$ErrorActionPreference = "Stop"

$workspace = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $workspace) { $workspace = "." }

$gasDir = Join-Path $workspace "google_apps_script"
$distDir = Join-Path $workspace "dist_single"
$simDir = Join-Path $workspace "simulator"

if (!(Test-Path $gasDir)) {
    New-Item -ItemType Directory -Path $gasDir -Force | Out-Null
}
if (!(Test-Path $distDir)) {
    New-Item -ItemType Directory -Path $distDir -Force | Out-Null
}

$css = Get-Content (Join-Path $simDir "css\style.css") -Raw -Encoding UTF8
$struct = Get-Content (Join-Path $simDir "data\structure.js") -Raw -Encoding UTF8
$gen = Get-Content (Join-Path $simDir "data\question-generator.js") -Raw -Encoding UTF8
$qArch = Get-Content (Join-Path $simDir "data\questions-arch.js") -Raw -Encoding UTF8
$qStruct = Get-Content (Join-Path $simDir "data\questions-struct.js") -Raw -Encoding UTF8
$calc = Get-Content (Join-Path $simDir "js\calculator.js") -Raw -Encoding UTF8
$engine = Get-Content (Join-Path $simDir "js\exam-engine.js") -Raw -Encoding UTF8
$ui = Get-Content (Join-Path $simDir "js\ui.js") -Raw -Encoding UTF8
$app = Get-Content (Join-Path $simDir "js\app.js") -Raw -Encoding UTF8

$parts = @(
    '<!DOCTYPE html>',
    '<html lang="ka">',
    '<head>',
    '  <meta charset="UTF-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '  <title>Exam Simulator CBT</title>',
    '  <script src="https://accounts.google.com/gsi/client" async defer></script>',
    '  <style>',
    $css,
    '  </style>',
    '</head>',
    '<body>',
    '  <div id="app"></div>',
    '  <div id="calcModalContainer" class="calc-container"></div>',
    '  <script>',
    $struct,
    '  </script>',
    '  <script>',
    $gen,
    '  </script>',
    '  <script>',
    $qArch,
    '  </script>',
    '  <script>',
    $qStruct,
    '  </script>',
    '  <script>',
    $engine,
    '  </script>',
    '  <script>',
    $calc,
    '  </script>',
    '  <script>',
    $ui,
    '  </script>',
    '  <script>',
    $app,
    '  </script>',
    '</body>',
    '</html>'
)

$outContent = $parts -join "`r`n"

$gasPath = Join-Path $gasDir "Index.html"
$distPath = Join-Path $distDir "index.html"

[System.IO.File]::WriteAllText($gasPath, $outContent, [System.Text.Encoding]::UTF8)
[System.IO.File]::WriteAllText($distPath, $outContent, [System.Text.Encoding]::UTF8)

$fiGas = Get-Item $gasPath
$fiDist = Get-Item $distPath

Write-Output "GAS_BUILD_OK: $($fiGas.Length) bytes at $($fiGas.FullName)"
Write-Output "DIST_BUILD_OK: $($fiDist.Length) bytes at $($fiDist.FullName)"
