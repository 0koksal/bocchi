# Bocchi — Remote Skin Variants

This file is **remote config** for [Bocchi](https://github.com/0koksal/bocchi). It controls the chroma wheels for special skin variants (forms of exalted/tiered skins like Immortalized Legend, Sahn-Uzal, Revenant Reign, etc.) without needing a new app release.

Bocchi checks this file whenever it refreshes champion data (app start, patch change, or data revision change). Edit the JSON block below and commit — every user picks up the change automatically.

## How it works

- Bocchi fetches the raw version of this file from the `main` branch
- Each champion entry **replaces** the built-in entries for that champion ID (champions not listed keep their built-in variants)
- If this file can't be reached or is invalid, Bocchi falls back to the variants baked into the app, so nothing breaks

## Entry format

| Field | Required | Description |
|---|---|---|
| `championId` | yes | The champion's game ID (e.g. `18` = Tristana, `234` = Viego) |
| `id` | yes | The variant skin ID, matching the file/folder name in the LeagueSkins repo (e.g. `234994`) |
| `name` | yes | Display name shown in the chroma wheel dialog |
| `parentSkinNum` | yes | The skin this variant belongs to: `id − championId × 1000` (e.g. skin `18080` → `80`) |
| `colors` | yes | One or more hex colors, shown as the wheel slice |
| `parentFolderId` | no | Full skin ID of the repo folder that contains the `{id}.png` preview image, only needed if it differs from the parent skin's own ID (e.g. Tristana's 18080 lives at champion level, so use `"parentFolderId": 18080`) |

## Variants

```json
[
  { "championId": 222, "variants": [
    { "id": 222998, "name": "Arcane Fractured Jinx (Form 1)", "parentSkinNum": 60, "colors": ["#00FF00", "#006400"] },
    { "id": 222999, "name": "Arcane Fractured Jinx (Form 2)", "parentSkinNum": 60, "colors": ["#FF00FF", "#4B0082"] }
  ] },
  { "championId": 875, "variants": [
    { "id": 875998, "name": "Radiant Serpent Sett (Form 2)", "parentSkinNum": 66, "colors": ["#04e8f8", "#04e8f8"] },
    { "id": 875999, "name": "Radiant Serpent Sett (Form 3)", "parentSkinNum": 66, "colors": ["#ec2323", "#ec2323"] }
  ] },
  { "championId": 82, "variants": [
    { "id": 82998, "name": "Sahn-Uzal Mordekaiser (Form 2)", "parentSkinNum": 54, "colors": ["#8B0000", "#FF4500"] },
    { "id": 82999, "name": "Sahn-Uzal Mordekaiser (Form 3)", "parentSkinNum": 54, "colors": ["#f39609", "#f39609"] }
  ] },
  { "championId": 25, "variants": [
    { "id": 25999, "name": "Spirit Blossom Morgana (Form 2)", "parentSkinNum": 80, "colors": ["#FF69B4", "#8B008B"] }
  ] },
  { "championId": 145, "variants": [
    { "id": 145999, "name": "Immortalized Legend Kai'Sa (Form 2)", "parentSkinNum": 71, "colors": ["#ff0000", "#FF1493"] }
  ] },
  { "championId": 234, "variants": [
    { "id": 234994, "name": "Revenant Reign Viego (Form 1)", "parentSkinNum": 43, "colors": ["#00FF7F", "#006400"] },
    { "id": 234995, "name": "Revenant Reign Viego (Form 2)", "parentSkinNum": 43, "colors": ["#00CED1", "#008B8B"] },
    { "id": 234996, "name": "Revenant Reign Viego (Form 3)", "parentSkinNum": 43, "colors": ["#9370DB", "#4B0082"] },
    { "id": 234997, "name": "Revenant Reign Viego (Form 4)", "parentSkinNum": 43, "colors": ["#FF4500", "#8B0000"] },
    { "id": 234998, "name": "Revenant Reign Viego (Form 5)", "parentSkinNum": 43, "colors": ["#FFD700", "#B8860B"] },
    { "id": 234999, "name": "Revenant Reign Viego (Form 6)", "parentSkinNum": 43, "colors": ["#FF1493", "#8B008B"] }
  ] },
  { "championId": 18, "variants": [] }
]
```

## Adding a new skin's variants (example: Tristana)

When Rose pushes the Immortalized Legend Tristana variants (3 forms, expected IDs `18081`–`18083` under folder `18080`), add this entry to the JSON array above:

```json
{ "championId": 18, "variants": [
  { "id": 18081, "name": "Immortalized Legend Tristana (Form 2)", "parentSkinNum": 80, "colors": ["#4169E1", "#191970"], "parentFolderId": 18080 },
  { "id": 18082, "name": "Immortalized Legend Tristana (Form 3)", "parentSkinNum": 80, "colors": ["#9370DB", "#4B0082"], "parentFolderId": 18080 },
  { "id": 18083, "name": "Immortalized Legend Tristana (Form 4)", "parentSkinNum": 80, "colors": ["#2E8B57", "#006400"], "parentFolderId": 18080 }
] }
```

(Verify the real IDs and folder layout in the LeagueSkins repo first — adjust `id`/`parentFolderId` to match, and the colors to match the actual forms.)
