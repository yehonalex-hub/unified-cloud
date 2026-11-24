# Copies your local rclone.conf encoded in Base64 directly to the clipboard
# so you can paste it as RCLONE_CONFIG_BASE64 in Render / Railway.
$confPath = "$env:APPDATA\rclone\rclone.conf"
if (-not (Test-Path $confPath)) {
    Write-Host "ERROR: rclone.conf not found at $confPath" -ForegroundColor Red
    exit 1
}
$bytes = [System.IO.File]::ReadAllBytes($confPath)
$b64 = [Convert]::ToBase64String($bytes)
Set-Clipboard -Value $b64
Write-Host "Copied RCLONE_CONFIG_BASE64 to clipboard! Paste it in Render/Railway Environment Variables." -ForegroundColor Green
