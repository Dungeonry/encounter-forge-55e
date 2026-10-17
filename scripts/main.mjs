import { MODULE_ID } from "./constants.mjs";
import * as rules from "./rules.mjs";
import { generateEncounter } from "./generator.mjs";
import { invalidateIndex } from "./monster-index.mjs";
import { EncounterBuilder } from "./app/encounter-builder.mjs";

let app = null;

function openBuilder() {
  if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("FDE.Notify.GMOnly"));
  app ??= new EncounterBuilder();
  app.render({ force: true });
  return app;
}

Hooks.once("init", () => {
  const reg = (key, data) => game.settings.register(MODULE_ID, key, { name: `FDE.Settings.${key}.Name`, hint: `FDE.Settings.${key}.Hint`, ...data });

  reg("defaultDifficulty", {
    scope: "world", config: true, type: String, default: "moderate",
    choices: Object.fromEntries(rules.TARGET_DIFFICULTIES.map(d => [d, `FDE.Difficulty.${d}`]))
  });
  reg("allyWeight", {
    scope: "world", config: true, type: Number, default: 1,
    range: { min: 0, max: 2, step: 0.25 }
  });
  reg("actionEconomy", { scope: "world", config: true, type: Boolean, default: false });
  reg("placeHidden", { scope: "world", config: true, type: Boolean, default: true });
  reg("addToCombat", { scope: "world", config: true, type: Boolean, default: true });
  reg("importFolder", { scope: "world", config: true, type: String, default: "Encounter Forge" });
  reg("includeWorldActors", { scope: "world", config: false, type: Boolean, default: true, onChange: invalidateIndex });
  reg("compendiums", { scope: "world", config: false, type: Array, default: [], onChange: invalidateIndex });
  reg("savedEncounters", { scope: "world", config: false, type: Object, default: {} });

  game.keybindings.register(MODULE_ID, "open", {
    name: "FDE.Keybinding",
    editable: [{ key: "KeyE", modifiers: ["Shift"] }],
    restricted: true,
    onDown: () => { openBuilder(); return true; }
  });

  // Public API for macros and other modules.
  game.modules.get(MODULE_ID).api = { open: openBuilder, rules, generateEncounter, EncounterBuilder };
});

// Keep the monster index fresh when the GM edits world NPCs.
for (const hook of ["createActor", "updateActor", "deleteActor"]) {
  Hooks.on(hook, actor => { if (actor.type === "npc") invalidateIndex(); });
}

// Button in the Actors sidebar header (v12 passes jQuery, v13 an HTMLElement).
Hooks.on("renderActorDirectory", (directory, html) => {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html[0];
  if (root.querySelector(".fde-open")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "fde-open";
  btn.innerHTML = `<i class="fa-solid fa-dragon"></i> ${game.i18n.localize("FDE.Title")}`;
  btn.addEventListener("click", openBuilder);
  const target = root.querySelector(".header-actions") ?? root.querySelector(".directory-header");
  target?.append(btn);
});

// Tool in the Token scene controls (v13 uses objects keyed by name, v12 arrays).
Hooks.on("getSceneControlButtons", controls => {
  if (!game.user.isGM) return;
  const tool = {
    name: "fde-builder",
    title: "FDE.Title",
    icon: "fa-solid fa-dragon",
    button: true,
    visible: true,
    order: 99
  };
  if (Array.isArray(controls)) {
    controls.find(c => c.name === "token")?.tools.push({ ...tool, onClick: openBuilder });
  } else if (controls.tokens?.tools) {
    controls.tokens.tools[tool.name] = { ...tool, onChange: () => openBuilder() };
  }
});
