# Halaman Agen (`/agent`)

Satu halaman tempat satu agen mengerjakan tugas: menulis, menganalisis,
merancang, menelusuri sumber. Berbeda dari AI Studio (`/studio`) yang
menyimpan riwayat percakapan di `ai_conversations`/`ai_messages`, halaman ini
menyimpan utas di `localStorage` dan tidak menulis apa pun ke database.

## Alur satu giliran

```
browser ──POST /api/agent──▶ Worker
                              │ 1. bangun system prompt (+ skill yang dipin)
                              │ 2. panggil model (provider dari DB)
                              │ 3. balasan berisi ```tool? ──▶ jalankan alat
                              │ 4. hasil alat → model lagi (maks 3 putaran)
                              └─ SSE: meta/step/skill/delta/done/error ──▶ browser
```

Tool loop ada di server, bukan di browser, karena dua alasan: kunci provider
tidak pernah sampai ke klien, dan urutan alat tidak bisa dimanipulasi dari
kode klien. `done.reply` adalah satu-satunya teks yang menjadi pesan asisten.

## Alat

| Alat | Argumen | Batas |
| --- | --- | --- |
| `web_search` | `{query}` | ≤ 300 karakter, 8 sumber teratas |
| `read_url` | `{url}` | http(s) publik, host privat ditolak, 400 KB, 10 dtk, hasil 6.000 karakter |
| `load_skill` | `{skill, resource?}` | hanya skill yang ada di manifest |

## Lampiran (foto, video, audio, berkas)

Halaman agen dan AI Studio menerima unggahan **maksimal 100MB per berkas**
(6 lampiran per pesan di `/agent`), lewat bucket `ai-studio-uploads`.

- Batas ada di satu tempat: `src/lib/uploads.js` (`MAX_UPLOAD_BYTES`). Jangan
  menyalin angka itu ke komponen — versi sebelumnya punya 30MB di dua tempat.
- Batas **juga** ditegakkan di bucket (`file_size_limit`, migrasi
  `20261207000000_upload_limit_100mb.sql`), karena klien bisa dimanipulasi.
- Gambar dikirim ke model sebagai `image_url`; video, audio, dan berkas lain
  dikirim sebagai tautan berlabel (model tidak bisa "menonton" video).
- `/api/agent` memvalidasi ulang setiap URL lampiran: harus path public bucket
  `ai-studio-uploads` **dan** berada di prefiks `<user_id>/`, supaya agen tidak
  bisa dipakai menyuruh provider mengambil URL sembarangan atau membaca
  unggahan akun lain.
- Video/audio berukuran besar memang bisa diunggah, tetapi **tidak** otomatis
  menjadi input model video. Menghubungkannya ke `/api/video/generate`
  (image-to-video, dance, lip-sync) adalah pekerjaan terpisah.

Tidak ada eksekusi kode, shell, akses berkas, atau operasi tulis. Model diminta
menyebut batas itu, bukan berpura-pura sudah melakukannya.

## Skill dari `anthropics/skills`

Tiga skill Apache-2.0 disalin verbatim ke `src/agent/skills/<id>/`:

| id | dipakai untuk |
| --- | --- |
| `frontend-design` | arah desain, tipografi, layout yang tidak terasa template |
| `internal-comms` | 3P update, newsletter, FAQ, laporan status/insiden |
| `web-artifacts-builder` | deliverable HTML/React satu file |

Yang **tidak** diambil: `skill-creator` (mengajarkan format, bukan
kemampuan), `mcp-builder` (73 KB dan mengutip skrip yang tidak bisa dijalankan
di Worker), `brand-guidelines` (identitas visual Anthropic), serta
`docx`/`pdf`/`pptx`/`xlsx` (butuh sandbox eksekusi kode).

### Kenapa disalin, bukan diambil saat runtime

Worker tidak punya filesystem, dan mengambil Markdown dari GitHub pada setiap
permintaan menambah latensi, kuota, dan titik gagal. Teks ikut bundel.

### Integritas dan provenance

- `src/agent/skills/manifest.js` menyimpan SHA-256 setiap berkas.
- `loadSkillSection()` menghitung ulang hash dan **menolak** berkas yang tidak
  cocok; tidak ada jalur yang memuat teks tanpa verifikasi.
- `src/agent/skills/skills.generated.json` dibuat oleh
  `node tools/build-agent-skills.mjs` (JSON karena Vite *dan* esbuild Wrangler
  sama-sama bisa mengimpornya; `?raw` hanya jalan di Vite).
- `node tools/build-agent-skills.mjs --check` dijalankan CI, jadi mengubah
  Markdown tanpa regenerasi JSON akan menggagalkan build.
- Setiap bagian skill yang masuk prompt memuat kalimat bahwa ini panduan pihak
  ketiga Apache-2.0, bukan fitur produk Anthropic dan tidak disponsori
  Anthropic. `LICENSE.txt` disimpan di samping tiap skill.
- Setiap skill punya "overlay" (`SKILL_OVERLAYS`) yang menyatakan batas
  lingkungan BLEA — mis. `web-artifacts-builder` menyuruh menjalankan
  `scripts/init-artifact.sh`, yang tidak ada di sini.

### Menambah skill baru

1. Pastikan lisensinya Apache-2.0 (atau kompatibel). Jangan salin skill
   tanpa berkas lisensi.
2. Salin berkasnya ke `src/agent/skills/<id>/`.
3. Daftarkan di `manifest.js` berikut SHA-256 hasil `sha256sum`.
4. Jalankan `npm run skills:build`.
5. Tambahkan overlay jika teksnya menyuruh menjalankan skrip yang tidak ada.

## Harga per giliran (opsional)

Agen memakai beberapa panggilan model + pencarian web per giliran, jadi ada
modalitas harga tersendiri: `agent_turn` di `credit_model_prices`
(migrasi `20261206000000_agent_turn_price_modality.sql`). Admin mengaturnya di
**Admin Panel → API & Keys → Katalog Model → tarif "Agen (per giliran)"** pada
model chat yang dipakai agen.

- **Tanpa baris harga aktif** → giliran gratis, sama seperti `/api/chat`.
- **Dengan harga** → `spend_credits` dipanggil **sebelum** panggilan model
  pertama. Saldo kurang → HTTP 402 `insufficient_credits`, model tidak
  dipanggil.
- **Refund otomatis** (via `refund_credits`) jika model gagal dihubungi, ada
  error tak terduga, atau giliran berakhir di batas alat tanpa jawaban final
  (`done.credits = 0`).
- Modalitas ini sengaja terpisah dari `text` supaya mengaktifkan harga agen
  tidak ikut menagih chat biasa di AI Studio.

## Konfigurasi

Tidak ada variabel environment baru. Halaman memakai model chat yang aktif di
`provider_models` dan kunci di `provider_api_keys`, persis seperti `/api/chat`.
Model dipilih dari `/api/enabled-models`; jika model yang diminta pengguna
sudah tidak aktif, permintaan gagal dengan pesan jelas alih-alih diam-diam
pindah model (`resolveAgentModel`).

## Batas yang diketahui

- **Kualitas bergantung model.** Di paket gratis, model kecil sering lupa
  format blok `tool`. Batas 3 putaran dan pesan koreksi menjaga agar gagal
  dengan rapi, bukan berputar.
- **Tidak ada riwayat lintas perangkat.** Utas hanya di browser ini.
- **Hasil pencarian bisa usang/salah.** DuckDuckGo, Wikipedia, Stack Overflow,
  GitHub, Hacker News — sama seperti `/api/search`.
- **Biaya per giliran hanya menutup panggilan model.** Pencarian web dan
  `read_url` tidak dihitung terpisah; kalau biaya itu penting, naikkan harga
  `agent_turn` untuk mengompensasi, bukan menambah hitungan per alat.
- **Belum ada rate limit per pengguna.** Yang membatasi hanya kuota provider
  dan saldo kredit. Batas per akun (mis. X giliran/menit) belum ada; tempatnya
  di `handleAgentTurn` sebelum panggilan model pertama.

## Lampiran video, klip, dan subtitle

Alur lengkapnya, semuanya di sisi klien kecuali transkripsi:

1. **Analisis** (`src/lib/videoAnalysis.js`) — scene cut (selisih frame 64×36,
   2 fps) dan energi audio per detik. Ini **bukan** transkrip.
2. **Transkripsi** (`POST /api/agent/transcribe`) — browser men-decode audio
   menjadi WAV mono 16 kHz per potongan 5 menit (`src/lib/audioExtract.js`),
   lalu Worker memanggil `@cf/openai/whisper-large-v3-turbo` lewat binding
   `env.AI`. Butuh binding `ai` di `wrangler.jsonc`; tanpa itu endpoint membalas
   503 dengan pesan jelas. `language: 'auto'` membiarkan Whisper mendeteksi
   bahasa; bahasa yang terdeteksi dikembalikan sebagai `language`.
3. **Rencana klip** (`propose_clips` + `src/lib/clipPlanner.js`) — agen hanya
   mengusulkan; tidak ada pemotongan tanpa klik pengguna.
4. **Ekspor subtitle** (`src/lib/subtitles.js`) — SRT/VTT. SRT per klip memakai
   `sliceTranscript` sehingga timestamp sudah relatif ke awal klip.
5. **Burn-in** (`src/lib/subtitleBurnIn.js`) — opsional, dicentang di panel
   klip. Canvas + `MediaRecorder`, realtime, dan audio diambil lewat Web Audio
   (canvas tidak membawa audio). Tidak ada ffmpeg di Worker; ini satu-satunya
   jalur tanpa server.

### Batas yang harus diketahui

- Burn-in **realtime**: klip 40 detik ≈ 40 detik render, tab harus terbuka.
- Kualitas turun karena re-encode; lebar canvas dibatasi 1280 px.
- Transkrip bisa diedit, tetapi edit memetakan baris secara berurutan — tidak
  ada re-timing otomatis.
- Batas 8 MB per potongan audio (base64 → ~10,7 MB body), 4 potongan per
  permintaan, jadi satu permintaan menangani ~20 menit audio.
- Kuota neuron Workers AI belum diukur; kalau habis, endpoint membalas error
  dari Cloudflare apa adanya.

## Studio (beranda alat)

Sejak halaman Agen dan Chat AI digabung, `/studio` bukan lagi percakapan: itu
daftar alat (`src/studio/toolCatalog.js`). Setiap kartu membuka ruang kerja
sendiri di `/studio/:toolId`:

| Tool | Rute | Komponen |
| --- | --- | --- |
| Chat & Tulis | `/studio/chat` | `AIStudio` |
| Agen Otonom | `/studio/agent` | `AgentPage` |
| Buat Gambar | `/studio/image` | `GenerateImagePanel` |
| Buat Musik | `/studio/music` | `GenerateMusicPanel` |
| Cek Metadata | `/studio/metadata` | `MetadataCheckPage` |
| Koneksi | `/studio/connection` | `ConnectionPage` |

`/agent` dipertahankan sebagai redirect ke `/studio/agent`; tidak ada tautan
lama yang pecah. Ruang kerja memakai komponen yang sudah ada, bukan salinan,
supaya tidak ada dua versi form.

Tool yang mesinnya belum ada (video saat OAuth freebeat putus) tetap tampil
dengan status `Terbatas`, dan halamannya menjelaskan alasannya alih-alih
menampilkan form yang pasti gagal.

### Yang sengaja tidak dibangun

Alur "klik CONNECTION → BLEA membuat email temp → mendaftarkan akun ChatGPT →
mengambil kode verifikasi → akun terhubung". Itu tidak diimplementasikan karena
tidak ada API pendaftaran resmi (hanya otomasi halaman signup, yang melanggar
ToS), rapuh terhadap captcha, dan menempatkan risiko banned pada pemilik akun
BLEA. Koneksi provider tetap hanya lewat API key/OAuth resmi.
