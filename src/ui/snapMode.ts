import { snapTogether, type SurfaceHit } from '../core/assembly';
import { store } from '../core/store';
import type { Viewport } from '../view/viewport';
import { el, esc, toast } from './dom';

let viewport: Viewport | null = null;
let cancel: (() => void) | null = null;

export const setSnapViewport = (v: Viewport) => (viewport = v);

/** "Encaixar": click a face of the selected part, then a face of another part. */
export function startSnap(id: string) {
  if (!viewport) return;
  cancel?.();
  const vp = viewport;
  const hint = document.body.appendChild(el(`<div class="snap-hint glass"></div>`));
  const say = (msg: string) => (hint.innerHTML = `${esc(msg)} <span class="kbd">Esc</span> cancela`);
  const stop = () => {
    vp.surfacePick = null;
    hint.remove();
    window.removeEventListener('keydown', onKey, true);
    cancel = null;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    stop();
  };
  window.addEventListener('keydown', onKey, true);
  cancel = stop;

  let first: SurfaceHit | null = null;
  say('Clique na face desta peça que vai encostar.');
  vp.surfacePick = (hit) => {
    if (!first) {
      if (!hit || hit.id !== id) return toast('Clique numa face da peça selecionada.');
      first = hit;
      say('Agora clique na face da outra peça.');
      return;
    }
    if (!hit || hit.id === id) return toast('Clique numa face de outra peça.');
    if (store.find(id)?.locked) {
      stop();
      return toast('A peça está travada.', 'error');
    }
    stop();
    snapTogether(first, hit);
    toast('Peças encaixadas com junta rígida.');
  };
}
