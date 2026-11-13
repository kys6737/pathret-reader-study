/* PathRet blinded reader study v5 - per-slide 1-5 similarity rating.
   Knows only anonymous image IDs; no system names, scores or ranks. */
(() => {
  "use strict";
  const CFG = window.RS_CONFIG || {};
  const DEMO = !CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY;
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null) e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null) e.append(k);
    return e;
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const P = "rs5_";   // storage prefix, separate from the v2 study

  const SCALE = [[1, "전혀 유사하지 않음", "주된 성장 패턴과 세포형태가 다름"], [2, "약간 유사함", "일부 특징만 공통이고 주된 패턴은 다름"], [3, "어느 정도 유사함", "주된 패턴은 비슷하나 세포/핵형태/밀도/성장 패턴 비율에 뚜렷한 차이 있음"], [4, "매우 유사함", "주요 특징이 대부분 일치하고 경미한 차이만 있음"], [5, "거의 동일함", "형태적으로 구별하기 어려움"]];

  const S = {
    code: null, items: {}, itemIds: [], slides: {}, order: [], pos: 0, cur: 0,
    resp: {},            // item_id -> {s: {img: score}, time_ms}
    pending: {},
    enteredAt: 0,
  };

  // ── API ─────────────────────────────────────────────
  async function rpc(fn, body) {
    const r = await fetch(`${CFG.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: CFG.SUPABASE_ANON_KEY,
                 Authorization: `Bearer ${CFG.SUPABASE_ANON_KEY}` },
      body: JSON.stringify(body),
    });
    const txt = await r.text();
    if (!r.ok) {
      let msg = txt; try { msg = JSON.parse(txt).message || txt; } catch { /* keep text */ }
      const err = new Error(msg); err.status = r.status; throw err;
    }
    return txt ? JSON.parse(txt) : null;
  }
  async function apiLogin(code) {
    if (DEMO) return Object.entries(store.get(`${P}demo_${code}`, {})).map(([item_id, v]) => ({ item_id, ...v }));
    return rpc("rs5_login", { p_code: code });
  }
  async function apiSave(code, p) {
    if (DEMO) {
      const all = store.get(`${P}demo_${code}`, {});
      all[p.item_id] = { scores: p.scores, time_ms: p.time_ms };
      store.set(`${P}demo_${code}`, all);
      return;
    }
    await rpc("rs5_save", { p_code: code, p_item: p.item_id, p_scores: p.scores, p_pos: p.pos, p_time_ms: p.time_ms });
  }

  // ── save queue (survives reloads / network drops) ───
  let flushing = false, retryTimer = null, retryDelay = 1000;
  const pendKey = () => `${P}pending_${S.code}`;
  function queueSave(itemId) {
    const r = S.resp[itemId] || {};
    S.pending[itemId] = { item_id: itemId, scores: { ...(r.s || {}) }, time_ms: Math.round(r.time_ms || 0),
                          pos: S.order.indexOf(itemId) + 1 };
    store.set(pendKey(), S.pending);
    setStatus("saving");
    clearTimeout(retryTimer);
    retryTimer = setTimeout(flush, 350);
  }
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (Object.keys(S.pending).length) {
        const [id, p] = Object.entries(S.pending)[0];
        await apiSave(S.code, p);
        if (S.pending[id] === p) delete S.pending[id];
        store.set(pendKey(), S.pending);
      }
      retryDelay = 1000;
      setStatus(DEMO ? "demo" : "saved");
    } catch (e) {
      setStatus("error", e.status === 401 || /reader code/.test(e.message) ? "저장 실패: 코드 확인 필요" : null);
      retryTimer = setTimeout(flush, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    } finally {
      flushing = false;
    }
    refreshDoneScreen();
  }
  function setStatus(state, text) {
    const s = $("#save-status");
    s.dataset.state = state;
    s.textContent = text || { saved: "저장됨", saving: "저장 중…", error: "저장 실패 · 재시도 중", demo: "데모 · 로컬 저장" }[state];
  }
  window.addEventListener("online", () => { retryDelay = 1000; flush(); });
  window.addEventListener("beforeunload", (e) => {
    commitTime();
    if (Object.keys(S.pending).length && !DEMO) { e.preventDefault(); e.returnValue = ""; }
  });

  // ── helpers ─────────────────────────────────────────
  function hash32(str) { let h = 2166136261; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
  function seededShuffle(arr, seed) {
    let a = seed || 1; const rnd = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
    return out;
  }
  const img = (id, f) => `img/${id}/${f}.webp`;
  const nPatches = (id) => (S.slides[id] ? S.slides[id].p.length : 4);
  const scoresOf = (id) => (S.resp[id] && S.resp[id].s) || {};
  const nRated = (id) => S.items[id].slides.filter((x) => scoresOf(id)[x]).length;
  const complete = (id) => nRated(id) === S.items[id].slides.length;
  const totalSlides = () => S.order.reduce((a, id) => a + S.items[id].slides.length, 0);
  const ratedSlides = () => S.order.reduce((a, id) => a + nRated(id), 0);
  const curItem = () => S.items[S.order[S.pos]];

  function show(id) {
    for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== id;
    window.scrollTo(0, 0);
  }

  // ── login / boot ────────────────────────────────────
  async function loadData() {
    const [items, slides] = await Promise.all([
      fetch("data/items.json", { cache: "no-cache" }).then((r) => r.json()),
      fetch("data/slides.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
    S.items = Object.fromEntries(items.items.map((it) => [it.id, it]));
    S.itemIds = items.items.map((it) => it.id);
    S.slides = slides;
    $("#q-total").textContent = S.itemIds.length;
    document.querySelectorAll(".n-items").forEach((e) => { e.textContent = S.itemIds.length; });
  }

  async function login(code) {
    code = code.trim().toUpperCase();
    const errEl = $("#login-error"); errEl.hidden = true;
    let rows;
    try { rows = await apiLogin(code); }
    catch (e) {
      errEl.textContent = /reader code/.test(e.message) ? "등록되지 않은 판독자 코드입니다." : `서버에 연결할 수 없습니다 (${e.message}).`;
      errEl.hidden = false; return;
    }
    S.code = code;
    store.set(`${P}code`, code);
    S.order = S.itemIds.slice();   // same fixed order for every reader (문항 n = answer_key seq n)
    S.resp = {};
    for (const r of rows || []) S.resp[r.item_id] = { s: r.scores || {}, time_ms: r.time_ms || 0 };
    S.pending = store.get(pendKey(), {});
    for (const [id, p] of Object.entries(S.pending)) S.resp[id] = { s: p.scores || {}, time_ms: p.time_ms };
    setStatus(DEMO ? "demo" : "saved");
    if (Object.keys(S.pending).length) flush();

    const first = S.order.findIndex((id) => !complete(id));
    if (first === -1) { S.pos = S.order.length - 1; showDone(); return; }
    S.pos = first;
    // always open on the instructions; the button says whether this is a fresh start or a resume
    $("#intro-start").textContent = ratedSlides() ? `이어서 평가하기 (문항 ${S.pos + 1}부터)` : "평가 시작";
    show("screen-intro");
  }

  function enterStudy() { store.set(`${P}intro_${S.code}`, true); show("screen-study"); renderItem(); }

  // ── slide rendering ────────────────────────────────
  function outlineSvg(id) {
    const t = S.slides[id] && S.slides[id].t;
    if (!t || !t.length) return null;
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 1 1");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("class", "tumor");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", t.map((r) => {
      let d = "";
      for (let i = 0; i < r.length; i += 2) d += `${i ? "L" : "M"}${r[i]} ${r[i + 1]}`;
      return `${d}Z`;
    }).join(""));
    path.setAttribute("vector-effect", "non-scaling-stroke");
    path.setAttribute("fill-rule", "evenodd");
    svg.append(path);
    return svg;
  }
  function patchMarkers(id) {
    const s = S.slides[id];
    if (!s) return [];
    // outline the patch region only (never fill it) and put the number beside the box
    return s.p.map(([x, y, w, h], i) =>
      el("span", { class: "pbox", style: `left:${(x + w / 2) * 100}%;top:${(y + h / 2) * 100}%;width:max(12px, ${w * 100}%);height:max(12px, ${h * 100}%)` },
        el("span", { class: "pnum" }, String(i + 1))));
  }
  function slideThumb(id, onclick) {
    const im = el("img", { src: img(id, "thumb"), alt: "", decoding: "async" });
    const ov = el("div", { class: "thumb-ov" }, outlineSvg(id), patchMarkers(id));
    const box = el("button", { class: "thumb-box", type: "button", title: "클릭하여 확대 비교", onclick }, im, ov);
    const place = () => {
      Object.assign(ov.style, { left: `${im.offsetLeft}px`, top: `${im.offsetTop}px`,
                                width: `${im.offsetWidth}px`, height: `${im.offsetHeight}px` });
    };
    im.addEventListener("load", place);
    if (window.ResizeObserver) new ResizeObserver(place).observe(box);
    return box;
  }
  function slidePatches(id, onclick) {
    const n = nPatches(id), share = S.slides[id] && S.slides[id].s;
    return el("div", { class: "patches" },
      Array.from({ length: n }, (_, i) => el("figure", { class: "patch", onclick: () => onclick(`p${i + 1}`) },
        el("span", { class: "pbadge" }, String(i + 1)),
        el("img", { src: img(id, `p${i + 1}`), alt: "", decoding: "async" }),
        el("figcaption", {}, share ? `${share[i]}%` : ""))));
  }
  const dxLabel = (it) => [el("span", { class: "tag" }, it.organ), el("span", { class: "tag" }, it.dx)];

  // ── item rendering ─────────────────────────────────
  function renderProgress() {
    const done = ratedSlides(), total = totalSlides();
    $("#progress-fill").style.width = `${(100 * done) / total}%`;
    $("#progress-text").textContent = `${Math.round((100 * done) / total)}%`;
    $("#progress-text").title = `${done}/${total} 슬라이드 평가 완료`;
  }

  function renderItem() {
    const it = curItem();
    $("#q-num").textContent = S.pos + 1;
    $("#ret-total").textContent = it.slides.length;
    renderProgress();
    $("#ref-dx").replaceChildren(...dxLabel(it));
    $("#ret-dx").replaceChildren(...dxLabel(it));
    const open = (v) => openViewer(S.cur, "thumb", v);
    $("#ref-view").replaceChildren(slideThumb(it.query, () => open("thumb")), slidePatches(it.query, open));
    // start on the first unrated slide
    const sc = scoresOf(it.id);
    const first = it.slides.findIndex((x) => !sc[x]);
    S.cur = first === -1 ? 0 : first;
    renderSlide();
    S.enteredAt = performance.now();
    preload(S.pos + 1);
  }

  function renderSlide() {
    const it = curItem(), id = it.slides[S.cur];
    $("#ret-num").textContent = S.cur + 1;
    const open = (v) => openViewer(S.cur, v, "thumb");
    $("#ret-view").replaceChildren(slideThumb(id, () => open("thumb")), slidePatches(id, open));
    renderAnswers();
  }

  function renderAnswers() {
    const it = curItem(), sc = scoresOf(it.id), id = it.slides[S.cur];
    $("#ret-tabs").replaceChildren(...it.slides.map((x, i) =>
      el("button", { type: "button", class: `tab${i === S.cur ? " cur" : ""}${sc[x] ? " done" : ""}`,
                     title: sc[x] ? `검색 슬라이드 ${i + 1}: ${sc[x]}점` : `검색 슬라이드 ${i + 1}: 미평가`,
                     "aria-current": i === S.cur ? "true" : null,
                     onclick: () => { S.cur = i; renderSlide(); } },
        el("span", { class: "tthumb" }, el("img", { src: img(x, "thumb"), alt: "", decoding: "async" })),
        el("span", { class: "tlab" }, el("b", {}, String(i + 1)),
           el("span", { class: "v" }, sc[x] ? `${sc[x]}점` : "미평가")))));
    const nr = nRated(it.id), nt = it.slides.length;
    $("#iprog-text").textContent = `${nr} / ${nt} 평가`;
    $("#iprog-fill").style.width = `${(100 * nr) / nt}%`;
    $("#scores").replaceChildren(...SCALE.map(([v, label, desc]) =>
      el("button", { type: "button", class: "score", "aria-pressed": String(sc[id] === v),
                     onclick: () => rate(v) },
        el("b", {}, String(v)), el("span", {}, label), el("small", { class: "sdesc" }, desc))));
    const ok = complete(it.id), left = it.slides.length - nRated(it.id);
    $("#btn-next").disabled = !ok;
    $("#btn-next").textContent = S.pos === S.order.length - 1 ? "마치기" : "다음 문항 →";
    $("#btn-prev").disabled = S.pos === 0;
    $("#nav-hint").textContent = ok ? "" : `검색 슬라이드 ${left}장이 남았습니다.`;
  }

  function commitTime() {
    if (!S.code || !S.enteredAt || $("#screen-study").hidden) return 0;
    const it = curItem(), now = performance.now();
    const dt = now - S.enteredAt; S.enteredAt = now;
    S.resp[it.id] = S.resp[it.id] || { s: {} };
    S.resp[it.id].time_ms = (S.resp[it.id].time_ms || 0) + dt;
    return dt;
  }

  let advTimer = null;
  function rate(v) {
    const it = curItem(), id = it.slides[S.cur];
    commitTime();
    const r = S.resp[it.id] = S.resp[it.id] || { s: {} };
    r.s = { ...(r.s || {}), [id]: v };
    queueSave(it.id);
    renderProgress();
    renderAnswers();
    // move on to the next unrated slide of this item after a short visual confirmation
    clearTimeout(advTimer);
    const n = it.slides.length;
    for (let k = 1; k < n; k++) {
      const j = (S.cur + k) % n;
      if (!r.s[it.slides[j]]) {
        const from = S.cur;
        advTimer = setTimeout(() => { if (curItem() === it && S.cur === from) { S.cur = j; renderSlide(); syncViewer(); } }, 250);
        return;
      }
    }
  }

  function go(pos) {
    if (pos < 0 || pos >= S.order.length) return;
    if (commitTime() > 0 && S.resp[curItem().id]) queueSave(curItem().id);
    S.pos = pos;
    renderItem();
    window.scrollTo(0, 0);
  }

  function next() {
    if (!complete(curItem().id)) return;
    if (S.pos === S.order.length - 1 || S.order.every(complete)) {
      const nxt = S.order.findIndex((id) => !complete(id));
      if (nxt === -1) { commitTime(); queueSave(curItem().id); showDone(); return; }
      go(nxt); return;
    }
    go(S.pos + 1);
  }

  function preload(pos) {
    const id = S.order[pos]; if (!id) return;
    const it = S.items[id];
    for (const s of [it.query, ...it.slides]) { const i = new Image(); i.src = img(s, "thumb"); }
  }

  function showDone() { show("screen-done"); refreshDoneScreen(); }
  function refreshDoneScreen() {
    if ($("#screen-done").hidden) return;
    const n = Object.keys(S.pending).length, e = $("#done-pending");
    e.hidden = !n || DEMO;
    e.textContent = `아직 서버에 저장되지 않은 응답이 ${n}개 있습니다. 창을 닫지 말고 잠시 기다려 주세요.`;
  }

  // ── item list dialog ───────────────────────────────
  function openList() {
    const g = $("#list-grid");
    g.replaceChildren(...S.order.map((id, i) => {
      const n = nRated(id);
      const cls = complete(id) ? "done" : n ? "partial" : "";
      return el("button", { type: "button", class: `${cls}${i === S.pos ? " cur" : ""}`, title: `${n}/${S.items[id].slides.length}`,
                            onclick: () => { $("#list-dialog").close(); go(i); } }, String(i + 1));
    }));
    $("#list-dialog").showModal();
  }

  // ── compare viewer (left: reference, right: retrieved slide S.cur) ──
  const V = { panes: {} };
  function makePane(host) {
    const st = { id: null, view: "thumb", z: 1, x: 0, y: 0, fit: 1 };
    const head = el("div", { class: "vpane-h" });
    const stage = el("div", { class: "stage" });
    const im = el("img", { alt: "", draggable: "false" });
    const tag = el("span", { class: "zoomtag" });
    stage.append(im, tag);
    host.replaceChildren(head, stage);

    function apply() {
      im.style.transform = `translate(${st.x}px, ${st.y}px) scale(${st.z})`;
      const W = im.naturalWidth, H = im.naturalHeight;
      stage.querySelectorAll(".box").forEach((b) => {
        const [bx, by, bw, bh] = JSON.parse(b.dataset.r);
        b.style.left = `${st.x + bx * W * st.z}px`; b.style.top = `${st.y + by * H * st.z}px`;
        b.style.width = `${bw * W * st.z}px`; b.style.height = `${bh * H * st.z}px`;
      });
      const ol = stage.querySelector("svg.tumor");
      if (ol) Object.assign(ol.style, { left: `${st.x}px`, top: `${st.y}px`, width: `${W * st.z}px`, height: `${H * st.z}px` });
      tag.textContent = `${Math.round((st.z / st.fit) * 100)}%`;
    }
    function fit() {
      const W = im.naturalWidth, H = im.naturalHeight; if (!W) return;
      const sw = stage.clientWidth, sh = stage.clientHeight;
      st.fit = st.z = Math.min(sw / W, sh / H);
      st.x = (sw - W * st.z) / 2; st.y = (sh - H * st.z) / 2; apply();
    }
    im.addEventListener("load", () => {
      stage.querySelectorAll(".box, svg.tumor").forEach((b) => b.remove());
      if (st.view === "thumb" && S.slides[st.id]) {
        const ol = outlineSvg(st.id);
        if (ol) stage.append(ol);
        S.slides[st.id].p.forEach((r, i) => {
          stage.append(el("div", { class: "box", "data-r": JSON.stringify(r), title: `패치 ${i + 1}` }, el("span", {}, String(i + 1))));
        });
      }
      fit();
    });
    stage.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = stage.getBoundingClientRect(), mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const nz = Math.min(Math.max(st.z * Math.exp(-e.deltaY * 0.0015), st.fit * 0.5), st.fit * 12);
      st.x = mx - ((mx - st.x) * nz) / st.z; st.y = my - ((my - st.y) * nz) / st.z; st.z = nz; apply();
    }, { passive: false });
    let drag = null;
    stage.addEventListener("pointerdown", (e) => { drag = { px: e.clientX, py: e.clientY, x: st.x, y: st.y }; stage.setPointerCapture(e.pointerId); stage.classList.add("dragging"); });
    stage.addEventListener("pointermove", (e) => { if (!drag) return; st.x = drag.x + e.clientX - drag.px; st.y = drag.y + e.clientY - drag.py; apply(); });
    const end = () => { drag = null; stage.classList.remove("dragging"); };
    stage.addEventListener("pointerup", end); stage.addEventListener("pointercancel", end);
    stage.addEventListener("dblclick", fit);

    function set(id, name, view = "thumb") {
      st.id = id; st.view = view;
      const share = S.slides[id] && S.slides[id].s;
      const views = [["thumb", "전체"], ...Array.from({ length: nPatches(id) },
        (_, i) => [`p${i + 1}`, share ? `패치 ${i + 1} · ${share[i]}%` : `패치 ${i + 1}`])];
      head.replaceChildren(el("span", { class: "name" }, name), ...views.map(([v, l]) =>
        el("button", { type: "button", "aria-pressed": String(v === view), onclick: () => set(id, name, v) }, l)));
      im.src = img(id, view);
    }
    return { set, fit };
  }

  function openViewer(idx, rightView = "thumb", leftView = "thumb") {
    const v = $("#viewer");
    v.hidden = false;
    document.body.style.overflow = "hidden";
    if (!V.panes.left) { V.panes.left = makePane($("#v-left")); V.panes.right = makePane($("#v-right")); }
    V.panes.left.set(curItem().query, "기준 슬라이드", leftView);
    S.cur = idx;
    syncViewer(rightView);
  }
  function syncViewer(view = "thumb") {
    if ($("#viewer").hidden) return;
    const it = curItem();
    $("#v-label").textContent = `검색 슬라이드 ${S.cur + 1} / ${it.slides.length}`;
    V.panes.right.set(it.slides[S.cur], `검색 슬라이드 ${S.cur + 1}`, view);
  }
  function closeViewer() { $("#viewer").hidden = true; document.body.style.overflow = ""; }
  function step(d) {
    const it = curItem(), n = it.slides.length;
    // → on the last slide of a completed item moves on to the next item
    if (d > 0 && S.cur === n - 1 && complete(it.id)) { next(); return; }
    if (d < 0 && S.cur === 0) return;
    if (d > 0 && S.cur === n - 1) {   // not finished yet: jump to the first unrated slide
      const j = it.slides.findIndex((x) => !scoresOf(it.id)[x]);
      if (j !== -1) { S.cur = j; renderSlide(); }
      return;
    }
    S.cur += d; renderSlide(); syncViewer();
  }
  window.addEventListener("resize", () => { if (!$("#viewer").hidden) { V.panes.left.fit(); V.panes.right.fit(); } });
  document.addEventListener("keydown", (e) => {
    if ($("#screen-study").hidden || $("#list-dialog").open || e.ctrlKey || e.metaKey || e.altKey) return;
    // the zoom viewer shows only the current retrieved slide: no switching or rating while it is open
    if (!$("#viewer").hidden) { if (e.key === "Escape") closeViewer(); return; }
    if (/^[1-5]$/.test(e.key)) { rate(Number(e.key)); return; }
    if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "Escape" && !$("#viewer").hidden) closeViewer();
  });

  // ── wiring ─────────────────────────────────────────
  $("#login-form").addEventListener("submit", (e) => { e.preventDefault(); login($("#login-code").value); });
  $("#intro-start").addEventListener("click", enterStudy);
  $("#btn-help").addEventListener("click", () => { commitTime(); $("#intro-start").textContent = "평가로 돌아가기"; show("screen-intro"); });
  $("#btn-next").addEventListener("click", next);
  $("#btn-prev").addEventListener("click", () => go(S.pos - 1));
  $("#btn-list").addEventListener("click", openList);
  $("#list-close").addEventListener("click", () => $("#list-dialog").close());
  $("#v-close").addEventListener("click", closeViewer);
  $("#done-review").addEventListener("click", () => { S.pos = 0; show("screen-study"); renderItem(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { if (commitTime() > 0 && S.resp[curItem()?.id]) queueSave(curItem().id); }
    else S.enteredAt = performance.now();
  });

  (async () => {
    $("#demo-note").hidden = !DEMO;
    try { await loadData(); }
    catch (e) { show("screen-login"); $("#login-error").textContent = "문항 데이터를 불러오지 못했습니다."; $("#login-error").hidden = false; return; }
    const saved = store.get(`${P}code`, null);
    if (saved) { $("#login-code").value = saved; }
    show("screen-login");
  })();
})();
