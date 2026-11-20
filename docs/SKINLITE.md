# SkinLite — show a custom skin over any equipped skin

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

## What SkinLite does

For every other skin index `N` of the champion, SkinLite adds a copy of each `skin0` bin that has been
re-identified as `skinN`:

| In the bin | `skin0` → `skinN` |
| --- | --- |
| object path hashes `characters/<c>/{skins,animations}/skin0` and `…/skin0/resources` (and every reference to them) | renamed |
| linked bins `data/characters/<c>/{skins,animations}/skin0.bin` | renamed to `skinN.bin` |
| links to the real source skin (e.g. `skin28.bin`), model, textures, sounds | **unchanged** |

The model, textures and audio are not duplicated, so a variant is only a few hundred KB larger than the
original. The skin the package was rebased from (e.g. `28`) is skipped, because its real bin is what the
`skin0` copy links to. Indexes for which the package already ships its own `skinN.bin` are left alone.

No game files and no per-skin data are needed, so it works for **every** package automatically — remote
repository skins, rainbow/chroma packages and user-imported custom skins — and keeps working after game
patches as long as the package itself does.

## How it is wired in

| File | Change |
| --- | --- |
| `src/main/services/skinLiteService.ts` | **New.** `createSkinLiteVariant(path, opts)` and `resolveSkinLitePaths(items)` |
| `src/main/services/modRepairService.ts` | Exports `parseWad`, `WadEntry`, `WAD_COMPRESSION`, `writeStoreZip`, `ZipInputEntry` (were module-private; no behaviour change) |
| `src/main/index.ts` | `run-patcher` and `smart-apply-skins`: when the `skinLiteMode` setting is on, resolved skin paths are swapped for their SkinLite variants right before `modToolsWrapper.applyPreset` |
| `src/renderer/src/components/SettingsDialog.tsx` | New toggle bound to the `skinLiteMode` setting |
| `src/renderer/src/locales/en_US/translation.json` | `settings.skinLiteMode.*` strings (other locales fall back to `en_US`) |

Design notes:

- **Original files are never modified.** Variants live in `userData/skinlite-cache/` and are generated at
  apply time. Turning the setting off simply stops using them.
- **Cache key** = source path + size + mtime + skin list. It is embedded in the variant's file name
  (`Name.sl-<key>.fantome`), so a re-downloaded/updated skin gets a new name and `modToolsWrapper` (which
  caches imports by base name) imports it fresh instead of reusing a stale overlay.
- **Skin list** comes from `championDataService` (all skin indexes + chroma indexes `id % 1000`). For
  champions it does not know (e.g. `Custom`) it falls back to indexes 1–99.
- **Non-applicable packages** (no `skin0` bins, e.g. a mod that only swaps textures) are left untouched
  and the original path is used. Failures are logged and also fall back to the original.
- New WAD entries are zstd-compressed with `zstd-napi` (already used by `nativeOverlay.ts`), entries are
  kept sorted by hash, and all original entries are copied byte-for-byte.

## UI

- **Settings -> SkinLite** is the global default (`skinLiteMode`).
- **Selected skins drawer**: every skin card has a small **SkinLite** chip (amber = on, shown on hover
  when off). Clicking it sets a per-skin flag (`SelectedSkin.skinLite`) that overrides the global
  default for that skin only. `undefined` means "follow the global setting".
- **Non-skin mods**: the chip is only offered for custom mods that `inspectSkinLite` (IPC
  `check-skinlite`) finds skin0 bins in. Texture/sound/other mods never show it, and even if the global
  default is on they are applied unchanged.
- Apply time (`run-patcher`, `smart-apply-skins`): `enabled = skin.skinLite ?? skinLiteMode`, passed to
  `resolveSkinLitePaths`.

Further ideas that are not part of this PR:

1. Run it in `fileImportService` after `repairModFile` and surface `report.reason` for imports.
2. Add the chip to the multi-select mode and the P2P room skins list.

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
SkinLite on, apply, and check the custom skin shows). Anything that depends on data outside the four bin
types above (e.g. skin-specific VFX bins that are not linked through the skin bin) could still load the
equipped skin's version.
