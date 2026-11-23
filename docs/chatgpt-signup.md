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

## Yang tidak dikerjakan, dan alasannya

Permintaan awal: tiru `POST https://chatgpt.com/api/auth/signin/openai` dari
server memakai email TempMail. Itu **tidak** diimplementasikan. Tiga alasan
teknis, bukan alasan kebijakan semata:

1. **Diblokir di runtime.** Cloudflare Workerd menolak permintaan keluar ke
   domain OpenAI (`chatgpt.com`, `api.openai.com`) — alasan yang sama dengan
   catatan pool akun di `src/lib/chatgptPool.js`. POST dari Worker akan gagal
   sebelum sampai ke OpenAI.
2. **Butuh konteks browser.** Endpoint itu memakai cookie sesi `chatgpt.com`,
   token CSRF dari halaman, dan **Cloudflare Turnstile**. Respons `200 OK` pada
   contoh request di laporan hanya berarti *halaman login terbuka*; akun tidak
   dibuat oleh request itu. Tanpa Turnstile + verifikasi email, tidak ada akun.
3. **Terms of Use.** Pendaftaran akun otomatis ke OpenAI melanggar ToS mereka
   dan akun hasilnya biasanya dinonaktifkan. Karena itu `credential_kind`
   `session` di pool pun sengaja tidak dipanggil ke backend non-publik.

`GET /api/chatgpt-signup` mengembalikan `config.supported.server_side_post =
false` beserta alasannya, jadi UI tidak pernah menampilkan tombol yang
diam-diam gagal.

## Yang benar-benar dilakukan

1. **Siapkan URL daftar resmi.** `buildSignupUrl(email)` membentuk
   `https://chatgpt.com/api/auth/signin/openai?prompt=login&screen_hint=signup&login_hint=<email>`
   (plus `auth_session_logging_id` bila klien mengirim UUID). Email diambil dari
   halaman TempMail (`tempmail_user_aliases`), bukan diketik ulang.
2. **Catat langkah manual.** `POST /api/chatgpt-signup { action: "prepare" }`
   menyimpan satu baris per (admin, email) berisi email, URL, dan langkah
   `dibuka → email_dikirim → menunggu_verifikasi → terverifikasi | dilewati`.
   Mengulang alamat yang sama memperbarui baris, bukan menumpuk riwayat.
3. **Cocokkan email verifikasi.** `{ action: "verify" }` membaca inbox TempMail
   (mail.tm atau Gmail alias, dengan pemeriksaan pemilik alias yang sama seperti
   `/api/tempmail`) dan memberi skor tiap pesan: pengirim OpenAI/ChatGPT, kata
   kunci verifikasi/kode, penerima cocok, dan waktu diterima setelah
   pendaftaran dimulai. Pesan dengan skor ≥ 50 ditandai cocok.

Yang disimpan hanya email, URL, dan langkah. Tidak ada kata sandi, kode
verifikasi, isi email, atau cookie sesi `chatgpt.com`.

## Alur pemakaian

1. Admin membuka **TempMail**, menghubungkan Gmail atau membuat alamat mail.tm,
   lalu menyalin alamat aktif.
2. Buka **Studio → Akun ChatGPT**, panel *Daftar ChatGPT dengan email TempMail*.
   Kolom email sudah terisi otomatis dari alias aktif.
3. Tekan **Siapkan & buka daftar** → tab baru berisi formulir daftar ChatGPT
   dengan email tersebut. Tab dibuka *sebelum* permintaan ke server, karena
   `window.open` setelah `await` diblokir popup blocker. Bila browser tetap
   memblokir, panel menampilkan tautan **Buka di tab baru** di blok
   "URL yang dibuka".
4. Isi formulir di tab itu, lalu kembali dan tekan **Formulir sudah dikirim**.
5. Tunggu email OpenAI masuk; tekan **Cari email verifikasi**. Panel menampilkan
   pesan yang cocok beserta skornya. Buka pesan itu di TempMail dan klik
   tautan verifikasinya sendiri.
6. Akun yang sudah jadi dimasukkan ke pool lewat **Continue with ChatGPT**
   (OAuth resmi) atau **Tambah akun manual** (API key).

## Catatan operasional

- Alamat Gmail `+tag` ditandai di UI: sebagian formulir OpenAI menolak tanda
  `+`. Bila pendaftaran ditolak, buat alias TempMail tanpa `+`.
- Migrasi baru perlu dijalankan di Supabase, lalu
  `NOTIFY pgrst, 'reload schema'` agar `/api/chatgpt-signup` tidak 503.
- Tes: `node --test tests/chatgpt-signup.test.js`.
