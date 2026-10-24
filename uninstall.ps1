# Bocchi Uninstaller Script
# Usage: irm https://raw.githubusercontent.com/0koksal/bocchi/main/uninstall.ps1 | iex

try {
    Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force -ErrorAction SilentlyContinue
} catch {}

Write-Host "Bocchi Uninstaller" -ForegroundColor Cyan
Write-Host ""

# Step 1: Kill Bocchi if running
$bocchiProcess = Get-Process -Name "Bocchi" -ErrorAction SilentlyContinue
if ($bocchiProcess) {
    Write-Host "Stopping Bocchi..." -ForegroundColor Yellow
    $bocchiProcess | Stop-Process -Force
    Start-Sleep -Seconds 2
    Write-Host "  Bocchi stopped." -ForegroundColor Green
}

# Step 2: Run the NSIS uninstaller if found
Write-Host "Searching for Bocchi installation..." -ForegroundColor Yellow

$possiblePaths = @(
    "$env:LOCALAPPDATA\Programs\Bocchi\Uninstall Bocchi.exe",
    "$env:PROGRAMFILES\Bocchi\Uninstall Bocchi.exe",
    "$env:PROGRAMFILES(x86)\Bocchi\Uninstall Bocchi.exe"
)

$uninstallerPath = $null
foreach ($path in $possiblePaths) {
    if (Test-Path $path) {
        $uninstallerPath = $path
        break
    }
}

if ($uninstallerPath) {
    Write-Host "  Found uninstaller at: $uninstallerPath" -ForegroundColor Green
    Write-Host "  Running uninstaller..." -ForegroundColor Cyan
    try {
        Start-Process -FilePath $uninstallerPath -ArgumentList "/S" -Wait
        Write-Host "  Uninstaller completed." -ForegroundColor Green
    } catch {
        Write-Host "  Uninstaller error: $_" -ForegroundColor Red
    }
} else {
    Write-Host "  No NSIS uninstaller found, skipping." -ForegroundColor Yellow
}

# Step 3: Remove all Bocchi data and leftover folders
Write-Host ""
Write-Host "Cleaning up all Bocchi files..." -ForegroundColor Yellow

$allPaths = @(
    "$env:APPDATA\bocchi",
    "$env:LOCALAPPDATA\bocchi",
    "$env:LOCALAPPDATA\bocchi-updater",
    "$env:LOCALAPPDATA\Programs\Bocchi",
    "$env:PROGRAMFILES\Bocchi",
    "$env:PROGRAMFILES(x86)\Bocchi",
    "$env:TEMP\bocchi"
)

foreach ($path in $allPaths) {
    if (Test-Path $path) {
        try {
            Remove-Item -Path $path -Recurse -Force -ErrorAction Stop
            Write-Host "  Removed: $path" -ForegroundColor Green
        } catch {
            Write-Host "  Failed to remove: $path - $_" -ForegroundColor Red
        }
    }
}

# Step 4: Remove registry entries
Write-Host ""
Write-Host "Cleaning up registry entries..." -ForegroundColor Yellow

$registryPaths = @(
    "HKCU:\Software\bocchi",
    "HKCU:\Software\Bocchi",
    "HKLM:\Software\bocchi",
    "HKLM:\Software\Bocchi",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\bocchi",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\bocchi",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\bocchi"
)

foreach ($regPath in $registryPaths) {
    if (Test-Path $regPath) {
        try {
            Remove-Item -Path $regPath -Recurse -Force -ErrorAction Stop
            Write-Host "  Removed: $regPath" -ForegroundColor Green
        } catch {
            Write-Host "  Failed to remove: $regPath - $_" -ForegroundColor Red
        }
    }
}

# Remove startup registry entry if present
$startupKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$startupValue = Get-ItemProperty -Path $startupKey -Name "Bocchi" -ErrorAction SilentlyContinue
if ($startupValue) {
    try {
        Remove-ItemProperty -Path $startupKey -Name "Bocchi" -Force
        Write-Host "  Removed startup entry." -ForegroundColor Green
    } catch {
        Write-Host "  Failed to remove startup entry: $_" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "Bocchi has been completely removed from your PC." -ForegroundColor Cyan
Write-Host ""
Write-Host "Press any key to exit..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
