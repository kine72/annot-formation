// Annot'Formation — annotation de PDF de formation, 100 % hors ligne.
// Rendu : pdf.js · Export : pdf-lib · Stockage : IndexedDB.
import * as pdfjsLib from './lib/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;
const PDF_OPTS = {
  wasmUrl: new URL('./lib/wasm/', import.meta.url).href,
  standardFontDataUrl: new URL('./lib/standard_fonts/', import.meta.url).href,
  isEvalSupported: false,
  enableXfa: false,
};

/* =========================================================
   Petits utilitaires
   ========================================================= */
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtDate = (t) => new Date(t).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' Mo' : Math.max(1, Math.round(b / 1024)) + ' Ko');
const plural = (n, s, p) => `${n} ${n > 1 ? p : s}`;

const COLORS = { yellow: '#ffeb3b', green: '#9be58a', pink: '#ff9ecf', blue: '#8fd3ff' };
const hexToRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return { r: (n >> 16) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }; };
const hexA = (hex, a) => { const c = hexToRgb(hex); return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`; };

let toastT;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------- Boîtes de dialogue intégrées (alert/confirm sont peu fiables en PWA) ---------- */
function makeModal(title) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal" role="dialog"><h3></h3><div class="body"></div><div class="btns"></div></div>`;
  $('h3', back).textContent = title || '';
  document.body.append(back);
  return { back, body: $('.body', back), btns: $('.btns', back), close: () => back.remove() };
}
function dialog({ title, body, buttons, cancelValue = null, onOpen }) {
  return new Promise((resolve) => {
    const m = makeModal(title);
    if (typeof body === 'string') m.body.innerHTML = body; else if (body) m.body.append(body);
    const done = (v) => { m.close(); resolve(v); };
    for (const b of buttons) {
      const el = document.createElement('button');
      el.className = 'btn ' + (b.cls || '');
      el.textContent = b.label;
      el.onclick = () => done(typeof b.value === 'function' ? b.value(m) : b.value);
      m.btns.append(el);
    }
    m.back.addEventListener('click', (e) => { if (e.target === m.back) done(cancelValue); });
    onOpen?.(m);
  });
}
const confirmBox = (title, body, okLabel = 'OK', danger = false) =>
  dialog({ title, body, buttons: [{ label: 'Annuler', value: false }, { label: okLabel, value: true, cls: danger ? 'danger solid' : 'primary' }], cancelValue: false });
function promptBox(title, label, value = '', type = 'text') {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div>${esc(label)}</div><input type="${type}">`;
  const input = $('input', wrap); input.value = value;
  return dialog({
    title, body: wrap,
    buttons: [{ label: 'Annuler', value: null }, { label: 'Valider', value: () => input.value, cls: 'primary' }],
    onOpen: (m) => {
      setTimeout(() => { input.focus(); input.select(); }, 50);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.btns.lastChild.click(); });
    },
  });
}
function busy(text) {
  const m = makeModal(text);
  m.body.innerHTML = `<div class="busy-txt"></div><div class="progress"><div></div></div>`;
  return {
    set(t, frac) { if (t != null) $('.busy-txt', m.body).textContent = t; if (frac != null) $('.progress > div', m.body).style.width = Math.round(frac * 100) + '%'; },
    close: m.close,
  };
}

/* =========================================================
   IndexedDB
   ========================================================= */
let dbPromise;
function db() {
  return (dbPromise ||= new Promise((resolve, reject) => {
    const r = indexedDB.open('annotformation', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('docs', { keyPath: 'id' });
      d.createObjectStore('pdfs', { keyPath: 'id' });
      d.createObjectStore('states', { keyPath: 'docId' });
      d.createObjectStore('images', { keyPath: 'id' }).createIndex('docId', 'docId');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function tx(stores, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then((v) => { out = v; }, reject);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction annulée'));
  });
}
const idbGet = (s, k) => tx([s], 'readonly', (t) => reqP(t.objectStore(s).get(k)));
const idbPut = (s, v) => tx([s], 'readwrite', (t) => { t.objectStore(s).put(v); });
const idbAll = (s) => tx([s], 'readonly', (t) => reqP(t.objectStore(s).getAll()));
const idbImagesOf = (docId) => tx(['images'], 'readonly', (t) => reqP(t.objectStore('images').index('docId').getAll(docId)));
function idbDeleteDoc(id) {
  return tx(['docs', 'pdfs', 'states', 'images'], 'readwrite', (t) => {
    t.objectStore('docs').delete(id);
    t.objectStore('pdfs').delete(id);
    t.objectStore('states').delete(id);
    const c = t.objectStore('images').index('docId').openCursor(IDBKeyRange.only(id));
    c.onsuccess = () => { const cur = c.result; if (cur) { cur.delete(); cur.continue(); } };
  });
}

async function requestPersist() {
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch {}
}
async function updateStorageNote() {
  const el = $('#storageNote');
  try {
    const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
    const pers = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
    el.innerHTML =
      (est ? `Stockage utilisé sur cette tablette : <b>${fmtSize(est.usage || 0)}</b>. ` : '') +
      (pers
        ? 'Protection contre l’effacement automatique : <b>activée ✓</b>.'
        : '<span class="warn">Protection contre l’effacement automatique : non activée.</span> Installe l’appli sur l’écran d’accueil (menu ⋮ de Chrome → « Installer l’application »).') +
      '<br>Ta vraie sauvegarde, c’est l’export : après chaque formation, <b>Exporter → Drive</b> avec « projet modifiable » coché.';
  } catch { el.textContent = ''; }
}

/* =========================================================
   Bibliothèque
   ========================================================= */
async function renderLibrary() {
  const docs = (await idbAll('docs')).sort((a, b) => b.updated - a.updated);
  const grid = $('#docGrid');
  grid.replaceChildren();
  $('#emptyLib').classList.toggle('hidden', docs.length > 0);
  for (const d of docs) {
    const card = document.createElement('div');
    card.className = 'card';
    const stats = [plural(d.pageCount, 'diapo', 'diapos')];
    if (d.noteCount) stats.push(plural(d.noteCount, 'page de notes', 'pages de notes'));
    if (d.boxCount) stats.push(plural(d.boxCount, 'zone de texte', 'zones de texte'));
    if (d.hlCount) stats.push(plural(d.hlCount, 'surlignage', 'surlignages'));
    const exp = d.exported ? `Dernier export : ${fmtDate(d.exported)}` : '<span style="color:#a15c00">Jamais exporté</span>';
    card.innerHTML = `
      <div class="thumb"></div>
      <div class="info"><div class="t">${esc(d.title)}</div>
        <div class="m">${stats.join(' · ')}<br>Modifié le ${fmtDate(d.updated)}<br>${exp}</div></div>
      <div class="acts">
        <button class="btn" data-a="export">Exporter</button>
        <button class="btn" data-a="rename">Renommer</button>
        <button class="btn danger" data-a="delete" title="Supprimer" style="flex:0 0 46px">🗑</button>
      </div>`;
    if (d.thumb) $('.thumb', card).style.backgroundImage = `url("${d.thumb}")`;
    $('.thumb', card).onclick = $('.info', card).onclick = () => openDoc(d.id);
    $('[data-a=export]', card).onclick = () => exportFlow(d.id);
    $('[data-a=rename]', card).onclick = async () => {
      const t = await promptBox('Renommer', 'Nouveau titre :', d.title);
      if (t && t.trim()) { d.title = t.trim(); await idbPut('docs', d); renderLibrary(); }
    };
    $('[data-a=delete]', card).onclick = async () => {
      const ok = await confirmBox('Supprimer ?', `« ${esc(d.title)} » et toutes ses annotations seront effacés de la tablette. ${d.exported ? '' : '<br><b>Ce document n’a jamais été exporté.</b>'}`, 'Supprimer', true);
      if (ok) { await idbDeleteDoc(d.id); renderLibrary(); toast('Document supprimé'); }
    };
    grid.append(card);
  }
  updateStorageNote();
}

/* ---------- Import ---------- */
function destroyPdf(pdf) { try { (pdf?.loadingTask?.destroy || pdf?.destroy)?.call(pdf?.loadingTask?.destroy ? pdf.loadingTask : pdf); } catch {} }
// pdf.js ≥ 6 renvoie une Map sans contenu (lu à part) ; les versions antérieures un objet avec contenu.
async function attachmentBytes(pdf, att, name) {
  if (!att) return null;
  const entries = att instanceof Map ? [...att.entries()] : Object.entries(att);
  const hit = entries.find(([k, v]) => k === name || v?.filename === name || v?.rawFilename === name);
  if (!hit) return null;
  if (hit[1]?.content) return hit[1].content;
  return pdf.getAttachmentContent ? (await pdf.getAttachmentContent(hit[0])) || null : null;
}
async function makeThumb(pdf) {
  const page = await pdf.getPage(1);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: 400 / vp1.width });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  page.cleanup();
  return c.toDataURL('image/jpeg', 0.75);
}
async function readSizes(pdf, onStep) {
  const sizes = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i);
    const vp = p.getViewport({ scale: 1 });
    sizes.push({ w: vp.width, h: vp.height });
    if (i % 10 === 0) onStep?.(i / pdf.numPages);
  }
  return sizes;
}
async function createDoc({ pdf, bytes, title, state, images, onStep }) {
  const sizes = await readSizes(pdf, onStep);
  const thumb = await makeThumb(pdf).catch(() => null);
  const id = uid();
  const now = Date.now();
  const st = state ? { notes: state.notes || [], boxes: state.boxes || [], hls: state.hls || [] } : { notes: [], boxes: [], hls: [] };
  const doc = {
    id, title, pageCount: pdf.numPages, sizes, thumb, created: now, updated: now, exported: null,
    noteCount: st.notes.length, boxCount: st.boxes.length, hlCount: st.hls.length,
  };
  await tx(['docs', 'pdfs', 'states', 'images'], 'readwrite', (t) => {
    t.objectStore('docs').put(doc);
    t.objectStore('pdfs').put({ id, data: new Blob([bytes], { type: 'application/pdf' }) });
    t.objectStore('states').put({ docId: id, ...st });
    for (const im of images || []) t.objectStore('images').put({ ...im, docId: id });
  });
  return id;
}
async function importFile(file) {
  const b = busy('Import du PDF…');
  let pdf;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    pdf = await pdfjsLib.getDocument({ ...PDF_OPTS, data: bytes.slice() }).promise;
    let att = null;
    try { att = await pdf.getAttachments(); } catch {}
    const proj = await attachmentBytes(pdf, att, 'annotformation-project.json').catch(() => null);
    const orig = proj && (await attachmentBytes(pdf, att, 'annotformation-original.pdf').catch(() => null));
    if (proj && orig) {
      b.close();
      const choice = await dialog({
        title: 'Projet Annot’Formation détecté',
        body: 'Ce PDF a été exporté depuis Annot’Formation avec ses annotations <b>modifiables</b>. Que veux-tu faire ?',
        buttons: [
          { label: 'Annuler', value: null },
          { label: 'Simple PDF', value: 'plain' },
          { label: 'Restaurer le projet', value: 'restore', cls: 'primary' },
        ],
      });
      if (!choice) return;
      if (choice === 'restore') { await restoreProject(proj, orig, file.name); return; }
    }
    b.set('Lecture des pages…', 0);
    const title = file.name.replace(/\.pdf$/i, '') || 'Sans titre';
    await createDoc({ pdf, bytes, title, onStep: (f) => b.set(null, f) });
    await requestPersist();
    toast('PDF importé ✓');
  } catch (err) {
    console.error(err);
    dialog({ title: 'Import impossible', body: esc(err.message || String(err)), buttons: [{ label: 'OK', value: null, cls: 'primary' }] });
  } finally {
    b.close();
    destroyPdf(pdf);
    renderLibrary();
  }
}
async function restoreProject(projBytes, origBytes, fileName) {
  const b = busy('Restauration du projet…');
  let pdf;
  try {
    const proj = JSON.parse(new TextDecoder().decode(projBytes));
    if (proj.app !== 'annotformation') throw new Error('Format de projet inconnu');
    const bytes = new Uint8Array(origBytes);
    pdf = await pdfjsLib.getDocument({ ...PDF_OPTS, data: bytes.slice() }).promise;
    // Nouvelles clés pour les images (évite les collisions si on restaure deux fois)
    const remap = new Map();
    const images = [];
    for (const [oldId, im] of Object.entries(proj.images || {})) {
      const id = uid(); remap.set(oldId, id);
      const bin = Uint8Array.from(atob(im.b64), (c) => c.charCodeAt(0));
      images.push({ id, blob: new Blob([bin], { type: 'image/jpeg' }), w: im.w, h: im.h });
    }
    const state = proj.state || {};
    for (const n of state.notes || []) n.html = (n.html || '').replace(/data-img="([^"]+)"/g, (m, id) => `data-img="${remap.get(id) || id}"`);
    const id = await createDoc({ pdf, bytes, title: proj.title || fileName.replace(/\.pdf$/i, ''), state, images, onStep: (f) => b.set(null, f) });
    await requestPersist();
    b.close();
    toast('Projet restauré ✓');
    await renderLibrary();
    openDoc(id);
  } catch (err) {
    console.error(err);
    dialog({ title: 'Restauration impossible', body: esc(err.message || String(err)), buttons: [{ label: 'OK', value: null, cls: 'primary' }] });
  } finally { b.close(); destroyPdf(pdf); }
}

/* =========================================================
   Lecteur
   ========================================================= */
const R = {
  doc: null, pdf: null, state: null,
  pageEls: [], noteEls: new Map(), boxEls: new Map(), imgUrls: new Map(),
  W: 0, visible: new Set(), renderGen: 0, io: null, ro: null,
  mode: null, activeEditor: null, savedRange: null, dirtyEds: new Set(), saveT: null,
  photoTarget: null, editHl: null, lastColor: 'yellow', curPage: 0,
};
const viewer = $('#viewer');
const noteById = (id) => R.state.notes.find((n) => n.id === id);
const boxById = (id) => R.state.boxes.find((b) => b.id === id);

async function openDoc(id) {
  const b = busy('Ouverture…');
  try {
    const [doc, pdfRec, state, imgs] = await Promise.all([idbGet('docs', id), idbGet('pdfs', id), idbGet('states', id), idbImagesOf(id)]);
    if (!doc || !pdfRec) throw new Error('Document introuvable');
    const data = new Uint8Array(await pdfRec.data.arrayBuffer());
    R.pdf = await pdfjsLib.getDocument({ ...PDF_OPTS, data }).promise;
    R.doc = doc;
    R.state = { docId: id, notes: [], boxes: [], hls: [], ...(state || {}) };
    R.imgUrls = new Map(imgs.map((im) => [im.id, URL.createObjectURL(im.blob)]));
    // Ménage : images qui ne sont plus utilisées dans aucune note
    const used = new Set();
    for (const n of R.state.notes) for (const m of (n.html || '').matchAll(/data-img="([^"]+)"/g)) used.add(m[1]);
    const orphans = imgs.filter((im) => !used.has(im.id)).map((im) => im.id);
    if (orphans.length) tx(['images'], 'readwrite', (t) => orphans.forEach((k) => t.objectStore('images').delete(k))).catch(() => {});

    $('#library').classList.add('hidden');
    $('#reader').classList.remove('hidden');
    $('#docTitle').textContent = doc.title;
    setSaveState('ok');
    history.pushState({ reader: id }, '');
    buildReader();
  } catch (err) {
    console.error(err);
    dialog({ title: 'Ouverture impossible', body: esc(err.message || String(err)), buttons: [{ label: 'OK', value: null, cls: 'primary' }] });
  } finally { b.close(); }
}

async function closeReader(fromPopstate = false) {
  if (!R.doc) return;
  deselectImage();
  deactivateEditor();
  await saveNow();
  R.io?.disconnect(); R.ro?.disconnect();
  destroyPdf(R.pdf);
  for (const u of R.imgUrls.values()) URL.revokeObjectURL(u);
  Object.assign(R, { doc: null, pdf: null, state: null, pageEls: [], visible: new Set(), mode: null });
  R.noteEls.clear(); R.boxEls.clear(); R.imgUrls = new Map();
  viewer.replaceChildren();
  setMode(null);
  hidePops();
  $('#reader').classList.add('hidden');
  $('#library').classList.remove('hidden');
  if (!fromPopstate && history.state?.reader) history.back();
  renderLibrary();
}

function buildReader() {
  viewer.replaceChildren();
  R.pageEls = []; R.noteEls.clear(); R.boxEls.clear(); R.visible = new Set();
  const n = R.doc.pageCount;
  const byAfter = new Map();
  for (const note of R.state.notes) { if (!byAfter.has(note.after)) byAfter.set(note.after, []); byAfter.get(note.after).push(note); }
  for (let i = 0; i < n; i++) {
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.i = i;
    el.innerHTML = `<canvas class="pc"></canvas><div class="layer hlLayer"></div><div class="textLayer"></div><div class="layer boxLayer"></div><div class="layer freeLayer"></div><div class="pnum">${i + 1}</div>`;
    setupFreeLayer(el);
    viewer.append(el);
    R.pageEls.push(el);
    for (const note of byAfter.get(i) || []) viewer.append(makeNote(note));
    const chip = document.createElement('button');
    chip.className = 'addNote';
    chip.dataset.after = i;
    chip.textContent = `＋ Page de notes après la diapo ${i + 1}`;
    chip.onclick = () => addNote(i);
    viewer.append(chip);
  }
  for (const b of R.state.boxes) if (b.page < n) makeBox(b);
  for (let i = 0; i < n; i++) renderHls(i);
  layout();

  R.io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const i = +e.target.dataset.i;
      if (e.isIntersecting) { R.visible.add(i); queueRender(i); } else { R.visible.delete(i); releasePage(i); }
    }
    updatePageIndicator();
  }, { root: viewer, rootMargin: '150% 0px' });
  R.pageEls.forEach((el) => R.io.observe(el));

  let lastW = viewer.clientWidth, roT;
  R.ro = new ResizeObserver(() => {
    clearTimeout(roT);
    roT = setTimeout(() => { if (Math.abs(viewer.clientWidth - lastW) > 2) { lastW = viewer.clientWidth; const keep = R.curPage; layout(); R.pageEls[keep]?.scrollIntoView({ block: 'start' }); } }, 180);
  });
  R.ro.observe(viewer);
  viewer.scrollTop = 0;
  updatePageIndicator();
}

function layout() {
  const W = Math.floor(Math.min(viewer.clientWidth - 20, 1400));
  if (W <= 0) return;
  R.W = W;
  R.pageEls.forEach((el, i) => {
    const sz = R.doc.sizes[i];
    const s = W / sz.w;
    el._s = s;
    el.style.width = W + 'px';
    el.style.height = sz.h * s + 'px';
    el.style.setProperty('--s', s);
    el.style.setProperty('--total-scale-factor', s);
  });
  for (const [id, el] of R.noteEls) layoutNote(el, noteById(id));
  R.renderGen++;
  for (const i of R.visible) queueRender(i);
}
function layoutNote(el, n) {
  if (!n || !R.W) return;
  const s = R.W / n.w;
  el.style.width = R.W + 'px';
  const paper = $('.note-paper', el);
  paper.style.setProperty('--s', s);
  paper.style.setProperty('--ph', n.h);
  paper.style.minHeight = n.h * s + 'px';
  $('.note-edit', el).style.minHeight = (n.h - NOTE_M.top - NOTE_M.bottom) / 11 + 'em';
}

/* ---------- Rendu paresseux des pages ---------- */
const renderQ = [];
let rendering = 0;
function queueRender(i) { if (!renderQ.includes(i)) renderQ.push(i); pumpRender(); }
function pumpRender() {
  while (rendering < 2 && renderQ.length) {
    const i = renderQ.shift();
    if (!R.visible.has(i)) continue;
    rendering++;
    renderPage(i).catch((e) => console.warn('rendu page', i + 1, e)).finally(() => { rendering--; pumpRender(); });
  }
}
function selectionInside(node) {
  const sel = getSelection();
  return sel.rangeCount > 0 && !sel.isCollapsed && node.contains(sel.anchorNode);
}
async function renderPage(i) {
  const el = R.pageEls[i];
  const pdf = R.pdf;
  const gen = R.renderGen;
  if (!el || el._gen === gen) return;
  const page = await pdf.getPage(i + 1);
  if (pdf !== R.pdf) return;
  const s = el._s;
  const vp = page.getViewport({ scale: s });
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (vp.width * dpr > 2400) dpr = 2400 / vp.width;
  const canvas = document.createElement('canvas');
  canvas.className = 'pc';
  canvas.width = Math.round(vp.width * dpr);
  canvas.height = Math.round(vp.height * dpr);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
  if (pdf !== R.pdf || gen !== R.renderGen || !R.visible.has(i)) { canvas.width = 0; return; }
  const old = $('canvas.pc', el);
  old.replaceWith(canvas);
  old.width = 0;
  const tl = $('.textLayer', el);
  if (!selectionInside(tl)) {
    const ntl = document.createElement('div');
    ntl.className = 'textLayer';
    const textLayer = new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: ntl, viewport: vp });
    await textLayer.render();
    if (pdf !== R.pdf) return;
    const eoc = document.createElement('div'); eoc.className = 'endOfContent'; ntl.append(eoc);
    $('.textLayer', el).replaceWith(ntl);
    el._hasText = ntl.textContent.trim().length > 0;
  }
  el._gen = gen;
}
function releasePage(i) {
  const el = R.pageEls[i];
  if (!el || el._gen == null) return;
  const old = $('canvas.pc', el);
  const c = document.createElement('canvas'); c.className = 'pc';
  old.replaceWith(c); old.width = 0;
  const tl = $('.textLayer', el);
  if (!selectionInside(tl)) tl.replaceChildren();
  el._gen = null;
}

/* ---------- Indicateur de diapo ---------- */
let scrollRaf = 0;
viewer.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updatePageIndicator(); if (R.selImg) positionImgUI(); });
  hidePops(true);
  if (!$('#hlPop').classList.contains('hidden')) { clearTimeout(selT); selT = setTimeout(onTextSelection, 120); }
}, { passive: true });
function updatePageIndicator() {
  if (!R.doc) return;
  const vr = viewer.getBoundingClientRect();
  const mid = vr.top + viewer.clientHeight * 0.35;
  let best = R.curPage, bestD = Infinity;
  for (const i of R.visible) {
    const r = R.pageEls[i].getBoundingClientRect();
    const d = mid < r.top ? r.top - mid : mid > r.bottom ? mid - r.bottom : 0;
    if (d < bestD || (d === bestD && i < best)) { bestD = d; best = i; }
  }
  R.curPage = best;
  $('#pageInd').textContent = `${best + 1} / ${R.doc.pageCount}`;
}
$('#pageInd').onclick = async () => {
  if (!R.doc) return;
  const v = await promptBox('Aller à la diapo', `Numéro (1 à ${R.doc.pageCount}) :`, String(R.curPage + 1), 'number');
  const n = parseInt(v, 10);
  if (n >= 1 && n <= R.doc.pageCount) R.pageEls[n - 1].scrollIntoView({ block: 'start' });
};

/* =========================================================
   Éditeurs de texte riche (zones et notes)
   ========================================================= */
function setupEditor(ed, kind, id) {
  ed._kind = kind; ed._id = id;
  ed.addEventListener('focusin', () => activateEditor(ed));
  ed.addEventListener('input', () => { convertSizeMarkers(ed); updateEmpty(ed); markDirty(ed); });
  ed.addEventListener('paste', (e) => {
    const t = e.clipboardData?.getData('text/plain');
    if (t != null && t !== '') { e.preventDefault(); document.execCommand('insertText', false, t); }
  });
  ed.addEventListener('keydown', onEditorKey);
  if (kind === 'note') {
    ed.addEventListener('click', (e) => { if (e.target.tagName === 'IMG') selectImage(e.target); });
    ed.addEventListener('contextmenu', (e) => { if (e.target.tagName === 'IMG') e.preventDefault(); });
    ed.addEventListener('input', () => { if (R.selImg) requestAnimationFrame(positionImgUI); });
  }
  updateEmpty(ed);
}

/* ---------- Photos : sélection, taille, position ---------- */
const imgPop = $('#imgPop'), imgHandle = $('#imgHandle');
function imgBlock(img) {
  const ed = img.closest('.note-edit');
  let b = img;
  while (b && b.parentNode !== ed) b = b.parentNode;
  return b || img;
}
function selectImage(img) {
  if (R.selImg !== img) {
    deselectImage();
    R.selImg = img;
    img.classList.add('sel');
    imgPop.classList.remove('hidden');
    imgHandle.classList.remove('hidden');
  }
  positionImgUI();
}
function deselectImage() {
  if (!R.selImg) return;
  R.selImg.classList.remove('sel');
  if (!R.selImg.getAttribute('class')) R.selImg.removeAttribute('class');
  R.selImg = null;
  imgPop.classList.add('hidden');
  imgHandle.classList.add('hidden');
}
function imgPct(img) {
  const bw = imgBlock(img).getBoundingClientRect().width || 1;
  return Math.round((img.getBoundingClientRect().width / bw) * 100);
}
// largeur max (en %) pour que la photo tienne sur une page du PDF exporté
function maxPct(img) {
  const paper = img.closest('.note-paper');
  const s = parseFloat(paper.style.getPropertyValue('--s')) || 1;
  const ph = parseFloat(paper.style.getPropertyValue('--ph')) || 400;
  const capH = (ph - NOTE_M.top - NOTE_M.bottom - 12) * s;
  const ratio = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : (img.width / img.height) || 1.33;
  const bw = imgBlock(img).getBoundingClientRect().width || 1;
  return clamp(Math.floor(((capH * ratio) / bw) * 100), 10, 100);
}
function setImgPct(img, pct) { img.style.width = clamp(Math.round(pct), 10, maxPct(img)) + '%'; }
function positionImgUI() {
  const img = R.selImg;
  if (!img || !img.isConnected) { deselectImage(); return; }
  const r = img.getBoundingClientRect();
  const vr = viewer.getBoundingClientRect();
  const off = r.bottom < vr.top || r.top > vr.bottom;
  imgPop.style.visibility = imgHandle.style.visibility = off ? 'hidden' : '';
  if (off) return;
  $('#imgPct').textContent = imgPct(img) + ' %';
  for (const k of ['left', 'center', 'right']) {
    const on = k === 'center' ? !img.classList.contains('al-left') && !img.classList.contains('al-right') : img.classList.contains('al-' + k);
    $(`[data-i=${k}]`, imgPop).classList.toggle('on', on);
  }
  const pw = imgPop.offsetWidth, ph = imgPop.offsetHeight;
  let top = r.top - ph - 12;
  if (top < vr.top + 4) top = Math.min(r.bottom + 12, innerHeight - ph - 8);
  imgPop.style.top = top + 'px';
  imgPop.style.left = clamp(r.left + r.width / 2 - pw / 2, 8, innerWidth - pw - 8) + 'px';
  const right = img.classList.contains('al-right');
  imgHandle.classList.toggle('flip', right);
  imgHandle.style.top = clamp(r.bottom - 24, vr.top, innerHeight - 50) + 'px';
  imgHandle.style.left = (right ? r.left - 20 : r.right - 24) + 'px';
}
function ensureTrailingP(ed) {
  const l = ed.lastElementChild;
  if (!l || l.classList.contains('ph') || l.querySelector('img')) { const p = document.createElement('p'); p.innerHTML = '<br>'; ed.append(p); }
}
for (const ev of ['pointerdown', 'mousedown']) imgPop.addEventListener(ev, (e) => e.preventDefault());
imgPop.addEventListener('click', (e) => {
  const b = e.target.closest('[data-i]');
  const img = R.selImg;
  if (!b || !img) return;
  const ed = img.closest('.note-edit');
  const blk = imgBlock(img);
  const act = b.dataset.i;
  if (act === 'smaller' || act === 'bigger') setImgPct(img, imgPct(img) + (act === 'bigger' ? 10 : -10));
  else if (act === 'left' || act === 'center' || act === 'right') {
    img.classList.remove('al-left', 'al-center', 'al-right');
    if (act !== 'center') { img.classList.add('al-' + act); if (!img.style.width || imgPct(img) > 60) setImgPct(img, Math.min(45, imgPct(img))); }
  } else if (act === 'up') { const p = blk.previousElementSibling; if (p) p.before(blk); }
  else if (act === 'down') { const n = blk.nextElementSibling; if (n) n.after(blk); }
  else if (act === 'del') { deselectImage(); blk.remove(); ensureTrailingP(ed); updateEmpty(ed); markDirty(ed); return; }
  ensureTrailingP(ed);
  markDirty(ed);
  requestAnimationFrame(() => { img.scrollIntoView({ block: 'nearest' }); positionImgUI(); });
});
imgHandle.addEventListener('pointerdown', (e) => {
  const img = R.selImg;
  if (!img) return;
  e.preventDefault();
  imgHandle.setPointerCapture(e.pointerId);
  const r0 = img.getBoundingClientRect();
  const bw = imgBlock(img).getBoundingClientRect().width || 1;
  const ratio = r0.width / r0.height;
  const right = img.classList.contains('al-right');
  const centered = !right && !img.classList.contains('al-left');
  const sx = e.clientX, sy = e.clientY;
  const move = (ev) => {
    const dx = (ev.clientX - sx) * (right ? -1 : 1), dy = (ev.clientY - sy) * ratio;
    const d = ((dx + dy) / 2) * (centered ? 2 : 1);
    setImgPct(img, ((r0.width + d) / bw) * 100);
    positionImgUI();
  };
  const up = () => {
    imgHandle.removeEventListener('pointermove', move); imgHandle.removeEventListener('pointerup', up); imgHandle.removeEventListener('pointercancel', up);
    markDirty(img.closest('.note-edit'));
  };
  imgHandle.addEventListener('pointermove', move);
  imgHandle.addEventListener('pointerup', up);
  imgHandle.addEventListener('pointercancel', up);
});
/* ---------- Taille du texte (échelle 4 → 25) ----------
   1 unité = 1 pt de la page de notes ; dans une zone de texte, 11 = taille de base de la zone.
   La taille est stockée en calc(var(--u) * N) : elle suit le zoom et le bouton A−/A＋. */
const SIZE_MARK = '7';
function boxUnit(fs) { return `calc(var(--s, 1) * ${(fs / 11).toFixed(4)}px)`; }
function sizeStyle(n) { return `calc(var(--u) * ${n})`; }
function applySize(n) {
  if (!ensureFocus()) return;
  const ed = R.activeEditor;
  R.pendingSize = n;
  document.execCommand('styleWithCSS', false, false);
  document.execCommand('fontSize', false, SIZE_MARK);
  convertSizeMarkers(ed, true);
  markDirty(ed);
}
// execCommand crée des <font size=7> : on les remplace par des <span> à notre échelle
function convertSizeMarkers(ed, reselect) {
  const fonts = ed.querySelectorAll(`font[size="${SIZE_MARK}"]`);
  if (!fonts.length) return;
  const n = R.pendingSize || 11;
  const sel = getSelection();
  const saved = sel.rangeCount ? { a: sel.anchorNode, ao: sel.anchorOffset, f: sel.focusNode, fo: sel.focusOffset, collapsed: sel.isCollapsed } : null;
  const spans = [];
  for (const f of fonts) {
    const span = document.createElement('span');
    span.style.fontSize = sizeStyle(n);
    for (const k of ['color', 'face']) if (f.getAttribute(k)) { if (k === 'color') span.style.color = f.getAttribute(k); }
    span.append(...f.childNodes);
    for (const d of span.querySelectorAll('[style]')) { d.style.fontSize = ''; if (!d.getAttribute('style')) d.removeAttribute('style'); }
    for (const d of span.querySelectorAll(`font[size]`)) d.removeAttribute('size');
    f.replaceWith(span);
    spans.push(span);
  }
  try {
    if (reselect && saved && !saved.collapsed && spans.length) {
      const r = document.createRange();
      r.setStartBefore(spans[0]); r.setEndAfter(spans[spans.length - 1]);
      sel.removeAllRanges(); sel.addRange(r);
    } else if (saved && ed.contains(saved.a)) {
      sel.setBaseAndExtent(saved.a, saved.ao, saved.f, saved.fo);
    } else if (saved?.collapsed && spans.length) {
      const last = spans[spans.length - 1];
      const r = document.createRange(); r.selectNodeContents(last); r.collapse(false);
      sel.removeAllRanges(); sel.addRange(r);
    }
  } catch {}
}
function currentSize() {
  const ed = R.activeEditor, sel = getSelection();
  if (!ed || !sel.rangeCount || !ed.contains(sel.anchorNode)) return '';
  const el = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
  const px = parseFloat(getComputedStyle(el).fontSize);
  const holder = ed._kind === 'box' ? R.boxEls.get(ed._id) : ed.closest('.note-paper');
  const s = parseFloat(getComputedStyle(holder || ed).getPropertyValue('--s')) || 1;
  const unit = ed._kind === 'box' ? s * ((boxById(ed._id)?.fs || 11) / 11) : s;
  return String(Math.round(px / unit));
}
const sizeSel = $('#sizeSel');
sizeSel.addEventListener('change', () => { const n = parseInt(sizeSel.value, 10); if (n) applySize(n); });

function updateEmpty(ed) { ed.classList.toggle('is-empty', !ed.textContent.trim() && !ed.querySelector('img')); }

const fmtBar = $('#fmtBar');
function activateEditor(ed) {
  if (R.activeEditor === ed) return;
  deactivateEditor(ed);
  R.activeEditor = ed;
  fmtBar.classList.remove('disabled');
  $('#boxTools').classList.toggle('hidden', ed._kind !== 'box');
  $('#noteTools').classList.toggle('hidden', ed._kind !== 'note');
  if (ed._kind === 'box') R.boxEls.get(ed._id)?.classList.add('active');
}
function deactivateEditor(next) {
  const ed = R.activeEditor;
  if (!ed) return;
  if (ed._kind === 'box') {
    R.boxEls.get(ed._id)?.classList.remove('active');
    if (!ed.textContent.trim()) removeBox(ed._id, true);
  }
  R.activeEditor = null;
  R.savedRange = null;
  if (!next) {
    fmtBar.classList.add('disabled');
    $('#boxTools').classList.add('hidden');
    $('#noteTools').classList.add('hidden');
    if (document.activeElement === ed) ed.blur();
  }
}
function ensureFocus() {
  const ed = R.activeEditor;
  if (!ed) return false;
  if (document.activeElement !== ed) {
    ed.focus({ preventScroll: true });
    if (R.savedRange) { const s = getSelection(); s.removeAllRanges(); s.addRange(R.savedRange); }
  }
  return true;
}
function execFmt(cmd, val) {
  if (!ensureFocus()) return;
  if (cmd === 'foreColor' || cmd === 'hiliteColor') document.execCommand('styleWithCSS', false, true);
  document.execCommand(cmd, false, val);
  if (cmd === 'foreColor' || cmd === 'hiliteColor') document.execCommand('styleWithCSS', false, false);
  updateEmpty(R.activeEditor);
  markDirty(R.activeEditor);
  refreshFmtState();
}
function refreshFmtState() {
  for (const b of $$('.fb[data-cmd]', fmtBar)) {
    const c = b.dataset.cmd;
    if (['bold', 'italic', 'underline', 'insertUnorderedList', 'insertOrderedList'].includes(c)) {
      let on = false; try { on = document.queryCommandState(c); } catch {}
      b.classList.toggle('on', !!on && !!R.activeEditor);
    }
  }
}
fmtBar.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
fmtBar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
fmtBar.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !R.activeEditor) return;
  const ed = R.activeEditor;
  if (b.dataset.cmd) execFmt(b.dataset.cmd);
  else if (b.dataset.block) execFmt('formatBlock', b.dataset.block);
  else if (b.dataset.color) execFmt('foreColor', b.dataset.color);
  else if (b.dataset.hilite) execFmt('hiliteColor', b.dataset.hilite);
  else if (b.dataset.box && ed._kind === 'box') boxAction(b.dataset.box, ed);
  else if (b.dataset.note && ed._kind === 'note') { R.photoTarget = ed._id; (b.dataset.note === 'cam' ? $('#camInput') : $('#galInput')).click(); }
});
function onEditorKey(e) {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.altKey && /^(Digit|Numpad)[120]$/.test(e.code)) {
    e.preventDefault();
    execFmt('formatBlock', { 1: 'h1', 2: 'h2', 0: 'p' }[e.code.slice(-1)]);
  } else if (mod && e.shiftKey && (e.code === 'Digit8' || e.code === 'Digit7')) {
    e.preventDefault();
    execFmt(e.code === 'Digit8' ? 'insertUnorderedList' : 'insertOrderedList');
  } else if (mod && (e.key === 's' || e.key === 'S')) {
    e.preventDefault(); saveNow().then(() => toast('Enregistré ✓', 1200));
  } else if (e.key === 'Escape') {
    deactivateEditor();
  }
}

/* ---------- Zones de texte sur les diapos ---------- */
function makeBox(b) {
  const el = document.createElement('div');
  el.className = 'tbox bg-' + (b.bg || 'white');
  el.dataset.id = b.id;
  el.style.left = b.x + 'em'; el.style.top = b.y + 'em'; el.style.width = b.w + 'em';
  el.innerHTML = `<div class="tb-grip" title="Déplacer">✥</div><div class="tb-edit rich" contenteditable="true" data-ph="Ton texte…"></div><div class="tb-resize" title="Largeur">↔</div>`;
  const ed = $('.tb-edit', el);
  ed.style.fontSize = b.fs + 'em';
  ed.style.setProperty('--u', boxUnit(b.fs));
  ed.innerHTML = b.html || '';
  setupEditor(ed, 'box', b.id);
  const pageEl = R.pageEls[b.page];
  const sz = R.doc.sizes[b.page];
  const drag = (handle, onMove) => {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const sx = e.clientX, sy = e.clientY, ox = b.x, oy = b.y, ow = b.w;
      const move = (ev) => onMove((ev.clientX - sx) / pageEl._s, (ev.clientY - sy) / pageEl._s, ox, oy, ow);
      const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); markDirty(); };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  };
  drag($('.tb-grip', el), (dx, dy, ox, oy) => {
    b.x = clamp(ox + dx, -b.w + 20, sz.w - 20); b.y = clamp(oy + dy, 0, sz.h - 10);
    el.style.left = b.x + 'em'; el.style.top = b.y + 'em';
  });
  drag($('.tb-resize', el), (dx, dy, ox, oy, ow) => {
    b.w = clamp(ow + dx, 30, sz.w * 1.2); el.style.width = b.w + 'em';
  });
  $('.boxLayer', pageEl).append(el);
  R.boxEls.set(b.id, el);
  return el;
}
function addBox(page, x, y) {
  const sz = R.doc.sizes[page];
  const fs = clamp(Math.round(sz.w / 52), 8, 60);
  const w = clamp(Math.min(sz.w * 0.38, sz.w - x - 4), Math.min(80, sz.w * 0.3), sz.w);
  const b = { id: uid(), page, x: clamp(x - fs * 0.45, 0, sz.w - 30), y: clamp(y - fs * 0.7, 0, sz.h - fs * 1.5), w, fs, bg: 'white', html: '' };
  R.state.boxes.push(b);
  const el = makeBox(b);
  const ed = $('.tb-edit', el);
  ed.focus();
  markDirty();
}
function removeBox(id, silent) {
  const i = R.state.boxes.findIndex((b) => b.id === id);
  if (i < 0) return;
  R.state.boxes.splice(i, 1);
  const el = R.boxEls.get(id);
  if (el) { R.dirtyEds.delete($('.tb-edit', el)); el.remove(); }
  R.boxEls.delete(id);
  if (R.activeEditor?._id === id) { R.activeEditor = null; fmtBar.classList.add('disabled'); $('#boxTools').classList.add('hidden'); }
  markDirty();
  if (!silent) toast('Zone supprimée');
}
function boxAction(act, ed) {
  const b = boxById(ed._id);
  if (!b) return;
  const el = R.boxEls.get(b.id);
  if (act === 'smaller' || act === 'bigger') {
    b.fs = clamp(b.fs + (act === 'bigger' ? 1 : -1) * Math.max(1, Math.round(b.fs * 0.1)), 5, 120);
    ed.style.fontSize = b.fs + 'em';
    ed.style.setProperty('--u', boxUnit(b.fs));
  } else if (act === 'bg') {
    const order = ['white', 'yellow', 'none'];
    b.bg = order[(order.indexOf(b.bg || 'white') + 1) % order.length];
    el.className = el.className.replace(/bg-\w+/, 'bg-' + b.bg);
    toast({ white: 'Fond blanc', yellow: 'Fond post-it', none: 'Fond transparent' }[b.bg], 1200);
  } else if (act === 'delete') {
    removeBox(b.id);
    return;
  }
  markDirty();
}

/* ---------- Pages de notes ---------- */
function makeNote(n) {
  const el = document.createElement('section');
  el.className = 'note';
  el.dataset.id = n.id;
  el.innerHTML = `
    <div class="note-head"><span class="lbl">📝 Notes — après la diapo ${n.after + 1}</span>
      <button class="btn small" data-a="cam" title="Prendre une photo">📷 Photo</button>
      <button class="btn small" data-a="gal" title="Importer une image">🖼 Image</button>
      <button class="btn small danger" data-a="del" title="Supprimer cette page">🗑</button></div>
    <div class="note-paper"><div class="note-edit rich" contenteditable="true" data-ph="Tes notes… (titres, listes, gras : barre d’outils en haut)"></div></div>`;
  const ed = $('.note-edit', el);
  ed.innerHTML = n.html || '<p><br></p>';
  hydrateImages(ed, R.imgUrls);
  setupEditor(ed, 'note', n.id);
  $('.note-paper', el).addEventListener('click', (e) => {
    if (e.target.closest('.rich')) return;
    ed.focus({ preventScroll: true });
    const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  $('[data-a=cam]', el).onclick = () => { R.photoTarget = n.id; $('#camInput').click(); };
  $('[data-a=gal]', el).onclick = () => { R.photoTarget = n.id; $('#galInput').click(); };
  $('[data-a=del]', el).onclick = async () => {
    const empty = !ed.textContent.trim() && !ed.querySelector('img');
    if (!empty && !(await confirmBox('Supprimer cette page de notes ?', 'Son texte et ses photos seront effacés.', 'Supprimer', true))) return;
    if (R.activeEditor === ed) deactivateEditor();
    R.state.notes = R.state.notes.filter((x) => x.id !== n.id);
    R.dirtyEds.delete(ed);
    R.noteEls.delete(n.id);
    el.remove();
    markDirty();
  };
  R.noteEls.set(n.id, el);
  layoutNote(el, n);
  return el;
}
function hydrateImages(root, urls) {
  for (const img of $$('img[data-img]', root)) { img.src = urls.get(img.dataset.img) || ''; img.draggable = false; }
}
function addNote(after) {
  const sz = R.doc.sizes[after];
  const w = 640;
  const h = Math.round(w * clamp(sz.h / sz.w, 0.5, 1.5));
  const n = { id: uid(), after, w, h, html: '<p><br></p>' };
  R.state.notes.push(n);
  const el = makeNote(n);
  const chip = $(`.addNote[data-after="${after}"]`, viewer);
  viewer.insertBefore(el, chip);
  layoutNote(el, n);
  const ed = $('.note-edit', el);
  ed.focus();
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  markDirty();
}

/* ---------- Photos ---------- */
async function compressImage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { bmp = await createImageBitmap(file); }
  const k = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  if (!blob) throw new Error('compression impossible');
  return { blob, w, h };
}
async function onPhotoFiles(files) {
  const n = R.doc && noteById(R.photoTarget);
  if (!n || !files.length) return;
  const ed = $('.note-edit', R.noteEls.get(n.id));
  let anchor = null;
  if (R.savedRange && ed.contains(R.savedRange.startContainer)) {
    anchor = R.savedRange.startContainer;
    while (anchor && anchor.parentNode !== ed) anchor = anchor.parentNode;
  }
  let lastAfter = null;
  for (const f of files) {
    try {
      const { blob, w, h } = await compressImage(f);
      const id = uid();
      await idbPut('images', { id, docId: R.doc.id, blob, w, h });
      const url = URL.createObjectURL(blob);
      R.imgUrls.set(id, url);
      const p = document.createElement('p'); p.className = 'ph';
      const img = new Image(); img.dataset.img = id; img.width = w; img.height = h; img.src = url; img.alt = '';
      p.append(img);
      const after = document.createElement('p'); after.innerHTML = '<br>';
      const isEmptyBlock = anchor && anchor.nodeType === 1 && !anchor.textContent.trim() && !anchor.querySelector?.('img');
      if (anchor && isEmptyBlock) anchor.replaceWith(p, after);
      else if (anchor) anchor.after(p, after);
      else ed.append(p, after);
      anchor = after; lastAfter = after;
    } catch (err) { toast('Image illisible : ' + (err.message || err)); }
  }
  if (lastAfter) {
    ed.focus({ preventScroll: true });
    const r = document.createRange(); r.setStart(lastAfter, 0); r.collapse(true);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    lastAfter.previousSibling?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  updateEmpty(ed);
  markDirty(ed);
}
for (const id of ['camInput', 'galInput']) {
  $('#' + id).addEventListener('change', (e) => { const files = [...e.target.files]; e.target.value = ''; onPhotoFiles(files); });
}

/* =========================================================
   Surlignage
   ========================================================= */
function renderHls(i) {
  const el = R.pageEls[i];
  if (!el) return;
  const layer = $('.hlLayer', el);
  layer.replaceChildren();
  for (const hl of R.state.hls) {
    if (hl.page !== i) continue;
    for (const [x, y, w, h] of hl.rects) {
      const d = document.createElement('div');
      d.className = 'hl';
      d.style.cssText = `left:${x}em;top:${y}em;width:${w}em;height:${h}em;background:${hexA(COLORS[hl.color] || COLORS.yellow, 0.75)}`;
      layer.append(d);
    }
  }
}
function mergeRects(rects) {
  rects.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out = [];
  for (const r of rects) {
    const last = out.find((o) => {
      const ov = Math.min(o[1] + o[3], r[1] + r[3]) - Math.max(o[1], r[1]);
      return ov > 0.5 * Math.min(o[3], r[3]) && r[0] <= o[0] + o[2] + 0.6 * r[3] && r[0] + r[2] >= o[0] - 0.6 * r[3];
    });
    if (last) {
      const x1 = Math.min(last[0], r[0]), y1 = Math.min(last[1], r[1]);
      const x2 = Math.max(last[0] + last[2], r[0] + r[2]), y2 = Math.max(last[1] + last[3], r[1] + r[3]);
      last[0] = x1; last[1] = y1; last[2] = x2 - x1; last[3] = y2 - y1;
    } else out.push([...r]);
  }
  return out.map((r) => r.map((v) => Math.round(v * 100) / 100));
}
const pageIndexOf = (node) => { const el = (node.nodeType === 1 ? node : node.parentElement)?.closest('.page'); return el ? +el.dataset.i : -1; };
function textLayerSelection() {
  const sel = getSelection();
  if (!R.doc || !sel.rangeCount || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  const inTL = (n) => !!(n.nodeType === 1 ? n : n.parentElement)?.closest('.textLayer');
  if (!inTL(r.startContainer) || !inTL(r.endContainer)) return null;
  return r;
}
function highlightSelection(color) {
  const r = textLayerSelection();
  if (!r) return;
  const p0 = pageIndexOf(r.startContainer), p1 = pageIndexOf(r.endContainer);
  if (p0 < 0 || p1 < 0) return;
  const byPage = new Map();
  for (const rc of r.getClientRects()) {
    if (rc.width < 1 || rc.height < 1) continue;
    const cx = rc.left + rc.width / 2, cy = rc.top + rc.height / 2;
    for (let i = p0; i <= p1; i++) {
      const pr = R.pageEls[i].getBoundingClientRect();
      if (cx < pr.left || cx > pr.right || cy < pr.top || cy > pr.bottom) continue;
      if (rc.height > pr.height * 0.25) break; // rectangle de conteneur, pas du texte
      const s = R.pageEls[i]._s;
      if (!byPage.has(i)) byPage.set(i, []);
      byPage.get(i).push([(rc.left - pr.left) / s, (rc.top - pr.top) / s, rc.width / s, rc.height / s]);
      break;
    }
  }
  for (const [i, list] of byPage) {
    const hs = list.map((x) => x[3]).sort((a, b) => a - b);
    const med = hs[Math.floor(hs.length / 2)];
    const rects = mergeRects(list.filter((x) => x[3] <= med * 3));
    if (rects.length) R.state.hls.push({ id: uid(), page: i, color, rects });
    renderHls(i);
  }
  R.lastColor = color;
  getSelection().removeAllRanges();
  hidePops();
  markDirty();
}
let selT;
document.addEventListener('selectionchange', () => {
  // mémorise la position du curseur dans l'éditeur actif (pour la barre d'outils et les photos)
  const sel = getSelection();
  if (R.activeEditor && sel.rangeCount && R.activeEditor.contains(sel.anchorNode)) {
    R.savedRange = sel.getRangeAt(0).cloneRange();
    refreshFmtState();
    const v = currentSize();
    sizeSel.value = [...sizeSel.options].some((o) => o.value === v) ? v : '';
  }
  clearTimeout(selT);
  selT = setTimeout(onTextSelection, 200);
});
function onTextSelection() {
  const pop = $('#hlPop');
  const r = textLayerSelection();
  if (!r || R.mode) { pop.classList.add('hidden'); return; }
  const rects = [...r.getClientRects()].filter((x) => x.width > 1 && x.height > 1 && x.height < 200);
  if (!rects.length) { pop.classList.add('hidden'); return; }
  const last = rects[rects.length - 1], first = rects[0];
  pop.classList.remove('hidden');
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let top = last.bottom + 14;
  if (top + ph > innerHeight - 8) top = Math.max(8, first.top - ph - 60);
  pop.style.top = top + 'px';
  pop.style.left = clamp(last.left + last.width / 2 - pw / 2, 8, innerWidth - pw - 8) + 'px';
}
for (const ev of ['pointerdown', 'mousedown']) $('#hlPop').addEventListener(ev, (e) => e.preventDefault());
$('#hlPop').addEventListener('click', (e) => { const c = e.target.closest('[data-c]')?.dataset.c; if (c) highlightSelection(c); });

// Toucher un surlignage existant → changer la couleur ou le retirer
function hlAt(i, x, y) {
  for (let k = R.state.hls.length - 1; k >= 0; k--) {
    const hl = R.state.hls[k];
    if (hl.page === i && hl.rects.some(([rx, ry, rw, rh]) => x >= rx - 2 && x <= rx + rw + 2 && y >= ry - 2 && y <= ry + rh + 2)) return hl;
  }
  return null;
}
$('#hlEditPop').addEventListener('click', (e) => {
  const hl = R.editHl;
  if (!hl) return;
  const c = e.target.closest('[data-c]')?.dataset.c;
  if (c) hl.color = c;
  else if (e.target.closest('[data-act=del]')) R.state.hls = R.state.hls.filter((x) => x !== hl);
  else return;
  renderHls(hl.page);
  hidePops();
  markDirty();
});
function hidePops(onlyEdit) {
  $('#hlEditPop').classList.add('hidden');
  R.editHl = null;
  if (!onlyEdit) $('#hlPop').classList.add('hidden');
}

// Surligneur libre (rectangle au doigt) — utile pour les PDF scannés sans texte
function setupFreeLayer(pageEl) {
  const layer = $('.freeLayer', pageEl);
  layer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    layer.setPointerCapture(e.pointerId);
    const s = pageEl._s;
    const pr = pageEl.getBoundingClientRect();
    const x0 = (e.clientX - pr.left) / s, y0 = (e.clientY - pr.top) / s;
    const d = document.createElement('div'); d.className = 'freeRect'; layer.append(d);
    let rect = [x0, y0, 0, 0];
    const move = (ev) => {
      const x1 = (ev.clientX - pr.left) / s, y1 = (ev.clientY - pr.top) / s;
      rect = [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)];
      d.style.cssText = `left:${rect[0]}em;top:${rect[1]}em;width:${rect[2]}em;height:${rect[3]}em`;
    };
    const up = () => {
      layer.removeEventListener('pointermove', move); layer.removeEventListener('pointerup', up); layer.removeEventListener('pointercancel', up);
      d.remove();
      if (rect[2] > 3 && rect[3] > 3) {
        const i = +pageEl.dataset.i;
        R.state.hls.push({ id: uid(), page: i, color: R.lastColor, rects: [rect.map((v) => Math.round(v * 100) / 100)] });
        renderHls(i);
        markDirty();
      }
    };
    layer.addEventListener('pointermove', move);
    layer.addEventListener('pointerup', up);
    layer.addEventListener('pointercancel', up);
  });
}

/* =========================================================
   Outils, clics, sauvegarde
   ========================================================= */
function setMode(m) {
  R.mode = m && R.mode !== m ? m : null;
  viewer.classList.toggle('mode-text', R.mode === 'text');
  viewer.classList.toggle('mode-free', R.mode === 'free');
  $('#toolText').classList.toggle('on', R.mode === 'text');
  $('#toolFree').classList.toggle('on', R.mode === 'free');
}
$('#toolText').onclick = () => { setMode('text'); if (R.mode) toast('Touche la diapo à l’endroit où tu veux écrire'); };
$('#toolFree').onclick = () => { setMode('free'); if (R.mode) toast('Trace des rectangles au doigt. Re-touche le bouton pour défiler à nouveau.', 3500); };
$('#backBtn').onclick = () => closeReader();
$('#exportBtn').onclick = () => R.doc && exportFlow(R.doc.id);
$('#importInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); });

viewer.addEventListener('click', (e) => {
  if (!R.doc) return;
  const pageEl = e.target.closest('.page');
  if (!pageEl || e.target.closest('.tbox')) return;
  const i = +pageEl.dataset.i;
  const pr = pageEl.getBoundingClientRect();
  const x = (e.clientX - pr.left) / pageEl._s, y = (e.clientY - pr.top) / pageEl._s;
  if (R.mode === 'text') { addBox(i, x, y); setMode(null); return; }
  if (R.mode) return;
  if (!getSelection().isCollapsed) return;
  const hl = hlAt(i, x, y);
  if (hl) {
    R.editHl = hl;
    const pop = $('#hlEditPop');
    pop.classList.remove('hidden');
    pop.style.top = clamp(e.clientY + 18, 8, innerHeight - pop.offsetHeight - 8) + 'px';
    pop.style.left = clamp(e.clientX - pop.offsetWidth / 2, 8, innerWidth - pop.offsetWidth - 8) + 'px';
  }
});
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#hlEditPop')) { $('#hlEditPop').classList.add('hidden'); }
  if (R.selImg && e.target !== R.selImg && !e.target.closest('#imgPop, #imgHandle')) deselectImage();
  if (e.target.closest('#fmtBar, .pop, .modal-back, .tb-grip, .tb-resize, .note-head, .note-paper')) return;
  if (e.target.closest('.rich')) return;
  deactivateEditor();
}, true);

function setSaveState(s) {
  const el = $('#saveState');
  el.className = 'save-state' + (s === 'saving' ? ' saving' : s === 'error' ? ' error' : '');
  el.textContent = s === 'saving' ? '● Enregistrement…' : s === 'error' ? '⚠ Non enregistré' : '✓ Enregistré';
}
function markDirty(ed) {
  if (!R.doc) return;
  if (ed) R.dirtyEds.add(ed);
  setSaveState('saving');
  clearTimeout(R.saveT);
  R.saveT = setTimeout(saveNow, 600);
}
function serialize(ed) {
  const c = ed.cloneNode(true);
  for (const img of $$('img[data-img]', c)) {
    img.removeAttribute('src');
    img.classList.remove('sel');
    if (!img.getAttribute('class')) img.removeAttribute('class');
  }
  return c.innerHTML;
}
let saving = Promise.resolve();
function saveNow() {
  clearTimeout(R.saveT);
  if (!R.doc) return saving;
  for (const ed of R.dirtyEds) {
    const item = ed._kind === 'box' ? boxById(ed._id) : noteById(ed._id);
    if (item) item.html = serialize(ed);
  }
  R.dirtyEds.clear();
  const doc = R.doc, st = R.state;
  doc.updated = Date.now();
  doc.noteCount = st.notes.length; doc.boxCount = st.boxes.length; doc.hlCount = st.hls.length;
  const stCopy = JSON.parse(JSON.stringify(st));
  const docCopy = { ...doc };
  saving = saving.then(() => tx(['states', 'docs'], 'readwrite', (t) => { t.objectStore('states').put(stCopy); t.objectStore('docs').put(docCopy); }))
    .then(() => { if (!R.dirtyEds.size && R.doc === doc) setSaveState('ok'); })
    .catch((err) => { console.error(err); setSaveState('error'); toast('Erreur d’enregistrement : ' + (err.message || err), 5000); });
  return saving;
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
window.addEventListener('pagehide', () => saveNow());
window.addEventListener('popstate', () => { if (R.doc) closeReader(true); });

/* =========================================================
   Export PDF (pdf-lib)
   ========================================================= */
const K = 2;                        // échelle de mesure (px par point)
const ASC = 0.905, DESC = 0.212;    // métriques Liberation Sans (≈ Helvetica)
const NOTE_M = { top: 34, bottom: 24, x: 36 };   // doit correspondre au padding de .note-paper
const WIN_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const CHAR_MAP = {
  '→': '->', '←': '<-', '↔': '<->', '⇒': '=>', '⇐': '<=', '⇔': '<=>', '↑': '^', '↓': 'v', '≥': '>=', '≤': '<=', '≠': '!=', '≈': '~', '✓': 'v', '✔': 'v', '✗': 'x', '✘': 'x',
  '−': '-', '‐': '-', '‑': '-', '‒': '-', '″': '"', '′': "'", 'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'Δ': 'Delta', 'θ': 'theta', 'λ': 'lambda',
  'μ': 'µ', 'π': 'pi', 'σ': 'sigma', 'Σ': 'Somme', 'ω': 'omega', 'Ω': 'Ohm', '∞': 'infini', '√': 'racine', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '​': '', '﻿': '',
};
function winAnsi(s) {
  let out = '';
  for (const ch of s.normalize('NFC')) {
    const c = ch.codePointAt(0);
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_EXTRA.includes(ch)) out += ch;
    else if (CHAR_MAP[ch] !== undefined) out += CHAR_MAP[ch];
    else if (c < 0x20 || /\p{Extended_Pictographic}|\p{M}/u.test(ch) || (c >= 0xfe00 && c <= 0xfe0f)) continue;
    else out += '?';
  }
  return out;
}
function parseColor(str) {
  const m = str && str.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
  return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255, a: p.length > 3 ? p[3] : 1 };
}
async function ensureFonts() {
  await Promise.all([['normal', 400], ['normal', 700], ['italic', 400], ['italic', 700]].map(([st, w]) => document.fonts.load(`${st} ${w} 20px AnnotSans`)));
  await document.fonts.ready;
}

// Met en page le texte riche hors écran avec la vraie police, puis relève la position de chaque mot.
async function measureRich({ html, width, fontEm, wrapClass, edClass, vars, urls }) {
  const host = $('#measureHost');
  host.replaceChildren();
  host.style.fontSize = K + 'px';
  const wrap = document.createElement('div');
  wrap.className = wrapClass || '';
  wrap.style.cssText = `position:relative;left:0;top:0;width:${width}em;`;
  for (const [k, v] of Object.entries(vars || {})) wrap.style.setProperty(k, v);
  const ed = document.createElement('div');
  ed.className = 'rich ' + (edClass || '');
  ed.style.fontSize = fontEm + 'em';
  if (edClass === 'tb-edit') ed.style.setProperty('--u', boxUnit(fontEm));
  ed.innerHTML = html || '';
  hydrateImages(ed, urls);
  for (const li of $$('li', ed)) {
    const list = li.parentElement;
    li.style.listStyle = 'none'; li.style.position = 'relative';
    const mk = document.createElement('span');
    mk.style.cssText = 'position:absolute;left:-1.3em;top:0;font-weight:400;font-style:normal;text-decoration:none;';
    mk.textContent = list?.tagName === 'OL' ? [...list.children].filter((c) => c.tagName === 'LI').indexOf(li) + 1 + '.' : '•';
    li.prepend(mk);
  }
  wrap.append(ed);
  host.append(wrap);
  await Promise.all($$('img', ed).map((img) => (img.complete ? null : img.decode().catch(() => {}))));
  const items = extractItems(ed);
  const box = ed.getBoundingClientRect();
  host.replaceChildren();
  return { items, w: box.width / K, h: box.height / K };
}
function extractItems(root) {
  const o = root.getBoundingClientRect();
  const P = (r) => ({ x: (r.left - o.left) / K, y: (r.top - o.top) / K, w: r.width / K, h: r.height / K });
  const items = [];
  for (const img of $$('img', root)) {
    const r = img.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && img.dataset.img) items.push({ k: 'img', id: img.dataset.img, ...P(r) });
  }
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let node;
  while ((node = tw.nextNode())) {
    const text = node.nodeValue;
    if (!/\S/.test(text)) continue;
    const el = node.parentElement;
    const cs = getComputedStyle(el);
    const bold = parseInt(cs.fontWeight, 10) >= 600;
    const ital = cs.fontStyle !== 'normal';
    const font = bold ? (ital ? 'bi' : 'b') : ital ? 'i' : 'r';
    const size = parseFloat(cs.fontSize) / K;
    const color = parseColor(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
    let underline = false, bg = null;
    for (let a = el; a; a = a.parentElement) {
      const c = a === el ? cs : getComputedStyle(a);
      if (c.textDecorationLine.includes('underline')) underline = true;
      if (a === root) break;
      if (!bg) { const b = parseColor(c.backgroundColor); if (b && b.a > 0.05) bg = b; }
    }
    const re = /\S+/g;
    let m;
    while ((m = re.exec(text))) {
      const start = m.index, end = start + m[0].length;
      range.setStart(node, start); range.setEnd(node, end);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0);
      if (rects.length === 1) items.push({ k: 't', str: m[0], ...P(rects[0]), font, size, color, underline });
      else if (rects.length > 1) {
        // mot coupé sur plusieurs lignes : on regroupe les caractères par ligne
        let cur = null;
        const flush = () => { if (cur) items.push({ k: 't', str: cur.str, ...P({ left: cur.l, top: cur.t, width: cur.r - cur.l, height: cur.h }), font, size, color, underline }); };
        for (let i = start; i < end; i++) {
          range.setStart(node, i); range.setEnd(node, i + 1);
          const rc = range.getClientRects()[0];
          if (!rc) continue;
          if (cur && Math.abs(rc.top - cur.t) < 1) { cur.str += text[i]; cur.r = rc.right; } else { flush(); cur = { str: text[i], l: rc.left, t: rc.top, r: rc.right, h: rc.height }; }
        }
        flush();
      }
      if (bg) {
        let e2 = end;
        while (e2 < text.length && /\s/.test(text[e2])) e2++;
        range.setStart(node, start); range.setEnd(node, e2);
        for (const rc of range.getClientRects()) if (rc.width > 0) items.push({ k: 'bg', ...P(rc), color: bg });
      }
    }
  }
  return items;
}
function drawItems(page, items, ox, oy, Hd, ctx) {
  const { rgb } = PDFLib;
  for (const it of items) if (it.k === 'bg') page.drawRectangle({ x: ox + it.x, y: Hd - (oy + it.y + it.h), width: it.w, height: it.h, color: rgb(it.color.r, it.color.g, it.color.b), opacity: it.color.a });
  for (const it of items) {
    if (it.k !== 'img') continue;
    const im = ctx.images.get(it.id);
    if (im) page.drawImage(im, { x: ox + it.x, y: Hd - (oy + it.y + it.h), width: it.w, height: it.h });
  }
  for (const it of items) {
    if (it.k !== 't') continue;
    const str = winAnsi(it.str);
    if (!str) continue;
    const base = oy + it.y + (it.h * ASC) / (ASC + DESC);
    const color = rgb(it.color.r, it.color.g, it.color.b);
    page.drawText(str, { x: ox + it.x, y: Hd - base, size: it.size, font: ctx.fonts[it.font], color });
    if (it.underline) {
      const uy = Hd - base - it.size * 0.11;
      page.drawLine({ start: { x: ox + it.x, y: uy }, end: { x: ox + it.x + it.w, y: uy }, thickness: Math.max(0.4, it.size * 0.06), color });
    }
  }
}
function paginate(items, avail) {
  const rows = [];
  for (const it of [...items].sort((a, b) => a.y - b.y)) {
    const last = rows[rows.length - 1];
    if (last && it.y < last.bottom - 0.5) { last.items.push(it); last.bottom = Math.max(last.bottom, it.y + it.h); }
    else rows.push({ top: it.y, bottom: it.y + it.h, items: [it] });
  }
  let cur = { S: 0, items: [] };
  const pages = [cur];
  for (const row of rows) {
    if (row.bottom - cur.S > avail && cur.items.length) { cur = { S: row.top, items: [] }; pages.push(cur); }
    cur.items.push(...row.items);
  }
  return pages;
}
// Repère « affichage » (origine en haut à gauche, comme pdf.js) → repère PDF, quelle que soit la rotation de la page
function displayMatrix(page) {
  const rot = (((page.getRotation().angle || 0) % 360) + 360) % 360;
  const cb = page.getCropBox();
  if (rot === 90) return { m: [0, 1, -1, 0, cb.x + cb.width, cb.y], Hd: cb.width };
  if (rot === 180) return { m: [-1, 0, 0, -1, cb.x + cb.width, cb.y + cb.height], Hd: cb.height };
  if (rot === 270) return { m: [0, -1, 1, 0, cb.x, cb.y + cb.height], Hd: cb.width };
  return { m: [1, 0, 0, 1, cb.x, cb.y], Hd: cb.height };
}
const blobToBase64 = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });

async function buildExport(docId, { project }, onProgress) {
  if (R.doc?.id === docId) await saveNow();
  const { PDFDocument, StandardFonts, rgb, BlendMode, pushGraphicsState, popGraphicsState, concatTransformationMatrix } = PDFLib;
  const [docRec, pdfRec, state, imgs] = await Promise.all([idbGet('docs', docId), idbGet('pdfs', docId), idbGet('states', docId), idbImagesOf(docId)]);
  const st = { notes: [], boxes: [], hls: [], ...(state || {}) };
  const urls = new Map(imgs.map((im) => [im.id, URL.createObjectURL(im.blob)]));
  try {
    await ensureFonts();
    const origBytes = new Uint8Array(await pdfRec.data.arrayBuffer());
    const pdf = await PDFDocument.load(origBytes, { ignoreEncryption: true, updateMetadata: false });
    const fonts = {
      r: await pdf.embedFont(StandardFonts.Helvetica), b: await pdf.embedFont(StandardFonts.HelveticaBold),
      i: await pdf.embedFont(StandardFonts.HelveticaOblique), bi: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
    };
    const images = new Map();
    for (const im of imgs) {
      try { images.set(im.id, await pdf.embedJpg(new Uint8Array(await im.blob.arrayBuffer()))); } catch (e) { console.warn('image', e); }
    }
    const ctx = { fonts, images };
    const orig = pdf.getPages();
    const n = orig.length;
    let inserted = 0;
    for (let i = 0; i < n; i++) {
      const page = orig[i];
      const hls = st.hls.filter((h) => h.page === i);
      const boxes = st.boxes.filter((b) => b.page === i && (b.html || '').replace(/<[^>]*>/g, '').trim());
      if (hls.length || boxes.length) {
        const { m, Hd } = displayMatrix(page);
        page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m));
        for (const hl of hls) {
          const c = hexToRgb(COLORS[hl.color] || COLORS.yellow);
          for (const [x, y, w, h] of hl.rects) page.drawRectangle({ x, y: Hd - (y + h), width: w, height: h, color: rgb(c.r, c.g, c.b), opacity: 0.55, blendMode: BlendMode.Multiply });
        }
        for (const b of boxes) {
          const res = await measureRich({ html: b.html, width: b.w, fontEm: b.fs, wrapClass: 'tbox bg-' + (b.bg || 'white'), edClass: 'tb-edit', vars: { '--s': K }, urls });
          if (b.bg === 'white' || b.bg === 'yellow' || !b.bg) {
            const c = b.bg === 'yellow' ? rgb(1, 0.957, 0.659) : rgb(1, 1, 1);
            page.drawRectangle({ x: b.x, y: Hd - (b.y + res.h), width: res.w, height: res.h, color: c, opacity: b.bg === 'yellow' ? 0.94 : 0.9 });
          }
          drawItems(page, res.items, b.x, b.y, Hd, ctx);
        }
        page.pushOperators(popGraphicsState());
      }
      // Pages de notes insérées après la diapo
      let at = i + inserted + 1;
      for (const note of st.notes.filter((x) => x.after === i)) {
        const res = await measureRich({ html: note.html, width: note.w - 2 * NOTE_M.x, fontEm: 11, edClass: 'note-edit', vars: { '--s': K, '--ph': note.h }, urls });
        if (!res.items.length) continue;
        const pages = paginate(res.items, note.h - NOTE_M.top - NOTE_M.bottom);
        // la page de notes prend la largeur de la diapo (tout est mis à l'échelle)
        const k = (docRec.sizes[i]?.w || note.w) / note.w;
        pages.forEach((pg, j) => {
          const p = pdf.insertPage(at++, [note.w * k, note.h * k]);
          inserted++;
          p.pushOperators(pushGraphicsState(), concatTransformationMatrix(k, 0, 0, k, 0, 0));
          p.drawRectangle({ x: 0, y: 0, width: 4, height: note.h, color: rgb(0.56, 0.82, 0.79) });
          p.drawText(winAnsi(`Notes · diapo ${i + 1}${pages.length > 1 ? ` (${j + 1}/${pages.length})` : ''}`), { x: NOTE_M.x, y: note.h - 20, size: 7, font: fonts.r, color: rgb(0.45, 0.5, 0.55) });
          drawItems(p, pg.items, NOTE_M.x, NOTE_M.top - pg.S, note.h, ctx);
          p.pushOperators(popGraphicsState());
        });
      }
      if (i % 4 === 0) { onProgress?.((i + 1) / n * 0.85); await sleep(0); }
    }
    if (project) {
      onProgress?.(0.88, 'Ajout du projet modifiable…');
      const proj = { app: 'annotformation', v: 1, title: docRec.title, sizes: docRec.sizes, state: { notes: st.notes, boxes: st.boxes, hls: st.hls }, images: {} };
      for (const im of imgs) proj.images[im.id] = { w: im.w, h: im.h, b64: await blobToBase64(im.blob) };
      const now = new Date();
      await pdf.attach(new TextEncoder().encode(JSON.stringify(proj)), 'annotformation-project.json', { mimeType: 'application/json', description: 'Projet Annot’Formation (annotations modifiables)', creationDate: now, modificationDate: now });
      await pdf.attach(new Uint8Array(await pdfRec.data.arrayBuffer()), 'annotformation-original.pdf', { mimeType: 'application/pdf', description: 'PDF original de la formation', creationDate: now, modificationDate: now });
    }
    pdf.setTitle(docRec.title);
    pdf.setProducer('Annot’Formation');
    pdf.setModificationDate(new Date());
    onProgress?.(0.92, 'Finalisation du fichier…');
    await sleep(0);
    const bytes = await pdf.save({ useObjectStreams: true });
    onProgress?.(1);
    const name = (docRec.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'formation') + ' - annoté.pdf';
    return new File([bytes], name, { type: 'application/pdf' });
  } finally {
    for (const u of urls.values()) URL.revokeObjectURL(u);
  }
}

async function exportFlow(docId) {
  const docRec = await idbGet('docs', docId);
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div>Crée un PDF avec tes pages de notes, tes zones de texte, tes photos et tes surlignages.</div>
    <label class="chk"><input type="checkbox" checked><span><b>Inclure le projet modifiable</b><br>
      <small>Le PDF reste lisible partout, et tu pourras le réimporter ici pour continuer à annoter. Fichier environ 2× plus lourd.</small></span></label>`;
  const project = await dialog({
    title: `Exporter « ${docRec.title} »`, body: wrap,
    buttons: [{ label: 'Annuler', value: null }, { label: 'Créer le PDF', value: () => $('input', wrap).checked, cls: 'primary' }],
  });
  if (project === null) return;
  const b = busy('Création du PDF…');
  let file;
  try {
    file = await buildExport(docId, { project }, (f, t) => b.set(t ?? null, f));
  } catch (err) {
    console.error(err);
    b.close();
    dialog({ title: 'Export impossible', body: esc(err.message || String(err)), buttons: [{ label: 'OK', value: null, cls: 'primary' }] });
    return;
  }
  b.close();
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  const markExported = async () => {
    const d = await idbGet('docs', docId);
    d.exported = Date.now();
    await idbPut('docs', d);
    if (R.doc?.id === docId) R.doc.exported = d.exported;
    if (!R.doc) renderLibrary();
  };
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = file.name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    markExported();
    toast('PDF téléchargé (dossier Téléchargements)');
  };
  const body = `<div><b>${esc(file.name)}</b> — ${fmtSize(file.size)}</div>
    <div style="margin-top:8px">${canShare ? '« Envoyer… » ouvre le menu de partage d’Android : choisis <b>Drive</b> (« Enregistrer dans Drive ») et le dossier de ta formation.' : 'Le partage direct n’est pas disponible ici : télécharge le fichier puis envoie-le dans Drive.'}</div>`;
  const choice = await dialog({
    title: 'PDF prêt ✓', body,
    buttons: [{ label: 'Fermer', value: null }, { label: 'Télécharger', value: 'dl' }, ...(canShare ? [{ label: 'Envoyer vers Drive…', value: 'share', cls: 'primary' }] : [])],
  });
  if (choice === 'dl') download();
  else if (choice === 'share') {
    try { await navigator.share({ files: [file], title: file.name }); markExported(); }
    catch (err) {
      if (err.name !== 'AbortError') {
        const again = await dialog({ title: 'Partage impossible', body: esc(err.message || String(err)) + '<br>Tu peux télécharger le fichier à la place.', buttons: [{ label: 'Fermer', value: null }, { label: 'Télécharger', value: 'dl', cls: 'primary' }] });
        if (again === 'dl') download();
      }
    }
  }
}

/* =========================================================
   Démarrage
   ========================================================= */
try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch {}
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('Nouvelle version installée : ferme et rouvre l’appli pour en profiter.', 6000);
  });
}
renderLibrary();
window.__annot = { R, buildExport, importFile, openDoc, closeReader }; // pour les tests
