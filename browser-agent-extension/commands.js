export function parseTaskCommands(input) {
  const lines = String(input || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { error: 'Tulis setidaknya satu langkah.' };
  const auto = /^lakukan tanpa konfirmasi$/i.test(lines[0]);
  const commands = auto ? lines.slice(1) : lines;
  if (!commands.length) return { error: 'Tambahkan langkah setelah baris “lakukan tanpa konfirmasi”.' };
  const actions = commands.map(parseCommand);
  const failure = actions.find((action) => action.error);
  return failure ? { error: failure.error } : { auto, actions };
}

export function parseCommand(input) {
  const text = String(input || '').trim();
  let match;
  if (!text) return { error: 'Tulis perintah terlebih dahulu.' };
  match = /^(?:cari|search)\s+(.+?)(?:\s+di\s+google)?$/i.exec(text);
  if (match) return { type: 'search', query: match[1].trim() };
  match = /^(?:buka|open)\s+(https?:\/\/\S+)$/i.exec(text);
  if (match) {
    try {
      const url = new URL(match[1]);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) return { error: 'URL tidak valid.' };
      return { type: 'open', url: url.href };
    } catch { return { error: 'URL tidak valid.' }; }
  }
  if (/^(?:baca|ringkas|read)\s+(?:halaman|page)?\s*$/i.test(text)) return { type: 'read' };
  match = /^(?:salin|copy)\s+(?:teks\s+)?["“]([\s\S]*?)["”]$/i.exec(text);
  if (match) return { type: 'copy', value: match[1] };
  match = /^(?:tempel|paste)\s+(?:ke\s+)?(?:kolom|field)\s+["“](.+?)["”]$/i.exec(text);
  if (match) return { type: 'paste', label: match[1].trim() };
  match = /^(?:klik|click)\s+(?:tombol|button)\s+["“](.+?)["”]$/i.exec(text);
  if (match) {
    const label = match[1].trim();
    if (/\b(bayar|purchase|buy|hapus|delete|transfer|checkout|order|pay|refund|remove)\b/i.test(label)) {
      return { error: 'Tindakan finansial atau penghapusan diblokir pada preview.' };
    }
    return { type: 'click', label };
  }
  match = /^(?:isi|fill)\s+(?:kolom|field)\s+["“](.+?)["”]\s+dengan\s+["“]([\s\S]*?)["”]$/i.exec(text);
  if (match) return { type: 'fill', label: match[1].trim(), value: match[2] };
  return { error: 'Perintah belum didukung. Coba: cari … di Google; buka https://…; baca halaman; salin teks "…"; tempel ke kolom "…"; isi kolom "…" dengan "…"; klik tombol "Kirim".' };
}
