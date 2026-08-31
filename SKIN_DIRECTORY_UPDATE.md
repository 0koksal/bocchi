# Skin Directory Update - Summary

# Skin Directory Update - Summary

## Issue
The local `lol_skins_directory.txt` file was outdated with only 8524 entries while the LeagueSkins repository contained 9000+ files. Additionally, the application needed to support both `.zip` and `.fantome` file formats for compatibility with different skin repositories.

## What Was Done

### 1. Created Universal Skin Directory Updater Script
- **New script**: `scripts/update-skin-directory.js`
- Fetches the latest file tree from any GitHub skin repository API
- **Supports both `.zip` and `.fantome` file extensions**
- Can be customized for different repositories using command-line options
- Clean, simple path-based format (one file per line)

**Usage:**
```bash
npm run update-skin-directory
# Or with custom repository:
node scripts/update-skin-directory.js --owner=CustomOwner --repo=CustomRepo --branch=main
```

### 2. Updated File Format
Changed from tree-style visualization to simple path list:

**Old format (tree-style):**
```
Directory structure:
└── skins/
    ├── Aatrox/
    │   ├── Aatrox.zip
    │   ├── chromas/
```

**New format (path list):**
```
Aatrox/Aatrox.zip
Aatrox/Justicar Aatrox.zip
103/103001/103001.fantome
103/103001/103052/103052.fantome
```

### 3. Updated Code for Dual Extension Support
Modified several files to properly handle both `.zip` and `.fantome`:

- ✅ `src/main/services/skinDownloader.ts` - Download and processing logic
- ✅ `src/main/services/repositoryDetector.ts` - Repository structure detection
- ✅ `src/main/utils/skinNameMatcher.ts` - Path parsing for new format
- ✅ `scripts/update-skin-directory.js` - Directory generation script

**Pattern used everywhere:** `/\.(zip|fantome)$/i`

### 4. Results
**Current file statistics:**
- **Total entries**: 8,944 skin files (all `.fantome` format for LeagueSkins)
- **Chromas** (4-level paths like `103/103001/103052/103052.fantome`): 7,005
- **Regular skins** (3-level paths like `103/103001/103001.fantome`): 1,939
- **File format compatibility**: Supports both `.zip` and `.fantome` extensions

**File format:**
```
1/1001/1001.fantome
1/1002/1002.fantome
1/1013/1014/1014.fantome  ← chroma (4 levels)
103/103001/103001.fantome
103/103001/103052/103052.fantome  ← chroma (4 levels)
```

### 3. Repository Structure
The LeagueSkins repo uses an **ID-based structure**:
- **Champion ID** / **Skin ID** / **Skin ID**.fantome (regular skins)
- **Champion ID** / **Parent Skin ID** / **Chroma ID** / **Chroma ID**.fantome (chromas)

Example for Ahri (Champion ID: 103):
- Base skin: `103/103001/103001.fantome`
- Dynasty Ahri chroma: `103/103001/103052/103052.fantome`
- Popstar Ahri: `103/103004/103004.fantome`
- Popstar Ahri chroma: `103/103004/103008/103008.fantome`

### 4. Chroma Detection
The existing code in `skinDownloader.ts` already correctly handles:
- ✅ Both `.zip` and `.fantome` file extensions
- ✅ 4-level path structure for chromas
- ✅ ID-to-name resolution using `championDataService`
- ✅ Chroma filtering with `excludeChromas` option

## Verification
Run this command to check the file:
```powershell
$content = Get-Content "scripts/lol_skins_directory.txt"
$total = $content.Count
$chromas = ($content | Where-Object { ($_ -split '/').Count -eq 4 }).Count
Write-Host "Total: $total, Chromas: $chromas, Regular: $($total - $chromas)"
```

Expected output: `Total: 8944, Chromas: 7005, Regular: 1939`

## Next Steps
The application now:
1. ✅ Detects all 8,944 skins from the repository (up from 8,524)
2. ✅ Properly identifies 7,005 chromas
3. ✅ Filters chromas when `excludeChromas: true` is set
4. ✅ Downloads and organizes skins by champion name (resolving numeric IDs)
5. ✅ **Supports both `.zip` and `.fantome` file formats**
6. ✅ **Works with any GitHub skin repository** (configurable via script options)

## For Custom Repositories

If you want to add a custom skin repository that uses `.zip` files:

1. Run the updater script with custom options:
   ```bash
   node scripts/update-skin-directory.js --owner=YourOrg --repo=YourRepo --branch=main
   ```

2. The script will automatically detect and include both `.zip` and `.fantome` files

3. The application will handle both formats seamlessly

## Technical Details

### File Extension Compatibility
The codebase now uses regex pattern `/\.(zip|fantome)$/i` throughout to match both extensions. This ensures:
- Download fallback mechanism (tries both extensions on 404)
- Proper file detection during bulk downloads
- Repository structure detection works for both formats
- Path parsing handles both extensions correctly
