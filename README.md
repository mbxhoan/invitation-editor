# Thiệp sự kiện

Tạo thiệp mời cá nhân hoá (canvas → PNG), trang tra cứu cho khách, và trang quản trị
có trình thiết kế kéo-thả kèm cấu hình API riêng cho từng sự kiện.

## Chạy

```bash
ADMIN_PASSWORD='<mật khẩu quản trị>' \
DELFI_API_PASSWORD='<mật khẩu Basic Auth của Delfi>' \
node server.js
```

Không cần `npm install` — không có dependency nào.

| Đường dẫn  | Nội dung                                        |
|------------|-------------------------------------------------|
| `/`        | Trang khách — chọn sự kiện, nhập thông tin, nhận thiệp |
| `/tra-cuu` | Khách tra lại thiệp bằng **sự kiện + họ tên + SĐT** |
| `/admin`   | Quản trị: sự kiện, khách, nhật ký API           |

## Biến môi trường

| Biến                 | Mặc định | Ghi chú |
|----------------------|----------|---------|
| `PORT`               | `3000`   | |
| `ADMIN_PASSWORD`     | `admin`  | **Bắt buộc đổi khi chạy thật.** Máy chủ kiểm tra, không phải trình duyệt. |
| `DELFI_API_PASSWORD` | *(trống)*| Chỉ dùng để seed lần đầu. Có thể bỏ qua và nhập trong `/admin` sau. |
| `DATA_FILE`          | `./data.json` | |

## Dữ liệu

Toàn bộ nằm trong `data.json` (sự kiện, template, khách, nhật ký, **và credential API**).
File này đã nằm trong `.gitignore` — đừng commit. Muốn seed lại: xoá file rồi khởi động lại.

## Tích hợp API

Cấu hình theo **từng sự kiện**, trong `/admin → Sửa thiết kế & API`. Không hardcode ở đâu cả.
Mỗi khi khách tạo hoặc sửa thiệp, **máy chủ** (không phải trình duyệt) gửi request đi.

Body là một JSON template có placeholder `{{...}}`; giá trị được JSON-escape trước khi
chèn, nên dấu nháy trong tên khách không làm hỏng payload. Template không parse được
sẽ bị chặn trước khi gửi và ghi vào nhật ký.

Biến dùng được: mọi `key` trong "Trường khách nhập", cộng với
`{{fullNameDisplay}}`, `{{lucky}}`, `{{qrContent}}`, `{{qrcode}}`, `{{recordId}}`,
`{{eventName}}`, `{{createdAt}}`.

`{{qrcode}}` trống ở lần tạo đầu; giá trị `qrcode` mà API trả về được lưu lại để lần
sửa sau gửi kèm — Delfi sẽ update đúng client thay vì tạo trùng.

**Vì sao phải có máy chủ:** `User-Agent` là forbidden header, `fetch()` trong trình duyệt
luôn bỏ qua nó; và mật khẩu Basic Auth gửi từ trình duyệt sẽ lộ cho mọi khách mời.
Máy chủ giữ mật khẩu, không bao giờ trả nó về client (`/api/admin/state` trả `password: null`
kèm `hasPassword`). Để trống ô mật khẩu khi lưu = giữ nguyên mật khẩu cũ.

## Kiểm thử

```bash
node test.js
```

27 check, không dependency. Tự dựng một endpoint giả trong process để kiểm tra
header và payload thực sự gửi đi — không bao giờ gọi ra ngoài internet.
