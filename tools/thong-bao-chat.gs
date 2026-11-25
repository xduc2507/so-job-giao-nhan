/**
 * Sổ Job – gửi thông báo đẩy lên điện thoại khi có tin nhắn mới trong khung Trao đổi của job.
 * App gọi: POST <link>/exec  với nội dung {"job":"<id job>"}.
 * Script tự đọc job và tin nhắn mới nhất trong Firestore (không tin nội dung gửi kèm),
 * gửi cho người thấy được job (chủ sổ; nhân viên nếu job đã chia sẻ hoặc do họ tạo),
 * trừ người gửi. Việc riêng của chủ sổ không bao giờ gửi.
 * Chạy bằng tài khoản chủ sổ (chủ dự án Firebase) nên đọc được Firestore và gửi được FCM.
 * appsscript.json: "oauthScopes": [datastore, firebase.messaging, script.external_request, userinfo.email, script.scriptapp, drive],
 * "webapp": {"executeAs":"USER_DEPLOYING","access":"ANYONE_ANONYMOUS"}. Triển khai: Ứng dụng web.
 */
var PID = "so-job-giao-nhan";
var APP = "https://opsdad.net/";
var FS = "https://firestore.googleapis.com/v1/projects/" + PID + "/databases/(default)/documents";

function doPost(e) {
  var out = { ok: false }, body = null;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    out = body.ai ? goiAI(body.ai, body.token) : body.test ? thuMayToi(body.token) : body.team ? guiChatChung() : guiThongBao(String(body.job || ""));
  } catch (err) { out = { ok: false, msg: String(err) }; }
  console.log(JSON.stringify(out));
  if (body && (body.ai || body.test)) return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON); // không ghi nhật ký nội dung AI / thử
  try { var P = PropertiesService.getScriptProperties(), L = JSON.parse(P.getProperty("log") || "[]"); L.unshift({ t: new Date().toISOString(), job: (body && body.job) || (body && body.team ? "team" : ""), out: out }); P.setProperty("log", JSON.stringify(L.slice(0, 10))); } catch (x) {}
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
function doGet(e) { if (e && e.parameter && e.parameter.log === "1") return ContentService.createTextOutput(PropertiesService.getScriptProperties().getProperty("log") || "[]").setMimeType(ContentService.MimeType.JSON); return ContentService.createTextOutput("ok"); }

function goi(url, opt) {
  opt = opt || {};
  opt.headers = Object.assign({ Authorization: "Bearer " + ScriptApp.getOAuthToken(), "X-Goog-User-Project": PID }, opt.headers || {});
  opt.muteHttpExceptions = true;
  if (opt.payload && typeof opt.payload !== "string") { opt.payload = JSON.stringify(opt.payload); opt.contentType = "application/json"; }
  var r = UrlFetchApp.fetch(url, opt);
  return { code: r.getResponseCode(), json: (function () { try { return JSON.parse(r.getContentText()); } catch (x) { return {}; } })(), text: r.getContentText().slice(0, 300) };
}
function giaTri(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(giaTri);
  if ("mapValue" in v) { var o = {}, f = v.mapValue.fields || {}; for (var k in f) o[k] = giaTri(f[k]); return o; }
  return null;
}
function docFs(path) {
  var r = goi(FS + "/" + path);
  if (r.code !== 200) return null;
  var o = {}, f = r.json.fields || {};
  for (var k in f) o[k] = giaTri(f[k]);
  return o;
}

function guiThongBao(jobId) {
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(jobId)) return { ok: false, msg: "Sai mã job" };
  var owner = Session.getEffectiveUser().getEmail().toLowerCase();
  var job = docFs("jobs/" + jobId);
  if (!job) return { ok: false, msg: "Không đọc được job" };
  var createdBy = String(job.createdBy || "").toLowerCase();
  if (!job.shared && (!createdBy || createdBy === owner)) return { ok: true, sent: 0, msg: "Việc riêng: không gửi" };
  // tin nhắn mới nhất
  var q = goi(FS + "/jobs/" + jobId + ":runQuery", { method: "post", payload: { structuredQuery: {
    from: [{ collectionId: "chat" }], orderBy: [{ field: { fieldPath: "at" }, direction: "DESCENDING" }], limit: 1 } } });
  var last = (Array.isArray(q.json) ? q.json : []).filter(function (x) { return x.document; })[0];
  if (!last) return { ok: false, msg: "Chưa có tin" };
  var f = last.document.fields || {}, msg = { text: giaTri(f.text) || "", by: String(giaTri(f.by) || "").toLowerCase(), byName: giaTri(f.byName) || "", at: Number(giaTri(f.at) || 0), tags: (giaTri(f.tags) || []).map(function (x) { return String(x).toLowerCase(); }), tagAll: !!giaTri(f.tagAll) };
  if (Date.now() - msg.at > 10 * 60 * 1000) return { ok: true, sent: 0, msg: "Tin cũ" };
  var props = PropertiesService.getScriptProperties(), key = "last_" + jobId;
  if (Number(props.getProperty(key) || 0) >= msg.at) return { ok: true, sent: 0, msg: "Đã gửi" };
  props.setProperty(key, String(msg.at));
  // người nhận: chủ sổ + (job chung: mọi thành viên; không chung: người tạo), trừ người gửi
  var nguoi = [owner];
  if (job.shared) nguoi = nguoi.concat(thanhVien()); else if (createdBy) nguoi.push(createdBy);
  nguoi = nguoi.filter(function (x, i, a) { return x && a.indexOf(x) === i && x !== msg.by; });
  var title = "💬 " + (msg.byName || msg.by) + " · " + (job.code || "");
  var titleTag = "🔔 " + (msg.byName || msg.by) + " nhắc đến bạn · " + (job.code || "");
  var body = (job.title ? String(job.title).slice(0, 60) + "\n" : "") + String(msg.text).slice(0, 160);
  var sent = 0, loi = [], det = [];
  nguoi.forEach(function (mail) {
    var r = guiMay(mail, { title: duocTag(msg, mail) ? titleTag : title, body: body, data: { job: jobId }, link: APP + "?job=" + encodeURIComponent(jobId), tag: "job-" + jobId });
    sent += r.sent; loi = loi.concat(r.loi); det.push(mail.slice(0, 3) + "…:" + r.may + (r.xoa ? "(-" + r.xoa + ")" : ""));
  });
  return { ok: true, sent: sent, to: nguoi.length, loi: loi, det: det };
}
/** Chạy thử bằng tay trong trình soạn Apps Script để cấp quyền lần đầu. */
function thu() { Logger.log(Session.getEffectiveUser().getEmail()); Logger.log(JSON.stringify(goi(FS + "/members?pageSize=1").code)); }

/** Gửi 1 thông báo thử tới các máy của chủ sổ (chọn hàm này rồi bấm Chạy trong trình soạn Apps Script). */
function thuGuiChu() {
  var owner = Session.getEffectiveUser().getEmail().toLowerCase();
  var p = docFs("push/" + owner), toks = (p && p.tokens) || [], kq = [];
  toks.forEach(function (t) {
    var r = goi("https://fcm.googleapis.com/v1/projects/" + PID + "/messages:send", { method: "post", payload: { message: { token: t,
      webpush: { notification: { title: "💬 Sổ Job · thử thông báo", body: "Nếu thấy dòng này trên điện thoại là thông báo đã chạy.", icon: APP + "icon-192.png" }, fcm_options: { link: APP } } } } });
    kq.push(r.code + " " + r.text);
  });
  Logger.log(toks.length + " máy: " + kq.join(" | "));
}

/** Chat chung: báo tin mới nhất (không gắn job) cho mọi thành viên, trừ người gửi và người tắt báo Chat chung. */
// Tin có tag người này (hoặc @Tất cả) thì tiêu đề ghi "nhắc đến bạn"
function duocTag(msg, mail) { return !!(msg.tagAll || (msg.tags || []).indexOf(String(mail).toLowerCase()) >= 0); }

function guiChatChung() {
  var owner = Session.getEffectiveUser().getEmail().toLowerCase();
  var q = goi(FS + ":runQuery", { method: "post", payload: { structuredQuery: {
    from: [{ collectionId: "teamchat" }], orderBy: [{ field: { fieldPath: "at" }, direction: "DESCENDING" }], limit: 1 } } });
  var last = (Array.isArray(q.json) ? q.json : []).filter(function (x) { return x.document; })[0];
  if (!last) return { ok: false, msg: "Chưa có tin", q: q.code };
  var f = last.document.fields || {};
  if (f.job) return { ok: true, sent: 0, msg: "Tin gắn job: đã báo theo job" };
  var msg = { text: giaTri(f.text) || "", by: String(giaTri(f.by) || "").toLowerCase(), byName: giaTri(f.byName) || "", at: Number(giaTri(f.at) || 0), tags: (giaTri(f.tags) || []).map(function (x) { return String(x).toLowerCase(); }), tagAll: !!giaTri(f.tagAll) };
  if (Date.now() - msg.at > 10 * 60 * 1000) return { ok: true, sent: 0, msg: "Tin cũ" };
  var props = PropertiesService.getScriptProperties();
  if (Number(props.getProperty("last_team") || 0) >= msg.at) return { ok: true, sent: 0, msg: "Đã gửi" };
  props.setProperty("last_team", String(msg.at));
  var nguoi = [owner].concat(thanhVien()).filter(function (x, i, a) { return x && a.indexOf(x) === i && x !== msg.by; });
  var sent = 0, loi = [], det = [];
  nguoi.forEach(function (mail) {
    var r = guiMay(mail, { title: (duocTag(msg, mail) ? "🔔 " + (msg.byName || msg.by) + " nhắc đến bạn" : "💬 " + (msg.byName || msg.by)) + " · Chat chung",
      body: String(msg.text).slice(0, 200), data: { view: "team" }, link: APP + "?view=team", tag: "teamchat" });
    sent += r.sent; loi = loi.concat(r.loi); det.push(mail.slice(0, 3) + "…:" + r.may + (r.xoa ? "(-" + r.xoa + ")" : ""));
  });
  return { ok: true, sent: sent, to: nguoi.length, loi: loi, det: det };
}
/** Kiểm tra: ai đã đăng ký máy nhận thông báo (chọn hàm này rồi bấm Chạy). */
function chanDoan() {
  var owner = Session.getEffectiveUser().getEmail().toLowerCase(), nguoi = [owner];
  var m = goi(FS + "/members?pageSize=200");
  ((m.json && m.json.documents) || []).forEach(function (d) { nguoi.push(decodeURIComponent(d.name.split("/").pop()).toLowerCase()); });
  nguoi.forEach(function (mail) { var p = docFs("push/" + mail); Logger.log(mail.replace(/^(.{3}).*@/, "$1…@") + ": " + ((p && p.tokens) || []).length + " máy" + (p && p.at ? ", đăng ký " + new Date(p.at).toLocaleString() : "") + (p && p.diag ? " | bản " + (p.diag.ver || "cũ") + " | lần cuối: " + p.diag.stage + (p.diag.err ? " (" + p.diag.err + ")" : "") + ", quyền " + p.diag.perm + ", màn hình chính " + p.diag.standalone + ", " + new Date(p.diag.at).toLocaleString() + " | " + p.diag.ua : "")); });
}

/* =====================================================================
 * TỰ ĐỘNG (chạy theo giờ). Cài một lần: chọn hàm caiLich rồi bấm Chạy.
 *  - theoDoiToKhai: 30 phút/lần, 7h–19h: kiểm tra các lô "Chờ thông quan"; thông quan thì báo điện thoại.
 *  - nhacViecSang: 8h sáng: báo mỗi người lô đến hạn hôm nay, quá hạn chưa ghi lý do.
 *  - saoLuuDem: 23h: sao lưu toàn bộ dữ liệu vào Google Drive (thư mục "So Job - Sao luu", giữ 30 bản).
 * Việc riêng của chủ sổ không bao giờ đưa vào thông báo.
 * ===================================================================== */
var TK_URL = "https://script.google.com/macros/s/AKfycbwtQV7vcwRtQLjxpZde6wB59jGrjdrakSeUNznnYNtOKa6Wv5BaBJ2cBPcRl0DgIT_G/exec";
var TZ = "Asia/Ho_Chi_Minh";

function caiLich() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (["theoDoiToKhai", "nhacViecSang", "saoLuuDem", "nhacHen"].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("theoDoiToKhai").timeBased().everyMinutes(30).create();
  ScriptApp.newTrigger("nhacViecSang").timeBased().atHour(8).nearMinute(0).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger("saoLuuDem").timeBased().atHour(23).nearMinute(0).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger("nhacHen").timeBased().everyMinutes(10).create();
  Logger.log("Đã cài lịch: " + ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }).join(", "));
}

/* Đổi giá trị JS sang dạng Firestore REST */
function veFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(veFs) } };
  var f = {}; for (var k in v) f[k] = veFs(v[k]); return { mapValue: { fields: f } };
}
function moFs(doc) { var o = {}, f = doc.fields || {}; for (var k in f) o[k] = giaTri(f[k]); o._id = doc.name.split("/").pop(); return o; }
function vaFs(path, obj) { // cập nhật vài trường của 1 tài liệu
  var keys = Object.keys(obj), f = {}; keys.forEach(function (k) { f[k] = veFs(obj[k]); });
  return goi(FS + "/" + path + "?" + keys.map(function (k) { return "updateMask.fieldPaths=" + encodeURIComponent(k); }).join("&"), { method: "patch", payload: { fields: f } });
}
function docHet(col) { // đọc hết 1 bộ sưu tập (theo trang)
  var out = [], tok = "";
  do {
    var r = goi(FS + "/" + col + "?pageSize=300" + (tok ? "&pageToken=" + encodeURIComponent(tok) : ""));
    ((r.json && r.json.documents) || []).forEach(function (d) { out.push(moFs(d)); });
    tok = r.json && r.json.nextPageToken;
  } while (tok);
  return out;
}
function chuSo() { return Session.getEffectiveUser().getEmail().toLowerCase(); }
function thanhVien() {
  var m = goi(FS + "/members?pageSize=200");
  return ((m.json && m.json.documents) || []).map(function (d) { return decodeURIComponent(d.name.split("/").pop()).toLowerCase(); });
}
function laViecRieng(j, owner) { return !j.shared && (!j.createdBy || String(j.createdBy).toLowerCase() === owner); }
function nguoiThayJob(j, owner, tv) { // ai thấy job này (để báo)
  if (laViecRieng(j, owner)) return [];
  var a = [owner];
  if (j.shared) a = a.concat(tv); else if (j.createdBy) a.push(String(j.createdBy).toLowerCase());
  return a.filter(function (x, i, s) { return x && s.indexOf(x) === i; });
}
function guiToi(mails, title, body, data, link, tag) { // gửi 1 thông báo tới các máy của danh sách người
  var sent = 0;
  mails.forEach(function (mail) { sent += guiMay(mail, { title: title, body: body, data: data, link: link, tag: tag }).sent; });
  return sent;
}
function homNay() { return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd"); }
function dm(s) { return s ? s.slice(8, 10) + "/" + s.slice(5, 7) : ""; }
var RE_TQ = /thông quan|giải phóng|mang hàng về/i;

/* 1) Tự theo dõi tờ khai các lô "Chờ thông quan" */
function theoDoiToKhai() {
  var gio = Number(Utilities.formatDate(new Date(), TZ, "H"));
  if (gio < 7 || gio >= 19) return { ok: true, msg: "Ngoài giờ" };
  var owner = chuSo(), tv = thanhVien(), kq = [];
  docHet("jobs").filter(function (j) { return j.status === "Chờ thông quan"; }).forEach(function (j) {
    var tk = String(j.tkNo || "").replace(/\D/g, ""), mst = String(j.mst || "").replace(/[^\d-]/g, ""), hq = String(j.hqCode || "").toUpperCase().trim();
    var d = String(j.tkDate || ""), m = d.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/); if (m) d = m[3] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[1]).slice(-2);
    if (tk.length !== 12 || !mst || hq.length !== 4 || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    var o; try { o = JSON.parse(UrlFetchApp.fetch(TK_URL + "?" + ["mst=" + mst, "hq=" + hq, "tk=" + tk, "date=" + d].join("&"), { muteHttpExceptions: true, followRedirects: true }).getContentText()); } catch (e) { return; }
    var cu = j.tkCheck || {}, thongQuan = o.ok && RE_TQ.test(o.status || "");
    var moi = o.ok ? { at: Date.now(), q: tk, ok: true, mv: !!o.mv, status: o.status || "", lane: o.lane || "", kind: o.kind || "", tkNo: o.tkNo || "", url: o.url || "", auto: true }
                   : { at: Date.now(), q: tk, ok: false, msg: o.msg || "", auto: true };
    var up = { tkCheck: moi }; if (o.ok && ["Xanh", "Vàng", "Đỏ"].indexOf(o.lane) >= 0 && !j.lane) up.lane = o.lane;
    vaFs("jobs/" + j._id, up);
    var daBao = cu.ok && RE_TQ.test(cu.status || "");
    if (thongQuan && !daBao) {
      var w = String(j.assignee || j.createdBy || "").toLowerCase();
      ghiTraoDoi(j, "✅ Tờ khai đã " + String(o.status || "thông quan").toLowerCase() + (o.lane ? " (luồng " + o.lane + ")" : "") + ": lấy mã vạch, điều xe hoặc làm bảng kê." + (w ? " @" + (j.assigneeName || j.createdByName || w.split("@")[0]) : ""), w);
      var n = guiToi([owner, w].filter(function (x, i, s) { return x && s.indexOf(x) === i && (x === owner || nguoiThayJob(j, owner, tv).indexOf(x) >= 0); }), "✅ " + (j.code || "") + " đã " + String(o.status || "thông quan").toLowerCase(),
        (j.title ? String(j.title).slice(0, 60) + "\n" : "") + (o.lane ? "Luồng " + o.lane + " · " : "") + "Bấm để mở job, lấy mã vạch và chuyển bước.",
        { job: j._id }, APP + "?job=" + encodeURIComponent(j._id), "tk-" + j._id);
      kq.push(j.code + ": báo " + n);
    } else kq.push(j.code + ": " + (o.ok ? o.status : o.msg));
  });
  Logger.log(kq.join(" | ") || "Không có lô nào chờ thông quan đủ thông tin"); return { ok: true, kq: kq };
}

/* 2) Nhắc việc 8h sáng: chủ sổ nhận tổng hợp Sổ chung; nhân viên nhận các lô do mình tạo */
function nhacViecSang() {
  var owner = chuSo(), tv = thanhVien(), today = homNay();
  var mo = docHet("jobs").filter(function (j) { return j.status !== "Hoàn thành" && j.status !== "Thất bại" && !laViecRieng(j, owner); });
  var nguoi = [owner].concat(tv).filter(function (x, i, s) { return x && s.indexOf(x) === i; }), kq = [];
  var han15 = Utilities.formatDate(new Date(Date.now() - 15 * 864e5), TZ, "yyyy-MM-dd");
  var docNo = docHet("jobs").filter(function (j) { return j.debitDate && !j.paidDate && j.debitDate <= han15 && !laViecRieng(j, owner); });
  nguoi.forEach(function (mail) {
    var cua = mo.filter(function (j) { return mail === owner || String(j.assignee || j.createdBy || "").toLowerCase() === mail; });
    var hn = cua.filter(function (j) { return j.deadline === today; });
    var qh = cua.filter(function (j) { return j.deadline && j.deadline < today && !(j.odAck && j.odAck.deadline === j.deadline && !j.odAck.rejected); });
    var no = mail === owner ? docNo : [];
    if (!hn.length && !qh.length && !no.length) return;
    var dong = [];
    if (no.length) dong.push("Công nợ quá 15 ngày: " + no.slice(0, 5).map(function (j) { return j.code + " (gửi " + dm(j.debitDate) + ")"; }).join(", ") + (no.length > 5 ? "…" : ""));
    if (hn.length) dong.push("Đến hạn hôm nay: " + hn.slice(0, 5).map(function (j) { return j.code; }).join(", ") + (hn.length > 5 ? "…" : ""));
    if (qh.length) dong.push("Quá hạn chưa ghi lý do: " + qh.slice(0, 5).map(function (j) { return j.code + " (hạn " + dm(j.deadline) + ")"; }).join(", ") + (qh.length > 5 ? "…" : ""));
    var n = guiToi([mail], "☀ Nhắc việc: " + hn.length + " lô đến hạn, " + qh.length + " lô quá hạn" + (no.length ? ", " + no.length + " lô nợ lâu" : ""), dong.join("\n"), { view: "today" }, APP + "?view=today", "nhac-sang");
    kq.push(mail.slice(0, 3) + "…: " + n);
  });
  Logger.log(kq.join(" | ") || "Không có gì cần nhắc"); return { ok: true, kq: kq };
}

/* 3) Sao lưu mỗi đêm vào Google Drive (cùng định dạng file "Sao lưu" trong app nên khôi phục được) */
function saoLuuDem() {
  var docs = [];
  ["jobs", "meta", "partners", "todos", "members", "mypartners", "teamchat"].forEach(function (col) {
    docHet(col).forEach(function (o) {
      var id = o._id; delete o._id; docs.push({ path: col + "/" + id, data: o });
      if (col === "jobs") docHet("jobs/" + id + "/chat").forEach(function (x) { var mid = x._id; delete x._id; docs.push({ path: "jobs/" + id + "/chat/" + mid, data: x }); });
    });
  });
  var it = DriveApp.getFoldersByName("So Job - Sao luu"), folder = it.hasNext() ? it.next() : DriveApp.createFolder("So Job - Sao luu");
  var ten = "so-job-" + Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd") + ".json";
  folder.createFile(ten, JSON.stringify({ app: "so-job", version: 1, exportedAt: new Date().toISOString(), docs: docs }), "application/json");
  var files = [], fi = folder.getFiles(); while (fi.hasNext()) files.push(fi.next());
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); }).slice(30).forEach(function (f) { f.setTrashed(true); });
  Logger.log("Đã sao lưu " + docs.length + " mục vào " + ten); return { ok: true, n: docs.length };
}

/* =====================================================================
 * AI MIỄN PHÍ (Google Gemini). Key lấy ở aistudio.google.com → Get API key,
 * dán vào: Cài đặt dự án → Thuộc tính tập lệnh → GEMINI_KEY (không để key trong code).
 * Chỉ thành viên sổ gọi được (kiểm tra mã đăng nhập Firebase). Có thể đổi mô hình bằng thuộc tính AI_MODEL.
 * ===================================================================== */
var FB_WEB_KEY = "AIzaSyCU35XKhtdlNKOMOauoe6q19tiFis87qqI"; // khoá web Firebase (công khai, giống trong firebase-config.js)
function nguoiGoi(token) {
  if (!token) return "";
  var r = UrlFetchApp.fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + FB_WEB_KEY, { method: "post", contentType: "application/json", payload: JSON.stringify({ idToken: token }), muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) return "";
  var u = (JSON.parse(r.getContentText()).users || [])[0];
  return u && u.emailVerified !== false ? String(u.email || "").toLowerCase() : "";
}
function goiAI(ai, token) {
  var mail = nguoiGoi(token);
  if (!mail) return { ok: false, code: "sampling_disabled", msg: "Hết phiên đăng nhập, tải lại trang rồi thử lại." };
  if (mail !== chuSo() && !docFs("members/" + encodeURIComponent(mail))) return { ok: false, code: "sampling_disabled", msg: "Tài khoản này chưa là thành viên sổ." };
  var P = PropertiesService.getScriptProperties(), key = P.getProperty("GEMINI_KEY");
  if (!key) return { ok: false, code: "sampling_disabled", msg: "Chưa cài AI miễn phí: chủ sổ cần dán key Gemini vào máy chủ (GEMINI_KEY)." };
  var parts = [{ text: String(ai.prompt || "").slice(0, 200000) }];
  (ai.files || []).slice(0, 8).forEach(function (f) { if (f && f.data) parts.push({ inline_data: { mime_type: f.mime || "image/jpeg", data: f.data } }); });
  var body = { contents: [{ role: "user", parts: parts }], generationConfig: { temperature: 0.2, maxOutputTokens: 8192 } };
  if (ai.json) body.generationConfig.responseMimeType = "application/json";
  var models = [P.getProperty("AI_MODEL"), "gemini-flash-lite-latest", "gemini-3.8-flash", "gemini-flash-latest"] // Lite nhanh, ít bị quá tải; lỗi thì thử bản Flash.filter(function (x, i, a) { return x && a.indexOf(x) === i; });
  var last = "";
  for (var i = 0; i < models.length; i++) {
    var r = UrlFetchApp.fetch("https://generativelanguage.googleapis.com/v1beta/models/" + models[i] + ":generateContent", { method: "post", contentType: "application/json", headers: { "x-goog-api-key": key }, payload: JSON.stringify(body), muteHttpExceptions: true });
    var c = r.getResponseCode(), j = {}; try { j = JSON.parse(r.getContentText()); } catch (e) {}
    if (c === 404 || c === 403) { last = (c === 404 ? "không có mô hình " : "không có quyền dùng ") + models[i]; continue; }
    if (c === 503 || c === 500) { last = models[i] + " đang quá tải"; continue; }
    if (c === 429) return { ok: false, code: "rate_limited", msg: "AI miễn phí đã dùng hết lượt trong phút / ngày. Thử lại sau ít phút." };
    if (c === 400) return { ok: false, code: "invalid_request", msg: "AI không nhận yêu cầu: " + ((j.error && j.error.message) || c) };
    if (c !== 200) { last = "lỗi " + c; continue; }
    var cand = (j.candidates || [])[0] || {}, text = ((cand.content && cand.content.parts) || []).map(function (p) { return p.text || ""; }).join("");
    if (!text.trim()) return { ok: false, code: "empty_completion", msg: "AI không trả về nội dung (có thể bị chặn vì nội dung nhạy cảm)." };
    return { ok: true, text: text, truncated: cand.finishReason === "MAX_TOKENS", model: models[i] };
  }
  return { ok: false, code: "upstream_error", msg: "AI chưa trả lời được (" + last + "). Thử lại sau." };
}

/* Ghi 1 tin tự động vào Trao đổi của job (và Chat chung nếu job ở Sổ chung) */
function ghiTraoDoi(j, text, tagMail) {
  var msg = { text: text, by: "tu-dong", byName: "🤖 Tự động", at: Date.now(), auto: true };
  if (tagMail) { msg.tags = [tagMail]; msg.tagN = [j.assigneeName || j.createdByName || tagMail.split("@")[0]]; }
  var f = {}; for (var k in msg) f[k] = veFs(msg[k]);
  goi(FS + "/jobs/" + j._id + "/chat", { method: "post", payload: { fields: f } });
  vaFs("jobs/" + j._id, { chatAt: msg.at, chatBy: msg.by, chatByName: msg.byName, chatLast: text.slice(0, 80), chatN: (Number(j.chatN) || 0) + 1 });
  if (j.shared) { var t = JSON.parse(JSON.stringify(msg)); t.job = { id: j._id, code: j.code || "", label: String(j.company || j.title || "").slice(0, 32) }; t.from = "job";
    var f2 = {}; for (var k2 in t) f2[k2] = veFs(t[k2]); goi(FS + "/teamchat", { method: "post", payload: { fields: f2 } }); }
}

/* Chẩn đoán AI (chạy tay trong trình soạn): ghi mã lỗi từng cách gọi, không in key */
function chanDoanAI() {
  var key = PropertiesService.getScriptProperties().getProperty("GEMINI_KEY") || "";
  Logger.log("Key: " + (key ? key.length + " ký tự, bắt đầu " + key.slice(0, 3) : "chưa có"));
  var base = "https://generativelanguage.googleapis.com/v1beta/models";
  var t = function (nm, url, opt) { var r = UrlFetchApp.fetch(url, Object.assign({ muteHttpExceptions: true }, opt || {})); Logger.log(nm + ": " + r.getResponseCode() + " " + r.getContentText().slice(0, 220).replace(/\s+/g, " ")); };
  t("models header", base, { headers: { "x-goog-api-key": key } });
  t("models ?key", base + "?key=" + encodeURIComponent(key));
  var body = JSON.stringify({ contents: [{ parts: [{ text: "OK" }] }] });
  ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"].forEach(function (m) {
    t(m + " header", base + "/" + m + ":generateContent", { method: "post", contentType: "application/json", headers: { "x-goog-api-key": key }, payload: body });
  });
  t("bearer", base, { headers: { Authorization: "Bearer " + key } });
}

/* Đo thời gian gọi từng mô hình Gemini (chạy tay) */
function doTocDoAI() {
  var key = PropertiesService.getScriptProperties().getProperty("GEMINI_KEY") || "";
  var base = "https://generativelanguage.googleapis.com/v1beta/models/";
  [["gemini-3.8-flash", {}], ["gemini-3.8-flash", { thinkingConfig: { thinkingLevel: "low" } }], ["gemini-flash-lite-latest", {}]].forEach(function (x) {
    var t0 = Date.now();
    var r = UrlFetchApp.fetch(base + x[0] + ":generateContent", { method: "post", contentType: "application/json", headers: { "x-goog-api-key": key }, muteHttpExceptions: true,
      payload: JSON.stringify({ contents: [{ parts: [{ text: "Trả lời đúng chữ: OK" }] }], generationConfig: Object.assign({ maxOutputTokens: 200 }, x[1]) }) });
    Logger.log(x[0] + " " + JSON.stringify(x[1]) + ": " + r.getResponseCode() + " sau " + (Date.now() - t0) + "ms · " + r.getContentText().slice(0, 160).replace(/\s+/g, " "));
  });
}

/* 4) Hẹn giờ nhắc từng job (10 phút/lần): gửi lên điện thoại người đặt nhắc. Việc riêng: không ghi nội dung. */
function nhacHen() {
  var owner = chuSo(), now = Date.now(), kq = [];
  docHet("jobs").forEach(function (j) {
    var R = j.reminders || [], doi = false;
    R.forEach(function (r) {
      if (!r || r.sent || !r.at || r.at > now || !r.by) return;
      var rieng = laViecRieng(j, owner);
      var n = guiToi([String(r.by).toLowerCase()], "⏰ " + (rieng ? "Nhắc việc riêng" : (j.code || "") + " · nhắc việc"), rieng ? "Mở app để xem lời nhắc." : (r.note || j.title || "Đến giờ nhắc"), { job: j._id }, APP + "?job=" + encodeURIComponent(j._id), "rem-" + r.id);
      r.sent = true; r.sentBy = "server"; doi = true; kq.push((j.code || j._id) + ": " + n);
    });
    if (doi) vaFs("jobs/" + j._id, { reminders: R });
  });
  if (kq.length) Logger.log(kq.join(" | "));
  return { ok: true, kq: kq };
}

/* MỘT cửa gửi thông báo (FCM HTTP v1 → web Chrome/Firefox/Edge/Safari; app iOS sau này dùng chung).
 * Gửi tới mọi máy của 1 người; Urgency high + TTL 1 ngày để điện thoại nhận ngay;
 * máy đã gỡ app / mã hết hạn (404, UNREGISTERED, token sai) thì tự xoá khỏi danh sách. */
function guiMay(mail, n) {
  mail = String(mail || "").toLowerCase();
  var p = docFs("push/" + mail), toks = (p && p.tokens) || [], bad = [], sent = 0, loi = [];
  toks.forEach(function (t) {
    var r = goi("https://fcm.googleapis.com/v1/projects/" + PID + "/messages:send", { method: "post", payload: { message: { token: t, data: n.data || {},
      webpush: { headers: { Urgency: "high", TTL: "86400" },
        notification: { title: n.title, body: n.body || "", icon: APP + "icon-192.png", badge: APP + "icon-192.png", tag: n.tag || "sojob", renotify: true },
        fcm_options: { link: n.link || APP } } } } });
    if (r.code === 200) { sent++; return; }
    loi.push(r.code);
    var m = (r.json && r.json.error && (r.json.error.status + " " + r.json.error.message)) || r.text || "";
    if (r.code === 404 || /UNREGISTERED|registration token|Requested entity was not found/i.test(m)) bad.push(t);
  });
  if (bad.length) goi(FS + "/push/" + encodeURIComponent(mail) + "?updateMask.fieldPaths=tokens", { method: "patch", payload: { fields: { tokens: { arrayValue: { values:
    toks.filter(function (t) { return bad.indexOf(t) < 0; }).map(function (t) { return { stringValue: t }; }) } } } } });
  return { sent: sent, may: toks.length, xoa: bad.length, loi: loi };
}

/* App bấm "Thử thông báo": gửi 1 tin thử tới mọi máy của chính người bấm */
function thuMayToi(token) {
  var mail = nguoiGoi(token);
  if (!mail) return { ok: false, msg: "Hết phiên đăng nhập, tải lại trang rồi thử lại." };
  var r = guiMay(mail, { title: "✅ Thông báo đang chạy", body: "Máy này nhận được thông báo của Theo dõi làm hàng.", data: { view: "today" }, link: APP + "?view=today", tag: "thu" });
  return { ok: true, sent: r.sent, may: r.may, xoa: r.xoa, loi: r.loi };
}
