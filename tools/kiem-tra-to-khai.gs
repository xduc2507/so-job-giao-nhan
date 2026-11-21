/**
 * Sổ Job – máy chủ trung gian kiểm tra trạng thái tờ khai (KVGS qua taichinhcong.com)
 * Cài: script.google.com → Dự án mới → dán toàn bộ file này → Triển khai → Tùy chọn triển khai mới
 *      → Loại: Ứng dụng web · Thực thi với tư cách: Tôi · Ai có quyền truy cập: Bất kỳ ai → Triển khai.
 * Gọi: <link>/exec?mst=0319585064&hq=34AB&tk=108839353710&date=2026-11-20
 * Không lưu gì; chỉ chuyển 4 thông tin sang taichinhcong.com rồi đọc kết quả.
 */
var BASE = "https://www.taichinhcong.com";

function doGet(e) {
  var p = (e && e.parameter) || {};
  var out;
  try { out = kiemTra(p.mst, p.hq, p.tk, p.date); }
  catch (err) { out = { ok: false, msg: "Lỗi máy chủ kiểm tra: " + err }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function kiemTra(mst, hq, tk, date) {
  mst = String(mst || "").replace(/[^\d-]/g, "");
  hq = String(hq || "").trim().toUpperCase();
  tk = String(tk || "").replace(/\D/g, "");
  date = String(date || "").trim();
  if (!/^\d{10}(-\d{3})?$/.test(mst) || !/^[0-9A-Z]{4}$/.test(hq) || !/^\d{12}$/.test(tk) || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return { ok: false, msg: "Thông tin chưa đúng (MST, mã HQ, số TK 12 số, ngày)." };
  var r = UrlFetchApp.fetch(BASE + "/Home/MaVachKVGS", {
    method: "post",
    payload: { maDoanhNghiep: mst, maHaiQuan: hq, soToKhai: tk, ngayToKhai: date },
    followRedirects: false, muteHttpExceptions: true
  });
  var code = r.getResponseCode(), h = r.getAllHeaders(), loc = h.Location || h.location;
  if (code >= 300 && code < 400 && loc) {
    var url = /^https?:/.test(loc) ? loc : BASE + loc;
    var page = UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText("UTF-8");
    var o = docBangKe(page);
    o.url = url;
    return o;
  }
  return docLoi(r.getContentText("UTF-8"));
}

function giaiMa(s) {
  return String(s).replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}

function docBangKe(html) {
  var lay = function (id) {
    var m = html.match(new RegExp('<span[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)</span>'));
    return m ? giaiMa(m[1].replace(/<[^>]+>/g, " ")) : "";
  };
  var st = lay("lblTrangThaiToKhai");
  if (!st && !lay("lblSoToKhai")) return docLoi(html);
  return {
    ok: true, mv: /<img[^>]*src="data:image\//.test(html), // hàng lẻ: mã vạch dài; hàng container: mã QR
    status: st, lane: lay("lblLuong"), kind: lay("lblTenLoaiHinh"), company: lay("lblTenDVXNK"),
    tkNo: lay("lblSoToKhai"), dates: lay("lblNgayToKhai"), qlhh: lay("lblSoQuanLyHangHoa"),
    qty: lay("lblSoLuongHang"), weight: lay("lblTongTrongLuong"), gs: lay("lblTenChiCucHQGS"), seal: lay("lblTrangThaiNiemPhong")
  };
}

function docLoi(html) {
  var m = String(html).match(/class="msg-text"[^>]*>([\s\S]*?)<\/p>/);
  return { ok: false, msg: m ? giaiMa(m[1].replace(/<[^>]+>/g, " ")) : "Không đọc được kết quả từ trang tra cứu." };
}
