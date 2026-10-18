import { MODULE_ID, TEMPLATE_PATH } from "../constants.mjs";
import {
  CR_VALUES, DEADLY_MULTIPLIER, TARGET_DIFFICULTIES, averagePartyLevel, crToXP, evaluateEncounter, formatCR, parseCR, targetBand
} from "../rules.mjs";
import { TEMPLATES, generateEncounter, rerollCreature } from "../generator.mjs";
import { availableActorPacks, filterIndex, getMonsterIndex, indexFacets, invalidateIndex } from "../monster-index.mjs";
import { exportToJournal, placeEncounter } from "../spawn.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

const MAX_RESULTS = 200;
const SHAPE_ICONS = {
  random: "fa-shuffle", solo: "fa-dragon", boss: "fa-crown", elite: "fa-shield-halved",
  squad: "fa-people-group", mixed: "fa-layer-group", horde: "fa-users", wild: "fa-dice"
};
const uid = () => foundry.utils.randomID();

export class EncounterBuilder extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-builder`,
    classes: ["fde-builder"],
    tag: "div",
    window: { title: "FDE.Title", icon: "fa-solid fa-dragon", resizable: true },
    position: { width: 1180, height: 760 },
    actions: {
      setDifficulty: EncounterBuilder.#onSetDifficulty,
      addCustomPC: EncounterBuilder.#onAddCustomPC,
      loadParty: EncounterBuilder.#onLoadParty,
      removeParty: EncounterBuilder.#onRemoveParty,
      addEnemy: EncounterBuilder.#onAddEnemy,
      removeEnemy: EncounterBuilder.#onRemoveEnemy,
      rerollEnemy: EncounterBuilder.#onRerollEnemy,
      stepEnemy: EncounterBuilder.#onStepEnemy,
      clearEnemies: EncounterBuilder.#onClearEnemies,
      generate: EncounterBuilder.#onGenerate,
      place: EncounterBuilder.#onPlace,
      journal: EncounterBuilder.#onJournal,
      save: EncounterBuilder.#onSave,
      load: EncounterBuilder.#onLoad,
      deleteSaved: EncounterBuilder.#onDeleteSaved,
      openSheet: EncounterBuilder.#onOpenSheet,
      sources: EncounterBuilder.#onSources,
      resetFilters: EncounterBuilder.#onResetFilters,
      toggleMinimize: EncounterBuilder.#onToggleMinimize,
      setShape: EncounterBuilder.#onSetShape
    }
  };

  static PARTS = {
    party: { template: `${TEMPLATE_PATH}/party.hbs` },
    encounter: { template: `${TEMPLATE_PATH}/encounter.hbs` },
    filters: { template: `${TEMPLATE_PATH}/filters.hbs` },
    results: { template: `${TEMPLATE_PATH}/results.hbs`, scrollable: [".fde-results-list"] }
  };

  constructor(options) {
    super(options);
    this.party = [];
    this.enemies = [];
    this.difficulty = game.settings.get(MODULE_ID, "defaultDifficulty");
    this.gen = { template: "random", sameType: false, maxCreatures: 8, crOffset: 2 };
    this.filters = EncounterBuilder.#defaultFilters();
    this.index = null;
    this.selectedSave = "";
    this.lastGenerated = null;
    this.#loadPartyFromWorld();
    getMonsterIndex().then(idx => {
      this.index = idx;
      if (this.rendered) this.render({ parts: ["filters", "results"] });
    });
  }

  static #defaultFilters() {
    return { search: "", crMin: "", crMax: "", type: "", habitat: "", rules: "any" };
  }

  get evalOptions() {
    return {
      allyWeight: game.settings.get(MODULE_ID, "allyWeight"),
      actionEconomy: game.settings.get(MODULE_ID, "actionEconomy")
    };
  }

  /* -------------------------------------------- */
  /*  Party                                        */
  /* -------------------------------------------- */

  #loadPartyFromWorld() {
    let actors = [];
    let primary = null;
    try { primary = game.settings.get("dnd5e", "primaryParty")?.actor; } catch { /* older dnd5e: no primary party */ }
    if (primary?.system?.members) {
      for (const m of primary.system.members) {
        const a = m?.actor ?? m;
        if (a?.type === "character") actors.push(a);
      }
    }
    if (!actors.length) actors = game.actors.filter(a => a.type === "character" && a.hasPlayerOwner);
    this.party = actors.map(a => this.#partyEntryFromActor(a, "pc"));
  }

  #partyEntryFromActor(actor, kind) {
    return {
      uid: uid(),
      kind,
      uuid: actor.uuid,
      name: actor.name,
      img: actor.img,
      level: kind === "pc" ? Math.max(1, Number(actor.system?.details?.level) || 1) : null,
      cr: kind === "ally" ? (parseCR(actor.system?.details?.cr) ?? 0) : null,
      qty: 1
    };
  }

  /* -------------------------------------------- */
  /*  Context                                      */
  /* -------------------------------------------- */

  async _prepareContext(options) {
    const evaluation = evaluateEncounter(this.party, this.enemies, this.evalOptions);
    const facets = this.index ? indexFacets(this.index) : { types: [], habitats: [] };
    return {
      evaluation,
      party: this.party.map(p => ({ ...p, crLabel: formatCR(p.cr), isAlly: p.kind === "ally" })),
      enemies: this.enemies.map(e => ({ ...e, crLabel: formatCR(e.cr), subtotal: (e.xp * e.qty).toLocaleString() })),
      difficulties: TARGET_DIFFICULTIES.map(d => ({
        key: d, label: game.i18n.localize(`FDE.Difficulty.${d}`), active: d === this.difficulty,
        homebrew: d === "deadly",
        budget: (d === "deadly" ? evaluation.budget.deadly : evaluation.budget[d]).toLocaleString()
      })),
      ratingLabel: game.i18n.localize(`FDE.Rating.${evaluation.rating}`),
      meter: this.#meter(evaluation),
      warnings: evaluation.warnings.map(w => ({ ...w, text: game.i18n.format(`FDE.Warn.${w.key}`, w.data ?? {}) })),
      gen: this.gen,
      templates: ["random", ...Object.keys(TEMPLATES)].map(k => ({
        key: k, icon: SHAPE_ICONS[k], selected: k === this.gen.template,
        label: game.i18n.localize(`FDE.Template.${k}`), hint: game.i18n.localize(`FDE.TemplateHint.${k}`)
      })),
      crOffsets: [0, 1, 2, 3, 5, "none"].map(v => ({ value: v, label: v === "none" ? game.i18n.localize("FDE.NoCap") : `+${v}`, selected: String(v) === String(this.gen.crOffset) })),
      actionEconomy: this.evalOptions.actionEconomy,
      saved: Object.entries(game.settings.get(MODULE_ID, "savedEncounters") ?? {}).map(([id, s]) => ({ id, name: s.name, selected: id === this.selectedSave })),
      selectedSave: this.selectedSave,
      filters: this.filters,
      crMinOptions: CR_VALUES.map(c => ({ value: c, label: formatCR(c), selected: String(c) === String(this.filters.crMin) })),
      crMaxOptions: CR_VALUES.map(c => ({ value: c, label: formatCR(c), selected: String(c) === String(this.filters.crMax) })),
      types: facets.types.map(t => ({ value: t, label: CONFIG.DND5E?.creatureTypes?.[t]?.label ? game.i18n.localize(CONFIG.DND5E.creatureTypes[t].label) : t, selected: t === this.filters.type })),
      habitats: facets.habitats.map(h => ({ value: h, label: CONFIG.DND5E?.habitats?.[h]?.label ? game.i18n.localize(CONFIG.DND5E.habitats[h].label) : h, selected: h === this.filters.habitat })),
      rulesOptions: ["any", "2024", "2014"].map(r => ({ value: r, label: game.i18n.localize(`FDE.Rules.${r}`), selected: r === this.filters.rules })),
      indexing: !this.index,
      lastGenerated: this.lastGenerated
    };
  }

  async _preparePartContext(partId, context) {
    if (partId === "results" && this.index) {
      const list = filterIndex(this.index, this.#browserFilters());
      context.results = list.slice(0, MAX_RESULTS).map(m => ({ ...m, crLabel: formatCR(m.cr), xpLabel: m.xp.toLocaleString() }));
      context.resultCount = list.length;
      context.truncated = list.length > MAX_RESULTS;
    }
    return context;
  }

  #browserFilters() {
    const f = this.filters;
    return {
      search: f.search,
      crMin: f.crMin === "" ? null : Number(f.crMin),
      crMax: f.crMax === "" ? null : Number(f.crMax),
      type: f.type, habitat: f.habitat, rules: f.rules
    };
  }

  /** Positions (as % of a scale running to the Deadly ceiling) for the difficulty meter. */
  #meter(ev) {
    const top = ev.budget.high * DEADLY_MULTIPLIER || 1;
    const pct = v => Math.min(100, (v / top) * 100).toFixed(1);
    return {
      fill: pct(ev.adjustedXP),
      low: pct(ev.budget.low),
      moderate: pct(ev.budget.moderate),
      high: pct(ev.budget.high),
      over: ev.adjustedXP > top
    };
  }

  /* -------------------------------------------- */
  /*  Rendering & listeners                        */
  /* -------------------------------------------- */

  /** ApplicationV2 only minimizes on title-bar double-click; add a visible button beside Close. */
  async _renderFrame(options) {
    const frame = await super._renderFrame(options);
    const close = this.window?.close ?? frame.querySelector('[data-action="close"]');
    if (close) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "header-control icon fa-solid fa-window-minimize";
      btn.dataset.action = "toggleMinimize";
      btn.dataset.tooltip = game.i18n.localize("FDE.Minimize");
      btn.setAttribute("aria-label", btn.dataset.tooltip);
      close.before(btn);
    }
    return frame;
  }

  static async #onToggleMinimize(event, target) {
    if (this.minimized) await this.maximize();
    else await this.minimize();
    target.classList.toggle("fa-window-minimize", !this.minimized);
    target.classList.toggle("fa-window-maximize", this.minimized);
  }

  /**
   * Listeners are delegated from the window element, which survives partial re-renders
   * (binding per-part in _onRender would stack duplicate handlers on parts that weren't replaced).
   */
  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    const el = this.element;

    el.addEventListener("change", ev => {
      if (ev.target.matches?.("[data-field]") && ev.target.type !== "search") this.#onFieldChange(ev.target);
    });
    el.addEventListener("input", ev => {
      if (ev.target.matches?.("[data-field]") && ev.target.type === "search") this.#onFieldChange(ev.target);
    });

    // Drag & drop of actors from the sidebar or a compendium.
    el.addEventListener("dragover", ev => {
      const zone = ev.target.closest?.("[data-drop]");
      if (!zone) return;
      ev.preventDefault();
      zone.classList.add("fde-drag");
    });
    el.addEventListener("dragleave", ev => ev.target.closest?.("[data-drop]")?.classList.remove("fde-drag"));
    el.addEventListener("drop", ev => {
      const zone = ev.target.closest?.("[data-drop]");
      if (!zone) return;
      zone.classList.remove("fde-drag");
      this.#onDrop(ev, zone.dataset.drop);
    });

    // Result rows can be dragged straight onto the party side as allies.
    el.addEventListener("dragstart", ev => {
      const row = ev.target.closest?.(".fde-result[data-uuid]");
      if (row) ev.dataTransfer.setData("text/plain", JSON.stringify({ type: "Actor", uuid: row.dataset.uuid }));
    });
  }

  #searchTimer = null;

  async #onFieldChange(input) {
    const field = input.dataset.field;
    const value = input.type === "checkbox" ? input.checked : input.value;
    const row = input.closest("[data-uid]")?.dataset.uid;

    switch (field) {
      case "party.level": {
        const p = this.party.find(x => x.uid === row);
        if (p) p.level = Math.min(20, Math.max(1, Math.round(Number(value) || 1)));
        return this.render({ parts: ["party", "encounter"] });
      }
      case "party.qty": {
        const p = this.party.find(x => x.uid === row);
        if (p) p.qty = Math.max(1, Math.floor(Number(value) || 1));
        return this.render({ parts: ["party", "encounter"] });
      }
      case "party.cr": {
        const p = this.party.find(x => x.uid === row);
        if (p) p.cr = parseCR(value) ?? 0;
        return this.render({ parts: ["party", "encounter"] });
      }
      case "party.name": {
        const p = this.party.find(x => x.uid === row);
        if (p) p.name = value;
        return;
      }
      case "enemy.qty": {
        const e = this.enemies.find(x => x.uid === row);
        if (e) e.qty = Math.max(0, Math.floor(Number(value) || 0));
        return this.render({ parts: ["encounter"] });
      }
      case "actionEconomy":
        await game.settings.set(MODULE_ID, "actionEconomy", value);
        return this.render({ parts: ["encounter"] });
      case "savedSelect":
        this.selectedSave = value;
        return;
      default:
        if (field.startsWith("gen.")) {
          const k = field.slice(4);
          this.gen[k] = k === "sameType" ? value : k === "maxCreatures" ? Math.max(1, Number(value) || 1) : value;
          return;
        }
        if (field.startsWith("filters.")) {
          this.filters[field.slice(8)] = value;
          if (field === "filters.search") {
            clearTimeout(this.#searchTimer);
            this.#searchTimer = setTimeout(() => this.render({ parts: ["results"] }), 200);
            return;
          }
          return this.render({ parts: ["results"] });
        }
    }
  }

  async #onDrop(event, zone) {
    event.preventDefault();
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { return; }
    if (data?.type !== "Actor" || !data.uuid) return;
    const actor = await fromUuid(data.uuid);
    if (!actor) return;
    if (zone === "party") {
      if (this.party.some(p => p.uuid === actor.uuid && p.kind === "pc")) return;
      this.party.push(this.#partyEntryFromActor(actor, actor.type === "character" ? "pc" : "ally"));
      return this.render({ parts: ["party", "encounter"] });
    }
    if (zone === "enemies") {
      if (actor.type !== "npc") return ui.notifications.warn(game.i18n.localize("FDE.Notify.NotNPC"));
      const cr = parseCR(actor.system?.details?.cr) ?? 0;
      this.#addEnemy({
        uuid: actor.uuid, name: actor.name, img: actor.img, cr, xp: crToXP(cr),
        legendary: Number(actor.system?.resources?.legact?.max ?? 0) > 0,
        type: actor.system?.details?.type?.value ?? ""
      });
      return this.render({ parts: ["encounter"] });
    }
  }

  #addEnemy(m, qty = 1) {
    const existing = this.enemies.find(e => e.uuid === m.uuid);
    if (existing) existing.qty += qty;
    else this.enemies.push({ uid: uid(), uuid: m.uuid, name: m.name, img: m.img, cr: m.cr, xp: m.xp, legendary: !!m.legendary, type: m.type, qty });
  }

  /* -------------------------------------------- */
  /*  Actions                                      */
  /* -------------------------------------------- */

  static #onSetShape(event, target) {
    this.gen.template = target.dataset.shape;
    this.render({ parts: ["encounter"] });
  }

  static #onSetDifficulty(event, target) {
    this.difficulty = target.dataset.difficulty;
    this.render({ parts: ["encounter"] });
  }

  static #onAddCustomPC() {
    const level = averagePartyLevel(this.party) || 1;
    this.party.push({ uid: uid(), kind: "pc", name: game.i18n.localize("FDE.Character"), img: "icons/svg/mystery-man.svg", level, qty: 1 });
    this.render({ parts: ["party", "encounter"] });
  }

  static #onLoadParty() {
    this.#loadPartyFromWorld();
    this.render({ parts: ["party", "encounter"] });
  }

  static #onRemoveParty(event, target) {
    const id = target.closest("[data-uid]").dataset.uid;
    this.party = this.party.filter(p => p.uid !== id);
    this.render({ parts: ["party", "encounter"] });
  }

  static #onAddEnemy(event, target) {
    const m = this.index?.find(x => x.uuid === target.closest("[data-uuid]").dataset.uuid);
    if (!m) return;
    this.#addEnemy(m, event.shiftKey ? 5 : 1);
    this.render({ parts: ["encounter"] });
  }

  static #onRemoveEnemy(event, target) {
    const id = target.closest("[data-uid]").dataset.uid;
    this.enemies = this.enemies.filter(e => e.uid !== id);
    this.render({ parts: ["encounter"] });
  }

  static #onStepEnemy(event, target) {
    const e = this.enemies.find(x => x.uid === target.closest("[data-uid]").dataset.uid);
    if (!e) return;
    e.qty = Math.max(0, e.qty + Number(target.dataset.step));
    this.render({ parts: ["encounter"] });
  }

  static #onClearEnemies() {
    this.enemies = [];
    this.lastGenerated = null;
    this.render({ parts: ["encounter"] });
  }

  static async #onGenerate() {
    if (!this.party.length) return ui.notifications.warn(game.i18n.localize("FDE.Warn.NoParty"));
    const pool = await this.#generatorPool();
    if (!pool.length) return ui.notifications.warn(game.i18n.localize("FDE.Notify.EmptyPool"));

    const result = generateEncounter({
      monsters: pool,
      party: this.party,
      difficulty: this.difficulty,
      template: this.gen.template,
      sameType: this.gen.sameType,
      maxCreatures: this.gen.maxCreatures,
      evalOptions: this.evalOptions
    });
    if (!result) return ui.notifications.warn(game.i18n.localize("FDE.Notify.GenFailed"));
    this.enemies = [];
    for (const { monster, qty } of result.enemies) this.#addEnemy(monster, qty);
    this.lastGenerated = {
      template: game.i18n.localize(`FDE.Template.${result.template}`),
      inBand: result.inBand
    };
    if (!result.inBand) ui.notifications.info(game.i18n.localize("FDE.Notify.Closest"));
    this.render({ parts: ["encounter"] });
  }

  /** Bestiary filters (minus search) plus the generator's CR cap. */
  async #generatorPool() {
    this.index ??= await getMonsterIndex();
    const { search, ...rest } = this.#browserFilters();
    const avg = averagePartyLevel(this.party) || 1;
    const cap = this.gen.crOffset === "none" ? null : Math.max(1, avg + Number(this.gen.crOffset));
    if (cap !== null) rest.crMax = rest.crMax === null ? cap : Math.min(rest.crMax, cap);
    return filterIndex(this.index, rest);
  }

  /** Swap one row for a different creature of similar XP, leaving the rest of the encounter alone. */
  static async #onRerollEnemy(event, target) {
    const index = this.enemies.findIndex(x => x.uid === target.closest("[data-uid]").dataset.uid);
    if (index < 0) return;
    if (!this.party.length) return ui.notifications.warn(game.i18n.localize("FDE.Warn.NoParty"));
    const pool = await this.#generatorPool();
    const current = this.enemies[index];
    // Remember what this row has already been, so repeated clicks keep showing new creatures.
    const seen = new Set([...(current.rerolled ?? []), current.uuid]);
    const result = rerollCreature({
      monsters: pool,
      party: this.party,
      enemies: this.enemies.map(e => ({ ...e, id: e.uuid })),
      index,
      difficulty: this.difficulty,
      exclude: seen,
      sameType: this.gen.sameType,
      maxCreatures: this.gen.maxCreatures,
      evalOptions: this.evalOptions
    });
    if (!result) return ui.notifications.warn(game.i18n.localize("FDE.Notify.NoReroll"));
    const m = result.monster;
    this.enemies[index] = {
      uid: current.uid, uuid: m.uuid, name: m.name, img: m.img, cr: m.cr, xp: m.xp,
      legendary: !!m.legendary, type: m.type, qty: result.qty,
      rerolled: seen.has(m.uuid) ? [current.uuid] : [...seen]
    };
    this.render({ parts: ["encounter"] });
  }

  /** data-combat="true" on the button also adds the tokens to the combat tracker. */
  static async #onPlace(event, target) {
    if (!this.enemies.length) return;
    await placeEncounter(this.enemies, {
      hidden: game.settings.get(MODULE_ID, "placeHidden"),
      combat: target.dataset.combat === "true"
    });
  }

  static async #onJournal() {
    if (!this.enemies.length) return;
    const ev = evaluateEncounter(this.party, this.enemies, this.evalOptions);
    const label = game.i18n.localize(`FDE.Rating.${ev.rating}`);
    const name = await this.#promptName(game.i18n.format("FDE.DefaultJournalName", { rating: label }));
    if (name) await exportToJournal(name, this.enemies, ev, label);
  }

  static async #onSave() {
    if (!this.enemies.length) return;
    const ev = evaluateEncounter(this.party, this.enemies, this.evalOptions);
    const name = await this.#promptName(`${game.i18n.localize(`FDE.Rating.${ev.rating}`)} — ${this.enemies.map(e => e.name).join(", ")}`.slice(0, 80));
    if (!name) return;
    const saved = foundry.utils.deepClone(game.settings.get(MODULE_ID, "savedEncounters") ?? {});
    const id = uid();
    saved[id] = { name, enemies: this.enemies.map(({ uid, rerolled, ...e }) => e), difficulty: this.difficulty };
    await game.settings.set(MODULE_ID, "savedEncounters", saved);
    this.selectedSave = id;
    this.render({ parts: ["encounter"] });
  }

  static #onLoad() {
    const s = game.settings.get(MODULE_ID, "savedEncounters")?.[this.selectedSave];
    if (!s) return;
    this.enemies = s.enemies.map(e => ({ ...e, uid: uid() }));
    if (s.difficulty) this.difficulty = s.difficulty;
    this.lastGenerated = null;
    this.render({ parts: ["encounter"] });
  }

  static async #onDeleteSaved() {
    if (!this.selectedSave) return;
    const saved = foundry.utils.deepClone(game.settings.get(MODULE_ID, "savedEncounters") ?? {});
    delete saved[this.selectedSave];
    await game.settings.set(MODULE_ID, "savedEncounters", saved);
    this.selectedSave = "";
    this.render({ parts: ["encounter"] });
  }

  static async #onOpenSheet(event, target) {
    const doc = await fromUuid(target.closest("[data-uuid]").dataset.uuid);
    doc?.sheet?.render(true);
  }

  static #onResetFilters() {
    this.filters = EncounterBuilder.#defaultFilters();
    this.render({ parts: ["filters", "results"] });
  }

  static async #onSources() {
    const selected = new Set(game.settings.get(MODULE_ID, "compendiums") ?? []);
    const packs = availableActorPacks();
    const rows = packs.map(p => `<label class="fde-pack"><input type="checkbox" name="pack" value="${p.id}" ${!selected.size || selected.has(p.id) ? "checked" : ""}> ${p.label}</label>`).join("");
    const worldChecked = game.settings.get(MODULE_ID, "includeWorldActors") ? "checked" : "";
    const result = await DialogV2.prompt({
      window: { title: game.i18n.localize("FDE.Sources") },
      content: `<p>${game.i18n.localize("FDE.SourcesHint")}</p><div class="fde-pack-list">${rows}</div>
        <hr><label class="fde-pack"><input type="checkbox" name="world" ${worldChecked}> ${game.i18n.localize("FDE.IncludeWorld")}</label>`,
      ok: {
        label: game.i18n.localize("FDE.Apply"),
        callback: (event, button) => {
          const form = button.form;
          const chosen = [...form.querySelectorAll('input[name="pack"]:checked')].map(i => i.value);
          return { packs: chosen.length === packs.length ? [] : chosen, world: form.querySelector('input[name="world"]').checked };
        }
      },
      rejectClose: false
    });
    if (!result) return;
    await game.settings.set(MODULE_ID, "compendiums", result.packs);
    await game.settings.set(MODULE_ID, "includeWorldActors", result.world);
    invalidateIndex();
    this.index = null;
    this.render({ parts: ["filters", "results"] });
    this.index = await getMonsterIndex();
    this.render({ parts: ["filters", "results"] });
  }

  async #promptName(defaultName) {
    return DialogV2.prompt({
      window: { title: game.i18n.localize("FDE.Name") },
      content: `<input type="text" name="name" value="${foundry.utils.escapeHTML?.(defaultName) ?? defaultName}" autofocus style="width:100%">`,
      ok: { callback: (event, button) => button.form.elements.name.value.trim() },
      rejectClose: false
    });
  }

  /** Expose the target band so macros/other modules can reuse it. */
  get targetBand() {
    return targetBand(this.difficulty, evaluateEncounter(this.party, [], this.evalOptions).budget);
  }
}
