# Bocchi Uninstaller Script
# Usage: irm https://raw.githubusercontent.com/0koksal/bocchi/main/uninstall.ps1 | iex

# Set execution policy for current process if needed
try {
    Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force -ErrorAction SilentlyContinue
} catch {
    # Ignore errors if already set
}

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
        
        # Check if additional cleanup is needed
        $additionalPaths = @(
            "$env:APPDATA\bocchi",
            "$env:LOCALAPPDATA\bocchi",
            "$env:LOCALAPPDATA\bocchi-updater"
        )
        
        $remainingPaths = @()
        foreach ($path in $additionalPaths) {
            if (Test-Path $path) {
                $remainingPaths += $path
            }
        }
        
        if ($remainingPaths.Count -gt 0) {
            Write-Host "`n🧹 Additional cleanup needed:" -ForegroundColor Yellow
            foreach ($path in $remainingPaths) {
                Write-Host "  - $path" -ForegroundColor Gray
            }
            
            $response = Read-Host "`nDo you want to remove all remaining Bocchi data? (y/N)"
            if ($response -match '^[Yy]') {
                foreach ($path in $remainingPaths) {
                    try {
                        Remove-Item -Path $path -Recurse -Force -ErrorAction Stop
                        Write-Host "✅ Removed: $path" -ForegroundColor Green
                    }
                    catch {
                        Write-Host "❌ Failed to remove: $path - $_" -ForegroundColor Red
                    }
                }
                Write-Host "✅ Additional cleanup completed!" -ForegroundColor Green
            } else {
                Write-Host "⏭️ Skipped additional cleanup" -ForegroundColor Yellow
            }
        } else {
            Write-Host "✅ All Bocchi files have been removed!" -ForegroundColor Green
        }
        
    }
    catch {
        Write-Host "❌ Error running uninstaller: $_" -ForegroundColor Red
        Write-Host "You can manually run the uninstaller at: $uninstallerPath" -ForegroundColor Yellow
    }
} else {
    Write-Host "❌ Bocchi uninstaller not found in common locations." -ForegroundColor Red
    Write-Host "Checking for Bocchi data folders to clean up manually..." -ForegroundColor Yellow
    
    # Check for data folders to clean up manually
    $dataPaths = @(
        "$env:APPDATA\bocchi",
        "$env:LOCALAPPDATA\bocchi",
        "$env:LOCALAPPDATA\bocchi-updater"
    )
    
    $foundPaths = @()
    foreach ($path in $dataPaths) {
        if (Test-Path $path) {
            $foundPaths += $path
        }
    }
    
    if ($foundPaths.Count -gt 0) {
        Write-Host "`n🧹 Found Bocchi data folders:" -ForegroundColor Cyan
        foreach ($path in $foundPaths) {
            Write-Host "  - $path" -ForegroundColor Gray
        }
        
        $response = Read-Host "`nDo you want to remove all Bocchi data folders? (y/N)"
        if ($response -match '^[Yy]') {
            foreach ($path in $foundPaths) {
                try {
                    Remove-Item -Path $path -Recurse -Force -ErrorAction Stop
                    Write-Host "✅ Removed: $path" -ForegroundColor Green
                }
                catch {
                    Write-Host "❌ Failed to remove: $path - $_" -ForegroundColor Red
                }
            }
            Write-Host "✅ Manual cleanup completed!" -ForegroundColor Green
        } else {
            Write-Host "⏭️ Cleanup cancelled by user" -ForegroundColor Yellow
        }
    } else {
        Write-Host "✅ No Bocchi data folders found" -ForegroundColor Green
    }
    
    # Show manual cleanup option for program files
    Write-Host "`n🔍 Manual program cleanup locations (if still present):" -ForegroundColor Cyan
    Write-Host "- $env:LOCALAPPDATA\Programs\Bocchi\" -ForegroundColor Gray
    Write-Host "- $env:PROGRAMFILES\Bocchi\" -ForegroundColor Gray
    Write-Host "- $env:PROGRAMFILES(x86)\Bocchi\" -ForegroundColor Gray
}

Write-Host "`nPress any key to exit..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')