(() => {
  'use strict';

  if (window.__trustLensSovereignLoaded) return;
  window.__trustLensSovereignLoaded = true;

  const API_BASE = 'http://localhost:5000';
  const REQUEST_TIMEOUT_MS = 30000;

  const state = {
    analyzing: false,
    lastUrl: location.href,
    telemetry: null,
    result: null,
    history: [],
  };

  /* ------------------------- utilities ------------------------- */

  const $ = (sel) => document.querySelector(sel);
  const textOf = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');

  function firstText(selectors) {
    for (const s of selectors) {
      try {
        const t = textOf($(s));
        if (t) return t.slice(0, 200);
      } catch (_) { /* ignore invalid selector */ }
    }
    return '';
  }

  async function api(path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(API_BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ----------------------- telemetry gather ----------------------- */

  function collectTelemetry() {
    const host = location.hostname;
    const isTrustedMarketplace = /(^|\.)amazon\.(in|com)$|(^|\.)flipkart\.com$/i.test(host);

    const links = Array.from(document.querySelectorAll('a[href]'));
    const externalDomains = new Set();
    let externalLinks = 0;
    for (const a of links) {
      try {
        const u = new URL(a.href, location.href);
        if (/^https?:$/.test(u.protocol) && u.hostname !== host) {
          externalLinks++;
          externalDomains.add(u.hostname);
        }
      } catch (_) { /* ignore */ }
    }

    let offDomainForms = 0;
    document.querySelectorAll('form[action]').forEach((f) => {
      try {
        const u = new URL(f.action, location.href);
        if (u.hostname && u.hostname !== host) offDomainForms++;
      } catch (_) { /* ignore */ }
    });

    const bodyText = (document.body && document.body.innerText) || '';
    const urgencyRegex =
      /(only \d+ left|hurry|limited time|act now|last chance|ends (today|soon)|selling fast|don'?t miss|expires in|lowest price ever|100% (genuine|original)|pay (via|using) (upi|whatsapp|telegram))/gi;
    const urgencyPhrases = Array.from(new Set((bodyText.match(urgencyRegex) || []).map((s) => s.toLowerCase()))).slice(0, 10);

    return {
      url: location.href,
      hostname: host,
      title: document.title,
      isHttps: location.protocol === 'https:',
      isTrustedMarketplace,
      price: firstText([
        '.a-price .a-offscreen', '#priceblock_ourprice', '#priceblock_dealprice',
        'div.Nx9bqj', 'div._30jeq3', 'div.hl05eU div',
      ]),
      originalPrice: firstText(['.a-text-price .a-offscreen', 'div.yRaY8j', 'div._3I9_wc']),
      discount: firstText(['.savingsPercentage', '.a-size-large.a-color-price.savingPriceOverride', 'div.UkUFwK span', 'div._3Ay6Sb span']),
      rating: firstText(['#acrPopover .a-icon-alt', 'span.a-icon-alt', 'div.XQDdHH', 'div._3LWZlK']),
      reviewCount: firstText(['#acrCustomerReviewText', 'span.Wphh3N', 'span._2_R_DZ']),
      seller: firstText([
        '#sellerProfileTriggerId', '#merchant-info', '#tabular-buybox .tabular-buybox-text[tabular-attribute-name="Sold by"]',
        '#sellerName', 'div#sellerName span', 'div._3enH42',
      ]),
      urgencyPhrases,
      passwordFields: document.querySelectorAll('input[type="password"]').length,
      offDomainForms,
      iframeCount: document.querySelectorAll('iframe').length,
      totalLinks: links.length,
      externalLinks,
      externalDomains: Array.from(externalDomains).slice(0, 15),
      textSample: bodyText.replace(/\s+/g, ' ').trim().slice(0, 3000),
      collectedAt: new Date().toISOString(),
    };
  }

  /* --------------------------- widget UI --------------------------- */

  const host = document.createElement('div');
  host.id = 'trustlens-sovereign-root';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;bottom:24px;right:24px;';
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: 'Segoe UI', system-ui, -apple-system, Roboto, sans-serif; }
      .fab {
        width: 58px; height: 58px; border-radius: 50%; border: 1px solid rgba(0,255,200,.45);
        background: radial-gradient(circle at 30% 30%, #0f2a3a, #070d16);
        box-shadow: 0 0 18px rgba(0,255,200,.35), 0 8px 24px rgba(0,0,0,.5);
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        transition: transform .2s ease, box-shadow .2s ease; position: relative; padding: 0;
      }
      .fab:hover { transform: scale(1.08); box-shadow: 0 0 26px rgba(0,255,200,.6), 0 8px 24px rgba(0,0,0,.5); }
      .fab svg { width: 28px; height: 28px; }
      .fab.scanning::after {
        content: ''; position: absolute; inset: -5px; border-radius: 50%;
        border: 2px solid transparent; border-top-color: #00ffc8; animation: spin 1s linear infinite;
      }
      .dot { position: absolute; top: 2px; right: 2px; width: 14px; height: 14px; border-radius: 50%;
        border: 2px solid #070d16; background: #64748b; }
      .dot.safe { background: #22c55e; } .dot.suspicious { background: #f59e0b; } .dot.dangerous { background: #ef4444; }
      @keyframes spin { to { transform: rotate(360deg); } }

      .panel {
        position: absolute; bottom: 72px; right: 0; width: 360px; max-height: 560px;
        background: linear-gradient(160deg, rgba(10,18,30,.97), rgba(5,9,16,.97));
        border: 1px solid rgba(0,255,200,.25); border-radius: 16px; color: #e2e8f0;
        box-shadow: 0 20px 50px rgba(0,0,0,.65), 0 0 30px rgba(0,255,200,.08);
        display: none; flex-direction: column; overflow: hidden; backdrop-filter: blur(10px);
      }
      .panel.open { display: flex; animation: pop .18s ease-out; }
      @keyframes pop { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: none; } }

      .head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px;
        border-bottom: 1px solid rgba(255,255,255,.07); }
      .brand { font-weight: 700; letter-spacing: .5px; font-size: 14px; color: #00ffc8; }
      .brand small { display: block; font-weight: 400; font-size: 10px; color: #7f8ea3; letter-spacing: 1px; text-transform: uppercase; }
      .icon-btn { background: transparent; border: 0; color: #94a3b8; cursor: pointer; font-size: 18px; padding: 4px 8px; border-radius: 6px; }
      .icon-btn:hover { background: rgba(255,255,255,.08); color: #fff; }

      .body { padding: 14px; overflow-y: auto; flex: 1; font-size: 13px; line-height: 1.45; }
      .body::-webkit-scrollbar { width: 6px; } .body::-webkit-scrollbar-thumb { background: #1e3a4a; border-radius: 3px; }

      .score-row { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; }
      .ring { --p: 0; --c: #64748b; width: 74px; height: 74px; border-radius: 50%; flex-shrink: 0;
        background: conic-gradient(var(--c) calc(var(--p) * 1%), rgba(255,255,255,.08) 0);
        display: flex; align-items: center; justify-content: center; }
      .ring-inner { width: 58px; height: 58px; border-radius: 50%; background: #0a121e; display: flex;
        align-items: center; justify-content: center; font-size: 20px; font-weight: 700; color: var(--c); }
      .verdict { font-size: 16px; font-weight: 700; }
      .verdict.safe { color: #22c55e; } .verdict.suspicious { color: #f59e0b; } .verdict.dangerous { color: #ef4444; }
      .muted { color: #7f8ea3; font-size: 11px; }
      .summary { margin: 8px 0 12px; color: #cbd5e1; }
      h4 { margin: 12px 0 6px; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #00ffc8; }
      ul { margin: 0; padding-left: 18px; } li { margin-bottom: 4px; color: #cbd5e1; }
      .threats li::marker { color: #ef4444; } .recs li::marker { color: #22c55e; }

      .btn { width: 100%; margin-top: 12px; padding: 9px; border-radius: 8px; border: 1px solid rgba(0,255,200,.4);
        background: rgba(0,255,200,.08); color: #00ffc8; font-weight: 600; cursor: pointer; font-size: 12px; letter-spacing: .5px; }
      .btn:hover { background: rgba(0,255,200,.16); } .btn:disabled { opacity: .5; cursor: not-allowed; }

      .error { background: rgba(239,68,68,.1); border: 1px solid rgba(239,68,68,.35); color: #fca5a5;
        padding: 10px; border-radius: 8px; font-size: 12px; }

      .chat { border-top: 1px solid rgba(255,255,255,.07); padding: 10px 14px 12px; }
      .msgs { max-height: 130px; overflow-y: auto; margin-bottom: 8px; display: flex; flex-direction: column; gap: 6px; }
      .msg { padding: 7px 10px; border-radius: 10px; font-size: 12px; max-width: 90%; white-space: pre-wrap; word-break: break-word; }
      .msg.user { align-self: flex-end; background: rgba(0,255,200,.15); color: #d1fae5; }
      .msg.bot { align-self: flex-start; background: rgba(255,255,255,.07); color: #e2e8f0; }
      .input-row { display: flex; gap: 6px; }
      .input-row input { flex: 1; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12);
        border-radius: 8px; color: #fff; padding: 8px 10px; font-size: 12px; outline: none; }
      .input-row input:focus { border-color: rgba(0,255,200,.6); }
      .send { background: #00ffc8; color: #04111a; border: 0; border-radius: 8px; padding: 0 14px; font-weight: 700; cursor: pointer; }
      .send:disabled { opacity: .5; cursor: not-allowed; }
    </style>

    <div class="panel" id="panel">
      <div class="head">
        <div class="brand">TRUSTLENS SOVEREIGN<small>Cyber-shield active</small></div>
        <button class="icon-btn" id="close" title="Close">✕</button>
      </div>
      <div class="body" id="body"></div>
      <div class="chat">
        <div class="msgs" id="msgs"></div>
        <div class="input-row">
          <input id="chatInput" type="text" placeholder="Ask about this page or seller..." maxlength="500" />
          <button class="send" id="send">Send</button>
        </div>
      </div>
    </div>

    <button class="fab" id="fab" title="TrustLens Sovereign">
      <svg viewBox="0 0 24 24" fill="none" stroke="#00ffc8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2l8 3v6c0 5-3.5 9.4-8 11-4.5-1.6-8-6-8-11V5l8-3z" fill="rgba(0,255,200,.12)"/>
        <path d="M8.5 12l2.5 2.5 4.5-5"/>
      </svg>
      <span class="dot" id="dot"></span>
    </button>
  `;

  const el = {
    fab: shadow.getElementById('fab'),
    dot: shadow.getElementById('dot'),
    panel: shadow.getElementById('panel'),
    close: shadow.getElementById('close'),
    body: shadow.getElementById('body'),
    msgs: shadow.getElementById('msgs'),
    input: shadow.getElementById('chatInput'),
    send: shadow.getElementById('send'),
  };

  /* DOM helper: builds nodes with textContent only (no innerHTML => no XSS from AI output) */
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  const levelClass = (verdict) => (verdict || '').toLowerCase();
  const levelColor = { safe: '#22c55e', suspicious: '#f59e0b', dangerous: '#ef4444' };

  function renderBody() {
    el.body.textContent = '';

    if (state.analyzing) {
      el.body.appendChild(h('div', { class: 'muted' }, '⏳ Scanning page telemetry with Llama 3.3 70B...'));
      return;
    }

    if (state.error) {
      el.body.appendChild(h('div', { class: 'error' }, state.error));
      el.body.appendChild(h('button', { class: 'btn', onclick: runAnalysis }, 'RETRY SCAN'));
      return;
    }

    const r = state.result;
    if (!r) {
      el.body.appendChild(h('div', { class: 'muted' }, 'No scan yet.'));
      el.body.appendChild(h('button', { class: 'btn', onclick: runAnalysis }, 'SCAN THIS PAGE'));
      return;
    }

    const lvl = levelClass(r.verdict);
    const ring = h('div', { class: 'ring', style: `--p:${r.riskScore};--c:${levelColor[lvl] || '#64748b'}` },
      h('div', { class: 'ring-inner' }, String(r.riskScore)));

    el.body.appendChild(
      h('div', { class: 'score-row' }, ring,
        h('div', {},
          h('div', { class: `verdict ${lvl}` }, r.verdict),
          h('div', { class: 'muted' }, `Risk score ${r.riskScore}/100 · Confidence ${r.confidence}%`)
        )
      )
    );
    el.body.appendChild(h('div', { class: 'summary' }, r.summary));

    if (r.threats.length) {
      el.body.appendChild(h('h4', {}, 'Detected Threats'));
      el.body.appendChild(h('ul', { class: 'threats' }, r.threats.map((t) => h('li', {}, t))));
    }
    if (r.recommendations.length) {
      el.body.appendChild(h('h4', {}, 'Recommendations'));
      el.body.appendChild(h('ul', { class: 'recs' }, r.recommendations.map((t) => h('li', {}, t))));
    }
    el.body.appendChild(h('button', { class: 'btn', onclick: runAnalysis }, 'RE-SCAN PAGE'));
  }

  function setDot() {
    el.dot.className = 'dot' + (state.result ? ' ' + levelClass(state.result.verdict) : '');
  }

  /* ----------------------------- actions ----------------------------- */

  async function runAnalysis() {
    if (state.analyzing) return;
    state.analyzing = true;
    state.error = '';
    el.fab.classList.add('scanning');
    renderBody();

    try {
      state.telemetry = collectTelemetry();
      state.result = await api('/api/analyze', { telemetry: state.telemetry });
    } catch (err) {
      state.result = null;
      state.error =
        err.name === 'AbortError'
          ? 'The analysis request timed out. Please try again.'
          : `Could not reach TrustLens backend at ${API_BASE}. Make sure the server is running (npm start). (${err.message})`;
    } finally {
      state.analyzing = false;
      el.fab.classList.remove('scanning');
      setDot();
      renderBody();
    }
  }

  function addMsg(role, text) {
    el.msgs.appendChild(h('div', { class: `msg ${role}` }, text));
    el.msgs.scrollTop = el.msgs.scrollHeight;
  }

  async function sendChat() {
    const text = el.input.value.trim();
    if (!text || el.send.disabled) return;
    el.input.value = '';
    addMsg('user', text);
    el.send.disabled = true;

    const typing = h('div', { class: 'msg bot' }, '…');
    el.msgs.appendChild(typing);
    el.msgs.scrollTop = el.msgs.scrollHeight;

    try {
      const data = await api('/api/chat', {
        message: text,
        history: state.history,
        context: state.telemetry || collectTelemetry(),
      });
      typing.remove();
      addMsg('bot', data.reply);
      state.history.push({ role: 'user', content: text }, { role: 'assistant', content: data.reply });
      state.history = state.history.slice(-10);
    } catch (err) {
      typing.remove();
      addMsg('bot', `⚠️ ${err.name === 'AbortError' ? 'Request timed out.' : err.message}`);
    } finally {
      el.send.disabled = false;
      el.input.focus();
    }
  }

  /* ----------------------------- events ----------------------------- */

  el.fab.addEventListener('click', () => {
    const open = el.panel.classList.toggle('open');
    if (open && !state.result && !state.analyzing && !state.error) runAnalysis();
  });
  el.close.addEventListener('click', () => el.panel.classList.remove('open'));
  el.send.addEventListener('click', sendChat);
  el.input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep site hotkeys from hijacking typing
    if (e.key === 'Enter') sendChat();
  });
  el.input.addEventListener('keyup', (e) => e.stopPropagation());
  el.input.addEventListener('keypress', (e) => e.stopPropagation());

  // Handle SPA navigation (Flipkart / Amazon dynamic routes)
  setInterval(() => {
    if (location.href !== state.lastUrl) {
      state.lastUrl = location.href;
      state.result = null;
      state.error = '';
      state.telemetry = null;
      state.history = [];
      el.msgs.textContent = '';
      setDot();
      renderBody();
      setTimeout(runAnalysis, 1500); // let the new view render first
    }
  }, 1000);

  /* ------------------------------ boot ------------------------------ */

  document.documentElement.appendChild(host);
  renderBody();
  setTimeout(runAnalysis, 1500); // auto-scan on load
})();