import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Disc3, Download, Music } from 'lucide-react';
import {
  buildDownloadFilename,
  fetchMusicConfig,
  fetchMusicHistory,
  fetchMusicStatus,
  generateMusic,
  withDownloadParam,
} from '../api/generation';
import { useAuth } from './AuthProvider';
import { useCredits } from '../lib/useCredits';
import { formatCredits, formatModelDisplayName, formatProviderBadge } from '../lib/formatCredits';
import { formatElapsedRuntime, useNowTick } from '../lib/formatRuntime';
import { ModelSelect } from './ModelSelect';
import './generate.css';
import './history.css';

// Large genre inspiration catalog grouped by category. Selecting an entry fills the prompt
// textarea with `text`; `tagline` is a short one-line preview shown under the name in the
// dropdown list (see ModelSelect `sub`).
const MUSIC_GENRE_CATALOG = [
  // Pop
  { value: 'pop-modern', category: 'Pop', label: 'Pop Modern', tagline: 'Anthem pop ceria & catchy', text: 'Upbeat modern pop anthem with polished vocals, a catchy hook, bright synth layers, and a punchy drum groove.' },
  { value: 'dance-pop', category: 'Pop', label: 'Dance Pop', tagline: 'Energik, ritme dansa', text: 'High-energy dance-pop track with a four-on-the-floor beat, shimmering synths, and an infectious sing-along chorus.' },
  { value: 'synth-pop', category: 'Pop', label: 'Synth Pop', tagline: 'Retro synth berkilau', text: 'Retro-inspired synth-pop with glossy analog synth leads, tight electronic drums, and dreamy falsetto vocals.' },
  { value: 'kpop-energetic', category: 'Pop', label: 'K-Pop Energetic', tagline: 'Beat trap-pop meledak', text: 'Vibrant K-pop energetic anthem with a sharp trap-pop beat, layered vocal harmonies, and an explosive chorus drop.' },
  { value: 'pop-ballad', category: 'Pop', label: 'Pop Ballad', tagline: 'Balada emosional', text: 'Emotional pop ballad with soaring piano chords, gentle strings, and heartfelt vocal delivery.' },
  { value: 'pop-punk', category: 'Pop', label: 'Pop Punk', tagline: 'Chord distorsi, teriak bareng', text: 'Energetic pop-punk anthem with distorted power chords, driving drums, and a shout-along chorus.' },
  // Rock
  { value: 'classic-rock', category: 'Rock', label: 'Classic Rock', tagline: 'Riff gitar klasik', text: 'Classic rock anthem with gritty electric guitar riffs, a driving bassline, and a powerful arena drum beat.' },
  { value: 'alternative-rock', category: 'Rock', label: 'Alternative Rock', tagline: 'Distorsi berlapis, moody', text: 'Moody alternative rock track with layered distorted guitars, dynamic verses, and a cathartic chorus.' },
  { value: 'indie-rock', category: 'Rock', label: 'Indie Rock', tagline: 'Gitar jangly santai', text: 'Jangly indie rock tune with bright guitar arpeggios, a relaxed groove, and understated vocal charm.' },
  { value: 'hard-rock', category: 'Rock', label: 'Hard Rock', tagline: 'Riff berat, agresif', text: 'Aggressive hard rock track with heavy guitar riffs, thunderous drums, and raspy powerful vocals.' },
  { value: 'pop-rock', category: 'Rock', label: 'Pop Rock', tagline: 'Hook gitar radio-friendly', text: 'Upbeat pop-rock track with catchy guitar hooks, a driving rhythm section, and a radio-friendly chorus.' },
  { value: 'post-rock', category: 'Rock', label: 'Post-Rock Atmospheric', tagline: 'Instrumental, membangun klimaks', text: 'Sweeping atmospheric post-rock instrumental with slow-building guitar layers, reverb-soaked textures, and a cinematic crescendo.' },
  // Elektronik / EDM
  { value: 'synthwave-sunset', category: 'Elektronik', label: 'Synthwave Sunset', tagline: 'Analog synth hangat', text: 'Upbeat synthwave sunset anthem with warm analog synths, punchy retro snare, and driving bassline.' },
  { value: 'deep-house', category: 'Elektronik', label: 'Deep House', tagline: 'Groovy, bass hangat', text: 'Groovy deep house track with warm sub-bass, soulful chord stabs, and a hypnotic four-on-the-floor beat.' },
  { value: 'techno-driving', category: 'Elektronik', label: 'Techno Driving', tagline: 'Kick menghentak, gelap', text: 'Relentless driving techno with a pounding kick drum, dark pulsing bassline, and industrial textures.' },
  { value: 'future-bass', category: 'Elektronik', label: 'Future Bass', tagline: 'Drop vokal chop berwarna', text: 'Colorful future bass drop with pitched vocal chops, lush supersaw synths, and a punchy trap-influenced beat.' },
  { value: 'trance-uplifting', category: 'Elektronik', label: 'Trance Uplifting', tagline: 'Synth lead euforik', text: 'Euphoric uplifting trance with soaring synth leads, a rolling bassline, and an emotional breakdown build-up.' },
  { value: 'drum-and-bass', category: 'Elektronik', label: 'Drum and Bass', tagline: 'Breakbeat cepat', text: 'Fast-paced drum and bass track with rapid breakbeats, a deep rolling bassline, and an energetic atmosphere.' },
  { value: 'dubstep-heavy', category: 'Elektronik', label: 'Dubstep Heavy', tagline: 'Bass wobble berat', text: 'Heavy dubstep drop with wobbling bass growls, aggressive sound design, and a half-time rhythm.' },
  { value: 'chillwave-dreamy', category: 'Elektronik', label: 'Chillwave Dreamy', tagline: 'Pad synth nostalgia', text: 'Dreamy chillwave soundscape with washed-out synth pads, a lo-fi drum machine groove, and hazy nostalgic vocals.' },
  // Hip-Hop / Rap
  { value: 'trap-modern', category: 'Hip-Hop', label: 'Trap Modern', tagline: '808 menggelegar', text: 'Modern trap beat with booming 808 bass, crisp hi-hat rolls, and a dark menacing melody.' },
  { value: 'boom-bap', category: 'Hip-Hop', label: 'Boom Bap Old School', tagline: 'Sampel vinyl klasik', text: 'Classic boom bap hip-hop beat with dusty vinyl samples, a punchy snare, and a laid-back groove.' },
  { value: 'lofi-hiphop', category: 'Hip-Hop', label: 'Lo-Fi Hip-Hop', tagline: 'Piano jazzy santai', text: 'Chill lo-fi hip-hop beat with a mellow jazzy piano loop, soft vinyl crackle, and relaxed boom-bap drums.' },
  { value: 'drill-dark', category: 'Hip-Hop', label: 'Drill Dark', tagline: '808 meluncur, tegang', text: 'Dark UK drill beat with sliding 808 bass, a tense string melody, and an aggressive hi-hat pattern.' },
  { value: 'conscious-rap', category: 'Hip-Hop', label: 'Conscious Rap', tagline: 'Sampel soulful, reflektif', text: 'Thoughtful conscious rap instrumental with a soulful sample loop, steady boom-bap drums, and an introspective mood.' },
  // R&B / Soul
  { value: 'smooth-rnb', category: 'R&B/Soul', label: 'Smooth R&B', tagline: 'Electric piano sutra', text: 'Smooth R&B groove with silky electric piano chords, a warm bassline, and a sultry vocal melody.' },
  { value: 'neo-soul', category: 'R&B/Soul', label: 'Neo Soul', tagline: 'Chord jazzy, groove ketat', text: 'Laid-back neo-soul track with jazzy chord extensions, a tight groove, and soulful vocal ad-libs.' },
  { value: 'funk-groove', category: 'R&B/Soul', label: 'Funk Groove', tagline: 'Slap bass, tiupan cerah', text: 'Funky groove with punchy slap bass, tight rhythm guitar, and bright horn section stabs.' },
  { value: 'motown-retro', category: 'R&B/Soul', label: 'Motown Retro', tagline: 'Horn vintage, tamborin', text: 'Retro Motown-style soul track with vintage horns, a tambourine groove, and a heartfelt vocal performance.' },
  // Jazz
  { value: 'jazz-lounge', category: 'Jazz', label: 'Jazz Lounge', tagline: 'Saksofon santai', text: 'Relaxed jazz lounge track with a smooth saxophone melody, walking double bass, and brushed drums.' },
  { value: 'bebop-energetic', category: 'Jazz', label: 'Bebop Energetic', tagline: 'Swing cepat, improvisasi', text: 'Energetic bebop jazz with a fast swinging rhythm, virtuosic piano runs, and lively horn improvisation.' },
  { value: 'smooth-jazz', category: 'Jazz', label: 'Smooth Jazz', tagline: 'Saksofon lembut', text: 'Mellow smooth jazz with warm electric piano, a gentle saxophone lead, and a soft bass groove.' },
  { value: 'jazz-fusion', category: 'Jazz', label: 'Jazz Fusion', tagline: 'Ritme kompleks, solo gitar', text: 'Dynamic jazz fusion track blending complex rhythms, electric guitar solos, and a funky bass groove.' },
  // Klasik / Orkestra
  { value: 'orkestra-epik', category: 'Klasik', label: 'Orkestra Epik', tagline: 'String & brass megah', text: 'Cinematic orchestral trailer score with soaring strings, brass swells, taiko drums, and dramatic choir.' },
  { value: 'piano-solo', category: 'Klasik', label: 'Piano Solo Emotional', tagline: 'Melodi reflektif', text: 'Emotional solo piano piece with a delicate melody, expressive dynamics, and a reflective mood.' },
  { value: 'string-quartet', category: 'Klasik', label: 'String Quartet Romantic', tagline: 'Violin & cello elegan', text: 'Romantic string quartet piece with a lush violin melody, warm cello harmony, and elegant phrasing.' },
  { value: 'choir-sacred', category: 'Klasik', label: 'Choir Sacred', tagline: 'Paduan suara megah', text: 'Majestic sacred choir piece with soaring vocal harmonies, organ accompaniment, and a reverent atmosphere.' },
  { value: 'baroque-harpsichord', category: 'Klasik', label: 'Baroque Harpsichord', tagline: 'Kontrapoin anggun', text: 'Intricate baroque composition with an ornate harpsichord melody, structured counterpoint, and an elegant string ensemble.' },
  // Folk / Akustik
  { value: 'akustik-indie', category: 'Folk', label: 'Akustik Indie', tagline: 'Gitar hangat, drum lembut', text: 'Warm Indonesian indie folk acoustic guitar ballad with soft brushed drums, gentle strings, and heartfelt melody.' },
  { value: 'country-road', category: 'Folk', label: 'Country Road', tagline: 'Gitar twangy, cerita', text: 'Warm country road anthem with twangy acoustic guitar, a steady train-beat rhythm, and storytelling vocals.' },
  { value: 'bluegrass-lively', category: 'Folk', label: 'Bluegrass Lively', tagline: 'Banjo cepat, biola', text: 'Lively bluegrass tune with fast banjo picking, a fiddle melody, and an upbeat acoustic rhythm.' },
  { value: 'singer-songwriter', category: 'Folk', label: 'Singer-Songwriter Intimate', tagline: 'Fingerpicking, vokal jujur', text: 'Intimate singer-songwriter ballad with fingerpicked acoustic guitar and tender, honest vocal delivery.' },
  { value: 'flamenco', category: 'Folk', label: 'Flamenco Spanish Guitar', tagline: 'Strumming cepat, tepuk tangan', text: 'Passionate flamenco with rapid Spanish guitar strumming, rhythmic hand claps, and fiery melodic runs.' },
  // Musik Dunia / Nusantara
  { value: 'dangdut-koplo', category: 'Dunia', label: 'Dangdut Koplo', tagline: 'Kendang riang', text: 'Energetic dangdut koplo with a bouncy kendang rhythm, playful gendang drum fills, and a catchy vocal melody.' },
  { value: 'gamelan-tradisional', category: 'Dunia', label: 'Gamelan Tradisional', tagline: 'Metalofon meditatif', text: 'Traditional Javanese gamelan ensemble with shimmering metallophone melodies and meditative rhythmic cycles.' },
  { value: 'keroncong-nostalgia', category: 'Dunia', label: 'Keroncong Nostalgia', tagline: 'Ukulele & selo lembut', text: 'Nostalgic keroncong ballad with gentle ukulele strumming, soft cello pizzicato, and a romantic vocal melody.' },
  { value: 'reggae-pantai', category: 'Dunia', label: 'Reggae Pantai', tagline: 'Skank santai, vibe pantai', text: 'Laid-back reggae groove with off-beat guitar skank, a warm bassline, and a sunny island vibe.' },
  { value: 'latin-salsa', category: 'Dunia', label: 'Latin Salsa', tagline: 'Horn & perkusi meriah', text: 'Vibrant salsa track with a lively horn section, syncopated percussion, and an infectious dance rhythm.' },
  { value: 'bollywood-meriah', category: 'Dunia', label: 'Bollywood Meriah', tagline: 'Tabla & sitar perayaan', text: 'Festive Bollywood-style track with an energetic tabla rhythm, sitar melody, and celebratory orchestral swells.' },
  // Lo-Fi / Santai
  { value: 'lofi-chill', category: 'Lo-Fi', label: 'Lo-Fi Chill', tagline: 'Vinyl crackle, Rhodes', text: 'Relaxing late-night lo-fi chillhop beat with dusty vinyl crackle, electric Rhodes chords, and mellow bass.' },
  { value: 'ambient-dreamscape', category: 'Lo-Fi', label: 'Ambient Dreamscape', tagline: 'Pad mengambang', text: 'Ethereal ambient soundscape with slow evolving pads, soft textures, and a tranquil atmosphere.' },
  { value: 'study-beats', category: 'Lo-Fi', label: 'Study Beats Calm', tagline: 'Fokus, tenang', text: 'Calm study beats with a mellow piano loop, a soft kick pattern, and an unobtrusive relaxing mood.' },
  { value: 'rainy-day', category: 'Lo-Fi', label: 'Rainy Day Mellow', tagline: 'Hujan & piano hangat', text: 'Mellow rainy-day track with soft rain ambience, warm lo-fi piano, and gentle vinyl crackle.' },
  // Sinematik
  { value: 'trailer-dramatis', category: 'Sinematik', label: 'Trailer Dramatis', tagline: 'Perkusi & brass menegangkan', text: 'Powerful cinematic trailer music with pounding percussion, rising brass hits, and dramatic orchestral tension.' },
  { value: 'horor-mencekam', category: 'Sinematik', label: 'Horor Mencekam', tagline: 'String disonan, drone', text: 'Tense horror underscore with eerie strings, dissonant textures, and unsettling atmospheric drones.' },
  { value: 'fantasi-petualangan', category: 'Sinematik', label: 'Petualangan Fantasi', tagline: 'Tema brass heroik', text: 'Adventurous fantasy score with heroic brass themes, sweeping strings, and magical woodwind flourishes.' },
  { value: 'scifi-futuristik', category: 'Sinematik', label: 'Sci-Fi Futuristik', tagline: 'Arpeggio synth logam', text: 'Futuristic sci-fi soundscape with pulsing synth arpeggios, metallic textures, and a tense atmospheric buildup.' },
  // Metal
  { value: 'heavy-metal', category: 'Metal', label: 'Heavy Metal Agresif', tagline: 'Riff berat, scream', text: 'Aggressive heavy metal track with crushing guitar riffs, double bass drum blasts, and intense screamed vocals.' },
  { value: 'symphonic-metal', category: 'Metal', label: 'Symphonic Metal', tagline: 'Orkestra & vokal operatik', text: 'Dramatic symphonic metal combining orchestral strings, operatic vocals, and powerful distorted guitars.' },
  { value: 'metalcore', category: 'Metal', label: 'Metalcore Intens', tagline: 'Breakdown & chorus melodis', text: 'Intense metalcore track with breakdown-heavy riffs, aggressive screams, and a melodic clean chorus.' },
  { value: 'doom-metal', category: 'Metal', label: 'Doom Metal Lambat', tagline: 'Tone sludgy, berat', text: 'Slow and heavy doom metal with a sludgy guitar tone, an ominous atmosphere, and a crushing low-end groove.' },
  // Anak & Perayaan
  { value: 'anak-ceria', category: 'Perayaan', label: 'Anak Ceria', tagline: 'Xilofon ceria', text: "Playful children's song with a bouncy melody, bright xylophone tones, and cheerful sing-along vocals." },
  { value: 'natal-meriah', category: 'Perayaan', label: 'Natal Meriah', tagline: 'Lonceng & paduan suara', text: 'Festive Christmas song with jingling bells, warm strings, and joyful choir harmonies.' },
  { value: 'ultah-gembira', category: 'Perayaan', label: 'Ulang Tahun Gembira', tagline: 'Tepuk tangan ceria', text: 'Cheerful birthday celebration tune with an upbeat clapping rhythm and a joyful festive melody.' },
  // Spiritual
  { value: 'gospel-membangkitkan', category: 'Spiritual', label: 'Gospel Membangkitkan', tagline: 'Paduan suara penuh semangat', text: 'Uplifting gospel anthem with powerful choir harmonies, driving piano chords, and a soulful lead vocal.' },
  { value: 'nasheed-syahdu', category: 'Spiritual', label: 'Nasheed Syahdu', tagline: 'Vokal harmoni, perkusi lembut', text: 'Soulful acapella-style nasheed with gentle vocal harmonies, rhythmic percussion, and a reflective spiritual mood.' },
];

const STATUS_LABEL = {
  submitted: 'Sedang diproses',
  queued: 'Dalam antrean',
  processing: 'Sedang diproses',
  completed: 'Selesai',
  failed: 'Gagal',
  cancelled: 'Dibatalkan',
  unknown: 'Hasil tidak pasti',
};

const isPending = (item) => item.status === 'queued' || item.status === 'processing' || item.status === 'submitted';

function formatTrackDuration(ms) {
  const num = Number(ms);
  if (!Number.isFinite(num) || num <= 0) return '';
  const totalSec = Math.round(num / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function GenerateMusicPanel({ initialPrompt = '' }) {
  const { user } = useAuth();
  const isAdmin = user?.app_metadata?.role === 'admin';
  const userId = user?.id;
  const { balance, refresh: refreshBalance } = useCredits(userId);
  const [config, setConfig] = useState(null);
  const [selected, setSelected] = useState('');
  const [genreValue, setGenreValue] = useState('');
  const [prompt, setPrompt] = useState(initialPrompt);
  const [instrumental, setInstrumental] = useState(false);
  const [lyrics, setLyrics] = useState('');
  const [durationSeconds, setDurationSeconds] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitStartedAt, setSubmitStartedAt] = useState(null);
  const pollVersion = useRef(0);

  const hasActiveMusicJobs = busy || items.some(isPending);
  const liveNowMs = useNowTick(hasActiveMusicJobs, 1000);

  const load = useCallback(async () => {
    setLoading(true);
    const [configRes, historyRes] = await Promise.all([fetchMusicConfig(), fetchMusicHistory()]);
    if (configRes.ok) setConfig(configRes.data);
    if (historyRes.ok && Array.isArray(historyRes.data?.generations)) setItems(historyRes.data.generations);
    refreshBalance();
    setLoading(false);
  }, [refreshBalance]);

  useEffect(() => { load(); }, [load]);

  const models = Array.isArray(config?.models) ? config.models : [];
  const active = models.find((m) => `${m.provider}:${m.model}` === selected)
    || models.find((m) => m.ready)
    || models[0]
    || null;
  const supportsDuration = (active?.supports_duration ?? active?.params?.supports_duration) === true;
  const supportsLyrics = active?.supports_lyrics ?? active?.params?.supports_lyrics ?? null;
  const supportsInstrumental = active?.supports_instrumental ?? active?.params?.supports_instrumental ?? null;
  const requiresLyrics = (active?.requires_lyrics ?? active?.params?.requires_lyrics) === true;

  useEffect(() => {
    if (!active) return;
    if (selected !== `${active.provider}:${active.model}`) {
      setSelected(`${active.provider}:${active.model}`);
    }
    if ((supportsInstrumental === false || requiresLyrics) && instrumental) {
      setInstrumental(false);
    }
    if (supportsLyrics === false && lyrics) {
      setLyrics('');
    }
    if (!supportsDuration && durationSeconds !== '') {
      setDurationSeconds('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.provider, active?.model, supportsDuration, supportsLyrics, supportsInstrumental, requiresLyrics]);

  useEffect(() => {
    const pending = items.filter((item) => isPending(item) && item.canPoll).slice(0, 4);
    if (!pending.length) return undefined;
    const version = ++pollVersion.current;
    const timer = setInterval(async () => {
      const results = await Promise.all(pending.map((item) => fetchMusicStatus(item.id)));
      if (version !== pollVersion.current) return;
      const updates = new Map(
        results
          .filter((res) => res.ok && res.data?.generation)
          .map((res) => [res.data.generation.id, res.data.generation]),
      );
      if (!updates.size) return;
      setItems((current) => current.map((item) => updates.get(item.id) || item));
      if ([...updates.values()].some((item) => !isPending(item))) refreshBalance();
    }, 10000);
    return () => { clearInterval(timer); };
  }, [items, refreshBalance]);

  async function submit(event) {
    event.preventDefault();
    const cleanPrompt = prompt.trim();
    const cleanLyrics = lyrics.trim();
    if (busy || !active || !cleanPrompt) return;
    if (instrumental && cleanLyrics) {
      setError('Nonaktifkan mode instrumental jika ingin mengisi lirik lagu.');
      return;
    }
    if (requiresLyrics && !cleanLyrics) {
      setError(`Model ${active.name || active.model} mewajibkan lirik lagu.`);
      return;
    }
    let cleanDuration;
    if (supportsDuration && String(durationSeconds).trim() !== '') {
      const parsed = Number(String(durationSeconds).trim());
      if (!Number.isFinite(parsed) || parsed < 10 || parsed > 300) {
        setError('Durasi lagu harus antara 10 hingga 300 detik.');
        return;
      }
      cleanDuration = parsed;
    }

    setBusy(true);
    setError('');
    setNotice('');
    setSubmitStartedAt(Date.now());
    const res = await generateMusic({
      provider: active.provider,
      model: active.model,
      prompt: cleanPrompt,
      ...(instrumental ? { instrumental: true } : {}),
      ...(!instrumental && cleanLyrics ? { lyrics: cleanLyrics } : {}),
      ...(cleanDuration !== undefined ? { duration_seconds: cleanDuration } : {}),
    });

    if (!res.ok) {
      setError(res.data?.error || 'Generasi musik gagal. Kredit tidak dipotong bila kegagalan terjadi sebelum pengiriman.');
      refreshBalance();
      setBusy(false);
      setSubmitStartedAt(null);
      return;
    }
    const generation = res.data?.generation || null;
    if (generation) {
      setItems((current) => [generation, ...current.filter((item) => item.id !== generation.id)]);
    }
    const billed = res.data?.credits ?? active.credits ?? 0;
    if (res.data?.status === 'unknown') {
      setError('Hasil pengiriman tidak pasti dan kredit mungkin sudah terpakai. Jangan ulangi; periksa status di riwayat terlebih dahulu.');
    } else {
      setNotice(`Permintaan musik diterima (${formatCredits(billed)} kredit BLEA). Musik sedang dibuat dan akan tampil otomatis saat selesai.`);
    }
    refreshBalance();
    setBusy(false);
    setSubmitStartedAt(null);
  }

  const price = active && Number.isSafeInteger(active.credits) ? active.credits : null;
  const ready = active?.ready === true && price !== null;
  const insufficient = price !== null && balance !== null && balance < price;
  const missingRequiredLyrics = Boolean(requiresLyrics && !lyrics.trim());

  return (
    <div className="generate-card">
      <div className="generate-card-head">
        <div>
          <h2 className="generate-card-title">Generate musik</h2>
          <p className="generate-card-sub">Dari teks, gaya musik, atau lirik</p>
        </div>
      </div>

      {loading && <p className="generate-hint" role="status">Memuat konfigurasi musik…</p>}

      {!loading && models.length === 0 && (
        <div className="generate-banner" role="status">
          <span>Belum ada model musik yang diaktifkan &amp; diberi harga kredit oleh admin.</span>
          {isAdmin && <Link className="generate-banner-link" to="/admin?tab=api-keys&sub=catalog">Atur di Katalog Model</Link>}
        </div>
      )}

      {!loading && isAdmin && Array.isArray(config?.freebeat_unpriced) && config.freebeat_unpriced.length > 0 && (
        <div className="generate-banner" role="status">
          <span>
            {config.freebeat_unpriced.length} model musik Freebeat sudah aktif di Katalog Model tetapi belum punya harga kredit BLEA, sehingga belum tampil di daftar konsumen ({config.freebeat_unpriced.slice(0, 3).map((m) => m.name || m.model).join(', ')}{config.freebeat_unpriced.length > 3 ? ', …' : ''}).
          </span>
          <Link className="generate-banner-link" to="/admin?tab=api-keys&sub=catalog">Atur harga kredit</Link>
        </div>
      )}

      {!loading && active && !config?.provider_ready && (
        <div className="generate-banner" role="status">
          <span>Provider musik belum dihubungkan oleh admin di Pool Freebeat OAuth, jadi generasi belum dapat dikirim. Tidak ada kredit yang dipotong.</span>
          {isAdmin && <Link className="generate-banner-link" to="/admin?tab=freebeat-oauth">Kelola Pool OAuth</Link>}
        </div>
      )}

      {error && <div className="generate-banner is-error" role="alert">{error}</div>}
      {notice && <div className="generate-banner is-success" role="status">{notice}</div>}
      {insufficient && ready && (
        <div className="generate-banner" role="status">
          <span>Saldo kredit BLEA Anda kurang dari {formatCredits(price)} kredit. Saldo ada di pojok kanan atas.</span>
          <Link className="generate-banner-link" to="/credits">Tambah kredit</Link>
        </div>
      )}

      <form className="generate-form" onSubmit={submit}>
        {models.length > 0 && (
          <div className="generate-field">
            <div className="generate-label-row">
              <span className="generate-label">Model musik</span>
              <span className="generate-hint">{models.length} model</span>
            </div>
            <ModelSelect
              ariaLabel="Model musik"
              value={active ? `${active.provider}:${active.model}` : ''}
              options={models.map((model) => {
                const badge = formatProviderBadge(model.provider);
                const displayName = formatModelDisplayName(model.name, model.provider);
                const creditLabel = Number.isSafeInteger(model.credits) ? `${formatCredits(model.credits)} kredit` : 'Belum bertarif';
                return {
                  value: `${model.provider}:${model.model}`,
                  badge,
                  label: displayName,
                  meta: creditLabel,
                  tone: Number.isSafeInteger(model.credits) ? 'accent' : 'warn',
                  nativeLabel: `[${badge}] ${displayName}${Number.isSafeInteger(model.credits) ? ` · ${creditLabel}` : ' · harga belum diatur'}`,
                };
              })}
              onChange={(nextValue) => {
                setSelected(nextValue);
                setError('');
                setNotice('');
              }}
            />
          </div>
        )}

        <div className="generate-field">
          <div className="generate-label-row">
            <span className="generate-label">Inspirasi genre</span>
            <span className="generate-hint">{MUSIC_GENRE_CATALOG.length} genre &middot; pilih untuk mengisi prompt</span>
          </div>
          <ModelSelect
            ariaLabel="Inspirasi genre musik"
            placeholder="Pilih genre inspirasi"
            value={genreValue}
            options={MUSIC_GENRE_CATALOG.map((genre) => ({
              value: genre.value,
              label: genre.label,
              badge: genre.category,
              sub: genre.tagline,
              nativeLabel: `[${genre.category}] ${genre.label}`,
            }))}
            onChange={(nextValue) => {
              const genre = MUSIC_GENRE_CATALOG.find((item) => item.value === nextValue);
              if (!genre) return;
              setGenreValue(nextValue);
              setPrompt(genre.text);
              setError('');
              setNotice('');
            }}
          />
        </div>

        <label className="generate-field">
          <div className="generate-label-row">
            <span className="generate-label">Prompt musik</span>
            <span className="generate-hint">{prompt.trim().length}/2000</span>
          </div>
          <textarea
            className="generate-textarea"
            rows={3}
            maxLength={2000}
            value={prompt}
            placeholder="Contoh: lagu pop upbeat bertempo cepat dengan vokal hangat, synth modern, dan beat drum renyah"
            onChange={(event) => { setPrompt(event.target.value); setNotice(''); }}
          />
        </label>

        {supportsInstrumental !== false && !requiresLyrics && (
          <label className="generate-toggle">
            <input
              type="checkbox"
              checked={instrumental}
              disabled={busy}
              onChange={(event) => {
                const checked = event.target.checked;
                setInstrumental(checked);
                if (checked) setLyrics('');
                setError('');
                setNotice('');
              }}
            />
            <span>Instrumental (tanpa vokal)</span>
          </label>
        )}

        {supportsLyrics !== false && (
          <label className="generate-field">
            <div className="generate-label-row">
              <span className="generate-label">
                Lirik lagu {requiresLyrics ? '(wajib)' : '(opsional)'}
              </span>
              <span className="generate-hint">
                {instrumental ? 'Nonaktif saat mode instrumental' : `${lyrics.trim().length}/12000`}
              </span>
            </div>
            <textarea
              className="generate-textarea"
              rows={4}
              maxLength={12000}
              value={lyrics}
              disabled={busy || instrumental}
              placeholder={instrumental ? 'Mode instrumental aktif (tanpa vokal/lirik)' : '[Verse 1]\nDi bawah langit senja kota...\n\n[Chorus]\nMelangkah jauh menuju bintang...'}
              onChange={(event) => { setLyrics(event.target.value); setNotice(''); }}
            />
          </label>
        )}

        {supportsDuration && (
          <label className="generate-field">
            <div className="generate-label-row">
              <span className="generate-label">Target durasi (opsional, 10–300 detik)</span>
            </div>
            <input
              type="number"
              min={10}
              max={300}
              step={1}
              className="generate-select"
              value={durationSeconds}
              disabled={busy}
              placeholder="Kosongkan untuk durasi bawaan model"
              onChange={(event) => { setDurationSeconds(event.target.value); setNotice(''); }}
            />
          </label>
        )}

        <div className="generate-actions">
          <button
            className="generate-submit-btn"
            type="submit"
            disabled={busy || !ready || insufficient || missingRequiredLyrics || !prompt.trim()}
          >
            {busy && <span className="generate-btn-spinner" aria-hidden="true" />}
            {busy ? 'Mengirim…' : 'Buat musik'}
          </button>
          <button className="generate-secondary-btn" type="button" disabled={busy || loading} onClick={load}>
            Perbarui
          </button>
        </div>
      </form>

      {(busy || items.some(isPending)) && (() => {
        const pendingItem = items.find(isPending);
        const stageStatus = busy ? 'Mengirim ke Studio Musik AI…' : (STATUS_LABEL[pendingItem?.status] || 'Sedang diproses');
        const stageModel = formatModelDisplayName(pendingItem?.model_name || active?.name || 'Musik AI', 'freebeat');
        const stagePrompt = (pendingItem?.prompt || prompt || '').trim();
        const stageStartedAt = busy ? submitStartedAt : (pendingItem?.created_at || null);
        const stageRuntime = stageStartedAt ? formatElapsedRuntime(stageStartedAt, liveNowMs) : '00:00';
        return (
          <div className="generate-img-live-stage" role="status" aria-live="polite">
            <div className="generate-aurora" aria-hidden="true" />
            <div className="generate-scanbeam" aria-hidden="true" />
            <div className="generate-orbit is-image" aria-hidden="true">
              <span className="generate-orbit-ring" />
              <span className="generate-orbit-ring is-inner" />
              <span className="generate-img-core">
                <Music size={18} />
              </span>
            </div>
            <span className="generate-loader-badge">
              <span className="generate-pulse-dot" aria-hidden="true" />
              {stageStatus}
            </span>
            <div className="generate-eq" aria-hidden="true">
              <i /><i /><i /><i /><i />
            </div>
            <div className="generate-progress-wrap">
              <div className="generate-progress-bar">
                <div className="generate-progress-fill is-animated" style={{ width: busy ? '34%' : '70%' }} />
              </div>
              <span className="generate-loader-sub">
                {stageModel} · Berjalan {stageRuntime} · Menyusun aransemen &amp; vokal…
              </span>
              <Link className="generate-banner-link" style={{ alignSelf: 'center', marginTop: 4 }} to="/live">
                Pantau di Proses Live
              </Link>
            </div>
            {stagePrompt && <p className="generate-img-live-prompt">{stagePrompt}</p>}
          </div>
        );
      })()}

      {items.length > 0 && (
        <div className="generate-history">
          <h3 className="generate-card-title">Riwayat musik</h3>
          <div className="history-grid">
            {items.slice(0, 12).map((item) => {
              const audioStreams = Array.isArray(item.audio_stream_urls) && item.audio_stream_urls.length > 0
                ? item.audio_stream_urls
                : (item.audio_stream_url ? [item.audio_stream_url] : []);
              const audioDownloads = Array.isArray(item.download_urls) && item.download_urls.length > 0
                ? item.download_urls
                : (item.download_url ? [item.download_url] : audioStreams);
              const isLoadingItem = isPending(item);
              const trackDuration = formatTrackDuration(item.duration_ms);
              return (
                <article className="history-card" key={item.id}>
                  {item.status === 'completed' ? (
                    item.cover_stream_url ? (
                      <img src={item.cover_stream_url} alt={item.title || item.prompt || 'Cover musik'} loading="lazy" />
                    ) : (
                      <div className="history-preview is-music-cover" aria-hidden="true">
                        <Disc3 size={34} />
                      </div>
                    )
                  ) : isLoadingItem ? (
                    <div className="history-preview generate-img-loader" role="status" aria-live="polite">
                      <div className="generate-aurora is-subtle" aria-hidden="true" />
                      <div className="generate-scanbeam" aria-hidden="true" />
                      <div className="generate-orbit is-compact" aria-hidden="true">
                        <span className="generate-orbit-ring" />
                        <span className="generate-orbit-ring is-inner" />
                        <Music size={13} className="generate-img-core-icon" />
                      </div>
                      <span className="generate-loader-badge">
                        <span className="generate-pulse-dot" aria-hidden="true" />
                        {STATUS_LABEL[item.status] || 'Memproses…'}
                      </span>
                      <span className="generate-img-loader-sub">Berjalan {formatElapsedRuntime(item.created_at, liveNowMs)} · Merender musik AI…</span>
                    </div>
                  ) : (
                    <div className="history-preview">{STATUS_LABEL[item.status] || item.status}</div>
                  )}
                  <div className="history-card-body">
                    <span className={`history-status status-${item.status}`}>
                      {STATUS_LABEL[item.status] || item.status}
                      {isLoadingItem ? ` · ${formatElapsedRuntime(item.created_at, liveNowMs)}` : ''}
                    </span>
                    {item.title && <h4 className="history-music-title">{item.title}</h4>}
                    <p className="history-prompt">{item.prompt || 'Tanpa prompt'}</p>
                    <p className="history-meta">
                      {item.created_at ? new Date(item.created_at).toLocaleString('id-ID') : '—'} · {item.model_name || `model ${item.model}`}
                      {trackDuration ? ` · ${trackDuration}` : ''}
                      {item.instrumental ? ' · Instrumental' : ''}
                      {` · ${formatCredits(item.credits_charged)} kredit`}
                      {item.credits_refunded > 0 ? ` · ${formatCredits(item.credits_refunded)} dikembalikan` : ''}
                    </p>
                    {item.error_message && <p className="history-error-text">{item.error_message}</p>}
                    {item.status === 'unknown' && (
                      <p className="history-error-text">Jangan ulangi sebelum statusnya jelas; kredit mungkin sudah terpakai.</p>
                    )}
                    {item.status === 'completed' && audioStreams.length > 0 && (
                      <div className="history-music-players">
                        {audioStreams.map((streamUrl, idx) => {
                          const downloadHref = withDownloadParam(audioDownloads[idx] || streamUrl);
                          return (
                            <div className="history-music-track" key={`${item.id}-track-${idx}`}>
                              <audio controls preload="none" src={streamUrl} aria-label={item.title || `Audio ${idx + 1}`} />
                              <div className="history-card-actions">
                                <a
                                  className="history-download-btn"
                                  href={downloadHref}
                                  download={buildDownloadFilename({ kind: 'music', id: item.id, index: idx, total: audioStreams.length, url: downloadHref })}
                                >
                                  <Download size={14} aria-hidden="true" />
                                  {audioStreams.length > 1 ? `Unduh audio #${idx + 1}` : 'Unduh audio'}
                                </a>
                                <a href={streamUrl} target="_blank" rel="noopener noreferrer">
                                  {audioStreams.length > 1 ? `Buka audio #${idx + 1}` : 'Buka audio'}
                                </a>
                                {idx === 0 && item.cover_download_url && (
                                  <a
                                    href={withDownloadParam(item.cover_download_url)}
                                    download={buildDownloadFilename({ kind: 'music_cover', id: item.id, url: item.cover_download_url })}
                                  >
                                    Unduh cover
                                  </a>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          <p className="generate-hint">Riwayat lengkap tersedia di <Link to="/history">halaman History</Link>.</p>
        </div>
      )}
    </div>
  );
}
