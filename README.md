# Thiệp sự kiện

Tạo thiệp mời cá nhân hoá (canvas → PNG), trang tra cứu cho khách, và trang quản trị
có trình thiết kế kéo-thả kèm cấu hình API riêng cho từng sự kiện.

| Đường dẫn  | Nội dung                                              |
|------------|-------------------------------------------------------|
| `/`        | Trang khách — chọn sự kiện, nhập thông tin, nhận thiệp |
| `/tra-cuu` | Khách tra lại thiệp bằng **sự kiện + họ tên + SĐT**    |
| `/admin`   | Quản trị: sự kiện, khách, nhật ký API                 |

```
public/           index.html, shared.js, ảnh nền → Vercel phục vụ ở ROOT (/1.png)
api/[...path].js  entry của Vercel, chỉ gọi vào server.js
server.js         toàn bộ routing + proxy API (dev server & Vercel dùng chung)
store.js          2 backend: Neon Postgres hoặc data.json
```

Chỉ 1 dependency: `@neondatabase/serverless` (driver HTTP cho serverless).

## Chạy local

```bash
npm install
ADMIN_PASSWORD='...' DELFI_API_PASSWORD='...' node server.js
```

Không set `DATABASE_URL` thì tự lưu vào `data.json`. Muốn seed lại: xoá file rồi chạy lại.

## Deploy lên Vercel

Vercel là serverless: **không có filesystem ghi được, không có RAM dùng chung**. Nên bắt
buộc có DB ngoài, nếu không dữ liệu khách sẽ mất và mỗi lambda thấy một kiểu khác nhau.

**1. Tạo Neon Postgres** — Vercel Dashboard → project → **Storage → Create Database →
Neon (Serverless Postgres)** → free plan → **Connect**. Vercel tự thêm biến `DATABASE_URL`
(và vài biến `POSTGRES_*`). Không cần tạo bảng tay — server tự `CREATE TABLE IF NOT EXISTS`
lần chạy đầu.

> Nếu Vercel chỉ set `POSTGRES_URL` mà không có `DATABASE_URL`, code vẫn nhận cả hai.

**2. Environment Variables** (Settings → Environment Variables):

| Biến | Bắt buộc | Ghi chú |
|------|----------|---------|
| `DATABASE_URL` *(hoặc `POSTGRES_URL`)* | ✅ | Neon tự thêm khi Connect |
| `ADMIN_PASSWORD` | ✅ | Mật khẩu vào `/admin` |
| `ADMIN_TOKEN_SECRET` | ✅ | Chuỗi ngẫu nhiên dài. **Không set là cold start đá admin ra ngoài.** Tạo bằng `openssl rand -hex 32` |
| `DELFI_API_PASSWORD` | — | Chỉ dùng lúc seed lần đầu; bỏ qua cũng được, nhập trong `/admin` sau. |
| `RESEND_API_KEY` | — | Bật gửi email qua Resend; giữ bí mật, chỉ đặt ở server/Vercel. |
| `RESEND_FROM` | — | Địa chỉ gửi đã verify trên Resend, ví dụ `Thiệp sự kiện <noreply@example.com>`. |
| `RESEND_REPLY_TO` | — | Địa chỉ nhận phản hồi, tuỳ chọn. |

**3. Deploy**

```bash
npx vercel --prod
```

Framework chọn **Other**. `vercel.json` đã lo rewrite `/tra-cuu` và `/admin`; `npm install`
Vercel tự chạy để cài driver Neon.

### Vài điều dễ vấp

- Ảnh nền nằm trong `public/` nên URL là `/1.png`, **không phải** `/public/1.png` — Vercel
  phục vụ thư mục `public/` ở root. Seed đã dùng đúng.
- Bảng `guests` ghi từng dòng (upsert theo `id`), không ghi đè cả mảng → hai người tạo thiệp
  cùng lúc không đè mất nhau.
- Đổi `ADMIN_TOKEN_SECRET` = đăng xuất toàn bộ admin đang đăng nhập.
- Ảnh admin tự upload lưu dạng data URL trong cột `jsonb`. Ảnh lớn làm dòng phình to; hay đổi
  ảnh thì cân nhắc Vercel Blob.
- Hobby plan giới hạn thời gian chạy function; nếu Delfi phản hồi chậm quá có thể bị cắt —
  nhật ký API sẽ ghi lại lỗi đó.

## Dữ liệu

Sự kiện/template ở bảng `app_state`, khách ở `guests`, nhật ký ở `logs`, chống-dò ở `rate`.
**Credential API nằm trong DB, không bao giờ trả về trình duyệt** (`/api/admin/state` trả
`password: null` kèm `hasPassword`). Bản file (`data.json`) đã nằm trong `.gitignore`.

## Tích hợp API

Cấu hình theo **từng sự kiện**, trong `/admin → Sửa thiết kế & API`. Không hardcode ở đâu.
Mỗi khi khách tạo/sửa thiệp, **máy chủ** (không phải trình duyệt) gửi request đi.

Body là JSON template có placeholder `{{...}}`; giá trị được JSON-escape trước khi chèn nên
dấu nháy trong tên khách không làm hỏng payload. Template sai JSON bị chặn trước khi gửi.

Biến dùng được: mọi `key` trong "Trường khách nhập", cộng `{{fullNameDisplay}}`, `{{lucky}}`,
`{{qrContent}}`, `{{qrcode}}`, `{{recordId}}`, `{{eventName}}`, `{{createdAt}}`.

`{{qrcode}}` trống ở lần tạo đầu; giá trị `qrcode` API trả về được lưu lại để lần sửa sau
gửi kèm — Delfi update đúng client thay vì tạo trùng.

**Vì sao phải có máy chủ:** `User-Agent` là forbidden header, `fetch()` trình duyệt luôn bỏ
qua; và mật khẩu Basic Auth gửi từ trình duyệt sẽ lộ cho mọi khách mời. Để trống ô mật khẩu
khi lưu = giữ nguyên mật khẩu cũ.

## Email qua Resend

Đặt `RESEND_API_KEY` và `RESEND_FROM`, sau đó vào `/admin → Sửa thiết kế & API`. Mỗi sự kiện
có phần **Email Resend theo sự kiện**, cho phép bật gửi tự động sau khi đăng ký, tạo/sửa/xoá
template `Thư mời` hoặc `Reminder`, và chọn thiệp/QR là file đính kèm hoặc ảnh inline trong
nội dung email. Admin cũng có thể mở từng khách trong tab **Khách** để gửi lại email theo
template đã chọn.

Email dùng các biến như `{{fullNameDisplay}}`, `{{eventName}}`, `{{name}}`, `{{phone}}`,
`{{cardImage}}` và `{{qrImage}}`. API key không bao giờ được trả về trình duyệt.

## Kiểm thử

```bash
node test.js
```

51 check. Chạy toàn bộ suite **hai lần** — một lần trên file store, một lần trên Postgres
(qua Neon giả dựng trong process, đúng các câu SQL `store.js` phát ra) — vì Postgres mới là
code path chạy thật trên Vercel. Endpoint Delfi cũng được giả lập: test không gọi ra internet.
Neon giả kiểm tra được việc ráp tham số và parse dòng, **không** thay được một lần chạy trên
Postgres thật — lần deploy đầu và nút "Gửi thử payload mẫu" mới xác nhận điều đó.
