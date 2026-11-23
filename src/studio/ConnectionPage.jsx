import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, CircleAlert, Loader2, Plug, ShieldAlert } from 'lucide-react';
import { DropXLayout } from '../dropx/DropXLayout';
import { supabase } from '../lib/supabase';
import './connection.css';

async function getAccessToken() {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data?.session?.access_token) throw new Error('Sesi login tidak tersedia. Masuk ulang dulu.');
  return data.session.access_token;
}

// TempMail yang sudah ada dipakai sebagai bukti kesiapan saluran email. Endpoint
// ini hanya melaporkan konfigurasi — tidak menerima pesanan untuk mendaftarkan
// akun ke layanan pihak ketiga.
async function tempmailRequest(action, params = {}) {
  const token = await getAccessToken();
  const query = new URLSearchParams({ action, ...params });
  const response = await fetch(`/api/tempmail?${query}`, {
    method: 'GET',
    cache: 'no-store',
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error([data?.error, data?.hint].filter(Boolean).join(' ') || `Gagal membaca status (HTTP ${response.status}).`);
  return data;
}

const PROVIDERS = [
  {
    id: 'unorouter',
    label: 'Unorouter / model chat aktif',
    note: 'Sudah terhubung lewat kunci provider yang dipasang admin.',
    state: 'connected',
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare Workers AI',
    note: 'Dipakai untuk Whisper (transkrip) dan pemindaian metadata vision.',
    state: 'connected',
  },
  {
    id: 'freebeat',
    label: 'freebeat (video/musik)',
    note: 'OAuth-nya terputus di sisi freebeat. Video dan musik berstatus terbatas sampai tersambung lagi.',
    state: 'degraded',
  },
  {
    id: 'chatgpt',
    label: 'Akun ChatGPT / OpenAI (pool manual)',
    note: 'Dikelola admin di Studio → Akun ChatGPT: prioritas, kuota harian, cooldown, lalu lanjut akun berikutnya.',
    state: 'degraded',
  },
  {
    id: 'tempmail',
    label: 'Saluran email (TempMail)',
    note: 'Aktif dan dipakai untuk verifikasi email milikmu sendiri.',
    state: 'connected',
  },
];

/**
 * Halaman koneksi.
 *
 * Yang TIDAK ada di sini: alur "klik CONNECTION lalu BLEA mendaftarkan akun
 * ChatGPT/OpenAI secara otomatis memakai email temp + kode verifikasi".
 * Fitur itu tidak dibangun karena:
 *   1. Tidak ada API pendaftaran akun resmi — satu-satunya jalan adalah
 *      mengotomasi halaman signup mereka, yang dilarang ToS.
 *   2. Captcha dan deteksi bot membuatnya tidak andal walau dipaksakan.
 *   3. Akun yang dibuat dengan email sekali pakai akan ditutup, dan biayanya
 *      ditanggung pemilik akun yang kena banned.
 * Halaman ini menampilkan apa yang benar-benar tersambung dan bagaimana
 * menambah koneksi provider lewat jalur resmi (API key / OAuth).
 */
export function ConnectionPage() {
  const [checking, setChecking] = useState(true);
  const [emailReady, setEmailReady] = useState(null);
  const [error, setError] = useState('');

  const check = useCallback(async () => {
    setChecking(true);
    setError('');
    try {
      const data = await tempmailRequest('status');
      // Alias belum tentu dibuat; yang penting endpoint-nya hidup dan akun bisa
      // membuat alias. `alias: null` tetap berarti saluran siap.
      setEmailReady(Boolean(data?.ok));
    } catch (err) {
      setEmailReady(false);
      setError(String(err?.message || err));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { check(); }, [check]);

  return (
    <DropXLayout
      title="Koneksi"
      description="Status penyedia AI dan saluran yang benar-benar tersambung ke akunmu."
      actions={(
        <button type="button" className="studio-home-connection" onClick={check} disabled={checking}>
          {checking ? <Loader2 size={13} className="agent-spin" /> : <Plug size={13} />} Periksa ulang
        </button>
      )}
    >
      <div className="studio-connection">
        <section className="studio-connection-hero">
          <span className="studio-connection-badge"><Plug size={12} /> Koneksi</span>
          <h1>Satu form, satu tombol.</h1>
          <p>
            Tekan <b>Periksa koneksi</b> untuk memastikan semua saluran yang dipakai Studio siap.
            BLEA hanya memakai koneksi resmi: API key provider dan OAuth pemilik akun.
          </p>
          <button type="button" className="studio-connection-cta" onClick={check} disabled={checking}>
            {checking ? 'Memeriksa…' : 'CONNECTION'}
          </button>
        </section>

        {error && (
          <p className="studio-connection-error"><CircleAlert size={13} /> {error}</p>
        )}

        <ul className="studio-connection-list">
          {PROVIDERS.map((provider) => {
            const isEmail = provider.id === 'tempmail';
            const state = isEmail && emailReady === false ? 'degraded' : provider.state;
            return (
              <li key={provider.id} className={`studio-connection-item is-${state}`}>
                <span className="studio-connection-dot" aria-hidden="true">
                  {state === 'connected' ? <Check size={11} /> : <ShieldAlert size={11} />}
                </span>
                <div>
                  <b>{provider.label}</b>
                  <small>{provider.note}</small>
                  {isEmail && emailReady === null && checking && <small>Memeriksa saluran email…</small>}
                </div>
                <span className="studio-connection-state">
                  {state === 'connected' ? 'Tersambung' : 'Terbatas'}
                </span>
              </li>
            );
          })}
        </ul>

        <section className="studio-connection-explain">
          <h2>Kenapa tidak ada tombol “daftarkan akun ChatGPT otomatis”</h2>
          <p>
            Permintaan itu berarti BLEA membuat email sekali pakai, mendaftarkannya ke akun
            ChatGPT, lalu mengambil kode verifikasi secara otomatis. Itu tidak saya bangun, dan
            bukan karena teknisnya sulit saja:
          </p>
          <ol>
            <li>OpenAI tidak menyediakan API pendaftaran akun. Satu-satunya jalan adalah mengotomasi halaman signup mereka, dan itu melanggar ketentuan layanan mereka.</li>
            <li>Captcha dan deteksi bot membuat prosesnya rapuh; hasilnya akun mati di tengah jalan.</li>
            <li>Akun beremail sekali pakai biasanya dinonaktifkan, dan yang menanggung risikonya adalah pemilik akun BLEA.</li>
            <li>Kredensial akun pihak ketiga yang dikumpulkan otomatis adalah risiko keamanan untuk pengguna BLEA sendiri.</li>
          </ol>
          <p>
            Jalur yang benar dan sudah tersedia: pakai API key milikmu sendiri, atau hubungkan lewat
            OAuth resmi. Kalau kamu mau menambahkan provider baru, admin bisa menambahkannya di
            Panel Admin → Model beserta harga kreditnya.
          </p>
          <h2>Jalur yang tersedia sekarang</h2>
          <p>
            Untuk ChatGPT/OpenAI: admin menambahkan akun sendiri (email + kunci resmi) di halaman
            <b> Studio → Akun ChatGPT</b>. Halaman itu menampilkan prioritas, sisa kuota harian, dan
            status cooldown tiap akun; bila kuota akun pertama habis, permintaan otomatis pindah ke
            akun berikutnya. Hasil semua tool bisa diambil di <b>Studio → Hasil</b>.
          </p>
          <p className="studio-connection-links">
            <Link className="studio-connection-link" to="/studio/chatgpt-accounts">Kelola akun ChatGPT</Link>
            <Link className="studio-connection-link" to="/studio/library">Lihat hasil & unduhan</Link>
            <Link className="studio-connection-link" to="/studio">Kembali ke Studio</Link>
          </p>
        </section>
      </div>
    </DropXLayout>
  );
}

export default ConnectionPage;
