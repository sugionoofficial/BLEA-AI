# Daftar ChatGPT dengan email TempMail

Fitur ini ada di **Studio → Akun ChatGPT** (`/studio/chatgpt-accounts`), panel
*Daftar ChatGPT dengan email TempMail*. Kode:

| Bagian | Berkas |
|---|---|
| Aturan & helper murni | `src/lib/chatgptSignup.js` |
| Rute API `/api/chatgpt-signup` | `src/lib/chatgptSignupRoute.js` + `src/worker.js` |
| UI panel | `src/studio/ChatGptSignupPanel.jsx`, `src/studio/chatgptSignupClient.js` |
| Tabel jejak | `supabase/migrations/20261213000000_chatgpt_signup_attempts.sql` |
| Uji | `tests/chatgpt-signup.test.js` |

## Kesalahan yang sudah diperbaiki: URL endpoint POST dibuka dengan GET

Versi pertama fitur ini membuka
`https://chatgpt.com/api/auth/signin/openai?prompt=login&screen_hint=signup&login_hint=…`
di tab browser. Hasilnya selalu halaman:

> **Kami tidak dapat memproses upaya masuk Anda. Coba lagi**

Sebabnya bukan captcha dan bukan jaringan: `/api/auth/signin/openai` adalah
**endpoint POST NextAuth**, bukan halaman. Kontraknya (terlihat pada SDK ChatGPT
yang memakai `GET /api/auth/csrf` lalu `POST {provider}?prompt=login` dengan
`callbackUrl` + `csrfToken`):

| Langkah | Request | Hasil |
|---|---|---|
| 1 | `GET /api/auth/csrf` | `{ csrfToken }` + cookie `__Host-next-auth.csrf-token` |
| 2 | `POST /api/auth/signin/openai` (form: `csrfToken`, `callbackUrl`, `login_hint`) | 302 ke `auth.openai.com/…` |

Tanpa langkah 1, langkah 2 selalu gagal — itulah pesan error di atas. Jadi
membuka URL itu dengan navigasi biasa (GET) **tidak akan pernah** sampai ke
formulir daftar, dan email TempMail tidak pernah terkirim.

Perbaikan pertama: `buildSignupUrl` mengembalikan **halaman**
`https://chatgpt.com/auth/login` (bisa dibuka dengan GET), tetap membawa
`login_hint` = email TempMail.

## Kesalahan kedua: `chatgpt.com/auth/login` tetap tidak menampilkan formulir

Dua percobaan nyata pada 2026-11-23 menunjukkan halaman itu tetap buruk:

1. Kunjungan pertama: halaman error **"ChatGPT tidak dapat menyiapkan pemuatan
   ini"** — tidak ada kolom email, jadi tidak ada yang bisa dikirim.
2. Setelah cookie `chatgpt.com` dihapus dan dicoba lagi: tab **langsung masuk ke
   beranda chatgpt.com** tanpa formulir sama sekali.

## Kesalahan ketiga (dan yang saya buat sendiri di #196)

`https://auth.openai.com/log-in` dibuka **tanpa cookie** dan hasilnya bukan
formulir, melainkan halaman perpisahan:

> **Sesi Anda telah berakhir** — Lanjutkan dengan masuk, atau gunakan
> ChatGPT.com tanpa akun

Halaman itu hanya masuk akal kalau perangkat sudah punya sesi yang diputus.
Memilih URL ini di #196 adalah kesalahan saya: saya menguji halaman dari luar
browser (tanpa cookie) dan salah membaca hasilnya sebagai "formulir biasa".

## URL yang sekarang dipakai (diuji langsung ke server OpenAI)

```
https://chatgpt.com/auth/login_with?callback_path=/&screen_hint=signup
```

Hasil pengujian per variasi:

| URL | Hasil |
|---|---|
| `chatgpt.com/auth/login_with?callback_path=/&screen_hint=signup` | **"Create an account"** di `auth.openai.com/create-account` — ada kolom email, Continue, dan tautan "Already have an account? Log in" |
| `chatgpt.com/auth/login_with?callback_path=/` | "Welcome back" (login), bukan daftar |
| `chatgpt.com/auth/login_with` **tanpa** `callback_path` | **HTTP 500** |
| `callback_path=%2F` (ter-encode) | **HTTP 500** — harus literal `/` |
| `chatgpt.com/auth/login_with?callback_path=/&prompt=login` | **HTTP 500** |
| `chatgpt.com/auth/login?prompt=login&screen_hint=signup` | 200 dari luar browser, **tetapi gagal di browser pengguna** |

Jadi: `callback_path=/` harus literal, `screen_hint=signup` wajib untuk memilih
halaman daftar, dan `prompt=...` **haram** di jalur ini (walau baik-baik saja di
`/auth/login` — beda halaman, beda perilaku).

**Yang belum terbukti:** apakah `/auth/login_with` benar-benar melewati error
"tidak dapat menyiapkan pemuatan ini" yang terjadi di browser pengguna. Itu
hipotesis kuat (ini jalur yang dipakai tombol "Log in" milik OpenAI sendiri),
bukan fakta. Karena itu panel sekarang punya **Periksa sesi ChatGPT**, yang
memisahkan masalah sesi/perangkat dari masalah URL.

Akibat yang harus diterima:

| Sebelumnya | Sekarang |
|---|---|
| URL membawa `prompt`, `screen_hint`, `login_hint`, `auth_session_logging_id` | URL **polos** tanpa parameter |
| Diklaim `login_hint` diabaikan OpenAI | `login_hint` **tidak dijanjikan** sama sekali (`supported.login_hint = false`) |
| Tombol di UI bernama "Lanjutkan" | Tombol di formulir bernama **Continue** |

Alasan parameter dibuang: formulir Auth0 tidak terbukti memakai `login_hint`,
dan parameter karangan pada halaman itu justru bisa memicu halaman error. Lebih
baik URL polos yang jelas berhasil memuat formulir daripada URL "pintar" yang
kadang gagal.

URL lama tetap bisa dibangun lewat `buildLegacySignupUrl()` untuk rujukan dan
dilaporkan sebagai `legacy_login_url` di `GET /api/chatgpt-signup`, tetapi
**bukan** tombol utama.

**Batas kedua yang terbukti dari percobaan nyata:** kolom "Alamat email" tetap
kosong — tidak ada mekanisme yang mengisinya dari URL. Karena itu isian manual
adalah jalur utama di UI.

**Batas ketiga, yang tidak bisa dilanggar:** halaman BLEA **tidak bisa** mengisi
kolom di `chatgpt.com` dari jauh. Same-origin policy melarang JavaScript BLEA
menyentuh DOM domain lain, dan `window.open` hanya mengembalikan referensi
window — bukan akses DOM. Jadi "email terisi otomatis saat tab terbuka" tidak
mungkin dari aplikasi web mana pun, bukan hanya BLEA.

Jalan yang tersedia (dan memang disediakan panel):

| Cara | Otomatis? | Catatan |
|---|---|---|
| Tempel manual | tidak | selalu bisa |
| Tombol **Salin email** | semi | fallback `execCommand` bila Clipboard API ditolak |
| **Userscript** (`/api/chatgpt-signup/userscript`) | **ya, tanpa klik** | dipasang sekali di Tampermonkey; mengisi sendiri setiap halaman formulir OpenAI dibuka (`chatgpt.com` dan `auth.openai.com`) |
| **Bookmarklet** | ya, sekali klik | tanpa ekstensi; Chrome membuang awalan `javascript:` kalau ditempel, jadi harus **diseret** |

**Alur manual adalah jalur utama, bukan bingkai otomatis.** Tempel email dengan
tangan sudah benar dan paling cepat; tidak ada yang wajib dipasang. Userscript
hanya opsi untuk yang malas mengetik ulang, dan di panel ia sengaja dilipat di
dalam `<details>` berlabel "Opsional: isi otomatis (tidak wajib)".

Userscript menghilangkan dua titik gagal sebelumnya (menyeret tautan, menempel
skrip). Isinya: pilih `input` email, isi
`value` lewat setter native + event `input`/`change`, fokus, tampilkan penanda
kecil 4 detik, ulangi tiap 250 ms sampai 10 detik (React hydrate) dan lewat
`MutationObserver` bila kolom dirender ulang. Tidak menekan `Lanjutkan`, tidak
`submit()`, tidak menyentuh cookie/`localStorage`/jaringan — ada tes yang
menjalankannya di DOM tiruan `chatgpt.com` dan memeriksa semuanya.

Bookmarklet (`buildAutofillBookmarklet`) hanya: memilih `input` email
(bukan `type=tel`), mengisi `value` lewat setter native + event `input`/`change`,
lalu fokus. Ia **tidak** menekan `Lanjutkan`, tidak mengirim formulir, tidak
membaca cookie/token, dan tidak menyimpan apa pun. Email disisipkan sebagai
literal JSON setelah divalidasi (kutip/backslash/`<`/`>` ditolak), jadi tidak
bisa dipakai untuk injeksi.

## Kenapa server tetap tidak mem-POST endpoint itu

1. **Diblokir di runtime.** Cloudflare Workerd menolak permintaan keluar ke
   `chatgpt.com` / `api.openai.com`.
2. **Tidak ada cookie browser.** `csrfToken` terikat pada cookie
   `__Host-next-auth.csrf-token` milik perangkat pengguna; token yang diambil
   server untuk dirinya sendiri tidak sah untuk browser pengguna.
3. **Turnstile + Terms of Use.** Pendaftaran otomatis ditahan captcha dan
   melanggar ToS OpenAI.

`GET /api/chatgpt-signup` karena itu mengembalikan `supported.server_side_post =
false`, `csrf_url`, dan langkah manualnya (`signin`) — bukan tombol yang
diam-diam gagal.

## Alur pemakaian

1. Admin membuka **TempMail**, menghubungkan Gmail atau membuat alamat mail.tm,
   lalu menyalin alamat aktif.
2. Buka **Studio → Akun ChatGPT**, panel *Daftar ChatGPT dengan email TempMail*.
   Kolom email sudah terisi otomatis dari alias aktif.
3. (Opsional, disarankan bila pernah gagal) Tekan **Periksa sesi ChatGPT**:
   panel menanyakan `chatgpt.com/backend-api/me` dari browser Anda. Kalau
   jawabannya berisi akun, perangkat ini **masih login** dan halaman daftar akan
   menolak — log out atau pakai Incognito baru.
4. Tekan **Siapkan & buka daftar** → tab baru membuka
   `chatgpt.com/auth/login_with?callback_path=/&screen_hint=signup` yang
   berakhir di formulir **"Create an account"**. Tab dibuka
   *sebelum* permintaan ke server karena `window.open` setelah `await` diblokir
   popup blocker; bila tetap diblokir, pakai tautan **Buka di tab baru**.
   Kalau yang tampil **"Welcome back"** (bukan "Create an account"), tekan
   tautan **Sign up** di bawah tombol Continue lebih dulu — artinya alamat itu
   sudah pernah didaftarkan.
4. Isi kolom **Email address**: tempel manual, atau pakai tombol bookmarklet/
   userscript (opsional) di panel. Kemudian tekan **Continue** di tab itu, salin
   URL halaman berikutnya dan tempel di panel → **Periksa URL**.
   - Halaman awal (`chatgpt.com/auth/login_with`, `auth.openai.com/log-in`,
     `chatgpt.com/auth/login`, atau `/create-account`) ditolak: itu berarti
     **Continue** belum ditekan, atau masih di formulir email.
   - URL halaman error (`/auth/error`, `error=…`) dan host non-OpenAI ditolak.
   - URL lanjutan seperti `auth.openai.com/u/login/identifier?state=…`
     **diterima**. OpenAI/Auth0 tidak membawa email di URL lanjutan — hanya
     `state=` — jadi menuntut email terlihat adalah syarat yang mustahil
     dipenuhi (ini bug versi sebelumnya yang sudah diperbaiki).
5. Tunggu email OpenAI masuk; tekan **Cari email verifikasi**. Panel membaca
   pesan yang cocok (maksimal 3 teratas, isi lengkap — bukan cuma snippet),
   mengambil **kode verifikasi** dari isinya, lalu menampilkannya besar-besar
   dengan tombol **Salin kode**.
6. Tempel kode itu di kolom kode pada tab ChatGPT, lalu tekan tombol lanjut di
   sana. OpenAI mengirim **kode**, bukan tautan yang cukup diklik; kode bersifat
   sekali pakai dan berumur pendek, jadi jangan menutup tab di tengah jalan.
7. Akun yang sudah jadi dimasukkan ke pool lewat **Continue with ChatGPT**
   (OAuth resmi) atau **Tambah akun manual** (API key).

Kalau formulir tetap menampilkan error, buka panel *"Email tidak terbawa /
halaman error?"*: di sana ada langkah mengambil `csrfToken` sendiri
(`GET /api/auth/csrf`) dan formulir `POST` yang sah. Token itu diambil browser
pada saat itu juga — BLEA tidak pernah menyimpan atau mengirimkannya. Langkah
ini jalur cadangan, bukan jalur utama; halaman formulir biasa sudah cukup.

## Verifikasi berupa kode, bukan tautan

Email verifikasi OpenAI berisi **kode 6 digit** (kadang ditulis `483-920`), bukan
tautan yang cukup diklik. Versi panel sebelumnya menyuruh "klik tautannya di
TempMail" — instruksi itu **salah** dan sudah dihapus.

Yang berubah:

- `extractVerificationCode()` di `src/lib/chatgptSignup.js` menarik kode dari
  **isi lengkap** pesan (teks + HTML), karena snippet inbox sering memotongnya.
  Aturannya konservatif: utamakan 6–8 digit, dukung bentuk berkelompok
  (`483-920`, `604 217` — bentuk berspasi hanya diterima bila ada kata kunci di
  dekatnya), baca juga subjek karena sebagian email menaruh kodenya di sana,
  lalu abaikan tahun (`2026`), nominal/harga, dan deret yang menempel pada
  angka/huruf lain.
  Bila ada beberapa kandidat tanpa kata kunci di sekitarnya, hasilnya kosong —
  lebih baik kosong daripada salah tempel.
- Rute `verify` membaca sampai 3 pesan teratas lewat `tempmailMessageReader`
  (pemeriksaan pemilik alias sama seperti `/api/tempmail`), menyimpan
  `verification_code`, dan mengembalikan `code` + `code_from_message_id` ke UI.
  Yang dibaca penuh hanya pesan yang masuk **setelah** ronde dimulai
  (`created_at`, yang selalu ditulis ulang oleh `prepare` saat ronde baru;
  toleransi 5 menit untuk selisih jam pengirim). Patokan `updated_at` **salah**
  dan pernah dicoba: setiap verify memperbarui `updated_at`, sehingga percobaan
  ulang justru mengecualikan email yang sedang dicari. Tanpa batas ini, surat
  lama di inbox admin ikut dipindai dan angka 6 digit di dalamnya bisa tersaji
  seolah kode verifikasi.
- Panel menampilkan kode + **Salin kode**, dengan peringatan sekali pakai.
- Kolom DB `chatgpt_signup_attempts.verification_code`
  (`20261213000002_…`) dan `verification_code_at`
  (`20261213000003_chatgpt_signup_code_at.sql`, waktu kode diambil — dipakai
  menghitung TTL, terpisah dari `verified_at`). Isinya **bukan**
  kredensial login — hanya bukti sekali pakai dari inbox milik admin sendiri.
- Aksi `{action:'code', id}` mengembalikan kode yang **sudah tersimpan** tanpa
  memanggil Gmail/mail.tm lagi. Panel memakainya saat dibuka atau dimuat ulang;
  tanpa ini kode hanya terlihat tepat setelah tombol verify ditekan, dan satu-
  satunya jalan adalah menekan verify lagi (memanggil Gmail ulang sekaligus
  me-reset `verified_at`).
- Kode bisa ditemukan pada pesan yang **tidak** dikenali sebagai email OpenAI
  (mis. domain pengirim berubah). Kasus itu tidak menaikkan langkah menjadi
  `terverifikasi`, tetapi kodenya tetap disimpan di kolom
  `verification_code_at` + `verification_code` dan dikembalikan dengan
  `code_unverified: true`. UI menandainya agar tidak ditempel tanpa dicek.
  Tanpa penyimpanan ini kode tersebut hilang setiap halaman dimuat ulang.
- Kode OpenAI hanya berlaku ±10 menit, jadi aksi `code` menyertakan
  `code_expired`. Kode basi **tetap ditampilkan** tetapi ditandai (judul dan
  warna berubah), bukan disembunyikan — kalau disembunyikan, pengguna akan
  mengira BLEA tidak pernah menemukan kodenya. Kalau tanda itu muncul, minta
  kode baru di ChatGPT lalu tekan **Cari email verifikasi** lagi.

Kalau panel menampilkan pesan cocok tetapi kodenya kosong, buka pesan itu di
TempMail: halaman **TempMail** kini menampilkan kode yang terbaca di atas isi
pesan, lengkap dengan tombol **Salin kode**. Itu penting karena menyalin angka
dari iframe email yang di-sandbox sering terpotong. Kalau tetap tidak ada kode
yang terbaca, salin manual — jangan mengarang kode dari potongan yang tidak
jelas.

## Email verifikasi tidak muncul di TempMail (alias Gmail `+tag`)

Gmail membuang plus-tag saat menyimpan alamat tujuan: pesan ke
`nama+1@gmail.com` sering tersimpan sebagai `nama@gmail.com`. Akibatnya
pencarian lama (`to:nama+1@gmail.com`) mengembalikan nol hasil walau emailnya
ada — "Cari email verifikasi" melaporkan tidak ada pesan.

Perbaikan di `src/lib/gmailProvider.js`:

- **Pencarian** memakai alamat dasar + `deliveredto:<alias lengkap>`, lalu
  mundur ke `to:<alamat dasar>` bila hasil pertama kosong.
- **Pencocokan penerima** berlapis: header yang masih memuat tag (cocok),
  tag muncul di subject/snippet (cocok), atau alamat dasar cocok tanpa jejak
  tag → hanya cocok pada `matchMode: 'loose'`.
- `/api/tempmail` tetap **ketat** (hanya pesan untuk alias `+tag`), sedangkan
  pembaca pendaftaran (`/api/chatgpt-signup`) memakai **longgar**, karena ia
  memang harus menemukan email verifikasi yang tag-nya sudah dibuang Gmail.

Kalau masih kosong: periksa tag Gmail (mis. `+1`), tunggu beberapa menit,
lalu tekan **Cari email verifikasi** lagi. Kalau tetap kosong, email-nya tidak
pernah sampai — itu sisi OpenAI/Gmail, bukan panel ini.

## Menyimpan akses setelah akun berhasil masuk

Permintaan yang wajar: "setelah kode berhasil, simpan cookie/token-nya supaya
sesi tidak pernah kedaluwarsa". Setengahnya bisa, setengahnya tidak — dan yang
tidak harus dikatakan terus terang.

| Yang diminta | Bisa? | Alasannya |
|---|---|---|
| Menyimpan cookie sesi `chatgpt.com` (`__Secure-next-auth.session-token`) | **Tidak** | Cookie itu milik domain `chatgpt.com`. Halaman BLEA tidak bisa membacanya (same-origin policy), jadi tidak ada yang bisa dikirim ke server. Menyalinnya manual = menyimpan kredensial ChatGPT mentah di database. |
| Sesi BLEA yang "tidak pernah kedaluwarsa" | **Tidak** | OAuth OpenAI memberi access token ±1 jam; memperpanjangnya butuh refresh token yang bergulir (≤30 hari) dan bisa dicabut. Mengklaim permanen = mengarang. |
| Akses yang diperbarui otomatis dan tahan lama | **Ya, ini yang dipakai** | **Continue with ChatGPT** (OAuth resmi, PKCE). Access token disegel di database, di-refresh otomatis 60 detik sebelum kedaluwarsa oleh `refreshOAuthAccessToken()` di `src/lib/chatgptPool.js`. |

Karena itu panel pendaftaran punya tombol penutup **"Akun sudah masuk? Simpan
aksesnya ke pool"** (muncul setelah langkah `terverifikasi`). Tombol itu
memanggil alur OAuth yang sudah ada — bukan alat baru, bukan pembaca cookie.

**Kesalahan saya sebelumnya:** panel sempat mencoba memeriksa sesi otomatis
dengan `fetch('https://chatgpt.com/backend-api/me', { credentials: 'include' })`.
Hasilnya di browser pengguna: **"Failed to fetch"**. Endpoint itu tidak
mengirim header CORS, jadi halaman lain memang tidak boleh membacanya. Fitur
itu sudah dihapus dan diganti panduan manual 30 detik.

## Catatan operasional

- Alamat Gmail `+tag` ditandai di UI: sebagian formulir OpenAI menolak tanda
  `+`. Bila pendaftaran ditolak, buat alias TempMail tanpa `+`.
- Migrasi baru perlu dijalankan di Supabase, lalu
  `NOTIFY pgrst, 'reload schema'` agar `/api/chatgpt-signup` tidak 503.
- Upsert memakai PostgREST `on_conflict=user_id,email`. Itu hanya sah bila ada
  **unique constraint** pada `(user_id, email)` — unique *index ekspresi*
  `(user_id, lower(email))` tidak bisa diinferensi `ON CONFLICT` dan
  menghasilkan `42P10 "there is no unique or exclusion constraint matching the
  ON CONFLICT specification"`. Migrasi `20261213000001_fix_chatgpt_signup_on_conflict.sql`
  memperbaikinya (idempoten, aman dijalankan berulang).
- Tes: `node --test tests/chatgpt-signup.test.js`.

## `invalid_state` dari auth.openai.com (belum tuntas)

Gejalanya: setelah menekan **Continue with ChatGPT**, OpenAI berhenti di
halaman *Auth login details* dengan `error_code: invalid_state`. Halaman itu
dimiliki OpenAI dan muncul **sebelum** `http://127.0.0.1:<port>/auth/callback`,
jadi BLEA tidak menerima `code`/`state` sama sekali — tidak ada baris DB yang
bisa diperiksa untuk kejadian itu. Karena itulah panel sekarang punya kotak
**“Gagal dengan kode error?”**: tempel kodenya dan BLEA menjelaskan sebab yang
paling mungkin plus langkah perbaikannya (`explainOAuthError`).

Yang **pasti** (dokumen OpenAI *Sign in with ChatGPT*):

- `redirect_uri` wajib `http://127.0.0.1:<port>/auth/callback`; hanya **port**
  yang boleh berubah antar percobaan; skema, host, dan path tetap.
- `state` harus nilai acak segar per percobaan, dan `state` di URL authorize
  harus sama dengan yang dipakai saat menukar kode.
- Nama variabel di dokumen adalah `error_code`; nilai yang dikirim ke
  `redirect_uri`/`state` tidak boleh ditambahi apa pun oleh BLEA.

Yang **belum terbukti** — sengaja tidak diklaim sebagai penyebab:

| Dugaan | Cara memastikan |
|---|---|
| Percobaan OAuth tidak ada/berbeda di server (tombol ditekan dua kali, tab lama dari riwayat) | Kotak diagnosa membedakan “ada percobaan pending” vs “tidak ada” |
| Port callback bertabrakan dengan layanan lain di perangkat | Panel menampilkan `redirect_uri` persis yang dikirim |
| `state` terpakai dua kali (callback dibuka ulang) | Baris `chatgpt_oauth_links.status` tidak lagi `pending` |

Perubahan port: `resolveOAuthRedirectUri()` (`src/lib/chatgptSignup.js`)
memakai port halaman **hanya** bila BLEA dibuka dari `127.0.0.1`; di domain
publik dipilih port acak 1024–65535 dan callback diselesaikan dengan menempel
URL. Ini tetap hipotesis, bukan bukti.

## “Session ended” + `invalid_state` pada `/email-verification`

Bukti dari lapangan (URL nyata yang dibuka pengguna):

```
https://auth.openai.com/email-verification?auth_page=YVXP3qYcCk42c3H0mcISDEgR3G4UGicJ
→ judul "Session ended", diagnostics: error_code: invalid_state
```

Dua hal penting dari kejadian ini:

1. **`invalid_state` di sini bukan `state` OAuth BLEA.** URL tersebut berasal
   dari alur *daftar* (`chatgpt.com/auth/login_with…`), bukan dari
   `auth.openai.com/api/accounts/authorize`. `auth_page=…` adalah penanda
   sesi tab milik Auth0/OpenAI; ketika tabnya ditutup (atau dipulihkan dari
   riwayat), penanda itu merujuk ke sesi yang sudah mati. BLEA tidak bisa
   memperbaikinya dari sisi server — satu-satunya jalan adalah memulai sesi
   baru di tab baru.
2. **Analyzer dulu salah membaca URL ini.** Tidak ada kata `error` di path
   maupun query, sehingga `analyzeReturnUrl` menyebutnya `verifikasi` (ok).
   Sekarang statusnya `sesi_berakhir` bila path `/email-verification` atau
   `/session-ended` tanpa `state=` dan tanpa email di URL. Panel juga memuat
   blok panduan **“Kalau OpenAI bilang Session ended”**.

Aturan operasional yang muncul dari sini: **satu percobaan = satu tab.** Jangan
menutup tab OpenAI selama kode verifikasi belum ditempel, dan jangan menekan
“Siapkan & buka daftar” dua kali (dua tab = dua sesi, hanya satu yang sah).
