# Sổ Job Giao Nhận

Sổ quản lý công việc cho nhân viên giao nhận / khai báo hải quan. Chụp màn hình email hoặc tin nhắn Zalo, dán vào trang, Claude đọc ảnh và tạo job theo FWD / công ty, kèm việc cần làm và bảng báo giá.

> Bản thử nghiệm (prototype). Một file HTML duy nhất, viết bằng JavaScript thuần, không cần build.

## Tính năng

- **Tạo job từ ảnh chụp**: dán ảnh (Ctrl+V), kéo thả hoặc dán chữ. Claude tách FWD, công ty chủ hàng, người liên hệ, tuyến, hàng hoá, hạn xử lý, mức ưu tiên, việc cần làm, hạng mục phí và câu cần hỏi lại khách.
- **Nhóm theo FWD / công ty** ở cột trái, kèm số job đang mở.
- **Mẫu checklist theo loại việc**: Báo giá, Khai HQ nhập, Khai HQ xuất, Vận chuyển, Chứng từ / C/O, Kiểm tra chuyên ngành. Sửa được trong tab "Mẫu checklist".
- **Hồ sơ FWD / khách hàng**: job đang mở, công nợ chờ thu, đã thu trong năm, liên hệ, lịch sử giá đã báo.
- **Nhớ giá**: báo giá mới gợi ý đơn giá lần trước của cùng FWD.
- **Quy trình**: Mới → Báo giá → Chốt → Làm hàng → Thông quan → Debit → Đã thu, dạng bảng kéo thả.
- **Kế hoạch việc**: gom việc chưa xong theo hạn (Quá hạn / Hôm nay / 7 ngày tới…). Gõ tay việc riêng hoặc việc thuộc job.
- **Báo giá và debit**: VAT, tổng theo VND / USD, nút copy báo giá để dán vào Zalo hoặc email.

## Hai cách chạy

Giao diện nằm trong một file duy nhất, `so-job.html`, dùng chung cho cả hai cách. Trang gọi `window.claude.use("db" | "sample" | "assets")` để lưu dữ liệu, đọc ảnh bằng Claude và lưu ảnh gốc.

### 1. Artifact trên claude.ai
claude.ai tự cung cấp ba khả năng trên. Người dùng cần tài khoản Claude, và việc đọc ảnh tính vào hạn mức của chính họ.

### 2. Bản chạy độc lập (PHP + MySQL), ví dụ trên Hostinger
`index.php` lấy `so-job.html`, chèn `shim.js` vào. `shim.js` dựng lại `window.claude.use(...)` bằng các API PHP:

| File | Việc |
|---|---|
| `api/auth.php` | Đăng nhập, đăng xuất (session PHP) |
| `api/db.php` | Kho tài liệu JSON trong MySQL; trình duyệt hỏi lại mỗi 6 giây để đồng bộ giữa các máy |
| `api/ai.php` | Gửi ảnh + lời nhắc tới Claude API (Claude Opus 5.5) qua thư viện chính thức `anthropic-ai/sdk` |
| `api/upload.php`, `api/file.php` | Lưu và xem ảnh chụp gốc (chỉ người đã đăng nhập) |
| `api/users.php` | Quản trị viên thêm, xoá, đổi mật khẩu người dùng |
| `install.php` | Trang cài đặt một lần: nhập MySQL, API key, tài khoản quản trị → tạo `config.php` rồi tự khoá |

Thư mục `vendor/` đã có sẵn thư viện (không cần chạy Composer trên host). Yêu cầu PHP 8.1 trở lên, có `curl`, `pdo_mysql`, `mbstring`, `fileinfo`.

Chi phí đọc ảnh tính vào tài khoản Claude API của bạn (console.anthropic.com), khoảng vài trăm đến một nghìn đồng mỗi lần tạo job từ ảnh, tuỳ số ảnh và độ dài tin nhắn.

### 3. Bản tĩnh trên GitHub Pages (dùng thử, miễn phí)
Thư mục `docs/` là bản không cần máy chủ: `docs/index.html` = `so-job.html` + `static-shim.js`.
- Có `firebase-config.js`: dữ liệu lưu **online** trên Firebase Firestore, đăng nhập bằng Google, mọi máy thấy chung một sổ. Quy tắc Firestore chỉ cho các email trong danh sách đọc / ghi (Firebase console → Firestore → Rules). Nút **Cài đặt** có "Đưa job đang lưu trên máy này lên kho online".
- Không có `firebase-config.js`: dữ liệu lưu trong IndexedDB của **từng trình duyệt** (không đồng bộ giữa các máy).
- Nút **Cài đặt** có sao lưu / khôi phục file JSON.
- Nút **Đọc chữ (miễn phí)** đọc chữ trong ảnh bằng Tesseract ngay trên máy, không cần API key.
- Đọc ảnh: mỗi người tự nhập API key Claude trong **Cài đặt**; key chỉ lưu ở trình duyệt đó và gọi thẳng `api.anthropic.com`.
- Sửa giao diện xong thì chạy `php build-pages.php` để dựng lại `docs/`, rồi commit và push.
- Bật: GitHub repo → Settings → Pages → Branch `main`, thư mục `/docs`.

## Cài lên Hostinger (Web / Cloud Hosting)

1. **Tạo database**: hPanel → Websites → *Quản lý* → **Databases → Management** → tạo database MySQL mới, ghi lại tên database, user và mật khẩu.
2. **Lấy API key Claude**: vào console.anthropic.com → API keys → Create key. Nạp tiền (Billing) nếu tài khoản chưa có số dư.
3. **Đưa code lên** (chọn một cách):
   - **Git** (khuyên dùng): hPanel → **Advanced → Git** → repository `https://github.com/xduc2507/so-job-giao-nhan.git`, branch `main`, thư mục cài đặt ví dụ `public_html/sojob` (thư mục phải trống) → *Create* → *Deploy*. Lần sau cập nhật chỉ cần bấm *Redeploy*.
   - **File Manager**: tải ZIP của repo trên GitHub (Code → Download ZIP), tải lên `public_html/sojob` và giải nén.
4. **Cài đặt**: mở `https://tên-miền-của-bạn/sojob/install.php`, điền thông tin ở bước 1, 2 và tạo tài khoản quản trị.
5. Mở `https://tên-miền-của-bạn/sojob/`, đăng nhập. Bấm **Người dùng** ở góc trên để tạo tài khoản cho đồng nghiệp.

Nếu đọc ảnh báo hết giờ: hPanel → **Advanced → PHP Configuration** → tăng `max_execution_time` lên 300 và `upload_max_filesize` lên 12M.

## Chạy thử trên máy

```bash
composer install
php -S 127.0.0.1:8099
```
Mở `http://127.0.0.1:8099/install.php` (cần MySQL), hoặc tự tạo `config.php` theo `config.sample.php` với `db_dsn` dạng `sqlite:/đường/dẫn/test.sqlite` rồi gọi `ensure_schema(pdo())` trong `lib.php` để tạo bảng.

## Bảo mật
- `config.php` (mật khẩu MySQL, API key) không nằm trong Git, `.htaccess` chặn tải trực tiếp.
- API key chỉ ở máy chủ, trình duyệt không bao giờ thấy.
- Mọi API ghi dữ liệu yêu cầu đăng nhập và header riêng của app (chống CSRF).
- Ảnh gốc lưu trong `uploads/`, chặn truy cập trực tiếp, chỉ xem qua `api/file.php` khi đã đăng nhập.

## Cấu trúc dữ liệu

- `jobs/{id}`: mã job, FWD, công ty, loại việc, tuyến, hàng, hạn, giai đoạn, `tasks[]`, `quote[]`, VAT, debit, ngày thu tiền…
- `meta/templates`: mẫu checklist theo loại việc
- `partners/{slug}`: điện thoại, email, ghi chú của từng FWD / khách
- `todos/{id}`: việc riêng không thuộc job
