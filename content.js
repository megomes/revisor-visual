/* Revisor Visual: content script.
   Marca elementos de uma pagina, guarda um comentario por marca e exporta tudo
   como prompt para o Claude Code. A sessão de revisão atravessa navegação,
   reload e páginas diferentes: o estado mora em chrome.storage.local. */
(() => {
  'use strict';
  if (window.__revisorVisualLoaded) return;
  window.__revisorVisualLoaded = true;

  const api = globalThis.chrome ?? globalThis.browser;
  const hasExt = !!(api && api.storage && api.storage.local && api.runtime && api.runtime.id);
  const KEY = 'rv_state';
  const ACCENT = '#ff7a45';

  const DEFAULTS = {
    active: false,
    sticky: false,      /* true: clique simples anota, false: exige o modificador */
    modifier: 'alt',    /* alt | shift | ctrl | meta */
    items: [],
    nextN: 1,
    panelPos: null,
    minimized: false
  };
  let S = Object.assign({}, DEFAULTS);
  let writingOurselves = false;

  /* ------------------------------------------------------------------ */
  /* estado                                                              */
  /* ------------------------------------------------------------------ */

  function loadState() {
    return new Promise((resolve) => {
      if (!hasExt) {
        let raw = {};
        try { raw = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (_) {}
        return resolve(Object.assign({}, DEFAULTS, raw));
      }
      let done = false;
      const cb = (o) => {
        if (done) return;
        done = true;
        resolve(Object.assign({}, DEFAULTS, (o && o[KEY]) || {}));
      };
      const r = api.storage.local.get(KEY, cb);
      if (r && typeof r.then === 'function') r.then(cb);
    });
  }

  function saveState() {
    if (!hasExt) {
      try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (_) {}
      return;
    }
    writingOurselves = true;
    try { api.storage.local.set({ [KEY]: S }); } catch (_) {}
    setTimeout(() => { writingOurselves = false; }, 60);
    try { api.runtime.sendMessage({ type: 'rv-count', n: S.items.length }); } catch (_) {}
  }

  /* ------------------------------------------------------------------ */
  /* identidade da página                                                */
  /* ------------------------------------------------------------------ */

  function pageUrl() {
    const u = location.href;
    const i = u.indexOf('#');
    return i === -1 ? u : u.slice(0, i);
  }

  function filePathOf(url) {
    if (!url.startsWith('file://')) return null;
    let p = url.slice('file://'.length);
    try { p = decodeURIComponent(p); } catch (_) {}
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);   /* file:///C:/... no Windows */
    return p;
  }

  /* ------------------------------------------------------------------ */
  /* leitura do elemento                                                 */
  /* ------------------------------------------------------------------ */

  const HASHY = /(^|[-_])([0-9a-f]{6,}|[a-z]{0,3}\d{4,})([-_]|$)/i;
  const GEN_PREFIX = /^(css|sc|jsx|emotion|styled|chakra|mui|ant|radix|headlessui|react-aria)[-_]/i;

  function stableClasses(el) {
    const list = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    return list
      .filter((c) => c.length <= 24 && !GEN_PREFIX.test(c) && !HASHY.test(c))
      .slice(0, 2);
  }

  function stableId(el) {
    const id = el.getAttribute('id');
    if (!id) return null;
    if (id.length > 40) return null;
    if (/^:r[0-9a-z]+:$/i.test(id)) return null;
    if (GEN_PREFIX.test(id) || HASHY.test(id)) return null;
    if (!/^[A-Za-z][\w:.-]*$/.test(id)) return null;
    return id;
  }

  /* nome amigável do elemento, do mais específico para o mais genérico */
  function kindOf(el) {
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (/^h[1-6]$/.test(tag)) return 'título';
    if (tag === 'button' || role === 'button') return 'botão';
    if (tag === 'a') return 'link';
    if (tag === 'img' || tag === 'picture' || tag === 'figure') return 'imagem';
    if (tag === 'svg' || tag === 'use' || tag === 'path') {
      const r = el.getBoundingClientRect();
      return (r.width <= 40 && r.height <= 40) ? 'ícone' : 'gráfico ou svg';
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return 'campo';
    if (tag === 'label') return 'rótulo de campo';
    if (tag === 'table') return 'tabela';
    if (tag === 'tr') return 'linha de tabela';
    if (tag === 'td' || tag === 'th') return 'célula';
    if (tag === 'ul' || tag === 'ol' || tag === 'dl') return 'lista';
    if (tag === 'li') return 'item de lista';
    if (tag === 'p') return 'parágrafo';
    if (tag === 'code' || tag === 'pre') return 'bloco de código';
    if (tag === 'blockquote') return 'citação';
    if (tag === 'nav') return 'navegação';
    if (tag === 'header') return 'cabeçalho';
    if (tag === 'footer') return 'rodapé';
    if (tag === 'aside') return 'barra lateral';
    if (tag === 'main') return 'conteúdo principal';
    if (tag === 'form') return 'formulário';
    if (tag === 'section' || tag === 'article') return 'seção';
    if (tag === 'span' || tag === 'strong' || tag === 'em' || tag === 'b' || tag === 'i') return 'trecho de texto';
    if (tag === 'div') {
      const cls = (el.getAttribute('class') || '').toLowerCase();
      if (/card|tile|box|panel|widget/.test(cls)) return 'cartão';
      return 'bloco';
    }
    return tag;
  }

  function cleanText(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function ownText(el) {
    let t = cleanText(el.innerText || '');
    if (!t) t = cleanText(el.textContent || '');
    return t;
  }

  function cut(s, max) {
    if (s.length <= max) return s;
    const head = s.slice(0, max);
    const sp = head.lastIndexOf(' ');
    return (sp > max * 0.6 ? head.slice(0, sp) : head) + '...';
  }

  /* texto que serve de âncora: prioriza o que existe literalmente no fonte */
  function anchorOf(el) {
    const t = ownText(el);
    if (t) return { text: cut(t, 90), from: 'texto' };
    const attrs = ['aria-label', 'alt', 'title', 'placeholder', 'value', 'data-testid'];
    for (const a of attrs) {
      const v = cleanText(el.getAttribute && el.getAttribute(a));
      if (v) return { text: cut(v, 90), from: a };
    }
    const src = el.getAttribute && (el.getAttribute('src') || el.getAttribute('href'));
    if (src) {
      const base = src.split('?')[0].split('/').filter(Boolean).pop();
      if (base) return { text: base, from: 'arquivo' };
    }
    return { text: '', from: 'sem texto' };
  }

  /* para elemento sem texto próprio: o rótulo curto mais próximo, que serve de
     ponto de referência para quem for procurar o trecho no arquivo */
  function nearbyOf(el) {
    const bom = (t) => t && t.length >= 2 && t.length <= 70;
    /* recipiente não serve de ponto de referência: o texto dele é a soma dos filhos */
    const RECIPIENTE = new Set(['table', 'thead', 'tbody', 'ul', 'ol', 'dl', 'section',
      'article', 'div', 'nav', 'form', 'header', 'footer', 'main', 'aside']);
    const serve = (e) => !RECIPIENTE.has(e.tagName.toLowerCase()) && e.children.length <= 2;
    let sib = el.previousElementSibling, hops = 0;
    while (sib && hops < 4) {
      const t = ownText(sib);
      if (serve(sib) && bom(t)) return { text: t, como: 'elemento logo antes' };
      sib = sib.previousElementSibling; hops++;
    }
    const heads = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'));
    let ultimo = null;
    for (const h of heads) {
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) ultimo = h;
    }
    if (ultimo) {
      const t = ownText(ultimo);
      if (bom(t)) return { text: t, como: 'título acima' };
    }
    let p = el.parentElement, up = 0;
    while (p && up < 3) {
      const t = ownText(p);
      if (bom(t)) return { text: t, como: 'bloco em volta' };
      p = p.parentElement; up++;
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* caminho CSS verificado                                              */
  /* ------------------------------------------------------------------ */

  function segmentFor(el, useNth) {
    let seg = el.tagName.toLowerCase();
    const id = stableId(el);
    if (id) return seg + '#' + CSS.escape(id);
    const cls = stableClasses(el);
    if (cls.length) seg += '.' + cls.map((c) => CSS.escape(c)).join('.');
    if (useNth && el.parentElement) {
      const same = Array.from(el.parentElement.children).filter((c) => c.tagName === el.tagName);
      if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
    }
    return seg;
  }

  /* sobe a árvore até o caminho identificar o elemento sozinho, no máximo 8 níveis */
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    let cur = el;
    for (let depth = 0; depth < 8 && cur && cur.nodeType === 1; depth++) {
      const hasId = !!stableId(cur);
      const noTopo = (cur === document.body || cur === document.documentElement);
      parts.unshift(segmentFor(cur, true));
      const path = parts.join(' > ');
      let hit = null;
      try { hit = document.querySelectorAll(path); } catch (_) { hit = null; }
      const unico = !!(hit && hit.length === 1 && hit[0] === el);
      /* caminho de um segmento só ("img") é único mas não diz nada a quem lê:
         continua subindo até 3 segmentos, ou até um id, ou até o topo */
      if (unico && (parts.length >= 3 || hasId || noTopo)) return path;
      if (hasId || noTopo) break;
      cur = cur.parentElement;
    }
    const path = parts.join(' > ');
    try {
      const hit = document.querySelectorAll(path);
      if (hit.length === 1 && hit[0] === el) return path;
      const idx = Array.prototype.indexOf.call(hit, el);
      if (idx >= 0) return path + '   /* ' + (idx + 1) + 'a de ' + hit.length + ' correspondências */';
    } catch (_) {}
    return path;
  }

  /* ancestral que serve de referência na frase "em X" */
  function anchorAncestor(el) {
    const SEMANTIC = new Set(['section', 'article', 'nav', 'header', 'footer', 'main', 'aside', 'form', 'table', 'dialog']);
    let p = el.parentElement, hops = 0;
    while (p && hops < 6) {
      const id = stableId(p);
      const tag = p.tagName.toLowerCase();
      if (id) return tag + '#' + id;
      if (SEMANTIC.has(tag)) {
        const cls = stableClasses(p);
        return cls.length ? tag + '.' + cls[0] : tag;
      }
      p = p.parentElement; hops++;
    }
    return null;
  }

  /* como o elemento aparece no export: <button class="btn-export"> */
  function tagSignature(el) {
    const tag = el.tagName.toLowerCase();
    const id = stableId(el);
    const cls = stableClasses(el);
    let s = '<' + tag;
    if (id) s += ' id="' + id + '"';
    else if (cls.length) s += ' class="' + cls.join(' ') + '"';
    else if (tag === 'img' || tag === 'a') {
      const src = el.getAttribute('src') || el.getAttribute('href') || '';
      const base = src.split('?')[0].split('/').filter(Boolean).pop();
      if (base) s += (tag === 'img' ? ' src=".../' : ' href=".../') + base + '"';
    }
    return s + '>';
  }

  /* ------------------------------------------------------------------ */
  /* captura de um item                                                  */
  /* ------------------------------------------------------------------ */

  function occurrences(text) {
    if (!text || text.length < 3) return 1;
    const body = cleanText(document.body ? document.body.innerText : '');
    if (!body) return 1;
    let n = 0, i = 0;
    while ((i = body.indexOf(text, i)) !== -1) { n++; i += text.length; }
    return n || 1;
  }

  function selectionInside(el) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const txt = cleanText(sel.toString());
    if (txt.length < 2) return null;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer) &&
        el !== range.commonAncestorContainer) return null;
    return txt;
  }

  /* monta o item a partir do elemento clicado, e da seleção de texto se houver */
  function captureFrom(el, selectedText) {
    const isSel = !!selectedText;
    const anchor = isSel ? { text: cut(selectedText, 120), from: 'seleção' } : anchorOf(el);
    let context = null;
    if (isSel) {
      const full = ownText(el);
      const at = full.indexOf(anchor.text.replace(/\.\.\.$/, ''));
      if (at !== -1) {
        const from = Math.max(0, at - 60);
        const to = Math.min(full.length, at + anchor.text.length + 60);
        context = (from > 0 ? '...' : '') +
          full.slice(from, at) + '\u00ab' + full.slice(at, at + anchor.text.length) + '\u00bb' +
          full.slice(at + anchor.text.length, to) +
          (to < full.length ? '...' : '');
      }
    }
    const url = pageUrl();
    return {
      id: 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      n: S.nextN,
      url,
      filePath: filePathOf(url),
      pageTitle: document.title || '(sem título)',
      kind: isSel ? 'trecho de texto' : kindOf(el),
      tagSig: tagSignature(el),
      inside: anchorAncestor(el),
      anchor: anchor.text,
      anchorFrom: anchor.from,
      nearby: anchor.text ? null : nearbyOf(el),
      context,
      path: cssPath(el),
      occurrences: occurrences(anchor.text),
      comment: '',
      createdAt: new Date().toISOString()
    };
  }

  /* reencontra o elemento de um item nesta página */
  function resolveItem(it) {
    if (it.url !== pageUrl()) return null;
    const path = (it.path || '').split('   /*')[0].trim();
    if (path) {
      let el = null;
      try { el = document.querySelector(path); } catch (_) {}
      if (el) return el;
    }
    if (it.anchor && it.anchor.length > 3) {
      const needle = it.anchor.replace(/\.\.\.$/, '');
      const all = document.body ? document.body.querySelectorAll('*') : [];
      for (const el of all) {
        if (el.children.length > 3) continue;
        if (ownText(el).startsWith(needle)) return el;
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* export                                                              */
  /* ------------------------------------------------------------------ */

  const PREAMBLE_BASE =
    'Cada item traz uma âncora, que é o texto como ele aparece na página e, em geral,\n' +
    'literalmente no arquivo fonte, mais um caminho CSS que confirma o alvo. Ache o\n' +
    'trecho pela âncora, confirme pelo caminho e aplique o pedido. Não altere nada\n' +
    'fora do que está listado.';
  const PREAMBLE_CTX =
    '\nNa linha Contexto, o que está entre \u00ab \u00bb é exatamente o trecho selecionado.';

  function stamp(d) {
    const p = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function buildExport(items) {
    const list = items.filter((i) => (i.comment || '').trim());
    if (!list.length) return '';
    const groups = [];
    const byUrl = new Map();
    for (const it of list) {
      if (!byUrl.has(it.url)) { const g = { url: it.url, filePath: it.filePath, title: it.pageTitle, items: [] }; byUrl.set(it.url, g); groups.push(g); }
      byUrl.get(it.url).items.push(it);
    }
    const out = [];
    const plural = list.length === 1 ? 'item' : 'itens';
    const pg = groups.length === 1 ? 'página' : 'páginas';
    out.push('# Revisão visual: ' + list.length + ' ' + plural + ' em ' + groups.length + ' ' + pg);
    out.push('Gerado em ' + stamp(new Date()) + '.');
    out.push('');
    out.push(PREAMBLE_BASE + (list.some((i) => i.context) ? PREAMBLE_CTX : ''));
    out.push('');
    groups.forEach((g, gi) => {
      out.push('## Página ' + (gi + 1) + ': ' + g.title);
      out.push(g.filePath ? 'Arquivo: ' + g.filePath : 'URL: ' + g.url);
      out.push('');
      for (const it of g.items) {
        let head = '### ' + it.n + ' \u00b7 ' + it.kind + ' ' + it.tagSig;
        if (it.inside) head += ' em ' + it.inside;
        out.push(head);
        if (it.anchor) {
          out.push('Âncora: "' + it.anchor + '"' +
            (it.anchorFrom !== 'texto' && it.anchorFrom !== 'seleção' ? '  (vem de ' + it.anchorFrom + ')' : ''));
        } else {
          out.push('Âncora: nenhuma, o elemento não tem texto próprio.');
          if (it.nearby) out.push('Perto de: "' + it.nearby.text + '" (' + it.nearby.como + ')');
        }
        if (it.context) out.push('Contexto: ' + it.context);
        if (it.path) out.push('Caminho: ' + it.path);
        if (it.occurrences > 1) out.push('Atenção: esse texto aparece ' + it.occurrences + ' vezes na página. Desempate pelo caminho.');
        out.push('Pedido: ' + it.comment.trim().replace(/\n/g, '\n  '));
        out.push('');
      }
    });
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  /* exposto para teste fora da extensão */
  window.__rv = { captureFrom, buildExport, cssPath, anchorOf, kindOf, resolveItem,
    get state() { return S; }, set state(v) { S = v; } };
  /* setActive e renderPanel entram em __rv mais abaixo, quando já existem */

  /* ------------------------------------------------------------------ */
  /* casca da interface (shadow DOM, isolada do CSS da página)            */
  /* ------------------------------------------------------------------ */

  const CSS_TEXT = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .layer { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; }
  .hi { position: fixed; border: 2px solid ${ACCENT}; border-radius: 3px;
        background: rgba(255,122,69,.10); pointer-events: none; display: none; }
  .chip { position: fixed; background: ${ACCENT}; color: #1a1208; padding: 1px 7px;
          border-radius: 4px; font: 600 11px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace;
          white-space: nowrap; pointer-events: none; display: none; max-width: 60vw;
          overflow: hidden; text-overflow: ellipsis; }
  .badge { position: fixed; min-width: 22px; height: 22px; padding: 0 5px; border-radius: 11px;
           background: ${ACCENT}; color: #1a1208; font: 700 12px/22px ui-sans-serif, sans-serif;
           text-align: center; pointer-events: auto; cursor: pointer;
           box-shadow: 0 1px 8px rgba(0,0,0,.45); user-select: none; }
  .badge.perdido { background: #6b7280; color: #e5e7eb; }

  .box { position: fixed; width: 340px; background: #15171c; border: 1px solid #3a4049;
         border-radius: 10px; padding: 10px; pointer-events: auto; color: #e7e9ee;
         box-shadow: 0 14px 44px rgba(0,0,0,.6); }
  .box .alvo { font: 600 11px/1.5 ui-monospace, Menlo, monospace; color: ${ACCENT};
               margin-bottom: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .box textarea { width: 100%; height: 88px; resize: vertical; background: #0e1014; color: #e7e9ee;
                  border: 1px solid #3a4049; border-radius: 6px; padding: 8px; font-size: 13px;
                  line-height: 1.45; outline: none; }
  .box textarea:focus { border-color: ${ACCENT}; }
  .box .rodape { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .box .dica { flex: 1; font-size: 10.5px; color: #8b93a1; line-height: 1.35; }

  button.b { background: #262b33; color: #e7e9ee; border: 1px solid #3a4049; border-radius: 6px;
             padding: 5px 10px; font-size: 12px; cursor: pointer; }
  button.b:hover { background: #313843; }
  button.b.pri { background: ${ACCENT}; border-color: ${ACCENT}; color: #1a1208; font-weight: 600; }
  button.b.pri:hover { filter: brightness(1.08); }
  button.b:disabled { opacity: .45; cursor: default; }

  .painel { position: fixed; width: 350px; max-height: 76vh; display: flex; flex-direction: column;
            background: #15171c; color: #e7e9ee; border: 1px solid #3a4049; border-radius: 12px;
            pointer-events: auto; box-shadow: 0 18px 54px rgba(0,0,0,.65); font-size: 13px;
            overflow: hidden; }
  .cab { display: flex; align-items: center; gap: 8px; padding: 9px 11px; cursor: grab;
         background: #1b1e25; border-bottom: 1px solid #2c323a; user-select: none; }
  .cab .pt { width: 8px; height: 8px; border-radius: 50%; background: ${ACCENT}; flex: none; }
  .cab h1 { font: 600 13px/1 ui-sans-serif, sans-serif; margin: 0; flex: 1; }
  .cab .n { font: 600 11px/1 ui-monospace, monospace; color: #8b93a1; }
  .cab button { background: none; border: none; color: #8b93a1; cursor: pointer; font-size: 15px;
                line-height: 1; padding: 2px 4px; }
  .cab button:hover { color: #e7e9ee; }

  .opcoes { display: flex; align-items: center; gap: 10px; padding: 8px 11px; flex-wrap: wrap;
            border-bottom: 1px solid #2c323a; font-size: 11.5px; color: #a9b1bf; }
  .opcoes label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
  .opcoes select { background: #0e1014; color: #e7e9ee; border: 1px solid #3a4049;
                   border-radius: 4px; font-size: 11px; padding: 2px 4px; }

  .lista { overflow-y: auto; flex: 1; padding: 6px; }
  .vazio { padding: 22px 14px; text-align: center; color: #8b93a1; font-size: 12px; line-height: 1.6; }
  .grupo { font: 600 10.5px/1 ui-sans-serif, sans-serif; color: #8b93a1; text-transform: uppercase;
           letter-spacing: .06em; padding: 9px 6px 5px; }
  .it { display: flex; gap: 8px; padding: 7px; border-radius: 7px; cursor: pointer; }
  .it:hover { background: #1e222a; }
  .it .num { flex: none; width: 20px; height: 20px; border-radius: 10px; background: ${ACCENT};
             color: #1a1208; font: 700 11px/20px ui-sans-serif, sans-serif; text-align: center; }
  .it.perdido .num { background: #4b5563; color: #d1d5db; }
  .it .txt { flex: 1; min-width: 0; }
  .it .alvo2 { font: 600 11px/1.4 ui-monospace, Menlo, monospace; color: #b9c0cc;
               white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .it .cm { font-size: 12px; line-height: 1.45; color: #e7e9ee; margin-top: 2px;
            display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .it .x { flex: none; background: none; border: none; color: #6b7280; cursor: pointer; font-size: 14px;
           line-height: 1; padding: 0 2px; align-self: flex-start; }
  .it .x:hover { color: #ef4444; }

  .pe { display: flex; gap: 6px; padding: 9px; border-top: 1px solid #2c323a; background: #1b1e25; }
  .pe button { flex: 1; }
  .pill { position: fixed; pointer-events: auto; background: ${ACCENT}; color: #1a1208;
          border-radius: 20px; padding: 7px 13px; font: 600 12px/1 ui-sans-serif, sans-serif;
          cursor: pointer; box-shadow: 0 8px 26px rgba(0,0,0,.5); user-select: none; }
  .aviso { position: fixed; left: 50%; transform: translateX(-50%); top: 14px; background: #15171c;
           color: #e7e9ee; border: 1px solid ${ACCENT}; border-radius: 8px; padding: 8px 14px;
           font-size: 12.5px; pointer-events: none; box-shadow: 0 10px 30px rgba(0,0,0,.6); }
  `;

  let host = null, root = null, layer = null, hiEl = null, chipEl = null,
      badgeWrap = null, panelEl = null, boxEl = null;

  function buildShell() {
    host = document.createElement('div');
    host.id = 'revisor-visual-host';
    host.style.cssText = 'all:initial;position:static';
    root = host.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS_TEXT);
      root.adoptedStyleSheets = [sheet];
    } catch (_) {
      const st = document.createElement('style');
      st.textContent = CSS_TEXT;
      root.appendChild(st);
    }
    layer = document.createElement('div');
    layer.className = 'layer';
    hiEl = document.createElement('div'); hiEl.className = 'hi';
    chipEl = document.createElement('div'); chipEl.className = 'chip';
    badgeWrap = document.createElement('div');
    layer.append(hiEl, chipEl, badgeWrap);
    root.appendChild(layer);
    (document.body || document.documentElement).appendChild(host);
  }

  function flash(msg, ms) {
    const a = document.createElement('div');
    a.className = 'aviso';
    a.textContent = msg;
    layer.appendChild(a);
    setTimeout(() => a.remove(), ms || 1800);
  }

  /* ------------------------------------------------------------------ */
  /* seleção do alvo                                                     */
  /* ------------------------------------------------------------------ */

  let hovered = null;    /* elemento sob o cursor, já com o nível aplicado */
  let baseEl = null;     /* elemento mais profundo sob o cursor */
  let level = 0;         /* quantos níveis acima do base */
  let modDown = false;
  let lastMouse = { x: 0, y: 0 };

  function modKeyOf(e) {
    switch (S.modifier) {
      case 'shift': return e.shiftKey;
      case 'ctrl': return e.ctrlKey;
      case 'meta': return e.metaKey;
      default: return e.altKey;
    }
  }

  function pickingNow() {
    return S.active && !boxEl && (S.sticky || modDown);
  }

  function applyLevel() {
    let el = baseEl;
    for (let i = 0; i < level && el && el.parentElement &&
         el.parentElement !== document.documentElement; i++) el = el.parentElement;
    hovered = el;
  }

  function paintHighlight() {
    if (!hovered || !pickingNow()) { hiEl.style.display = 'none'; chipEl.style.display = 'none'; return; }
    const r = hovered.getBoundingClientRect();
    hiEl.style.display = 'block';
    hiEl.style.left = r.left + 'px';
    hiEl.style.top = r.top + 'px';
    hiEl.style.width = Math.max(r.width, 2) + 'px';
    hiEl.style.height = Math.max(r.height, 2) + 'px';
    const cls = stableClasses(hovered);
    const id = stableId(hovered);
    let label = kindOf(hovered) + ' · <' + hovered.tagName.toLowerCase() +
      (id ? '#' + id : (cls.length ? '.' + cls.join('.') : '')) + '>';
    if (level > 0) label += ' · ' + level + ' nível' + (level > 1 ? 'is' : '') + ' acima';
    chipEl.textContent = label;
    chipEl.style.display = 'block';
    const top = r.top > 22 ? r.top - 21 : r.bottom + 3;
    chipEl.style.left = Math.max(2, Math.min(r.left, innerWidth - 240)) + 'px';
    chipEl.style.top = top + 'px';
  }

  let rafPending = false;
  function scheduleLayout() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; paintHighlight(); paintBadges(); });
  }

  function onMove(e) {
    lastMouse = { x: e.clientX, y: e.clientY };
    if (!pickingNow()) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === host || host.contains(el)) return;
    if (el !== baseEl) { baseEl = el; level = 0; applyLevel(); }
    scheduleLayout();
  }

  /* ------------------------------------------------------------------ */
  /* caixa de comentário                                                 */
  /* ------------------------------------------------------------------ */

  let pending = null;      /* item em edição */
  let pendingEl = null;    /* elemento alvo do item em edição */
  let editingId = null;    /* id de um item existente sendo reeditado */

  function closeBox() {
    if (boxEl) { boxEl.remove(); boxEl = null; }
    pending = null; pendingEl = null; editingId = null;
    scheduleLayout();
  }

  function openBox(el, selectedText, existing) {
    closeBox();
    pendingEl = el;
    if (existing) { pending = existing; editingId = existing.id; }
    else { pending = captureFrom(el, selectedText); }

    boxEl = document.createElement('div');
    boxEl.className = 'box';
    const alvo = document.createElement('div');
    alvo.className = 'alvo';
    const ta = document.createElement('textarea');
    ta.value = pending.comment || '';
    ta.placeholder = 'O que mudar aqui?';
    const rod = document.createElement('div');
    rod.className = 'rodape';
    const dica = document.createElement('div');
    dica.className = 'dica';
    dica.textContent = 'Enter salva, Shift+Enter quebra linha, Esc cancela. Alt + seta para cima ou para baixo muda o alvo.';
    const ok = document.createElement('button');
    ok.className = 'b pri'; ok.textContent = 'Salvar';
    const no = document.createElement('button');
    no.className = 'b'; no.textContent = 'Cancelar';
    rod.append(dica, no, ok);
    boxEl.append(alvo, ta, rod);
    layer.appendChild(boxEl);

    function refreshAlvo() {
      alvo.textContent = pending.n + ' · ' + pending.kind + ' ' + pending.tagSig +
        (pending.anchor ? ' · "' + cut(pending.anchor, 40) + '"' : '');
    }
    function retarget(dir) {
      if (editingId) return;
      let el2 = pendingEl;
      if (dir > 0) { if (el2.parentElement && el2.parentElement !== document.documentElement) el2 = el2.parentElement; }
      else {
        const inside = Array.from(el2.children).find((c) => !host.contains(c));
        if (inside) el2 = inside;
      }
      if (el2 === pendingEl) return;
      pendingEl = el2;
      const keep = ta.value;
      pending = captureFrom(el2, null);
      pending.comment = keep;
      refreshAlvo(); place(); paintTargetBox();
    }
    function paintTargetBox() {
      const r = pendingEl.getBoundingClientRect();
      hiEl.style.display = 'block';
      hiEl.style.left = r.left + 'px'; hiEl.style.top = r.top + 'px';
      hiEl.style.width = Math.max(r.width, 2) + 'px'; hiEl.style.height = Math.max(r.height, 2) + 'px';
      chipEl.style.display = 'none';
    }
    function place() {
      const r = pendingEl.getBoundingClientRect();
      let left = Math.min(Math.max(8, r.left), innerWidth - 348);
      let top = r.bottom + 8;
      if (top + 170 > innerHeight) top = Math.max(8, r.top - 178);
      boxEl.style.left = left + 'px';
      boxEl.style.top = top + 'px';
    }
    function commit() {
      const v = ta.value.trim();
      if (!v) { closeBox(); return; }
      pending.comment = v;
      if (editingId) {
        const i = S.items.findIndex((x) => x.id === editingId);
        if (i >= 0) S.items[i] = pending;
      } else {
        S.items.push(pending);
        S.nextN = pending.n + 1;
      }
      saveState(); closeBox(); renderPanel();
    }

    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeBox(); }
      else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault(); e.stopPropagation(); retarget(e.key === 'ArrowUp' ? 1 : -1);
      }
    });
    ok.addEventListener('click', commit);
    no.addEventListener('click', closeBox);

    refreshAlvo(); place(); paintTargetBox();
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
  }

  /* ------------------------------------------------------------------ */
  /* marcadores numerados                                                */
  /* ------------------------------------------------------------------ */

  let resolved = new Map();   /* id do item -> elemento nesta página */

  function clearBadges() {
    badgeWrap.innerHTML = '';
    badgeWrap.dataset.sig = '';
  }

  function resolveAll() {
    resolved = new Map();
    const url = pageUrl();
    for (const it of S.items) {
      if (it.url !== url) continue;
      const el = resolveItem(it);
      if (el) resolved.set(it.id, el);
    }
  }

  function paintBadges() {
    if (!S.active) { clearBadges(); return; }
    const url = pageUrl();
    const mine = S.items.filter((i) => i.url === url);
    /* compara a lista de ids, não só a quantidade: trocar um item por outro
       mantinha o marcador antigo na tela */
    const assinatura = mine.map((i) => i.id + ':' + i.n).join('|');
    if (badgeWrap.dataset.sig !== assinatura) {
      badgeWrap.dataset.sig = assinatura;
      badgeWrap.innerHTML = '';
      for (const it of mine) {
        const b = document.createElement('div');
        b.className = 'badge' + (resolved.has(it.id) ? '' : ' perdido');
        b.textContent = it.n;
        b.title = resolved.has(it.id) ? it.comment : 'Elemento não encontrado nesta versão da página';
        b.dataset.id = it.id;
        b.addEventListener('click', (e) => {
          e.stopPropagation(); e.preventDefault();
          const el = resolved.get(it.id);
          if (el) openBox(el, null, JSON.parse(JSON.stringify(it)));
        });
        badgeWrap.appendChild(b);
      }
    }
    for (const b of badgeWrap.children) {
      const el = resolved.get(b.dataset.id);
      /* o elemento pode sumir ou reaparecer entre uma passada e outra, por
         exemplo depois de o Claude reescrever o arquivo: a classe acompanha */
      b.classList.toggle('perdido', !el);
      if (!el) { b.style.display = 'none'; continue; }
      const r = el.getBoundingClientRect();
      if (r.bottom < -30 || r.top > innerHeight + 30) { b.style.display = 'none'; continue; }
      b.style.display = 'block';
      b.style.left = Math.max(2, Math.min(r.left - 11, innerWidth - 26)) + 'px';
      b.style.top = Math.max(2, r.top - 8) + 'px';
    }
  }

  /* ------------------------------------------------------------------ */
  /* painel flutuante                                                    */
  /* ------------------------------------------------------------------ */

  function copyText(t) {
    return new Promise((resolve) => {
      const fallback = () => {
        try {
          const ta = document.createElement('textarea');
          ta.value = t;
          ta.style.cssText = 'position:fixed;top:-2000px;left:0;opacity:0';
          (document.body || document.documentElement).appendChild(ta);
          ta.focus(); ta.select();
          const ok = document.execCommand('copy');
          ta.remove();
          resolve(ok);
        } catch (_) { resolve(false); }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(() => resolve(true), fallback);
      } else fallback();
    });
  }

  function showFallbackText(t) {
    const w = document.createElement('div');
    w.className = 'box';
    w.style.cssText = 'left:50%;top:10vh;transform:translateX(-50%);width:min(680px,92vw)';
    const h = document.createElement('div');
    h.className = 'alvo';
    h.textContent = 'Não consegui escrever na área de transferência. Copie daqui com Cmd+C.';
    const ta = document.createElement('textarea');
    ta.style.height = '50vh'; ta.value = t;
    const rod = document.createElement('div'); rod.className = 'rodape';
    const b = document.createElement('button'); b.className = 'b pri'; b.textContent = 'Fechar';
    b.addEventListener('click', () => w.remove());
    rod.append(document.createElement('div'), b);
    w.append(h, ta, rod);
    layer.appendChild(w);
    ta.focus(); ta.select();
  }

  async function doCopy(items, rotulo) {
    const txt = buildExport(items);
    if (!txt) { flash('Nenhum comentário para exportar.'); return; }
    const ok = await copyText(txt);
    if (ok) flash(rotulo + ' na área de transferência. Cole no Claude Code.', 2400);
    else showFallbackText(txt);
  }

  function renderPanel() {
    if (!panelEl) return;
    resolveAll();
    const url = pageUrl();
    const lista = panelEl.querySelector('.lista');
    const cont = panelEl.querySelector('.n');
    cont.textContent = S.items.length + (S.items.length === 1 ? ' item' : ' itens');
    lista.innerHTML = '';

    if (!S.items.length) {
      const v = document.createElement('div');
      v.className = 'vazio';
      v.textContent = S.sticky
        ? 'Clique em qualquer elemento da página para comentar.'
        : 'Segure ' + modName() + ' e clique em um elemento para comentar. Selecionar um trecho antes marca só o trecho.';
      lista.appendChild(v);
    }

    const grupos = [];
    const porUrl = new Map();
    for (const it of S.items) {
      if (!porUrl.has(it.url)) { const g = { url: it.url, title: it.pageTitle, items: [] }; porUrl.set(it.url, g); grupos.push(g); }
      porUrl.get(it.url).items.push(it);
    }
    grupos.sort((a, b) => (a.url === url ? -1 : b.url === url ? 1 : 0));

    for (const g of grupos) {
      if (grupos.length > 1) {
        const t = document.createElement('div');
        t.className = 'grupo';
        t.textContent = (g.url === url ? 'Esta página: ' : '') + g.title;
        lista.appendChild(t);
      }
      for (const it of g.items) {
        const aqui = g.url === url;
        const achado = resolved.has(it.id);
        const row = document.createElement('div');
        row.className = 'it' + (aqui && !achado ? ' perdido' : '');
        const num = document.createElement('div'); num.className = 'num'; num.textContent = it.n;
        const txt = document.createElement('div'); txt.className = 'txt';
        const a2 = document.createElement('div'); a2.className = 'alvo2';
        a2.textContent = it.kind + ' ' + it.tagSig + (it.anchor ? ' "' + cut(it.anchor, 34) + '"' : '');
        const cm = document.createElement('div'); cm.className = 'cm'; cm.textContent = it.comment;
        txt.append(a2, cm);
        const x = document.createElement('button'); x.className = 'x'; x.textContent = '×';
        x.title = 'Apagar';
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          S.items = S.items.filter((i) => i.id !== it.id);
          saveState(); clearBadges(); renderPanel();
        });
        row.append(num, txt, x);
        row.addEventListener('click', () => {
          if (!aqui) { flash('Esse item é da página "' + it.pageTitle + '".'); return; }
          const el = resolved.get(it.id);
          if (!el) { flash('Elemento não encontrado nesta versão da página.'); return; }
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          setTimeout(() => openBox(el, null, JSON.parse(JSON.stringify(it))), 260);
        });
        lista.appendChild(row);
      }
    }
    paintBadges();
  }

  function modName() {
    return { alt: 'Alt (Option)', shift: 'Shift', ctrl: 'Ctrl', meta: 'Cmd' }[S.modifier] || 'Alt';
  }

  function buildPanel() {
    panelEl = document.createElement('div');
    panelEl.className = 'painel';
    panelEl.innerHTML =
      '<div class="cab"><span class="pt"></span><h1>Revisor Visual</h1>' +
      '<span class="n">0 itens</span><button class="min" title="Minimizar">⌄</button>' +
      '<button class="off" title="Desligar o modo de revisão">×</button></div>' +
      '<div class="opcoes">' +
      '<label><input type="checkbox" class="sticky"> clique simples anota</label>' +
      '<label>modificador <select class="mod">' +
      '<option value="alt">Alt / Option</option><option value="shift">Shift</option>' +
      '<option value="ctrl">Ctrl</option><option value="meta">Cmd</option></select></label>' +
      '</div>' +
      '<div class="lista"></div>' +
      '<div class="pe"><button class="b pri tudo">Copiar tudo</button>' +
      '<button class="b pag">Só esta página</button>' +
      '<button class="b limpa" title="Apagar todos os comentários">Limpar</button></div>';
    layer.appendChild(panelEl);

    const pos = S.panelPos || { left: innerWidth - 366, top: innerHeight - 520 };
    panelEl.style.left = Math.max(8, Math.min(pos.left, innerWidth - 360)) + 'px';
    panelEl.style.top = Math.max(8, Math.min(pos.top, innerHeight - 120)) + 'px';

    const sticky = panelEl.querySelector('.sticky');
    sticky.checked = !!S.sticky;
    sticky.addEventListener('change', () => { S.sticky = sticky.checked; saveState(); renderPanel(); });

    const mod = panelEl.querySelector('.mod');
    mod.value = S.modifier;
    mod.addEventListener('change', () => { S.modifier = mod.value; saveState(); renderPanel(); });

    panelEl.querySelector('.tudo').addEventListener('click', () => doCopy(S.items, 'Revisão completa'));
    panelEl.querySelector('.pag').addEventListener('click', () =>
      doCopy(S.items.filter((i) => i.url === pageUrl()), 'Revisão desta página'));
    panelEl.querySelector('.limpa').addEventListener('click', () => {
      if (!S.items.length) return;
      if (!confirm('Apagar os ' + S.items.length + ' comentários da sessão?')) return;
      S.items = []; S.nextN = 1; saveState(); clearBadges(); renderPanel();
    });
    panelEl.querySelector('.off').addEventListener('click', () => setActive(false));
    panelEl.querySelector('.min').addEventListener('click', () => { S.minimized = true; saveState(); paintChrome(); });

    /* arrastar pelo cabeçalho */
    const cab = panelEl.querySelector('.cab');
    let drag = null;
    cab.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const r = panelEl.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const left = Math.max(4, Math.min(e.clientX - drag.dx, innerWidth - 360));
      const top = Math.max(4, Math.min(e.clientY - drag.dy, innerHeight - 60));
      panelEl.style.left = left + 'px'; panelEl.style.top = top + 'px';
    }, true);
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      drag = null;
      S.panelPos = { left: parseInt(panelEl.style.left, 10), top: parseInt(panelEl.style.top, 10) };
      saveState();
    }, true);
  }

  let pillEl = null;
  function paintChrome() {
    if (panelEl) { panelEl.remove(); panelEl = null; }
    if (pillEl) { pillEl.remove(); pillEl = null; }
    if (!S.active) { clearBadges(); hiEl.style.display = 'none'; chipEl.style.display = 'none'; return; }
    if (S.minimized) {
      pillEl = document.createElement('div');
      pillEl.className = 'pill';
      pillEl.textContent = 'Revisor · ' + S.items.length;
      pillEl.style.right = '16px'; pillEl.style.bottom = '16px';
      pillEl.addEventListener('click', () => { S.minimized = false; saveState(); paintChrome(); });
      layer.appendChild(pillEl);
      resolveAll(); paintBadges();
    } else {
      buildPanel(); renderPanel();
    }
  }

  let ready = false;
  /* enquanto o modo está desligado o script não monta nada nem escuta nada:
     em página que você só abre e lê, o custo é uma leitura de storage */
  function ensureReady() {
    if (ready) return;
    ready = true;
    buildShell();
    wire();
  }

  function setActive(on) {
    ensureReady();   /* desligar também precisa da casca, para limpar a tela */
    S.active = on;
    if (!on) { closeBox(); S.minimized = false; }
    saveState();
    paintChrome();
    flash(on ? 'Modo de revisão ligado. ' +
      (S.sticky ? 'Clique em um elemento para comentar.' : 'Segure ' + modName() + ' e clique.')
      : 'Modo de revisão desligado.');
  }

  /* ------------------------------------------------------------------ */
  /* eventos                                                             */
  /* ------------------------------------------------------------------ */

  function onClickCapture(e) {
    if (!S.active) return;
    if (host.contains(e.target)) return;
    if (boxEl) return;
    if (!S.sticky && !modKeyOf(e)) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === host || host.contains(el)) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (baseEl !== el) { baseEl = el; level = 0; }
    applyLevel();
    const alvo = hovered || el;
    openBox(alvo, selectionInside(alvo));
  }

  function swallow(e) {
    if (!S.active || boxEl || host.contains(e.target)) return;
    if (!S.sticky && !modKeyOf(e)) return;
    e.preventDefault(); e.stopPropagation();
  }

  function onKeyDown(e) {
    if (!S.active) return;
    if (modKeyOf(e) && !modDown) { modDown = true; scheduleLayout(); }
    if (boxEl) return;
    if (pickingNow() && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'ArrowUp') level++;
      else level = Math.max(0, level - 1);
      applyLevel(); scheduleLayout();
      return;
    }
    if (e.key === 'Escape') { setActive(false); }
  }

  function onKeyUp(e) {
    if (!modKeyOf(e)) { modDown = false; level = 0; scheduleLayout(); }
  }

  function wire() {
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mousedown', swallow, true);
    window.addEventListener('mouseup', swallow, true);
    window.addEventListener('click', onClickCapture, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', () => { modDown = false; scheduleLayout(); });
    window.addEventListener('scroll', scheduleLayout, true);
    window.addEventListener('resize', scheduleLayout, true);
    setInterval(() => { if (S.active && !boxEl) { resolveAll(); paintBadges(); } }, 1500);
  }

  /* ------------------------------------------------------------------ */
  /* ligação com a extensão                                              */
  /* ------------------------------------------------------------------ */

  if (hasExt) {
    try {
      api.runtime.onMessage.addListener((msg, _s, send) => {
        if (msg && msg.type === 'rv-toggle') { setActive(!S.active); if (send) send({ ok: true }); }
        return false;
      });
    } catch (_) {}
    try {
      api.storage.onChanged.addListener((ch, area) => {
        if (area !== 'local' || !ch[KEY] || writingOurselves) return;
        const nv = ch[KEY].newValue;
        if (!nv) return;
        const eraAtivo = S.active;
        S = Object.assign({}, DEFAULTS, nv);
        if (S.active) ensureReady();
        if (!ready) return;
        if (S.active !== eraAtivo) paintChrome();
        else if (S.active) renderPanel();
      });
    } catch (_) {}
  }

  /* ------------------------------------------------------------------ */
  /* início                                                              */
  /* ------------------------------------------------------------------ */

  window.__rv.setActive = (on) => setActive(on);
  window.__rv.renderPanel = () => renderPanel();

  loadState().then((st) => {
    S = st;
    /* a sessão atravessa navegação e reload: se estava ligada, volta ligada */
    if (S.active) { ensureReady(); paintChrome(); }
    if (hasExt) { try { api.runtime.sendMessage({ type: 'rv-count', n: S.items.length }); } catch (_) {} }
  });
})();
