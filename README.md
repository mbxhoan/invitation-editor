# Thiệp sự kiện

Tạo thiệp mời cá nhân hoá (canvas → PNG), trang tra cứu cho khách, và trang quản trị
có trình thiết kế kéo-thả kèm cấu hình API riêng cho từng sự kiện.

| Đường dẫn  | Nội dung                                              |
|------------|-------------------------------------------------------|
| `/`        | Trang khách — chọn sự kiện, nhập thông tin, nhận thiệp |
| `/tra-cuu` | Khách tra lại thiệp bằng **sự kiện + họ tên + SĐT**    |
| `/admin`   | Quản trị: sự kiện, khách, nhật ký API                 |

Không có dependency nào — không cần `npm install`.

```
public/           index.html, shared.js, ảnh nền  → Vercel phục vụ ở ROOT (/1.png)
api/[...path].js  entry của Vercel, chỉ gọi vào server.js
server.js         toàn bộ routing + proxy API (dev server & Vercel dùng chung)
store.js          2 backend: Upstash Redis hoặc data.json
```

## Chạy local

```bash
ADMIN_PASSWORD='...' DELFI_API_PASSWORD='...' node server.js
```

Không set biến Redis thì tự lưu vào `data.json`. Muốn seed lại: xoá file rồi chạy lại.

## Deploy lên Vercel

Vercel là serverless: **không có filesystem ghi được và không có RAM dùng chung**. Nên
phải có kho ngoài, nếu không dữ liệu khách sẽ biến mất và mỗi lambda thấy một kiểu khác nhau.

**1. Tạo Redis** — Vercel Dashboard → Storage → Upstash Redis (free tier đủ dùng) → Connect
vào project. Vercel tự thêm `UPSTASH_REDIS_REST_URL` và `UPSTASH_REDIS_REST_TOKEN`.

**2. Thêm Environment Variables** (Settings → Environment Variables):

| Biến | Bắt buộc | Ghi chú |
|------|----------|---------|
| `UPSTASH_REDIS_REST_URL` | ✅ | Upstash tự thêm khi Connect |
| `UPSTASH_REDIS_REST_TOKEN` | ✅ | Upstash tự thêm khi Connect |
| `ADMIN_PASSWORD` | ✅ | Mật khẩu vào `/admin` |
| `ADMIN_TOKEN_SECRET` | ✅ | Chuỗi ngẫu nhiên dài. **Không set là cold start đá admin ra ngoài.** Tạo bằng `openssl rand -hex 32` |
| `DELFI_API_PASSWORD` | — | Chỉ dùng lúc seed lần đầu. Bỏ qua cũng được, nhập trong `/admin` sau. |

**3. Deploy**

```bash
npx vercel --prod
```

Không cần chọn framework (Other). `vercel.json` đã lo rewrite cho `/tra-cuu` và `/admin`.

### Vài điều dễ vấp

- Ảnh nền nằm trong `public/` nên URL là `/1.png`, **không phải** `/public/1.png` — Vercel
  phục vụ thư mục `public/` ở root. Seed đã dùng đúng đường dẫn này.
- Ảnh nền admin tự upload được lưu dạng data URL trong Redis. Ảnh lớn sẽ làm record phình to;
  nếu hay đổi ảnh thì nên chuyển sang Vercel Blob.
- Đổi `ADMIN_TOKEN_SECRET` = đăng xuất toàn bộ admin đang đăng nhập.
- Free tier của Vercel có giới hạn thời gian chạy function; API Delfi phản hồi chậm quá
  có thể bị cắt. Nhật ký API sẽ ghi lại lỗi đó.

## Dữ liệu

Sự kiện, template, khách, nhật ký **và credential API** đều nằm trong kho (Redis hoặc
`data.json`). `data.json` đã nằm trong `.gitignore` — đừng commit.

Khách được ghi theo từng bản ghi (`HSET`), không ghi đè cả mảng, nên hai người bấm tạo
thiệp cùng lúc không đè mất nhau.

## Tích hợp API

Cấu hình theo **từng sự kiện**, trong `/admin → Sửa thiết kế & API`. Không hardcode ở đâu.
Mỗi khi khách tạo hoặc sửa thiệp, **máy chủ** (không phải trình duyệt) gửi request đi.

Body là JSON template có placeholder `{{...}}`; giá trị được JSON-escape trước khi chèn nên
dấu nháy trong tên khách không làm hỏng payload. Template không parse được sẽ bị chặn
trước khi gửi và ghi vào nhật ký.

Biến dùng được: mọi `key` trong "Trường khách nhập", cộng với `{{fullNameDisplay}}`,
`{{lucky}}`, `{{qrContent}}`, `{{qrcode}}`, `{{recordId}}`, `{{eventName}}`, `{{createdAt}}`.

`{{qrcode}}` trống ở lần tạo đầu; giá trị `qrcode` API trả về được lưu lại để lần sửa sau
gửi kèm — Delfi update đúng client thay vì tạo trùng.

**Vì sao phải có máy chủ:** `User-Agent` là forbidden header, `fetch()` trong trình duyệt
luôn bỏ qua nó; và mật khẩu Basic Auth gửi từ trình duyệt sẽ lộ cho mọi khách mời. Máy chủ
giữ mật khẩu, không bao giờ trả về client (`/api/admin/state` trả `password: null` kèm
`hasPassword`). Để trống ô mật khẩu khi lưu = giữ nguyên mật khẩu cũ.

## Kiểm thử

```bash
node test.js
```

51 check, không dependency. Chạy toàn bộ bộ test **hai lần** — một lần trên file store,
một lần trên Redis (qua Upstash giả dựng ngay trong process) — vì Redis mới là code path
chạy thật trên Vercel. Endpoint bên thứ 3 cũng được giả lập: test không bao giờ gọi ra internet.
