import { MODEL_NAMES } from './modelList.js';

function localName(id) {
  return id.slice(id.indexOf('/') + 1);
}

// Each kit defines its own sub-categories, matched against the model's
// local name (kit prefix stripped). First matching rule wins within a kit.
// `ground` marks single-layer "floor" items (placing one replaces whatever
// tile/road was already at that cell); everything else stacks as a prop.
const KITS = [
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

export function buildCategories() {
  const byLabel = new Map();
  const other = { label: 'Other', items: [] };

  for (const id of MODEL_NAMES) {
    const match = findMatch(id);
    if (!match) {
      other.items.push(id);
      continue;
    }
    const label = match.rule ? `${match.kitDef.label}: ${match.rule.label}` : `${match.kitDef.label}: Other`;
    if (!byLabel.has(label)) byLabel.set(label, { label, items: [] });
    byLabel.get(label).items.push(id);
  }

  const all = [...byLabel.values(), other].filter((c) => c.items.length > 0);
  for (const category of all) category.items.sort();
  return all;
}
