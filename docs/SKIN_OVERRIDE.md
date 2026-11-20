# Skin Override — show a custom skin over any equipped skin

## The problem

Most skin packages (Sunshine / LeagueSkins `.fantome` files, and many cslol mods) are built by
"rebasing" a skin onto the champion's **base skin**. They ship these files:

```
data/characters/<champ>/skins/skin0.bin
data/characters/<champ>/animations/skin0.bin
data/characters/<champ>helper/skins/skin0.bin        (traps, pets, clones…)
```

The game reads `skin0.bin` only when the **base skin is equipped**. If the player has an owned skin
equipped (skin5, skin12, a chroma…), the game loads `skinN.bin` instead and the mod never shows. The
current workaround is "select the default skin before the game starts".

## What Skin Override does

For every other skin index `N` of the champion, Skin Override creates a copy of each `skin0` bin that has
been re-identified as `skinN`:

| In the bin | `skin0` → `skinN` |
| --- | --- |
| object path hashes `characters/<c>/{skins,animations}/skin0` and `…/skin0/resources` (and every reference to them) | renamed |
| linked bins `data/characters/<c>/{skins,animations}/skin0.bin` | renamed to `skinN.bin` |
| links to the real source skin (e.g. `skin28.bin`), model, textures, sounds | **unchanged** |

The model, textures and audio are not duplicated. The skin the package was rebased from (e.g. `28`) is
skipped, because its real bin is what the `skin0` copy links to (for packages that embed the whole skin
in `skin0.bin` it is read from the animation bin link). Indexes for which the package already ships its
own `skinN.bin` are left alone.

## Cost: nothing is copied (companion mod)

The new bins are **not** written into a copy of the skin. They go into a tiny *companion* mod that holds
only the added bins (same WAD name, e.g. `WAD/Caitlyn.wad.client`, no overlap with the original) and is
applied **next to the untouched original**: `mkoverlay --mods:original/companion`. cslol merges the two.

| 150 MB custom skin | full copy (first version) | companion |
| --- | --- | --- |
| written to disk / imported again by cslol | 151 MB | 0.5 MB |
| time to build (zip STORE / DEFLATE) | 1.4 s / 1.5 s | 0.3 s / 1.2 s |
| peak memory (zip STORE / DEFLATE) | 388 MB / 389 MB | 80 MB / 82 MB |

How the memory stays low: scanning only reads the WAD header, the entry table and the small chunks
that turn out to be PROP bins. STORE-d zip entries and raw wads are read in place with ranged reads;
deflated entries are streamed once and everything that is not a bin (models, textures, audio) is
dropped as it goes by. The result is cached, so this happens once per skin (and again only if the
file changes). The Settings/drawer check (`inspectSkinOverride`) uses the same cheap scan and is memoized.

Raw `.wad` imports have no package to attach a companion to, so they get a standalone copy (`full`
mode). `createSkinOverrideVariant(path, { mode: 'full' })` also produces one standalone package
(original + bins), which is what to hand to another launcher.

No game files and no per-skin data are needed, so it works for **every** package automatically — remote
repository skins, rainbow/chroma packages and user-imported custom skins — and keeps working after game
patches as long as the package itself does.

## How it is wired in

| File | Change |
| --- | --- |
| `src/main/services/skinOverrideService.ts` | **New.** `createSkinOverrideVariant`, `resolveSkinOverridePaths`, `inspectSkinOverride` |
| `src/main/services/modRepairService.ts` | Exports `parseWad`, `WadEntry`, `WAD_COMPRESSION`, `writeStoreZip`, `ZipInputEntry` (were module-private; no behaviour change) |
| `src/main/index.ts` | `run-patcher` and `smart-apply-skins`: when the `skinOverrideMode` setting is on, each resolved skin path becomes `[original, companion]` right before `modToolsWrapper.applyPreset` |
| `src/renderer/src/components/SettingsDialog.tsx` | Skin Override switch (`skinOverrideMode`) in Skin Management |
| `src/renderer/src/locales/en_US/translation.json` | `settings.skinOverrideMode.*` strings (other locales fall back to `en_US`) |

Design notes:

- **Original files are never modified.** Companions live in `userData/skin-override-cache/` and are
  generated at apply time. Turning the setting off simply stops using them.
- **Cache key** = source path + size + mtime + skin list + mode. It is embedded in the file name
  (`Name.sl-<key>.companion.fantome`), so a re-downloaded/updated skin gets a new name and
  `modToolsWrapper` (which caches imports by base name) imports it fresh instead of reusing a stale
  overlay.
- **Skin list** comes from `championDataService` (all skin indexes + chroma indexes `id % 1000`). For
  champions it does not know (e.g. `Custom`) it falls back to indexes 1–99.
- **Non-applicable packages** (no `skin0` bins, e.g. a mod that only swaps textures) are left untouched
  and the original path is used. Failures are logged and also fall back to the original.
- New WAD entries are zstd-compressed with `zstd-napi` (already used by `nativeOverlay.ts`) and kept
  sorted by hash. In `full` mode all original entries are copied byte-for-byte.
- Two selected skins of the same champion (needs *Allow multiple skins per champion*, which already sets
  `--ignoreConflict`) would both define `skinN.bin`; that is the same situation as two mods touching the
  same file today.

## UI

- **Settings -> Skin Management -> Skin Override** (`skinOverrideMode`) turns the feature on. Off by default.
- **Selected skins drawer**: once the switch is on, every skin card shows an **Override** chip (top-left
  of the image). Clicking it sets `SelectedSkin.skinOverride` for that skin only. **Every skin is off by
  default**, so users choose which skins use it.
- At apply time (`run-patcher`, `smart-apply-skins`) a skin is overridden when
  `skinOverrideMode && skin.skinOverride === true`.
- **Non-skin mods**: the chip is only offered for custom mods that `inspectSkinOverride` (IPC
  `check-skin-override`) finds skin0 bins in. Texture/sound/other mods never show it and are always
  applied unchanged.

Ideas not in this PR: run the check in `fileImportService` and show the reason on import, and add the
chip to multi-select mode / P2P room skins.

## Verification

- Re-implemented from a Python prototype; the TypeScript output is **content-identical** (every WAD
  entry decompressed and compared) to the prototype for *Arcane Enforcer Caitlyn* (`skin28`, 244 bins
  added for skins 1–62).
- Ran over 451 real packages from `skins/` and `rainbow/` (Ahri, Jinx, Kayn, Lux, Viego, Yasuo, Caitlyn,
  including chroma/form packages and champions with helper characters such as Jinx's) — all produced
  valid, hash-sorted v3 WADs and the right source skin was detected for each.
- `npm run typecheck` passes; ESLint reports no errors in the new code.

**Not verified:** actually playing a match with an owned skin equipped. The transform is built on how
the game selects `skinN.bin`; please confirm in a practice game (equip an owned skin such as skin5 with
Skin Override on, apply, and check the custom skin shows). Anything that depends on data outside the four bin
types above (e.g. skin-specific VFX bins that are not linked through the skin bin) could still load the
equipped skin's version.
