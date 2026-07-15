import { MODEL_NAMES } from './modelList.js';

// Groups the flat model list into palette sections, in display order.
// Each rule is tried in turn; the first prefix match wins.
const RULES = [
  { label: 'Grass Path & Tiles', test: (n) => n.startsWith('tile') || n === 'spawn-round' || n === 'spawn-square' },
  { label: 'Grass Scenery', test: (n) => n.startsWith('detail-') || n.startsWith('wood-structure') },
  { label: 'Snow Tiles', test: (n) => n.startsWith('snow-tile') },
  { label: 'Snow Scenery', test: (n) => n.startsWith('snow-detail-') || n.startsWith('snow-wood-structure') },
  { label: 'Towers', test: (n) => n.startsWith('tower-') },
  { label: 'Weapons', test: (n) => n.startsWith('weapon-') },
  { label: 'Enemies', test: (n) => n.startsWith('enemy-') },
  { label: 'Markers', test: (n) => n.startsWith('selection-') },
];

const GROUND_LABELS = new Set(['Grass Path & Tiles', 'Snow Tiles']);

// Ground items occupy a single-layer "floor" per cell (placing one replaces
// whatever tile was there); everything else stacks as a prop on top of it.
export function isGroundModel(name) {
  const rule = RULES.find((r) => r.test(name));
  return rule ? GROUND_LABELS.has(rule.label) : false;
}

export function buildCategories() {
  const categories = RULES.map((rule) => ({ label: rule.label, items: [] }));
  const other = { label: 'Other', items: [] };

  for (const name of MODEL_NAMES) {
    const rule = RULES.find((r) => r.test(name));
    const bucket = rule ? categories[RULES.indexOf(rule)] : other;
    bucket.items.push(name);
  }

  const all = [...categories, other].filter((c) => c.items.length > 0);
  for (const category of all) category.items.sort();
  return all;
}
