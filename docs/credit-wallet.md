# Kredit BLEA AI (persiapan)

Migrasi `20261118000003_create_credit_wallets.sql` menambahkan paket dan harga model yang dikelola admin, instruksi transfer, pesanan manual, saldo, dan buku besar. Halaman `/credits` memakai kebijakan RLS dan RPC Supabase; admin ditentukan dari `app_metadata.role` seperti bagian lain aplikasi. Tidak ada pembayaran otomatis atau unggahan bukti transfer.

## Penting: belum siap menerima uang

Pembelian secara default **dimatikan di database**, dan admin dari browser tidak bisa mengubah `purchases_enabled`. Jangan mengaktifkannya atau meminta pengguna mentransfer uang sampai integrasi Freebeat, pengurangan kredit yang atomik, penanganan kegagalan/refund, dan kebijakan harga sudah selesai dan diuji. Harga model yang disimpan hanya konfigurasi; generasi yang ada **tidak memotong kredit**. Tidak ada saldo awal atau pembelian paket yang dibuat otomatis.

## Setelah fitur pemakaian kredit tersedia

Terapkan migrasi melalui alur migrasi Supabase yang disetujui. Admin memasukkan instruksi pembayaran, membuat paket, dan mengatur harga model di `/credits`. Pengguna dapat memilih satu pesanan aktif, melakukan transfer di luar aplikasi, lalu mengirim nama pengirim atau referensi. Admin harus mencocokkan dana yang masuk secara independen sebelum menyetujui. Persetujuan memakai row lock dan transaksi SQL: saldo serta satu entri buku besar dibuat bersama, dan percobaan persetujuan ulang tidak menambahkan saldo lagi. Penolakan tidak mengubah saldo. Jumlah dan harga disalin ke pesanan saat dibuat agar perubahan paket tidak mengubah pesanan sebelumnya.

Ini bukan bukti pembayaran, rekonsiliasi bank, atau sistem pembayaran otomatis. Perlu proses operasional untuk transaksi yang salah nominal, refund uang, pertikaian, dan pengamanan akun admin. Kredit Freebeat tetap dipakai oleh akun provider terhubung secara terpisah dari kredit BLEA.

## Pengujian

`node --test tests/credit-wallet.test.js` menjalankan migrasi di PostgreSQL WASM (PGlite), termasuk isolasi pengguna, larangan menulis saldo langsung, larangan review oleh non-admin, snapshot harga, pembatalan, penolakan dan persetujuan yang idempotent. Ini tidak menggantikan uji integrasi pada proyek Supabase nonproduksi atau pengujian browser.
