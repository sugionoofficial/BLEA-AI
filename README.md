# BLEA-AI
### Koneksi GitHub AI Studio

Administrator cukup membuat **satu** GitHub OAuth App untuk semua pengguna.
Konfigurasikan `GITHUB_CLIENT_ID` pada Worker dan simpan `GITHUB_CLIENT_SECRET`
sebagai Cloudflare Worker secret. Callback OAuth App harus sesuai domain Worker,
misalnya `https://blea-ai.blea-ai.workers.dev/auth/github/callback`. Setelah
konfigurasi dan deployment, setiap pengguna dapat masuk dan menyetujui akses
menggunakan akun GitHub mereka sendiri. Pengguna lama perlu menghubungkan ulang.

Sesi GitHub disimpan di cookie terenkripsi dan terikat pada akun BLEA yang memulai
proses; sesi ini berlaku pada browser tersebut, bukan disinkronkan antar perangkat.
Scope GitHub `repo` mencakup akses baca **dan tulis** ke repository privat;
meskipun begitu, alat yang mengubah data dinonaktifkan sampai tersedia alur
persetujuan yang aman. Ringkasan hasil alat agen saat ini hanya metadata.
Memutus koneksi menghapus cookie lokal, tidak mencabut otorisasi di GitHub;
untuk mencabut akses, pengguna dapat menghapus aplikasi dari pengaturan
**GitHub Settings → Applications → Authorized OAuth Apps**. Pengguna juga dapat
memutus akses di sana jika kehilangan perangkat. Mengganti secret Worker akan
membuat semua cookie GitHub lama tidak berlaku.

Uji unit alur OAuth: `node --test tests/github-oauth.test.js`.
