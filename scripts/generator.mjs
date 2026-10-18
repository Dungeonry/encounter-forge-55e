/**
 * Random encounter generator. Pure logic (no Foundry globals).
 *
 * Works like Kobold Fight Club / donjon: choose an encounter "shape", split the XP target
 * between its groups, then fill each group with a monster whose XP fits its share.
 * Every candidate is scored with the same evaluator the builder uses, so a generated
 * encounter is guaranteed to rate at the requested difficulty (or the closest it could get).
 */
import { bandAim, evaluateEncounter, targetBand } from "./rules.mjs";

/**
 * Encounter shapes. `share` = fraction of the XP target, `min`/`max` = creature count for the group.
 * Counts can be "party" (number of party combatants) or "party2" (twice that).
 * `fixed` groups (the solo monster, the boss) never get extra copies when the generator tops up XP.
 */
export const TEMPLATES = Object.freeze({
  solo:  { groups: [{ share: 1, min: 1, max: 1, preferLegendary: true, fixed: true }] },
  boss:  { groups: [{ share: 0.6, min: 1, max: 1, preferLegendary: true, fixed: true }, { share: 0.4, min: 2, max: "party" }] },
  elite: { groups: [{ share: 1, min: 2, max: 3 }] },
  squad: { groups: [{ share: 0.45, min: 1, max: 2 }, { share: 0.55, min: 2, max: 4 }] },
  mixed: { groups: [{ share: 0.4, min: 1, max: 1 }, { share: 0.3, min: 1, max: 2 }, { share: 0.3, min: 2, max: 3 }] },
  horde: { groups: [{ share: 1, min: "party", max: "party2" }] },
  /** No fixed structure: 1-4 different creatures, random XP split, random counts. Rolled fresh each attempt. */
  wild:  { dynamic: true }
});

/** Roll a one-off shape for "wild". */
function wildShape(rng) {
  const k = 1 + Math.floor(rng() * 4);
  const weights = Array.from({ length: k }, () => 0.2 + rng());
  const total = weights.reduce((s, w) => s + w, 0);
  return {
    groups: weights.map(w => {
      const min = 1 + Math.floor(rng() * 2);
      return { share: w / total, min, max: min + Math.floor(rng() * 3) };
    })
  };
}

/** Relative odds of each shape when "random" is chosen, by difficulty. */
const RANDOM_WEIGHTS = {
  low:      { solo: 1, boss: 2, elite: 3, squad: 3, mixed: 2, horde: 2, wild: 2 },
  moderate: { solo: 1, boss: 3, elite: 2, squad: 3, mixed: 3, horde: 2, wild: 2 },
  high:     { solo: 2, boss: 4, elite: 2, squad: 2, mixed: 2, horde: 1, wild: 2 },
  deadly:   { solo: 3, boss: 4, elite: 2, squad: 1, mixed: 1, horde: 1, wild: 1 }
};

function resolveCount(v, partyCount) {
  if (v === "party") return Math.max(2, partyCount);
  if (v === "party2") return Math.max(3, partyCount * 2);
  return v;
}

function weightedPick(weights, rng) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [k, w] of entries) if ((r -= w) < 0) return k;
  return entries.at(-1)[0];
}

const randInt = (lo, hi, rng) => lo + Math.floor(rng() * (hi - lo + 1));

/**
 * Choose a monster whose XP is close to (and preferably not above) `perXP`.
 * Returns null if nothing in the pool fits.
 */
function pickMonster(pool, perXP, { rng, exclude, preferLegendary }) {
  const fits = m => m.xp <= perXP * 1.1 && m.xp >= perXP * 0.4;
  let candidates = pool.filter(m => fits(m) && !exclude.has(m.id));
  if (!candidates.length) candidates = pool.filter(fits);
  if (!candidates.length) {
    // Everything allowed is too weak (e.g. CR capped at party level): take the strongest that isn't over.
    const under = pool.filter(m => m.xp <= perXP * 1.1);
    if (!under.length) return null;
    const maxXP = Math.max(...under.map(m => m.xp));
    candidates = under.filter(m => m.xp === maxXP);
  }
  if (preferLegendary && rng() < 0.65) {
    const leg = candidates.filter(m => m.legendary);
    if (leg.length) candidates = leg;
  }
  candidates.sort((a, b) => Math.abs(a.xp - perXP) - Math.abs(b.xp - perXP));
  const top = candidates.slice(0, Math.min(8, candidates.length));
  return top[Math.floor(rng() * top.length)];
}

/**
 * @param {object} args
 * @param {Array<{id:string,name:string,cr:number,xp:number,type?:string,legendary?:boolean}>} args.monsters  candidate pool (already filtered)
 * @param {Array} args.party                       party entries (see rules.partyBudget)
 * @param {"low"|"moderate"|"high"|"deadly"} args.difficulty
 * @param {string} [args.template="random"]        a TEMPLATES key or "random"
 * @param {boolean} [args.sameType=false]          keep all creatures the same creature type
 * @param {number} [args.maxCreatures=10]
 * @param {object} [args.evalOptions]              passed to evaluateEncounter (allyWeight, actionEconomy)
 * @param {() => number} [args.rng=Math.random]
 * @param {number} [args.attempts=60]
 * @returns {{enemies:Array<{monster:object, qty:number}>, template:string, evaluation:object, inBand:boolean} | null}
 */
export function generateEncounter({
  monsters, party, difficulty, template = "random", sameType = false,
  maxCreatures = 10, evalOptions = {}, rng = Math.random, attempts = 60
}) {
  if (!monsters?.length || !party?.length) return null;
  const pool = monsters.filter(m => m.xp > 0);
  if (!pool.length) return null;

  const base = evaluateEncounter(party, [], evalOptions);
  const band = targetBand(difficulty, base.budget);
  const aim = bandAim(band);
  const partyCount = base.counts.total;
  const evaluate = enemies => evaluateEncounter(party, enemies.map(e => ({ ...e.monster, qty: e.qty })), evalOptions);

  let best = null;
  for (let i = 0; i < attempts; i++) {
    const tKey = template === "random" ? weightedPick(RANDOM_WEIGHTS[difficulty] ?? RANDOM_WEIGHTS.moderate, rng) : template;
    let shape = TEMPLATES[tKey];
    if (!shape) throw new Error(`Unknown template "${tKey}"`);
    if (shape.dynamic) shape = wildShape(rng);

    let subPool = pool;
    if (sameType) {
      const types = [...new Set(pool.filter(m => m.xp <= aim).map(m => m.type).filter(Boolean))];
      if (types.length) {
        const t = types[Math.floor(rng() * types.length)];
        subPool = pool.filter(m => m.type === t);
      }
    }

    const enemies = buildFromShape(shape, subPool, { aim, partyCount, maxCreatures, rng });
    if (!enemies) continue;
    fitToBand(enemies, band, evaluate, maxCreatures);

    const evaluation = evaluate(enemies);
    const xp = evaluation.adjustedXP;
    const inBand = xp >= band.min && xp <= band.max;
    const score = inBand ? Math.abs(xp - aim) : 1e9 + Math.abs(xp - aim);
    if (!best || score < best.score) best = { enemies, template: tKey, evaluation, inBand, score };
    // A hit within 5% of the aim is good enough; a little variety is better than more precision.
    if (inBand && Math.abs(xp - aim) <= aim * 0.05) break;
  }
  if (!best) return null;
  delete best.score;
  return best;
}

function buildFromShape(shape, pool, { aim, partyCount, maxCreatures, rng }) {
  const enemies = [];
  const used = new Set();
  let remainingSlots = maxCreatures;
  for (const g of shape.groups) {
    if (remainingSlots <= 0) break;
    const groupXP = aim * g.share;
    const lo = Math.min(resolveCount(g.min, partyCount), remainingSlots);
    const hi = Math.min(resolveCount(g.max, partyCount), remainingSlots);
    let n = randInt(lo, Math.max(lo, hi), rng);
    let monster = null;
    // If nothing fits that many, try fewer, stronger creatures.
    for (; n >= 1; n--) {
      monster = pickMonster(pool, groupXP / n, { rng, exclude: used, preferLegendary: g.preferLegendary });
      if (monster) break;
    }
    if (!monster) continue;
    used.add(monster.id);
    const existing = enemies.find(e => e.monster.id === monster.id);
    if (existing) existing.qty += n;
    else enemies.push({ monster, qty: n, fixed: !!g.fixed });
    remainingSlots -= n;
  }
  return enemies.length ? enemies : null;
}

/** Nudge quantities until the effective XP lands inside the band (or we run out of moves). */
function fitToBand(enemies, band, evaluate, maxCreatures) {
  for (let guard = 0; guard < 30; guard++) {
    const xp = evaluate(enemies).adjustedXP;
    const count = enemies.reduce((s, e) => s + e.qty, 0);
    if (xp > band.max) {
      // Remove one of the cheapest stack that has more than one, else the cheapest stack that leaves something.
      const stacks = [...enemies].sort((a, b) => a.monster.xp - b.monster.xp);
      const target = stacks.find(e => e.qty > 1) ?? (enemies.length > 1 ? stacks[0] : null);
      if (!target) return;
      target.qty -= 1;
      if (!target.qty) enemies.splice(enemies.indexOf(target), 1);
    } else if (xp < band.min) {
      if (count >= maxCreatures) return;
      // Add the stack member that gets us closest without overshooting.
      let bestStack = null, bestXP = -1;
      for (const e of enemies) {
        if (e.fixed) continue;
        e.qty += 1;
        const nx = evaluate(enemies).adjustedXP;
        e.qty -= 1;
        if (nx <= band.max && nx > bestXP) { bestXP = nx; bestStack = e; }
      }
      if (!bestStack) return;
      bestStack.qty += 1;
    } else return;
  }
}

/**
 * Swap one creature of an existing encounter for a different one, keeping everything else.
 *
 * The replacement takes over roughly the same share of XP (its count may change: two ogres can
 * become five gnolls), and is scored against the same band as generateEncounter. If the
 * encounter wasn't in the band to begin with (hand-tuned), it stays as close to its current XP.
 *
 * @param {object} args
 * @param {Array} args.monsters                       candidate pool (already filtered)
 * @param {Array} args.party
 * @param {Array<{id:string, cr:number, xp:number, qty:number, type?:string, legendary?:boolean}>} args.enemies  the current encounter
 * @param {number} args.index                         which entry of `enemies` to replace
 * @param {"low"|"moderate"|"high"|"deadly"} args.difficulty
 * @param {Set<string>} [args.exclude]                ids not to pick (e.g. creatures already rerolled away)
 * @param {boolean} [args.sameType=false]             keep the creature type of the one being replaced
 * @param {number} [args.maxCreatures=10]
 * @param {object} [args.evalOptions]
 * @param {() => number} [args.rng=Math.random]
 * @returns {{monster:object, qty:number, evaluation:object, inBand:boolean} | null}
 */
export function rerollCreature({
  monsters, party, enemies, index, difficulty, exclude = new Set(), sameType = false,
  maxCreatures = 10, evalOptions = {}, rng = Math.random
}) {
  const current = enemies?.[index];
  if (!current || !party?.length) return null;
  const others = enemies.filter((_, i) => i !== index);
  const taken = new Set([current.id, ...others.map(e => e.id)]);
  let pool = (monsters ?? []).filter(m => m.xp > 0 && !taken.has(m.id));
  if (sameType && current.type) pool = pool.filter(m => m.type === current.type);
  const fresh = pool.filter(m => !exclude.has(m.id));
  if (fresh.length) pool = fresh;
  if (!pool.length) return null;

  const evaluate = list => evaluateEncounter(party, list, evalOptions);
  const before = evaluate(enemies);
  const band = targetBand(difficulty, before.budget);
  const wasInBand = before.adjustedXP >= band.min && before.adjustedXP <= band.max;
  const aim = wasInBand ? before.adjustedXP : before.adjustedXP || bandAim(band);
  const slotXP = (current.xp || 0) * Math.max(1, current.qty);
  const room = Math.max(1, maxCreatures - others.reduce((s, e) => s + (e.qty ?? 1), 0));

  const options = [];
  for (const m of pool) {
    const ideal = Math.round(slotXP / m.xp);
    if (ideal < 1) continue; // one of them alone is worth over twice the slot
    for (const qty of new Set([ideal - 1, ideal, ideal + 1, current.qty])) {
      if (qty < 1 || qty > room) continue;
      const evaluation = evaluate([...others, { ...m, qty }]);
      const xp = evaluation.adjustedXP;
      const inBand = xp >= band.min && xp <= band.max;
      let score = Math.abs(xp - aim) / (aim || 1);
      if (wasInBand && !inBand) score += 10;
      if (qty !== current.qty) score += 0.05;                // a like-for-like count is nicer, if it fits
      if (current.legendary && !m.legendary) score += 0.1;  // keep a boss a boss
      options.push({ monster: m, qty, evaluation, inBand, score });
    }
  }
  if (!options.length) return null;

  // Best quantity per creature, then a random pick among the closest few for variety.
  const perMonster = new Map();
  for (const o of options) {
    const prev = perMonster.get(o.monster.id);
    if (!prev || o.score < prev.score) perMonster.set(o.monster.id, o);
  }
  const ranked = [...perMonster.values()].sort((a, b) => a.score - b.score);
  const cutoff = ranked[0].score + 0.1;
  const top = ranked.filter(o => o.score <= cutoff).slice(0, 8);
  const pick = top[Math.floor(rng() * top.length)];
  return { monster: pick.monster, qty: pick.qty, evaluation: pick.evaluation, inBand: pick.inBand };
}
