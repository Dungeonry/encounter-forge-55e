import { MODULE_ID } from "./constants.mjs";
import { formatCR } from "./rules.mjs";

/** Get (or create) the world folder imported monsters go into. */
async function getFolder() {
  const name = game.settings.get(MODULE_ID, "importFolder") || "Encounter Forge";
  return game.folders.find(f => f.type === "Actor" && f.name === name)
    ?? Folder.create({ name, type: "Actor", color: "#7a1f1f" });
}

/** Resolve an enemy's actor in the world, importing it from its compendium if needed (once). */
export async function resolveWorldActor(uuid) {
  const doc = await fromUuid(uuid);
  if (!doc) throw new Error(`Actor ${uuid} not found`);
  if (!doc.pack) return doc;
  const existing = game.actors.find(a =>
    a._stats?.compendiumSource === uuid || a.getFlag("core", "sourceId") === uuid);
  if (existing) return existing;
  const folder = await getFolder();
  return game.actors.importFromCompendium(game.packs.get(doc.pack), doc.id, { folder: folder.id });
}

/**
 * Place the encounter's creatures on the current scene, in a block centred on the view.
 * @param {Array<{uuid:string, qty:number}>} enemies
 * @param {{hidden?:boolean, combat?:boolean}} options
 */
export async function placeEncounter(enemies, { hidden = true, combat = true } = {}) {
  const scene = canvas?.scene;
  if (!scene) return ui.notifications.warn(game.i18n.localize("FDE.Notify.NoScene"));
  const gs = scene.grid.size;
  const center = canvas.stage.pivot;
  const perRow = 5;
  const tokenData = [];
  let i = 0;
  for (const e of enemies) {
    if (!e.qty) continue;
    const actor = await resolveWorldActor(e.uuid);
    for (let n = 0; n < e.qty; n++, i++) {
      const col = i % perRow, row = Math.floor(i / perRow);
      // Space by 2 cells so Large creatures don't overlap; snap to grid.
      const x = Math.round((center.x + (col - perRow / 2) * gs * 2) / gs) * gs;
      const y = Math.round((center.y + row * gs * 2) / gs) * gs;
      const td = await actor.getTokenDocument({ x, y, hidden });
      tokenData.push(td.toObject());
    }
  }
  const tokens = await scene.createEmbeddedDocuments("Token", tokenData);
  if (combat && tokens.length) {
    const c = game.combats.find(c => c.scene?.id === scene.id && !c.started)
      ?? await Combat.implementation.create({ scene: scene.id, active: true });
    await c.createEmbeddedDocuments("Combatant", tokens.map(t => ({
      tokenId: t.id, sceneId: scene.id, actorId: t.actorId, hidden: t.hidden
    })));
  }
  ui.notifications.info(game.i18n.format("FDE.Notify.Placed", { count: tokens.length }));
  return tokens;
}

/** Write the encounter into a journal entry with links, budget and XP award. */
export async function exportToJournal(name, enemies, evaluation, difficultyLabel) {
  const rows = enemies.filter(e => e.qty).map(e =>
    `<tr><td>${e.qty}×</td><td>@UUID[${e.uuid}]{${foundry.utils.escapeHTML?.(e.name) ?? e.name}}</td>`
    + `<td>${formatCR(e.cr)}</td><td>${(e.xp * e.qty).toLocaleString()}</td></tr>`).join("");
  const b = evaluation.budget;
  const content = `
    <h2>${difficultyLabel}</h2>
    <table>
      <thead><tr><th></th><th>${game.i18n.localize("FDE.Creature")}</th><th>CR</th><th>XP</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p><strong>${game.i18n.localize("FDE.TotalXP")}:</strong> ${evaluation.totalXP.toLocaleString()}
      &nbsp;·&nbsp; <strong>${game.i18n.localize("FDE.XPPerCharacter")}:</strong> ${evaluation.xpPerCharacter.toLocaleString()}</p>
    <p><em>${game.i18n.localize("FDE.Budget")}: ${game.i18n.localize("FDE.Difficulty.low")} ${b.low.toLocaleString()} ·
      ${game.i18n.localize("FDE.Difficulty.moderate")} ${b.moderate.toLocaleString()} ·
      ${game.i18n.localize("FDE.Difficulty.high")} ${b.high.toLocaleString()}</em></p>`;
  const entry = await JournalEntry.implementation.create({
    name,
    pages: [{ name, type: "text", text: { content } }]
  });
  entry?.sheet.render(true);
  return entry;
}
