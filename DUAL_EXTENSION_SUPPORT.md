# Dual Extension Support (.zip and .fantome)

## Overview
The application now fully supports both `.zip` and `.fantome` file extensions for skin files across all repositories. This ensures compatibility with various skin repositories that may use different file formats.

## Changes Made

### 1. Scripts
#### `scripts/update-skin-directory.js` (NEW)
- Universal skin directory updater
- Fetches file tree from GitHub API
- Filters for both `.zip` and `.fantome` extensions
- Supports custom repositories via CLI args
- Outputs clean path-based format

**Usage:**
```bash
# Default (LeagueSkins repository)
npm run update-skin-directory

# Custom repository
node scripts/update-skin-directory.js --owner=CustomOwner --repo=CustomRepo --branch=main
```

### 2. Core Services

#### `src/main/services/skinDownloader.ts`
**Changes:**
- Line ~1257: Changed `if (chromaFile.endsWith('.zip'))` to `if (/\.(zip|fantome)$/i.test(chromaFile))`
- Line ~1259: Changed `chromaFile.replace(/\.zip$/i, '')` to `chromaFile.replace(/\.(zip|fantome)$/i, '')`
- **Result**: Bulk download now processes both file types for chromas

**Existing features (unchanged):**
- Download fallback: tries both extensions on 404 errors
- URL parsing supports both extensions throughout
- File detection uses `/\.(zip|fantome)$/i` pattern

#### `src/main/services/repositoryDetector.ts`
**Changes:**
- Line ~238: Added `.fantome` check alongside `.zip` for structure detection
- Changed variable name from `zipFiles` to `skinFiles` for clarity
- **Result**: Repository detection works for both ID-based and name-based repos regardless of file extension

#### `src/main/utils/skinNameMatcher.ts`
**Changes:**
- Completely rewrote `parseDirectoryStructure()` function
- Now parses simple path-based format instead of tree visualization
- Uses `/\.(zip|fantome)$/i` pattern to match both extensions
- Handles both name-based (2-level) and ID-based (3-level) structures
- **Result**: Skin matching works with new file format and both extensions

### 3. Configuration

#### `package.json`
**Added:**
```json
"update-skin-directory": "node scripts/update-skin-directory.js"
```

### 4. Documentation

#### `SKIN_DIRECTORY_UPDATE.md` (NEW)
- Comprehensive documentation of changes
- Statistics and verification instructions
- Usage examples

#### `DUAL_EXTENSION_SUPPORT.md` (THIS FILE)
- Technical details of all changes
- Complete file list with line numbers
- Testing guidelines

## File Format Changes

### Old Format (Tree Visualization)
```
Directory structure:
└── skins/
    ├── Aatrox/
    │   ├── chromas/
    │   │   ├── DRX Aatrox/
    │   │   │   └── DRX Aatrox 266032.zip
    │   ├── Aatrox.zip
```

### New Format (Path List)
```
1/1001/1001.fantome
1/1002/1002.fantome
103/103001/103001.fantome
103/103001/103052/103052.fantome
Aatrox/Aatrox.zip
Aatrox/DRX Aatrox.zip
```

**Advantages:**
- ✅ Simpler to parse
- ✅ Smaller file size
- ✅ Easier to generate programmatically
- ✅ Works with both extension types
- ✅ Consistent format regardless of repository structure

## Extension Pattern

Throughout the codebase, we now use:

```typescript
// Correct pattern (supports both)
/\.(zip|fantome)$/i

// Example usage:
if (/\.(zip|fantome)$/i.test(filename)) {
  const skinName = filename.replace(/\.(zip|fantome)$/i, '')
  // Process skin...
}
```

## Testing

### Verify Dual Extension Support

1. **Check skin directory file:**
   ```powershell
   $content = Get-Content "scripts/lol_skins_directory.txt"
   $zip = ($content | Where-Object { $_ -match '\.zip$' }).Count
   $fantome = ($content | Where-Object { $_ -match '\.fantome$' }).Count
   Write-Host "ZIP: $zip, FANTOME: $fantome, Total: $($content.Count)"
   ```

2. **Test with custom repository:**
   ```bash
   # If you have access to a repo using .zip files
   node scripts/update-skin-directory.js --owner=YourOrg --repo=YourRepo
   ```

3. **Verify download fallback:**
   - Try downloading a skin
   - If primary extension fails (404), it should automatically try the alternate extension
   - Check console logs for "Trying fallback" messages

## Backward Compatibility

✅ **Fully backward compatible**
- Existing functionality preserved
- All existing file patterns still work
- No breaking changes to APIs
- Existing cached skins remain functional

## Future Considerations

### Adding Support for New Extensions
If a new skin file format emerges (e.g., `.custom`), update the pattern in:

1. `scripts/update-skin-directory.js` - line ~45
2. All regex patterns: `/\.(zip|fantome|custom)$/i`
3. Repository detector filters
4. Bulk download processors

### Multi-Repository Support
The current implementation supports:
- ✅ Different file extensions per repository
- ✅ Mixed extensions within same repository
- ✅ Custom repository configuration
- ✅ Repository switching at runtime

## Statistics

**LeagueSkins Repository (Current):**
- Total files: 8,944
- Format: 100% `.fantome` (0 `.zip`)
- Chromas: 7,005 (4-level paths)
- Regular skins: 1,939 (3-level paths)

**Code Coverage:**
- ✅ Download service
- ✅ Repository detector
- ✅ Path parser
- ✅ Bulk downloader
- ✅ File import service (already supported both)
- ✅ Main process file handler (already supported both)

## Summary

The application now provides **universal skin file format support** across all features:
- Seamless handling of `.zip` and `.fantome` files
- Automatic fallback between formats
- Repository-agnostic design
- Easy to extend for future formats
