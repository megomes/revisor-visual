/* Revisor Visual: content script.
   Marca elementos de uma pagina, guarda um comentario por marca e exporta tudo
   como prompt para o Claude Code. A sessão de revisão atravessa navegação,
   reload e páginas diferentes: o estado mora em chrome.storage.local. */
(() => {
  'use strict';
  if (window.__revisorVisualLoaded) return;
  window.__revisorVisualLoaded = true;

  /* o script roda em todo frame, porque há página cujo conteúdo inteiro mora
     num iframe de outra origem (o Artefato do Claude). Iframe pequeno é anúncio,
     botão de rede social ou widget: sai daqui sem ler nada */
  const isTop = window.top === window;
  if (!isTop && (innerWidth < 300 || innerHeight < 200)) return;

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
    minimized: false,
    sessionId: null,    /* a sessão que vai para o histórico, até o próximo Limpar */
    sessionStart: null,
    sends: [],          /* cada cópia: quando, quais itens e se foi tudo ou só a página */
    vista: 'lista'      /* o que o painel mostra: os comentários ou o histórico */
  };
  let S = Object.assign({}, DEFAULTS);
  let writingOurselves = false;

  /* só um frame por aba desenha painel e aceita clique. O topo começa dono e
     cede a um iframe que cubra quase toda a janela; o iframe começa quieto e só
     acorda quando o topo cede. Quem cede é 'hospede', quem espera é 'quieto'. */
  let role = isTop ? 'dono' : 'quieto';
  let hostUrl = null;      /* endereço da barra, recebido do topo ao ganhar o painel */
  let hostTitle = null;
  let ownerFrame = null;   /* no topo: o frameId do iframe que tem o painel */

  function live() { return S.active && role === 'dono'; }

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

  function ownUrl() {
    const u = location.href;
    const i = u.indexOf('#');
    return i === -1 ? u : u.slice(0, i);
  }

  /* o iframe que ganhou o painel usa o endereço da barra: o dele próprio é
     efêmero (o do Artefato leva um token novo a cada carga), e é o da barra que
     quem vai editar sabe abrir */
  function pageUrl() {
    return hostUrl || ownUrl();
  }

  /* o endereço que o topo entrega ao iframe. No claude.ai a query é a chave de
     compartilhamento, que não identifica o Artefato e não deve ir para o export */
  function shareableUrl() {
    try {
      const u = new URL(ownUrl());
      if (/(^|\.)claude\.ai$/.test(u.hostname)) u.search = '';
      return u.href;
    } catch (_) { return ownUrl(); }
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
      filePath: filePathOf(ownUrl()),
      pageTitle: document.title || hostTitle || '(sem título)',
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
  function elPorCaminho(it) {
    const path = (it.path || '').split('   /*')[0].trim();
    if (!path) return null;
    try { return document.querySelector(path); } catch (_) { return null; }
  }

  function elPorAncora(it) {
    if (!it.anchor || it.anchor.length <= 3) return null;
    const needle = it.anchor.replace(/\.\.\.$/, '');
    const all = document.body ? document.body.querySelectorAll('*') : [];
    for (const el of all) {
      if (el.children.length > 3) continue;
      if (host && host.contains(el)) continue;
      if (ownText(el).startsWith(needle)) return el;
    }
    return null;
  }

  /* reencontra o elemento de um item nesta página */
  function resolveItem(it) {
    if (it.url !== pageUrl()) return null;
    return elPorCaminho(it) || elPorAncora(it);
  }

  /* para conferir, o caminho sozinho não basta: numa versão nova da página o
     mesmo caminho pode cair em outro elemento. Confere a âncora e diz o que achou */
  function achaParaConferir(it) {
    const needle = (it.anchor || '').replace(/\.\.\.$/, '');
    const porCaminho = elPorCaminho(it);
    const bate = (el) => !needle || needle.length <= 3 ||
      ownText(el).includes(needle) || anchorOf(el).text.replace(/\.\.\.$/, '').startsWith(needle);
    if (porCaminho && bate(porCaminho)) return { el: porCaminho, como: 'igual' };
    const porTexto = elPorAncora(it);
    if (porTexto) return { el: porTexto, como: 'igual' };
    if (porCaminho) return { el: porCaminho, como: 'mudou' };
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* export                                                              */
  /* ------------------------------------------------------------------ */

  /* o texto do export e a comparação de endereço vêm de shared.js, que o
     manifesto carrega antes deste arquivo */
  const { buildExport, sameUrl } = globalThis.RVShared;

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
  .cab button.hist, .foco .cab .h { font-size: 11px; border: 1px solid #3a4049; border-radius: 5px;
                                   padding: 3px 7px; color: #c3c9d4; }
  .cab button.hist:hover, .foco .cab .h:hover { border-color: ${ACCENT}; color: ${ACCENT}; }

  .spot { position: fixed; border: 3px solid ${ACCENT}; border-radius: 6px; pointer-events: none;
          box-shadow: 0 0 0 4000px rgba(10,12,16,.28); animation: rvpulso 1.4s ease-in-out infinite; }
  @keyframes rvpulso { 0%, 100% { outline: 0 solid rgba(255,122,69,.55); }
                       50% { outline: 8px solid rgba(255,122,69,0); } }
  .foco { position: fixed; left: 16px; bottom: 16px; width: 380px; max-width: calc(100vw - 32px);
          max-height: 80vh; display: flex; flex-direction: column; background: #15171c; color: #e7e9ee;
          border: 1px solid ${ACCENT}; border-radius: 12px; pointer-events: auto; font-size: 13px;
          box-shadow: 0 18px 54px rgba(0,0,0,.65); overflow: hidden; }
  .foco .cab { cursor: default; }
  .fcorpo { padding: 10px 12px; overflow-y: auto; }
  .falvo { font: 600 11px/1.45 ui-monospace, Menlo, monospace; color: #b9c0cc; margin-bottom: 6px;
           overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fped { font-size: 14px; line-height: 1.5; white-space: pre-wrap; }
  .fsit { margin-top: 10px; font-size: 11.5px; line-height: 1.45; color: #8b93a1; }
  .fsit.aviso2 { color: #fbbf24; }
  .fsit.mudou { color: #86efac; }
  .fantes { margin: 10px 0 0; }
  .fantes figcaption { font-size: 10.5px; color: #8b93a1; text-transform: uppercase; letter-spacing: .06em;
                       margin-bottom: 5px; }
  .fantes img { display: block; max-width: 100%; max-height: 200px; border-radius: 6px;
                border: 1px solid #2c323a; }
  .layer.fotografando .aviso { display: none; }

  .painel.modo-hist { width: 410px; }
  .painel.modo-hist .opcoes, .painel.modo-hist .pe { display: none; }
  .hbarra { display: flex; align-items: center; justify-content: space-between; gap: 8px;
            padding: 3px 6px 9px; font-size: 11.5px; color: #a9b1bf; }
  .hbarra label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
  .hbarra button { background: none; border: 1px solid #3a4049; color: #c3c9d4; border-radius: 5px;
                   font-size: 11px; padding: 3px 7px; cursor: pointer; }
  .hbarra button:hover { border-color: ${ACCENT}; color: ${ACCENT}; }
  .hs { display: flex; align-items: center; gap: 7px; padding: 9px 6px; border-top: 1px solid #2c323a;
        cursor: pointer; font-size: 12px; user-select: none; }
  .hs:hover { background: #1e222a; }
  .hs .seta { font-size: 9px; color: #8b93a1; transition: transform .15s; }
  .hs.aberta .seta { transform: rotate(90deg); }
  .hs .hq { font-weight: 600; white-space: nowrap; }
  .hs .tag { font-size: 10.5px; color: #a9b1bf; border: 1px solid #3a4049; border-radius: 99px;
             padding: 0 6px; white-space: nowrap; }
  .hs .mini { flex: 1; min-width: 40px; height: 5px; background: #262b33; border-radius: 99px;
              overflow: hidden; display: flex; }
  .hs .mini i { display: block; height: 100%; }
  .hs .mini .o { background: #22c55e; }
  .hs .mini .x { background: #ef4444; }
  .hs .hn { font: 600 11px/1 ui-monospace, Menlo, monospace; color: #8b93a1; white-space: nowrap; }
  .hit { display: flex; gap: 8px; align-items: flex-start; padding: 7px 6px 7px 4px; border-radius: 7px;
         cursor: pointer; border-left: 3px solid transparent; }
  .hit:hover { background: #1e222a; }
  .hit.ok { border-left-color: #22c55e; }
  .hit.nao { border-left-color: #ef4444; }
  .hit.ok .cm { color: #8b93a1; }
  .hit.fora { opacity: .72; }
  .hit .num { flex: none; min-width: 20px; height: 20px; padding: 0 4px; border-radius: 10px;
              background: ${ACCENT}; color: #1a1208; font: 700 11px/20px ui-sans-serif, sans-serif; text-align: center; }
  .hit .th { flex: none; width: 66px; height: 46px; object-fit: cover; border-radius: 4px;
             border: 1px solid #2c323a; background: #0b0d10; }
  .hit .txt { flex: 1; min-width: 0; }
  .hit .cm { font-size: 12px; line-height: 1.4; color: #e7e9ee; display: -webkit-box; -webkit-line-clamp: 3;
             -webkit-box-orient: vertical; overflow: hidden; }
  .hit .alvo2 { font: 10.5px/1.4 ui-monospace, Menlo, monospace; color: #8b93a1; margin-top: 2px;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hit .bts { flex: none; display: flex; flex-direction: column; gap: 3px; }
  .hit .bts button { width: 26px; height: 22px; border-radius: 5px; border: 1px solid #3a4049; background: #1b1e25;
                     color: #8b93a1; cursor: pointer; font-size: 12px; line-height: 1; padding: 0; }
  .hit .bts button:hover { color: #e7e9ee; }
  .hit .bts .sim.on { background: rgba(34,197,94,.15); border-color: #22c55e; color: #86efac; }
  .hit .bts .nao.on { background: rgba(239,68,68,.15); border-color: #ef4444; color: #fca5a5; }
  button.b.ruim { background: #7f1d1d; border-color: #b91c1c; color: #fee2e2; }
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
    return live() && !boxEl && (S.sticky || modDown);
  }

  function applyLevel() {
    let el = baseEl;
    for (let i = 0; i < level && el && el.parentElement &&
         el.parentElement !== document.documentElement; i++) el = el.parentElement;
    hovered = el;
  }

  let fotografando = null;   /* elemento cujo contorno fica na tela até a foto sair */

  function paintHighlight() {
    paintSpot();
    if (fotografando) {
      const r = fotografando.getBoundingClientRect();
      hiEl.style.display = 'block';
      hiEl.style.left = r.left + 'px'; hiEl.style.top = r.top + 'px';
      hiEl.style.width = Math.max(r.width, 2) + 'px'; hiEl.style.height = Math.max(r.height, 2) + 'px';
      chipEl.style.display = 'none';
      return;
    }
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
    /* o modificador também vem do mouse: com o foco do teclado em outro frame
       (a barra do claude.ai em volta do Artefato), o keydown do Alt não chega */
    if (live() && !boxEl && modKeyOf(e) !== modDown) {
      modDown = modKeyOf(e);
      if (!modDown) level = 0;
      scheduleLayout();
    }
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
      const novo = !editingId;
      const item = pending, alvoEl = pendingEl;
      if (editingId) {
        const i = S.items.findIndex((x) => x.id === editingId);
        if (i >= 0) S.items[i] = pending;
      } else {
        ensureSession();
        S.items.push(pending);
        S.nextN = pending.n + 1;
      }
      saveState(); closeBox(); renderPanel();
      /* a foto é do item como ele estava ao ser marcado: a edição não tira outra */
      if (novo) fotografa(item, alvoEl);
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
  /* histórico                                                           */
  /* ------------------------------------------------------------------ */

  function ensureSession() {
    if (S.sessionId) return;
    S.sessionId = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    S.sessionStart = (S.items[0] && S.items[0].createdAt) || new Date().toISOString();
    S.sends = [];
  }

  /* manda a sessão para o histórico, que mora no fundo da extensão. Devolve
     false quando não havia nada para guardar */
  function archive(motivo) {
    if (!hasExt || !S.items.length) return false;
    if (!S.sessionId) { ensureSession(); saveState(); }
    ask({ type: 'rv-archive', sess: JSON.parse(JSON.stringify({
      id: S.sessionId,
      start: S.sessionStart,
      end: new Date().toISOString(),
      motivo,
      items: S.items,
      sends: S.sends || []
    })) });
    return true;
  }

  function registraEnvio(items, escopo) {
    if (!hasExt) return;
    const ids = items.filter((i) => (i.comment || '').trim()).map((i) => i.id);
    if (!ids.length) return;
    ensureSession();
    S.sends = (S.sends || []).concat([{ at: new Date().toISOString(), ids, escopo }]);
    saveState();
    archive('copiado');
  }

  /* o histórico abre dentro do painel, em cima da página, para você não sair
     de onde está. Com o modo desligado não há painel, e aí abre a página inteira */
  function abreHistorico() {
    if (!hasExt) return;
    if (!live()) { ask({ type: 'rv-open-history' }); return; }
    S.vista = 'hist';
    S.minimized = false;
    saveState();
    paintChrome();
  }

  /* pede ao fundo a foto do item. O contorno fica em volta do elemento até a
     foto sair, e por isso ela sai com a marca laranja */
  function fotografa(it, el) {
    if (!hasExt || !el || !el.isConnected) return;
    fotografando = el;
    layer.classList.add('fotografando');
    scheduleLayout();
    const solta = () => {
      if (fotografando !== el) return;
      fotografando = null;
      layer.classList.remove('fotografando');
      scheduleLayout();
    };
    const seguranca = setTimeout(solta, 2500);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      ask({ type: 'rv-shot', id: it.id, rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        vw: innerWidth, vh: innerHeight })
        .then(() => { clearTimeout(seguranca); solta(); });
    }));
  }

  /* ------------------------------------------------------------------ */
  /* conferência na página                                               */
  /* ------------------------------------------------------------------ */

  let focoEl = null;       /* o cartão de conferência */
  let spotEl = null;       /* o contorno pulsante no elemento conferido */
  let spotAlvo = null;
  let focoBusca = null;

  function closeFocus() {
    if (focoBusca) { clearInterval(focoBusca); focoBusca = null; }
    if (focoEl) { focoEl.remove(); focoEl = null; }
    if (spotEl) { spotEl.remove(); spotEl = null; }
    spotAlvo = null;
  }

  function paintSpot() {
    if (!spotEl) return;
    if (!spotAlvo || !spotAlvo.isConnected) { spotEl.style.display = 'none'; return; }
    const r = spotAlvo.getBoundingClientRect();
    spotEl.style.display = 'block';
    spotEl.style.left = (r.left - 4) + 'px'; spotEl.style.top = (r.top - 4) + 'px';
    spotEl.style.width = Math.max(r.width, 2) + 8 + 'px'; spotEl.style.height = Math.max(r.height, 2) + 8 + 'px';
  }

  /* pergunta ao fundo se há um pedido de foco para esta aba e esta página */
  function takeFocus() {
    if (!hasExt || role !== 'dono') return;
    /* o topo com um iframe grande deixa o pedido para o iframe, que é onde o
       item mora; e só pergunta ao fundo se há pedido guardado */
    if (isTop && temFilhoGrande()) return;
    const pergunta = (o) => {
      if (!o || !o.rv_focus) return;
      ask({ type: 'rv-focus-take', url: pageUrl() }).then((f) => { if (f && f.item) showFocus(f); });
    };
    try {
      const r = api.storage.local.get('rv_focus', pergunta);
      if (r && typeof r.then === 'function') r.then(pergunta);
    } catch (_) {}
  }

  function dataCurta(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = (x) => String(x).padStart(2, '0');
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function showFocus(f) {
    ensureReady();
    closeFocus();
    const it = f.item;
    focoEl = document.createElement('div');
    focoEl.className = 'foco';
    focoEl.innerHTML =
      '<div class="cab"><span class="pt"></span><h1>Conferir</h1><span class="n"></span>' +
      '<button class="h" title="Abrir o histórico">Histórico</button><button class="x" title="Fechar">×</button></div>' +
      '<div class="fcorpo"><div class="falvo"></div><div class="fped"></div>' +
      '<div class="fsit">Procurando o ponto na página...</div>' +
      '<figure class="fantes" hidden><figcaption>Como estava quando você marcou</figcaption><img alt=""></figure></div>' +
      '<div class="pe"><button class="b ok">Ficou</button><button class="b nao">Não ficou</button>' +
      '<button class="b pula">Pular</button></div>';
    layer.appendChild(focoEl);
    focoEl.querySelector('.n').textContent = 'item ' + it.n + ' · ' + f.pos + ' de ' + f.total +
      (f.sessionEnd ? ' · ' + dataCurta(f.sessionEnd) : '');
    focoEl.querySelector('.falvo').textContent = it.kind + ' ' + it.tagSig +
      (it.anchor ? ' "' + cut(it.anchor, 60) + '"' : '');
    focoEl.querySelector('.fped').textContent = it.comment;
    const sit = focoEl.querySelector('.fsit');
    const bOk = focoEl.querySelector('.ok'), bNao = focoEl.querySelector('.nao');
    const pintaSt = (st) => {
      bOk.classList.toggle('pri', st === 'ok');
      bNao.classList.toggle('ruim', st === 'nao');
    };
    pintaSt(f.st);

    if (f.temFoto) {
      ask({ type: 'rv-shot-get', id: it.id }).then((src) => {
        if (!src || !focoEl) return;
        const fig = focoEl.querySelector('.fantes');
        const img = fig.querySelector('img');
        img.onload = () => { fig.hidden = false; };
        img.src = src;
      });
    }

    /* página que desenha o conteúdo depois de carregar, como o Artefato, ainda
       não tem o elemento no primeiro instante: tenta por alguns segundos */
    let tentativas = 0;
    const procura = () => {
      const achado = achaParaConferir(it);
      if (!achado && ++tentativas < 12) return false;
      clearInterval(focoBusca); focoBusca = null;
      if (!focoEl) return true;
      if (!achado) {
        sit.textContent = 'Não achei esse ponto nesta versão da página. Se o pedido era tirar, é sinal de que saiu.';
        sit.className = 'fsit aviso2';
        return true;
      }
      spotAlvo = achado.el;
      spotEl = document.createElement('div');
      spotEl.className = 'spot';
      layer.insertBefore(spotEl, layer.firstChild);
      if (achado.como === 'mudou') {
        sit.textContent = 'No lugar marcado agora está outro texto: "' + cut(anchorOf(achado.el).text, 80) + '"';
        sit.className = 'fsit mudou';
      } else {
        sit.textContent = 'O ponto está destacado na página.';
        sit.className = 'fsit';
      }
      achado.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      scheduleLayout();
      return true;
    };
    if (!procura()) focoBusca = setInterval(procura, 500);

    const segue = (st) => {
      const vai = () => ask({ type: 'rv-next', sessionId: f.sessionId, afterId: it.id }).then((r) => {
        if (r && r.done && focoEl) {
          focoEl.querySelector('.fcorpo').innerHTML = '<div class="fsit">Nada mais para conferir nesta sessão.</div>';
          focoEl.querySelector('.pe').innerHTML = '<button class="b pri hist2">Abrir o histórico</button>';
          focoEl.querySelector('.hist2').addEventListener('click', abreHistorico);
          if (spotEl) { spotEl.remove(); spotEl = null; spotAlvo = null; }
        }
      });
      if (st === undefined) { vai(); return; }
      pintaSt(st);
      if (histCache) histCache.confs[it.id] = st;
      ask({ type: 'rv-review', id: it.id, st }).then(() => {
        if (panelEl && S.vista === 'hist') renderHistorico();
        vai();
      });
    };
    bOk.addEventListener('click', () => segue('ok'));
    bNao.addEventListener('click', () => segue('nao'));
    focoEl.querySelector('.pula').addEventListener('click', () => segue(undefined));
    focoEl.querySelector('.x').addEventListener('click', closeFocus);
    focoEl.querySelector('.h').addEventListener('click', abreHistorico);
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
    if (!live()) { clearBadges(); return; }
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
        b.dataset.id = it.id;
        /* o item sai de S na hora do clique, e não do fechamento: salvar a edição
           troca o objeto em S.items, e o marcador segurava o antigo, que reabria
           com o comentário de antes */
        b.addEventListener('click', (e) => {
          e.stopPropagation(); e.preventDefault();
          const atual = S.items.find((x) => x.id === b.dataset.id);
          const el = resolved.get(b.dataset.id);
          if (atual && el) openBox(el, null, JSON.parse(JSON.stringify(atual)));
        });
        badgeWrap.appendChild(b);
      }
    }
    const porId = new Map(mine.map((i) => [i.id, i]));
    for (const b of badgeWrap.children) {
      const el = resolved.get(b.dataset.id);
      const it = porId.get(b.dataset.id);
      b.title = el ? (it ? it.comment : '') : 'Elemento não encontrado nesta versão da página';
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

  async function doCopy(items, rotulo, escopo) {
    const txt = buildExport(items);
    if (!txt) { flash('Nenhum comentário para exportar.'); return; }
    registraEnvio(items, escopo);
    const ok = await copyText(txt);
    if (ok) flash(rotulo + ' na área de transferência. Cole no Claude Code.', 2400);
    else showFallbackText(txt);
  }

  function renderPanel() {
    if (!panelEl) return;
    resolveAll();
    if (S.vista === 'hist' && hasExt) { renderHistorico(); paintBadges(); return; }
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
    encaixaPainel();
  }

  /* ------------------------------------------------------------------ */
  /* histórico no painel                                                 */
  /* ------------------------------------------------------------------ */

  let histCache = null;          /* a última lista que veio do fundo */
  const fotoCache = new Map();   /* id do item -> dataURL, ou null quando não há foto */
  const histAbertas = new Set();
  let histIniciado = false;
  let histToken = 0;
  let soPendentes = true;

  /* as sessões guardadas, mais a que está no painel agora, que é a mais nova.
     Primeiro as sessões com item desta página */
  function sessoesDoHistorico() {
    const sess = ((histCache && histCache.sessoes) || []).slice();
    if (S.items.length) {
      if (!S.sessionId) { ensureSession(); saveState(); }
      const i = sess.findIndex((x) => x.id === S.sessionId);
      const velha = i >= 0 ? sess[i] : null;
      const agora = new Set(S.items.map((x) => x.id));
      const enviados = new Set((S.sends || []).flatMap((e) => e.ids));
      const ficam = velha ? velha.items.filter((x) => !agora.has(x.id) && enviados.has(x.id)) : [];
      if (i >= 0) sess.splice(i, 1);
      sess.push({ id: S.sessionId, start: S.sessionStart, end: new Date().toISOString(),
        motivo: 'aberta', aberta: true, items: ficam.concat(S.items) });
    }
    const url = pageUrl();
    const daqui = (x) => x.items.some((it) => sameUrl(it.url, url));
    return sess.sort((a, b) => (b.aberta ? 1 : 0) - (a.aberta ? 1 : 0) ||
      (daqui(b) ? 1 : 0) - (daqui(a) ? 1 : 0) || String(b.end).localeCompare(String(a.end)));
  }

  function renderHistorico() {
    const lista = panelEl.querySelector('.lista');
    const token = ++histToken;
    if (histCache) desenhaHistorico(lista);
    else lista.innerHTML = '<div class="vazio">Carregando o histórico...</div>';
    ask({ type: 'rv-hist-list' }).then((r) => {
      if (!r || token !== histToken || !panelEl || S.vista !== 'hist') return;
      histCache = r;
      desenhaHistorico(panelEl.querySelector('.lista'));
    });
  }

  const MOTIVO = { aberta: 'no painel agora', copiado: 'copiada', limpo: 'limpa',
    desligado: 'ao desligar', importado: 'importada', conferida: 'conferida' };

  function desenhaHistorico(lista) {
    const confs = histCache.confs || {};
    const fotos = new Set(histCache.fotos || []);
    const sessoes = sessoesDoHistorico();
    const url = pageUrl();
    const rolagem = lista.scrollTop;
    lista.innerHTML = '';
    panelEl.querySelector('.n').textContent = sessoes.length + (sessoes.length === 1 ? ' sessão' : ' sessões');

    const barra = document.createElement('div');
    barra.className = 'hbarra';
    barra.innerHTML = '<label><input type="checkbox"> só o que falta conferir</label>' +
      '<button class="inteira" title="Abre o histórico numa aba própria, com as fotos grandes">Página inteira</button>';
    const cb = barra.querySelector('input');
    cb.checked = soPendentes;
    cb.addEventListener('change', () => { soPendentes = cb.checked; desenhaHistorico(lista); });
    barra.querySelector('.inteira').addEventListener('click', () => ask({ type: 'rv-open-history' }));
    lista.appendChild(barra);

    if (!sessoes.length) {
      const v = document.createElement('div');
      v.className = 'vazio';
      v.textContent = 'Nenhuma sessão ainda. A sessão entra aqui quando você copia, limpa ou desliga o modo.';
      lista.appendChild(v);
      encaixaPainel();
      return;
    }
    if (!histIniciado) {
      histIniciado = true;
      histAbertas.add(sessoes[0].id);
    }

    let mostrou = 0;
    for (const sess of sessoes) {
      const itens = sess.items.filter((i) => !soPendentes || !confs[i.id]);
      let ok = 0, nao = 0;
      for (const i of sess.items) { if (confs[i.id] === 'ok') ok++; else if (confs[i.id] === 'nao') nao++; }
      const total = sess.items.length;
      if (soPendentes && !itens.length) continue;
      mostrou++;
      const aberta = histAbertas.has(sess.id);

      const cab = document.createElement('div');
      cab.className = 'hs' + (aberta ? ' aberta' : '');
      cab.innerHTML = '<span class="seta">▶</span><span class="hq"></span><span class="tag"></span>' +
        '<span class="mini"><i class="o"></i><i class="x"></i></span><span class="hn"></span>';
      cab.querySelector('.hq').textContent = dataCurta(sess.end || sess.start);
      cab.querySelector('.tag').textContent = MOTIVO[sess.motivo] || sess.motivo;
      cab.querySelector('.o').style.width = (100 * ok / total) + '%';
      cab.querySelector('.x').style.width = (100 * nao / total) + '%';
      cab.querySelector('.hn').textContent = (ok + nao) + ' de ' + total;
      cab.title = ok + ' ficaram, ' + nao + ' não ficaram, ' + (total - ok - nao) + ' sem conferir';
      cab.addEventListener('click', () => {
        if (histAbertas.has(sess.id)) histAbertas.delete(sess.id); else histAbertas.add(sess.id);
        desenhaHistorico(lista);
      });
      lista.appendChild(cab);
      if (!aberta) continue;

      for (const it of itens) {
        const st = confs[it.id] || null;
        const aqui = sameUrl(it.url, url);
        const row = document.createElement('div');
        row.className = 'hit' + (st ? ' ' + st : '') + (aqui ? '' : ' fora');
        const num = document.createElement('div'); num.className = 'num'; num.textContent = it.n;
        row.appendChild(num);
        if (fotos.has(it.id)) {
          const th = document.createElement('img');
          th.className = 'th';
          th.alt = '';
          const poe = (src) => { if (src) th.src = src; else th.remove(); };
          th.onerror = () => th.remove();
          if (fotoCache.has(it.id)) poe(fotoCache.get(it.id));
          else ask({ type: 'rv-shot-get', id: it.id }).then((src) => { fotoCache.set(it.id, src); poe(src); });
          row.appendChild(th);
        }
        const txt = document.createElement('div'); txt.className = 'txt';
        const cm = document.createElement('div'); cm.className = 'cm'; cm.textContent = it.comment;
        const a2 = document.createElement('div'); a2.className = 'alvo2';
        a2.textContent = (aqui ? '' : it.pageTitle + ' · ') + it.kind + (it.anchor ? ' "' + cut(it.anchor, 40) + '"' : '');
        txt.append(cm, a2);
        const bts = document.createElement('div'); bts.className = 'bts';
        const bOk = document.createElement('button'); bOk.className = 'sim' + (st === 'ok' ? ' on' : ''); bOk.textContent = '✓';
        bOk.title = st === 'ok' ? 'Voltar para sem conferir' : 'Ficou';
        const bNao = document.createElement('button'); bNao.className = 'nao' + (st === 'nao' ? ' on' : ''); bNao.textContent = '✗';
        bNao.title = st === 'nao' ? 'Voltar para sem conferir' : 'Não ficou';
        const marca = (v) => (e) => {
          e.stopPropagation();
          const novo = st === v ? null : v;
          if (novo) confs[it.id] = novo; else delete confs[it.id];
          if (sess.aberta) archive('conferida');
          ask({ type: 'rv-review', id: it.id, st: novo });
          desenhaHistorico(lista);
        };
        bOk.addEventListener('click', marca('ok'));
        bNao.addEventListener('click', marca('nao'));
        bts.append(bOk, bNao);
        row.append(txt, bts);
        row.title = aqui ? 'Mostrar na página' : 'Abrir a página "' + it.pageTitle + '" nesta aba';
        row.addEventListener('click', () => confere(sess, it, st, fotos.has(it.id)));
        lista.appendChild(row);
      }
    }
    if (!mostrou) {
      const v = document.createElement('div');
      v.className = 'vazio';
      v.textContent = 'Tudo conferido. Desmarque "só o que falta conferir" para ver o que já passou.';
      lista.appendChild(v);
    }
    lista.scrollTop = rolagem;
    encaixaPainel();
  }

  /* o painel cresce quando a lista cresce: se passar da borda de baixo, sobe */
  function encaixaPainel() {
    if (!panelEl) return;
    const r = panelEl.getBoundingClientRect();
    if (r.bottom > innerHeight - 8) panelEl.style.top = Math.max(8, innerHeight - 8 - r.height) + 'px';
  }

  /* item desta página: destaca aqui mesmo, sem navegar. Item de outra página:
     leva esta aba até lá, e o cartão aparece quando ela carregar */
  function confere(sess, it, st, temFoto) {
    if (sess.aberta) archive('conferida');
    if (sameUrl(it.url, pageUrl())) {
      showFocus({ item: it, sessionId: sess.id, sessionEnd: sess.end, st, temFoto,
        pos: sess.items.findIndex((x) => x.id === it.id) + 1, total: sess.items.length });
    } else {
      ask({ type: 'rv-goto', sessionId: sess.id, itemId: it.id, aqui: true });
    }
  }

  function modName() {
    return { alt: 'Alt (Option)', shift: 'Shift', ctrl: 'Ctrl', meta: 'Cmd' }[S.modifier] || 'Alt';
  }

  function buildPanel() {
    panelEl = document.createElement('div');
    panelEl.className = 'painel';
    panelEl.innerHTML =
      '<div class="cab"><span class="pt"></span><h1>Revisor Visual</h1>' +
      '<span class="n">0 itens</span>' +
      (hasExt ? '<button class="hist"></button>' : '') +
      '<button class="min" title="Minimizar">⌄</button>' +
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
      '<button class="b limpa" title="Guarda a sessão no histórico e começa outra, vazia">Limpar</button></div>';
    layer.appendChild(panelEl);

    const largura = S.vista === 'hist' && hasExt ? 410 : 350;
    const pos = S.panelPos || { left: innerWidth - 366, top: innerHeight - 520 };
    panelEl.style.left = Math.max(8, Math.min(pos.left, innerWidth - largura - 10)) + 'px';
    panelEl.style.top = Math.max(8, Math.min(pos.top, innerHeight - 120)) + 'px';

    const sticky = panelEl.querySelector('.sticky');
    sticky.checked = !!S.sticky;
    sticky.addEventListener('change', () => { S.sticky = sticky.checked; saveState(); renderPanel(); });

    const mod = panelEl.querySelector('.mod');
    mod.value = S.modifier;
    mod.addEventListener('change', () => { S.modifier = mod.value; saveState(); renderPanel(); });

    panelEl.querySelector('.tudo').addEventListener('click', () => doCopy(S.items, 'Revisão completa', 'tudo'));
    panelEl.querySelector('.pag').addEventListener('click', () =>
      doCopy(S.items.filter((i) => i.url === pageUrl()), 'Revisão desta página', 'pagina'));
    /* confirma no próprio botão, e não com confirm(): iframe sem allow-modals,
       como o do Artefato, faz o confirm() voltar false sem mostrar nada */
    const limpa = panelEl.querySelector('.limpa');
    let armado = null;
    limpa.addEventListener('click', () => {
      if (!S.items.length) return;
      if (!armado) {
        limpa.textContent = 'Apagar ' + S.items.length + '?';
        armado = setTimeout(() => { armado = null; limpa.textContent = 'Limpar'; }, 3000);
        return;
      }
      clearTimeout(armado); armado = null;
      const guardou = archive('limpo');
      S.items = []; S.nextN = 1; S.sessionId = null; S.sessionStart = null; S.sends = [];
      saveState(); clearBadges(); renderPanel();
      limpa.textContent = 'Limpar';
      if (guardou) flash('Sessão guardada no histórico. O painel começa vazio.', 2400);
    });
    const hist = panelEl.querySelector('.hist');
    if (hist) {
      const noHist = S.vista === 'hist';
      hist.textContent = noHist ? 'Comentários' : 'Histórico';
      hist.title = noHist ? 'Volta para os comentários desta sessão' : 'Mostra as sessões anteriores, para conferir item a item';
      hist.addEventListener('click', () => {
        if (S.vista === 'hist') { S.vista = 'lista'; saveState(); paintChrome(); }
        else abreHistorico();
      });
      if (noHist) panelEl.classList.add('modo-hist');
    }
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
    if (!live()) { clearBadges(); hiEl.style.display = 'none'; chipEl.style.display = 'none'; return; }
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

  function avisoModo() {
    return S.active ? 'Modo de revisão ligado. ' +
      (S.sticky ? 'Clique em um elemento para comentar.' : 'Segure ' + modName() + ' e clique.')
      : 'Modo de revisão desligado.';
  }

  function setActive(on) {
    if (!on && S.active) archive('desligado');
    S.active = on;
    if (!on) S.minimized = false;
    saveState();
    /* o painel é de outro frame: ele fica sabendo pelo storage e desenha lá */
    if (role !== 'dono') return;
    ensureReady();   /* desligar também precisa da casca, para limpar a tela */
    if (!on) closeBox();
    paintChrome();
    flash(avisoModo());
  }

  /* ------------------------------------------------------------------ */
  /* eventos                                                             */
  /* ------------------------------------------------------------------ */

  function onClickCapture(e) {
    if (!live()) return;
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
    if (!live() || boxEl || host.contains(e.target)) return;
    if (!S.sticky && !modKeyOf(e)) return;
    e.preventDefault(); e.stopPropagation();
  }

  function onKeyDown(e) {
    if (!live()) return;
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
    setInterval(() => { if (live() && !boxEl) { resolveAll(); paintBadges(); } }, 1500);
  }

  /* ------------------------------------------------------------------ */
  /* ligação com a extensão                                              */
  /* ------------------------------------------------------------------ */

  /* fração da janela que um iframe precisa cobrir para levar o painel. O
     Artefato do Claude cobre quase tudo, menos a barra de 40px no topo; um
     vídeo ou mapa embutido no meio de um artigo fica bem abaixo disso */
  const COBRE = 0.5;

  function temFilhoGrande() {
    const area = innerWidth * innerHeight;
    if (!area) return false;
    return Array.from(document.querySelectorAll('iframe, frame')).some((f) => {
      const r = f.getBoundingClientRect();
      return r.width * r.height >= COBRE * area;
    });
  }

  /* runtime.sendMessage nos dois estilos, e null quando ninguém responde */
  function ask(msg) {
    return new Promise((resolve) => {
      let done = false;
      const cb = (r) => {
        if (done) return;
        done = true;
        void (api.runtime.lastError);
        resolve(r || null);
      };
      try {
        const p = api.runtime.sendMessage(msg, cb);
        if (p && typeof p.then === 'function') p.then(cb, () => cb(null));
      } catch (_) { cb(null); }
    });
  }

  /* no topo: um iframe grande pediu o painel. Cede, e avisa o dono anterior
     se o painel já estava com outro iframe (o Artefato recarregado, por exemplo) */
  function cede(frameId) {
    const antes = ownerFrame;
    ownerFrame = frameId;
    if (antes != null && antes !== frameId) ask({ type: 'rv-revoke', frameId: antes });
    if (role !== 'dono') return;
    role = 'hospede';
    if (ready) { closeBox(); closeFocus(); paintChrome(); }
  }

  /* no iframe: pede o painel ao topo. O topo pode ainda não ter carregado o
     script, então tenta de novo algumas vezes, cada vez esperando mais */
  function pedePainel(tentativa) {
    ask({ type: 'rv-claim', w: innerWidth, h: innerHeight }).then((r) => {
      if (!r || r.retry) {
        if (tentativa < 8) setTimeout(() => pedePainel(tentativa + 1), 250 * (tentativa + 1));
        return;
      }
      if (!r.own) return;
      hostUrl = r.hostUrl || null;
      hostTitle = r.hostTitle || null;
      role = 'dono';
      if (S.active) { ensureReady(); paintChrome(); }
      takeFocus();
    });
  }

  if (hasExt) {
    try {
      api.runtime.onMessage.addListener((msg, _s, send) => {
        if (!msg) return false;
        if (msg.type === 'rv-toggle') { setActive(!S.active); if (send) send({ ok: true }); }
        else if (msg.type === 'rv-claim' && isTop) {
          const cobre = (msg.w | 0) * (msg.h | 0) >= COBRE * innerWidth * innerHeight;
          if (cobre) cede(msg.frameId);
          if (send) send(cobre ? { own: true, hostUrl: shareableUrl(), hostTitle: document.title } : { own: false });
        } else if (msg.type === 'rv-frame-rect' && isTop) {
          /* o iframe dono quer saber onde está na janela, para recortar a foto:
             é o iframe cujo tamanho interno bate com o que ele informou */
          let melhor = null, dif = Infinity;
          for (const f of document.querySelectorAll('iframe, frame')) {
            const d = Math.abs(f.clientWidth - (msg.w | 0)) + Math.abs(f.clientHeight - (msg.h | 0));
            if (d < dif) { dif = d; melhor = f; }
          }
          if (send) {
            if (!melhor) send(null);
            else {
              const r = melhor.getBoundingClientRect();
              send({ x: r.left + melhor.clientLeft, y: r.top + melhor.clientTop, vw: innerWidth });
            }
          }
        } else if (msg.type === 'rv-revoke' && !isTop) {
          role = 'quieto';
          if (ready) { closeBox(); closeFocus(); paintChrome(); }
        }
        return false;
      });
    } catch (_) {}
    try {
      api.storage.onChanged.addListener((ch, area) => {
        if (area !== 'local') return;
        if (ch.rv_focus && ch.rv_focus.newValue) takeFocus();
        if (!ch[KEY] || writingOurselves) return;
        const nv = ch[KEY].newValue;
        if (!nv) return;
        const eraAtivo = S.active;
        S = Object.assign({}, DEFAULTS, nv);
        if (role !== 'dono') return;
        if (S.active) ensureReady();
        if (!ready) return;
        if (S.active !== eraAtivo) {
          /* o modo mudou em outro frame ou outra aba, e quem avisa é o dono */
          if (!S.active) closeBox();
          paintChrome();
          flash(avisoModo());
        } else if (S.active) renderPanel();
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
    /* a sessão atravessa navegação e reload: se estava ligada, volta ligada.
       Com um iframe grande na página, o topo espera um pouco antes de desenhar,
       porque o iframe provavelmente vai pedir o painel, e o painel piscaria */
    const pinta = () => { if (live()) { ensureReady(); paintChrome(); } takeFocus(); };
    if (isTop && hasExt && temFilhoGrande()) setTimeout(pinta, 1500);
    else pinta();
    if (!hasExt) return;
    if (isTop) { try { api.runtime.sendMessage({ type: 'rv-count', n: S.items.length }); } catch (_) {} }
    else if (!temFilhoGrande()) pedePainel(0);
  });
})();
