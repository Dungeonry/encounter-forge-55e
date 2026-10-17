import { test } from "node:test";
import assert from "node:assert/strict";
import {
  XP_BUDGET_PER_CHARACTER, crToXP, parseCR, formatCR, budgetForLevel, partyBudget, allyBudget,
  evaluateEncounter, rateXP, targetBand, actionEconomyMultiplier
} from "../scripts/rules.mjs";

const pcs = (n, level) => Array.from({ length: n }, () => ({ kind: "pc", level }));

test("budget table covers levels 1-20 and is monotonic", () => {
  for (let l = 1; l <= 20; l++) {
    const [lo, mod, hi] = XP_BUDGET_PER_CHARACTER[l];
    assert.ok(lo < mod && mod < hi, `level ${l} tiers ordered`);
    if (l > 1) {
      const prev = XP_BUDGET_PER_CHARACTER[l - 1];
      assert.ok(lo > prev[0] && mod > prev[1] && hi > prev[2], `level ${l} grows`);
    }
  }
});

test("4-character High budgets match the 2024 DMG", () => {
  // Published checkpoints: 4 PCs, High difficulty.
  assert.equal(partyBudget(pcs(4, 1)).high, 400);
  assert.equal(partyBudget(pcs(4, 5)).high, 4400);
  assert.equal(partyBudget(pcs(4, 11)).high, 16400);
  assert.equal(partyBudget(pcs(4, 17)).high, 46800);
});

test("mixed-level parties sum per character", () => {
  const b = partyBudget([{ kind: "pc", level: 3 }, { kind: "pc", level: 5 }, { kind: "pc", level: 5, qty: 2 }]);
  assert.equal(b.low, 150 + 500 * 3);
  assert.equal(b.moderate, 225 + 750 * 3);
  assert.equal(b.high, 400 + 1100 * 3);
});

test("CR parsing and XP", () => {
  assert.equal(parseCR("1/4"), 0.25);
  assert.equal(parseCR(0.125), 0.125);
  assert.equal(parseCR("30"), 30);
  assert.equal(parseCR(null), null);
  assert.equal(formatCR(0.5), "1/2");
  assert.equal(crToXP("1/2"), 100);
  assert.equal(crToXP(5), 1800);
  assert.equal(crToXP(21), 33000);
});

test("no encounter multiplier: XP is a plain sum", () => {
  const e = evaluateEncounter(pcs(4, 3), [{ name: "Goblin", cr: 0.25, qty: 8 }]);
  assert.equal(e.totalXP, 400);
  assert.equal(e.adjustedXP, 400);
  assert.equal(e.rating, "low"); // L3 ×4: Low budget 600
  const e2 = evaluateEncounter(pcs(4, 3), [{ name: "Goblin", cr: 0.25, qty: 14 }]);
  assert.equal(e2.rating, "moderate"); // 700 > 600, ≤ 900
});

test("rating thresholds", () => {
  const b = budgetForLevel(5);
  const party = { low: b.low * 4, moderate: b.moderate * 4, high: b.high * 4 };
  assert.equal(rateXP(0, party), "none");
  assert.equal(rateXP(500, party), "trivial");
  assert.equal(rateXP(2000, party), "low");
  assert.equal(rateXP(2001, party), "moderate");
  assert.equal(rateXP(3000, party), "moderate");
  assert.equal(rateXP(4400, party), "high");
  assert.equal(rateXP(6600, party), "deadly");
  assert.equal(rateXP(6601, party), "extreme");
});

test("allies add budget; CR c ally ≈ level-c character", () => {
  assert.deepEqual(allyBudget(5), budgetForLevel(5));
  assert.deepEqual(allyBudget(0.5), { low: 25, moderate: 38, high: 50 });
  assert.deepEqual(allyBudget(4, 0.5), { low: 125, moderate: 188, high: 250 });
  const withAlly = partyBudget([...pcs(3, 5), { kind: "ally", cr: 5 }]);
  assert.equal(withAlly.high, partyBudget(pcs(4, 5)).high);
  // Allies don't take an XP share.
  const e = evaluateEncounter([...pcs(3, 5), { kind: "ally", cr: 5 }], [{ cr: 5, qty: 1 }]);
  assert.equal(e.xpPerCharacter, 600);
});

test("target bands sit between tiers", () => {
  const b = partyBudget(pcs(4, 5));
  assert.deepEqual(targetBand("moderate", b), { min: 2001, max: 3000 });
  assert.deepEqual(targetBand("high", b), { min: 3001, max: 4400 });
  assert.equal(targetBand("deadly", b).max, 6600);
});

test("action economy heuristic", () => {
  assert.equal(actionEconomyMultiplier({ enemyCount: 1, partyCount: 4, hasLegendary: false }), 0.75);
  assert.equal(actionEconomyMultiplier({ enemyCount: 1, partyCount: 4, hasLegendary: true }), 1);
  assert.equal(actionEconomyMultiplier({ enemyCount: 4, partyCount: 4 }), 1);
  assert.equal(actionEconomyMultiplier({ enemyCount: 12, partyCount: 4 }), 1.25);
  const raw = evaluateEncounter(pcs(4, 5), [{ name: "Troll", cr: 5 }]);
  const adj = evaluateEncounter(pcs(4, 5), [{ name: "Troll", cr: 5 }], { actionEconomy: true });
  assert.equal(raw.adjustedXP, 1800);
  assert.equal(adj.adjustedXP, 1350);
});

test("warnings", () => {
  const keys = (party, enemies) => evaluateEncounter(party, enemies).warnings.map(w => w.key);
  assert.ok(keys(pcs(4, 3), [{ name: "Ogre", cr: 5 }]).includes("CRAbove"));
  assert.ok(keys(pcs(4, 3), [{ name: "Ogre", cr: 5 }]).includes("SoloNoLegendary"));
  assert.ok(!keys(pcs(4, 3), [{ name: "Dragon", cr: 3, legendary: true }]).includes("SoloNoLegendary"));
  assert.ok(keys(pcs(4, 1), [{ name: "Bugbear", cr: 1 }, { name: "Ghoul", cr: 2 }]).includes("Level1"));
  assert.ok(keys(pcs(4, 5), [{ name: "Wolf", cr: 0.25, qty: 9 }]).includes("Horde"));
  assert.ok(keys(pcs(4, 8), [{ name: "Goblin", cr: 0.25, qty: 6 }]).includes("WeakFodder"));
  assert.ok(keys(pcs(4, 5), [{ name: "Big", cr: 10, qty: 2 }]).includes("Extreme"));
  assert.deepEqual(keys([], [{ cr: 1 }]), ["NoParty"]);
});
