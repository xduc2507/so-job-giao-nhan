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
  if (e && e.parameter && e.parameter.zb) return zbHook(e); // tin từ Zalo Bot
  var out = { ok: false }, body = null;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    out = body.ai ? goiAI(body.ai, body.token) : body.zbcode ? zbNoi(body.token) : body.mail ? thuOp(body.mail, body.token) : body.test ? thuMayToi(body.token) : body.team ? guiChatChung() : guiThongBao(String(body.job || ""));
  } catch (err) { out = { ok: false, msg: String(err) }; }
  if (!(body && body.mail)) console.log(JSON.stringify(out));
  if (body && (body.ai || body.test || body.mail || body.zbcode)) return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON); // không ghi nhật ký nội dung AI / thử
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
 *  - theoDoiToKhai: 30 phút/lần, 7h–19h: kiểm tra các lô Đã truyền tờ khai / Trình tờ khai / Kiểm hóa; thông quan thì báo điện thoại.
 *  - nhacViecSang: 8h sáng: báo mỗi người lô đến hạn hôm nay, quá hạn chưa ghi lý do.
 *  - saoLuuDem: 23h: sao lưu toàn bộ dữ liệu vào Google Drive (thư mục "So Job - Sao luu", giữ 30 bản).
 * Việc riêng của chủ sổ không bao giờ đưa vào thông báo.
 * ===================================================================== */
var TK_URL = "https://script.google.com/macros/s/AKfycbwtQV7vcwRtQLjxpZde6wB59jGrjdrakSeUNznnYNtOKa6Wv5BaBJ2cBPcRl0DgIT_G/exec";
var TZ = "Asia/Ho_Chi_Minh";

function caiLich() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (["theoDoiToKhai", "nhacViecSang", "saoLuuDem", "nhacHen", "thuMoi"].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("theoDoiToKhai").timeBased().everyMinutes(30).create();
  ScriptApp.newTrigger("nhacViecSang").timeBased().atHour(8).nearMinute(0).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger("saoLuuDem").timeBased().atHour(23).nearMinute(0).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger("nhacHen").timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger("thuMoi").timeBased().everyMinutes(5).create();
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

/* 1) Tự theo dõi tờ khai các lô ở bước chờ hải quan (Đã truyền tờ khai / Trình tờ khai cho Hải quan / Kiểm hóa) */
function theoDoiToKhai() {
  var gio = Number(Utilities.formatDate(new Date(), TZ, "H"));
  if (gio < 7 || gio >= 19) return { ok: true, msg: "Ngoài giờ" };
  var owner = chuSo(), tv = thanhVien(), kq = [];
  docHet("jobs").filter(function (j) { return ["Đã truyền tờ khai", "Trình tờ khai cho Hải quan", "Kiểm hóa"].indexOf(j.status) >= 0; }).forEach(function (j) {
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
  var tep = folder.createFile(ten, JSON.stringify({ app: "so-job", version: 1, exportedAt: new Date().toISOString(), docs: docs }), "application/json");
  try { PropertiesService.getScriptProperties().setProperty("DB_DUNG", JSON.stringify({ at: Date.now(), n: docs.length, bytes: tep.getSize() })); } catch (e) {}
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
  return aiChay(ai);
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

/* ===== Email: hộp thư chung giaonhan@opsdad.net qua Zoho Mail API =====
 * Script Properties (anh tự dán): ZOHO_ID, ZOHO_SECRET, ZOHO_CODE (mã cấp quyền 10 phút) → chạy zhKetNoi() → lưu ZOHO_REFRESH */
function zhP() { return PropertiesService.getScriptProperties(); }

function zhKetNoi() {
  var P = zhP(), acc = P.getProperty("ZOHO_ACCOUNTS") || "https://accounts.zoho.com";
  var r = UrlFetchApp.fetch(acc + "/oauth/v2/token", { method: "post", muteHttpExceptions: true, payload: {
    grant_type: "authorization_code", client_id: P.getProperty("ZOHO_ID"), client_secret: P.getProperty("ZOHO_SECRET"), code: P.getProperty("ZOHO_CODE") } });
  var o = {}; try { o = JSON.parse(r.getContentText()); } catch (x) {}
  if (!o.refresh_token) { Logger.log("Chưa nối được Zoho: " + (o.error || r.getResponseCode())); return; }
  P.setProperty("ZOHO_REFRESH", o.refresh_token); P.deleteProperty("ZOHO_CODE"); P.deleteProperty("ZOHO_ACC");
  if (o.api_domain) P.setProperty("ZOHO_API_DOMAIN", o.api_domain);
  CacheService.getScriptCache().put("zhTok", o.access_token, 3000);
  Logger.log("Đã nối Zoho. Thử đọc hộp thư…"); zhThu();
}

function zhTok() {
  var c = CacheService.getScriptCache(), t = c.get("zhTok"); if (t) return t;
  var P = zhP(), acc = P.getProperty("ZOHO_ACCOUNTS") || "https://accounts.zoho.com";
  var r = UrlFetchApp.fetch(acc + "/oauth/v2/token", { method: "post", muteHttpExceptions: true, payload: {
    grant_type: "refresh_token", client_id: P.getProperty("ZOHO_ID"), client_secret: P.getProperty("ZOHO_SECRET"), refresh_token: P.getProperty("ZOHO_REFRESH") } });
  var o = {}; try { o = JSON.parse(r.getContentText()); } catch (x) {}
  if (!o.access_token) throw new Error("Zoho chưa cấp quyền (" + (o.error || r.getResponseCode()) + ")");
  c.put("zhTok", o.access_token, 3000); return o.access_token;
}

function zhGoi(path, opt) {
  opt = opt || {};
  opt.headers = Object.assign({ Authorization: "Zoho-oauthtoken " + zhTok() }, opt.headers || {});
  opt.muteHttpExceptions = true;
  if (opt.payload && typeof opt.payload !== "string" && !opt.raw) { opt.payload = JSON.stringify(opt.payload); opt.contentType = "application/json"; }
  var r = UrlFetchApp.fetch("https://mail.zoho.com/api" + path, opt);
  var j = {}; try { j = JSON.parse(r.getContentText().replace(/("[A-Za-z]*Id"\s*:\s*)(\d{12,})/g, '$1"$2"')); } catch (x) {} // mã Zoho dài hơn 2^53: giữ dạng chữ
  return { code: r.getResponseCode(), json: j, text: r.getContentText().slice(0, 300), blob: opt.blob ? r.getBlob() : null };
}

function zhAcc() { // mã hộp thư + mã thư mục (lưu lại)
  var P = zhP(), s = P.getProperty("ZOHO_ACC"); if (s) return JSON.parse(s);
  var a = zhGoi("/accounts"); var ac = ((a.json && a.json.data) || [])[0];
  if (!ac) throw new Error("Không đọc được hộp thư Zoho (" + a.code + " " + a.text + ")");
  var f = zhGoi("/accounts/" + ac.accountId + "/folders"), F = {};
  ((f.json && f.json.data) || []).forEach(function (x) { var k = String(x.folderType || x.folderName).toLowerCase(); if (!F[k] || String(x.path || "").toLowerCase() === "/" + k) F[k] = x.folderId; });
  var o = { id: ac.accountId, mail: ac.primaryEmailAddress || ac.mailboxAddress || "", F: F };
  P.setProperty("ZOHO_ACC", JSON.stringify(o)); return o;
}

function zhThu() {
  var A = zhAcc(); Logger.log("Hộp thư: " + A.mail + " · thư mục: " + Object.keys(A.F).join(", "));
  var r = zhGoi("/accounts/" + A.id + "/messages/view?folderId=" + A.F.inbox + "&limit=5");
  Logger.log("Đọc Inbox: HTTP " + r.code + " · " + (((r.json && r.json.data) || []).map(function (m) { return m.subject; }).join(" | ") || r.text));
}

function zhXem() { // xem thô vài trường của thư (để dò tên trường)
  zhP().deleteProperty("ZOHO_ACC"); var A = zhAcc(); Logger.log(JSON.stringify(A.F)); var r = zhGoi("/accounts/" + A.id + "/messages/view?folderId=" + A.F.inbox + "&limit=3&includeto=true");
  ((r.json && r.json.data) || []).forEach(function (m) { var o = {}; Object.keys(m).forEach(function (k) { o[k] = String(m[k]).slice(0, 40); }); Logger.log(JSON.stringify(o)); });
}

function zhMsg(m) { // rút gọn 1 thư cho app
  return { id: String(m.messageId), f: String(m.folderId || ""), s: m.subject || "(không tiêu đề)", sum: String(m.summary || "").slice(0, 160),
    from: m.fromAddress || "", fromN: m.sender || "", to: String(m.toAddress || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, ""), t: Number(m.receivedTime || m.sentDateInGMT || 0),
    read: String(m.status) === "1", att: String(m.hasAttachment) === "1", th: String(m.threadId || "") };
}

/* App gọi mục Email: {mail:{op,...}, token}. Chỉ chủ sổ + thành viên. */
function thuOp(q, token) {
  var who = nguoiGoi(token);
  if (!who) return { ok: false, msg: "Hết phiên đăng nhập, tải lại trang rồi thử lại." };
  var owner = chuSo();
  if (who !== owner && !docFs("members/" + encodeURIComponent(who))) return { ok: false, msg: "Tài khoản này chưa là thành viên sổ." };
  if (!zhP().getProperty("ZOHO_REFRESH")) return { ok: false, msg: "Chủ sổ chưa nối hộp thư Zoho với máy chủ." };
  var A = zhAcc(), B = "/accounts/" + A.id, op = q.op;
  if (op === "dung") return dungLuong(who === owner, B);
  if (op === "list") {
    var lim = Math.min(Number(q.limit) || 40, 100), st = Number(q.start) || 1, r;
    if (q.q) r = zhGoi(B + "/messages/search?searchKey=" + encodeURIComponent("entire:" + String(q.q).slice(0, 80)) + "&start=" + st + "&limit=" + lim + "&includeto=true");
    else r = zhGoi(B + "/messages/view?folderId=" + (A.F[q.folder || "inbox"] || A.F.inbox) + "&start=" + st + "&limit=" + lim + "&includeto=true");
    if (r.code !== 200) return { ok: false, msg: "Zoho chưa trả danh sách thư (" + r.code + ")" };
    return { ok: true, mail: A.mail, list: ((r.json && r.json.data) || []).map(zhMsg) };
  }
  var id = String(q.id || "").replace(/\D/g, ""), f = String(q.f || "").replace(/\D/g, "");
  if (op === "read") {
    if (!id || !f) return { ok: false, msg: "Thiếu mã thư" };
    var P = B + "/folders/" + f + "/messages/" + id;
    var c = zhGoi(P + "/content?includeBlockContent=true"), d = zhGoi(P + "/details"), a = zhGoi(P + "/attachmentinfo");
    if (c.code !== 200) return { ok: false, msg: "Không mở được thư (" + c.code + ")" };
    if (q.mark !== false) zhGoi(B + "/updatemessage", { method: "put", payload: { mode: "markAsRead", messageId: [id] } });
    var D = (d.json && d.json.data) || {};
    var att = (((a.json && a.json.data) || {}).attachments || []).map(function (x) { return { id: String(x.attachmentId), n: x.attachmentName, sz: Number(x.attachmentSize) || 0 }; });
    return { ok: true, html: ((c.json && c.json.data) || {}).content || "", from: D.fromAddress || "", fromN: D.sender || "", to: D.toAddress || "", cc: D.ccAddress || "", s: D.subject || "", t: Number(D.receivedTime || D.sentDateInGMT || 0), att: att };
  }
  if (op === "att") {
    var r2 = zhGoi(B + "/folders/" + f + "/messages/" + id + "/attachments/" + String(q.aid || "").replace(/\D/g, ""), { blob: true });
    if (r2.code !== 200 || !r2.blob) return { ok: false, msg: "Không tải được tệp (" + r2.code + ")" };
    if (r2.blob.getBytes().length > 15e6) return { ok: false, msg: "Tệp quá lớn để tải qua Sổ, mở Zoho Mail để tải." };
    return { ok: true, b64: Utilities.base64Encode(r2.blob.getBytes()), type: r2.blob.getContentType() || "application/octet-stream" };
  }
  if (op === "send") {
    var to = String(q.to || "").trim(), sub = String(q.s || "").slice(0, 300);
    if (!to) return { ok: false, msg: "Chưa có người nhận" };
    var ten = q.byName || who.split("@")[0];
    var body = String(q.html || "").slice(0, 200000) + '<br><div style="color:#666;font-size:12px">— ' + String(ten).replace(/[<>&]/g, "") + " · Giao nhận FDI · " + A.mail + "</div>";
    var pl = { fromAddress: A.mail, toAddress: to, subject: sub, content: body, mailFormat: "html", askReceipt: "no" };
    if (q.cc) pl.ccAddress = String(q.cc);
    var files = (q.files || []).slice(0, 10), up = [];
    for (var i = 0; i < files.length; i++) {
      var fl = files[i]; if (!fl || !fl.b64) continue;
      var u = zhGoi(B + "/messages/attachments?fileName=" + encodeURIComponent(fl.n || "tep"), { method: "post", raw: true, contentType: "application/octet-stream", payload: Utilities.base64Decode(fl.b64) });
      var ud = u.json && u.json.data; ud = Array.isArray(ud) ? ud[0] : ud;
      if (u.code !== 200 || !ud) return { ok: false, msg: "Không đính kèm được " + (fl.n || "tệp") + " (" + u.code + ")" };
      up.push({ storeName: ud.storeName, attachmentPath: ud.attachmentPath, attachmentName: ud.attachmentName });
    }
    if (up.length) pl.attachments = up;
    var rs;
    if (q.reply && id) { pl.action = q.action === "forward" ? "forward" : "reply"; rs = zhGoi(B + "/messages/" + id, { method: "post", payload: pl }); }
    else rs = zhGoi(B + "/messages", { method: "post", payload: pl });
    if (rs.code !== 200) return { ok: false, msg: "Zoho chưa gửi được (" + rs.code + " " + ((rs.json && rs.json.data && (rs.json.data.moreInfo || rs.json.data.errorCode)) || "") + ")" };
    if (q.job) { var j = docFs("jobs/" + String(q.job).replace(/[^A-Za-z0-9_-]/g, "")); if (j && j.shared) { j._id = String(q.job); ghiTraoDoi(j, "✉ " + ten + " đã gửi email tới " + to + ": " + sub); } }
    return { ok: true };
  }
  return { ok: false, msg: "Không rõ yêu cầu" };
}

/* Cứ 5 phút: thư mới đến giaonhan → báo cả nhóm; tiêu đề có mã job (FDI…) → ghi vào Trao đổi của job;
 * thư khác → AI đọc: yêu cầu làm hàng mới → "job chờ duyệt" (mailjobs) để nhóm bấm tạo; thư về lô đang làm → ghi vào Trao đổi của lô đó. Chỉ job ở Sổ chung. */
function thuMoi() {
  var P = zhP(); if (!P.getProperty("ZOHO_REFRESH")) return;
  var A = zhAcc(), r = zhGoi("/accounts/" + A.id + "/messages/view?folderId=" + A.F.inbox + "&limit=20");
  if (r.code !== 200) { Logger.log("thuMoi: " + r.code); return; }
  var last = Number(P.getProperty("ZOHO_LAST") || 0), L = ((r.json && r.json.data) || []).map(zhMsg).filter(function (m) { return m.t > last; }).sort(function (a, b) { return a.t - b.t; });
  if (!last) { P.setProperty("ZOHO_LAST", String(Math.max.apply(null, [Date.now()].concat(L.map(function (m) { return m.t; }))))); return; }
  if (!L.length) return;
  P.setProperty("ZOHO_LAST", String(L[L.length - 1].t));
  var owner = chuSo(), nguoi = [owner].concat(thanhVien()).filter(function (x, i, a) { return x && a.indexOf(x) === i; });
  var jobs = null, kq = [];
  L.forEach(function (m) {
    if (String(m.from).toLowerCase() === String(A.mail).toLowerCase()) return;
    jobs = jobs || docHet("jobs").filter(function (x) { return x.shared && x.status !== "Hoàn thành" && x.status !== "Thất bại"; });
    var code = (String(m.s).match(/FDI\d{6}-\d+/i) || [])[0];
    var j = code ? jobs.filter(function (x) { return String(x.code || "").toUpperCase() === code.toUpperCase(); })[0] : null;
    if (j) { ganThu(m, j); ghiTraoDoi(j, "✉ Email mới từ " + (m.fromN || m.from) + ": " + m.s); guiToi(nguoi, "✉ " + (m.fromN || m.from) + " · " + j.code, m.s, { job: j._id }, APP + "?job=" + encodeURIComponent(j._id), "mail"); kq.push(m.s + " → " + j.code); return; }
    var o = null; try { o = thuDocAI(m, A, jobs); } catch (e) { Logger.log("AI lỗi: " + e); }
    if (o && o.loai === "cu") {
      var mc = String(o.maJob || "").toUpperCase();
      j = jobs.filter(function (x) { return String(x.code || "").toUpperCase() === mc; })[0];
      if (!j && o.bl) j = jobs.filter(function (x) { return x.bl && String(x.bl).replace(/\W/g, "").toUpperCase() === String(o.bl).replace(/\W/g, "").toUpperCase(); })[0];
      if (j) { ganThu(m, j); ghiTraoDoi(j, "✉ Email từ " + (m.fromN || m.from) + ": " + m.s + (o.tomTat ? "\n" + o.tomTat : "")); guiToi(nguoi, "✉ " + (m.fromN || m.from) + " · " + j.code, m.s, { job: j._id }, APP + "?job=" + encodeURIComponent(j._id), "mail"); kq.push(m.s + " → " + j.code + " (AI)"); return; }
    }
    if (o && o.loai === "moi") {
      var doc = { at: Date.now(), status: "cho", mid: m.id, f: m.f, from: m.from, fromN: m.fromN || "", s: m.s, t: m.t,
        ai: { tieuDe: o.tieuDe || "", congTy: o.congTy || "", fwd: o.fwd || "", dichVu: o.dichVu || "", hang: o.hang || "", bl: o.bl || "", cont: o.cont || "", tkNo: String(o.tkNo || "").replace(/\D/g, "").slice(0, 12), mst: o.mst || "", hangHoa: o.hangHoa || "", han: o.han || "", lienHe: o.lienHe || "", tomTat: o.tomTat || "" } };
      var f = {}; for (var k in doc) f[k] = veFs(doc[k]);
      goi(FS + "/mailjobs?documentId=" + encodeURIComponent("m" + m.id), { method: "post", payload: { fields: f } });
      guiToi(nguoi, "📨 Job mới từ email · chờ duyệt", (o.tieuDe || m.s) + "\nTừ " + (m.fromN || m.from), { view: "mail" }, APP + "?view=mail", "mailjob");
      kq.push(m.s + " → chờ duyệt"); return;
    }
    guiToi(nguoi, "✉ " + (m.fromN || m.from) + " · Email", m.s + (m.sum ? "\n" + m.sum.slice(0, 120) : ""), { view: "mail" }, APP + "?view=mail", "mail");
    kq.push(m.s + " → " + (o ? o.loai : "AI không đọc được"));
  });
  Logger.log("thuMoi: " + kq.join(" | "));
}
/* Dung lượng: hộp thư Zoho (KB đã dùng / KB được dùng) cho mọi thành viên; dữ liệu Sổ (ước tính) chỉ cho chủ sổ */
function dungLuong(laChu, B) {
  var o = { ok: true }, r = zhGoi(B), d = (r.json && r.json.data) || {};
  if (Array.isArray(d)) d = d[0] || {};
  if (r.code === 200) o.mail = { used: Number(d.usedStorage) || 0, total: Number(d.allowedStorage) || 0 };
  if (laChu) {
    var P = PropertiesService.getScriptProperties(), db = null;
    try { db = JSON.parse(P.getProperty("DB_DUNG") || "null"); } catch (e) {}
    if (!db) { db = uocDb(); P.setProperty("DB_DUNG", JSON.stringify(db)); }
    db.total = 1073741824; o.db = db;
  }
  return o;
}
/* Ước tính dung lượng dữ liệu Sổ trên Firestore (đọc hết các bộ sưu tập; dùng khi chưa có số từ bản sao lưu đêm) */
function uocDb() {
  var n = 0, b = 0, cong = function (x) { n++; b += Utilities.newBlob(JSON.stringify(x)).getBytes().length + 40; };
  ["jobs", "meta", "partners", "todos", "members", "mypartners", "teamchat", "teamseen", "mailjobs", "push"].forEach(function (col) {
    docHet(col).forEach(function (o) { cong(o); if (col === "jobs") ["chat", "seen"].forEach(function (s) { docHet("jobs/" + o._id + "/" + s).forEach(cong); }); });
  });
  return { at: Date.now(), n: n, bytes: b };
}
/* Ghi thư nào thuộc job nào (mailjobs, status "gan") để tab Email trong app hiện mã job, bấm mở job */
function ganThu(m, j) {
  var doc = { at: Date.now(), status: "gan", mid: m.id, f: m.f, from: m.from, fromN: m.fromN || "", s: m.s, t: m.t, jobId: j._id, code: j.code || "" };
  var f = {}; for (var k in doc) f[k] = veFs(doc[k]);
  try { goi(FS + "/mailjobs?documentId=" + encodeURIComponent("m" + m.id), { method: "post", payload: { fields: f } }); } catch (e) { Logger.log("ganThu: " + e); }
}
/* Gọi Gemini (dùng chung cho app và máy chủ): Lite trước vì nhanh, ít quá tải; lỗi thì thử bản Flash */
function aiChay(ai) {
  var P = PropertiesService.getScriptProperties(), key = P.getProperty("GEMINI_KEY");
  if (!key) return { ok: false, code: "sampling_disabled", msg: "Chưa cài AI miễn phí: chủ sổ cần dán key Gemini vào máy chủ (GEMINI_KEY)." };
  var parts = [{ text: String(ai.prompt || "").slice(0, 200000) }];
  (ai.files || []).slice(0, 8).forEach(function (f) { if (f && f.data) parts.push({ inline_data: { mime_type: f.mime || "image/jpeg", data: f.data } }); });
  var body = { contents: [{ role: "user", parts: parts }], generationConfig: { temperature: 0.2, maxOutputTokens: 8192 } };
  if (ai.json) body.generationConfig.responseMimeType = "application/json";
  var models = [P.getProperty("AI_MODEL"), "gemini-flash-lite-latest", "gemini-3.8-flash", "gemini-flash-latest"].filter(function (x, i, a) { return x && a.indexOf(x) === i; });
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

/* AI đọc 1 thư mới: yêu cầu làm hàng mới / thư về lô đang làm / thư khác. Trả về đối tượng JSON hoặc null */
function thuDocAI(m, A, jobs) {
  var B = "/accounts/" + A.id + "/folders/" + m.f + "/messages/" + m.id;
  var c = zhGoi(B + "/content"), html = ((c.json && c.json.data) || {}).content || "";
  var text = String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>|<\/(p|div|tr|li)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, 6000);
  var files = [];
  if (m.att) {
    var a = zhGoi(B + "/attachmentinfo");
    (((a.json && a.json.data) || {}).attachments || []).filter(function (x) { return /\.(pdf|jpe?g|png)$/i.test(x.attachmentName || "") && Number(x.attachmentSize || 0) < 4e6; }).slice(0, 3).forEach(function (x) {
      var d = zhGoi(B + "/attachments/" + x.attachmentId, { blob: true });
      if (d.code === 200 && d.blob) files.push({ mime: /\.pdf$/i.test(x.attachmentName) ? "application/pdf" : /\.png$/i.test(x.attachmentName) ? "image/png" : "image/jpeg", data: Utilities.base64Encode(d.blob.getBytes()) });
    });
  }
  var ds = jobs.slice(0, 80).map(function (j) { return [j.code, j.company || "", j.fwd || "", j.bl || "", j.cont || "", j.tkNo || ""].join(" | "); }).join("\n");
  var prompt = "Bạn là trợ lý bộ phận giao nhận (khai hải quan, vận chuyển container) của công ty FDI tại Việt Nam. Đọc email gửi tới hộp thư giaonhan@opsdad.net (kèm tệp đính kèm nếu có) và trả về DUY NHẤT một JSON.\n" +
    "Phân loại \"loai\":\n- \"moi\": khách / đại lý (FWD) nhờ làm một lô hàng MỚI (khai báo hải quan, làm thủ tục, vận chuyển, lấy D/O…) chưa có trong danh sách job đang làm.\n- \"cu\": email nói về một lô ĐÃ có trong danh sách job đang làm (trùng số B/L, số cont, số tờ khai, công ty + nội dung). Ghi \"maJob\" là mã job đó.\n- \"khac\": báo giá, quảng cáo, thông báo hệ thống, thư cảm ơn, thư không cần tạo việc.\n" +
    "Các trường (để chuỗi rỗng nếu không có): loai, maJob, tieuDe (ngắn gọn, VD \"Khai nhập 2x40 máy móc - Cty A\"), congTy (chủ hàng), fwd (đại lý giao nhận / forwarder gửi yêu cầu), dichVu (\"HQ\" nếu chỉ khai hải quan, \"VC\" nếu chỉ vận chuyển, \"HQ+VC\" nếu cả hai, rỗng nếu không rõ), hang (\"Nhập khẩu\" hoặc \"Xuất khẩu\"), bl, cont (số lượng + loại hoặc số cont), tkNo (12 chữ số), mst, hangHoa, han (hạn xử lý dạng YYYY-MM-DD nếu email có nêu), lienHe (tên + số điện thoại người liên hệ), tomTat (1-3 câu tiếng Việt: khách cần làm gì, còn thiếu gì).\n" +
    "Danh sách job đang làm (mã | công ty | FWD | B/L | cont | tờ khai):\n" + (ds || "(trống)") + "\n\n" +
    "EMAIL\nTừ: " + (m.fromN || "") + " <" + m.from + ">\nTiêu đề: " + m.s + "\nNội dung:\n" + text;
  var r = aiChay({ prompt: prompt, files: files, json: true });
  if (!r.ok) { Logger.log("thuDocAI: " + r.msg); return null; }
  try { var o = JSON.parse(String(r.text).replace(/^\s*\x60+(json)?|\x60+\s*$/g, "").trim()); return Array.isArray(o) ? o[0] : o; } catch (e) { Logger.log("thuDocAI JSON lỗi"); return null; }
}

function thuThuAI() { // chạy tay: cho AI đọc lại thư mới nhất trong Inbox (không tạo gì), xem kết quả phân loại
  var A = zhAcc(), r = zhGoi("/accounts/" + A.id + "/messages/view?folderId=" + A.F.inbox + "&limit=1");
  var m = ((r.json && r.json.data) || []).map(zhMsg)[0]; if (!m) return Logger.log("Inbox trống");
  var jobs = docHet("jobs").filter(function (x) { return x.shared && x.status !== "Hoàn thành" && x.status !== "Thất bại"; });
  Logger.log(m.s + " → " + JSON.stringify(thuDocAI(m, A, jobs)));
}

/* =====================================================================
 * ZALO BOT (bot-api.zaloplatforms.com). Mã bot lưu ở Script Properties: ZALO_BOT_TOKEN (chủ sổ tự dán, không ghi ra nhật ký).
 * ===================================================================== */
function zbGoi(method, body) {
  var tok = PropertiesService.getScriptProperties().getProperty("ZALO_BOT_TOKEN");
  if (!tok) throw new Error("Chưa có ZALO_BOT_TOKEN trong Thuộc tính tập lệnh");
  var r = UrlFetchApp.fetch("https://bot-api.zaloplatforms.com/bot" + tok + "/" + method,
    { method: "post", contentType: "application/json", payload: JSON.stringify(body || {}), muteHttpExceptions: true });
  var t = r.getContentText(), j; try { j = JSON.parse(t); } catch (e) { j = { raw: t.slice(0, 300) }; }
  return { code: r.getResponseCode(), json: j };
}
/* ---------- Zalo Bot: gom tin của từng người; nhắn "tạo job" thì AI đọc hết các tin đã gom rồi tạo job (Mới nhận, Sổ chung) ----------
 * Lệnh (không phân biệt dấu / hoa thường): nối 123456 · tạo job · gắn FDI261125-05 · xem · xoá · hd
 * Người dùng phải nối Zalo với tài khoản Sổ bằng mã 6 số lấy trong app (Cài đặt → Nối Zalo). Người lạ nhắn bot sẽ không làm gì được. */
var ZB_HD = "Cách dùng:\n• Gửi hoặc chuyển tiếp thông tin, ảnh của lô cho bot, bot gom lại.\n• Nhắn \"tạo job\" → AI đọc các tin đã gom và tạo job ở cột Mới nhận.\n• Nhắn \"gắn FDI…\" → ghi các tin đã gom vào Trao đổi của job đó.\n• \"xem\": xem đã gom gì · \"xoá\": bỏ các tin đã gom.";
function zbHook(e) {
  var P = PropertiesService.getScriptProperties(), s = P.getProperty("ZB_SECRET"), ok = ContentService.createTextOutput("ok");
  if (!s || String(e.parameter.zb) !== s) return ContentService.createTextOutput("no");
  var b = {}; try { b = JSON.parse((e.postData && e.postData.contents) || "{}"); } catch (x) {}
  var m = b.message || {};
  if (b.event_name === "webhook.test" || !m.chat || !m.from || m.from.is_bot) return ok;
  var lock = LockService.getScriptLock(); try { lock.waitLock(25000); } catch (x) { return ok; }
  try {
    var seen = []; try { seen = JSON.parse(P.getProperty("ZB_SEEN") || "[]"); } catch (x) {}
    if (seen.indexOf(m.message_id) >= 0) return ok; // Zalo gửi lại cùng một tin: bỏ qua
    seen.unshift(m.message_id); P.setProperty("ZB_SEEN", JSON.stringify(seen.slice(0, 80)));
    zbXuLy(m, String(b.event_name || ""));
  } catch (x) { Logger.log("zbHook lỗi: " + x); } finally { lock.releaseLock(); }
  return ok;
}
function zbGui(chat, text) { try { zbGoi("sendMessage", { chat_id: chat, text: String(text).slice(0, 1990) }); } catch (e) {} }
function zbKhongDau(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/\s+/g, " ").trim(); }
function zbMa(mail) { // mã nối 6 số cố định cho từng email (tính từ mã bí mật của máy chủ)
  var b = Utilities.computeHmacSha256Signature(String(mail).toLowerCase(), PropertiesService.getScriptProperties().getProperty("ZB_SECRET") || "x"), n = 0;
  for (var i = 0; i < 4; i++) n = (n * 256 + (b[i] & 255)) % 1000000007;
  return ("00000" + (n % 1000000)).slice(-6);
}
/* App gọi (đã đăng nhập): lấy mã nối Zalo của chính mình */
function zbNoi(token) {
  var mail = nguoiGoi(token);
  if (!mail) return { ok: false, msg: "Hết phiên đăng nhập, tải lại trang rồi thử lại." };
  if (mail !== chuSo() && !docFs("members/" + encodeURIComponent(mail))) return { ok: false, msg: "Tài khoản này chưa là thành viên sổ." };
  var u = JSON.parse(PropertiesService.getScriptProperties().getProperty("ZB_USERS") || "{}"), noi = false;
  for (var k in u) if (u[k].e === mail) noi = true;
  return { ok: true, ma: zbMa(mail), noi: noi, bot: "Bot opsdad" };
}
function zbBuf(uid, v) {
  var P = PropertiesService.getScriptProperties(), k = "zbbuf_" + uid;
  if (v === undefined) { try { return JSON.parse(P.getProperty(k) || "[]"); } catch (e) { return []; } }
  if (!v.length) { P.deleteProperty(k); return v; }
  var s = JSON.stringify(v); while (s.length > 8500 && v.length > 1) { v.shift(); s = JSON.stringify(v); }
  P.setProperty(k, s); return v;
}
function zbXuLy(m, ev) {
  var P = PropertiesService.getScriptProperties(), chat = m.chat.id, uid = m.from.id;
  var users = {}; try { users = JSON.parse(P.getProperty("ZB_USERS") || "{}"); } catch (x) {}
  var text = String(m.text || m.caption || "").trim(), k = zbKhongDau(text), u = users[uid];
  var noi = k.match(/^noi\s*(\d{6})$/);
  if (noi) {
    var owner = chuSo(), ds = [owner].concat(thanhVien()), mail = ds.filter(function (x) { return zbMa(x) === noi[1]; })[0];
    if (!mail) return zbGui(chat, "Mã không đúng. Mở Sổ → Cài đặt → Nối Zalo để lấy mã 6 số của bạn.");
    var ppl = docFs("meta/people") || {}, ten = ((ppl.p || {})[mail] || {}).n || m.from.display_name || mail.split("@")[0];
    users[uid] = { e: mail, n: ten, chat: chat }; P.setProperty("ZB_USERS", JSON.stringify(users));
    return zbGui(chat, "✅ Đã nối Zalo với tài khoản Sổ " + mail + " (" + ten + ").\n\n" + ZB_HD);
  }
  if (!u) return zbGui(chat, "Bot chưa biết bạn là ai trong Sổ. Mở app Làm hàng FDI → Cài đặt → Nối Zalo, lấy mã 6 số rồi nhắn cho bot: nối 123456");
  if (k === "hd" || k === "huong dan" || k === "help" || k === "/start") return zbGui(chat, ZB_HD);
  var buf = zbBuf(uid);
  if (k === "xem") return zbGui(chat, buf.length ? "Đang gom " + buf.length + " mục:\n" + buf.map(function (x, i) { return (i + 1) + ". " + (x.p ? "📷 ảnh" + (x.x ? ": " : "") : "") + String(x.x || "").slice(0, 80).replace(/\n/g, " "); }).join("\n") : "Chưa gom tin nào.");
  if (k === "xoa" || k === "huy" || k === "xoa het") { zbBuf(uid, []); return zbGui(chat, "🗑 Đã bỏ " + buf.length + " mục đã gom."); }
  var gan = text.match(/^\s*g[aắ]n\s+([A-Za-z]{1,4}\d{6}-[A-Za-z]*\d+)/i) || k.match(/^gan\s+([a-z]{1,4}\d{6}-[a-z]*\d+)/);
  if (gan) return zbGan(u, uid, chat, buf, gan[1].toUpperCase());
  if (/^tao( 1| mot)?( job| lo| viec)?$/.test(k) || k === "tao job moi") return zbTao(u, uid, chat, buf);
  if (!text && !m.photo_url) return; // sticker, tin thoại…: bỏ qua
  buf.push({ t: Number(m.date) || Date.now(), x: text.slice(0, 1500), p: m.photo_url || "" });
  buf = zbBuf(uid, buf);
  zbGui(chat, "📥 Đã gom " + buf.length + " mục. Gửi tiếp nếu còn, xong nhắn \"tạo job\" (hoặc \"gắn FDI…\" để ghi vào job có sẵn).");
}
function zbNoiDung(buf) {
  return buf.map(function (x, i) { return "[" + (i + 1) + "] " + (x.x || "") + (x.p ? (x.x ? "\n" : "") + "📷 " + x.p : ""); }).join("\n\n");
}
function zbGan(u, uid, chat, buf, code) {
  if (!buf.length) return zbGui(chat, "Chưa gom tin nào để gắn vào " + code + ".");
  var j = docHet("jobs").filter(function (x) { return String(x.code || "").toUpperCase() === code && x.shared; })[0];
  if (!j) return zbGui(chat, "Không thấy job " + code + " ở Sổ chung.");
  ghiTraoDoi(j, "📥 Từ Zalo (" + u.n + "):\n" + zbNoiDung(buf));
  zbBuf(uid, []);
  zbGui(chat, "✅ Đã ghi " + buf.length + " mục vào Trao đổi của " + code + ".\n" + APP + "?job=" + encodeURIComponent(j._id));
}
function zbTao(u, uid, chat, buf) {
  if (!buf.length) return zbGui(chat, "Chưa có thông tin nào. Gửi hoặc chuyển tiếp thông tin, ảnh của lô trước, rồi nhắn \"tạo job\".");
  zbGui(chat, "⏳ Đang đọc " + buf.length + " mục để tạo job…");
  var owner = chuSo(), jobs = docHet("jobs"), now = Date.now();
  var files = [];
  buf.filter(function (x) { return x.p; }).slice(0, 4).forEach(function (x) {
    try { var r = UrlFetchApp.fetch(x.p, { muteHttpExceptions: true }); if (r.getResponseCode() === 200) { var bl = r.getBlob(), by = bl.getBytes(); if (by.length < 4e6) files.push({ mime: bl.getContentType() || "image/jpeg", data: Utilities.base64Encode(by) }); } } catch (e) {}
  });
  var prompt = "Bạn là trợ lý bộ phận giao nhận (khai hải quan, vận chuyển container) của công ty FDI tại Việt Nam. Nhân viên đã gom các tin nhắn Zalo (và ảnh kèm theo) về MỘT lô hàng cần làm. Đọc hết và trả về DUY NHẤT một JSON mô tả lô đó.\n" +
    "Các trường (để chuỗi rỗng nếu không có): tieuDe (ngắn gọn, VD \"Khai nhập 2x40 máy móc - Cty A\" hoặc \"Xe nhập Hoà Vang - Đà Nẵng\"), congTy (chủ hàng), fwd (đại lý giao nhận / forwarder), dichVu (\"HQ\" nếu chỉ khai hải quan, \"VC\" nếu chỉ vận chuyển, \"HQ+VC\" nếu cả hai, rỗng nếu không rõ), hang (\"Nhập khẩu\" hoặc \"Xuất khẩu\"), bl, cont (số lượng + loại, hoặc số cont / biển số xe), tkNo (12 chữ số), mst, hangHoa, han (hạn xử lý YYYY-MM-DD nếu có, năm hiện tại " + homNay().slice(0, 4) + "), lienHe (tên + số điện thoại người liên hệ / tài xế), pol (nơi lấy hàng), pod (nơi giao hàng), tomTat (1-3 câu tiếng Việt: cần làm gì, còn thiếu gì).\n\n" +
    "CÁC TIN ĐÃ GOM (người gửi: " + u.n + "):\n" + buf.map(function (x, i) { return "[" + (i + 1) + "] " + (x.x || "(ảnh)"); }).join("\n\n");
  var o = null, r = aiChay({ prompt: prompt, files: files, json: true });
  if (r.ok) { try { o = JSON.parse(String(r.text).replace(/^\s*\x60+(json)?|\x60+\s*$/g, "").trim()); if (Array.isArray(o)) o = o[0]; } catch (e) { o = null; } }
  o = o || {};
  var sv = ["HQ", "VC", "HQ+VC"].indexOf(o.dichVu) >= 0 ? o.dichVu : "";
  var type = !sv ? "Khác" : sv === "VC" ? "Vận chuyển" : o.hang === "Xuất khẩu" ? "Khai HQ xuất" : "Khai HQ nhập";
  var d = homNay(), p = "FDI" + d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10), tag = u.e === owner ? "" : u.e.replace(/[^a-z]/g, "").slice(0, 2).toUpperCase();
  var n = jobs.filter(function (j) { return String(j.code || "").indexOf(p + "-" + tag) === 0; }).length + 1, code = p + "-" + tag + ("0" + n).slice(-2);
  var first = (buf.filter(function (x) { return x.x; })[0] || {}).x || "Job từ Zalo";
  var tieuDe = String(o.tieuDe || first.split("\n")[0]).slice(0, 70);
  var job = { code: code, title: dm(d) + " - " + tieuDe, fwd: o.fwd || "", company: o.congTy || "", contact: o.lienHe || "", source: "Zalo", type: type,
    mode: "", pol: o.pol || "", pod: o.pod || "", cargo: o.hangHoa || "", incoterm: "", refs: "", deadline: /^\d{4}-\d{2}-\d{2}$/.test(o.han || "") ? o.han : "", priority: "Thường",
    status: "Mới nhận", summary: String(o.tomTat || "").trim() + "\n📥 Tạo từ Zalo (" + u.n + ", " + buf.length + " tin)", questions: "",
    service: sv, vehicle: sv && sv !== "HQ" ? "Xe cont" : "", yard: "", cbm: "", mst: o.mst || "", bl: o.bl || "", cont: o.cont || "", tkNo: String(o.tkNo || "").replace(/\D/g, "").slice(0, 12),
    lane: "", truck: "", deposit: "", blocker: "", returnNote: "", tasks: [], quote: [], vat: 8, quoteNote: "", quoteSentAt: "", debitAmount: 0, debitCurrency: "VND", debitDate: "", paidDate: "",
    raw: zbNoiDung(buf).slice(0, 6000), images: [], createdAt: now, updatedAt: now, stageAt: now, history: [{ at: now, by: u.n, kind: "create", to: "Mới nhận", note: "Tạo từ Zalo" }],
    shared: true, createdBy: u.e, createdByName: u.n, assignee: u.e, assigneeName: u.n };
  if (!sv) job.svcPending = true;
  var f = {}; for (var key in job) f[key] = veFs(job[key]);
  var w = goi(FS + "/jobs", { method: "post", payload: { fields: f } });
  if (w.code !== 200) { Logger.log("zbTao ghi lỗi " + w.code + " " + w.text); return zbGui(chat, "❌ Chưa tạo được job (lỗi máy chủ " + w.code + "). Các tin đã gom vẫn giữ, thử lại sau."); }
  job._id = w.json.name.split("/").pop();
  ghiTraoDoi(job, "📥 Thông tin gom từ Zalo (" + u.n + "):\n" + zbNoiDung(buf));
  zbBuf(uid, []);
  if (u.e !== owner) guiToi([owner], "📥 Job mới từ Zalo · " + code, job.title + "\nTạo bởi " + u.n, { job: job._id }, APP + "?job=" + encodeURIComponent(job._id), "zalo-" + job._id);
  zbGui(chat, "✅ Đã tạo " + code + ": " + job.title + (sv ? " · " + sv : "") + (o.congTy ? " · " + o.congTy : "") + "\nJob ở cột Mới nhận, bạn là người phụ trách. Mở: " + APP + "?job=" + encodeURIComponent(job._id));
}
/* Chạy tay 1 lần: tự sinh mã bí mật và báo Zalo đẩy tin về link máy chủ đang triển khai */
function zaloCaiWebhook() {
  var P = PropertiesService.getScriptProperties(), s = P.getProperty("ZB_SECRET");
  if (!s) { s = Utilities.getUuid().replace(/-/g, ""); P.setProperty("ZB_SECRET", s); }
  var url = "https://script.google.com/macros/s/AKfycbybwZjSrdEh0xrt0MFKtbwh6dEfCCJuldpqVrQSAgP4e14RwZZs04FB_fPUZ7vKRFP2XQ/exec"; // link máy chủ đang dùng (PUSH_URL)
  var r = zbGoi("setWebhook", { url: url + "?zb=" + s, secret_token: s });
  Logger.log("setWebhook " + r.code + ": " + JSON.stringify(r.json).replace(s, "***"));
}
/* Chạy tay: xem trạng thái webhook Zalo (ẩn mã bí mật) */
function zaloKiemTra() { var s = PropertiesService.getScriptProperties().getProperty("ZB_SECRET") || "~"; Logger.log(JSON.stringify(zbGoi("getWebhookInfo").json).split(s).join("***")); }
