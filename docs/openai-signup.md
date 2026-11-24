# Akun OpenAI: daftar, simpan, dan kemampuan yang dipakai Studio

Halaman: **Studio → Akun OpenAI** (`/studio/openai-accounts`).

Satu jalur, seluruhnya di browser Anda:

```
platform.openai.com/login → email TempMail → Continue → kode 6 digit
→ platform.openai.com/home → API keys → Create new secret key → sk-…
→ kembali ke BLEA → "Tambah akun manual"
```

## Langkah di panel

| Langkah | Tombol | Yang terjadi |
|---|---|---|
| 1. Buat akun | **Siapkan & buka daftar** | Tab `platform.openai.com/login` terbuka; email TempMail ditempel, Continue, kode 6 digit. |
| 2. Ambil kode | **Cari email verifikasi** | BLEA membaca inbox TempMail, menampilkan kode; Anda menempelnya di tab platform. |
| 3. Simpan | **Tambah akun manual** | API key (`sk-…`) disegel (AES-GCM) dan masuk pool. |

Kolom email **tidak** terisi otomatis: halaman login platform tidak memakai
`login_hint`, dan halaman BLEA tidak boleh menyentuh DOM domain lain
(same-origin policy). Karena itu ada tombol **Salin email**, ditambah
bookmarklet/userscript opsional yang hanya mengisi kolom — tidak pernah menekan
**Continue**.

### Kenapa `/login` sah dibuka dengan GET

Diuji langsung ke server OpenAI: `/home`, `/api-keys`, dan
`/settings/organization/billing/overview` semuanya 302 ke `/login?next=…` bila
belum masuk. Jadi `/login` halaman, bukan endpoint POST. `next` dibatasi daftar
tetap (`/home`, `/api-keys`, `/settings/organization/billing/overview`) di
`buildPlatformSignupUrl`, jadi tidak bisa dipakai sebagai open redirect.

### Yang TIDAK dilakukan BLEA

- Tidak mem-POST formulir dari server: Cloudflare Worker diblokir ke domain
  OpenAI, dan pendaftaran otomatis melanggar Terms of Use.
- Tidak membaca/menyimpan cookie atau token sesi browser. Yang disimpan hanya
  email, URL yang dibuka, langkah terakhir, dan kode verifikasi (sekali pakai,
  bukan kredensial login).
- Tidak memakai halaman login konsumen sebagai jalur daftar. Jalur itu
  ditujukan untuk aplikasi (callback-nya deep link), sehingga setelah verifikasi
  halaman berputar menunggu aplikasi. Jalur platform berakhir di
  `platform.openai.com/home` yang bisa dilanjutkan.

## Kemampuan platform ↔ tool Studio

`src/lib/openaiCapabilities.js` memetakan tab **Kemampuan API** di platform ke
tool Studio. Halaman Akun OpenAI menampilkan tabel yang sama (dilipat), termasuk
baris yang **belum** dipakai — supaya jelas kenapa angkanya nol di platform.

| Kemampuan OpenAI | Tool Studio | Status |
|---|---|---|
| Respons dan penyelesaian obrolan | Chat & Tulis | dipakai — `POST /v1/responses` |
| Keputusan (reasoning) | Agen Otonom | dipakai — model penalaran + loop alat |
| Pencarian web | Agen & Riset | dipakai — alat `web_search`/`read_url` milik BLEA |
| Gambar | Buat Gambar | dipakai — `POST /v1/images/generations` |
| Audio pidato (TTS) | Klip & Subtitle | belum — `v1/audio/speech` belum dipanggil |
| Transkripsi audio | Analisis Berkas | dipakai — Workers AI Whisper (`env.AI`), bukan kuota OpenAI |
| Penyematan (embeddings) | — | belum |
| Pencarian file | — | belum — `v1/files` + `v1/vector_stores` |
| Moderasi | — | belum — `v1/moderations` |
| Penyimpanan vektor | — | belum |
| Sesi interpreter kode | — | belum |
| Kontainer yang dihosting OpenAI | — | belum |

Kapabilitas yang bisa dicentang per akun (`capabilities` di tabel
`openai_accounts`): `chat`, `agent`, `image`, `video`, `audio`, `music`,
`metadata`. Daftar ini dipakai tiga tempat sekaligus — validasi input, centang di
form akun, dan pemeriksaan isolasi tool (`src/lib/toolCapabilities.js`) — jadi
tidak ada salinan yang bisa menyimpang.

## OAuth tanpa API key (opsional)

Tombol **Connect OpenAI** memakai OAuth PKCE resmi. Batasannya jelas:

- Hanya untuk **teks** (Responses API): chat & agen. Token ini tidak bisa
  memanggil gambar/video/audio.
- `redirect_uri` wajib loopback `http://127.0.0.1:<port>/auth/callback`. Kalau
  BLEA dibuka dari domain publik, halaman callback tidak bisa dijangkau browser
  — tempel URL callback-nya di kolom yang disediakan.
- Persetujuan harus memakai `client_id` yang sama dengan saat authorize;
  callback dengan `client_id` berbeda ditolak (409) sebelum kode ditukar.

### Audit `invalid_grant` (bukti, bukan dugaan)

Percobaan nyata di `openai_oauth_links` (`52c57983-…`): `status=failed`,
`issued_client_id = requested_client_id = oaiapp_Qq7G8m2DtkWq6erQyKk5ZXWxn`,
`error_message` memuat
`mode=issued redirect=http://127.0.0.1:39178/auth/callback verify=20fc9b7f6c87 resource=1 status=400 body={"error":"invalid_grant"}`.

- Umur baris `created_at → updated_at` = **30 detik penuh**, tepat di rentang
  `AbortSignal.timeout(30_000)` — bukan "ditukar pada detik ke-71".
- Yang **gugur**: halaman callback dimuat dua kali (klaim kode pertama berhasil,
  klaim kedua ditolak 409 sebelum ke OpenAI), dan izin paket tidak dicentang
  (`scope` di URL callback memuatnya).
- Retry tanpa `resource` sudah dihapus; jangan dikembalikan.

## Kenapa API key ditolak walau akun "bisa chat"

Dua jalur OpenAI yang **tidak** saling berbagi kuota:

| Jalur | Yang dipakai | Tanpa pembayaran |
|---|---|---|
| `platform.openai.com` → API key (`sk-…`) | saldo kredit **API** | gagal `429 credit_balance_exhausted` |
| `chat.openai.com` / aplikasi ChatGPT | langganan ChatGPT | jalan bila ada langganan |

Chat di aplikasi OpenAI bisa jalan sementara API key ditolak karena keduanya
anggaran yang berbeda. Hal yang sama berlaku untuk **Usage tiers** di menu
Limits: `Free tier` di sana adalah **tingkat batas laju** (RPM/TPM), bukan
kredit gratis. OpenAI tidak lagi memberi kredit gratis saat mendaftar; API baru
jalan setelah organisasi punya saldo prabayar (minimum pembelian US$5).

### Kode 429 yang wajib dibedakan

Semuanya HTTP 429 dengan `type: insufficient_quota`, jadi `type` saja tidak
cukup — BLEA membaca `error.code` (`openAiErrorCodeHint` di
`src/lib/openaiPool.js`):

| `error.code` | Arti | Tindakan |
|---|---|---|
| `credit_balance_exhausted` | saldo prabayar organisasi nol | Billing → **Add credits** |
| `organization_spend_limit_exceeded` | batas belanja organisasi | Settings → Limits |
| `project_spend_limit_exceeded` | batas belanja proyek | Settings → Limits |
| `organization_usage_limit_exceeded` | batas pemakaian dari OpenAI | minta limit lebih tinggi (Usage tiers) |
| `rate_limit_exceeded` / `slow_down` | laju permintaan terlalu cepat | tunggu `Retry-After` |

`GET /v1/models` tetap **200** walau saldo nol, jadi tombol **Uji** di
`/studio/openai-accounts` tidak berhenti di situ: setelah kunci diterima ia
memanggil satu kali `POST /v1/chat/completions` termurah untuk membuktikan
billing. Tanpa langkah itu, akun tanpa kredit tampil "berhasil diuji" padahal
chat pasti gagal.

Akun yang gagal karena billing ditahan (state `kredit-habis`) sampai diperbaiki
— tidak dicoba ulang setiap cooldown habis, dan tidak dilaporkan sebagai
"cooldown" di UI.

## Jalur OAuth: siapa yang bisa memakainya

Jalur ini memakai paket ChatGPT pengguna, bukan saldo API, jadi **syaratnya
paket**, bukan sekadar bisa login:

| Kondisi akun | Login OAuth | Pemakaian paket |
|---|---|---|
| Tanpa langganan (Free) | berhasil | **ditolak** `403 subscription_sharing_user_not_eligible` |
| Go | berhasil | ditolak (sama seperti Free) |
| Plus / Pro (akun pribadi) | berhasil | berjalan |
| Business / Enterprise / Edu | berhasil | perlu izin admin workspace |

Login yang berhasil **tidak** berarti paketnya boleh dipakai: keduanya izin
terpisah. Kode `subscription_sharing_*` ditangani sebagai sebab tersendiri
(`openaiPool.planUsageFailure`), bukan sebagai "kunci ditolak" atau "kredit
habis" — akun OAuth tidak punya saldo sama sekali.

| `error.code` | Arti | Tindakan |
|---|---|---|
| `subscription_sharing_user_not_eligible` | akun/workspace tidak boleh membagikan paket | permanen untuk akun itu; pindah ke API key atau akun Plus/Pro |
| `subscription_sharing_usage_limit_exceeded` | batas pemakaian paket tercapai | tunggu / tambah akun; lihat Settings → Usage |
| `subscription_sharing_usage_unavailable` | pemakaian tidak bisa diperiksa | coba lagi nanti |
| `subscription_sharing_invalid_user` | sesi OAuth tidak dikenali | login ulang lewat Connect |
| `subscription_sharing_unsupported_capability` | isi permintaan tidak didukung | jalur ini hanya teks |

Akun yang kena `not_eligible` ditandai `paket-tidak-boleh` dan **berhenti
dicoba** (bukan "cooldown"), karena mengulang login tidak mengubah keputusan
OpenAI.

### Pesan 401 bukan penolakan OpenAI

Tombol **Connect** memanggil `/api/openai-oauth/start` yang butuh sesi BLEA.
Bila sesi itu tidak ada atau sudah kedaluwarsa, jawabannya `401`
`auth_required` — dan **OpenAI belum dilibatkan sama sekali** (tidak ada satu
pun baris `openai_oauth_links`). Pesan lama "Login diperlukan." mudah dibaca
sebagai "OpenAI menolak", jadi sekarang dibedakan:

| Keadaan | Pesan |
|---|---|
| permintaan tanpa token | "Halaman ini belum login (atau sesinya baru kedaluwarsa) — masuk dulu" |
| token ada, ditolak Supabase | "Sesi BLEA tidak diterima server … Ini belum menyentuh OpenAI sama sekali." |

Cara membedakan dari data: kalau tombol benar-benar sudah memulai alur,
`openai_oauth_links` berisi satu baris `pending` (ditulis SEBELUM browser
dibuka). Nol baris = permintaan tidak pernah lolos autentikasi.

### Model dipilih dari katalog akun, bukan ditebak

Jalur paket memakai katalog **per akun**: `GET /v1/models` dengan access token
mengembalikan `{models:[{slug, …}]}`. Dulu `model_default` diisi tebakan
`gpt-5.1`; bila akun tidak punya model itu, setiap chat gagal `model_not_found`
padahal tokennya sehat. Sekarang:

1. saat pendaftaran OAuth, model dipilih dari katalog akun
   (`planModelFromCatalog`);
2. saat chat, `model_not_found` tidak langsung dianggap gagal — katalog dibaca
   lalu permintaan diulang **sekali** dengan model yang benar-benar dimiliki;
3. tombol **Uji** memakai model dari katalog yang sama.

### Uji akun OAuth

`GET /v1/models` tetap 200 walau izin paket tidak diberikan, jadi Uji tidak
berhenti di situ: ia memanggil satu kali `POST /v1/responses`
(`store:false`, `stream:true`) untuk membuktikan izinnya. Batas pemakaian
dilaporkan sebagai "sedang kena batas", bukan sebagai akun rusak.

## Nama internal & database

Istilah lama "chatgpt" sudah dihapus dari kode, label, dokumen, dan nama objek
database:

| Sebelum | Sesudah |
|---|---|
| `chatgpt_accounts` | `openai_accounts` |
| `chatgpt_oauth_links` | `openai_oauth_links` |
| `chatgpt_signup_attempts` | `openai_signup_attempts` |
| `studio_generations.chatgpt_account_id/label` | `openai_account_id/label` |
| `/api/chatgpt-*`, `/studio/chatgpt-accounts` | `/api/openai-*`, `/studio/openai-accounts` |

Migrasi `20261214000000_rename_openai_tables.sql` melakukan rename di tempat
(idempoten, data tidak disalin). Satu pengecualian disengaja: nama scope OAuth
`chatgpt.tokens.use.direct` adalah identifier milik OpenAI, jadi ditulis apa
adanya — menggantinya akan membuat permintaan izin gagal.

## Berkas

| Bagian | Berkas |
|---|---|
| Aturan & helper murni | `src/lib/openaiSignup.js` |
| Kapabilitas ↔ tool | `src/lib/openaiCapabilities.js` |
| Rute API `/api/openai-signup` | `src/lib/openaiSignupRoute.js` + `src/worker.js` |
| UI pendaftaran (langkah 1–3) | `src/studio/OpenAiSignupPanel.jsx` |
| UI simpan akses (OAuth) | `src/studio/OpenAiOAuthPanel.jsx`, `src/studio/openaiOAuthClient.js` |
| Pool akun | `src/lib/openaiPool.js` |
| Uji | `tests/openai-signup.test.js`, `tests/openai-oauth.test.js`, `tests/openai-pool-and-library.test.js` |
