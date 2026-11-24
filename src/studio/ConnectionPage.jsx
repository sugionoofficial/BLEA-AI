import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, CircleAlert, Loader2, Plug, ShieldAlert } from 'lucide-react';
import { DropXLayout } from '../dropx/DropXLayout';
import { supabase } from '../lib/supabase';
import { openAiOAuthApi } from './openaiOAuthClient';
import './connection.css';

async function getAccessToken() {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data?.session?.access_token) throw new Error('Sesi login tidak tersedia. Masuk ulang dulu.');
  return data.session.access_token;
}

// Ringkasan pool akun (dibaca server, tanpa kredensial). Endpoint ini admin-only,
// jadi pengguna biasa akan menerima 403 — itu ditampilkan sebagai "tidak diukur",
// bukan sebagai "terputus".
async function fetchPoolSummary() {
  try {
    const token = await getAccessToken();
    const res = await fetch('/api/openai-accounts/summary', {
      method: 'GET',
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 403) return { restricted: true };
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data?.error || `HTTP ${res.status}` };
    return { total: Number(data?.total) || 0, usable: Number(data?.usable) || 0 };
  } catch (error) {
    return { error: String(error?.message || error) };
  }
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
    note: 'Kunci provider dipasang admin. Status di sini tidak diukur dari server, jadi jangan dibaca sebagai bukti.',
    state: 'unknown',
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare Workers AI',
    note: 'Dipakai untuk Whisper (transkrip) dan pemindaian metadata vision.',
    state: 'unknown',
  },
  {
    id: 'freebeat',
    label: 'freebeat (video/musik)',
    note: 'OAuth-nya terputus di sisi freebeat. Video dan musik berstatus terbatas sampai tersambung lagi.',
    state: 'degraded',
  },
  {
    id: 'openai',
    label: 'OpenAI (Connect OpenAI, tanpa API key)',
    note: 'OAuth resmi OpenAI: satu tombol, izin di browser, lalu kuota paket OpenAI dipakai untuk chat & agen.',
    // Statusnya TIDAK ditulis di sini. Label "Tersambung" hanya muncul kalau
    // server melaporkan ada tautan yang benar-benar berstatus linked.
    state: 'unknown',
    check: 'oauth',
  },
  {
    id: 'openai-api',
    label: 'OpenAI API key (untuk gambar & video)',
    note: 'Jalur cadangan admin. Izin OAuth hanya berlaku untuk teks, jadi tool gambar/video tetap butuh API key di pool yang sama.',
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
 * OpenAI/OpenAI secara otomatis memakai email temp + kode verifikasi".
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
  const [oauthState, setOauthState] = useState(null);
  const [poolState, setPoolState] = useState(null);
  const [error, setError] = useState('');

  const check = useCallback(async () => {
    setChecking(true);
    setError('');
    try {
      // Saluran email: satu-satunya provider yang endpoint statusnya sudah lama
      // ada. Kegagalan di sini tidak boleh menggagalkan pembacaan status lain.
      try {
        const data = await tempmailRequest('status');
        setEmailReady(Boolean(data?.ok));
      } catch (err) {
        setEmailReady(false);
        setError(String(err?.message || err));
      }

      // OpenAI: dibaca dari server. "Tersambung" hanya berarti tautan OAuth
      // benar-benar berstatus linked — bukan sekadar tombolnya ada.
      const oauth = await openAiOAuthApi.status();
      if (oauth.ok) {
        const links = Array.isArray(oauth.data?.links) ? oauth.data.links : [];
        const linked = links.filter((link) => link.status === 'linked');
        setOauthState({
          linked: linked.length,
          pending: links.filter((link) => link.status === 'pending').length,
          planUsage: linked.some((link) => link.plan_usage),
          email: linked[0]?.email || '',
        });
      } else {
        setOauthState({ error: oauth.data?.error || 'Status OpenAI tidak bisa dibaca.' });
      }

      // Pool akun (API key) — dipakai tool gambar/video.
      const summary = await fetchPoolSummary();
      setPoolState(summary);
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
          <h1>Status dari server, bukan label di halaman ini.</h1>
          <p>
            Tekan <b>Periksa koneksi</b> untuk membaca keadaan sebenarnya: berapa akun OpenAI yang
            benar-benar siap dipakai pool, dan apakah saluran email hidup. BLEA hanya memakai
            koneksi resmi: OAuth pemilik akun dan API key provider.
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
            let state = provider.state;
            let detail = '';
            if (isEmail) {
              state = emailReady === false ? 'degraded' : (emailReady ? 'connected' : 'unknown');
            } else if (provider.check === 'oauth') {
              if (!oauthState) state = 'unknown';
              else if (oauthState.error) { state = 'unknown'; detail = oauthState.error; }
              else if (oauthState.linked > 0) {
                state = 'connected';
                detail = `${oauthState.linked} akun tertaut${oauthState.planUsage ? ' · izin paket aktif' : ' · izin paket belum dicentang'}${oauthState.email ? ` · ${oauthState.email}` : ''}`;
              } else {
                state = 'degraded';
                detail = oauthState.pending > 0
                  ? `${oauthState.pending} percobaan login belum selesai — tempel URL callback di halaman Akun OpenAI.`
                  : 'Belum ada akun yang benar-benar tertaut. Tekan Connect OpenAI di halaman Akun OpenAI.';
              }
            } else if (provider.id === 'openai-api') {
              if (!poolState || poolState.restricted) state = 'unknown';
              else if (poolState.error) { state = 'unknown'; detail = poolState.error; }
              else if (poolState.usable > 0) { state = 'connected'; detail = `${poolState.usable} akun ber-API key siap (dari ${poolState.total}).`; }
              else { state = 'degraded'; detail = `Ada ${poolState.total} akun, tidak ada yang siap.`; }
            }
            const label = state === 'connected' ? 'Tersambung'
              : state === 'degraded' ? 'Belum tersambung'
                : state === 'restricted' ? 'Tidak diukur'
                  : 'Belum diperiksa';
            return (
              <li key={provider.id} className={`studio-connection-item is-${state}`}>
                <span className="studio-connection-dot" aria-hidden="true">
                  {state === 'connected' ? <Check size={11} /> : <ShieldAlert size={11} />}
                </span>
                <div>
                  <b>{provider.label}</b>
                  <small>{provider.note}</small>
                  {detail && <small className="studio-connection-detail">{detail}</small>}
                </div>
                <span className={`studio-connection-state is-${state}`}>{label}</span>
              </li>
            );
          })}
        </ul>

        <section className="studio-connection-explain">
          <h2>“Koneksikan seperti freebeat, tanpa API key” — sudah ada</h2>
          <p>
            Sejak OpenAI membuka <b>Sign in with OpenAI</b>, akun OpenAI bisa disambungkan lewat
            OAuth resmi: tidak ada API key, tidak ada client secret, dan kuota yang terpakai adalah
            paket OpenAI pemilik akun. Tombolnya ada di
            <b> Studio → Akun OpenAI → Connect OpenAI</b>.
          </p>
          <ol>
            <li>Tekan tombol, lalu setujui di halaman OpenAI. BLEA mendaftarkan client-nya sendiri saat login pertama.</li>
            <li>Izin yang diminta: <code>openid profile email offline_access resource.invoke</code> ditambah izin paket akun dari OpenAI.</li>
            <li>Akses hanya untuk chat &amp; agen (Responses API teks). Gambar, video, audio, dan unggah berkas tidak tercakup izin ini.</li>
            <li>Token disimpan tersegel di server; koneksi bisa diputus kapan saja di halaman yang sama atau di OpenAI → Settings → Apps.</li>
          </ol>
          <p>
            Satu catatan teknis yang perlu diketahui: OpenAI mewajibkan hasil login dikirim ke
            <code>http://127.0.0.1:&lt;port&gt;/auth/callback</code>. Kalau BLEA dibuka dari domain
            publik (blea.ai), alamat itu tidak bisa dibuka otomatis — tempel URL callback-nya di
            halaman Akun OpenAI, atau jalankan BLEA di mesin sendiri lewat 127.0.0.1 agar selesai
            otomatis. Domain publik butuh client ID partner dari OpenAI (formulir Sign in with OpenAI).
          </p>

          <h2>Yang tetap tidak dilakukan: mendaftarkan akun otomatis</h2>
          <p>
            Permintaan itu berarti BLEA membuat email sekali pakai, mendaftarkannya ke akun
            OpenAI, lalu mengambil kode verifikasi secara otomatis. Itu tidak saya bangun, dan
            bukan karena teknisnya sulit saja:
          </p>
          <ol>
            <li>OpenAI tidak menyediakan API pendaftaran akun. Satu-satunya jalan adalah mengotomasi halaman signup mereka, dan itu melanggar ketentuan layanan mereka.</li>
            <li>Captcha dan deteksi bot membuat prosesnya rapuh; hasilnya akun mati di tengah jalan.</li>
            <li>Akun beremail sekali pakai biasanya dinonaktifkan, dan yang menanggung risikonya adalah pemilik akun BLEA.</li>
            <li>Kredensial akun pihak ketiga yang dikumpulkan otomatis adalah risiko keamanan untuk pengguna BLEA sendiri.</li>
          </ol>
          <h2>Jalur yang tersedia sekarang</h2>
          <p>
            <b>Connect OpenAI</b> (OAuth, tanpa API key) dan <b>API key admin</b> masuk ke pool
            yang sama di <b>Studio → Akun OpenAI</b>. Halaman itu menampilkan prioritas, sisa kuota
            harian, status cooldown, dan sumber kredensial tiap akun; bila akun pertama tidak bisa
            dipakai, permintaan otomatis pindah ke akun berikutnya. Hasil semua tool bisa diambil di
            <b> Studio → Hasil</b>.
          </p>
          <p className="studio-connection-links">
            <Link className="studio-connection-link" to="/studio/openai-accounts">Kelola akun OpenAI</Link>
            <Link className="studio-connection-link" to="/studio/library">Lihat hasil & unduhan</Link>
            <Link className="studio-connection-link" to="/studio">Kembali ke Studio</Link>
          </p>
        </section>
      </div>
    </DropXLayout>
  );
}

export default ConnectionPage;
