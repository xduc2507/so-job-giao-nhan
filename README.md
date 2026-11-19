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

## Chạy ở đâu

Trang được thiết kế để chạy như một **Artifact trên claude.ai**. Nó dùng các khả năng mà claude.ai cấp cho trang qua `window.claude.use(...)`:

| Khả năng | Dùng để |
|---|---|
| `db` | Lưu job, mẫu checklist, hồ sơ FWD, việc riêng; đồng bộ giữa các máy |
| `sample` (kèm ảnh) | Gọi Claude đọc ảnh chụp và trả về JSON |
| `assets` | Lưu ảnh chụp gốc của job |

Mở file `so-job.html` trực tiếp trong trình duyệt hoặc qua GitHub Pages thì **không có** các khả năng trên. Trang vẫn chạy ở chế độ tạm: tạo job trống và nhập tay được, nhưng không đọc ảnh bằng Claude và dữ liệu mất khi tải lại trang.

Muốn chạy độc lập ngoài claude.ai cần thay hai phần:
1. Kho dữ liệu: đổi lớp `db` sang Firebase / Supabase / API riêng (cùng kiểu `doc().set()`, `collection().onSnapshot()`).
2. Đọc ảnh: gọi Claude API qua một backend nhỏ, **không** đặt API key trong file HTML.

## Cấu trúc dữ liệu

- `jobs/{id}`: mã job, FWD, công ty, loại việc, tuyến, hàng, hạn, giai đoạn, `tasks[]`, `quote[]`, VAT, debit, ngày thu tiền…
- `meta/templates`: mẫu checklist theo loại việc
- `partners/{slug}`: điện thoại, email, ghi chú của từng FWD / khách
- `todos/{id}`: việc riêng không thuộc job
