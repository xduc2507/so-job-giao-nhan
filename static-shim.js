/* static-shim.js — cho bản tĩnh (GitHub Pages, không có máy chủ).
 * Cung cấp window.claude.use("db" | "sample" | "assets") giống claude.ai:
 *  - db: lưu trong IndexedDB của trình duyệt (mỗi máy / trình duyệt một sổ riêng)
 *  - sample: gọi thẳng Claude API bằng API key người dùng tự nhập (chỉ lưu trong trình duyệt này)
 *  - assets: ảnh gốc thu nhỏ, lưu dạng data URL ngay trong job
 * Có nút "Cài đặt" để nhập key, sao lưu / khôi phục dữ liệu ra file JSON. */
(function () {
  "use strict";
  if (window.claude && window.claude.use) return;
  window.SOJOB_BLOB_BASE = ""; // id ảnh chính là data URL

  const KEY_LS = "sojob.anthropicKey";
  const MODEL = "claude-opus-5-5";
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const onReady = fn => document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn) : fn();
  const getKey = () => { try { return localStorage.getItem(KEY_LS) || ""; } catch (e) { return ""; } };

  /* ---------- IndexedDB ---------- */
  const idb = new Promise((res, rej) => {
    const r = indexedDB.open("sojob", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("docs");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  async function tx(mode, fn) {
    const d = await idb;
    return new Promise((res, rej) => {
      const t = d.transaction("docs", mode), s = t.objectStore("docs");
      const out = fn(s);
      t.oncomplete = () => res(out && "result" in out ? out.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error("Giao dịch bị huỷ"));
    });
  }
  async function allDocs() {
    const d = await idb;
    return new Promise((res, rej) => {
      const out = [], c = d.transaction("docs").objectStore("docs").openCursor();
      c.onsuccess = () => { const k = c.result; if (!k) return res(out); out.push([k.key, k.value]); k.continue(); };
      c.onerror = () => rej(c.error);
    });
  }

  /* ---------- db: giả lập kiểu Firestore ---------- */
  const cols = {};
  const bc = "BroadcastChannel" in window ? new BroadcastChannel("sojob") : null;
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(15)), b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const loaded = allDocs().then(rows => {
    for (const [k, v] of rows) { const i = k.indexOf("/"); colState(k.slice(0, i)).docs.set(k.slice(i + 1), v); }
  });
  function colState(name) { return cols[name] || (cols[name] = { docs: new Map(), listeners: new Set() }); }
  const docSnap = (id, data) => ({ id, exists: data !== undefined, data: () => clone(data), metadata: { fromCache: false, hasPendingWrites: false } });
  function buildSnap(st) {
    const docs = [...st.docs.keys()].sort().map(id => docSnap(id, st.docs.get(id)));
    return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false },
      docChanges: () => docs.map((doc, i) => ({ type: "added", doc, oldIndex: -1, newIndex: i })) };
  }
  function emit(st) { const s = buildSnap(st); st.listeners.forEach(l => { try { l.next(s); } catch (e) { console.error(e); } }); }
  // Tab khác cùng trình duyệt sửa dữ liệu: cập nhật theo
  if (bc) bc.onmessage = ev => {
    const { col, id, data } = ev.data || {}; if (!col) return;
    const st = colState(col);
    data === null ? st.docs.delete(id) : st.docs.set(id, data);
    emit(st);
  };
  const wrapErr = e => ({ code: e && e.name === "QuotaExceededError" ? "quota_exceeded" : "unavailable", message: "Không lưu được vào trình duyệt: " + (e && e.message || e) });

  function docRef(col, id) {
    const st = colState(col), k = col + "/" + id;
    return {
      id, path: k,
      async set(data) {
        await loaded;
        const v = clone(data);
        st.docs.set(id, v); emit(st);
        await tx("readwrite", s => { s.put(v, k); }).catch(e => { throw wrapErr(e); });
        bc && bc.postMessage({ col, id, data: v });
      },
      async update(data) {
        await loaded;
        if (!st.docs.has(id)) throw { code: "invalid_argument", message: "Tài liệu không tồn tại." };
        return this.set(Object.assign({}, st.docs.get(id), clone(data)));
      },
      async delete() {
        await loaded;
        st.docs.delete(id); emit(st);
        await tx("readwrite", s => { s.delete(k); }).catch(e => { throw wrapErr(e); });
        bc && bc.postMessage({ col, id, data: null });
      },
      async get() { await loaded; return docSnap(id, st.docs.get(id)); },
      onSnapshot(next, error) {
        const l = { next: () => next(docSnap(id, st.docs.get(id))), error };
        st.listeners.add(l);
        loaded.then(() => st.listeners.has(l) && l.next(), e => error && error({ code: "unavailable", message: String(e) }));
        return () => st.listeners.delete(l);
      },
      collection() { throw new TypeError("Bản tĩnh không hỗ trợ bộ sưu tập con."); },
    };
  }
  function colRef(name) {
    const st = colState(name);
    return {
      path: name,
      doc: id => docRef(name, id || rid()),
      async add(data) { const r = docRef(name, rid()); await r.set(data); return r; },
      async get() { await loaded; return buildSnap(st); },
      onSnapshot(next, error) {
        const l = { next, error };
        st.listeners.add(l);
        loaded.then(() => st.listeners.has(l) && next(buildSnap(st)), e => error && error({ code: "unavailable", message: String(e) }));
        return () => st.listeners.delete(l);
      },
    };
  }
  const db = {
    collection: p => colRef(p),
    doc(p) { const i = p.lastIndexOf("/"); return docRef(p.slice(0, i), p.slice(i + 1)); },
  };

  /* ---------- ảnh ---------- */
  async function shrink(blob, maxSide, quality) {
    try {
      if (!blob || !/^image\/(jpeg|png|webp)$/.test(blob.type) || typeof createImageBitmap !== "function") return blob;
      const bmp = await createImageBitmap(blob);
      const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
      if (k === 1 && blob.size < 1.5e6) { bmp.close && bmp.close(); return blob; }
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close && bmp.close();
      return (await new Promise(r => c.toBlob(r, "image/jpeg", quality))) || blob;
    } catch (e) { return blob; }
  }
  const toDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
  const asList = v => !v ? [] : (v instanceof Blob ? [v] : Array.from(v));

  /* ---------- sample: gọi Claude API trực tiếp ---------- */
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
    const key = getKey();
    if (!key) { openSettings(); throw { code: "sampling_disabled", message: "Chưa nhập API key Claude. Bấm “Cài đặt” ở góc trên để nhập." }; }
    const prompt = typeof input === "string" ? input : (input || []).map(m => m.content).join("\n\n");
    const content = [];
    for (const img of asList(opts.images).slice(0, 5)) {
      const b = await shrink(img, 2000, 0.88);
      const url = await toDataURL(b);
      content.push({ type: "image", source: { type: "base64", media_type: b.type || "image/jpeg", data: url.slice(url.indexOf(",") + 1) } });
    }
    content.push({ type: "text", text: prompt });
    let r;
    try {
      r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: opts.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "server-side-fallback-2026-07-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({ model: MODEL, max_tokens: 16000, messages: [{ role: "user", content }],
          output_config: { effort: "medium" }, fallbacks: "default" }),
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw { code: "cancelled", message: "Đã dừng." };
      throw { code: "unavailable", message: "Không kết nối được tới Claude API. Kiểm tra mạng rồi thử lại." };
    }
    let j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) {
      const m = j && j.error && j.error.message || "";
      if (r.status === 401 || r.status === 403) throw { code: "sampling_disabled", message: "API key Claude không hợp lệ hoặc không có quyền. Bấm “Cài đặt” để nhập lại." };
      if (r.status === 429) throw { code: "rate_limited", message: "Tài khoản API chạm giới hạn hoặc hết tiền. Thử lại sau, hoặc nạp thêm ở console.anthropic.com." };
      if (r.status === 529 || r.status === 503) throw { code: "rate_limited", message: "Claude đang quá tải. Thử lại sau ít phút." };
      if (r.status === 400) throw { code: "invalid_request", message: "Claude không nhận yêu cầu: " + m };
      throw { code: "upstream_error", message: "Lỗi từ Claude API (" + r.status + "). Thử lại." };
    }
    if (j.stop_reason === "refusal") throw { code: "refused", message: "Claude không xử lý được nội dung này." };
    const text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    if (!text.trim()) throw { code: "empty_completion", message: "Claude không trả về nội dung." };
    if (typeof opts.onText === "function") { try { opts.onText({ text, delta: text }); } catch (e) {} }
    return { text, truncated: j.stop_reason === "max_tokens", modelTierApplied: "default" };
  }
  sample.json = async (input, opts) => {
    const r = await sample(input, opts);
    if (r.truncated) throw { code: "invalid_json", message: "Câu trả lời bị cắt ngắn.", text: r.text };
    return parseLoose(r.text);
  };
  sample.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 5, maxInputBytes: 10 * 1024 * 1024, mediaTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"] } });

  /* ---------- assets: ảnh gốc thu nhỏ, lưu thẳng trong job ---------- */
  const assets = {
    async upload(blob) {
      const b = await shrink(blob, 1400, 0.8);
      const url = await toDataURL(b);
      return { id: url, url, sizeBytes: b.size, contentType: b.type };
    },
    async list() { return { assets: [], usage: {} }; },
    async delete() { throw { code: "not_supported", message: "Chưa hỗ trợ xoá ảnh." }; },
  };

  /* ---------- Cài đặt: API key, sao lưu, khôi phục ---------- */
  function overlay(html) {
    const d = document.createElement("div");
    d.className = "modal";
    d.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(d);
    return d;
  }
  let settingsOpen = false;
  function openSettings() {
    if (settingsOpen) return; settingsOpen = true;
    const k = getKey();
    const d = overlay(`<h2>Cài đặt</h2>
      <p>Bản dùng thử trên GitHub Pages. Dữ liệu chỉ nằm <b>trong trình duyệt này</b>: máy khác, trình duyệt khác sẽ thấy sổ trống. Nhớ sao lưu thường xuyên.</p>
      <label class="fld"><span>API key Claude (lấy ở console.anthropic.com → API keys)</span>
        <input id="sj-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" value="${esc(k)}"></label>
      <p class="note">Key chỉ lưu trong trình duyệt này và chỉ gửi tới api.anthropic.com. Đừng nhập key trên máy dùng chung. Không có key vẫn tạo job trống và nhập tay được.</p>
      <div class="mrow"><span id="sj-msg" class="note"></span>
        ${k ? '<button class="ghost danger" id="sj-clear">Xoá key</button>' : ""}
        <button class="primary" id="sj-save">Lưu key</button></div>
      <h2 style="margin-top:14px">Dữ liệu</h2>
      <div class="mrow" style="justify-content:flex-start;flex-wrap:wrap">
        <button id="sj-exp">Tải file sao lưu (.json)</button>
        <button id="sj-imp">Khôi phục từ file…</button>
        <input id="sj-file" type="file" accept="application/json,.json" hidden>
      </div>
      <div class="mrow"><button id="sj-close">Đóng</button></div>`);
    const msg = (t, err) => { const n = $("#sj-msg", d); n.textContent = t; n.className = "note" + (err ? " err" : ""); };
    const close = () => { d.remove(); settingsOpen = false; };
    $("#sj-close", d).onclick = close;
    $("#sj-save", d).onclick = () => {
      const v = $("#sj-key", d).value.trim();
      if (!/^sk-ant-[\w-]{20,}$/.test(v)) { msg("Key phải bắt đầu bằng sk-ant-…", true); return; }
      try { localStorage.setItem(KEY_LS, v); msg("Đã lưu key."); } catch (e) { msg("Trình duyệt chặn lưu (chế độ ẩn danh?).", true); }
    };
    const clr = $("#sj-clear", d);
    if (clr) clr.onclick = () => { try { localStorage.removeItem(KEY_LS); } catch (e) {} $("#sj-key", d).value = ""; msg("Đã xoá key."); };
    $("#sj-exp", d).onclick = async () => {
      const rows = await allDocs();
      const blob = new Blob([JSON.stringify({ app: "so-job", version: 1, exportedAt: new Date().toISOString(), docs: rows.map(([k, v]) => ({ path: k, data: v })) })], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = "so-job-" + new Date().toISOString().slice(0, 10) + ".json";
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
    $("#sj-imp", d).onclick = () => $("#sj-file", d).click();
    $("#sj-file", d).onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        if (!j || j.app !== "so-job" || !Array.isArray(j.docs)) throw new Error("File không phải bản sao lưu Sổ Job.");
        const good = j.docs.filter(x => x && typeof x.path === "string" && /^[a-z]+\/.+/.test(x.path) && x.data && typeof x.data === "object");
        await tx("readwrite", s => { good.forEach(x => s.put(x.data, x.path)); });
        msg("Đã khôi phục " + good.length + " mục. Đang tải lại…");
        setTimeout(() => location.reload(), 800);
      } catch (err) { msg(err.message || "Không đọc được file.", true); }
    };
  }
  onReady(() => {
    const top = $(".top"); if (!top) return;
    const b = document.createElement("button");
    b.className = "ghost sm"; b.textContent = "Cài đặt"; b.onclick = openSettings;
    top.appendChild(b);
  });

  const caps = { db, sample, assets };
  window.claude = Object.freeze({ use: async name => caps[name] || null });
})();
