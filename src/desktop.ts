/** Native services available when CajuCAD runs as the desktop app. */

export interface BambuInfo {
  available: boolean;
  exe?: string;
  /** 'studio' = installed Bambu Studio, 'bundled' = engine shipped with CajuCAD. */
  engine?: 'studio' | 'bundled';
  printers?: string[];
  defaultPrinter?: string;
  bedTypes?: string[];
  defaultBedType?: string;
}

export interface BambuPrinterInfo {
  bed: { width: number; depth: number };
  maxHeight: number;
  processes: string[];
  filaments: string[];
}

export interface SliceJob {
  printer: string;
  process: string;
  slice: boolean;
  objects: { name: string; filament: number; stl: ArrayBuffer }[];
  slots: { preset: string; color: string; type: string }[];
  overrides: { infill?: string; supports?: boolean; bedType?: string; tower?: { x: number; y: number } | null };
}

export interface Toolpaths {
  count: number;
  /** x0 y0 z0 x1 y1 z1 per segment, in bed coordinates (mm). */
  pos: Float32Array;
  /** Index into `types` per segment. */
  type: Uint8Array;
  /** Filament (0-based) per segment. */
  tool: Uint8Array;
  layer: Uint16Array;
  /** Names of the line types found ("Outer wall", "Support"...). */
  types: string[];
  layerZ: number[];
}

export interface SliceResult {
  id: string;
  size: number;
  seconds?: number;
  weightG?: number;
  filaments: { id: number; type: string; color: string; usedG?: number; usedM?: number }[];
  thumbnail: string | null;
  hasGcode: boolean;
  outsideBed: boolean;
  towerBox: number[] | null;
}

export interface FoundPrinter {
  ip: string;
  serial: string;
  name: string;
  model: string;
  lanMode: boolean;
}

export interface SavedPrinter {
  serial: string;
  ip: string;
  name: string;
  model: string;
  hasCode: boolean;
}

export interface PrinterTray {
  amsId: number;
  slot: number;
  id: number;
  color: string | null;
  type: string;
  name: string;
  remain: number | null;
  empty: boolean;
  external?: boolean;
}

export interface PrinterStatus {
  connected: boolean;
  gcodeState?: string | null;
  percent?: number | null;
  remainingMin?: number | null;
  layer?: number | null;
  totalLayers?: number | null;
  nozzle?: number | null;
  nozzleTarget?: number | null;
  bed?: number | null;
  bedTarget?: number | null;
  job?: string | null;
  trays?: PrinterTray[];
  external?: PrinterTray | null;
  hasAms?: boolean;
  /** microSD present; null/undefined = the printer did not say. */
  sdcard?: boolean | null;
}

export type UpdateState =
  | { status: 'available'; version: string }
  | { status: 'downloading'; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string };

export interface DesktopApi {
  platform: string;
  update: {
    download(): Promise<void>;
    install(): Promise<void>;
    onState(fn: (s: UpdateState) => void): () => void;
  };
  listFonts(): Promise<{ id: string; family: string; style: string }[]>;
  readFont(id: string): Promise<ArrayBuffer>;
  setTheme(dark: boolean): void;
  bambu: {
    info(): Promise<BambuInfo>;
    printerInfo(name: string): Promise<BambuPrinterInfo>;
    slice(job: SliceJob): Promise<SliceResult>;
    saveProject(args: { jobId: string; name: string; kind: 'project' | 'gcode' }): Promise<string | null>;
    /** Extruded segments of a sliced job in print order (x0 y0 z0 x1 y1 z1 each). */
    toolpaths(jobId: string, bed?: { width: number; depth: number }): Promise<Toolpaths>;
    onProgress(fn: (msg: string) => void): () => void;
  };
  printers: {
    discover(): Promise<FoundPrinter[]>;
    saved(): Promise<SavedPrinter[]>;
    forget(serial: string): Promise<void>;
    connect(args: { serial: string; ip?: string; name?: string; model?: string; accessCode?: string; remember?: boolean }): Promise<{ ok: boolean }>;
    disconnect(): Promise<void>;
    print(args: { jobId: string; name: string }): Promise<{ remoteName: string }>;
    control(action: 'pause' | 'resume' | 'stop'): Promise<void>;
    onStatus(fn: (s: PrinterStatus) => void): () => void;
    onUpload(fn: (progress: number) => void): () => void;
  };
}

declare global {
  interface Window {
    opencad?: DesktopApi;
  }
}

export const desktop: DesktopApi | undefined = window.opencad;
export const isDesktop = !!desktop;
