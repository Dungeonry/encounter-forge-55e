/**
 * Encounter-balance rules for D&D 5e (2024 revision, a.k.a. "5.5e").
 *
 * Pure logic, no Foundry globals, so it can be unit tested in Node.
 *
 * RAW (2024 Dungeon Master's Guide, "Combat Encounters"):
 *  1. Pick a difficulty: Low, Moderate or High.
 *  2. Look up the XP budget per character for that difficulty and each character's level; add them up.
 *  3. Spend the budget on creatures, using each creature's XP value (from its CR).
 *     There is NO multiplier for the number of creatures (the 2014 encounter multiplier is gone).
 *
 * Everything beyond that (ally contribution, "Deadly"/"Extreme" tiers above High, the optional
 * action-economy adjustment and the warnings) is clearly marked as a heuristic extension.
 */

export const DIFFICULTIES = ["low", "moderate", "high"];

/** Difficulties offered by the generator: the three RAW tiers plus one homebrew tier beyond High. */
export const TARGET_DIFFICULTIES = ["low", "moderate", "high", "deadly"];

/** 2024 DMG — XP Budget per Character: [Low, Moderate, High]. */
export const XP_BUDGET_PER_CHARACTER = Object.freeze({
  1: [50, 75, 100],
  2: [100, 150, 200],
  3: [150, 225, 400],
  4: [250, 375, 500],
  5: [500, 750, 1100],
  6: [600, 1000, 1400],
  7: [750, 1300, 1700],
  8: [1000, 1700, 2100],
  9: [1300, 2000, 2600],
  10: [1600, 2300, 3100],
  11: [1900, 2900, 4100],
  12: [2200, 3700, 4700],
  13: [2600, 4200, 5400],
  14: [2900, 4900, 6200],
  15: [3300, 5400, 7800],
  16: [3800, 6100, 9800],
  17: [4500, 7200, 11700],
  18: [5000, 8700, 14200],
  19: [5500, 10700, 17200],
  20: [6400, 13200, 22000]
});

/** XP by Challenge Rating (2024 Monster Manual / DMG). CR 0 is 0 or 10 XP; 10 is used by default. */
export const CR_XP = Object.freeze({
  0: 10, 0.125: 25, 0.25: 50, 0.5: 100,
  1: 200, 2: 450, 3: 700, 4: 1100, 5: 1800, 6: 2300, 7: 2900, 8: 3900, 9: 5000, 10: 5900,
  11: 7200, 12: 8400, 13: 10000, 14: 11500, 15: 13000, 16: 15000, 17: 18000, 18: 20000, 19: 22000, 20: 25000,
  21: 33000, 22: 41000, 23: 50000, 24: 62000, 25: 75000, 26: 90000, 27: 105000, 28: 120000, 29: 135000, 30: 155000
});

export const CR_VALUES = Object.freeze(Object.keys(CR_XP).map(Number).sort((a, b) => a - b));

/** Homebrew tiers above High, as multiples of the High budget. */
export const DEADLY_MULTIPLIER = 1.5;
/** Below this fraction of the Low budget an encounter is rated "Trivial". */
export const TRIVIAL_FRACTION = 0.5;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Normalise any CR-ish value (number, "1/4", "0.25", null) to one of CR_VALUES. */
export function parseCR(value) {
  if (value === null || value === undefined || value === "") return null;
  let n;
  if (typeof value === "number") n = value;
  else {
    const s = String(value).trim();
    if (s.includes("/")) {
      const [a, b] = s.split("/").map(Number);
      n = b ? a / b : NaN;
    } else n = Number(s);
  }
  if (!Number.isFinite(n) || n < 0) return null;
  // Snap to the nearest legal CR.
  let best = CR_VALUES[0];
  for (const cr of CR_VALUES) if (Math.abs(cr - n) < Math.abs(best - n)) best = cr;
  return best;
}

export function formatCR(cr) {
  const c = parseCR(cr);
  if (c === null) return "—";
  if (c === 0.125) return "1/8";
  if (c === 0.25) return "1/4";
  if (c === 0.5) return "1/2";
  return String(c);
}

export function crToXP(cr) {
  const c = parseCR(cr);
  return c === null ? 0 : CR_XP[c];
}

/** Per-character budget for one level, as {low, moderate, high}. */
export function budgetForLevel(level) {
  const l = clamp(Math.round(Number(level) || 1), 1, 20);
  const [low, moderate, high] = XP_BUDGET_PER_CHARACTER[l];
  return { low, moderate, high };
}

/**
 * HEURISTIC: how much budget an allied NPC adds to the party side.
 *
 * The 2024 DMG doesn't price allies. We treat an ally of CR c as a character of level c
 * (CR ≥ 1, capped at 20) and scale fractional CRs from the level-1 budget
 * (a CR 1/2 ally adds half a level-1 character). `weight` lets the GM tune this
 * (e.g. 0.5 for flimsy allies the DM plays conservatively).
 */
export function allyBudget(cr, weight = 1) {
  const c = parseCR(cr) ?? 0;
  const base = c >= 1 ? budgetForLevel(Math.min(20, Math.floor(c))) : scaleBudget(budgetForLevel(1), c);
  return scaleBudget(base, weight);
}

function scaleBudget(b, f) {
  return { low: Math.round(b.low * f), moderate: Math.round(b.moderate * f), high: Math.round(b.high * f) };
}

/**
 * Total XP budget for the party side.
 * @param {Array<{kind:"pc"|"ally", level?:number, cr?:number, qty?:number}>} party
 * @param {{allyWeight?:number}} [options]
 */
export function partyBudget(party, { allyWeight = 1 } = {}) {
  const total = { low: 0, moderate: 0, high: 0 };
  for (const m of party ?? []) {
    const qty = Math.max(0, Math.floor(m.qty ?? 1));
    const b = m.kind === "ally" ? allyBudget(m.cr, allyWeight) : budgetForLevel(m.level);
    total.low += b.low * qty;
    total.moderate += b.moderate * qty;
    total.high += b.high * qty;
  }
  total.deadly = Math.round(total.high * DEADLY_MULTIPLIER);
  return total;
}

/** Count of characters (PCs) and of all combatants on the party side. */
export function partyCounts(party) {
  let pcs = 0, allies = 0;
  for (const m of party ?? []) {
    const qty = Math.max(0, Math.floor(m.qty ?? 1));
    if (m.kind === "ally") allies += qty;
    else pcs += qty;
  }
  return { pcs, allies, total: pcs + allies };
}

/** Average PC level, rounded (allies excluded). */
export function averagePartyLevel(party) {
  let sum = 0, n = 0;
  for (const m of party ?? []) {
    if (m.kind === "ally") continue;
    const qty = Math.max(0, Math.floor(m.qty ?? 1));
    sum += clamp(Number(m.level) || 1, 1, 20) * qty;
    n += qty;
  }
  return n ? Math.round(sum / n) : 0;
}

/**
 * HEURISTIC (optional, off by default): the 2024 DMG prices creatures purely by XP, which
 * over-rates lone non-legendary monsters (they lose the action-economy war) and under-rates
 * hordes (many attacks, many targets). This nudges the *effective* XP used for the rating.
 */
export function actionEconomyMultiplier({ enemyCount, partyCount, hasLegendary }) {
  if (!enemyCount || !partyCount) return 1;
  const r = enemyCount / partyCount;
  if (r < 0.34) return hasLegendary ? 1 : 0.75;
  if (r < 0.5) return hasLegendary ? 1 : 0.9;
  if (r <= 1.5) return 1;
  if (r <= 2.5) return 1.1;
  return 1.25;
}

/** Rate an XP total against a budget. */
export function rateXP(xp, budget) {
  if (!xp) return "none";
  if (xp < budget.low * TRIVIAL_FRACTION) return "trivial";
  if (xp <= budget.low) return "low";
  if (xp <= budget.moderate) return "moderate";
  if (xp <= budget.high) return "high";
  if (xp <= budget.high * DEADLY_MULTIPLIER) return "deadly";
  return "extreme";
}

/**
 * The XP window the generator aims for when asked for a given difficulty.
 * An encounter "is" Moderate when it spends more than the Low budget but no more than the Moderate one.
 */
export function targetBand(difficulty, budget) {
  switch (difficulty) {
    case "low": return { min: Math.round(budget.low * 0.75), max: budget.low };
    case "moderate": return { min: budget.low + 1, max: budget.moderate };
    case "high": return { min: budget.moderate + 1, max: budget.high };
    case "deadly": return { min: budget.high + 1, max: Math.round(budget.high * DEADLY_MULTIPLIER) };
    default: throw new Error(`Unknown difficulty "${difficulty}"`);
  }
}

/** The point inside a band the generator tries to hit: near the top, leaving a little slack. */
export function bandAim(band) {
  return Math.round(band.min + (band.max - band.min) * 0.8);
}

/**
 * Evaluate an encounter.
 * @param {Array} party   see partyBudget()
 * @param {Array<{name?:string, cr:number, xp?:number, qty?:number, legendary?:boolean}>} enemies
 * @param {{allyWeight?:number, actionEconomy?:boolean}} [options]
 */
export function evaluateEncounter(party, enemies, { allyWeight = 1, actionEconomy = false } = {}) {
  const budget = partyBudget(party, { allyWeight });
  const counts = partyCounts(party);
  const avgLevel = averagePartyLevel(party);

  let totalXP = 0, enemyCount = 0, hasLegendary = false, maxCR = null, strongest = null;
  for (const e of enemies ?? []) {
    const qty = Math.max(0, Math.floor(e.qty ?? 1));
    if (!qty) continue;
    const xp = Number.isFinite(e.xp) && e.xp > 0 ? e.xp : crToXP(e.cr);
    totalXP += xp * qty;
    enemyCount += qty;
    const cr = parseCR(e.cr) ?? 0;
    if (maxCR === null || cr > maxCR) { maxCR = cr; strongest = e; }
  }
  if (strongest?.legendary) hasLegendary = true;

  const multiplier = actionEconomy
    ? actionEconomyMultiplier({ enemyCount, partyCount: counts.total, hasLegendary })
    : 1;
  const adjustedXP = Math.round(totalXP * multiplier);
  const rating = counts.total ? rateXP(adjustedXP, budget) : "none";

  return {
    budget,
    counts,
    avgLevel,
    totalXP,
    adjustedXP,
    multiplier,
    enemyCount,
    rating,
    /** 2024 rules award each character an equal share of the creatures' XP (allies don't take a share). */
    xpPerCharacter: counts.pcs ? Math.floor(totalXP / counts.pcs) : 0,
    /** Fraction of each budget spent (useful for meters). */
    usage: {
      low: budget.low ? adjustedXP / budget.low : 0,
      moderate: budget.moderate ? adjustedXP / budget.moderate : 0,
      high: budget.high ? adjustedXP / budget.high : 0
    },
    warnings: encounterWarnings({ party, enemies, budget, counts, avgLevel, adjustedXP, enemyCount, hasLegendary })
  };
}

/**
 * Advisory warnings. The CR guidance follows the 2024 DMG's caution about creatures whose CR
 * exceeds the party's level (and the extra fragility of level 1 characters); the rest are
 * well-known action-economy pitfalls.
 * @returns {Array<{key:string, level:"info"|"warn"|"danger", data?:object}>}
 */
export function encounterWarnings({ party, enemies, budget, counts, avgLevel, adjustedXP, enemyCount, hasLegendary }) {
  const w = [];
  if (!counts.pcs) {
    if (counts.total) w.push({ key: "NoPCs", level: "info" });
    else return [{ key: "NoParty", level: "info" }];
  }
  if (!enemyCount) return w;

  if (adjustedXP > budget.high * DEADLY_MULTIPLIER) w.push({ key: "Extreme", level: "danger" });
  else if (adjustedXP > budget.high) w.push({ key: "OverHigh", level: "danger" });

  const seen = new Set();
  for (const e of enemies) {
    if (!(e.qty ?? 1)) continue;
    const cr = parseCR(e.cr) ?? 0;
    if (avgLevel && cr > avgLevel && !seen.has(e.name)) {
      seen.add(e.name);
      w.push({ key: "CRAbove", level: cr >= avgLevel + 3 ? "danger" : "warn", data: { name: e.name ?? "?", cr: formatCR(cr), level: avgLevel } });
    }
  }
  if (avgLevel === 1 && enemies.some(e => (e.qty ?? 1) && (parseCR(e.cr) ?? 0) > 1)) {
    w.push({ key: "Level1", level: "warn" });
  }

  if (counts.total) {
    const ratio = enemyCount / counts.total;
    if (enemyCount === 1 && counts.total >= 3 && !hasLegendary) w.push({ key: "SoloNoLegendary", level: "warn" });
    if (ratio > 2) w.push({ key: "Horde", level: "warn", data: { count: enemyCount } });
  }

  // Many very weak creatures against a higher-level party mostly miss; XP over-rates them.
  if (avgLevel >= 5) {
    const weak = enemies.filter(e => (e.qty ?? 1) && (parseCR(e.cr) ?? 0) <= avgLevel / 4);
    const weakCount = weak.reduce((s, e) => s + (e.qty ?? 1), 0);
    if (weakCount >= 4 && weakCount >= enemyCount / 2) w.push({ key: "WeakFodder", level: "info" });
  }
  return w;
}
