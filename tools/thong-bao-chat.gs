/**
 * Sổ Job – gửi thông báo đẩy lên điện thoại khi có tin nhắn mới trong khung Trao đổi của job.
 * App gọi: POST <link>/exec  với nội dung {"job":"<id job>"}.
 * Script tự đọc job và tin nhắn mới nhất trong Firestore (không tin nội dung gửi kèm),
 * gửi cho người thấy được job (chủ sổ; nhân viên nếu job đã chia sẻ hoặc do họ tạo),
 * trừ người gửi và người đã tắt 🔕 ở job đó. Việc riêng của chủ sổ không bao giờ gửi.
 * Chạy bằng tài khoản chủ sổ (chủ dự án Firebase) nên đọc được Firestore và gửi được FCM.
 * appsscript.json: "oauthScopes": [datastore, firebase.messaging, script.external_request, userinfo.email],
 * "webapp": {"executeAs":"USER_DEPLOYING","access":"ANYONE_ANONYMOUS"}. Triển khai: Ứng dụng web.
 */
var PID = "so-job-giao-nhan";
var APP = "https://xduc2507.github.io/so-job-giao-nhan/";
var FS = "https://firestore.googleapis.com/v1/projects/" + PID + "/databases/(default)/documents";

function doPost(e) {
  var out = { ok: false };
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    out = guiThongBao(String(body.job || ""));
  } catch (err) { out = { ok: false, msg: String(err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
function doGet() { return ContentService.createTextOutput("ok"); }

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
  var f = last.document.fields || {}, msg = { text: giaTri(f.text) || "", by: String(giaTri(f.by) || "").toLowerCase(), byName: giaTri(f.byName) || "", at: Number(giaTri(f.at) || 0) };
  if (Date.now() - msg.at > 10 * 60 * 1000) return { ok: true, sent: 0, msg: "Tin cũ" };
  var props = PropertiesService.getScriptProperties(), key = "last_" + jobId;
  if (Number(props.getProperty(key) || 0) >= msg.at) return { ok: true, sent: 0, msg: "Đã gửi" };
  props.setProperty(key, String(msg.at));

  // người nhận
  var nguoi = [owner];
  if (job.shared) {
    var m = goi(FS + "/members?pageSize=200");
    ((m.json && m.json.documents) || []).forEach(function (d) { nguoi.push(decodeURIComponent(d.name.split("/").pop()).toLowerCase()); });
  } else if (createdBy) nguoi.push(createdBy);
  var tat = (job.mute || []).map(function (x) { return String(x).toLowerCase(); });
  nguoi = nguoi.filter(function (x, i, a) { return x && a.indexOf(x) === i && x !== msg.by && tat.indexOf(x) < 0; });

  var title = "💬 " + (msg.byName || msg.by) + " · " + (job.code || "");
  var body = (job.title ? String(job.title).slice(0, 60) + "\n" : "") + String(msg.text).slice(0, 160);
  var sent = 0, loi = [];
  nguoi.forEach(function (mail) {
    var p = docFs("push/" + mail);
    var toks = (p && p.tokens) || [], bad = [];
    toks.forEach(function (t) {
      var r = goi("https://fcm.googleapis.com/v1/projects/" + PID + "/messages:send", { method: "post", payload: { message: {
        token: t,
        data: { job: jobId },
        webpush: {
          notification: { title: title, body: body, icon: APP + "icon-192.png", badge: APP + "icon-192.png", tag: "job-" + jobId, renotify: true },
          fcm_options: { link: APP + "?job=" + encodeURIComponent(jobId) }
        } } } });
      if (r.code === 200) sent++;
      else { loi.push(r.code); if (r.code === 404 || r.code === 400) bad.push(t); } // mã máy hết hạn / gỡ app
    });
    if (bad.length) goi(FS + "/push/" + encodeURIComponent(mail) + "?updateMask.fieldPaths=tokens", { method: "patch", payload: { fields: { tokens: { arrayValue: { values:
      toks.filter(function (t) { return bad.indexOf(t) < 0; }).map(function (t) { return { stringValue: t }; }) } } } } });
  });
  return { ok: true, sent: sent, to: nguoi.length, loi: loi };
}

/** Chạy thử bằng tay trong trình soạn Apps Script để cấp quyền lần đầu. */
function thu() { Logger.log(Session.getEffectiveUser().getEmail()); Logger.log(JSON.stringify(goi(FS + "/members?pageSize=1").code)); }
