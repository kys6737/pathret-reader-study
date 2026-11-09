/* PathRet blinded reader study — front end.
   Knows only anonymous image IDs; no system names, scores, ranks or labels. */
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
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  const CHOICES = {
    q1: [["A", "A"], ["B", "B"], ["both_yes", "A, B 둘 다 맞음"], ["both_no", "둘 다 틀림"]],
    q2: [["A", "A"], ["B", "B"], ["both_yes", "둘 다 유용함"], ["both_no", "둘 다 유용하지 않음"]],
  };
  const CONFS = [["low", "낮음"], ["medium", "보통"], ["high", "높음"]];
  const FIELDS = ["q1", "q1_conf", "q2", "q2_conf"];

  const S = {
    code: null, items: [], slides: {}, order: [], pos: 0,
    resp: {},            // item_id -> {q1,q1_conf,q2,q2_conf,time_ms}
    pending: {},         // item_id -> payload awaiting upload
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
    if (DEMO) return Object.entries(store.get(`rs_demo_${code}`, {})).map(([item_id, v]) => ({ item_id, ...v }));
    return rpc("rs_login", { p_code: code });
  }
  async function apiSave(code, p) {
    if (DEMO) {
      const all = store.get(`rs_demo_${code}`, {});
      all[p.item_id] = { q1: p.q1, q1_conf: p.q1_conf, q2: p.q2, q2_conf: p.q2_conf, time_ms: p.time_ms };
      store.set(`rs_demo_${code}`, all);
      return;
    }
    await rpc("rs_save", { p_code: code, p_item: p.item_id, p_q1: p.q1, p_q1_conf: p.q1_conf,
                           p_q2: p.q2, p_q2_conf: p.q2_conf, p_pos: p.pos, p_time_ms: p.time_ms });
  }

  // ── save queue (survives reloads / network drops) ───
  let flushing = false, retryTimer = null, retryDelay = 1000;
  const pendKey = () => `rs_pending_${S.code}`;
  function queueSave(itemId) {
    const r = S.resp[itemId] || {};
    S.pending[itemId] = { item_id: itemId, q1: r.q1 || null, q1_conf: r.q1_conf || null,
      q2: r.q2 || null, q2_conf: r.q2_conf || null, time_ms: Math.round(r.time_ms || 0),
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
        if (S.pending[id] === p) delete S.pending[id];   // unchanged while in flight
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
  const complete = (id) => !!(S.resp[id] && S.resp[id].q1 && S.resp[id].q2);
  const answeredCount = () => S.order.filter(complete).length;
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
    store.set("rs_code", code);
    S.order = seededShuffle(S.itemIds, hash32(code));
    S.resp = {};
    for (const r of rows || []) S.resp[r.item_id] = { q1: r.q1, q1_conf: r.q1_conf, q2: r.q2, q2_conf: r.q2_conf, time_ms: r.time_ms || 0 };
    // re-apply anything saved locally but not yet uploaded
    S.pending = store.get(pendKey(), {});
    for (const [id, p] of Object.entries(S.pending)) S.resp[id] = { q1: p.q1, q1_conf: p.q1_conf, q2: p.q2, q2_conf: p.q2_conf, time_ms: p.time_ms };
    setStatus(DEMO ? "demo" : "saved");
    if (Object.keys(S.pending).length) flush();

    const first = S.order.findIndex((id) => !complete(id));
    if (first === -1) { S.pos = S.order.length - 1; showDone(); return; }
    S.pos = first;
    if (answeredCount() === 0 && !store.get(`rs_intro_${code}`, false)) show("screen-intro");
    else enterStudy();
  }

  function enterStudy() { store.set(`rs_intro_${S.code}`, true); show("screen-study"); renderItem(); }

  // ── item rendering ─────────────────────────────────
  function slideThumb(id) {
    return el("div", { class: "thumb-box" }, el("img", { src: img(id, "thumb"), alt: "", loading: "lazy", decoding: "async" }));
  }
  function slidePatches(id) {
    const n = nPatches(id);
    return el("div", { class: "patches" },
      Array.from({ length: n }, (_, i) => el("img", { src: img(id, `p${i + 1}`), alt: "", loading: "lazy", decoding: "async" })));
  }

  function renderItem() {
    const it = curItem();
    $("#q-num").textContent = S.pos + 1;
    const done = answeredCount(), total = S.order.length;
    $("#progress-fill").style.width = `${(100 * done) / total}%`;
    $("#progress-text").textContent = `${Math.round((100 * done) / total)}%`;
    $("#progress-text").title = `${done}/${total} 응답 완료`;

    const qv = $("#query-view");
    qv.replaceChildren(slideThumb(it.query), slidePatches(it.query));
    qv.onclick = () => openViewer(0);

    for (const set of ["A", "B"]) {
      $(`#set-${set}`).replaceChildren(...it[set].map((id, i) =>
        el("button", { class: "slide", type: "button", "aria-label": `${set}-${i + 1} 확대 비교`,
                       onclick: () => openViewer(set === "A" ? i : 5 + i) },
          el("span", { class: "lbl" }, `${set}-${i + 1}`), slideThumb(id), slidePatches(id))));
    }
    renderAnswers();
    S.enteredAt = performance.now();
    preload(S.pos + 1);
  }

  function renderAnswers() {
    const it = curItem(), r = S.resp[it.id] || {};
    for (const q of ["q1", "q2"]) {
      const box = document.querySelector(`.choices[data-q="${q}"]`);
      box.replaceChildren(...CHOICES[q].map(([v, label]) =>
        el("button", { type: "button", class: `choice${v.length === 1 ? " big" : ""}`, "aria-pressed": String(r[q] === v),
                       onclick: () => answer(q, r[q] === v ? null : v) }, label)));
      const cf = document.querySelector(`.conf[data-q="${q}_conf"]`);
      cf.replaceChildren(el("span", { class: "lab" }, "확신도 (선택)"), ...CONFS.map(([v, label]) =>
        el("button", { type: "button", "aria-pressed": String(r[`${q}_conf`] === v),
                       onclick: () => answer(`${q}_conf`, r[`${q}_conf`] === v ? null : v) }, label)));
    }
    const ok = complete(it.id);
    $("#btn-next").disabled = !ok;
    $("#btn-next").textContent = S.pos === S.order.length - 1 ? "마치기" : "다음 →";
    $("#btn-prev").disabled = S.pos === 0;
    $("#nav-hint").textContent = ok ? "" : "질문 1과 질문 2에 모두 응답하면 다음으로 넘어갈 수 있습니다.";
  }

  function commitTime() {
    if (!S.code || !S.enteredAt || $("#screen-study").hidden) return 0;
    const it = curItem(), now = performance.now();
    const dt = now - S.enteredAt; S.enteredAt = now;
    S.resp[it.id] = S.resp[it.id] || {};
    S.resp[it.id].time_ms = (S.resp[it.id].time_ms || 0) + dt;
    return dt;
  }

  function answer(field, value) {
    const it = curItem();
    commitTime();
    S.resp[it.id] = { ...(S.resp[it.id] || {}), [field]: value };
    renderAnswers();
    queueSave(it.id);
    const done = answeredCount();
    $("#progress-fill").style.width = `${(100 * done) / S.order.length}%`;
    $("#progress-text").textContent = `${Math.round((100 * done) / S.order.length)}%`;
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
    if (S.pos === S.order.length - 1 || answeredCount() === S.order.length) {
      const nxt = S.order.findIndex((id) => !complete(id));
      if (nxt === -1) { commitTime(); queueSave(curItem().id); showDone(); return; }
      go(nxt); return;
    }
    go(S.pos + 1);
  }

  function preload(pos) {
    const id = S.order[pos]; if (!id) return;
    const it = S.items[id];
    for (const s of [it.query, ...it.A, ...it.B]) { const i = new Image(); i.src = img(s, "thumb"); }
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
      const r = S.resp[id] || {};
      const cls = complete(id) ? "done" : r.q1 || r.q2 ? "partial" : "";
      return el("button", { type: "button", class: `${cls}${i === S.pos ? " cur" : ""}`,
                            onclick: () => { $("#list-dialog").close(); go(i); } }, String(i + 1));
    }));
    $("#list-dialog").showModal();
  }

  // ── compare viewer ─────────────────────────────────
  // index 0..4 = A-1..A-5, 5..9 = B-1..B-5. Left pane is always the Query.
  const V = { idx: 0, panes: {} };
  function viewerList() { const it = curItem(); return [...it.A.map((id, i) => [`A-${i + 1}`, id]), ...it.B.map((id, i) => [`B-${i + 1}`, id])]; }

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
      stage.querySelectorAll(".box").forEach((b) => {
        const [bx, by, bw, bh] = JSON.parse(b.dataset.r);
        const W = im.naturalWidth, H = im.naturalHeight;
        b.style.left = `${st.x + bx * W * st.z}px`; b.style.top = `${st.y + by * H * st.z}px`;
        b.style.width = `${bw * W * st.z}px`; b.style.height = `${bh * H * st.z}px`;
      });
      tag.textContent = `${Math.round((st.z / st.fit) * 100)}%`;
    }
    function fit() {
      const W = im.naturalWidth, H = im.naturalHeight; if (!W) return;
      const sw = stage.clientWidth, sh = stage.clientHeight;
      st.fit = st.z = Math.min(sw / W, sh / H);
      st.x = (sw - W * st.z) / 2; st.y = (sh - H * st.z) / 2; apply();
    }
    im.addEventListener("load", () => {
      stage.querySelectorAll(".box").forEach((b) => b.remove());
      if (st.view === "thumb" && S.slides[st.id]) {
        S.slides[st.id].p.forEach((r, i) => {
          const b = el("div", { class: "box", "data-r": JSON.stringify(r), title: `패치 ${i + 1}` });
          stage.append(b);
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
      const views = [["thumb", "전체"], ...Array.from({ length: nPatches(id) }, (_, i) => [`p${i + 1}`, `패치 ${i + 1}`])];
      head.replaceChildren(el("span", { class: "name" }, name), ...views.map(([v, l]) =>
        el("button", { type: "button", "aria-pressed": String(v === view), onclick: () => set(id, name, v) }, l)));
      im.src = img(id, view);
    }
    return { set, fit, get view() { return st.view; } };
  }

  function openViewer(idx) {
    const v = $("#viewer");
    v.hidden = false;
    document.body.style.overflow = "hidden";
    if (!V.panes.left) { V.panes.left = makePane($("#v-left")); V.panes.right = makePane($("#v-right")); }
    V.panes.left.set(curItem().query, "Query");
    const strip = $("#v-strip");
    const list = viewerList();
    strip.replaceChildren(
      el("span", { class: "grp" }, "Set A"),
      ...list.slice(0, 5).map(([l, id], i) => el("button", { type: "button", title: l, onclick: () => viewerGo(i) }, el("img", { src: img(id, "thumb"), alt: l }))),
      el("span", { class: "grp" }, "Set B"),
      ...list.slice(5).map(([l, id], i) => el("button", { type: "button", title: l, onclick: () => viewerGo(5 + i) }, el("img", { src: img(id, "thumb"), alt: l }))));
    viewerGo(idx);
  }
  function viewerGo(idx) {
    const list = viewerList();
    V.idx = (idx + list.length) % list.length;
    const [label, id] = list[V.idx];
    $("#v-label").textContent = label;
    V.panes.right.set(id, label, "thumb");
    [...$("#v-strip").querySelectorAll("button")].forEach((b, i) => b.classList.toggle("cur", i === V.idx));
  }
  function closeViewer() { $("#viewer").hidden = true; document.body.style.overflow = ""; }
  window.addEventListener("resize", () => { if (!$("#viewer").hidden) { V.panes.left.fit(); V.panes.right.fit(); } });
  document.addEventListener("keydown", (e) => {
    if ($("#viewer").hidden) return;
    if (e.key === "Escape") closeViewer();
    else if (e.key === "ArrowRight") viewerGo(V.idx + 1);
    else if (e.key === "ArrowLeft") viewerGo(V.idx - 1);
  });

  // ── wiring ─────────────────────────────────────────
  $("#login-form").addEventListener("submit", (e) => { e.preventDefault(); login($("#login-code").value); });
  $("#intro-start").addEventListener("click", enterStudy);
  $("#btn-help").addEventListener("click", () => { commitTime(); show("screen-intro"); });
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
    const saved = store.get("rs_code", null);
    if (saved) { $("#login-code").value = saved; }
    show("screen-login");
  })();
})();
