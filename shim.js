/* shim.js — cho bản chạy độc lập (PHP + MySQL).
 * Cung cấp window.claude.use("db" | "sample" | "assets") cùng kiểu với claude.ai,
 * để so-job.html chạy nguyên vẹn mà không phải sửa logic. Thêm đăng nhập và quản lý người dùng. */
(function () {
  "use strict";
  if (window.claude && window.claude.use) return; // đang chạy trên claude.ai: không cần shim
  window.SOJOB_BLOB_BASE = "api/file.php?id=";

  const POLL_MS = 6000;
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function call(url, opts) {
    opts = opts || {};
    let r;
    try {
      r = await fetch(url, Object.assign({ credentials: "same-origin", cache: "no-store" }, opts,
        { headers: Object.assign({ "X-Requested-With": "sojob" }, opts.headers || {}) }));
    } catch (e) {
      if (e && e.name === "AbortError") throw { code: "cancelled", message: "Đã dừng." };
      throw { code: "unavailable", message: "Mất kết nối tới máy chủ." };
    }
    let j = null;
    try { j = await r.json(); } catch (e) { /* không phải JSON */ }
    if (r.status === 401 && !(j && j.code === "bad_credentials")) { showLogin(); throw { code: "not_granted", message: "Cần đăng nhập." }; }
    if (!r.ok) throw { code: (j && j.code) || "unavailable", message: (j && j.error) || ("Máy chủ báo lỗi " + r.status + ".") };
    return j || {};
  }
  const sendJson = (url, method, body) => call(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  /* ---------- đăng nhập ---------- */
  let me = null;
  const never = new Promise(() => {});
  const ready = call("api/auth.php").then(j => {
    me = j.user || null;
    if (!me) { showLogin(); return never; }
    addUserBar();
    return me;
  }, e => { showBanner(e.message); return never; });

  function showBanner(msg) {
    const go = () => { const b = $("#banner"); if (b) b.innerHTML = `<div class="banner">${esc(msg)}</div>`; };
    document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", go) : go();
  }
  function overlay(html) {
    const d = document.createElement("div");
    d.className = "modal";
    d.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(d);
    return d;
  }
  let loginShown = false;
  function showLogin() {
    if (loginShown) return; loginShown = true;
    const open = () => {
      const d = overlay(`<h2>Đăng nhập Sổ Job</h2>
        <form id="sj-login" style="display:flex;flex-direction:column;gap:10px">
          <label class="fld"><span>Tên đăng nhập</span><input id="sj-u" autocomplete="username" required></label>
          <label class="fld"><span>Mật khẩu</span><input id="sj-p" type="password" autocomplete="current-password" required></label>
          <div class="mrow"><span id="sj-err" class="note err"></span><button class="primary" type="submit">Đăng nhập</button></div>
        </form>`);
      $("#sj-u", d).focus();
      $("#sj-login", d).addEventListener("submit", async e => {
        e.preventDefault();
        const btn = $("button", d); btn.disabled = true; $("#sj-err", d).textContent = "";
        try {
          await sendJson("api/auth.php", "POST", { action: "login", username: $("#sj-u", d).value.trim(), password: $("#sj-p", d).value });
          location.reload();
        } catch (err) { $("#sj-err", d).textContent = err.message; btn.disabled = false; }
      });
    };
    document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", open) : open();
  }
  function addUserBar() {
    const go = () => {
      const top = $(".top"); if (!top) return;
      const s = document.createElement("span");
      s.style.cssText = "display:flex;gap:6px;align-items:center;white-space:nowrap";
      s.innerHTML = `<span style="color:var(--muted);font-size:13px">${esc(me.username)}</span>`
        + (me.admin ? `<button class="ghost sm" id="sj-users">Người dùng</button>` : "")
        + `<button class="ghost sm" id="sj-out">Đăng xuất</button>`;
      top.appendChild(s);
      $("#sj-out").addEventListener("click", async () => { try { await sendJson("api/auth.php", "POST", { action: "logout" }); } catch (e) {} location.reload(); });
      if (me.admin) $("#sj-users").addEventListener("click", openUsers);
    };
    document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", go) : go();
  }
  async function openUsers() {
    const d = overlay(`<h2>Người dùng</h2><p>Người dùng nào cũng xem và sửa được mọi job. Quản trị viên được thêm, xoá người dùng.</p>
      <div id="sj-list" class="card"></div>
      <form id="sj-add" class="grid2">
        <label class="fld"><span>Tên đăng nhập</span><input id="sj-nu" required></label>
        <label class="fld"><span>Mật khẩu (tối thiểu 8 ký tự)</span><input id="sj-np" type="password" minlength="8" required></label>
        <label class="chk"><input type="checkbox" id="sj-na">Quản trị viên</label>
        <div class="mrow"><span id="sj-uerr" class="note"></span><button class="primary" type="submit">Thêm / đổi mật khẩu</button></div>
      </form>
      <div class="mrow"><button id="sj-close">Đóng</button></div>`);
    const note = (t, err) => { const n = $("#sj-uerr", d); n.textContent = t; n.className = "note" + (err ? " err" : ""); };
    async function load() {
      try {
        const j = await call("api/users.php");
        $("#sj-list", d).innerHTML = j.users.map(u => `<div class="row" style="cursor:default;grid-template-columns:minmax(0,1fr) auto">
          <span class="t">${esc(u.username)}${u.admin ? ' <span class="pill">Quản trị</span>' : ""}</span>
          <span class="right">${u.username === me.username ? '<span class="pill">Bạn</span>' : `<button class="ghost sm danger" data-del="${esc(u.username)}">Xoá</button>`}</span></div>`).join("");
      } catch (e) { note(e.message, true); }
    }
    $("#sj-list", d).addEventListener("click", async e => {
      const b = e.target.closest("[data-del]"); if (!b) return;
      if (!b.classList.contains("arm")) { b.classList.add("arm"); b.textContent = "Bấm lần nữa để xoá"; return; }
      try { await call("api/users.php?u=" + encodeURIComponent(b.dataset.del), { method: "DELETE" }); note("Đã xoá " + b.dataset.del + "."); load(); }
      catch (err) { note(err.message, true); }
    });
    $("#sj-add", d).addEventListener("submit", async e => {
      e.preventDefault();
      try {
        await sendJson("api/users.php", "POST", { username: $("#sj-nu", d).value.trim(), password: $("#sj-np", d).value, admin: $("#sj-na", d).checked });
        note("Đã lưu " + $("#sj-nu", d).value.trim() + "."); $("#sj-np", d).value = ""; load();
      } catch (err) { note(err.message, true); }
    });
    $("#sj-close", d).addEventListener("click", () => d.remove());
    load();
  }

  /* ---------- db: kho tài liệu, đồng bộ bằng hỏi định kỳ ---------- */
  const cols = {};
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(15)), b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  function colState(name) {
    return cols[name] || (cols[name] = { name, docs: new Map(), ver: "", listeners: new Set(), loaded: false, inflight: null, seq: 0 });
  }
  function docSnap(id, data) {
    return { id, exists: data !== undefined, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function buildSnap(st) {
    const docs = [...st.docs.keys()].sort().map(id => docSnap(id, st.docs.get(id)));
    return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false },
      docChanges: () => docs.map((doc, i) => ({ type: "added", doc, oldIndex: -1, newIndex: i })) };
  }
  function emit(st) {
    const snap = buildSnap(st);
    st.listeners.forEach(l => { try { l.next(snap); } catch (e) { console.error(e); } });
  }
  function poll(st) {
    if (st.inflight) return st.inflight;
    const seq = st.seq;
    st.inflight = (async () => {
      try {
        const j = await call("api/db.php?col=" + encodeURIComponent(st.name) + "&ver=" + encodeURIComponent(st.ver));
        if (seq !== st.seq) return; // có lần ghi trong lúc đọc: bỏ kết quả cũ, lần sau đọc lại
        if (!j.same) { st.ver = j.ver; st.docs = new Map(j.docs.map(d => [d.id, d.data])); }
        const first = !st.loaded; st.loaded = true;
        if (!j.same || first) emit(st);
      } catch (e) {
        if (!st.loaded && e.code !== "not_granted") st.listeners.forEach(l => l.error && l.error({ code: "unavailable", message: e.message }));
      } finally { st.inflight = null; }
    })();
    return st.inflight;
  }
  setInterval(() => { if (!document.hidden) Object.values(cols).forEach(st => st.listeners.size && poll(st)); }, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) Object.values(cols).forEach(st => st.listeners.size && poll(st)); });

  function docRef(col, id) {
    const st = colState(col);
    const url = () => "api/db.php?col=" + encodeURIComponent(col) + "&id=" + encodeURIComponent(id);
    return {
      id, path: col + "/" + id,
      async set(data) {
        st.seq++; st.docs.set(id, clone(data)); st.ver = ""; emit(st);
        await call(url(), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
          .catch(e => { throw { code: e.code === "quota_exceeded" ? "quota_exceeded" : e.code === "invalid_argument" ? "invalid_argument" : "unavailable", message: e.message }; });
      },
      async update(data) {
        if (!st.docs.has(id)) await poll(st);
        if (!st.docs.has(id)) throw { code: "invalid_argument", message: "Tài liệu không tồn tại." };
        return this.set(Object.assign({}, clone(st.docs.get(id)), data));
      },
      async delete() {
        st.seq++; st.docs.delete(id); st.ver = ""; emit(st);
        await call(url(), { method: "DELETE" }).catch(e => { throw { code: "unavailable", message: e.message }; });
      },
      async get() { await poll(st); return docSnap(id, st.docs.get(id)); },
      onSnapshot(next, error) {
        const l = { next: snap => next(docSnap(id, st.docs.get(id))), error };
        st.listeners.add(l);
        if (st.loaded) setTimeout(() => st.listeners.has(l) && l.next(), 0); else poll(st);
        return () => st.listeners.delete(l);
      },
      collection() { throw new TypeError("Bản độc lập không hỗ trợ bộ sưu tập con."); },
    };
  }
  function colRef(name) {
    const st = colState(name);
    return {
      path: name,
      doc: id => docRef(name, id || rid()),
      async add(data) { const r = docRef(name, rid()); await r.set(data); return r; },
      async get() { await poll(st); return buildSnap(st); },
      onSnapshot(next, error) {
        const l = { next, error };
        st.listeners.add(l);
        if (st.loaded) setTimeout(() => st.listeners.has(l) && next(buildSnap(st)), 0); else poll(st);
        return () => st.listeners.delete(l);
      },
    };
  }
  const db = {
    collection: path => colRef(path),
    doc(path) { const i = path.lastIndexOf("/"); return docRef(path.slice(0, i), path.slice(i + 1)); },
  };

  /* ---------- ảnh: thu nhỏ trước khi gửi để đỡ tốn dung lượng và chi phí ---------- */
  async function shrink(blob, maxSide = 2000) {
    try {
      if (!blob || !/^image\/(jpeg|png|webp)$/.test(blob.type) || typeof createImageBitmap !== "function") return blob;
      const bmp = await createImageBitmap(blob);
      const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
      if (k === 1 && blob.size < 2.5e6) { bmp.close && bmp.close(); return blob; }
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close && bmp.close();
      const out = await new Promise(res => c.toBlob(res, "image/jpeg", 0.88));
      return out || blob;
    } catch (e) { return blob; }
  }
  const asList = v => !v ? [] : (v instanceof Blob ? [v] : Array.from(v));

  /* ---------- sample: gọi Claude qua api/ai.php ---------- */
  function parseLoose(text) {
    const t = String(text || "").trim();
    try { return JSON.parse(t); } catch (e) {}
    const f = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (f) { try { return JSON.parse(f[1]); } catch (e) {} }
    const a = t.search(/[\[{]/), b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
    throw { code: "invalid_json", message: "Câu trả lời không phải JSON.", text: t };
  }
  async function sample(input, opts) {
    opts = opts || {};
    const prompt = typeof input === "string" ? input : (input || []).map(m => m.content).join("\n\n");
    const fd = new FormData();
    fd.append("prompt", prompt);
    const imgs = asList(opts.images);
    for (let i = 0; i < imgs.length; i++) {
      const b = await shrink(imgs[i]);
      fd.append("images[]", b, "anh-" + (i + 1) + (b.type === "image/jpeg" ? ".jpg" : b.type === "image/png" ? ".png" : b.type === "image/webp" ? ".webp" : ".gif"));
    }
    const j = await call("api/ai.php", { method: "POST", body: fd, signal: opts.signal });
    if (typeof opts.onText === "function") { try { opts.onText({ text: j.text, delta: j.text }); } catch (e) {} }
    return { text: j.text, truncated: !!j.truncated, modelTierApplied: "default" };
  }
  sample.json = async (input, opts) => {
    const r = await sample(input, opts);
    if (r.truncated) throw { code: "invalid_json", message: "Câu trả lời bị cắt ngắn.", text: r.text };
    return parseLoose(r.text);
  };
  sample.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 5, maxInputBytes: 10 * 1024 * 1024, mediaTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"] } });

  /* ---------- assets: lưu ảnh gốc ---------- */
  const assets = {
    async upload(blob) {
      const b = await shrink(blob, 2400);
      const fd = new FormData();
      fd.append("file", b, "anh" + (b.type === "image/png" ? ".png" : b.type === "image/webp" ? ".webp" : b.type === "image/gif" ? ".gif" : ".jpg"));
      return call("api/upload.php", { method: "POST", body: fd });
    },
    async list() { return { assets: [], usage: {} }; },
    async delete() { throw { code: "not_supported", message: "Chưa hỗ trợ xoá ảnh." }; },
  };

  const caps = { db, sample, assets };
  window.claude = Object.freeze({ use: async name => { await ready; return caps[name] || null; } });
})();
