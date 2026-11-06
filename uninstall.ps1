# Bocchi Uninstaller Script
# Usage: irm https://raw.githubusercontent.com/0koksal/bocchi/main/uninstall.ps1 | iex
#
# Removes Bocchi, and then the LTK Manager installation Bocchi used for
# injection (including its application data, as if "Delete the application
# data" were ticked in LTK Manager's own uninstaller).

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

# Bocchi can leave its private LTK Manager copy running; stop it so the files
# under Bocchi's app data folder are not locked.
Get-Process -Name 'ltk-manager', 'ltk_patcher_host' -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

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

# --- LTK Manager helpers ---

function Add-LtkManagerInstall {
    param(
        [hashtable]$Found,
        [string]$InstallDir,
        [string]$Uninstaller
    )

    if ($InstallDir) { $InstallDir = $InstallDir.Trim().Trim('"').TrimEnd('\') }
    if ($Uninstaller) { $Uninstaller = $Uninstaller.Trim().Trim('"') }

    if (-not $InstallDir -and $Uninstaller) { $InstallDir = Split-Path -Parent $Uninstaller }
    if (-not $InstallDir) { return }

    $key = $InstallDir.ToLowerInvariant()
    if ($Found.ContainsKey($key)) { return }

    # Ignore entries that point at a folder that is already gone and has no
    # uninstaller left in it.
    if (-not (Test-Path -LiteralPath $InstallDir) -and
        -not ($Uninstaller -and (Test-Path -LiteralPath $Uninstaller))) {
        return
    }

    if (-not $Uninstaller) {
        $candidate = Join-Path $InstallDir 'uninstall.exe'
        if (Test-Path -LiteralPath $candidate) { $Uninstaller = $candidate }
    }

    $Found[$key] = [pscustomobject]@{
        InstallDir  = $InstallDir
        Uninstaller = $Uninstaller
    }
}

function Get-LtkManagerInstalls {
    $found = @{}

    # Add/Remove Programs is authoritative: it knows the real install folder,
    # including a custom one chosen during setup.
    $uninstallRoots = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKCU:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )

    foreach ($root in $uninstallRoots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        foreach ($entry in Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue) {
            $props = Get-ItemProperty -LiteralPath $entry.PSPath -ErrorAction SilentlyContinue
            if (-not $props -or $props.DisplayName -ne 'LTK Manager') { continue }

            $uninstaller = $null
            if ($props.UninstallString) {
                $uninstaller = $props.UninstallString.Trim()
                if ($uninstaller -match '^\s*"([^"]+)"') {
                    $uninstaller = $Matches[1]
                } elseif ($uninstaller -match '^\s*(\S+)') {
                    $uninstaller = $Matches[1]
                }
            }

            Add-LtkManagerInstall -Found $found -InstallDir $props.InstallLocation -Uninstaller $uninstaller

            if ($props.DisplayIcon) {
                $icon = $props.DisplayIcon
                if ($icon -match '^\s*"([^"]+)"') {
                    $icon = $Matches[1]
                } else {
                    $icon = ($icon -split ',')[0].Trim()
                }
                Add-LtkManagerInstall -Found $found -InstallDir (Split-Path -Parent $icon)
            }
        }
    }

    # Well-known locations, for installs whose registry entry is missing.
    $candidateDirs = @()
    if ($env:ProgramFiles) { $candidateDirs += (Join-Path $env:ProgramFiles 'LTK Manager') }
    if (${env:ProgramFiles(x86)}) { $candidateDirs += (Join-Path ${env:ProgramFiles(x86)} 'LTK Manager') }
    if ($env:LOCALAPPDATA) {
        $candidateDirs += (Join-Path $env:LOCALAPPDATA 'LTK Manager')
        $candidateDirs += (Join-Path $env:LOCALAPPDATA 'Programs\LTK Manager')
    }
    foreach ($dir in $candidateDirs) {
        if (Test-Path -LiteralPath $dir) {
            Add-LtkManagerInstall -Found $found -InstallDir $dir
        }
    }

    # Older per-user installs recorded their folder here, even after moving.
    $legacy = Get-ItemProperty -LiteralPath 'HKCU:\Software\leaguetoolkit\LTK Manager' -ErrorAction SilentlyContinue
    if ($legacy -and $legacy.'(default)') {
        Add-LtkManagerInstall -Found $found -InstallDir $legacy.'(default)'
    }

    return @($found.Values)
}

# --- end LTK Manager helpers ---

# Step 4: Uninstall LTK Manager (Bocchi's injection backend)
Write-Host ""
Write-Host "Uninstalling LTK Manager..." -ForegroundColor Yellow

$ltkRemoved = $false
$ltkInstalls = @(Get-LtkManagerInstalls)

if ($ltkInstalls.Count -eq 0) {
    Write-Host "  LTK Manager is not installed, skipping." -ForegroundColor Yellow
} else {
    # Close the manager and its patcher host first. A silent uninstaller would
    # close them itself, but only with rights it may not have.
    Get-Process -Name 'ltk-manager', 'ltk_patcher_host' -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1

    $allGone = $true

    foreach ($install in $ltkInstalls) {
        Write-Host "  Found LTK Manager at: $($install.InstallDir)" -ForegroundColor Green

        if (-not $install.Uninstaller -or -not (Test-Path -LiteralPath $install.Uninstaller)) {
            Write-Host "  No uninstaller found there." -ForegroundColor Yellow
        } else {
            Write-Host "  Running LTK Manager uninstaller (silent)..." -ForegroundColor Cyan
            $launched = $false
            try {
                # The per-machine uninstaller asks for elevation through its manifest.
                Start-Process -FilePath $install.Uninstaller -ArgumentList '/S' -Wait -ErrorAction Stop | Out-Null
                $launched = $true
            } catch {
                Write-Host "  Uninstaller error: $_" -ForegroundColor Red
            }

            if ($launched) {
                # An NSIS uninstaller relaunches itself from %TEMP%, so -Wait returns
                # before the real work is done. Wait for the main executable to go.
                $deadline = (Get-Date).AddSeconds(90)
                while ((Test-Path -LiteralPath (Join-Path $install.InstallDir 'ltk-manager.exe')) -and
                       (Get-Date) -lt $deadline) {
                    Start-Sleep -Milliseconds 500
                }
            }
        }

        if (Test-Path -LiteralPath (Join-Path $install.InstallDir 'ltk-manager.exe')) {
            $allGone = $false
            Write-Host "  LTK Manager is still installed at $($install.InstallDir)." -ForegroundColor Red
        } elseif (Test-Path -LiteralPath $install.InstallDir) {
            # The uninstaller cannot always delete the folder it ran from.
            try {
                Remove-Item -LiteralPath $install.InstallDir -Recurse -Force -ErrorAction Stop
                Write-Host "  Removed leftover folder: $($install.InstallDir)" -ForegroundColor Green
            } catch {
                Write-Host "  Could not remove $($install.InstallDir) - $_" -ForegroundColor Yellow
            }
        }
    }

    if ($allGone) {
        # The same thing "Delete the application data" does in LTK Manager's
        # uninstaller, which a silent uninstall skips because its page never runs.
        $ltkDataDirs = @()
        if ($env:APPDATA) { $ltkDataDirs += (Join-Path $env:APPDATA 'dev.leaguetoolkit.manager') }
        if ($env:LOCALAPPDATA) { $ltkDataDirs += (Join-Path $env:LOCALAPPDATA 'dev.leaguetoolkit.manager') }

        # A library the user moved out of the app data folder is kept, because
        # deleting a user-chosen folder could destroy unrelated files.
        $keptData = @()
        if ($env:APPDATA) {
            $settingsFile = Join-Path $env:APPDATA 'dev.leaguetoolkit.manager\settings.json'
            if (Test-Path -LiteralPath $settingsFile) {
                try {
                    $ltkSettings = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json
                    foreach ($movedPath in @($ltkSettings.modStoragePath, $ltkSettings.workshopPath)) {
                        if ($movedPath -and (Test-Path -LiteralPath $movedPath)) {
                            $keptData += $movedPath
                        }
                    }
                } catch {}
            }
        }

        foreach ($dataDir in $ltkDataDirs) {
            if (Test-Path -LiteralPath $dataDir) {
                try {
                    Remove-Item -LiteralPath $dataDir -Recurse -Force -ErrorAction Stop
                    Write-Host "  Removed app data: $dataDir" -ForegroundColor Green
                } catch {
                    Write-Host "  Failed to remove: $dataDir - $_" -ForegroundColor Red
                }
            }
        }

        # Registry entries the uninstaller only clears when its app-data
        # checkbox is ticked, plus leftovers in the current user's hive that an
        # elevated uninstaller cannot reach.
        $ltkKeys = @(
            'HKCU:\Software\leaguetoolkit\LTK Manager',
            'HKCU:\Software\leaguetoolkit\Manager',
            'HKLM:\Software\leaguetoolkit\LTK Manager',
            'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\LTK Manager',
            'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\LTK Manager',
            'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\LTK Manager'
        )
        foreach ($regPath in $ltkKeys) {
            if (Test-Path -LiteralPath $regPath) {
                try {
                    Remove-Item -LiteralPath $regPath -Recurse -Force -ErrorAction Stop
                    Write-Host "  Removed: $regPath" -ForegroundColor Green
                } catch {
                    Write-Host "  Failed to remove: $regPath - $_" -ForegroundColor Yellow
                }
            }
        }

        try {
            Remove-ItemProperty -LiteralPath 'HKCU:\Software\RegisteredApplications' -Name 'LTK Manager' -Force -ErrorAction Stop
            Write-Host "  Removed registered application entry." -ForegroundColor Green
        } catch {}

        try {
            Remove-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'LTK Manager' -Force -ErrorAction Stop
            Write-Host "  Removed startup entry." -ForegroundColor Green
        } catch {}

        # Drop the manufacturer key once it is empty.
        foreach ($parent in @('HKCU:\Software\leaguetoolkit', 'HKLM:\Software\leaguetoolkit')) {
            if (Test-Path -LiteralPath $parent) {
                try {
                    if (-not (Get-ChildItem -LiteralPath $parent -ErrorAction Stop)) {
                        Remove-Item -LiteralPath $parent -Force -ErrorAction Stop
                    }
                } catch {}
            }
        }

        if ($keptData.Count -gt 0) {
            Write-Host "  LTK Manager's library was moved outside its app data and was kept:" -ForegroundColor Yellow
            foreach ($kept in ($keptData | Select-Object -Unique)) {
                Write-Host "    $kept" -ForegroundColor Yellow
            }
        }

        $ltkRemoved = $true
        Write-Host "  LTK Manager removed." -ForegroundColor Green
    } else {
        Write-Host "  LTK Manager was not fully removed, so its app data was left in place." -ForegroundColor Red
        Write-Host "  Close any LTK Manager window and run this script again as administrator." -ForegroundColor Yellow
    }
}

# Step 5: Remove registry entries
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
if ($ltkRemoved) {
    Write-Host "Bocchi and LTK Manager have been completely removed from your PC." -ForegroundColor Cyan
} else {
    Write-Host "Bocchi has been completely removed from your PC." -ForegroundColor Cyan
}
Write-Host ""
Write-Host "Press any key to exit..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
