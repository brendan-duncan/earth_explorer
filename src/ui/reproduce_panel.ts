/**
 * "Get this data" panel for the GIS explorer.
 *
 * The map answers questions; this panel hands over the means to check the answers. It shows the
 * exact griddap request behind the frame on screen, in the formats a working scientist actually
 * needs next — a NetCDF URL, a CSV URL, ERDDAP's own browse page, an xarray snippet, an R snippet,
 * and a citation carrying the access date. Nothing here is a reconstruction: every artifact is
 * built from the same request the loader issued, so what someone downloads is what they were
 * looking at.
 *
 * Self-contained like the other explorer panels: the host supplies a context getter and appends
 * {@link ReproducePanel.open} wherever it likes.
 */

import {
  citationText, griddapUrl, pythonSnippet, rSnippet,
  type CitationFields, type ReproduceContext,
} from '../live/reproduce.js';

export interface ReproducePanelOptions {
  /**
   * The request behind the CURRENT view, or a reason there isn't one (baked atlases have no live
   * query to hand over). Called fresh on every open, so the panel always describes what is on
   * screen rather than whatever was showing when it was built.
   */
  context: () => { ctx: ReproduceContext; cite?: CitationFields } | { unavailable: string };
  /** Makes a panel draggable by its header, matching the explorer's other floating panels. */
  makeDraggable?: (panel: HTMLElement, handle: HTMLElement) => void;
}

export interface ReproducePanel {
  /** Opens (or re-renders) the panel for the current view. */
  open(): void;
  toggle(): void;
}

export function installReproducePanel(opts: ReproducePanelOptions): ReproducePanel {
  const css = (el: HTMLElement, s: string): void => { el.style.cssText = s; };

  const panel = document.createElement('div');
  panel.id = 'reproduce-panel';
  css(panel, 'position:fixed;z-index:13;right:12px;top:64px;width:520px;max-width:92vw;max-height:78vh;'
    + 'overflow-y:auto;display:none;background:rgba(8,10,14,0.94);border-radius:6px;padding:10px 12px;'
    + 'font-family:ui-monospace,monospace;color:#dfeef0;font-size:12px;'
    + 'box-shadow:0 6px 32px rgba(0,0,0,0.6);border:1px solid rgba(94,240,200,0.22)');

  const header = document.createElement('div');
  css(header, 'display:flex;align-items:center;gap:8px;margin-bottom:8px;color:#5ef0c8;'
    + 'cursor:move;user-select:none;touch-action:none');
  const title = document.createElement('span');
  css(title, 'flex:1;letter-spacing:0.5px');
  title.textContent = 'Get this data';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  css(closeBtn, 'cursor:pointer;background:none;border:none;color:#889;font-size:14px;padding:0');
  closeBtn.addEventListener('click', () => { panel.style.display = 'none'; });
  header.append(title, closeBtn);

  const body = document.createElement('div');
  panel.append(header, body);
  document.body.appendChild(panel);
  opts.makeDraggable?.(panel, header);

  /** A copy button that confirms in place — no toast, no layout shift. */
  function copyBtn(label: string, text: () => string): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    css(b, 'cursor:pointer;background:#2a2a38;color:#5ef0c8;border:1px solid #444;border-radius:4px;'
      + 'padding:2px 8px;font-size:11px;font-family:inherit');
    b.addEventListener('click', () => {
      void navigator.clipboard?.writeText(text());
      const was = b.textContent;
      b.textContent = 'copied';
      setTimeout(() => { b.textContent = was; }, 1100);
    });
    return b;
  }

  function sectionTitle(text: string, note?: string): HTMLDivElement {
    const d = document.createElement('div');
    css(d, 'margin:10px 0 4px;color:#9fd8cf;letter-spacing:0.5px');
    d.textContent = text;
    if (note) {
      const n = document.createElement('span');
      css(n, 'color:#667;margin-left:8px;letter-spacing:0');
      n.textContent = note;
      d.appendChild(n);
    }
    return d;
  }

  /** A read-only code block with its own copy button. */
  function codeBlock(text: string): HTMLDivElement {
    const wrap = document.createElement('div');
    css(wrap, 'position:relative');
    const pre = document.createElement('pre');
    css(pre, 'margin:0;padding:7px 8px;background:rgba(255,255,255,0.05);border-radius:4px;'
      + 'overflow-x:auto;white-space:pre;font-size:11px;line-height:1.45;color:#cfe6e4');
    pre.textContent = text;
    const b = copyBtn('copy', () => text);
    css(b, 'position:absolute;top:5px;right:5px;cursor:pointer;background:#2a2a38;color:#5ef0c8;'
      + 'border:1px solid #444;border-radius:4px;padding:1px 7px;font-size:10px;font-family:inherit');
    wrap.append(pre, b);
    return wrap;
  }

  function linkRow(label: string, url: string): HTMLDivElement {
    const r = document.createElement('div');
    css(r, 'display:flex;align-items:center;gap:8px;margin:3px 0');
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = label;
    css(a, 'color:#5ef0c8;text-decoration:none;flex:none;width:120px');
    const u = document.createElement('span');
    css(u, 'flex:1;color:#8fa5ab;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px');
    u.textContent = url;
    r.append(a, u, copyBtn('copy', () => url));
    return r;
  }

  function render(): void {
    body.textContent = '';
    const got = opts.context();
    if ('unavailable' in got) {
      const p = document.createElement('div');
      css(p, 'color:#8fa5ab;line-height:1.5');
      p.textContent = got.unavailable;
      body.appendChild(p);
      return;
    }
    const { ctx, cite } = got;
    const accessed = new Date().toISOString().slice(0, 10);

    // What this is, before how to get it.
    const summary = document.createElement('div');
    css(summary, 'color:#8fa5ab;line-height:1.5');
    summary.textContent = `${ctx.layerLabel} · variable ${ctx.request.variable} · `
      + `${ctx.request.timeSel.replace(/[()]/g, '')} · `
      + `${ctx.box ? 'region drawn on the map' : 'global'}`
      + `${ctx.resolutionDeg ? ` · ~${ctx.resolutionDeg.toFixed(2)}° cells` : ''}`;
    body.appendChild(summary);

    body.appendChild(sectionTitle('Download', 'the exact frame on screen'));
    body.appendChild(linkRow('NetCDF (.nc)', griddapUrl(ctx.request, 'nc')));
    body.appendChild(linkRow('CSV', griddapUrl(ctx.request, 'csv')));
    body.appendChild(linkRow('Browse on ERDDAP', griddapUrl(ctx.request, 'htmlTable')));
    body.appendChild(linkRow('Dataset page', griddapUrl(ctx.request, 'graph')));

    body.appendChild(sectionTitle('Python'));
    body.appendChild(codeBlock(pythonSnippet(ctx)));

    body.appendChild(sectionTitle('R'));
    body.appendChild(codeBlock(rSnippet(ctx)));

    if (cite) {
      body.appendChild(sectionTitle('Cite', 'includes the access date — these feeds are revised'));
      body.appendChild(codeBlock(citationText(cite, ctx, accessed)));
    }
  }

  return {
    open(): void {
      render();
      panel.style.display = 'block';
    },
    toggle(): void {
      if (panel.style.display === 'block') {
        panel.style.display = 'none';
      } else {
        render();
        panel.style.display = 'block';
      }
    },
  };
}
