// Format subtitle: SRT (CapCut/Premiere/YouTube) dan WebVTT (web/TikTok web).
// Fungsi murni tanpa browser, supaya bisa diuji dan dipakai ulang nanti saat
// burn-in ke canvas mulai dikerjakan.

/**
 * Pecah satu segmen panjang menjadi beberapa baris subtitle pendek.
 * Whisper kadang mengembalikan 12 detik teks dalam satu segmen; subtitle
 * sepanjang itu tidak terbaca di layar ponsel. Pembagian dilakukan pada batas
 * kata, dan durasi dibagi proporsional terhadap jumlah karakter, bukan jumlah
 * kata, karena "Oke" dan "bertanggung jawab" tidak butuh waktu yang sama.
 */
export function splitSegment(segment, maxChars = 42) {
  const text = String(segment?.text || '').trim();
  const start = Number(segment?.startSec);
  const end = Number(segment?.endSec);
  if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  if (text.length <= maxChars) return [{ startSec: start, endSec: end, text }];

  const words = text.split(/\s+/);
  const groups = [];
  let current = [];
  for (const word of words) {
    const candidate = [...current, word].join(' ');
    if (candidate.length > maxChars && current.length) {
      groups.push(current);
      current = [word];
    } else {
      current.push(word);
    }
  }
  if (current.length) groups.push(current);

  const totalChars = groups.reduce((sum, group) => sum + group.join(' ').length, 0) || 1;
  const duration = end - start;
  let cursor = start;
  return groups.map((group, index) => {
    const share = group.join(' ').length / totalChars;
    const from = cursor;
    const to = index === groups.length - 1 ? end : Math.min(end, from + duration * share);
    cursor = to;
    return {
      startSec: Math.round(from * 100) / 100,
      endSec: Math.round(Math.max(from + 0.3, to) * 100) / 100,
      text: group.join(' '),
    };
  });
}

export function buildCues(segments, { maxChars = 42 } = {}) {
  const out = [];
  for (const segment of segments || []) {
    for (const cue of splitSegment(segment, maxChars)) out.push(cue);
  }
  return out;
}

function stamp(seconds, separator) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const millis = Math.round((total - Math.floor(total)) * 1000);
  // 59,9996 dibulatkan jadi 1000 ms: naikkan detik, bukan mencetak "1000".
  const rolled = millis === 1000
    ? { s: secs + 1, ms: 0 }
    : { s: secs, ms: millis };
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(rolled.s)}${separator}${pad(rolled.ms, 3)}`;
}

export function toSrt(segments, options = {}) {
  return buildCues(segments, options)
    .map((cue, index) => `${index + 1}\n${stamp(cue.startSec, ',')} --> ${stamp(cue.endSec, ',')}\n${cue.text}`)
    .join('\n\n')
    .concat('\n');
}

export function toVtt(segments, options = {}) {
  const body = buildCues(segments, options)
    .map((cue) => `${stamp(cue.startSec, '.')} --> ${stamp(cue.endSec, '.')}\n${cue.text}`)
    .join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

export function toPlainText(segments) {
  return (segments || []).map((segment) => String(segment?.text || '').trim()).filter(Boolean).join('\n');
}

/**
 * Potong transkrip agar relatif terhadap klip [startSec, endSec).
 * Ini yang membuat satu transkrip video panjang bisa dipakai untuk setiap klip
 * tanpa memanggil Whisper berulang kali.
 */
export function sliceTranscript(segments, startSec, endSec) {
  const from = Number(startSec) || 0;
  const to = Number(endSec) || 0;
  const out = [];
  for (const segment of segments || []) {
    const segStart = Number(segment?.startSec);
    const segEnd = Number(segment?.endSec);
    if (!Number.isFinite(segStart) || !Number.isFinite(segEnd)) continue;
    if (segEnd <= from || segStart >= to) continue;
    out.push({
      startSec: Math.round((Math.max(from, segStart) - from) * 100) / 100,
      endSec: Math.round((Math.min(to, segEnd) - from) * 100) / 100,
      text: String(segment.text || '').trim(),
    });
  }
  return out;
}

// Template tampilan subtitle. Belum dipakai untuk burn-in (itu butuh encoder
// canvas di browser); dipakai sebagai metadata pilihan gaya yang ikut terkirim
// bersama SRT supaya nanti konsisten saat render benar-benar diaktifkan.
export const SUBTITLE_TEMPLATES = [
  { id: 'clean', label: 'Bersih', note: 'Teks putih, latar transparan, aman untuk semua video.' },
  { id: 'boxed', label: 'Kotak', note: 'Teks putih dengan kotak solid — paling terbaca di video ramai.' },
  { id: 'outline', label: 'Garis tepi', note: 'Teks tebal dengan outline hitam, gaya TikTok.' },
  { id: 'karaoke', label: 'Karaoke', note: 'Kata yang sedang diucapkan disorot; butuh timestamp per kata.' },
];
