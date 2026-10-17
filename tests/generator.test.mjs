import { test } from "node:test";
import assert from "node:assert/strict";
import { generateEncounter, TEMPLATES } from "../scripts/generator.mjs";
import { crToXP, targetBand, partyBudget, CR_VALUES } from "../scripts/rules.mjs";

/** Deterministic PRNG (mulberry32). */
function seeded(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A synthetic bestiary: three creature types at every CR up to 24.
const TYPES = ["humanoid", "undead", "beast"];
const MONSTERS = CR_VALUES.filter(cr => cr <= 24).flatMap(cr =>
  TYPES.map(type => ({ id: `${type}-${cr}`, name: `${type} ${cr}`, cr, xp: crToXP(cr), type, legendary: cr >= 10 && type === "undead" }))
);

const pcs = (n, level) => Array.from({ length: n }, () => ({ kind: "pc", level }));

for (const difficulty of ["low", "moderate", "high", "deadly"]) {
  for (const [size, level] of [[3, 1], [4, 3], [5, 5], [4, 11], [6, 17]]) {
    test(`${difficulty}: ${size}×L${level} lands in band for every template`, () => {
      const party = pcs(size, level);
      const band = targetBand(difficulty, partyBudget(party));
      for (const template of [...Object.keys(TEMPLATES), "random"]) {
        for (let seed = 1; seed <= 15; seed++) {
          const pool = MONSTERS.filter(m => m.cr <= Math.max(1, level + (difficulty === "deadly" ? 3 : 2)));
          const r = generateEncounter({ monsters: pool, party, difficulty, template, rng: seeded(seed * 97 + level), maxCreatures: 12 });
          assert.ok(r, `${template} seed ${seed} produced something`);
          const xp = r.evaluation.adjustedXP;
          const soloPossible = pool.some(m => m.xp >= band.min && m.xp <= band.max);
          if (template === "solo" && !soloPossible) {
            assert.equal(r.inBand, false);
            assert.equal(r.enemies.length, 1);
            assert.equal(r.enemies[0].qty, 1);
          } else {
            assert.ok(xp >= band.min && xp <= band.max, `${template} seed ${seed}: ${xp} not in [${band.min}, ${band.max}]`);
            assert.equal(r.inBand, true);
          }
          const count = r.enemies.reduce((s, e) => s + e.qty, 0);
          assert.ok(count <= 12);
        }
      }
    });
  }
}

test("sameType keeps one creature type", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const r = generateEncounter({ monsters: MONSTERS, party: pcs(4, 6), difficulty: "high", template: "mixed", sameType: true, rng: seeded(seed) });
    assert.equal(new Set(r.enemies.map(e => e.monster.type)).size, 1);
  }
});

test("allies make the generator spend more XP", () => {
  const rng = () => 0.5;
  const solo = generateEncounter({ monsters: MONSTERS, party: pcs(3, 5), difficulty: "moderate", template: "elite", rng });
  const allied = generateEncounter({ monsters: MONSTERS, party: [...pcs(3, 5), { kind: "ally", cr: 5 }], difficulty: "moderate", template: "elite", rng });
  assert.ok(allied.evaluation.totalXP > solo.evaluation.totalXP);
});

test("returns null on empty input", () => {
  assert.equal(generateEncounter({ monsters: [], party: pcs(4, 1), difficulty: "low" }), null);
  assert.equal(generateEncounter({ monsters: MONSTERS, party: [], difficulty: "low" }), null);
});
