export type Theme = 'light' | 'dark' | 'system';

interface SettingsData {
  snap: number;
  snapAngle: number;
  localSpace: boolean;
  theme: Theme;
}

const KEY = 'open-cad:settings';
const defaults: SettingsData = { snap: 1, snapAngle: 15, localSpace: false, theme: 'system' };

function read(): SettingsData {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...defaults };
  }
}

/** User preferences, persisted per browser. */
class Settings {
  private data = read();
  private listeners = new Set<() => void>();

  get snap() { return this.data.snap; }
  get snapAngle() { return this.data.snapAngle; }
  get localSpace() { return this.data.localSpace; }
  get theme() { return this.data.theme; }

  set<K extends keyof SettingsData>(key: K, value: SettingsData[K]) {
    this.data[key] = value;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage blocked: keep in memory */
    }
    this.listeners.forEach((f) => f());
  }

  on(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const settings = new Settings();

export const SNAP_STEPS = [0, 0.1, 0.25, 0.5, 1, 2, 5, 10];
