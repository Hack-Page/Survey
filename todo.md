# 📋 KẾ HOẠCH VÀ TOÀN BỘ NHẬT KÝ LÀM VIỆC VỚI OPENCODE (TODO.MD)

---

## 🖥️ 1. THÔNG TIN TIẾN TRÌNH & PHIÊN LÀM VIỆC (TERMINAL CONTEXT)

* **Terminal PID (Session Shell):** `3026`
* **Shell Command Line:** 
  `/bin/bash --init-file /vscode/bin/linux-x64/a5b500951314efd502d07465bd138dfbd714a960/out/vs/workbench/contrib/terminal/common/scripts/shellIntegration-bash.sh`
* **Tiến trình OpenCode chạy ngầm:** PID `4464` (`opencode`)
* **OpenCode Session ID:** `ses_fba2ad5c5ffeQoWqBO07RGBXO9` (Slug: `nimble-engine`)
* **Trạng thái dừng của OpenCode:** 
  Quá trình xử lý của OpenCode bị gián đoạn do lỗi phía nhà cung cấp mô hình AI:
  `AI_APICallError: Error from provider (Console): Rate limit exceeded. Please try again later.` tại tin nhắn `msg_0468dd63e001vhFKeULN6BWEgT`.

---

## 📜 2. TOÀN BỘ LOG & DIỄN BIẾN TRÒ CHUYỆN VỚI OPENCODE (TIMELINE)

Dưới đây là tóm tắt toàn bộ chuỗi yêu cầu và giải pháp trong suốt phiên làm việc giữa User và OpenCode được trích xuất từ database log `opencode.db`:

### 🔹 Giai đoạn 1: Thiết lập bảo mật, giới hạn IP + MSNV & Khóa bài nộp 1 lần
* **Yêu cầu User:**
  1. Mỗi bài khảo sát chỉ tạo link/QR 1 lần; người làm sau khi nộp thành công sẽ bị khóa theo IP và MSNV, không thể nộp lại.
  2. Dùng mạng cá nhân (4G/di động), không dùng wifi chung công ty. Khóa IP kèm MSNV.
  3. Khi vào lại link đã làm, hiển thị màn hình thông báo đã nộp thành công ("Nếu muốn sửa bài khảo sát hãy liên hệ nhân sự").
  4. Nút "Cho phép làm lại" trong Admin Hub sẽ xóa bài nộp trong Neon để thiết bị/IP/MSNV đó làm lại được.
  5. Đăng nhập Admin: lưu biến bảo mật trên server Cloudflare, không hardcode frontend.
* **OpenCode đã thực hiện:**
  * Tạo ràng buộc UNIQUE / kiểm tra trùng lặp `survey_id + employee_msnv` và `survey_id + client_ip` trên backend (`worker.js` và `functions/api/[[path]].js`).
  * Bổ sung API xóa bài nộp `DELETE /api/responses?id=...` để mở khóa làm lại.

### 🔹 Giai đoạn 2: Quy định chuẩn định dạng MSNV (`LEP***`)
* **Yêu cầu User:** Bắt buộc ô nhập MSNV phải bắt đầu bằng `LEP` (ví dụ `LEP123`, `LEP120A`), tự động hỗ trợ viết hoa, cảnh báo nếu thiếu tiền tố `LEP`.
* **OpenCode đã thực hiện:** Thêm regex kiểm tra `/^LEP[A-Z0-9]+$/i` và tự động gắn tiền tố gợi ý trên giao diện.

### 🔹 Giai đoạn 3: Bỏ cơ chế tự động lưu khi chưa bấm "LƯU KHẢO SÁT & TẠO LINK/QR"
* **Yêu cầu User:** Chỉ khi bấm nút *"LƯU KHẢO SÁT & TẠO LINK/QR"* mới được lưu vào database và sinh link/QR; không tự lưu ngầm làm rác bộ nhớ. Toàn bộ alert trình duyệt phải chuyển thành UI Toast thông báo đẹp mắt.
* **OpenCode đã thực hiện:** Loại bỏ auto-save ngầm, hoàn thiện modal/toast thông báo.

### 🔹 Giai đoạn 4: Chuyển xác thực Admin Login lên Cloudflare Backend
* **Yêu cầu User:** Không đặt tài khoản/mật khẩu ở file `index.html`, chuyển sang API `POST /api/login` với biến môi trường `ADMIN_USER` / `ADMIN_PASS`.
* **OpenCode đã thực hiện:** Cập nhật endpoint `/api/login` và cơ chế xác thực `x-admin-key` qua header.

### 🔹 Giai đoạn 5: Sửa định dạng xuất Excel (`.xlsx` chuẩn) & Giao diện Header
* **Yêu cầu User:** File Excel tải về không được báo lỗi sai định dạng MIME / corrupt; căn chỉnh độ rộng cột, nền tiêu đề xanh nhạt, chữ đen rõ ràng dễ đọc.
* **OpenCode đã thực hiện:** Tích hợp thư viện SheetJS tạo file `.xlsx` nhị phân chuẩn, style bảng dữ liệu rõ ràng.

### 🔹 Giai đoạn 6 (NGỮ CẢNH HIỆN TẠI): Vấn đề Khảo Sát Ẩn, Bộ Nhớ Neon Free, Bỏ IndexedDB & Xóa Hàng Loạt
* **Phát hiện từ User (Hình ảnh `image.png`):**
  * Trong database Neon tồn tại nhiều bản ghi khảo sát trùng lặp (`SV-LP-196535`, `SV-LP-383199`, `SV-LP-407328`,...) do các lần nạp mẫu tự động trước đây.
  * Trên Frontend chỉ hiển thị 1 mẫu `SV-LP-692817`, các mẫu còn lại bị **"ẩn"** vì trước đó Frontend chỉ đọc từ bộ nhớ `IndexedDB` của trình duyệt chứ không đọc từ Neon DB.
  * Nguy cơ đầy hạn mức 0.5 GB của gói Neon Free.
* **Đề xuất và Trao đổi chốt phương án giữa User và OpenCode (`image copy 2.png`):**
  * **Mục A:** Bỏ cơ chế tự nạp preset khi khởi động. Builder để trắng; chỉ nạp mẫu khi bấm nút `✨ Nạp Mẫu!`. Muốn sửa khảo sát cũ thì vào danh sách bấm icon bút chì `✏️ Sửa`. Không cần quét liên tục về Neon.
  * **Mục B:** Khi bấm xóa khảo sát trên Frontend, hiển thị hộp thoại xác nhận:
    > *"Nếu xóa mẫu khảo sát này thì toàn bộ bài khảo sát liên quan sẽ bị xóa. Xác nhận xóa?"*
    Đồng thời Backend tự động xóa sạch các bản ghi bài nộp liên quan (orphan responses) trong bảng `responses`.
  * **Mục C:** **Bỏ hẳn IndexedDB**, chuyển toàn bộ sang gọi Neon API trực tiếp để tránh lệch cache và không lo bị ẩn khảo sát.
  * **Mục E:** Thêm endpoint `GET /api/storage` và thanh hiển thị % dung lượng Neon (kèm cảnh báo dọn dẹp khi dung lượng cao).
  * **Mục Bổ sung:** Thêm tính năng chọn hàng loạt (checkbox) và xóa hàng loạt ở cả 2 menu: **Khảo Sát Đã Lưu** và **Dữ Liệu Khảo Sát & Báo Cáo**.

---

## 🎯 3. DANH SÁCH CÔNG VIỆC TODO (TIẾN ĐỘ CHI TIẾT)

Dựa trên hình ảnh `todo opencode image copy.png` và các thay đổi trong code:

| STT | Hạng mục công việc | Trạng thái | Chi tiết triển khai |
| :--- | :--- | :---: | :--- |
| **A** | **Bỏ tự nạp preset, Builder trắng, chỉ nạp khi bấm Nạp Mẫu** | 🟢 **ĐÃ XONG** | • Đã sửa `index.html`: `initApp()` và `handleAdminLogin()` không còn tự gọi `loadBootcampPreset()`\.<br>• Builder khởi tạo trắng, chỉ nạp khi người dùng chủ động bấm `✨ Nạp Mẫu!`\. |
| **B** | **Cập nhật cảnh báo xóa survey + xóa orphan responses** | 🟢 **ĐÃ XONG** | • **Backend:** `functions/api/[[path]].js` & `worker.js` đã thêm lệnh xóa `DELETE FROM responses WHERE survey_id = $1` khi xóa survey\.<br>• **Frontend:** Đã cập nhật nội dung modal cảnh báo: *"Nếu xóa mẫu khảo sát này thì toàn bộ bài khảo sát liên quan sẽ bị xóa. Xác nhận xóa?"* |
| **C** | **Bỏ hẳn IndexedDB, chuyển toàn bộ sang Neon API** | 🟢 **ĐÃ XONG** | • **Backend:** Đã mở endpoint `GET /api/surveys` trả về danh sách toàn bộ khảo sát từ Neon DB\.<br>• **Frontend:** Đã thay thế toàn bộ các hàm gọi `DB.*` trong `index.html` sang gọi Neon API trực tiếp (`GET /api/surveys`, `POST /api/surveys`, `DELETE /api/surveys`, `GET /api/responses`). |
| **E** | **Thêm endpoint `/api/storage` và thanh % đầy ổ đĩa** | 🟢 **ĐÃ XONG** | • **Backend:** Endpoint `GET /api/storage` tính dung lượng `pg_database_size` so với quota 512 MB\.<br>• **Frontend:** Đã thêm giao diện thanh % streaming dung lượng trực quan trong tab *Dữ Liệu Khảo Sát & Báo Cáo* với mã màu động (Xanh/Vàng/Cam/Đỏ) và toast cảnh báo khi >90%\. |
| **+** | **Bổ sung: Chọn hàng loạt + xóa theo chọn cho cả 2 menu** | 🟢 **ĐÃ XONG** | • **Menu Khảo Sát Đã Lưu:** Thêm checkbox chọn từng mục, checkbox chọn tất cả, nút "Xóa đã chọn" gọi `DELETE /api/surveys?ids=...`\.<br>• **Menu Dữ Liệu Khảo Sát:** Thêm checkbox chọn từng bài nộp, checkbox chọn tất cả, nút "Xóa đã chọn" gọi `DELETE /api/responses?ids=...`\. |
| **✓** | **Test syntax và push main** | 🟢 **ĐÃ XONG** | • Đã kiểm tra toàn bộ cú pháp JS/HTML\.<br>• Commit và push lên GitHub repo `main`\. |

---

## 🛠️ 4. BƯỚC ĐÃ THỰC HIỆN ĐỂ HOÀN THIỆN TOÀN BỘ

1. **Cập nhật `index.html`:**
   * Thay thế hoàn toàn các thao tác IndexedDB bằng gọi trực tiếp `fetch('/api/surveys')` và `fetch('/api/responses')`.
   * Cập nhật modal cảnh báo xóa khảo sát với thông điệp chuẩn xác:
     > *"Nếu xóa mẫu khảo sát này thì toàn bộ bài khảo sát liên quan sẽ bị xóa. Xác nhận xóa?"*
   * Bổ sung thanh hiển thị dung lượng lưu trữ Neon Storage (% Bar) bên dưới hàng thống kê `stats-row`.
   * Bổ sung giao diện và logic Checkbox chọn hàng loạt + Nút xóa đã chọn ở cả tab *Khảo Sát Đã Lưu* và tab *Dữ Liệu Khảo Sát & Báo Cáo*.
2. **Cập nhật `worker.js` & `functions/api/[[path]].js`:**
   * Hỗ trợ xóa hàng loạt qua tham số `ids=...` cho cả `/api/surveys` và `/api/responses`.
   * Xóa sạch orphan responses khi xóa survey.
   * Cung cấp endpoint `GET /api/storage` và `GET /api/surveys` (all).
3. **Kiểm tra cú pháp & kiểm thử chức năng:**
   * Không còn lỗi cú pháp JavaScript hay HTTP method không hợp lệ.
4. **Commit & Push Git:**
   * Đưa toàn bộ các thay đổi hoàn chỉnh lên branch `main`.
