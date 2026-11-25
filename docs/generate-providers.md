# Generate: gambar dan video multi-provider

Halaman `/generate` memisahkan pilihan **Generate gambar** dan **Generate video**. Integrasi setiap provider dan famili model harus dibuat dan diverifikasi secara terpisah; label atau model di katalog tidak otomatis membuktikan kemampuan API provider.

## Gambar

Halaman Generate menampilkan daftar model dari `/api/image/config`: entri Freebeat 122 (jalur Freebeat consumer yang sudah ada) dan model gambar **Alibaba Model Studio** yang sudah diimplementasikan dengan adapter per famili:

- **Messages Async (`POST {base}/api/v1/services/aigc/image-generation/generation` + `X-DashScope-Async: enable`, hasil `output.choices[].message.content[].image`)**:
  - `wan2.7-image`, `wan2.7-image-pro` (`1K`/`2K`, `n=1`, opsional 1–4 gambar sumber).
  - `qwen-image-3.0`, `qwen-image-3.0-pro` (preset `1664*928`, `1472*1104`, `1328*1328`, `1104*1472`, `928*1664`, `n=1..6`, `prompt_extend: true`, opsional ≤3 gambar sumber).
  - `qwen-image-2.0`, `qwen-image-2.0-2026-03-03`, `qwen-image-2.0-pro`, `qwen-image-2.0-pro-2026-03-03/-04-22/-06-22`, `qwen-image-2.1-pro`, `qwen-image-2.1-turbo` (ukuran `LEBAR*TINGGI` sisi 512–2048, default `2048*2048`, `n=1..6`, opsional ≤3 gambar sumber).
  - `wan2.6-t2i` (`1280*1280` s/d `1440*1440`, `n=1..4`, teks saja).
- **Wan 2.6 Image (`wan2.6-image`, endpoint `image-generation/generation`)**:
  - Tanpa gambar input: mode interleaved (`enable_interleave: true`, `n: 1`, `max_images: 1..5`, total piksel `768^2–1280^2`, rasio `1:4–4:1`).
  - Dengan 1–4 gambar input: mode edit (`enable_interleave: false`, `n: 1..4`, `prompt_extend: true`, ukuran `1K`/`2K` atau `768^2–2048^2`).
- **Legacy T2I (`POST {base}/api/v1/services/aigc/text2image/image-synthesis` + `X-DashScope-Async: enable`, `input.prompt` string, hasil `output.results[].url`)**:
  - `wan2.5-t2i-preview` (total piksel `1280^2–1440^2`, rasio `1:4–4:1`, `n=1..4`, prompt ≤2000 karakter).
  - `wan2.2-t2i-plus`, `wan2.2-t2i-flash`, `wan2.1-t2i-plus`, `wan2.1-t2i-turbo` (sisi 512–1440, total maks `1440*1440`, `n=1..4`, prompt ≤500 karakter; `wan2.1-*` otomatis dipetakan ke `wanx2.1-*` bila base URL region China Beijing).
- **Wan 2.5 I2I (`wan2.5-i2i-preview`, endpoint `image2image/image-synthesis` + `X-DashScope-Async: enable`)**:
  - Wajib 1–4 gambar sumber (`input.images[]`), total piksel `768^2–1280^2`, rasio `1:4–4:1`, `n=1..4`.
- **Z-Image-Turbo (`z-image-turbo`, SYNC `POST {base}/api/v1/services/aigc/multimodal-generation/generation`)**:
  - Sinkron tanpa `X-DashScope-Async`, sisi 512–2048 (default `1024*1024`), `n=1`, `prompt_extend: false`, prompt ≤800 karakter, hasil langsung `output.choices[].message.content[].image`.

Model yang muncul di `/api/image/config` hanya jika semuanya terpenuhi: admin mengaktifkannya di Katalog Model (`provider=alibaba`, aktif), menetapkan harga kredit aktif di Admin → Kredit (`modality=image`), dan minimal satu akun Alibaba Cloud tersedia di pool/key admin. `qwen-mt-image-2.0` (model terjemahan gambar) tetap dikecualikan (`blea: null`).

Alur gambar pengguna: periksa akun aktif → lookup harga `credit_model_prices` (`active=eq.true`) → debit `spend_credits` → kirim ke endpoint sesuai famili model → simpan di `image_generations` → untuk model async polling `GET {base}/api/v1/tasks/{task_id}` lewat `/api/image/status` (atau langsung selesai untuk model sinkron). Kegagalan definitif sebelum tugas terdaftar memicu refund otomatis; kegagalan jaringan/timeout TIDAK di-refund otomatis (status `unknown`, jangan ulangi). Refund otomatis juga terjadi bila provider melaporkan tugas FAILED. Error upstream disanitasi (`redactUpstreamDetail`) sebelum diteruskan.

Untuk pengujian admin Freebeat (OAuth dengan izin gambar di `/admin/freebeat`), alurnya tetap seperti sebelumnya: quote, persetujuan per pengiriman dengan `max_credits`, receipt terikat sesi, dan penguncian hasil tidak pasti seperti dijelaskan di `freebeat-mcp.md`. Uji ini memakai kredit akun Freebeat admin dan bukan pembelian atau pemotongan kredit BLEA.

## Video

Halaman Generate Video menampilkan hanya model video yang ditandai aktif di Admin Panel (atau fallback bawaan `wan3.0-video`) dan memiliki provider dengan kredensial serta base URL yang dapat digunakan. Untuk provider `alibaba`, hanya model video dengan adapter per famili terverifikasi di `ALIBABA_VIDEO_MODEL_SPECS` (`src/lib/videoCatalog.js`) yang diizinkan tampil dan diterima oleh `/api/video/generate`:

- **Wan 3.0 (`wan3.0-video`, `wan3.0-video-prime`)**: `video-generation/video-synthesis` dengan `input.media[]` (`first_frame` + opsional `last_frame`, ATAU referensi multi-modal hingga 10 foto + 5 video + 5 audio, maks 20 total; kedua mode saling eksklusif).
- **Wan T2V (`wan2.6-t2v`, `wan2.5-t2v-preview`, `wan2.2-t2v-plus`, `wan2.1-t2v-plus`, `wan2.1-t2v-turbo`)**: `video-generation/video-synthesis`, `input.prompt` + opsional `audio_url` (2.6/2.5), `parameters.size` format `W*H` sesuai tier resolusi/rasio resmi; tanpa input gambar/video.
- **Wan I2V (`wan2.6-i2v`, `wan2.6-i2v-flash`, `wan2.5-i2v-preview`, `wan2.2-i2v-flash` 480P/720P, `wan2.2-i2v-plus`, `wan2.1-i2v-turbo`, `wan2.1-i2v-plus`)**: `video-generation/video-synthesis`, wajib First Frame (`input.img_url`), tanpa `ratio` (rasio mengikuti gambar), opsional `audio_url` (2.6/2.5).
- **Wan R2V (`wan2.6-r2v`, `wan2.6-r2v-flash`)**: `video-generation/video-synthesis`, `input.prompt` + `input.reference_urls[]` (1–3 foto atau 1–5 video), `parameters.size` + `duration` 2–10 dtk.
- **Wan KF2V (`wan2.2-kf2v-flash`, `wan2.1-kf2v-plus`)**: `image2video/video-synthesis`, wajib `first_frame_url` dan `last_frame_url`. ID salah ejaan `wan2.1-kf2iv-plus` tetap diblokir.
- **Wan Animate (`wan2.2-animate-move`, `wan2.2-animate-mix`)**: `image2video/video-synthesis`, wajib `image_url` (karakter) + `video_url` (penggerak), `parameters.mode` (`wan-std` 720p / `wan-pro` 1080p).
- **Wan VACE (`wan2.1-vace-plus`)**: `video-generation/video-synthesis`, `input.function` (`image_reference`, `video_repainting`, `video_extension`), 720p 5 detik.
- **HappyHorse 1.0 & 1.1**: `happyhorse-1.1-t2v` / `1.0-t2v` (prompt saja), `1.1-i2v` / `1.0-i2v` (wajib `media: [{ type: 'first_frame' }]`, tanpa `ratio`), `1.1-r2v` / `1.0-r2v` (wajib 1–9 `media: [{ type: 'reference_image' }]`), `1.0-video-edit` (wajib `video` + 0–5 `reference_image` + `audio_setting`).
- Seluruh model `wan2.1-*` otomatis dipetakan ke `wanx2.1-*` bila base URL menunjuk region China (Beijing). Model non-video dan ID belum terverifikasi (`wan2.1-kf2iv-plus`, `wan2.7-image`, `gui-plus`, dll.) tetap ditolak `400` sebelum memanggil provider.

Status verifikasi: adapter per famili, validasi input, pemetaan region Beijing, redaksi error upstream, serta pengujian unit/integrasi dengan respons provider yang di-mock lulus. Uji end-to-end langsung dengan API Alibaba dan akun sungguhan belum dijalankan di sini dan menunggu uji admin pada kredensial live.

UnoRouter tidak lagi ditampilkan di katalog video dan `/api/video/models` tidak meminta katalog UnoRouter. `/api/video/generate` menolak provider tersebut atau provider kosong; ini tidak menghapus kredensial atau pengaturan UnoRouter dari fitur Chat/Admin, dan tidak menghapus riwayat video lama. Riwayat lama tetap dapat dipantau/diakses melalui mekanisme sebelumnya. Provider tanpa base URL valid tidak boleh jatuh diam-diam ke URL provider lain.

**Batasan penting:** jalur video lama (`/api/video/generate`) belum menegakkan saldo/debit kredit BLEA, idempotensi tagihan, atau quote Freebeat. Pemanggilan melalui provider video dapat memakai saldo/kuota provider; angka harga historis pada katalog bukan konfirmasi biaya. Pembelian kredit BLEA tetap nonaktif. Freebeat image-to-video belum dihubungkan ke `/generate`.

## Diagnostik kegagalan Singing / Lip-Sync Freebeat

Pesan `Permintaan lip-sync video gagal dikirim ke Freebeat` pada versi lama
menggabungkan penolakan tool, error HTTP, kegagalan transport, dan respons tidak
valid. Pesan itu sendiri bukan bukti error ekstensi browser, saldo provider
habis, atau parameter media tertentu salah. Respons mentah lama tidak disimpan,
sehingga alasan spesifiknya tidak dapat dipulihkan dari pesan ini.

Worker kini menambahkan tag tetap `FB-VOCAL-*` ke pesan kegagalan dan menyimpan
`metadata.dispatch_failure` pada baris `video_generations`: kategori, status HTTP
atau kode RPC numerik jika tersedia, serta alasan terstruktur dari daftar aman.
Contoh: `FB-VOCAL-HTTP; HTTP 400` atau
`FB-VOCAL-TOOL-REJECTED; RPC -32602; invalid_parameter`. Kode provider yang tidak
dikenal dan pesan bebas tidak diteruskan; tidak ada token, URL, atau body respons
mentah yang ditambahkan ke diagnostik. Ini memperbaiki observabilitas, bukan
menjamin generasi Freebeat berhasil. Perubahan Worker perlu dideploy dahulu.

Cocokkan refund BLEA dengan `credit_ledger.generation_id`, bukan hanya teks UI.
Refund BLEA tidak membuktikan Freebeat tidak membuat tugas atau tidak memakai
kredit provider: timeout/hasil tidak valid setelah dispatch masih mungkin
terjadi setelah tugas diterima. Penanganan refund lama untuk kasus ini belum
diubah oleh patch diagnostik. Periksa aktivitas Freebeat sebelum mengulang;
jangan menjalankan generasi berbayar otomatis hanya untuk menguji diagnostik.

## Upload video ditolak karena ukuran Storage

`The object exceeded the maximum allowed size` adalah penolakan ukuran objek
oleh Supabase Storage pada tahap upload, sebelum URL input berhasil dipasang ke
form generasi. Batas aplikasi/video 100 MiB (`104857600` byte) bukan jaminan bahwa
Storage menerima ukuran itu. Batas efektif mengikuti nilai terendah antara
pengaturan global proyek Storage dan `storage.buckets.file_size_limit`.

Untuk proyek BLEA, bucket `ai-studio-uploads` telah terverifikasi bernilai
`104857600` byte pada 25 November 2026. Nilai global belum diverifikasi; jangan
mengklaim batas global pasti 50 MB, mengganti paket, atau menaikkan bucket lagi
tanpa memeriksanya. Migrasi SQL bucket tidak mengubah pengaturan global proyek.

Admin perlu membuka Supabase Dashboard → Storage → Settings untuk memeriksa
batas ukuran file global, lalu memeriksa konfigurasi bucket. Jika proyek/plan
mengizinkan, sesuaikan batas global agar mendukung batas aplikasi. Jangan
menaikkan batas melebihi kebutuhan atau mengubah billing tanpa persetujuan.
Konektor yang dipakai pada pemeriksaan ini tidak menyediakan pembacaan/perubahan
konfigurasi global Storage, sehingga patch aplikasi tidak mengubah batas server.

Untuk segera melanjutkan, kompres/potong file hingga di bawah batas aktual, atau
gunakan kolom URL HTTPS publik di form Lip-Sync. URL harus bisa diakses Freebeat
dan tetap memenuhi batas provider. Memecah request menjadi chunk/TUS tidak
mengatasi batas maksimum per objek. Pesan upload kini menjelaskan penolakan ini,
termasuk ukuran file jika diketahui, tanpa menampilkan respons mentah. Error SDK
yang dikembalikan maupun dilempar ditangani, tanpa retry atau pengiriman generasi
otomatis. Ini bukan perbaikan batas global maupun error generate Freebeat.
