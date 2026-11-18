# Freebeat MCP: uji koneksi admin

`/admin/freebeat` hanya tersedia untuk admin dan hanya menawarkan OAuth serta `get_credit_balance`. Tidak ada endpoint generasi atau pembelian yang diaktifkan. Backend memeriksa role admin pada setiap permintaan, menggunakan pendaftaran OAuth dinamis, PKCE S256, `freebeat:read`, dan state yang terikat ke browser. Endpoint resmi: `https://freebeat.ai/api/mcp`.

Worker memerlukan `PROVIDER_CREDENTIAL_ENCRYPTION_KEY` yang sudah digunakan fitur Gmail. Jangan ganti kunci yang ada. Callback default: `https://blea-ai.blea-ai.workers.dev/api/freebeat/callback`. Opsional `FREEBEAT_OAUTH_REDIRECT_URI` dapat mengatur domain HTTPS lain dengan path yang sama; buka aplikasi dari origin tersebut agar cookie OAuth tersedia pada callback.

Token akses untuk pengujian dienkripsi AES-GCM ke cookie HttpOnly, Secure, SameSite=Lax, terikat ID admin, dan digunakan hanya setelah verifikasi admin. Tidak ada token refresh yang disimpan. Sesi berlaku paling lama satu jam (atau masa token yang lebih pendek); hubungkan ulang setelah kedaluwarsa. Setiap admin/browser punya sesi sendiri, belum ada akun provider bersama untuk pengguna. Tombol Putuskan menghapus cookie dan mencoba mencabut token; jika gagal, cabut akses di Freebeat. Perubahan kunci enkripsi juga mengakhiri sesi ini dan akan memengaruhi fitur Gmail yang memakai kunci yang sama.

Koneksi, saldo, cakupan OAuth, dan ketersediaan pada akun/plan belum diuji pada Freebeat live. Tidak ada bypass pembatasan plan atau kredit. Penggunaan kredit Freebeat gratis bersifat nonkomersial menurut ketentuan Freebeat; akses untuk pengguna BLEA dan penggunaan komersial memerlukan pengecekan izin terpisah. Sistem kredit BLEA tidak terhubung ke Freebeat, dan pembelian tetap nonaktif.

Unit/integration tests: `node --test tests/freebeat-mcp.test.js`; pengujian menggunakan respons upstream tiruan, bukan akun Freebeat asli.
