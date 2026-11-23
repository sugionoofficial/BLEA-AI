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

Sekarang `buildSignupUrl` mengembalikan **halaman** `https://chatgpt.com/auth/login`
(bisa dibuka dengan GET), tetap membawa `login_hint` = email TempMail.

**Batas kedua yang terbukti dari percobaan nyata:** halaman `/auth/login`
mengabaikan `login_hint` — kolom "Alamat email" tetap kosong. `login_hint`
tetap dibawa karena berpotensi dipakai pada tahap berikutnya (mis.
`auth.openai.com`), tetapi tidak diandalkan.

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
| **Userscript** (`/api/chatgpt-signup/userscript`) | **ya, tanpa klik** | dipasang sekali di Tampermonkey; mengisi sendiri setiap `/auth/login` dibuka |
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
3. Tekan **Siapkan & buka daftar** → tab baru membuka halaman
   `chatgpt.com/auth/login` dengan email TempMail sebagai `login_hint`. Tab
   dibuka *sebelum* permintaan ke server karena `window.open` setelah `await`
   diblokir popup blocker; bila tetap diblokir, pakai tautan **Buka di tab baru**.
4. Isi kolom **Alamat email** di ChatGPT: tempel manual, atau seret tombol
   **Isi email otomatis** di panel ke bilah bookmark lalu klik bookmark itu di
   tab ChatGPT. Kemudian tekan **Lanjutkan** di tab ChatGPT, salin URL halaman
   berikutnya dan tempel di panel → **Periksa URL**.
   - URL halaman error (`/auth/error`, `error=…`) ditolak dengan alasan jelas.
   - URL di luar domain OpenAI ditolak.
   - Langkah baru ditandai `email_dikirim` bila email TempMail benar-benar
     terlihat di URL. Tidak ada klaim "berhasil" tanpa bukti.
5. Tunggu email OpenAI masuk; tekan **Cari email verifikasi**. Panel menampilkan
   pesan yang cocok beserta skornya. Buka pesan itu di TempMail dan klik
   tautan verifikasinya sendiri.
6. Akun yang sudah jadi dimasukkan ke pool lewat **Continue with ChatGPT**
   (OAuth resmi) atau **Tambah akun manual** (API key).

Kalau halaman login tetap menampilkan error, buka panel *"Email tidak terbawa /
halaman error?"*: di sana ada langkah mengambil `csrfToken` sendiri
(`GET /api/auth/csrf`) dan formulir `POST` yang sah. Token itu diambil browser
pada saat itu juga — BLEA tidak pernah menyimpan atau mengirimkannya.

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
