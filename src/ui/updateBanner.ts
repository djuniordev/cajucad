import { desktop } from '../desktop';
import { el, esc, toast } from './dom';

/** Bottom bar that offers a new version, shows the download and asks to restart. */
export function initUpdateBanner() {
  if (!desktop?.update) return;
  let bar: HTMLElement | null = null;
  const close = () => {
    bar?.remove();
    bar = null;
  };
  const show = (html: string) => {
    bar ??= document.body.appendChild(el('<div class="update-bar"></div>'));
    bar.innerHTML = html;
  };

  desktop.update.onState((s) => {
    if (s.status === 'available') {
      show(`<span>Nova versão <b>${esc(s.version)}</b> disponível.</span><button data-a="get">Baixar</button><button data-a="later" class="ghost">Depois</button>`);
    } else if (s.status === 'downloading') {
      show(`<span>Baixando atualização… <b>${s.percent}%</b></span>`);
    } else if (s.status === 'ready') {
      show(`<span>Versão <b>${esc(s.version)}</b> pronta.</span><button data-a="install">Reiniciar e atualizar</button><button data-a="later" class="ghost">Depois</button>`);
    } else {
      close();
      toast(`Não foi possível atualizar: ${s.message}`, 'error', 5000);
    }
    bar?.querySelector('[data-a=get]')?.addEventListener('click', () => {
      show('<span>Baixando atualização…</span>');
      desktop!.update.download().catch(() => {});
    });
    bar?.querySelector('[data-a=install]')?.addEventListener('click', () => desktop!.update.install());
    bar?.querySelector('[data-a=later]')?.addEventListener('click', close);
  });
}
