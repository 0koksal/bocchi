# Bocchi Uninstaller Script
# Usage: irm https://raw.githubusercontent.com/0koksal/bocchi/main/uninstall.ps1 | iex

Write-Host "🗑️ Bocchi Uninstaller" -ForegroundColor Cyan
Write-Host "Searching for Bocchi installation..." -ForegroundColor Yellow

# Common installation paths to check
$possiblePaths = @(
    "$env:LOCALAPPDATA\Programs\Bocchi\Uninstall Bocchi.exe",
    "$env:PROGRAMFILES\Bocchi\Uninstall Bocchi.exe",
    "$env:PROGRAMFILES(x86)\Bocchi\Uninstall Bocchi.exe"
)

# Find the uninstaller
$uninstallerPath = $null
foreach ($path in $possiblePaths) {
    if (Test-Path $path) {
        $uninstallerPath = $path
        break
    }
}

if ($uninstallerPath) {
    Write-Host "✅ Found Bocchi uninstaller at: $uninstallerPath" -ForegroundColor Green
    Write-Host "🚀 Starting uninstaller..." -ForegroundColor Cyan
    
    try {
        # Run the uninstaller
        Start-Process -FilePath $uninstallerPath -Wait
        Write-Host "✅ Uninstaller completed successfully!" -ForegroundColor Green
    }
    catch {
        Write-Host "❌ Error running uninstaller: $_" -ForegroundColor Red
        Write-Host "You can manually run the uninstaller at: $uninstallerPath" -ForegroundColor Yellow
    }
} else {
    Write-Host "❌ Bocchi uninstaller not found in common locations." -ForegroundColor Red
    Write-Host "Please check if Bocchi is installed or manually locate 'Uninstall Bocchi.exe'" -ForegroundColor Yellow
    
    # Show manual cleanup option
    Write-Host "`n🔍 Manual cleanup locations:" -ForegroundColor Cyan
    Write-Host "- $env:LOCALAPPDATA\Programs\Bocchi\" -ForegroundColor Gray
    Write-Host "- $env:LOCALAPPDATA\bocchi\" -ForegroundColor Gray
    Write-Host "- $env:LOCALAPPDATA\bocchi-updater\" -ForegroundColor Gray
    Write-Host "- $env:APPDATA\bocchi\" -ForegroundColor Gray
}

Write-Host "`nPress any key to exit..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')