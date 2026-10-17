/**
 * The user's filaments: spools they own or the ones loaded in the printer's
 * AMS. Objects are painted with a filament, and the print dialog maps each
 * colour used in the model to one of them.
 */

export interface Filament {
  id: string;
  name: string;
  /** PLA, PETG, TPU... (selects the slicer preset). */
  type: string;
  color: string;
  source: 'manual' | 'ams';
  /** AMS tray id (ams*4 + slot) the filament was read from. */
  tray?: number;
}

export const FILAMENT_TYPES = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PC', 'PA', 'PVA'];

const KEY = 'opencad:filaments';

const read = (): Filament[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

class FilamentStore {
  private items: Filament[] = read();
  private listeners = new Set<() => void>();

  get list(): readonly Filament[] {
    return this.items;
  }
  get(id?: string) {
    return id ? this.items.find((f) => f.id === id) : undefined;
  }
  on(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.items));
    } catch {
      /* storage blocked: keep in memory */
    }
    this.listeners.forEach((f) => f());
  }

  add(f: Omit<Filament, 'id' | 'source'> & Partial<Pick<Filament, 'source' | 'tray'>>) {
    const item: Filament = { source: 'manual', ...f, id: Math.random().toString(36).slice(2, 9) };
    this.items.push(item);
    this.save();
    return item;
  }
  update(id: string, patch: Partial<Filament>) {
    const f = this.get(id);
    if (!f) return;
    Object.assign(f, patch);
    this.save();
  }
  remove(id: string) {
    this.items = this.items.filter((f) => f.id !== id);
    this.save();
  }

  /**
   * Replace the filaments read from the AMS with the current trays. Ids of
   * filaments that stay in the same slot with the same colour are kept, so
   * objects painted with them are not orphaned.
   */
  syncAms(trays: { id: number; color: string | null; type: string; name: string; empty: boolean }[]) {
    const old = this.items.filter((f) => f.source === 'ams');
    const next: Filament[] = [];
    for (const t of trays) {
      if (t.empty || !t.color) continue;
      const prev = old.find((f) => f.tray === t.id && f.color === t.color && f.type === (t.type || 'PLA'));
      next.push(prev ?? { id: Math.random().toString(36).slice(2, 9), source: 'ams', tray: t.id, color: t.color, type: t.type || 'PLA', name: t.name || t.type || 'Filamento' });
    }
    this.items = [...this.items.filter((f) => f.source !== 'ams'), ...next];
    this.save();
    return next;
  }
}

export const filaments = new FilamentStore();

// ---------- colour helpers ----------

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0x888888;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** "Redmean" distance: close to perceived difference, cheap, no Lab conversion. */
export function colorDistance(a: string, b: string) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const rm = (r1 + r2) / 2;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

/** Nearest item by colour; `max` rejects matches that would look wrong. */
export function nearestByColor<T extends { color: string | null }>(color: string, items: readonly T[], max = Infinity): T | undefined {
  let best: T | undefined;
  let bestD = max;
  for (const it of items) {
    if (!it.color) continue;
    const d = colorDistance(color, it.color);
    if (d <= bestD) {
      best = it;
      bestD = d;
    }
  }
  return best;
}

/** Colours closer than this look like "the same" to most people. */
export const MATCH_DISTANCE = 120;
