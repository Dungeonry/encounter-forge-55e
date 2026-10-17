import { MODULE_ID } from "./constants.mjs";
import { crToXP, parseCR } from "./rules.mjs";

const INDEX_FIELDS = [
  "type",
  "system.details.cr",
  "system.details.type",
  "system.details.habitat",
  "system.details.environment",
  "system.attributes.hp.max",
  "system.attributes.hp.value",
  "system.resources.legact",
  "system.source"
];

let cache = null;
let building = null;

/** Actor compendiums the GM can pick from (everything containing Actors). */
export function availableActorPacks() {
  return game.packs.filter(p => p.documentName === "Actor").map(p => ({
    id: p.collection,
    label: `${p.metadata.label} (${p.metadata.packageName ?? p.metadata.package})`
  }));
}

export function invalidateIndex() {
  cache = null;
  building = null;
}

/**
 * Build (once) a flat, de-duplicated list of NPCs from the selected compendiums (and optionally
 * world actors). Each entry: {id, uuid, name, img, cr, xp, type, legendary, hp, habitats, rules, source}.
 */
export async function getMonsterIndex() {
  if (cache) return cache;
  building ??= buildIndex().then(r => (cache = r));
  return building;
}

async function buildIndex() {
  const selected = game.settings.get(MODULE_ID, "compendiums") ?? [];
  const packs = game.packs.filter(p => p.documentName === "Actor" && (!selected.length || selected.includes(p.collection)));
  const out = [];
  for (const pack of packs) {
    if (!pack.visible && !game.user.isGM) continue;
    let index;
    try {
      index = await pack.getIndex({ fields: INDEX_FIELDS });
    } catch (err) {
      console.warn(`${MODULE_ID} | Could not index ${pack.collection}`, err);
      continue;
    }
    for (const e of index) {
      if (e.type !== "npc") continue;
      const entry = toEntry(e, e.uuid ?? `Compendium.${pack.collection}.Actor.${e._id}`, pack.metadata.label);
      if (entry) out.push(entry);
    }
  }
  if (game.settings.get(MODULE_ID, "includeWorldActors")) {
    for (const a of game.actors) {
      if (a.type !== "npc" || a.hasPlayerOwner) continue;
      const entry = toEntry(a, a.uuid, game.i18n.localize("FDE.World"));
      if (entry) out.push(entry);
    }
  }
  out.sort((a, b) => a.cr - b.cr || a.name.localeCompare(b.name));
  return out;
}

function get(obj, path) {
  return foundry.utils.getProperty(obj, path);
}

function toEntry(doc, uuid, sourceLabel) {
  const cr = parseCR(get(doc, "system.details.cr"));
  if (cr === null) return null;
  const typeData = get(doc, "system.details.type");
  const type = (typeof typeData === "string" ? typeData : typeData?.value) || "";
  const legact = get(doc, "system.resources.legact");
  const habitat = get(doc, "system.details.habitat");
  const habitats = [
    ...(Array.isArray(habitat?.value) ? habitat.value.map(h => h?.type ?? h).filter(Boolean) : []),
    ...String(habitat?.custom ?? get(doc, "system.details.environment") ?? "")
      .split(/[,;]/).map(s => s.trim().toLowerCase()).filter(Boolean)
  ];
  const source = get(doc, "system.source") ?? {};
  return {
    id: uuid,
    uuid,
    name: doc.name,
    img: doc.img,
    cr,
    xp: crToXP(cr),
    type,
    legendary: Number(legact?.max ?? legact?.value ?? 0) > 0,
    hp: get(doc, "system.attributes.hp.max") ?? get(doc, "system.attributes.hp.value") ?? null,
    habitats: [...new Set(habitats)],
    rules: String(source.rules ?? (source.book?.includes("2024") ? "2024" : "") ?? ""),
    source: sourceLabel
  };
}

/** Distinct creature types and habitats present in the index (for filter dropdowns). */
export function indexFacets(index) {
  const types = new Set(), habitats = new Set();
  for (const m of index) {
    if (m.type) types.add(m.type);
    for (const h of m.habitats) habitats.add(h);
  }
  return { types: [...types].sort(), habitats: [...habitats].sort() };
}

/**
 * Filter the index.
 * @param {object} f  {search, crMin, crMax, type, habitat, rules: "any"|"2024"|"2014", dedupe}
 */
export function filterIndex(index, f = {}) {
  const q = (f.search ?? "").trim().toLowerCase();
  let list = index.filter(m =>
    (!q || m.name.toLowerCase().includes(q))
    && (f.crMin == null || m.cr >= f.crMin)
    && (f.crMax == null || m.cr <= f.crMax)
    && (!f.type || m.type === f.type)
    && (!f.habitat || m.habitats.includes(f.habitat))
    && (!f.rules || f.rules === "any" || m.rules === f.rules)
  );
  if (f.dedupe !== false) {
    // Same statblock in several packs (or 2014 + 2024 versions): keep one, preferring 2024 rules.
    const byName = new Map();
    for (const m of list) {
      const key = m.name.toLowerCase();
      const prev = byName.get(key);
      if (!prev || (m.rules === "2024" && prev.rules !== "2024")) byName.set(key, m);
    }
    list = list.filter(m => byName.get(m.name.toLowerCase()) === m);
  }
  return list;
}
