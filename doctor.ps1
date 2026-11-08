# Bocchi Doctor - PC diagnostics for Bocchi and LTK Manager
#
# Read-only by default. Pass -Fix to remove the RUNASADMIN compatibility flags
# that cause LTK Manager's LEAGUE_ELEVATED / MANAGER_ELEVATED errors.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\doctor.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\doctor.ps1 -Fix
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\doctor.ps1 -Fix -Yes
#
# From the internet (read-only):
#   irm https://raw.githubusercontent.com/0koksal/bocchi/main/doctor.ps1 | iex
#
# From the internet with -Fix:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/0koksal/bocchi/main/doctor.ps1))) -Fix

[CmdletBinding()]
param(
    [switch]$Fix,
    [switch]$Yes
)

$ErrorActionPreference = 'SilentlyContinue'

# Use TLS 1.2 for the connectivity checks. Windows PowerShell 5.1 otherwise
# still offers TLS 1.0 to GitHub on some machines.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$script:DoctorVersion = '1.0'
$script:Results = New-Object System.Collections.ArrayList
$script:SeenFixes = New-Object System.Collections.ArrayList
$script:NativeAvailable = $false
$script:League = $null
$script:LeagueElevationFixed = $false
$script:InjectionMethod = 'ltk'
$script:UacDisabled = $false
$script:BuiltinAdmin = $false
$script:AppBridgeNotRunning = $false
$script:AppVcRedistMissing = $false
$script:BocchiData = Join-Path $env:APPDATA 'bocchi'
$script:LtkData = Join-Path $env:APPDATA 'dev.leaguetoolkit.manager'
$script:BridgeRoot = Join-Path $script:BocchiData 'official-ltk-bridge'

# Official LTK Manager binaries Bocchi has verified (the same SHA-256 values
# the bridge pins). A different build may still work, but it has not been
# tested, so doctor reports it as a warning rather than a failure.
$script:LtkManagerDigests = @{
    '67a668db37f66dccc25beb273ff87b66172c134c650f299c6b55f26319d437a6' = '1.33.0'
    'db83114d1bd95bd207ffd79c14b5f701c9583a2287bf9e330943963c1c4b08de' = '1.32.0'
}
$script:LtkHostDigest = '27de1bfdbf37129e42c12b18cc7b4f75c15d39bcd7afefe65c4c33d0e99fe856'

function Add-Section {
    param([string]$Name)
    Write-Host ''
    Write-Host ("--- $Name " + ('-' * [Math]::Max(0, 55 - $Name.Length))) -ForegroundColor DarkCyan
}

function Add-Result {
    param(
        [ValidateSet('OK', 'INFO', 'WARN', 'FAIL')][string]$Status,
        [string]$Area,
        [string]$Title,
        [string[]]$Detail = @(),
        [string]$FixText = '',
        [string]$Tag = ''
    )

    $null = $script:Results.Add([pscustomobject]@{
        Status = $Status
        Area   = $Area
        Title  = $Title
        Detail = $Detail
        Fix    = $FixText
        Tag    = $Tag
    })

    $tag = @{ OK = ' OK '; INFO = 'INFO'; WARN = 'WARN'; FAIL = 'FAIL' }[$Status]
    $color = @{ OK = 'Green'; INFO = 'Gray'; WARN = 'Yellow'; FAIL = 'Red' }[$Status]

    Write-Host ('[{0}] {1,-19} {2}' -f $tag, $Area, $Title) -ForegroundColor $color
    foreach ($line in $Detail) {
        if ($line) { Write-Host ('        ' + $line) -ForegroundColor DarkGray }
    }
    if ($FixText -and ($Status -eq 'WARN' -or $Status -eq 'FAIL')) {
        Write-Host ('        Fix: ' + $FixText) -ForegroundColor Cyan
        if ($script:SeenFixes -notcontains $FixText) {
            $null = $script:SeenFixes.Add($FixText)
        }
    }
}

function Test-IsAdmin {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Get-RegValue {
    param([string]$Path, [string]$Name)
    try {
        $item = Get-ItemProperty -LiteralPath $Path -Name $Name -ErrorAction Stop
        return $item.$Name
    } catch {
        return $null
    }
}

function Read-JsonFile {
    param([string]$Path)
    try {
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
            if ($raw) { return ($raw | ConvertFrom-Json) }
        }
    } catch {}
    return $null
}

function Get-FileVersion {
    param([string]$Path)
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
        return (Get-Item -LiteralPath $Path).VersionInfo.FileVersion
    } catch {
        return $null
    }
}

function Get-BaseName {
    param([string]$Path)
    if (-not $Path) { return '' }
    $parts = $Path -split '[\\/]'
    return $parts[$parts.Length - 1]
}

function Get-Sha256 {
    param([string]$Path)
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
        return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    } catch {
        return $null
    }
}

function Get-NormalizedPath {
    param([string]$Path)
    if (-not $Path) { return '' }
    $p = $Path.Trim().Trim('"')
    try { $p = [IO.Path]::GetFullPath($p) } catch {}
    $p = $p -replace '/', '\'
    return $p.TrimEnd('\').ToLowerInvariant()
}

function Test-IsWritable {
    param([string]$Path)
    if (-not $Path) { return $null }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $null }
    $probe = Join-Path $Path ('.bocchi-doctor-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($probe, 'bocchi')
        return $true
    } catch {
        return $false
    } finally {
        if (Test-Path -LiteralPath $probe) {
            Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-FreeGB {
    param([string]$Path)
    try {
        $qualifier = Split-Path -Qualifier $Path -ErrorAction Stop
        $name = $qualifier.TrimEnd(':')
        $drive = Get-PSDrive -Name $name -ErrorAction Stop
        if ($null -eq $drive.Free) { return $null }
        return [Math]::Round(($drive.Free / 1GB), 1)
    } catch {
        return $null
    }
}

function Test-CloudPath {
    param([string]$Path)
    if (-not $Path) { return $null }
    foreach ($token in @('OneDrive', 'Dropbox', 'iCloudDrive', 'iCloud Drive', 'Google Drive', 'GoogleDrive', 'Box', 'pCloud')) {
        if ($Path -like "*$token*") { return $token }
    }
    return $null
}

function Test-OfflineAttribute {
    param([string]$Path)
    try {
        $attrs = [IO.File]::GetAttributes($Path)
        if (($attrs -band [IO.FileAttributes]::Offline) -ne 0) { return 'Offline' }
        if (([int]$attrs -band 0x400000) -ne 0) { return 'RecallOnDataAccess' }
    } catch {}
    return $null
}

function Test-HttpEndpoint {
    param([string]$Url)
    try {
        $null = Invoke-WebRequest -Uri $Url -UseBasicParsing -Method Head -TimeoutSec 8 -ErrorAction Stop
        return $true
    } catch {
        # Any HTTP response means the endpoint is reachable; only DNS/TLS/timeout
        # failures leave no response object.
        if ($_.Exception.Response) { return $true }
        return $false
    }
}

function Get-CompatLayers {
    $roots = @(
        [pscustomobject]@{ Key = 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers'; Label = 'HKCU' },
        [pscustomobject]@{ Key = 'HKCU:\Software\WOW6432Node\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers'; Label = 'HKCU (32-bit view)' },
        [pscustomobject]@{ Key = 'HKLM:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers'; Label = 'HKLM' },
        [pscustomobject]@{ Key = 'HKLM:\Software\WOW6432Node\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers'; Label = 'HKLM (32-bit view)' }
    )

    $entries = @()
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root.Key)) { continue }
        $props = $null
        try { $props = Get-ItemProperty -LiteralPath $root.Key -ErrorAction Stop } catch { continue }
        if (-not $props) { continue }
        foreach ($prop in $props.PSObject.Properties) {
            if ($prop.Name -in @('PSPath', 'PSParentPath', 'PSChildName', 'PSDrive', 'PSProvider')) { continue }
            $entries += [pscustomobject]@{
                Root   = $root.Label
                Key    = $root.Key
                Exe    = $prop.Name
                Layers = [string]$prop.Value
                Base   = Get-BaseName $prop.Name
            }
        }
    }
    return @($entries)
}

function Get-IfeoDebuggers {
    $targets = @(
        'League of Legends.exe',
        'LeagueClient.exe',
        'LeagueClientUx.exe',
        'LeagueClientUxRender.exe',
        'RiotClientServices.exe',
        'RiotClientUx.exe',
        'RiotClientUxRender.exe',
        'ltk-manager.exe',
        'ltk_patcher_host.exe',
        'Bocchi.exe',
        'mod-tools.exe'
    )

    $roots = @(
        [pscustomobject]@{ Key = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options'; Label = 'HKLM' },
        [pscustomobject]@{ Key = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows NT\CurrentVersion\Image File Execution Options'; Label = 'HKLM (32-bit view)' }
    )

    $entries = @()
    $seen = @{}
    foreach ($root in $roots) {
        foreach ($target in $targets) {
            $debugger = Get-RegValue (Join-Path $root.Key $target) 'Debugger'
            if (-not $debugger) { continue }
            $key = ($target + '|' + [string]$debugger).ToLowerInvariant()
            if ($seen.ContainsKey($key)) { continue }
            $seen[$key] = $true
            $entries += [pscustomobject]@{
                Root     = $root.Label
                Exe      = $target
                Debugger = [string]$debugger
            }
        }
    }
    return @($entries)
}

function Get-AuthenticodeStatus {
    param([string]$Path)
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
        $signature = Get-AuthenticodeSignature -LiteralPath $Path -ErrorAction Stop
        if (-not $signature) { return $null }
        return [pscustomobject]@{
            Status = [string]$signature.Status
            Signer = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { '' }
        }
    } catch {
        return $null
    }
}

function Get-RunningProcesses {
    param([string[]]$Names)
    $list = @()
    foreach ($name in $Names) {
        $list += @(Get-Process -Name $name -ErrorAction SilentlyContinue)
    }
    return @($list | Sort-Object Id -Unique)
}

function Get-ElevationOfProcess {
    param([int]$Id)
    if (-not $script:NativeAvailable) { return $null }
    try {
        $result = [BocchiDoctorNative]::IsElevated($Id)
    } catch {
        return $null
    }
    if ($result -eq 1) { return $true }
    if ($result -eq 0) { return $false }
    return $null
}

function Add-ProcessCheck {
    param(
        [string]$Area,
        [string]$Label,
        [string[]]$Names,
        [string]$ElevatedStatus = 'FAIL',
        [string]$ElevatedFix = ''
    )

    $procs = @(Get-RunningProcesses $Names)
    if ($procs.Count -eq 0) {
        Add-Result 'INFO' $Area "$Label is not running" @()
        return
    }

    $elevated = @()
    $normal = @()
    $unknown = @()

    foreach ($proc in $procs) {
        $level = Get-ElevationOfProcess -Id $proc.Id
        $text = "$($proc.ProcessName) (PID $($proc.Id))"
        if ($level -eq $true) {
            $elevated += $text
        } elseif ($level -eq $false) {
            $normal += $text
        } else {
            $unknown += $text
        }
    }

    if ($elevated.Count -gt 0) {
        Add-Result $ElevatedStatus $Area "$Label is running as administrator" $elevated $ElevatedFix
    } elseif ($normal.Count -eq 0 -and $unknown.Count -gt 0) {
        Add-Result 'WARN' $Area "Could not read the elevation level of $Label" $unknown 'Run this script as administrator to read other processes, or check Task Manager > Details and add the "Elevated" column.'
    } else {
        Add-Result 'OK' $Area "$Label is running normally" @("$($normal.Count) process(es) checked; none elevated")
    }
}

# Process elevation probe. OpenProcessToken + TokenElevation works without a
# manifest and without loading any extra module.
if (-not ('BocchiDoctorNative' -as [type])) {
    try {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class BocchiDoctorNative
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int infoClass, out int info, int len, out int retLen);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static int IsElevated(int pid)
    {
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) return -1;

        IntPtr token = IntPtr.Zero;
        try
        {
            if (!OpenProcessToken(process, 0x0008, out token)) return -1;

            int info;
            int ret;
            if (!GetTokenInformation(token, 20, out info, 4, out ret)) return -1;
            return info != 0 ? 1 : 0;
        }
        finally
        {
            if (token != IntPtr.Zero) CloseHandle(token);
            CloseHandle(process);
        }
    }
}
'@
        $script:NativeAvailable = $true
    } catch {
        $script:NativeAvailable = $false
    }
}

# Reads the integrity level and user RID of the Windows shell (explorer.exe).
# Rose uses the same check because an elevated shell makes every program it
# starts run as administrator, even when Bocchi itself is not elevated.
if (-not ('BocchiDoctorShell' -as [type])) {
    try {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class BocchiDoctorShell
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetShellWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int len, out int retLen);

    [DllImport("advapi32.dll")]
    private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

    [DllImport("advapi32.dll")]
    private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static string GetShellAccount()
    {
        IntPtr hwnd = GetShellWindow();
        if (hwnd == IntPtr.Zero) return null;

        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        if (pid == 0) return null;

        IntPtr process = OpenProcess(0x1000, false, (int)pid);
        if (process == IntPtr.Zero) return null;

        IntPtr token = IntPtr.Zero;
        try
        {
            if (!OpenProcessToken(process, 0x0008, out token)) return null;

            int integrity = GetSidLastRid(token, 25);
            int user = GetSidLastRid(token, 1);
            if (integrity < 0 || user < 0) return null;

            return pid.ToString() + ";" + integrity.ToString() + ";" + user.ToString();
        }
        finally
        {
            if (token != IntPtr.Zero) CloseHandle(token);
            CloseHandle(process);
        }
    }

    private static int GetSidLastRid(IntPtr token, int infoClass)
    {
        int size;
        GetTokenInformation(token, infoClass, IntPtr.Zero, 0, out size);
        if (size <= 0) return -1;

        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            int returned;
            if (!GetTokenInformation(token, infoClass, buffer, size, out returned)) return -1;

            IntPtr sid = Marshal.ReadIntPtr(buffer);
            if (sid == IntPtr.Zero) return -1;

            byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
            if (count == 0) return -1;

            IntPtr sub = GetSidSubAuthority(sid, (uint)(count - 1));
            if (sub == IntPtr.Zero) return -1;

            return Marshal.ReadInt32(sub);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }
}
'@
    } catch {}
}

function Get-ShellAccount {
    try {
        $raw = [BocchiDoctorShell]::GetShellAccount()
        if (-not $raw) { return $null }
        $parts = $raw -split ';'
        if ($parts.Count -ne 3) { return $null }
        $integrity = [int]$parts[1]
        $userRid = [int]$parts[2]
        return [pscustomobject]@{
            Pid                  = [int]$parts[0]
            Integrity            = $integrity
            UserRid              = $userRid
            Elevated             = ($integrity -ge 0x3000)
            BuiltinAdministrator = ($userRid -eq 500)
        }
    } catch {
        return $null
    }
}

function Find-LeagueGamePath {
    param([string]$SettingsGamePath)

    $candidates = New-Object System.Collections.ArrayList

    if ($SettingsGamePath) {
        [void]$candidates.Add([pscustomobject]@{ Path = $SettingsGamePath; Source = 'Bocchi settings' })
    }

    $registryCandidates = @(
        [pscustomobject]@{ Key = 'HKLM:\SOFTWARE\WOW6432Node\Riot Games\League of Legends'; Source = 'Riot Games registry' },
        [pscustomobject]@{ Key = 'HKLM:\SOFTWARE\Riot Games\League of Legends'; Source = 'Riot Games registry' },
        [pscustomobject]@{ Key = 'HKLM:\SOFTWARE\WOW6432Node\Riot Games, Inc.\League of Legends'; Source = 'Riot Games Inc. registry' },
        [pscustomobject]@{ Key = 'HKLM:\SOFTWARE\Riot Games, Inc.\League of Legends'; Source = 'Riot Games Inc. registry' }
    )

    foreach ($reg in $registryCandidates) {
        $location = Get-RegValue $reg.Key 'InstallLocation'
        if ($location) {
            [void]$candidates.Add([pscustomobject]@{ Path = ([string]$location); Source = $reg.Source })
        }
    }

    foreach ($uninstallKey in @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\League of Legends',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\League of Legends'
    )) {
        $props = Get-ItemProperty -LiteralPath $uninstallKey -ErrorAction SilentlyContinue
        if (-not $props) { continue }
        if ($props.InstallLocation) {
            [void]$candidates.Add([pscustomobject]@{ Path = ([string]$props.InstallLocation); Source = 'Add/Remove Programs' })
        }
        if ($props.DisplayIcon) {
            $icon = [string]$props.DisplayIcon
            if ($icon -match '^"([^"]+)"') { $icon = $Matches[1] } else { $icon = ($icon -split ',')[0].Trim() }
            $dir = Split-Path -Parent $icon
            if ($dir) {
                [void]$candidates.Add([pscustomobject]@{ Path = $dir; Source = 'Add/Remove Programs icon' })
            }
        }
    }

    foreach ($drive in @('C:', 'D:', 'E:')) {
        [void]$candidates.Add([pscustomobject]@{ Path = "$drive\Riot Games\League of Legends"; Source = 'common install folder' })
        [void]$candidates.Add([pscustomobject]@{ Path = "$drive\Program Files\Riot Games\League of Legends"; Source = 'common install folder' })
    }

    foreach ($candidate in $candidates) {
        $path = ([string]$candidate.Path).Trim().Trim('"').TrimEnd('\')
        if (-not $path) { continue }

        if (Test-Path -LiteralPath (Join-Path $path 'League of Legends.exe')) {
            return [pscustomobject]@{
                GamePath = $path
                Root     = (Split-Path -Parent $path)
                Source   = $candidate.Source
            }
        }

        $game = Join-Path $path 'Game'
        if (Test-Path -LiteralPath (Join-Path $game 'League of Legends.exe')) {
            return [pscustomobject]@{
                GamePath = $game
                Root     = $path
                Source   = $candidate.Source
            }
        }
    }

    return $null
}

function Get-LtkInstalls {
    $found = @{}

    $uninstallRoots = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKCU:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )

    foreach ($root in $uninstallRoots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        foreach ($entry in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
            $props = Get-ItemProperty -LiteralPath $entry.PSPath -ErrorAction SilentlyContinue
            if (-not $props -or $props.DisplayName -ne 'LTK Manager') { continue }

            $installDir = $null
            if ($props.InstallLocation) {
                $installDir = ([string]$props.InstallLocation).Trim().Trim('"').TrimEnd('\')
            }
            if (-not $installDir -and $props.UninstallString) {
                $uninstaller = ([string]$props.UninstallString).Trim()
                if ($uninstaller -match '^"([^"]+)"') { $uninstaller = $Matches[1] } elseif ($uninstaller -match '^(\S+)') { $uninstaller = $Matches[1] }
                $installDir = Split-Path -Parent $uninstaller
            }
            if (-not $installDir) { continue }

            $key = $installDir.ToLowerInvariant()
            if (-not $found.ContainsKey($key)) {
                $version = $null
                if ($props.DisplayVersion) { $version = [string]$props.DisplayVersion }
                $found[$key] = [pscustomobject]@{
                    InstallDir = $installDir
                    Manager    = Join-Path $installDir 'ltk-manager.exe'
                    Patcher    = Join-Path $installDir 'ltk_patcher_host.exe'
                    Version    = $version
                    Source     = 'Add/Remove Programs'
                }
            }
        }
    }

    $knownDirs = @()
    if ($env:ProgramFiles) { $knownDirs += (Join-Path $env:ProgramFiles 'LTK Manager') }
    if (${env:ProgramFiles(x86)}) { $knownDirs += (Join-Path ${env:ProgramFiles(x86)} 'LTK Manager') }
    if ($env:LOCALAPPDATA) {
        $knownDirs += (Join-Path $env:LOCALAPPDATA 'LTK Manager')
        $knownDirs += (Join-Path $env:LOCALAPPDATA 'Programs\LTK Manager')
    }
    if ($env:APPDATA) { $knownDirs += (Join-Path $env:APPDATA 'LTK Manager') }

    foreach ($dir in $knownDirs) {
        $manager = Join-Path $dir 'ltk-manager.exe'
        if (-not (Test-Path -LiteralPath $manager)) { continue }
        $key = $dir.ToLowerInvariant()
        if (-not $found.ContainsKey($key)) {
            $found[$key] = [pscustomobject]@{
                InstallDir = $dir
                Manager    = $manager
                Patcher    = Join-Path $dir 'ltk_patcher_host.exe'
                Version    = Get-FileVersion $manager
                Source     = 'known folder'
            }
        }
    }

    return @($found.Values)
}

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host 'Bocchi Doctor' -ForegroundColor Cyan
Write-Host "Diagnostics for Bocchi 2.0.53 and LTK Manager - version $($script:DoctorVersion)" -ForegroundColor DarkGray
Write-Host 'Read-only by default. Pass -Fix to remove RUNASADMIN compatibility flags.' -ForegroundColor DarkGray

$isAdmin = Test-IsAdmin

# ---------------------------------------------------------------------------
# System
# ---------------------------------------------------------------------------

Add-Section 'System'

$osInfo = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue
$build = 0
if ($osInfo -and $osInfo.CurrentBuildNumber) { $build = [int]$osInfo.CurrentBuildNumber }

if ($build -gt 0) {
    $ubr = 0
    if ($osInfo.PSObject.Properties['UBR']) { $ubr = [int]$osInfo.UBR }
    $product = [string]$osInfo.ProductName
    $release = [string]$osInfo.DisplayVersion
    $osText = "$product $release (build $build.$ubr)"

    if ($build -lt 19045 -or $build -eq 22000) {
        Add-Result 'FAIL' 'Windows' $osText @() 'Run Windows Update until you are on Windows 10 22H2 (build 19045) or a current Windows 11 build, then reboot.'
    } else {
        Add-Result 'OK' 'Windows' $osText
    }
} else {
    Add-Result 'INFO' 'Windows' 'Could not read the Windows build number'
}

$architecture = $env:PROCESSOR_ARCHITECTURE
if ($architecture -eq 'AMD64') {
    Add-Result 'OK' 'Architecture' '64-bit Windows (AMD64)'
} elseif ($architecture -eq 'ARM64') {
    Add-Result 'WARN' 'Architecture' 'ARM64 Windows' @() 'Bocchi and LTK Manager are x64 applications. They can run under emulation, but injection may fail. Use an x64 PC if possible.'
} else {
    Add-Result 'FAIL' 'Architecture' "Unsupported architecture: $architecture" @() 'Bocchi and LTK Manager require 64-bit Windows.'
}

$enableLua = Get-RegValue 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' 'EnableLUA'
if ($null -eq $enableLua -or [int]$enableLua -ne 0) {
    Add-Result 'OK' 'User Account Control' 'Enabled'
} else {
    $script:UacDisabled = $true
    Add-Result 'FAIL' 'User Account Control' 'UAC is disabled, so every process runs elevated' @() 'Turn UAC back on: Start > "Change User Account Control settings" > set it to the default level, then reboot. An elevated League cannot be injected.'
}

try {
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($currentSid -match '-500$') {
        $script:BuiltinAdmin = $true
        Add-Result 'WARN' 'Account' 'Built-in Administrator account detected' @() 'UAC does not filter this account, so every process runs elevated. Create a normal administrator account and use it for League, Bocchi and LTK Manager.'
    }
} catch {}

# LTK Manager refuses to patch when the process chain is elevated. Checking the
# shell catches "everything runs as administrator" even when this script itself
# is started normally (Rose does the same through explorer.exe's token).
$shellAccount = Get-ShellAccount
if ($shellAccount) {
    if ($shellAccount.Elevated) {
        if ($shellAccount.BuiltinAdministrator) {
            Add-Result 'INFO' 'Windows shell' 'explorer.exe runs elevated, as expected on the built-in Administrator account'
        } elseif ($script:UacDisabled) {
            Add-Result 'INFO' 'Windows shell' 'explorer.exe runs elevated, as expected with UAC disabled'
        } else {
            Add-Result 'WARN' 'Windows shell' 'explorer.exe runs as administrator' @('Programs started from the desktop, including League and LTK Manager, inherit that elevation.') 'Sign out and sign in normally. If explorer.exe still runs elevated, check the shell replacement and Task Scheduler startup entries, or use a regular administrator account.'
        }
    } else {
        Add-Result 'OK' 'Windows shell' 'explorer.exe runs normally (not elevated)'
    }
} else {
    Add-Result 'INFO' 'Windows shell' 'Could not read the integrity level of explorer.exe'
}

$longPaths = Get-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' 'LongPathsEnabled'
if ($null -ne $longPaths -and [int]$longPaths -eq 1) {
    Add-Result 'OK' 'Long paths' 'Enabled'
} else {
    Add-Result 'WARN' 'Long paths' 'Disabled (260-character path limit)' @() 'Mods in deeply nested folders can fail to extract. Run this in an elevated Command Prompt, then reboot: reg add "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f'
}

$systemFreeGB = Get-FreeGB $env:SystemDrive
if ($null -ne $systemFreeGB) {
    if ($systemFreeGB -lt 2) {
        Add-Result 'WARN' 'Disk space' "$env:SystemDrive has only $systemFreeGB GB free" @() 'Free up space on the Windows drive. Overlay building needs temporary disk space.'
    } else {
        Add-Result 'OK' 'Disk space' "$env:SystemDrive has $systemFreeGB GB free"
    }
}

$tempWritable = Test-IsWritable $env:TEMP
if ($tempWritable -eq $true) {
    Add-Result 'OK' 'Temp folder' "$env:TEMP is writable"
} elseif ($tempWritable -eq $false) {
    Add-Result 'FAIL' 'Temp folder' "$env:TEMP is not writable" @() 'Clear %TEMP% or fix its permissions. Bocchi and the LTK installer need a writable temp folder.'
} else {
    Add-Result 'INFO' 'Temp folder' "$env:TEMP was not found"
}

$webViewKeys = @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
$webViewVersion = $null
foreach ($key in $webViewKeys) {
    $value = Get-RegValue $key 'pv'
    if ($value) { $webViewVersion = [string]$value; break }
}
if (-not $webViewVersion) {
    foreach ($dir in @(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\EdgeWebView\Application'),
        (Join-Path $env:ProgramFiles 'Microsoft\EdgeWebView\Application')
    )) {
        if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
        $sub = Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
        if ($sub) { $webViewVersion = $sub.Name; break }
    }
}
if ($webViewVersion) {
    Add-Result 'OK' 'WebView2' "Installed: $webViewVersion"
} else {
    Add-Result 'WARN' 'WebView2' 'Microsoft Edge WebView2 Runtime was not found' @() 'LTK Manager uses WebView2 to draw its window. Install the Evergreen WebView2 Runtime from Microsoft, then restart LTK Manager.'
}

if ($isAdmin) {
    Add-Result 'INFO' 'Script access' 'Running as administrator' @('Only needed to remove HKLM entries. Bocchi, League and LTK Manager should still run normally.')
} else {
    Add-Result 'INFO' 'Script access' 'Running as a normal user' @('HKLM compatibility entries can only be removed from an elevated prompt.')
}

# ---------------------------------------------------------------------------
# Internet
# ---------------------------------------------------------------------------

Add-Section 'Internet'

$proxyEnable = Get-RegValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' 'ProxyEnable'
if ($proxyEnable -eq 1) {
    $proxyServer = Get-RegValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' 'ProxyServer'
    Add-Result 'INFO' 'Proxy' "A system proxy is enabled: $proxyServer"
}

$endpoints = @(
    [pscustomobject]@{ Name = 'GitHub'; Url = 'https://github.com' },
    [pscustomobject]@{ Name = 'GitHub API'; Url = 'https://api.github.com' },
    [pscustomobject]@{ Name = 'GitHub raw content'; Url = 'https://raw.githubusercontent.com' },
    [pscustomobject]@{ Name = 'LTK patcher service'; Url = 'https://patcher.leaguetoolkit.dev' }
)

$reachable = @()
$unreachable = @()
foreach ($endpoint in $endpoints) {
    if (Test-HttpEndpoint $endpoint.Url) {
        $reachable += $endpoint.Name
    } else {
        $unreachable += $endpoint.Name
    }
}

if ($unreachable.Count -eq 0) {
    Add-Result 'OK' 'Internet' ('Reached: ' + ($reachable -join ', '))
} elseif ($reachable.Count -eq 0) {
    Add-Result 'FAIL' 'Internet' 'No connection to GitHub or the LTK patcher service' @() 'Check your internet connection, VPN/proxy, DNS and firewall. If GitHub is blocked in your country, use a VPN.'
} else {
    Add-Result 'WARN' 'Internet' ('Could not reach: ' + ($unreachable -join ', ')) @() 'Skins, updates or the LTK patcher download may fail. Check VPN/proxy, DNS and firewall rules.'
}

# ---------------------------------------------------------------------------
# League of Legends
# ---------------------------------------------------------------------------

Add-Section 'League of Legends'

$bocchiSettingsFile = Join-Path $script:BocchiData 'settings.json'
$script:BocchiSettings = Read-JsonFile $bocchiSettingsFile
$savedGamePath = $null
if ($script:BocchiSettings -and $script:BocchiSettings.gamePath) {
    $savedGamePath = [string]$script:BocchiSettings.gamePath
}

if ($script:BocchiSettings -and $script:BocchiSettings.injectionMethod) {
    $script:InjectionMethod = [string]$script:BocchiSettings.injectionMethod
}

$script:League = Find-LeagueGamePath -SettingsGamePath $savedGamePath

if ($script:League) {
    $leagueExe = Join-Path $script:League.GamePath 'League of Legends.exe'
    Add-Result 'OK' 'League install' $script:League.GamePath @("Found via: $($script:League.Source)")

    $leagueVersion = Get-FileVersion $leagueExe
    if ($leagueVersion) { Add-Result 'INFO' 'League version' $leagueVersion }

    if ($savedGamePath -and ((Get-NormalizedPath $savedGamePath) -ne (Get-NormalizedPath $script:League.GamePath))) {
        Add-Result 'WARN' 'Bocchi path' "Bocchi is set to: $savedGamePath" @("League is actually at: $($script:League.GamePath)") 'Open Bocchi > Settings and select the correct League "Game" folder.'
    } else {
        Add-Result 'OK' 'Bocchi path' 'Bocchi points at the detected League folder'
    }

    $pathLength = $script:League.GamePath.Length
    if ($pathLength -gt 128) {
        Add-Result 'WARN' 'League path length' "$pathLength characters" @() 'Move League to a shorter path such as C:\Riot Games\League of Legends. Deep paths can hit the 260-character limit.'
    } else {
        Add-Result 'OK' 'League path length' "$pathLength characters"
    }

    $cloudToken = Test-CloudPath $script:League.GamePath
    if ($cloudToken) {
        Add-Result 'FAIL' 'League location' "The League folder is inside a cloud-synced folder ($cloudToken)" @() 'Move League outside OneDrive/Dropbox/Google Drive. Cloud-only files cannot be reliably overlaid.'
    } else {
        Add-Result 'OK' 'League location' 'Not inside a known cloud-sync folder'
    }

    $offline = Test-OfflineAttribute $leagueExe
    if ($offline) {
        Add-Result 'FAIL' 'League files' "League of Legends.exe has the $offline attribute" @() 'Move League out of OneDrive/Dropbox or turn off Files On-Demand for that folder.'
    }

    $leagueWritable = Test-IsWritable $script:League.GamePath
    if ($leagueWritable -eq $true) {
        Add-Result 'OK' 'League permissions' 'The Game folder is writable'
    } elseif ($leagueWritable -eq $false) {
        Add-Result 'FAIL' 'League permissions' 'The Game folder is not writable' @() 'Run this script as administrator once and check NTFS permissions, or reinstall League. The patcher must write an overlay into the Game folder.'
    }

    $leagueFreeGB = Get-FreeGB $script:League.GamePath
    if ($null -ne $leagueFreeGB) {
        if ($leagueFreeGB -lt 1) {
            Add-Result 'FAIL' 'League disk space' "Only $leagueFreeGB GB free where League is installed" @() 'Free up space. Building the overlay needs temporary disk space.'
        } elseif ($leagueFreeGB -lt 5) {
            Add-Result 'WARN' 'League disk space' "$leagueFreeGB GB free where League is installed" @() 'Consider freeing up space before applying a large skin.'
        } else {
            Add-Result 'OK' 'League disk space' "$leagueFreeGB GB free"
        }
    }
} else {
    Add-Result 'FAIL' 'League install' 'League of Legends was not found' @('Checked Bocchi settings, the Riot Games registry keys and the usual folders.') 'Open Bocchi > Settings and select the League "Game" folder (the one that contains League of Legends.exe), or reinstall League.'
}

# ---------------------------------------------------------------------------
# Compatibility flags and process elevation
# ---------------------------------------------------------------------------

Add-Section 'Elevation and compatibility flags'

$layers = @(Get-CompatLayers)
$leagueRiotRunAs = @()
$leagueRiotOther = @()
$toolRunAs = @()
$toolOther = @()

foreach ($entry in $layers) {
    $isLeagueRiot = $entry.Base -match '^(?i)(League|Riot)'
    $isTool = $entry.Base -match '^(?i)(cslol-|ltk_patcher|ltk-manager|Bocchi)'
    if (-not $isLeagueRiot -and -not $isTool) { continue }

    $hasRunAs = $entry.Layers -match '(?i)\bRUNASADMIN\b'

    if ($isLeagueRiot) {
        if ($hasRunAs) { $leagueRiotRunAs += $entry } else { $leagueRiotOther += $entry }
    } else {
        if ($hasRunAs) { $toolRunAs += $entry } else { $toolOther += $entry }
    }
}

if ($leagueRiotRunAs.Count -gt 0) {
    $details = @()
    foreach ($entry in $leagueRiotRunAs) {
        $details += "$($entry.Root): $($entry.Exe)  [$($entry.Layers)]"
    }
    Add-Result 'FAIL' 'League elevation' 'League or Riot is set to "Run as administrator"' $details 'This is what causes LEAGUE_ELEVATED. Untick "Run this program as an administrator" in the Compatibility tab of each listed program (for one marked "all users", use "Change settings for all users" first). Then close League, Riot Client, Bocchi and LTK Manager completely and reopen them normally.' -Tag 'RUNASADMIN'
} elseif ($leagueRiotOther.Count -gt 0) {
    $details = @()
    foreach ($entry in $leagueRiotOther) {
        $details += "$($entry.Root): $($entry.Exe)  [$($entry.Layers)]"
    }
    Add-Result 'WARN' 'League elevation' 'Compatibility flags are set on League or Riot' $details 'Right-click the .exe > Properties > Compatibility and uncheck every compatibility option. Any compatibility layer can break injection.'
} else {
    Add-Result 'OK' 'League elevation' 'No "Run as administrator" flag on League or Riot'
}

$ltkRunAs = @($toolRunAs | Where-Object { $_.Base -match '^(?i)(cslol-|ltk_patcher|ltk-manager)' })
$ltkOther = @($toolOther | Where-Object { $_.Base -match '^(?i)(cslol-|ltk_patcher|ltk-manager)' })
$bocchiRunAs = @($toolRunAs | Where-Object { $_.Base -match '^(?i)Bocchi' })
$bocchiOther = @($toolOther | Where-Object { $_.Base -match '^(?i)Bocchi' })

if ($ltkRunAs.Count -gt 0) {
    $details = @()
    foreach ($entry in $ltkRunAs) {
        $details += "$($entry.Root): $($entry.Exe)  [$($entry.Layers)]"
    }
    Add-Result 'FAIL' 'LTK elevation' 'An LTK or cslol binary is set to "Run as administrator"' $details 'LTK Manager and its patcher must start normally. Remove the RUNASADMIN flag and reopen LTK Manager without "Run as administrator".' -Tag 'RUNASADMIN'
} elseif ($ltkOther.Count -gt 0) {
    $details = @()
    foreach ($entry in $ltkOther) {
        $details += "$($entry.Root): $($entry.Exe)  [$($entry.Layers)]"
    }
    Add-Result 'WARN' 'LTK elevation' 'Compatibility flags are set on an LTK or cslol binary' $details 'Uncheck every compatibility option on these executables.'
} else {
    Add-Result 'OK' 'LTK elevation' 'No "Run as administrator" flag on LTK or cslol binaries'
}

if ($bocchiRunAs.Count -gt 0) {
    $details = @()
    foreach ($entry in $bocchiRunAs) {
        $details += "$($entry.Root): $($entry.Exe)  [$($entry.Layers)]"
    }
    Add-Result 'WARN' 'Bocchi elevation' 'Bocchi is set to "Run as administrator"' $details 'Bocchi should run normally. Remove the RUNASADMIN flag and start it from the Start Menu without "Run as administrator".' -Tag 'RUNASADMIN'
} elseif ($bocchiOther.Count -gt 0) {
    $details = @()
    foreach ($entry in $bocchiOther) {
        $details += "$($entry.Root): $($entry.Exe)  [$($entry.Layers)]"
    }
    Add-Result 'WARN' 'Bocchi elevation' 'Compatibility flags are set on Bocchi' $details 'Right-click Bocchi.exe > Properties > Compatibility and uncheck every compatibility option.'
}

Add-ProcessCheck -Area 'League process' -Label 'League/Riot' -Names @(
    'League of Legends',
    'LeagueClient',
    'LeagueClientUx',
    'LeagueClientUxRender',
    'RiotClientServices',
    'RiotClientUx',
    'RiotClientUxRender',
    'RiotClientCrashHandler'
) -ElevatedStatus 'FAIL' -ElevatedFix 'Close League and Riot Client completely (tray icon > Exit), then start them normally. If they still elevate, untick "Run this program as an administrator" in the Compatibility tab of RiotClientServices.exe, LeagueClient.exe and League of Legends.exe (also under "Change settings for all users").'

Add-ProcessCheck -Area 'LTK process' -Label 'LTK Manager' -Names @('ltk-manager') -ElevatedStatus 'FAIL' -ElevatedFix 'Close LTK Manager and open it normally. If it keeps elevating, remove RUNASADMIN from ltk-manager.exe and check its shortcut for "Run as administrator".'

Add-ProcessCheck -Area 'LTK process' -Label 'LTK patcher host' -Names @('ltk_patcher_host') -ElevatedStatus 'WARN' -ElevatedFix 'Stop the patcher, close Bocchi and LTK Manager, then reopen Bocchi normally. The patcher host should not inherit administrator rights.'

Add-ProcessCheck -Area 'Bocchi process' -Label 'Bocchi' -Names @('Bocchi') -ElevatedStatus 'WARN' -ElevatedFix 'Close Bocchi and start it from the Start Menu without "Run as administrator". An elevated Bocchi cannot work with a normal League.'

Add-ProcessCheck -Area 'cslol process' -Label 'mod-tools' -Names @('mod-tools') -ElevatedStatus 'WARN' -ElevatedFix 'Close Bocchi, end mod-tools.exe in Task Manager, then reopen Bocchi normally.'

$ltkManagerProcs = @(Get-RunningProcesses @('ltk-manager'))
$ltkHostProcs = @(Get-RunningProcesses @('ltk_patcher_host'))
if ($ltkHostProcs.Count -gt 0 -and $ltkManagerProcs.Count -eq 0) {
    Add-Result 'WARN' 'LTK process' 'ltk_patcher_host is running without LTK Manager' @() 'End ltk_patcher_host.exe in Task Manager, then reopen Bocchi or LTK Manager normally.'
}

$bocchiProcs = @(Get-RunningProcesses @('Bocchi'))
$modToolsProcs = @(Get-RunningProcesses @('mod-tools'))
if ($modToolsProcs.Count -gt 0 -and $bocchiProcs.Count -eq 0) {
    Add-Result 'WARN' 'cslol process' 'mod-tools is running without Bocchi' @() 'End mod-tools.exe in Task Manager, then reopen Bocchi normally.'
}

# A leftover LTK Manager (or its patcher) while Bocchi is closed blocks the
# next Apply with "Close the existing Manager/patcher/game before Apply".
if (($ltkManagerProcs.Count -gt 0 -or $ltkHostProcs.Count -gt 0) -and $bocchiProcs.Count -eq 0) {
    $lingering = @()
    foreach ($proc in @($ltkManagerProcs + $ltkHostProcs)) {
        $lingering += ("{0} (PID {1})" -f $proc.ProcessName, $proc.Id)
    }
    Add-Result 'WARN' 'LTK process' 'LTK Manager or its patcher is still running while Bocchi is closed' $lingering 'This leftover instance makes the next Apply fail with "Close the existing Manager/patcher/game before Apply". Open Task Manager (Ctrl+Shift+Esc), go to the Details tab, end ltk-manager.exe and ltk_patcher_host.exe, then reopen Bocchi. Next time close Bocchi with "Quit Bocchi" from the tray so it stops LTK Manager itself.'
}

# ---------------------------------------------------------------------------
# Bocchi
# ---------------------------------------------------------------------------

Add-Section 'Bocchi'

$bocchiExes = @()
foreach ($candidate in @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Bocchi\Bocchi.exe'),
    (Join-Path $env:ProgramFiles 'Bocchi\Bocchi.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Bocchi\Bocchi.exe')
)) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { $bocchiExes += $candidate }
}

if ($bocchiExes.Count -gt 0) {
    foreach ($exe in $bocchiExes) {
        $version = Get-FileVersion $exe
        Add-Result 'OK' 'Bocchi install' $exe @("Version: $version")
    }
} else {
    Add-Result 'WARN' 'Bocchi install' 'Bocchi was not found in the default install folders' @('Portable or development copies are fine; ignore this if Bocchi starts normally.')
}

if (Test-Path -LiteralPath $script:BocchiData) {
    Add-Result 'OK' 'Bocchi data' $script:BocchiData
    $bocchiWritable = Test-IsWritable $script:BocchiData
    if ($bocchiWritable -eq $false) {
        Add-Result 'FAIL' 'Bocchi data' 'Bocchi cannot write to its app data folder' @() 'Fix permissions on %APPDATA%\bocchi or run Bocchi once as the same Windows user who installed it.'
    }
} else {
    Add-Result 'WARN' 'Bocchi data' 'Bocchi has not created its app data folder yet' @('Start Bocchi once, then run this script again.')
}

if ($script:BocchiSettings) {
    Add-Result 'INFO' 'Injection method' $script:InjectionMethod
} else {
    Add-Result 'WARN' 'Bocchi settings' 'settings.json was not found or could not be read' @('Start Bocchi once so it can create its settings, then run this script again.')
}

# Recent errors from Bocchi's in-app Troubleshooting panel. The app mirrors
# them next to settings.json whenever the history changes.
$appErrorsFile = Join-Path $script:BocchiData 'troubleshooting.json'
if (Test-Path -LiteralPath $appErrorsFile) {
    try {
        $appHistory = Get-Content -LiteralPath $appErrorsFile -Raw -ErrorAction Stop | ConvertFrom-Json
        $appErrors = @($appHistory.entries | Where-Object { $_ })
        if ($appErrors.Count -eq 0) {
            Add-Result 'OK' 'App error history' 'Bocchi has no recorded patcher errors'
        } else {
            $appErrors = @($appErrors | Sort-Object { [int64]$_.at } -Descending)
            $latest = $appErrors[0]
            $latestTime = ''
            $ageDays = 999
            try {
                $latestDate = [datetimeoffset]::FromUnixTimeMilliseconds([int64]$latest.at).LocalDateTime
                $latestTime = $latestDate.ToString('yyyy-MM-dd HH:mm')
                $ageDays = ((Get-Date) - $latestDate).TotalDays
            } catch {}

            $appDetails = @("History file: $appErrorsFile")
            foreach ($appError in @($appErrors | Select-Object -First 5)) {
                $when = ''
                try { $when = [datetimeoffset]::FromUnixTimeMilliseconds([int64]$appError.at).LocalDateTime.ToString('yyyy-MM-dd HH:mm') } catch {}
                $message = [string]$appError.message
                if ($message.Length -gt 160) { $message = $message.Substring(0, 157) + '...' }
                $appDetails += ("{0} x{1} {2} - {3}" -f [string]$appError.code, [int]$appError.count, $when, $message)
            }

            $appStatus = if ($ageDays -le 7) { 'WARN' } else { 'INFO' }
            Add-Result $appStatus 'App error history' ("Bocchi recorded $($appErrors.Count) patcher error(s); the latest is $($latest.code) from $latestTime") $appDetails 'Open Bocchi > Settings > Troubleshooting to read what each error means and its fix. Use the matching finding in this report to fix the PC cause.'
            $script:AppBridgeNotRunning = @($appErrors | Where-Object { [string]$_.code -eq 'BRIDGE_NOT_RUNNING' }).Count -gt 0
            $script:AppVcRedistMissing = @($appErrors | Where-Object { [string]$_.code -eq 'VC_REDIST_MISSING' }).Count -gt 0
        }
    } catch {
        Add-Result 'INFO' 'App error history' 'troubleshooting.json exists but could not be read'
    }
}

if ($script:InjectionMethod -eq 'ltk') {
    $bridgeManager = Join-Path $script:BridgeRoot 'app\ltk-manager.exe'
    $bridgePatcher = Join-Path $script:BridgeRoot 'app\ltk_patcher_host.exe'
    $bridgeManifest = Join-Path $script:BridgeRoot 'app\bocchi-install.json'
    $bridgeLibrary = Join-Path $script:BridgeRoot 'libraries\persistent'

    if (Test-Path -LiteralPath $script:BridgeRoot) {
        Add-Result 'OK' 'LTK bridge' $script:BridgeRoot
    } else {
        Add-Result 'WARN' 'LTK bridge' 'Bocchi has not prepared its private LTK Manager copy yet' @() 'Open Bocchi, select a skin and click Apply once. Bocchi will copy the installed LTK Manager into its own app data folder.'
    }

    if (Test-Path -LiteralPath $bridgeManager) {
        Add-Result 'OK' 'Bridge manager' $bridgeManager
    } else {
        Add-Result 'WARN' 'Bridge manager' 'Bocchi has no private ltk-manager.exe' @() 'Install LTK Manager, then open Bocchi and click Apply once so it can copy the files.'
    }

    if (Test-Path -LiteralPath $bridgePatcher) {
        Add-Result 'OK' 'Bridge patcher' $bridgePatcher
    } else {
        Add-Result 'WARN' 'Bridge patcher' 'Bocchi has no private ltk_patcher_host.exe' @() 'Reinstall LTK Manager v1.33.0, then open Bocchi and click Apply once.'
    }

    foreach ($signedFile in @($bridgeManager, $bridgePatcher)) {
        if (-not (Test-Path -LiteralPath $signedFile)) { continue }
        $signature = Get-AuthenticodeStatus $signedFile
        if (-not $signature) { continue }
        if ($signature.Status -eq 'Valid') {
            $signerText = if ($signature.Signer) { " ($($signature.Signer))" } else { '' }
            Add-Result 'OK' 'Bridge signature' "$(Get-BaseName $signedFile) has a valid signature$signerText"
        } else {
            Add-Result 'FAIL' 'Bridge signature' "$(Get-BaseName $signedFile) has an invalid signature ($($signature.Status))" @("File: $signedFile") 'An antivirus or another program may have modified the private copy. Delete %APPDATA%\bocchi\official-ltk-bridge\app, then open Bocchi and click Apply once.'
        }
    }

    if (Test-Path -LiteralPath $bridgeManifest) {
        Add-Result 'OK' 'Bridge manifest' 'bocchi-install.json is present'
    } else {
        Add-Result 'WARN' 'Bridge manifest' 'Bocchi has no install manifest for its private LTK copy' @() 'Delete the folder %APPDATA%\bocchi\official-ltk-bridge\app, then open Bocchi and click Apply once.'
    }

    if ((Test-Path -LiteralPath $bridgeManager) -and (Test-Path -LiteralPath $bridgeManifest)) {
        $bridgeManifestData = Read-JsonFile $bridgeManifest
        if ($bridgeManifestData -and $bridgeManifestData.managerSha256) {
            try {
                $actualHash = (Get-FileHash -LiteralPath $bridgeManager -Algorithm SHA256 -ErrorAction Stop).Hash
                if ($actualHash.ToLowerInvariant() -eq ([string]$bridgeManifestData.managerSha256).ToLowerInvariant()) {
                    Add-Result 'OK' 'Bridge integrity' 'The private ltk-manager.exe matches its manifest'
                } else {
                    Add-Result 'WARN' 'Bridge integrity' 'The private ltk-manager.exe does not match its manifest' @() 'Antivirus may have changed the file. Delete %APPDATA%\bocchi\official-ltk-bridge\app, then open Bocchi and click Apply once.'
                }
            } catch {
                Add-Result 'INFO' 'Bridge integrity' 'Could not hash the private ltk-manager.exe'
            }
        }
    }

    $bridgeApp = Join-Path $script:BridgeRoot 'app'
    if (Test-Path -LiteralPath $bridgeApp) {
        $bridgeAppWritable = Test-IsWritable $bridgeApp
        if ($bridgeAppWritable -eq $false) {
            Add-Result 'FAIL' 'Bridge folder' "$bridgeApp is not writable" @() 'Fix permissions on %APPDATA%\bocchi, or delete the folder and let Bocchi recreate it.'
        }
    }

    if (Test-Path -LiteralPath $bridgeLibrary) {
        $libraryWritable = Test-IsWritable $bridgeLibrary
        if ($libraryWritable -eq $true) {
            Add-Result 'OK' 'LTK library' "$bridgeLibrary is writable"
        } elseif ($libraryWritable -eq $false) {
            Add-Result 'FAIL' 'LTK library' "$bridgeLibrary is not writable" @() 'Fix permissions on %APPDATA%\bocchi, or delete the folder and let Bocchi recreate it.'
        }
    } else {
        Add-Result 'WARN' 'LTK library' 'Bocchi has not created its mod library yet' @() 'Open Bocchi and click Apply once.'
    }

    $sessionFile = Join-Path $script:BridgeRoot 'bridge-session.json'
    $runtimeJournal = Join-Path $script:BridgeRoot 'settings.runtime.previous.json'
    $bocchiRunning = @(Get-RunningProcesses @('Bocchi', 'bocchi-ltk-bridge'))
    $sessionExists = Test-Path -LiteralPath $sessionFile
    $journalExists = Test-Path -LiteralPath $runtimeJournal

    if ($sessionExists) {
        $sessionJson = Read-JsonFile $sessionFile
        $supervisorPid = 0
        if ($sessionJson -and $sessionJson.supervisorPid) { $supervisorPid = [int]$sessionJson.supervisorPid }

        $supervisorAlive = $false
        if ($supervisorPid -gt 0) {
            $supervisorAlive = $null -ne (Get-Process -Id $supervisorPid -ErrorAction SilentlyContinue)
        }

        if ($bocchiRunning.Count -gt 0 -or $supervisorAlive) {
            Add-Result 'INFO' 'LTK session' 'An LTK settings session is currently active' @("File: $sessionFile")
        } else {
            Add-Result 'WARN' 'LTK session' 'A previous LTK settings session was not cleaned up' @("File: $sessionFile") 'Close Bocchi, LTK Manager and League, then start Bocchi again. It will try to restore the previous LTK settings. If recovery fails, delete bridge-session.json and start Bocchi again.'
        }
    }

    if ($journalExists -and -not $sessionExists) {
        Add-Result 'FAIL' 'LTK session' 'Orphaned LTK settings journal found' @("File: $runtimeJournal", 'Without a matching bridge-session.json, Bocchi refuses to recover it.') 'Close Bocchi, LTK Manager and League. Rename settings.runtime.previous.json to settings.runtime.previous.bad, then start Bocchi again. If LTK settings look wrong afterwards, set the League path and mod storage again in LTK Manager.'
    }
} elseif ($script:InjectionMethod -eq 'cslol') {
    $toolsPath = $null
    if ($script:BocchiSettings -and $script:BocchiSettings.modToolsPath) {
        $toolsPath = [string]$script:BocchiSettings.modToolsPath
    } else {
        $toolsPath = Join-Path $script:BocchiData 'cslol-tools'
    }

    $modTools = Join-Path $toolsPath 'mod-tools.exe'
    $cslolDll = Join-Path $toolsPath 'cslol-dll.dll'

    if (Test-Path -LiteralPath $toolsPath) {
        $toolsWritable = Test-IsWritable $toolsPath
        if ($toolsWritable -eq $false) {
            Add-Result 'FAIL' 'cslol tools' "$toolsPath is not writable" @() 'Fix permissions on the cslol-tools folder, or choose a different folder in Bocchi > Settings.'
        }
    }

    if (Test-Path -LiteralPath $modTools) {
        Add-Result 'OK' 'cslol tools' $modTools
    } else {
        Add-Result 'FAIL' 'cslol tools' "mod-tools.exe was not found in $toolsPath" @() 'Open Bocchi > Settings and download cslol-tools, or switch the injection method to LTK.'
    }

    if (Test-Path -LiteralPath $cslolDll) {
        Add-Result 'OK' 'cslol DLL' $cslolDll
    } else {
        Add-Result 'FAIL' 'cslol DLL' "cslol-dll.dll was not found in $toolsPath" @() 'Put cslol-dll.dll in the cslol-tools folder, or switch the injection method to LTK.'
    }
}

# ---------------------------------------------------------------------------
# LTK Manager
# ---------------------------------------------------------------------------

Add-Section 'LTK Manager'

$ltkInstalls = @(Get-LtkInstalls)

if ($ltkInstalls.Count -eq 0) {
    if ($script:InjectionMethod -eq 'cslol') {
        Add-Result 'INFO' 'LTK install' 'LTK Manager is not installed' @('Bocchi is using the cslol injection method, so this is fine.')
    } else {
        Add-Result 'FAIL' 'LTK install' 'LTK Manager is not installed' @() 'Download LTK Manager v1.33.0 from https://github.com/LeagueToolkit/ltk-manager/releases/tag/v1.33.0, install it, then open Bocchi and click Apply once.'
    }
} else {
    foreach ($install in $ltkInstalls) {
        $versionText = $install.Version
        if (-not $versionText) { $versionText = Get-FileVersion $install.Manager }

        if (Test-Path -LiteralPath $install.Manager) {
            Add-Result 'OK' 'LTK install' $install.InstallDir @("Version: $versionText", "Found via: $($install.Source)")
        } else {
            Add-Result 'FAIL' 'LTK install' "LTK Manager is incomplete at $($install.InstallDir)" @('ltk-manager.exe is missing.') 'Reinstall LTK Manager v1.33.0.'
        }

        if (Test-Path -LiteralPath $install.Patcher) {
            Add-Result 'OK' 'LTK patcher' $install.Patcher
        } else {
            Add-Result 'FAIL' 'LTK patcher' "ltk_patcher_host.exe is missing at $($install.InstallDir)" @() 'Reinstall LTK Manager v1.33.0. The patcher host must sit next to ltk-manager.exe.'
        }

        foreach ($signedFile in @($install.Manager, $install.Patcher)) {
            if (-not (Test-Path -LiteralPath $signedFile)) { continue }
            $signature = Get-AuthenticodeStatus $signedFile
            if (-not $signature) { continue }
            if ($signature.Status -eq 'Valid') {
                $signerText = if ($signature.Signer) { " ($($signature.Signer))" } else { '' }
                Add-Result 'OK' 'LTK signature' "$(Get-BaseName $signedFile) has a valid signature$signerText"
            } else {
                Add-Result 'FAIL' 'LTK signature' "$(Get-BaseName $signedFile) has an invalid signature ($($signature.Status))" @("File: $signedFile") 'An antivirus or another program may have modified the file. Reinstall LTK Manager v1.33.0 from its official release, then add its folder to your antivirus exclusions.'
            }
        }

        if (Test-Path -LiteralPath $install.Manager) {
            $managerHash = Get-Sha256 $install.Manager
            if ($managerHash) {
                if ($script:LtkManagerDigests.ContainsKey($managerHash)) {
                    Add-Result 'OK' 'LTK build' "ltk-manager.exe matches the verified LTK $($script:LtkManagerDigests[$managerHash]) build" @("SHA-256: $managerHash")
                } else {
                    Add-Result 'WARN' 'LTK build' 'ltk-manager.exe is not a build Bocchi has verified' @("SHA-256: $managerHash", "Found via: $($install.Source)") 'It may still work, but it has not been tested. If Apply fails, install the official LTK Manager 1.33.0 from https://github.com/LeagueToolkit/ltk-manager/releases/tag/v1.33.0.'
                }
            }
        }

        if (Test-Path -LiteralPath $install.Patcher) {
            $hostHash = Get-Sha256 $install.Patcher
            if ($hostHash) {
                if ($hostHash -eq $script:LtkHostDigest) {
                    Add-Result 'OK' 'LTK build' 'ltk_patcher_host.exe matches the verified patcher host'
                } else {
                    Add-Result 'WARN' 'LTK build' 'ltk_patcher_host.exe is not the verified patcher host' @("SHA-256: $hostHash") 'An antivirus may have changed it, or this is a different LTK build. Reinstall the official LTK Manager 1.33.0.'
                }
            }
        }
    }

    if (Test-Path -LiteralPath $script:LtkData) {
        $ltkDataWritable = Test-IsWritable $script:LtkData
        if ($ltkDataWritable -eq $false) {
            Add-Result 'FAIL' 'LTK data' 'LTK Manager cannot write to its app data folder' @() 'Fix permissions on %APPDATA%\dev.leaguetoolkit.manager, or run LTK Manager once as the same Windows user who installed it.'
        }
    }

    $ltkSettingsFile = Join-Path $script:LtkData 'settings.json'
    $ltkSettings = Read-JsonFile $ltkSettingsFile

    if ($ltkSettings) {
        Add-Result 'OK' 'LTK settings' $ltkSettingsFile

        if ($ltkSettings.leaguePath) {
            $ltkLeaguePath = [string]$ltkSettings.leaguePath
            if ($script:League) {
                if ((Get-NormalizedPath $ltkLeaguePath) -ne (Get-NormalizedPath $script:League.Root)) {
                    Add-Result 'WARN' 'LTK League path' "LTK Manager points at: $ltkLeaguePath" @("League is actually at: $($script:League.Root)") 'Open LTK Manager > Settings and correct the League installation path.'
                } else {
                    Add-Result 'OK' 'LTK League path' 'LTK Manager points at the detected League folder'
                }
            }
        } else {
            Add-Result 'WARN' 'LTK League path' 'LTK Manager has no League path saved' @() 'Open LTK Manager > Settings and select your League of Legends folder.'
        }

        if ($ltkSettings.builtinMods) {
            $baseSkins = [string]$ltkSettings.builtinMods.baseSkins
            if ($baseSkins -eq 'allChampions') {
                Add-Result 'WARN' 'LTK base skins' 'LTK Manager is set to "Base skins: Every champion"' @() 'Open LTK Manager > Settings > Built-in mods and set Base skins to Off or "Modded champions only". "Every champion" puts every champion archive (about 16 GB) into the overlay, so Apply takes minutes and the game can start before the patcher is ready.'
            } elseif ($baseSkins) {
                Add-Result 'OK' 'LTK base skins' "Base skins scope: $baseSkins"
            }
            $inking = $ltkSettings.builtinMods.characterInking
            if ($inking -and $inking.enabled -eq $true -and ([string]$inking.scope) -eq 'all') {
                Add-Result 'WARN' 'LTK character inking' 'Character inking is enabled for every champion in LTK Manager' @() 'Open LTK Manager > Settings > Built-in mods and turn character inking off, or limit it to the champions you use. Inking every champion slows every build down.'
            }
        }

        if ($null -ne $ltkSettings.autoHealthCheckEnabled) {
            if ($ltkSettings.autoHealthCheckEnabled -eq $true) {
                Add-Result 'INFO' 'LTK mod check' 'LTK Manager will check every mod Bocchi installs on each Apply' @() 'Bocchi turns "Automatically check mods" off on Apply. If it stays on, open LTK Manager > Settings > Library and turn it off: on a hard drive that check can hold the loading screen for minutes.'
            } else {
                Add-Result 'OK' 'LTK mod check' 'Automatic mod check is off'
            }
        }

        if ($ltkSettings.modStoragePath) {
            $storage = [string]$ltkSettings.modStoragePath
            if (-not (Test-Path -LiteralPath $storage)) {
                Add-Result 'WARN' 'LTK storage' "LTK Manager's mod storage does not exist: $storage" @() 'Open LTK Manager > Settings and choose an existing folder for mod storage.'
            } else {
                $storageWritable = Test-IsWritable $storage
                if ($storageWritable -eq $true) {
                    Add-Result 'OK' 'LTK storage' "$storage is writable"
                } elseif ($storageWritable -eq $false) {
                    Add-Result 'FAIL' 'LTK storage' "$storage is not writable" @() 'Choose a different mod storage folder in LTK Manager or fix its permissions.'
                }

                if ($script:League) {
                    $storageNormalized = Get-NormalizedPath $storage
                    $leagueNormalized = Get-NormalizedPath $script:League.Root
                    if ($storageNormalized.StartsWith($leagueNormalized + '\')) {
                        Add-Result 'WARN' 'LTK storage' 'Mod storage is inside the League installation' @() 'Move mod storage to a separate folder in LTK Manager > Settings.'
                    }
                }

                $storageCloud = Test-CloudPath $storage
                if ($storageCloud) {
                    Add-Result 'WARN' 'LTK storage' "Mod storage is inside a cloud-synced folder ($storageCloud)" @() 'Move mod storage to a local-only folder. Cloud-only mods can break the overlay.'
                }

                $storageFreeGB = Get-FreeGB $storage
                if ($null -ne $storageFreeGB) {
                    if ($storageFreeGB -lt 1) {
                        Add-Result 'FAIL' 'LTK disk space' "Only $storageFreeGB GB free where mods are stored" @() 'Free up space or choose another mod storage folder in LTK Manager.'
                    } elseif ($storageFreeGB -lt 5) {
                        Add-Result 'WARN' 'LTK disk space' "$storageFreeGB GB free where mods are stored" @() 'Applying large skins needs temporary disk space.'
                    } else {
                        Add-Result 'OK' 'LTK disk space' "$storageFreeGB GB free"
                    }
                }
            }
        }
    } else {
        Add-Result 'WARN' 'LTK settings' 'LTK Manager settings were not found' @('LTK Manager has not been started yet, or it stores its data elsewhere.') 'Start LTK Manager once, then run this script again.'
    }

    $logFiles = @()
    foreach ($logDir in @(
        (Join-Path $script:LtkData 'logs'),
        (Join-Path $env:LOCALAPPDATA 'dev.leaguetoolkit.manager\logs')
    )) {
        if ($logDir -and (Test-Path -LiteralPath $logDir)) {
            $logFiles += @(Get-ChildItem -LiteralPath $logDir -File -Recurse -ErrorAction SilentlyContinue)
        }
    }
    $publicDir = 'C:\Users\Public'
    if (Test-Path -LiteralPath $publicDir) {
        $logFiles += @(Get-ChildItem -LiteralPath $publicDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '(?i)^ltk.*\.log$' })
    }
    $logFiles = @($logFiles | Sort-Object LastWriteTime -Descending)

    if ($logFiles.Count -eq 0) {
        Add-Result 'INFO' 'LTK log' 'No LTK log files yet' @('LTK Manager creates logs after its first patcher run.')
    } else {
        $logText = ''
        $logNames = @()
        foreach ($logFile in @($logFiles | Select-Object -First 3)) {
            $logNames += $logFile.Name
            try { $logText += ((Get-Content -LiteralPath $logFile.FullName -Tail 300 -ErrorAction Stop) -join "`n") + "`n" } catch {}
        }
        $logLabel = ($logNames -join ', ')

        if ($logText -match '(?i)LEAGUE_ELEVATED(?!\s*=\s*false)') {
            Add-Result 'WARN' 'LTK log' 'The LTK log mentions LEAGUE_ELEVATED' @("Log: $logLabel") 'Fix the League elevation finding above, then close League, Riot Client, Bocchi and LTK Manager completely and restart them normally.'
        } elseif ($logText -match '(?i)MANAGER_ELEVATED(?!\s*=\s*false)') {
            Add-Result 'WARN' 'LTK log' 'The LTK log mentions MANAGER_ELEVATED' @("Log: $logLabel") 'LTK Manager is running elevated. Close it and start it normally; if the Windows shell is elevated, fix the account/UAC finding above.'
        } elseif ($logText -match '(?i)(os error 740|requires elevation)') {
            Add-Result 'FAIL' 'LTK log' 'Windows refused to start an LTK program without administrator rights (error 740)' @("Log: $logLabel") 'ltk-manager.exe or ltk_patcher_host.exe is ticked "Run this program as an administrator". Untick it in Properties > Compatibility (use "Change settings for all users" too), close LTK Manager including its tray icon, then reopen Bocchi and click Apply again.'
        } elseif ($logText -match '(?i)no patcher dll is available' -and $logText -match '(?i)error sending request') {
            Add-Result 'WARN' 'LTK log' "Something blocked LTK Manager's patcher download" @("Log: $logLabel") 'LTK Manager could not reach its delivery service (patcher.leaguetoolkit.dev): a firewall, antivirus, VPN, proxy or DNS blocker on this PC or network stopped it. Allow ltk-manager.exe through Windows Firewall and your antivirus, turn off any VPN, proxy or DNS blocker, then reopen Bocchi and click Apply again.'
        } elseif ($logText -match '(?i)no patcher dll is available') {
            Add-Result 'WARN' 'LTK log' "LTK Manager's delivery service refused its patcher" @("Log: $logLabel") 'Nothing on this PC is broken. Retry in a few minutes, or from another network (turn off a VPN or proxy). If LTK Manager also fails when you run it on its own, report it to LTK Manager''s issue tracker.'
        } elseif ($logText -match '(?i)close the existing (manager|patcher|game)') {
            Add-Result 'WARN' 'LTK log' 'The LTK log says a Manager/patcher/game was still running' @("Log: $logLabel") 'End ltk-manager.exe and ltk_patcher_host.exe in Task Manager (Ctrl+Shift+Esc, Details tab), then reopen Bocchi and click Apply again.'
        } elseif ($logText -match '(?i)(ltk_patcher_host[^\n]*(missing|not found)|host[_ ]missing)') {
            Add-Result 'FAIL' 'LTK log' 'The LTK log says its patcher host is missing' @("Log: $logLabel") 'An antivirus likely removed ltk_patcher_host.exe. Reinstall LTK Manager v1.33.0 and add its folder to your antivirus exclusions.'
        } elseif ($logText -match '(?i)(invalid signature|signature (check )?failed|not signed|untrusted)') {
            Add-Result 'FAIL' 'LTK log' 'The LTK log reports a signature failure' @("Log: $logLabel") 'A patcher file was modified or damaged. Reinstall LTK Manager v1.33.0 from its official release and add it to your antivirus exclusions.'
        } elseif ($logText -match '(?i)(unknown command|unsupported command|outdated|too old)') {
            Add-Result 'WARN' 'LTK log' 'The LTK log reports an outdated LTK Manager' @("Log: $logLabel") 'Update LTK Manager to v1.33.0 or newer, then open Bocchi and click Apply once.'
        } elseif ($logText -match '(?i)not allowed by ACL|command plugin:library') {
            Add-Result 'WARN' 'LTK log' 'The LTK log shows a "not allowed by ACL" refusal' @("Log: $logLabel") 'An LTK Manager older than v1.24.1 cannot answer the mod-library commands Bocchi needs. Update or reinstall LTK Manager v1.33.0, then open Bocchi and click Apply again.'
        } elseif ($logText -match '(?i)(access is denied|permission denied|refused)') {
            Add-Result 'INFO' 'LTK log' "Recent access messages in $logLabel" @() 'If patching also fails, check antivirus and Controlled Folder Access.'
        } else {
            Add-Result 'OK' 'LTK log' "No known errors in $logLabel"
        }
    }

    $bridgeEvents = Join-Path $script:BridgeRoot 'libraries\persistent\bocchi-bridge-events.jsonl'
    if (Test-Path -LiteralPath $bridgeEvents) {
        $badEvents = @()
        try {
            $badEvents = @(Get-Content -LiteralPath $bridgeEvents -Tail 400 -ErrorAction Stop | Where-Object {
                $_ -match '(?i)"event"\s*:\s*"[^"]*(error|fail|crash|abort|timeout|killed|denied)[^"]*"'
            } | Select-Object -Last 5)
        } catch {}
        if ($badEvents.Count -gt 0) {
            Add-Result 'WARN' 'Bridge log' 'Recent Bocchi bridge events report a failure' $badEvents "Log: $bridgeEvents"
        } else {
            Add-Result 'OK' 'Bridge log' 'No recent bridge failures before this run'
        }
    }
}

# ---------------------------------------------------------------------------
# Other known blockers
# ---------------------------------------------------------------------------

Add-Section 'Other'

# LTK Manager and Bocchi's bridge helper are MSVC binaries. Without the
# Microsoft Visual C++ 2015-2022 runtime they fail to load with exit code
# 0xC0000135 (3221225781), and Windows shows "MSVCP140.dll was not found".
$runtimeMissing = @()
foreach ($runtimeDll in @('MSVCP140.dll', 'VCRUNTIME140.dll')) {
    $runtimeFound = $false
    foreach ($sysDir in @((Join-Path $env:WINDIR 'System32'), (Join-Path $env:WINDIR 'Sysnative'))) {
        if (Test-Path -LiteralPath (Join-Path $sysDir $runtimeDll)) { $runtimeFound = $true; break }
    }
    if (-not $runtimeFound) { $runtimeMissing += $runtimeDll }
}
if ($runtimeMissing.Count -gt 0) {
    Add-Result 'FAIL' 'Visual C++ runtime' ("Missing: " + ($runtimeMissing -join ', ')) @("LTK Manager and Bocchi's bridge helper cannot start without the Microsoft Visual C++ 2015-2022 runtime.") 'Install the Microsoft Visual C++ Redistributable (x64) from https://aka.ms/vs/17/release/vc_redist.x64.exe, then restart the PC and open Bocchi again.'
} else {
    Add-Result 'OK' 'Visual C++ runtime' 'The Microsoft Visual C++ 2015-2022 runtime is installed'
}

$vgk = Get-Service -Name 'vgk' -ErrorAction SilentlyContinue
$vgc = Get-Service -Name 'vgc' -ErrorAction SilentlyContinue

if ($vgk -and $vgk.Status -eq 'Running') {
    $vanguardDetail = 'Vanguard kernel driver (vgk) is running.'
    if ($vgc) { $vanguardDetail += " User-mode service (vgc): $($vgc.Status)." }
    Add-Result 'OK' 'Vanguard' $vanguardDetail
} elseif ($vgc -and $vgc.Status -eq 'Running') {
    Add-Result 'OK' 'Vanguard' 'Vanguard service is running'
} elseif ($vgk -or $vgc) {
    Add-Result 'WARN' 'Vanguard' 'Vanguard is installed but not running' @() 'Start Riot Vanguard and reboot. Do not disable Vanguard to fix injection.'
} else {
    Add-Result 'INFO' 'Vanguard' 'Vanguard service not found'
}

$ifeoEntries = @(Get-IfeoDebuggers)
# Pengu Loader uses an IFEO debugger entry for the League client. That is a
# client-side plugin hook, unrelated to the patcher, so it is not a failure.
$clientHooks = @($ifeoEntries | Where-Object { $_.Exe -match '^(?i)LeagueClient' -and $_.Debugger -match '(?i)Pengu|core\.dll' })
$ifeoEntries = @($ifeoEntries | Where-Object { -not ($_.Exe -match '^(?i)LeagueClient' -and $_.Debugger -match '(?i)Pengu|core\.dll') })

if ($clientHooks.Count -gt 0) {
    Add-Result 'INFO' 'Client hook' 'Pengu Loader is attached to the League client' @('This is a client-side plugin hook and does not affect the game patcher.')
}

if ($ifeoEntries.Count -gt 0) {
    $details = @()
    foreach ($entry in $ifeoEntries) {
        $details += "$($entry.Root): $($entry.Exe) -> $($entry.Debugger)"
    }
    Add-Result 'FAIL' 'Image hijack' 'A debugger is attached to a League or patcher executable' $details 'Remove the Debugger value under HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\<exe>. This is usually left by an antivirus, a debugger or malware; fix or remove the program that created it.'
} else {
    Add-Result 'OK' 'Image hijack' 'No debugger is attached to League of Legends, LTK or Bocchi executables'
}

$cfa = Get-RegValue 'HKLM:\SOFTWARE\Microsoft\Windows Defender\Windows Defender Exploit Guard\Controlled Folder Access' 'EnableControlledFolderAccess'
if ($cfa -eq 1 -or $cfa -eq 2) {
    Add-Result 'WARN' 'Windows Defender' 'Controlled Folder Access is enabled' @() 'It can block Bocchi or LTK Manager from writing mods. Add them under Windows Security > Virus & threat protection > Ransomware protection > Allow an app through Controlled folder access.'
} else {
    Add-Result 'OK' 'Windows Defender' 'Controlled Folder Access is not blocking writes'
}

# Rose support has found 360/Qihoo silently blocking patcher files. Listing the
# registered products makes other silent blockers visible without blaming them.
$avProducts = @(Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName AntiVirusProduct -ErrorAction SilentlyContinue)
if ($avProducts.Count -gt 0) {
    $avNames = @($avProducts | ForEach-Object { [string]$_.displayName } | Where-Object { $_ })
    if ($avNames.Count -gt 0) {
        Add-Result 'INFO' 'Antivirus' ('Registered: ' + ($avNames -join ', '))
        $knownBlockers = @($avNames | Where-Object { $_ -match '(?i)\b360\b|Qihoo' })
        if ($knownBlockers.Count -gt 0) {
            Add-Result 'WARN' 'Antivirus' '360 Total Security / Qihoo is installed' @() 'It is known to block patcher files silently. Check its quarantine and protection history for Bocchi, ltk-manager.exe and ltk_patcher_host.exe, then restore them or replace 360 with Windows Defender.'
        }
    }
} else {
    Add-Result 'INFO' 'Antivirus' 'No antivirus product is registered with Windows Security Center'
}

# ---------------------------------------------------------------------------
# Optional fixes
# ---------------------------------------------------------------------------

if ($Fix) {
    Add-Section 'Fixes'

    $targets = @()
    $targets += $leagueRiotRunAs
    $targets += $ltkRunAs
    $targets += $bocchiRunAs

    if ($targets.Count -eq 0) {
        Add-Result 'INFO' 'Fix' 'No RUNASADMIN compatibility entries found; nothing to remove'
    } else {
        Write-Host ''
        Write-Host 'RUNASADMIN entries to remove:' -ForegroundColor Yellow
        foreach ($target in $targets) {
            Write-Host ("  [$($target.Root)] $($target.Exe)")
            Write-Host ("      current value: $($target.Layers)") -ForegroundColor DarkGray
        }

        $proceed = $true
        if (-not $Yes) {
            $answer = ''
            try { $answer = Read-Host 'Type YES to remove them' } catch {}
            if ($answer.Trim().ToUpperInvariant() -ne 'YES') {
                $proceed = $false
                Add-Result 'INFO' 'Fix' 'Cancelled; nothing was changed'
            }
        }

        if ($proceed) {
            foreach ($target in $targets) {
                try {
                    # Use the .NET registry API so value names with brackets or
                    # wildcard characters are treated literally.
                    if ($target.Key -like 'HKCU:*') {
                        $hive = [Microsoft.Win32.Registry]::CurrentUser
                        $subKey = $target.Key.Substring(5).TrimStart('\')
                    } else {
                        $hive = [Microsoft.Win32.Registry]::LocalMachine
                        $subKey = $target.Key.Substring(5).TrimStart('\')
                    }
                    $registryKey = $hive.OpenSubKey($subKey, $true)
                    if (-not $registryKey) { throw "Cannot open or write to $($target.Key)" }
                    try {
                        $registryKey.DeleteValue($target.Exe, $false)
                    } finally {
                        $registryKey.Close()
                    }
                    Add-Result 'OK' 'Fix' "Removed RUNASADMIN from $($target.Exe)" @("Registry: $($target.Root)")
                } catch {
                    $registryKeyText = $target.Key -replace '^HKCU:\\', 'HKCU\' -replace '^HKLM:\\', 'HKLM\'
                    $command = 'reg delete "' + $registryKeyText + '" /v "' + $target.Exe + '" /f'
                    Add-Result 'FAIL' 'Fix' "Could not remove RUNASADMIN from $($target.Exe)" @([string]$_.Exception.Message) "Open an elevated Command Prompt and run: $command"
                }
            }

            $targetNames = @($targets | ForEach-Object { $_.Exe })
            $remaining = @(Get-CompatLayers | Where-Object { $targetNames -contains $_.Exe -and $_.Layers -match '(?i)\bRUNASADMIN\b' })
            $allGone = $remaining.Count -eq 0
            if ($allGone) {
                Add-Result 'OK' 'Fix' 'All selected RUNASADMIN entries are gone'
            } else {
                Add-Result 'WARN' 'Fix' "$($remaining.Count) RUNASADMIN entries are still present" @() 'Run this script as administrator, or use the reg delete commands shown above.'
            }

            Add-Result 'INFO' 'Fix' 'Close League, Riot Client, Bocchi and LTK Manager completely, then start them normally'

            if ($allGone) {
                $fixedResults = @($script:Results | Where-Object { $_.Tag -eq 'RUNASADMIN' })
                foreach ($fixed in $fixedResults) {
                    if ($fixed.Fix) { [void]$script:SeenFixes.Remove($fixed.Fix) }
                }
                $script:Results = [System.Collections.ArrayList]@($script:Results | Where-Object { $_.Tag -ne 'RUNASADMIN' })
                if ($leagueRiotRunAs.Count -gt 0) { $script:LeagueElevationFixed = $true }
                Write-Host '        Findings above were recorded before the fix; the summary reflects the current state.' -ForegroundColor DarkGray
            }
        }
    }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

$failCount = @($script:Results | Where-Object { $_.Status -eq 'FAIL' }).Count
$warnCount = @($script:Results | Where-Object { $_.Status -eq 'WARN' }).Count
$okCount = @($script:Results | Where-Object { $_.Status -eq 'OK' }).Count
$infoCount = @($script:Results | Where-Object { $_.Status -eq 'INFO' }).Count

Write-Host ''
Write-Host ('=' * 62) -ForegroundColor DarkGray
Write-Host ("Summary: $failCount failed, $warnCount warnings, $okCount passed, $infoCount info") -ForegroundColor $(if ($failCount -gt 0) { 'Red' } elseif ($warnCount -gt 0) { 'Yellow' } else { 'Green' })
Write-Host ('=' * 62) -ForegroundColor DarkGray

$leagueProcessElevated = @($script:Results | Where-Object { $_.Area -eq 'League process' -and $_.Status -eq 'FAIL' }).Count -gt 0
$managerProcessElevated = @($script:Results | Where-Object { $_.Area -eq 'LTK process' -and $_.Status -eq 'FAIL' }).Count -gt 0
$windowsAdminShell = @($script:Results | Where-Object { $_.Area -in @('Windows shell', 'Account', 'User Account Control') -and $_.Status -in @('FAIL', 'WARN') }).Count -gt 0

if ($leagueRiotRunAs.Count -gt 0 -or $leagueProcessElevated) {
    Write-Host ''
    if ($script:LeagueElevationFixed) {
        Write-Host 'LEAGUE_ELEVATED fix applied.' -ForegroundColor Green
        Write-Host '  Close League, Riot Client, Bocchi and LTK Manager completely, then reopen them normally.' -ForegroundColor Green
    } else {
        Write-Host 'DIAGNOSIS: LEAGUE_ELEVATED' -ForegroundColor Red
        if ($leagueRiotRunAs.Count -gt 0) {
            Write-Host '  League or Riot is set to run as administrator in its Compatibility settings.' -ForegroundColor Red
            Write-Host '  Untick "Run this program as an administrator" for each file listed above.' -ForegroundColor Red
        } else {
            Write-Host '  League or Riot is currently running as administrator.' -ForegroundColor Red
            Write-Host '  Close League and Riot Client completely, then start them normally.' -ForegroundColor Red
        }
        Write-Host '  LTK Manager refuses to patch an elevated game.' -ForegroundColor Red
        Write-Host '  After fixing it, fully close League, Riot Client, Bocchi and LTK Manager before reopening them.' -ForegroundColor Red
    }
}

if ($managerProcessElevated -and -not $windowsAdminShell) {
    Write-Host ''
    Write-Host 'DIAGNOSIS: MANAGER_ELEVATED' -ForegroundColor Red
    Write-Host '  LTK Manager is running as administrator.' -ForegroundColor Red
    Write-Host '  Close it and start it normally. Do not use "Run as administrator" on ltk-manager.exe or its shortcut.' -ForegroundColor Red
}

if ($windowsAdminShell) {
    Write-Host ''
    Write-Host 'DIAGNOSIS: WINDOWS_ADMIN_SHELL' -ForegroundColor Red
    Write-Host '  Windows runs every program as administrator on this account.' -ForegroundColor Red
    if ($script:BuiltinAdmin) {
        Write-Host '  This is the built-in Administrator account. Use a regular Windows account for League, Bocchi and LTK Manager.' -ForegroundColor Red
    } elseif ($script:UacDisabled) {
        Write-Host '  User Account Control is off. Turn it back on, then restart the PC.' -ForegroundColor Red
    } else {
        Write-Host '  explorer.exe itself runs elevated. Sign out and sign in normally, or use a regular account.' -ForegroundColor Red
    }
}

$managerBusy = @($script:Results | Where-Object { $_.Area -eq 'LTK process' -and $_.Status -eq 'WARN' -and $_.Title -match 'still running while Bocchi is closed' }).Count -gt 0
if ($managerBusy) {
    Write-Host ''
    Write-Host 'DIAGNOSIS: MANAGER_BUSY' -ForegroundColor Yellow
    Write-Host '  A leftover LTK Manager or patcher is still running while Bocchi is closed.' -ForegroundColor Yellow
    Write-Host '  It makes the next Apply fail with "Close the existing Manager/patcher/game before Apply".' -ForegroundColor Yellow
    Write-Host '  End ltk-manager.exe and ltk_patcher_host.exe in Task Manager (Details tab), then reopen Bocchi.' -ForegroundColor Yellow
    Write-Host '  Close Bocchi with "Quit Bocchi" from the tray next time so it stops LTK Manager itself.' -ForegroundColor Yellow
}

if ($script:AppBridgeNotRunning) {
    Write-Host ''
    Write-Host 'DIAGNOSIS: BRIDGE_NOT_RUNNING' -ForegroundColor Yellow
    Write-Host '  Bocchi recorded that its own bridge helper was not running when it tried to Apply.' -ForegroundColor Yellow
    Write-Host '  The bridge starts on the first Apply, not when Bocchi opens, so this is usually a' -ForegroundColor Yellow
    Write-Host '  leftover state from an earlier failed or cancelled Apply.' -ForegroundColor Yellow
    Write-Host '  Click Apply again in the current Bocchi version (it restarts the bridge automatically).' -ForegroundColor Yellow
    Write-Host '  If it repeats, quit Bocchi from the tray (Quit Bocchi), reopen it, then Apply.' -ForegroundColor Yellow
}

$vcRedistMissing = (@($script:Results | Where-Object { $_.Area -eq 'Visual C++ runtime' -and $_.Status -eq 'FAIL' }).Count -gt 0) -or $script:AppVcRedistMissing
if ($vcRedistMissing) {
    Write-Host ''
    Write-Host 'DIAGNOSIS: VC_REDIST_MISSING' -ForegroundColor Red
    Write-Host '  The Microsoft Visual C++ 2015-2022 runtime is missing on this PC.' -ForegroundColor Red
    Write-Host '  LTK Manager and Bocchi''s bridge helper cannot start without it, which shows as' -ForegroundColor Red
    Write-Host '  "MSVCP140.dll was not found" or Bocchi error 3221225781 (0xC0000135).' -ForegroundColor Red
    Write-Host '  Install it from https://aka.ms/vs/17/release/vc_redist.x64.exe, then restart the PC.' -ForegroundColor Red
    Write-Host '  If LTK Manager still does not open, reinstall LTK Manager v1.33.0 afterwards.' -ForegroundColor Red
}

if ($script:SeenFixes.Count -gt 0) {
    Write-Host ''
    Write-Host 'What to fix:' -ForegroundColor Yellow
    $number = 1
    foreach ($fixText in $script:SeenFixes) {
        Write-Host ("  $number. $fixText")
        $number++
    }
}

if ($failCount -eq 0 -and $warnCount -eq 0) {
    Write-Host ''
    Write-Host 'No problems found. If the patcher still fails, send this output to the Bocchi Discord.' -ForegroundColor Green
}

Write-Host ''
Write-Host 'Discord: https://discord.com/invite/FVxNNhzNcP' -ForegroundColor DarkGray
if (-not $Fix) {
    Write-Host 'Run again with -Fix to remove RUNASADMIN compatibility flags.' -ForegroundColor DarkGray
}
Write-Host ''
