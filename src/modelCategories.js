import { MODEL_NAMES } from './modelList.js';

function localName(id) {
  return id.slice(id.indexOf('/') + 1);
}

// Each kit defines its own sub-categories, matched against the model's
// local name (kit prefix stripped). First matching rule wins within a kit.
// `ground` marks single-layer "floor" items (placing one replaces whatever
// tile/road was already at that cell); everything else stacks as a prop.
// The source tower-defense kit is intentionally last so workshop browsing
// starts with the broader prop packs and leaves tower-defense assets at the end.
const KITS = [
  {
    kit: 'blaster',
    label: 'Blaster Kit',
    rules: [
      { label: 'Blasters', test: (n) => n.startsWith('blaster-') },
      { label: 'Attachments', test: (n) => n.startsWith('scope-') || n.startsWith('silencer-') || n.startsWith('clip-') },
      { label: 'Ammo & FX', test: (n) => n.startsWith('bullet-') || n.startsWith('grenade-') || n === 'smoke' },
      { label: 'Targets & Crates', test: (n) => n.startsWith('target-') || n.startsWith('crate-') },
    ],
  },
  {
    kit: 'fantasy-town',
    label: 'Fantasy Town',
    rules: [
      { label: 'Roads & Paths', ground: true, test: (n) => n.startsWith('road') || n.startsWith('planks') },
      { label: 'Wood Walls', test: (n) => n.startsWith('wall-wood') },
      { label: 'Stone Walls', test: (n) => n === 'wall' || n.startsWith('wall-') },
      { label: 'Roofs', test: (n) => n.startsWith('roof') },
      { label: 'Stairs', test: (n) => n.startsWith('stairs-') },
      { label: 'Fountains', test: (n) => n.startsWith('fountain-') },
      { label: 'Fences & Hedges', test: (n) => n.startsWith('fence') || n.startsWith('hedge') || n.startsWith('balcony') || n.startsWith('poles') },
      {
        label: 'Structures',
        test: (n) =>
          n.startsWith('chimney') ||
          n.startsWith('pillar-') ||
          n.startsWith('stall') ||
          n.startsWith('cart') ||
          n.startsWith('banner-') ||
          ['lantern', 'overhang', 'watermill', 'watermill-wide', 'windmill', 'wheel', 'blade'].includes(n),
      },
      { label: 'Town Scenery', test: (n) => n.startsWith('tree') || n.startsWith('rock-') },
    ],
  },
  {
    kit: 'tower-defense',
    label: 'Tower Defense',
    rules: [
      { label: 'Grass Path & Tiles', ground: true, test: (n) => n.startsWith('tile') || n === 'spawn-round' || n === 'spawn-square' },
      { label: 'Grass Scenery', test: (n) => n.startsWith('detail-') || n.startsWith('wood-structure') },
      { label: 'Snow Tiles', ground: true, test: (n) => n.startsWith('snow-tile') },
      { label: 'Snow Scenery', test: (n) => n.startsWith('snow-detail-') || n.startsWith('snow-wood-structure') },
      { label: 'Towers', test: (n) => n.startsWith('tower-') },
      { label: 'Siege Weapons', test: (n) => n.startsWith('weapon-') },
      { label: 'Enemies', test: (n) => n.startsWith('enemy-') },
      { label: 'Markers', test: (n) => n.startsWith('selection-') },
    ],
  },
];

function findMatch(id) {
  const kitDef = KITS.find((k) => id.startsWith(`${k.kit}/`));
  if (!kitDef) return null;
  const name = localName(id);
  const rule = kitDef.rules.find((r) => r.test(name));
  return rule ? { kitDef, rule } : { kitDef, rule: null };
}

export function isGroundModel(id) {
  const match = findMatch(id);
  return !!match?.rule?.ground;
}

export function getModelMeta(id) {
  const match = findMatch(id);
  return {
    kit: match?.kitDef.kit ?? 'other',
    kitLabel: match?.kitDef.label ?? 'Other',
    type: match?.rule?.ground ? 'ground' : 'prop',
  };
}

export function getKitOptions() {
  return KITS.map(({ kit, label }) => ({ value: kit, label }));
}

export function buildCategories() {
  const categories = [];
  const byLabel = new Map();
  const other = { label: 'Other', items: [] };

  for (const kit of KITS) {
    for (const rule of kit.rules) {
      const label = `${kit.label}: ${rule.label}`;
      const category = { label, items: [] };
      byLabel.set(label, category);
      categories.push(category);
    }
    const label = `${kit.label}: Other`;
    const category = { label, items: [] };
    byLabel.set(label, category);
    categories.push(category);
  }

  for (const id of MODEL_NAMES) {
    const match = findMatch(id);
    if (!match) {
      other.items.push(id);
      continue;
    }
    const label = match.rule ? `${match.kitDef.label}: ${match.rule.label}` : `${match.kitDef.label}: Other`;
    byLabel.get(label).items.push(id);
  }

  const all = [...categories, other].filter((c) => c.items.length > 0);
  for (const category of all) category.items.sort();
  return all;
}
