# ლოკალური მინი HTTP სერვერი PowerShell-ზე (ნულოვანი დამოკიდებულება)
param([int]$Port = 8080)

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

try {
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://localhost:$Port/")
    $listener.Start()
    Write-Host "=================================================================" -ForegroundColor Cyan
    Write-Host "  სერტიფიცირების საგამოცდო სისტემა გაშვებულია: http://localhost:$Port/" -ForegroundColor Green
    Write-Host "  ბრაუზერი ავტომატურად გაიხსნა. სერვერის გასაჩერებლად დააჭირეთ Ctrl+C" -ForegroundColor Yellow
    Write-Host "=================================================================" -ForegroundColor Cyan
    
    Start-Process "http://localhost:$Port/index.html"

    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        $localPath = $request.Url.LocalPath.TrimStart('/')
        if ([string]::IsNullOrEmpty($localPath)) { $localPath = "index.html" }
        $filePath = Join-Path $Root $localPath

        if (Test-Path $filePath -PathType Leaf) {
            $bytes = [System.IO.File]::ReadAllBytes($filePath)
            $ext = [System.IO.Path]::GetExtension($filePath).ToLower()

            $mime = switch ($ext) {
                ".html" { "text/html; charset=utf-8" }
                ".htm"  { "text/html; charset=utf-8" }
                ".css"  { "text/css; charset=utf-8" }
                ".js"   { "application/javascript; charset=utf-8" }
                ".json" { "application/json; charset=utf-8" }
                ".png"  { "image/png" }
                ".jpg"  { "image/jpeg" }
                ".svg"  { "image/svg+xml" }
                default { "application/octet-stream" }
            }

            $response.ContentType = $mime
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $response.StatusCode = 404
            $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
            $response.OutputStream.Write($msg, 0, $msg.Length)
        }
        $response.Close()
    }
} catch {
    Write-Host "სერვერის გაშვების შეცდომა: $_" -ForegroundColor Red
    Write-Host "ვხსნით ფაილს პირდაპირ ბრაუზერში..." -ForegroundColor Yellow
    Start-Process (Join-Path $Root "index.html")
}
