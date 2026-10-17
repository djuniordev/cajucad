import { DesignDoc, SceneNode, emptyDoc } from './types';

type Listener = () => void;

const HISTORY_LIMIT = 120;

export const uid = () => Math.random().toString(36).slice(2, 10);

export const clone = <T>(v: T): T => structuredClone(v);

/**
 * Single source of truth for the design. Every change goes through `commit`,
 * which snapshots the previous document for undo.
 */
class Store {
  doc: DesignDoc = emptyDoc();
  selection = new Set<string>();
  private past: string[] = [];
  private future: string[] = [];
  private docListeners = new Set<Listener>();
  private selListeners = new Set<Listener>();

  onDoc(fn: Listener) {
    this.docListeners.add(fn);
    return () => this.docListeners.delete(fn);
  }
  onSelection(fn: Listener) {
    this.selListeners.add(fn);
    return () => this.selListeners.delete(fn);
  }
  private emitDoc() {
    this.docListeners.forEach((f) => f());
  }
  private emitSel() {
    this.selListeners.forEach((f) => f());
  }

  /** Apply a mutation as one undoable step. */
  commit(mutate: (doc: DesignDoc) => void) {
    this.past.push(JSON.stringify(this.doc));
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
    mutate(this.doc);
    this.pruneSelection();
    this.emitDoc();
  }

  /** Replace the whole document (open file, restore autosave). */
  load(doc: DesignDoc, resetHistory = true) {
    this.doc = doc;
    if (resetHistory) {
      this.past = [];
      this.future = [];
    }
    this.selection.clear();
    this.emitDoc();
    this.emitSel();
  }

  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }

  undo() {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(prev);
    this.pruneSelection();
    this.emitDoc();
  }

  redo() {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(next);
    this.pruneSelection();
    this.emitDoc();
  }

  select(ids: string[], additive = false) {
    if (!additive) this.selection.clear();
    for (const id of ids) {
      if (additive && this.selection.has(id)) this.selection.delete(id);
      else this.selection.add(id);
    }
    this.emitSel();
  }

  clearSelection() {
    if (this.selection.size === 0) return;
    this.selection.clear();
    this.emitSel();
  }

  get selected(): SceneNode[] {
    return this.doc.nodes.filter((n) => this.selection.has(n.id));
  }

  find(id: string) {
    return this.doc.nodes.find((n) => n.id === id);
  }

  private pruneSelection() {
    // Always notify: selected nodes may have new transforms even if ids survive.
    const ids = new Set(this.doc.nodes.map((n) => n.id));
    for (const id of [...this.selection]) if (!ids.has(id)) this.selection.delete(id);
    this.emitSel();
  }
}

export const store = new Store();
