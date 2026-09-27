# Sunshine catalog

The built-in repository is `bettie9/LeagueSkins`. Existing installations using
the built-in Alban default migrate to Sunshine on startup. User-added repository
settings are retained.

Sunshine's `index.json` owns available skins, chromas, form IDs and package names.
Riot metadata supplies localized names, artwork, rarity and champion information.
Forms appear with their published labels in the existing variant picker, sorted
by label rather than by numeric ID. For Tristana this means:

| Selection             | Catalog ID | Package                                                              |
| --------------------- | ---------- | -------------------------------------------------------------------- |
| Risen Legend Tristana | 79         | `skins/Tristana/Risen Legend Tristana.fantome`                       |
| Immortalized - Form 1 | 999        | `skins/Tristana/Risen Legend Tristana/Immortalized - Form 1.fantome` |
| Stage 2               | 80         | `skins/Tristana/Risen Legend Tristana/Stage 2.fantome`               |
| Stage 3               | 998        | `skins/Tristana/Risen Legend Tristana/Stage 3.fantome`               |

These are publisher-owned variant identities, not interchangeable Riot skin
slots. The main package supplies automatic form progression; the three separate
packages select fixed appearances. Catalog IDs must not be reordered to change
display order.

Classic skins use `classic/index.json` and its published `Jade_` paths. Missing
Classic metadata does not invent downloadable Classic packages. The most recent
valid catalog is cached on disk. Subsequent loads refresh after five minutes;
the champion-data refresh button forces a check. An outage keeps the last valid
catalog, while a first launch without a catalog reports an error.

Single and bulk downloads use the same catalog-to-filename mapping. Sunshine
downloads and extracted cslol imports have separate cache directories from older
repositories, preserving existing files without reusing an unrelated package.
Sunshine downloads preserve publisher bytes and do not run the legacy BIN repair
or search unrelated paths after a 404.

Validation:

```sh
npm run test:catalog
npm run typecheck
npm run build
# Optional: checks every published path against one GitHub revision, plus
# downloads the four Tristana packages. Requires internet access.
node scripts/verify-sunshine-catalog.cjs
```

These checks verify catalog, download and build behavior. They do not replace an
in-game test of the Electron app and patcher.
