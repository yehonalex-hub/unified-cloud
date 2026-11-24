# ======================================================================
# Unified Cloud - Windows Drive Mount Engine (Z:\)
# ======================================================================
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = "MyCloud Drive (Z:\) - Unified Cloud"

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "           Unified Cloud — חיבור כונן מקומי ב-Windows                 " -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host ""

# 1. קביעת הגדרות ברירת מחדל וטעינה מקובץ mount-config.ini אם קיים
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigFile = Join-Path $ScriptDir "mount-config.ini"

$DriveLetter = "Z"
$ServerUrl = "https://unified-cloud.onrender.com"
$CloudPassword = ""

if (Test-Path $ConfigFile) {
    Get-Content $ConfigFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $parts = $line.Split('=', 2)
            if ($parts.Count -eq 2) {
                $k = $parts[0].Trim().ToUpper()
                $v = $parts[1].Trim()
                if ($k -eq "DRIVE_LETTER" -and $v) { $DriveLetter = $v.Substring(0, 1).ToUpper() }
                if ($k -eq "SERVER_URL" -and $v) { $ServerUrl = $v }
                if ($k -eq "CLOUD_PASSWORD") { $CloudPassword = $v }
            }
        }
    }
}

# 2. בדיקת כלי rclone
$rcloneCmd = Get-Command rclone -ErrorAction SilentlyContinue
if (-not $rcloneCmd) {
    # נסה לאתר בנתיב ההתקנה של WinGet
    $wingetRclone = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter "rclone.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($wingetRclone) {
        $env:PATH += ";" + $wingetRclone.DirectoryName
        $rcloneCmd = Get-Command rclone -ErrorAction SilentlyContinue
    }
}

if (-not $rcloneCmd) {
    Write-Host "[X] שגיאה: כלי rclone לא נמצא במערכת (PATH)." -ForegroundColor Red
    Write-Host "    כדי להתקין את rclone באופן אוטומטי, פתח PowerShell כמנהל והרץ:" -ForegroundColor Yellow
    Write-Host "    winget install Rclone.Rclone" -ForegroundColor White
    Write-Host ""
    Read-Host "הקש Enter לסגירה..."
    exit 1
}

# 3. בדיקת WinFsp (נדרש עבור Windows Drive Mount)
$winfspInstalled = (
    (Test-Path "C:\Program Files (x86)\WinFsp\bin\winfsp-x64.dll") -or
    (Test-Path "C:\Program Files\WinFsp\bin\winfsp-x64.dll") -or
    (Test-Path "C:\Program Files (x86)\WinFsp\bin\winfsp-x86.dll")
)

if (-not $winfspInstalled) {
    Write-Host "[X] שגיאה: רכיב WinFsp אינו מותקן במחשב." -ForegroundColor Red
    Write-Host "    WinFsp נדרש להתקנה חד-פעמית כדי לחבר ענן ככונן קבצים אמיתי בסייר הקבצים." -ForegroundColor Yellow
    Write-Host "    להתקנה מהירה ואוטומטית, פתח PowerShell והרץ:" -ForegroundColor White
    Write-Host "    winget install WinFsp.WinFsp" -ForegroundColor White
    Write-Host ""
    Read-Host "הקש Enter לסגירה..."
    exit 1
}

# 4. סנכרון הגדרות חשבונות ענן מהשרת
if ($ServerUrl) {
    Write-Host "[*] בודק סנכרון הגדרות מול השרת ($ServerUrl) ..." -ForegroundColor Gray
    try {
        $cleanUrl = $ServerUrl.TrimEnd('/') + "/api/accounts/export-base64"
        $headers = @{}
        if ($CloudPassword) {
            $headers["X-Cloud-Password"] = $CloudPassword
            $headers["Authorization"] = "Bearer $CloudPassword"
        }
        $resp = Invoke-RestMethod -Uri $cleanUrl -Headers $headers -TimeoutSec 6 -ErrorAction Stop
        if ($resp.ok -and $resp.base64) {
            $confPath = "$env:APPDATA\rclone\rclone.conf"
            $confDir = [System.IO.Path]::GetDirectoryName($confPath)
            if (-not (Test-Path $confDir)) {
                New-Item -ItemType Directory -Path $confDir -Force | Out-Null
            }
            [System.IO.File]::WriteAllBytes($confPath, [Convert]::FromBase64String($resp.base64))
            Write-Host "[V] הגדרות החשבונות סונכרנו בהצלחה מהשרת!" -ForegroundColor Green
        }
    } catch {
        Write-Host "[i] דילוג על סנכרון ענן (שימוש בהגדרות המקומיות)." -ForegroundColor Yellow
    }
}
Write-Host ""

# 5. בדיקת חשבונות ענן מחוברים
$rawRemotes = @(& rclone listremotes --long 2>&1)
$remotes = @()
$hasMyCloud = $false

foreach ($line in $rawRemotes) {
    if ($line -match '^([^:]+):\s+(\S+)') {
        $rName = $matches[1].Trim()
        if ($rName -eq "mycloud") {
            $hasMyCloud = $true
        } else {
            $remotes += $rName
        }
    }
}

if ($remotes.Count -eq 0 -and -not $hasMyCloud) {
    Write-Host "======================================================================" -ForegroundColor Yellow
    Write-Host " [!] שים לב: עדיין לא חוברו חשבונות ענן ל-Unified Cloud!              " -ForegroundColor Yellow
    Write-Host ""
    Write-Host " כדי שתוכל לגשת לקבצים דרך כונן ${DriveLetter}:\ יש לחבר לפחות חשבון ענן אחד"
    Write-Host " (Google Drive, OneDrive, MEGA, Dropbox, Box ועוד)."
    Write-Host ""
    Write-Host " כיצד לחבר בקלות:"
    Write-Host " 1. הפעל את השרת המקומי (הרץ את start.bat) או פתח את כתובת האתר בענן."
    Write-Host " 2. לחץ על 'הוסף חשבון ענן' וחבר את החשבונות שלך."
    Write-Host " 3. לאחר מכן, הפעל שוב את הסקריפט הזה."
    Write-Host "======================================================================" -ForegroundColor Yellow
    Write-Host ""
    $openWeb = Read-Host "האם לפתוח כעת את ממשק האתר בדפדפן? (Y/N)"
    if ($openWeb -match "^[yYה]") {
        Start-Process "http://localhost:3456"
    }
    Write-Host ""
    Read-Host "הקש Enter לסגירה..."
    exit 0
}

# אם יש חשבונות אך עדיין אין remote בשם mycloud, בנה אותו
if (-not $hasMyCloud -and $remotes.Count -gt 0) {
    Write-Host "[*] יוצר איחוד עננים (mycloud union) עבור $($remotes.Count) חשבונות..." -ForegroundColor Gray
    if ($remotes.Count -eq 1) {
        & rclone config create mycloud alias "remote=$($remotes[0]):" | Out-Null
    } else {
        $up = ($remotes | ForEach-Object { "$($_):" }) -join " "
        & rclone config create mycloud union "upstreams=$up" action_policy=epall create_policy=mfs search_policy=ff | Out-Null
    }
}

# 6. בדיקה האם אות הכונן כבר תפוסה
if (Test-Path "$($DriveLetter):") {
    Write-Host "[!] כונן ${DriveLetter}:\ כבר מחובר או תפוס במערכת." -ForegroundColor Yellow
    Write-Host "    פותח את הכונן בסייר הקבצים..."
    Start-Process "explorer.exe" "$($DriveLetter):\"
    Write-Host ""
    $reconnect = Read-Host "האם ברצונך לנתק את הכונן ולחבר מחדש? (Y/N)"
    if ($reconnect -match "^[yYה]") {
        Write-Host "[*] מנתק חיבור קודם..." -ForegroundColor Gray
        Get-Process rclone -ErrorAction SilentlyContinue | Where-Object {
            $_.CommandLine -like "*mount*mycloud*"
        } | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    } else {
        exit 0
    }
}

# 7. חיבור הכונן בפועל
Write-Host "[*] מחבר את כל העננים המאוחדים אל כונן ${DriveLetter}:\ בסייר הקבצים..." -ForegroundColor Green
Write-Host "    שם כונן: MyCloud | מטמון: VFS Full Cache 4GB | חיבור: Network Drive" -ForegroundColor Gray
Write-Host ""
Write-Host "----------------------------------------------------------------------" -ForegroundColor Cyan
Write-Host "    הכונן מחובר כעת! חלון סייר הקבצים ייפתח אוטומטית בעוד רגע.        " -ForegroundColor Cyan
Write-Host "    כדי לנתק את הכונן, פשוט סגור חלון זה או הקש Ctrl+C.               " -ForegroundColor Cyan
Write-Host "----------------------------------------------------------------------" -ForegroundColor Cyan
Write-Host ""

# פתיחה ברקע של סייר הקבצים ברגע שהכונן מוכן
$jobScript = {
    param($drive)
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Path "${drive}:\") {
            Start-Sleep -Milliseconds 300
            Start-Process "explorer.exe" "${drive}:\"
            break
        }
    }
}
Start-Job -ScriptBlock $jobScript -ArgumentList $DriveLetter | Out-Null

# הרצת פקודת ה-mount
$mountArgs = @(
    "mount",
    "mycloud:",
    "$($DriveLetter):",
    "--network-mode",
    "--vfs-cache-mode", "full",
    "--vfs-write-back", "5s",
    "--vfs-read-ahead", "128M",
    "--vfs-read-chunk-size", "32M",
    "--vfs-read-chunk-size-limit", "256M",
    "--vfs-cache-max-size", "4G",
    "--vfs-cache-max-age", "24h",
    "--vfs-fast-fingerprint",
    "--buffer-size", "64M",
    "--dir-cache-time", "5m",
    "--poll-interval", "15s",
    "--transfers", "8",
    "--checkers", "16",
    "--drive-use-trash=false",
    "--volname", "MyCloud"
)

& rclone @mountArgs

Write-Host ""
Write-Host "[i] כונן ${DriveLetter}:\ נותק." -ForegroundColor Yellow
Read-Host "הקש Enter לסגירה..."
