# Bocchi — Remote Skin Variants

This file is **remote config** for [Bocchi](https://github.com/0koksal/bocchi), stored in the Bocchi repository at `variants/variants.md`. It controls the chroma wheels for special skin variants (forms of exalted/tiered skins like Immortalized Legend, Sahn-Uzal, Revenant Reign, etc.) without needing a new app release.

Bocchi checks this file whenever it refreshes champion data (app start, patch change, or data revision change). Edit the JSON block below and commit — every user picks up the change automatically.

## How it works

- Bocchi fetches the raw version of this file from this repository (`variants/variants.md` on the `main` branch)
- Each champion entry **replaces** the built-in entries for that champion ID (champions not listed keep their built-in variants)
- If this file can't be reached or is invalid, Bocchi falls back to the variants baked into the app, so nothing breaks

## Entry format

| Field | Required | Description |
|---|---|---|
| `championId` | yes | The champion's game ID (e.g. `18` = Tristana, `21` = Miss Fortune) |
| `id` | yes | The variant skin ID, matching the file/folder name in the LeagueSkins repo (e.g. `234994`) |
| `name` | yes | Display name shown in the chroma wheel dialog |
| `parentSkinNum` | yes | The skin this variant belongs to: `id − championId × 1000` (e.g. skin `18080` → `80`) |
| `colors` | yes | One or more hex colors, shown as the wheel slice |
| `parentFolderId` | no | No longer needed for previews — preview images are served from `variants/{id}.png` in this folder. Kept for backward compatibility. |

**Disabling a champion's variants:** an entry with an empty list removes the chroma wheel entirely for that champion — including the auto-detected "(Variant)" that Bocchi adds on its own for tiered skins. Use this when the auto-entry points at files that don't exist in the repo yet:

```json
{ "championId": 18, "variants": [] }
```

## Preview images

Each variant needs a preview image at `variants/{id}.png` in this folder (transparent model render, same convention as the `{id}.png` files in the `skins/` folders). Bocchi shows it as the chroma wheel preview — e.g. variant `222999` → `variants/222999.png`. If an image is missing, Bocchi falls back to the parent skin's artwork.

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
    { "id": 25999, "name": "Spirit Blossom Morgana (Stage 2)", "parentSkinNum": 80, "colors": ["#FF69B4", "#8B008B"], "previewId": 25999 }
  ] },
  { "championId": 145, "variants": [
    { "id": 145071, "name": "Immortalized Legend Kai'Sa (Stage 2)", "parentSkinNum": 71, "colors": ["#C41E3A", "#FFD700"] },
    { "id": 145999, "name": "Immortalized Legend Kai'Sa (Stage 3)", "parentSkinNum": 71, "colors": ["#ff0000", "#FF1493"] }
  ] },
  { "championId": 21, "variants": [
    { "id": 21997, "name": "Gun Goddess Miss Fortune (Zero Hour)", "parentSkinNum": 16, "colors": ["#191970", "#B0B0B0"] },
    { "id": 21998, "name": "Gun Goddess Miss Fortune (Royal Arms)", "parentSkinNum": 16, "colors": ["#C41E3A", "#FFD700"] },
    { "id": 21999, "name": "Gun Goddess Miss Fortune (Starswarm)", "parentSkinNum": 16, "colors": ["#7DF9FF", "#4B0082"] }
  ] },
  { "championId": 103, "variants": [
    { "id": 103086, "name": "Immortalized Legend Ahri (Stage 2)", "parentSkinNum": 86, "colors": ["#ECF9F8", "#ECF9F8"] },
    { "id": 103087, "name": "Immortalized Legend Ahri (Stage 3)", "parentSkinNum": 86, "colors": ["#FFD700", "#FFFACD"] }
  ] },
  { "championId": 99, "variants": [
    { "id": 997991, "name": "Elementalist Lux (Air)", "parentSkinNum": 7, "colors": ["#E0FFFF", "#B0E0E6"] },
    { "id": 997992, "name": "Elementalist Lux (Dark)", "parentSkinNum": 7, "colors": ["#2F2F4F", "#191970"] },
    { "id": 997993, "name": "Elementalist Lux (Ice)", "parentSkinNum": 7, "colors": ["#ADD8E6", "#87CEEB"] },
    { "id": 997994, "name": "Elementalist Lux (Magma)", "parentSkinNum": 7, "colors": ["#FF4500", "#8B0000"] },
    { "id": 997995, "name": "Elementalist Lux (Mystic)", "parentSkinNum": 7, "colors": ["#9370DB", "#6A0DAD"] },
    { "id": 997996, "name": "Elementalist Lux (Nature)", "parentSkinNum": 7, "colors": ["#32CD32", "#228B22"] },
    { "id": 997997, "name": "Elementalist Lux (Storm)", "parentSkinNum": 7, "colors": ["#778899", "#4682B4"] },
    { "id": 997998, "name": "Elementalist Lux (Water)", "parentSkinNum": 7, "colors": ["#1E90FF", "#0000CD"] },
    { "id": 997999, "name": "Elementalist Lux (Fire)", "parentSkinNum": 7, "colors": ["#FF4500", "#FFD700"] }
  ] },
  { "championId": 147, "variants": [
    { "id": 147002, "name": "K/DA ALL OUT Seraphine (Stage 2)", "parentSkinNum": 1, "colors": ["#FF69B4", "#00CED1"] },
    { "id": 147003, "name": "K/DA ALL OUT Seraphine (Stage 3)", "parentSkinNum": 1, "colors": ["#FFD700", "#FF1493"] }
  ] },
  { "championId": 18, "variants": [
    { "id": 18080, "name": "Immortalized Legend Tristana (Stage 2)", "parentSkinNum": 80, "colors": ["#3CB371", "#228B22"] },
    { "id": 18998, "name": "Immortalized Legend Tristana (Stage 3)", "parentSkinNum": 80, "colors": ["#FFD700", "#FFFACD"] }
  ] },
  { "championId": 234, "variants": [] }
]
```
