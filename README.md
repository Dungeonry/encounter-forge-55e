# Encounter Forge (D&D 2024) — FoundryVTT module

Build and randomly generate balanced combat encounters for **D&D 5e (2024 rules / "5.5e")** in Foundry VTT, in the spirit of [Kobold+ Fight Club](https://koboldplus.club/#/encounter-builder) and [donjon](https://donjon.bin.sh/5e5/random/#type=encounter), but working on your own compendiums and placing tokens straight onto the scene.

- **Requires:** Foundry VTT v12 or v13, `dnd5e` system 4.0+
- **Open it:** the dragon button in the Actors sidebar, the Token scene controls, `Shift+E`, or a macro: `game.modules.get("encounter-forge-55e").api.open()`

## How balance works

### 2024 DMG rules (as written)
1. Pick a difficulty: **Low**, **Moderate** or **High**.
2. Add up the **XP budget per character** for each character's level (table below). Mixed-level parties are summed per character, so a party of any size is handled.
3. Spend that budget on creatures using each creature's **XP by CR**. **There is no multiplier for creature count** (the 2014 encounter multiplier was removed).

| Level | Low | Moderate | High | | Level | Low | Moderate | High |
|---|---|---|---|---|---|---|---|---|
| 1 | 50 | 75 | 100 | | 11 | 1,900 | 2,900 | 4,100 |
| 2 | 100 | 150 | 200 | | 12 | 2,200 | 3,700 | 4,700 |
| 3 | 150 | 225 | 400 | | 13 | 2,600 | 4,200 | 5,400 |
| 4 | 250 | 375 | 500 | | 14 | 2,900 | 4,900 | 6,200 |
| 5 | 500 | 750 | 1,100 | | 15 | 3,300 | 5,400 | 7,800 |
| 6 | 600 | 1,000 | 1,400 | | 16 | 3,800 | 6,100 | 9,800 |
| 7 | 750 | 1,300 | 1,700 | | 17 | 4,500 | 7,200 | 11,700 |
| 8 | 1,000 | 1,700 | 2,100 | | 18 | 5,000 | 8,700 | 14,200 |
| 9 | 1,300 | 2,000 | 2,600 | | 19 | 5,500 | 10,700 | 17,200 |
| 10 | 1,600 | 2,300 | 3,100 | | 20 | 6,400 | 13,200 | 22,000 |

An encounter is rated by the tier whose budget it fits under. Moderate means it spends more than the Low budget but no more than the Moderate budget.

### Extensions (clearly labelled in the UI)
| Feature | What it does | Default |
|---|---|---|
| **Allies** | Drag an NPC onto the party side. A CR *X* ally adds the budget of a level-*X* character (fractional CRs add that fraction of a level-1 character). Scaled by the **Ally weight** setting. Allies don't take an XP share. | weight 1.0 |
| **Deadly\*** tier | Anything over High, up to 150% of High. The 2024 DMG has no tier above High. | shown |
| **Trivial / Extreme** ratings | Under 50% of Low; over 150% of High. | shown |
| **Action-economy adjustment** | Optional multiplier on effective XP. Lone non-legendary monsters count ×0.75 (or ×0.9 when outnumbered more than 2:1); hordes of more than 1.5 or 2.5 enemies per party member count ×1.1 or ×1.25. | **off** (RAW) |
| **Warnings** | CR above party level (the DMG's caution); fragile level-1 characters; a solo with no legendary actions; more than 2 enemies per party member; low-CR fodder against a high-level party; over High. | always |

## Random generator
Pick a target (Low/Moderate/High/Deadly\*) and an encounter shape: **Solo**, **Boss + minions**, **Elite pair/trio**, **Squad**, **Mixed group**, **Horde**, or **Random** (weighted by difficulty). The generator:
- uses the bestiary filters as its monster pool (CR range, creature type, habitat, 2014/2024 rules);
- caps CR at *party level + N* (default +2, configurable or uncapped);
- can keep everything one creature type, and respects a max creature count;
- aims for 80% of the way into the target tier's XP window, then adjusts the numbers until the result rates at that tier, using **the same evaluator the meter shows** (including allies and the optional action-economy adjustment).

If the filters make the target impossible (e.g. *Solo* with no single creature in the XP window), you get the closest result and a notice.

## Other features
- Party auto-loads from the dnd5e **Primary Party** group, or from player-owned characters if there's none. Add characters by level, set quantities, and edit an ally's CR.
- Bestiary search across any Actor compendiums you choose (gear icon) plus world NPCs. Duplicate statblocks are merged, preferring the 2024 version.
- **Place on scene**: imports monsters into an "Encounter Forge" folder once, places tokens (hidden by default) at the view centre and adds them to the combat tracker.
- **To journal**: writes a journal page with linked creatures, XP total, XP per character and the budget.
- **Save/Load** named encounters (world setting).

## Installing for development
Copy (or symlink) this folder to `{FoundryData}/Data/modules/encounter-forge-55e` and enable it in your world.

```powershell
New-Item -ItemType Junction -Path "$env:LOCALAPPDATA\FoundryVTT\Data\modules\encounter-forge-55e" -Target "E:\FoundryDNDEncounter"
```

## Tests
The rules and generator are pure JS with no Foundry dependency:

```
npm test
```

They cover the DMG budget checkpoints, rating thresholds, ally maths, warnings, and over 2,000 generated encounters across difficulties, party sizes, levels and shapes, all of which must land in the requested tier.

## Layout
```
module.json
scripts/rules.mjs            budgets, CR→XP, rating, warnings (pure)
scripts/generator.mjs        random generation (pure)
scripts/monster-index.mjs    compendium indexing & filtering
scripts/spawn.mjs            token placement, combat, journal export
scripts/app/encounter-builder.mjs   ApplicationV2 UI
scripts/main.mjs             settings, buttons, keybinding, API
templates/*.hbs  styles/*.css  lang/en.json  tests/*.mjs
```
