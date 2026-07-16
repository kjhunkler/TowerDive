// Map library: multiple named saves in localStorage. A small index holds
// list metadata (name, timestamps, thumbnail) so the menu can render the
// library without parsing every map blob; each map body lives under its own
// key so saving one map never rewrites the others.
const INDEX_KEY = 'towerdive-maplib-index-v1';
const MAP_KEY_PREFIX = 'towerdive-maplib-map-';
const LEGACY_KEY = 'towerdive-workshop-map-v1';

export function createEmptyMap(width = 15, depth = 15, tileSize = 1) {
  const entities = [];
  let id = 0;
  for (let col = 0; col < width; col++) {
    for (let row = 0; row < depth; row++) {
      entities.push({ id: id++, name: 'tower-defense/tile', ground: true, col, row, rotationStep: 0, heightStep: 0 });
    }
  }
  return { version: 1, width, depth, tileSize, nextId: id, entities };
}

// Maps saved before models were split into per-kit folders store bare names
// (e.g. "tile" instead of "tower-defense/tile") — the only kit that existed
// then, so an unprefixed name always means tower-defense.
function migrateEntityNames(map) {
  for (const entity of map.entities) {
    if (!entity.name.includes('/')) entity.name = `tower-defense/${entity.name}`;
  }
  return map;
}

function generateMapId() {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readIndex() {
  try {
    const entries = JSON.parse(localStorage.getItem(INDEX_KEY) || '[]');
    return Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry.id === 'string') : [];
  } catch {
    return [];
  }
}

function writeIndex(entries) {
  localStorage.setItem(INDEX_KEY, JSON.stringify(entries));
}

// The single-slot save that predates the library becomes its first entry.
function migrateLegacySlot() {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return;
    const map = JSON.parse(raw);
    if (map?.version === 1) {
      saveMapAs({ name: 'My first map', map: migrateEntityNames(map) });
    }
    localStorage.removeItem(LEGACY_KEY);
  } catch (error) {
    console.error('Failed to migrate legacy map:', error);
  }
}

export function listMaps() {
  migrateLegacySlot();
  return readIndex().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function getSavedMap(id) {
  try {
    const raw = localStorage.getItem(MAP_KEY_PREFIX + id);
    if (!raw) return null;
    const map = JSON.parse(raw);
    if (map?.version !== 1) return null;
    return migrateEntityNames(map);
  } catch {
    return null;
  }
}

// Create (no id) or update (existing id) a library entry. `thumb` is an
// optional small data-URL screenshot; when omitted on update, the previous
// thumbnail is kept.
export function saveMapAs({ id = null, name, map, thumb = undefined }) {
  const entries = readIndex();
  const existing = id ? entries.find((entry) => entry.id === id) : null;
  const entry = existing || {
    id: generateMapId(),
    createdAt: Date.now(),
  };
  entry.name = (name || entry.name || 'Untitled map').trim().slice(0, 48) || 'Untitled map';
  entry.updatedAt = Date.now();
  entry.entityCount = map.entities.length;
  entry.width = map.width;
  entry.depth = map.depth;
  if (thumb !== undefined) entry.thumb = thumb;

  try {
    localStorage.setItem(MAP_KEY_PREFIX + entry.id, JSON.stringify(map));
  } catch (error) {
    console.error('Failed to save map:', error);
    throw error;
  }
  if (!existing) entries.push(entry);
  try {
    writeIndex(entries);
  } catch (error) {
    // Quota pressure: thumbnails are the only bulky part of the index —
    // retry without this entry's thumbnail rather than losing the save.
    delete entry.thumb;
    writeIndex(entries);
  }
  return { ...entry };
}

export function renameMap(id, name) {
  const entries = readIndex();
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) return null;
  entry.name = (name || '').trim().slice(0, 48) || entry.name;
  entry.updatedAt = Date.now();
  writeIndex(entries);
  return { ...entry };
}

export function duplicateMap(id) {
  const map = getSavedMap(id);
  const source = readIndex().find((entry) => entry.id === id);
  if (!map || !source) return null;
  return saveMapAs({
    name: `${source.name} copy`,
    map,
    thumb: source.thumb,
  });
}

export function deleteMap(id) {
  localStorage.removeItem(MAP_KEY_PREFIX + id);
  writeIndex(readIndex().filter((entry) => entry.id !== id));
}

export function exportMapFile(map, name = 'towerdive-map') {
  const blob = new Blob([JSON.stringify(map, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'towerdive-map'}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function importMapFile(file) {
  const map = JSON.parse(await file.text());
  if (map?.version !== 1) throw new Error('Unrecognized map file');
  return migrateEntityNames(map);
}
