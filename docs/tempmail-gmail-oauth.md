# TempMail: Hubungkan akun Gmail dengan Google OAuth

Mode Gmail mengikuti alur TempMail GEN-Z.AI: admin menghubungkan akun Gmail satu kali, lalu membuat alias `nama+tag@gmail.com` dan membaca pesan yang ditujukan ke alias tersebut.

## Siapkan Google OAuth (sekali saja)

1. Di [Google Cloud Console](https://console.cloud.google.com/), pilih/buat project dan aktifkan **Gmail API**.
2. Atur Google Auth Platform / OAuth consent screen. Tambahkan akun Gmail yang akan dihubungkan sebagai **Test user** jika aplikasi masih berstatus Testing.
3. Tambahkan scope baca saja: `https://www.googleapis.com/auth/gmail.readonly`.
4. Buat OAuth Client ID tipe **Web application**. Di **Authorized redirect URIs**, tambahkan:
   `https://<origin-aplikasi-blea>/api/tempmail-gmail-callback`
   Gunakan origin yang sama persis dengan yang dipakai membuka BLEA AI. Tambahkan origin kedua juga jika aplikasi dipakai dari domain lain.
5. Simpan Client ID dan Client Secret langsung sebagai Cloudflare Worker secrets bernama `GMAIL_CLIENT_ID` dan `GMAIL_CLIENT_SECRET`. Jangan kirim atau commit nilainya.
6. Tambahkan `PROVIDER_CREDENTIAL_ENCRYPTION_KEY` sebagai Worker secret. Gunakan kunci acak 32 byte (disarankan 64 karakter hex). Jika secret tersebut sudah ada dan dipakai untuk data terenkripsi lain, gunakan nilai yang sama—jangan menggantinya. Opsional: set `GMAIL_OAUTH_REDIRECT_URI` jika callback tidak bisa diturunkan dari origin aplikasi.
7. Deploy ulang Worker setelah menambahkan secrets.

> Google consent screen berstatus Testing dapat membuat refresh token kedaluwarsa setelah beberapa hari. Untuk pemakaian jangka panjang, tinjau status publikasi dan kebijakan Google OAuth; Google dapat menampilkan peringatan aplikasi belum diverifikasi untuk scope sensitif.

## Pakai TempMail

1. Login sebagai admin dan buka **TempMail** di navigasi.
2. Klik **Hubungkan Gmail**, pilih akun `@gmail.com`, dan setujui izin baca.
3. Setelah kembali ke BLEA AI, masukkan akhiran seperti `1` atau `shop-2026`, lalu tekan **Generate ujung**. Kosongkan kolom untuk akhiran angka acak.
4. Gunakan alamat `akun+akhiran@gmail.com`; pesan yang benar-benar ditujukan ke alias itu akan muncul di inbox dan diperbarui otomatis.

Aplikasi hanya meminta scope baca email. Refresh token disimpan terenkripsi AES-GCM di Supabase dan tidak dikirim ke browser. Tabel koneksi hanya dapat diakses `service_role`; setiap action dicek kembali sebagai admin di Worker. Isi HTML pesan ditampilkan pada iframe sandbox dengan CSP ketat.

Jika secrets Gmail belum tersedia, halaman TempMail menampilkan petunjuk konfigurasi. Mode `mail.tm` lama tetap tersedia sebagai fallback sampai Gmail OAuth diaktifkan.
