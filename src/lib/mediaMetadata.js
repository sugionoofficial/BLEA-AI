// Pure-JS lossless media metadata scanner and cleaner for images & videos.
// Runs identically in browser, Cloudflare Workers, and Node.js without native deps.

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
const latin1Decoder = new TextDecoder('latin1');
const utf8Encoder = new TextEncoder();

export const METADATA_SERVICE_COST = 100;
export const METADATA_MAX_FILE_BYTES = 250 * 1024 * 1024; // 250 MB
export const METADATA_WORKER_PROCESS_MAX_BYTES = 20 * 1024 * 1024; // 20 MB batas aman RAM Cloudflare Worker
export const METADATA_STORAGE_UPLOAD_MAX_BYTES = 45 * 1024 * 1024; // 45 MB batas aman Storage bucket 50 MB

const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Safe non-metadata PNG chunks to keep intact (image pixels, color, animation)
const PNG_KEEP_CHUNKS = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND',
  'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'hIST', 'pHYs', 'sPLT',
  'acTL', 'fcTL', 'fdAT', 'cICP', 'mDCv', 'cLLi',
]);

// PNG chunks known to carry metadata / AI parameters / C2PA
const PNG_META_CHUNKS = new Set([
  'tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME', 'caBX', 'c2pa', 'jumb', 'dSIG', 'eXIF',
]);

// MP4 / MOV boxes containing descriptive/AI/C2PA metadata
const MP4_META_BOXES = new Set(['udta', 'meta', 'XMP_', 'c2pa', 'jumb']);
const MP4_CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'moof', 'traf']);

// C2PA & XMP UUIDs used in ISOBMFF `uuid` boxes
const UUID_XMP = 'be7acfcb97a942e89c71999491e3afac';
const UUID_C2PA = 'd8fec3d61b0e483c92975828877ec481';

const EXIF_TAGS = new Map([
  [0x010d, 'DocumentName'],
  [0x010e, 'ImageDescription'],
  [0x010f, 'Make'],
  [0x0110, 'Model'],
  [0x0131, 'Software'],
  [0x0132, 'DateTime'],
  [0x013b, 'Artist'],
  [0x013c, 'HostComputer'],
  [0x8298, 'Copyright'],
  [0x8769, 'ExifIFDPointer'],
  [0x8825, 'GPSInfoIFDPointer'],
  [0x9003, 'DateTimeOriginal'],
  [0x9004, 'DateTimeDigitized'],
  [0x9286, 'UserComment'],
  [0x9c9b, 'XPTitle'],
  [0x9c9c, 'XPComment'],
  [0x9c9d, 'XPAuthor'],
  [0x9c9e, 'XPKeywords'],
  [0x9c9f, 'XPSubject'],
  [0xa420, 'ImageUniqueID'],
  [0xa430, 'CameraOwnerName'],
  [0xa431, 'BodySerialNumber'],
  [0xa434, 'LensModel'],
  [0xa435, 'LensSerialNumber'],
]);

const AI_SIGNATURES = [
  {
    tool: 'C2PA / Content Credentials',
    pattern: /(?:c2pa|contentcredentials|content credentials|jumb|cabx|jumbf|trainedalgorithmicmedia|compositewithtrainedalgorithmicmedia|digitalcapture.*c2pa|c2pa\.assertions|c2pa\.actions)/i,
    reason: 'Menyertakan manifestasi Content Credentials / C2PA (penanda asal konten AI).',
  },
  {
    tool: 'OpenAI (Sora / DALL-E)',
    pattern: /(?:openai|dall-?e|com\.openai\.sora|openai[\s_-]*sora|\bsora[\s_-]?[12]\b|gpt-image|truepic)/i,
    reason: 'Mengandung jejak generator atau penanda OpenAI (Sora / DALL-E).',
  },
  {
    tool: 'Google AI (Veo / Imagen / SynthID)',
    pattern: /(?:made with google ai|google deepmind|google[\s_-]*imagen|\bimagen[\s_-]?[234]\b|google[\s_-]*veo|\bveo[\s_-]?[123]\b|synthid|gemini\s*image)/i,
    reason: 'Mengandung penanda atau atribusi model AI Google (Veo / Imagen / SynthID).',
  },
  {
    tool: 'Alibaba Cloud / Wan / Qwen AIGC',
    pattern: /(?:alibaba|dashscope|wanx?\d|qwen-image|qwen-vl|tongyi|\"aigc\"|\baigc\b[^a-z0-9]{0,6}(?:label|contentproducer|produceid))/i,
    reason: 'Mengandung tanda AIGC atau penanda generator Alibaba / Wan / Qwen.',
  },
  {
    tool: 'Kling AI',
    pattern: /(?:kling\s*ai|kuaishou|kwai(?:\s*ai)?|kolors)/i,
    reason: 'Mengandung penanda model Kling AI / Kolors.',
  },
  {
    tool: 'ByteDance / Seedance / Dreamina',
    pattern: /(?:bytedance|seedance|seedream|jimeng|dreamina|doubao)/i,
    reason: 'Mengandung jejak generator ByteDance (Seedance / Seedream / Dreamina).',
  },
  {
    tool: 'MiniMax / Hailuo AI',
    pattern: /(?:minimax|hailuo)/i,
    reason: 'Mengandung penanda generator MiniMax / Hailuo AI.',
  },
  {
    tool: 'Midjourney',
    pattern: /(?:midjourney|\bmj\s+v\d|--stylize\s+\d|--chaos\s+\d|--iw\s+\d)/i,
    reason: 'Mengandung parameter atau metadata Midjourney.',
  },
  {
    tool: 'ComfyUI',
    pattern: /(?:comfyui|checkpointloadersimple|cliptextencode|ksampler|class_type["']?\s*:\s*["']|workflow["']?\s*:\s*\{)/i,
    reason: 'Mengandung graph node atau workflow JSON dari ComfyUI.',
  },
  {
    tool: 'Stable Diffusion (A1111 / Forge / InvokeAI)',
    pattern: /(?:stable\s*diffusion|automatic1111|sd-metadata|invokeai|novelai|dreamstudio|stability\s*ai|negative prompt:\s|cfg scale:\s*\d|steps:\s*\d+,\s*sampler:)/i,
    reason: 'Mengandung parameter generasi Stable Diffusion (Steps / Sampler / CFG / Seed).',
  },
  {
    tool: 'Black Forest Labs (FLUX)',
    pattern: /(?:black\s*forest\s*labs|\bflux(?:\.\d|[-_ ](?:pro|dev|schnell|kontext)))/i,
    reason: 'Mengandung penanda model FLUX / Black Forest Labs.',
  },
  {
    tool: 'Runway',
    pattern: /(?:runwayml|runway\s*gen-?[234]|made with runway)/i,
    reason: 'Mengandung penanda video AI Runway.',
  },
  {
    tool: 'Luma / Pika / Freebeat',
    pattern: /(?:luma\s*(?:ai|dream\s*machine)|pika\s*labs|freebeat)/i,
    reason: 'Mengandung penanda generator AI (Luma / Pika / Freebeat).',
  },
  {
    tool: 'Adobe Firefly',
    pattern: /(?:adobe\s*firefly|firefly\s*image|firefly\s*video)/i,
    reason: 'Mengandung metadata pembuatan dari Adobe Firefly.',
  },
  {
    tool: 'IPTC DigitalSourceType (Algorithmic Media)',
    pattern: /(?:digitalsourcetype|algorithmicmedia|trainedalgorithmicmedia|compositesynthetic)/i,
    reason: 'Mengandung kode standar IPTC yang menandai media hasil algoritma AI.',
  },
  {
    tool: 'Generic AI Generation Indicator',
    pattern: /(?:generated\s*(?:by|with|using)\s*ai|ai[-_\s]generated|synthetic\s*media|aigc[-_\s]?label|negative_prompt|cfg_scale|contentproducer|produceid|reservedcode1)/i,
    reason: 'Mengandung atribut atau label umum pembuatan konten AI (AIGC).',
  },
];

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('Input harus berupa Uint8Array atau ArrayBuffer.');
}

function readU16BE(b, o) {
  return ((b[o] << 8) | b[o + 1]) >>> 0;
}

function readU16LE(b, o) {
  return (b[o] | (b[o + 1] << 8)) >>> 0;
}

function readU32BE(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function readU32LE(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function writeU32BE(val) {
  const out = new Uint8Array(4);
  out[0] = (val >>> 24) & 0xff;
  out[1] = (val >>> 16) & 0xff;
  out[2] = (val >>> 8) & 0xff;
  out[3] = val & 0xff;
  return out;
}

function writeU32LE(val) {
  const out = new Uint8Array(4);
  out[0] = val & 0xff;
  out[1] = (val >>> 8) & 0xff;
  out[2] = (val >>> 16) & 0xff;
  out[3] = (val >>> 24) & 0xff;
  return out;
}

function ascii(b, start, end) {
  return latin1Decoder.decode(b.subarray(start, end));
}

function bytesEqual(a, b, offset = 0) {
  if (a.length - offset < b.length) return false;
  for (let i = 0; i < b.length; i += 1) {
    if (a[offset + i] !== b[i]) return false;
  }
  return true;
}

function concatBytes(parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function sanitizeText(raw, maxLen = 600) {
  const cleaned = String(raw || '')
    .replace(/\u0000+/g, ' ')
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1)}…`;
}

async function inflateZlibBytes(compressed) {
  if (!compressed || compressed.length === 0) return '';
  if (typeof DecompressionStream !== 'function') return '';
  for (const algo of ['deflate', 'deflate-raw']) {
    try {
      const ds = new DecompressionStream(algo);
      const stream = new Blob([compressed]).stream().pipeThrough(ds);
      const buf = await new Response(stream).arrayBuffer();
      return utf8Decoder.decode(new Uint8Array(buf));
    } catch {
      // try next algorithm
    }
  }
  return '';
}

export function detectMediaFormat(input, { fileName = '', mimeType = '' } = {}) {
  const b = toUint8Array(input);
  if (b.length >= 8 && bytesEqual(b, PNG_SIG, 0)) {
    return { format: 'png', mediaKind: 'image', mimeType: 'image/png', ext: 'png', label: 'PNG' };
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) {
    return { format: 'jpeg', mediaKind: 'image', mimeType: 'image/jpeg', ext: 'jpg', label: 'JPEG' };
  }
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') {
    return { format: 'webp', mediaKind: 'image', mimeType: 'image/webp', ext: 'webp', label: 'WebP' };
  }
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF89a' || ascii(b, 0, 6) === 'GIF87a')) {
    return { format: 'gif', mediaKind: 'image', mimeType: 'image/gif', ext: 'gif', label: 'GIF' };
  }
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12).trim().toLowerCase();
    const isMov = brand === 'qt' || /\.mov$/i.test(fileName) || mimeType === 'video/quicktime';
    return {
      format: 'mp4',
      mediaKind: 'video',
      mimeType: isMov ? 'video/quicktime' : 'video/mp4',
      ext: isMov ? 'mov' : 'mp4',
      label: isMov ? 'MOV (QuickTime)' : 'MP4',
    };
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    const isMkv = /\.mkv$/i.test(fileName) || mimeType === 'video/x-matroska';
    return {
      format: 'webm',
      mediaKind: 'video',
      mimeType: isMkv ? 'video/x-matroska' : 'video/webm',
      ext: isMkv ? 'mkv' : 'webm',
      label: isMkv ? 'MKV' : 'WebM',
    };
  }
  return { format: 'unsupported', mediaKind: mimeType.startsWith('video/') ? 'video' : 'image', mimeType: mimeType || 'application/octet-stream', ext: 'bin', label: 'Tidak dikenal' };
}

function matchAiSignals(text) {
  const hay = String(text || '');
  if (!hay) return [];
  const hits = [];
  for (const sig of AI_SIGNATURES) {
    if (sig.pattern.test(hay)) {
      hits.push({ tool: sig.tool, reason: sig.reason });
    }
  }
  return hits;
}

function addEntry(entries, { group, key, value, location, forceAiTool, forceAiReason }) {
  const cleanValue = sanitizeText(value);
  const cleanKey = sanitizeText(key, 120) || group;
  const combined = `${group} ${cleanKey} ${cleanValue} ${location || ''}`;
  const sigMatches = matchAiSignals(combined);
  if (forceAiTool && !sigMatches.some((s) => s.tool === forceAiTool)) {
    sigMatches.unshift({ tool: forceAiTool, reason: forceAiReason || 'Penanda metadata AI terdeteksi.' });
  }
  entries.push({
    group,
    key: cleanKey,
    value: cleanValue || '(data biner / manifest)',
    location: location || group,
    isAi: sigMatches.length > 0,
    aiTools: sigMatches.map((m) => m.tool),
    aiReasons: sigMatches.map((m) => m.reason),
  });
}

function parseExifTiff(tiffBytes, entries, locationPrefix = 'EXIF') {
  if (!tiffBytes || tiffBytes.length < 8) return;
  const endian = ascii(tiffBytes, 0, 2);
  if (endian !== 'II' && endian !== 'MM') return;
  const le = endian === 'II';
  const r16 = (o) => (o + 2 <= tiffBytes.length ? (le ? readU16LE(tiffBytes, o) : readU16BE(tiffBytes, o)) : 0);
  const r32 = (o) => (o + 4 <= tiffBytes.length ? (le ? readU32LE(tiffBytes, o) : readU32BE(tiffBytes, o)) : 0);
  if (r16(2) !== 42) return;
  const visited = new Set();

  const walkIfd = (ifdOffset, label) => {
    if (!ifdOffset || ifdOffset + 2 > tiffBytes.length || visited.has(ifdOffset)) return;
    visited.add(ifdOffset);
    const count = Math.min(r16(ifdOffset), 200);
    for (let i = 0; i < count; i += 1) {
      const entryOff = ifdOffset + 2 + i * 12;
      if (entryOff + 12 > tiffBytes.length) break;
      const tag = r16(entryOff);
      const type = r16(entryOff + 2);
      const num = r32(entryOff + 4);
      const typeSizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };
      const unitSize = typeSizes[type] || 1;
      const totalBytes = num * unitSize;
      if (totalBytes <= 0 || totalBytes > tiffBytes.length) continue;

      const valueOff = totalBytes <= 4 ? entryOff + 8 : r32(entryOff + 8);
      if (valueOff + totalBytes > tiffBytes.length) continue;

      if (tag === 0x8769 && type === 4) {
        walkIfd(r32(entryOff + 8), `${locationPrefix} · ExifIFD`);
        continue;
      }
      if (tag === 0x8825 && type === 4) {
        addEntry(entries, {
          group: 'EXIF',
          key: 'GPSInfo',
          value: 'Data lokasi GPS tertanam di file',
          location: `${locationPrefix} · GPSIFD`,
        });
        continue;
      }

      const tagName = EXIF_TAGS.get(tag) || `Tag 0x${tag.toString(16).padStart(4, '0')}`;
      if (type === 2 || tag === 0x9286) {
        let rawSlice = tiffBytes.subarray(valueOff, valueOff + totalBytes);
        if (tag === 0x9286 && rawSlice.length > 8) {
          const prefix = ascii(rawSlice, 0, 8);
          if (prefix.startsWith('ASCII') || prefix.startsWith('UNICODE')) {
            rawSlice = rawSlice.subarray(8);
          }
        }
        const text = sanitizeText(utf8Decoder.decode(rawSlice));
        if (text) {
          addEntry(entries, { group: 'EXIF', key: tagName, value: text, location: label });
        }
      } else if (EXIF_TAGS.has(tag)) {
        const val = type === 3 ? String(r16(valueOff)) : String(r32(valueOff));
        addEntry(entries, { group: 'EXIF', key: tagName, value: val, location: label });
      }
    }
  };

  walkIfd(r32(4), locationPrefix);
}

function parseXmpPacket(xmlText, entries, location = 'XMP') {
  const xml = String(xmlText || '');
  if (!xml.trim()) return;
  const tagRegex = /<([a-zA-Z0-9_:-]+)>([^<]{1,1200})<\/\1>/g;
  const seen = new Set();
  let match;
  while ((match = tagRegex.exec(xml)) !== null) {
    const k = match[1];
    const v = sanitizeText(match[2]);
    if (!v || k.startsWith('rdf:')) continue;
    const dedup = `${k}=${v}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    addEntry(entries, { group: 'XMP', key: k, value: v, location });
  }
  const attrRegex = /\b([a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+)="([^"]{1,600})"/g;
  while ((match = attrRegex.exec(xml)) !== null) {
    const k = match[1];
    const v = sanitizeText(match[2]);
    if (!v || k.startsWith('xmlns:') || k === 'rdf:about' || k === 'rdf:parseType') continue;
    const dedup = `${k}=${v}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    addEntry(entries, { group: 'XMP', key: k, value: v, location });
  }
  if (seen.size === 0) {
    addEntry(entries, { group: 'XMP', key: 'XMP Packet', value: sanitizeText(xml), location });
  }
}

function parseIptcBytes(bytes, entries, location = 'JPEG APP13 / IPTC') {
  const text = extractPrintableStrings(bytes, 4).join(' | ');
  addEntry(entries, {
    group: 'IPTC',
    key: 'Photoshop / IPTC Metadata',
    value: text || `${bytes.length} byte data IPTC`,
    location,
  });
}

function extractPrintableStrings(bytes, minLen = 5, maxStrings = 24) {
  const out = [];
  let cur = [];
  for (let i = 0; i < bytes.length; i += 1) {
    const c = bytes[i];
    if ((c >= 32 && c <= 126) || c === 9 || c === 10 || c === 13) {
      cur.push(c);
    } else {
      if (cur.length >= minLen) {
        const str = sanitizeText(String.fromCharCode(...cur), 400);
        if (str) out.push(str);
        if (out.length >= maxStrings) break;
      }
      cur = [];
    }
  }
  if (cur.length >= minLen && out.length < maxStrings) {
    const str = sanitizeText(String.fromCharCode(...cur), 400);
    if (str) out.push(str);
  }
  return out;
}

// ---- PNG ----
async function scanPng(bytes, entries) {
  let off = 8;
  while (off + 12 <= bytes.length) {
    const len = readU32BE(bytes, off);
    const type = ascii(bytes, off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > bytes.length) break;
    const data = bytes.subarray(dataStart, dataEnd);

    if (type === 'tEXt') {
      const nul = data.indexOf(0);
      const key = nul >= 0 ? latin1Decoder.decode(data.subarray(0, nul)) : 'tEXt';
      const val = nul >= 0 ? utf8Decoder.decode(data.subarray(nul + 1)) : utf8Decoder.decode(data);
      addEntry(entries, { group: 'PNG tEXt', key, value: val, location: `Chunk ${type}` });
    } else if (type === 'iTXt') {
      const nul1 = data.indexOf(0);
      const key = nul1 >= 0 ? latin1Decoder.decode(data.subarray(0, nul1)) : 'iTXt';
      let pos = nul1 >= 0 ? nul1 + 1 : 0;
      const compFlag = data[pos] || 0;
      pos += 2; // compression flag + method
      const nul2 = data.indexOf(0, pos);
      pos = nul2 >= 0 ? nul2 + 1 : data.length;
      const nul3 = data.indexOf(0, pos);
      pos = nul3 >= 0 ? nul3 + 1 : data.length;
      const payload = data.subarray(pos);
      const val = compFlag === 1 ? (await inflateZlibBytes(payload)) || utf8Decoder.decode(payload) : utf8Decoder.decode(payload);
      if (key.toLowerCase().includes('xmp') || val.includes('<x:xmpmeta') || val.includes('<rdf:RDF')) {
        parseXmpPacket(val, entries, 'PNG iTXt (XMP)');
      } else {
        addEntry(entries, { group: 'PNG iTXt', key, value: val, location: `Chunk ${type}` });
      }
    } else if (type === 'zTXt') {
      const nul = data.indexOf(0);
      const key = nul >= 0 ? latin1Decoder.decode(data.subarray(0, nul)) : 'zTXt';
      const compressed = nul >= 0 && nul + 2 <= data.length ? data.subarray(nul + 2) : new Uint8Array(0);
      const val = (await inflateZlibBytes(compressed)) || `[Data terkompresi ${compressed.length} byte]`;
      addEntry(entries, { group: 'PNG zTXt', key, value: val, location: `Chunk ${type}` });
    } else if (type === 'eXIf' || type === 'eXIF') {
      const exifOffset = data.length >= 6 && ascii(data, 0, 6) === 'Exif\x00\x00' ? 6 : 0;
      parseExifTiff(data.subarray(exifOffset), entries, 'PNG eXIf');
    } else if (type === 'caBX' || type === 'c2pa' || type === 'jumb') {
      const strings = extractPrintableStrings(data, 4).join(' · ');
      addEntry(entries, {
        group: 'C2PA / Content Credentials',
        key: `PNG ${type}`,
        value: strings || `${data.length} byte manifest C2PA`,
        location: `Chunk ${type}`,
        forceAiTool: 'C2PA / Content Credentials',
        forceAiReason: `Chunk biner ${type} membawa manifest Content Credentials / C2PA.`,
      });
    } else if (type === 'tIME' && data.length >= 7) {
      const y = readU16BE(data, 0);
      const m = data[2];
      const d = data[3];
      const h = String(data[4]).padStart(2, '0');
      const min = String(data[5]).padStart(2, '0');
      const s = String(data[6]).padStart(2, '0');
      addEntry(entries, { group: 'PNG Timestamp', key: 'tIME', value: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} ${h}:${min}:${s} UTC`, location: 'Chunk tIME' });
    } else if (!PNG_KEEP_CHUNKS.has(type) && (PNG_META_CHUNKS.has(type) || (type[0] >= 'a' && type[0] <= 'z'))) {
      const strings = extractPrintableStrings(data, 4).join(' · ');
      addEntry(entries, { group: 'PNG Metadata', key: type, value: strings || `${data.length} byte`, location: `Chunk ${type}` });
    }

    off = dataEnd + 4;
    if (type === 'IEND') break;
  }
}

function stripPng(bytes) {
  const parts = [bytes.subarray(0, 8)];
  let off = 8;
  let removed = 0;
  while (off + 12 <= bytes.length) {
    const len = readU32BE(bytes, off);
    const type = ascii(bytes, off + 4, off + 8);
    const nextOff = off + 12 + len;
    if (nextOff > bytes.length) break;
    if (PNG_KEEP_CHUNKS.has(type)) {
      parts.push(bytes.subarray(off, nextOff));
    } else {
      removed += 1;
    }
    off = nextOff;
    if (type === 'IEND') break;
  }
  if (parts.length === 1 || ascii(parts[parts.length - 1], 4, 8) !== 'IEND') {
    const iend = new Uint8Array([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    parts.push(iend);
  }
  return { cleanedBytes: concatBytes(parts), removedChunks: removed };
}

// ---- JPEG ----
function scanJpeg(bytes, entries) {
  let off = 2;
  while (off + 2 <= bytes.length) {
    if (bytes[off] !== 0xff) {
      off += 1;
      continue;
    }
    while (off < bytes.length && bytes[off] === 0xff) off += 1;
    if (off >= bytes.length) break;
    const marker = bytes[off];
    off += 1;
    if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS (image entropy begins)
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (off + 2 > bytes.length) break;
    const segLen = readU16BE(bytes, off);
    if (segLen < 2 || off + segLen > bytes.length) break;
    const data = bytes.subarray(off + 2, off + segLen);

    if (marker === 0xe1) {
      if (data.length >= 6 && ascii(data, 0, 6) === 'Exif\x00\x00') {
        parseExifTiff(data.subarray(6), entries, 'JPEG APP1 · EXIF');
      } else if (data.length >= 29 && ascii(data, 0, 29) === 'http://ns.adobe.com/xap/1.0/\x00') {
        parseXmpPacket(utf8Decoder.decode(data.subarray(29)), entries, 'JPEG APP1 · XMP');
      } else if (data.length >= 35 && ascii(data, 0, 35) === 'http://ns.adobe.com/xmp/extension/\x00') {
        parseXmpPacket(utf8Decoder.decode(data.subarray(75)), entries, 'JPEG APP1 · Extended XMP');
      } else {
        const strings = extractPrintableStrings(data, 4).join(' · ');
        addEntry(entries, { group: 'JPEG APP1', key: 'APP1 Metadata', value: strings || `${data.length} byte`, location: 'JPEG APP1' });
      }
    } else if (marker === 0xeb) {
      const strings = extractPrintableStrings(data, 4).join(' · ');
      const isC2pa = /c2pa|jumb|contentcredentials/i.test(strings);
      addEntry(entries, {
        group: isC2pa ? 'C2PA / Content Credentials' : 'JPEG APP11 (JUMBF)',
        key: 'APP11 / JUMBF',
        value: strings || `${data.length} byte segmen APP11`,
        location: 'JPEG APP11',
        ...(isC2pa ? { forceAiTool: 'C2PA / Content Credentials', forceAiReason: 'Segmen JPEG APP11 JUMBF memuat manifest C2PA.' } : {}),
      });
    } else if (marker === 0xed) {
      parseIptcBytes(data, entries);
    } else if (marker === 0xec || (marker >= 0xe3 && marker <= 0xea)) {
      const strings = extractPrintableStrings(data, 4).join(' · ');
      if (strings) addEntry(entries, { group: `JPEG APP${marker - 0xe0}`, key: `APP${marker - 0xe0}`, value: strings, location: `JPEG 0xFF${marker.toString(16).toUpperCase()}` });
    } else if (marker === 0xfe) {
      addEntry(entries, { group: 'JPEG Comment', key: 'COM', value: utf8Decoder.decode(data), location: 'JPEG COM (0xFFFE)' });
    }

    off += segLen;
  }
}

function stripJpeg(bytes) {
  const parts = [bytes.subarray(0, 2)]; // SOI
  let off = 2;
  let removed = 0;
  while (off + 1 < bytes.length) {
    if (bytes[off] !== 0xff) {
      parts.push(bytes.subarray(off));
      break;
    }
    const markerStart = off;
    while (off < bytes.length && bytes[off] === 0xff) off += 1;
    if (off >= bytes.length) {
      parts.push(bytes.subarray(markerStart));
      break;
    }
    const marker = bytes[off];
    off += 1;
    if (marker === 0xd9 || marker === 0xda) {
      parts.push(bytes.subarray(markerStart));
      break;
    }
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd8)) {
      parts.push(bytes.subarray(markerStart, off));
      continue;
    }
    if (off + 2 > bytes.length) {
      parts.push(bytes.subarray(markerStart));
      break;
    }
    const segLen = readU16BE(bytes, off);
    if (segLen < 2 || off + segLen > bytes.length) {
      parts.push(bytes.subarray(markerStart));
      break;
    }
    const segEnd = off + segLen;
    const data = bytes.subarray(off + 2, segEnd);

    // Strip EXIF/XMP (APP1), APP3..APP13 (including C2PA APP11 & IPTC APP13), and COM (0xFE).
    // Keep APP2 ICC_PROFILE so colors stay identical, and APP0 (JFIF) + APP14 (Adobe CMYK).
    const isIccApp2 = marker === 0xe2 && data.length >= 12 && ascii(data, 0, 12) === 'ICC_PROFILE\x00';
    const shouldDrop =
      marker === 0xe1 ||
      (marker === 0xe2 && !isIccApp2) ||
      (marker >= 0xe3 && marker <= 0xed) ||
      marker === 0xef ||
      marker === 0xfe;

    if (shouldDrop) {
      removed += 1;
    } else {
      parts.push(bytes.subarray(markerStart, segEnd));
    }
    off = segEnd;
  }
  return { cleanedBytes: concatBytes(parts), removedChunks: removed };
}

// ---- WebP (RIFF) ----
function scanWebp(bytes, entries) {
  let off = 12;
  while (off + 8 <= bytes.length) {
    const fourcc = ascii(bytes, off, off + 4);
    const size = readU32LE(bytes, off + 4);
    const dataStart = off + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) break;
    const data = bytes.subarray(dataStart, dataEnd);

    if (fourcc === 'EXIF') {
      const tiffStart = ascii(data, 0, 6) === 'Exif\x00\x00' ? 6 : 0;
      parseExifTiff(data.subarray(tiffStart), entries, 'WebP EXIF');
    } else if (fourcc === 'XMP ') {
      parseXmpPacket(utf8Decoder.decode(data), entries, 'WebP XMP');
    } else if (fourcc === 'C2PA' || fourcc === 'JUMB') {
      const strings = extractPrintableStrings(data, 4).join(' · ');
      addEntry(entries, {
        group: 'C2PA / Content Credentials',
        key: `WebP ${fourcc}`,
        value: strings || `${data.length} byte C2PA`,
        location: `Chunk ${fourcc}`,
        forceAiTool: 'C2PA / Content Credentials',
        forceAiReason: `Chunk WebP ${fourcc} berisi Content Credentials / C2PA.`,
      });
    }
    off = dataEnd + (size % 2);
  }
}

function stripWebp(bytes) {
  const parts = [];
  let off = 12;
  let removed = 0;
  while (off + 8 <= bytes.length) {
    const fourcc = ascii(bytes, off, off + 4);
    const size = readU32LE(bytes, off + 4);
    const totalEnd = Math.min(bytes.length, off + 8 + size + (size % 2));
    if (fourcc === 'EXIF' || fourcc === 'XMP ' || fourcc === 'C2PA' || fourcc === 'JUMB') {
      removed += 1;
    } else if (fourcc === 'VP8X' && size >= 10 && off + 18 <= bytes.length) {
      const vp8x = bytes.slice(off, totalEnd);
      // Clear XMP (bit 2 = 0x04) & EXIF (bit 3 = 0x08) flags in VP8X header byte 8
      vp8x[8] = vp8x[8] & ~0x0c;
      parts.push(vp8x);
    } else {
      parts.push(bytes.subarray(off, totalEnd));
    }
    off = totalEnd;
  }
  const body = concatBytes(parts);
  const header = concatBytes([
    utf8Encoder.encode('RIFF'),
    writeU32LE(4 + body.length),
    utf8Encoder.encode('WEBP'),
  ]);
  return { cleanedBytes: concatBytes([header, body]), removedChunks: removed };
}

// ---- GIF ----
function skipGifSubBlocks(bytes, off) {
  while (off < bytes.length) {
    const subLen = bytes[off];
    off += 1;
    if (subLen === 0) break;
    off = Math.min(bytes.length, off + subLen);
  }
  return off;
}

function readGifSubBlocks(bytes, off) {
  const chunks = [];
  let cursor = off;
  while (cursor < bytes.length) {
    const subLen = bytes[cursor];
    cursor += 1;
    if (subLen === 0) break;
    const end = Math.min(bytes.length, cursor + subLen);
    chunks.push(bytes.subarray(cursor, end));
    cursor = end;
  }
  return { data: concatBytes(chunks), nextOff: cursor };
}

function parseGifHeaderEnd(bytes) {
  if (bytes.length < 13) return bytes.length;
  const packed = bytes[10];
  const hasGct = (packed & 0x80) !== 0;
  const gctSize = hasGct ? 3 * (1 << ((packed & 0x07) + 1)) : 0;
  return Math.min(bytes.length, 13 + gctSize);
}

function scanGif(bytes, entries) {
  let off = parseGifHeaderEnd(bytes);
  while (off < bytes.length) {
    const introducer = bytes[off];
    if (introducer === 0x3b) break;
    if (introducer === 0x21 && off + 2 <= bytes.length) {
      const label = bytes[off + 1];
      if (label === 0xfe) {
        const { data, nextOff } = readGifSubBlocks(bytes, off + 2);
        addEntry(entries, { group: 'GIF Comment', key: 'Comment Extension', value: utf8Decoder.decode(data), location: 'GIF 0x21FE' });
        off = nextOff;
        continue;
      }
      if (label === 0xff && off + 14 <= bytes.length) {
        const blockSize = bytes[off + 2];
        const appId = ascii(bytes, off + 3, off + 3 + Math.min(blockSize, 11));
        const { data, nextOff } = readGifSubBlocks(bytes, off + 3 + blockSize);
        if (appId.startsWith('XMP Data')) {
          parseXmpPacket(utf8Decoder.decode(data), entries, 'GIF Application XMP');
        } else if (!appId.startsWith('NETSCAPE') && !appId.startsWith('ANIMEXTS')) {
          addEntry(entries, { group: 'GIF Extension', key: appId, value: extractPrintableStrings(data, 4).join(' · ') || `${data.length} byte`, location: 'GIF 0x21FF' });
        }
        off = nextOff;
        continue;
      }
      off = skipGifSubBlocks(bytes, off + 3);
      continue;
    }
    if (introducer === 0x2c && off + 10 <= bytes.length) {
      const packed = bytes[off + 9];
      const hasLct = (packed & 0x80) !== 0;
      const lctSize = hasLct ? 3 * (1 << ((packed & 0x07) + 1)) : 0;
      off = skipGifSubBlocks(bytes, Math.min(bytes.length, off + 10 + lctSize + 1));
      continue;
    }
    break;
  }
}

function stripGif(bytes) {
  const headerEnd = parseGifHeaderEnd(bytes);
  const parts = [bytes.subarray(0, headerEnd)];
  let off = headerEnd;
  let removed = 0;
  while (off < bytes.length) {
    const start = off;
    const introducer = bytes[off];
    if (introducer === 0x3b) {
      parts.push(bytes.subarray(start, start + 1));
      break;
    }
    if (introducer === 0x21 && off + 2 <= bytes.length) {
      const label = bytes[off + 1];
      if (label === 0xfe) {
        off = skipGifSubBlocks(bytes, off + 2);
        removed += 1;
        continue;
      }
      if (label === 0xff && off + 3 <= bytes.length) {
        const blockSize = bytes[off + 2];
        const appId = ascii(bytes, off + 3, Math.min(bytes.length, off + 3 + blockSize));
        off = skipGifSubBlocks(bytes, off + 3 + blockSize);
        if (appId.startsWith('NETSCAPE') || appId.startsWith('ANIMEXTS')) {
          parts.push(bytes.subarray(start, off));
        } else {
          removed += 1;
        }
        continue;
      }
      off = skipGifSubBlocks(bytes, off + 3);
      parts.push(bytes.subarray(start, off));
      continue;
    }
    if (introducer === 0x2c && off + 10 <= bytes.length) {
      const packed = bytes[off + 9];
      const hasLct = (packed & 0x80) !== 0;
      const lctSize = hasLct ? 3 * (1 << ((packed & 0x07) + 1)) : 0;
      off = skipGifSubBlocks(bytes, Math.min(bytes.length, off + 10 + lctSize + 1));
      parts.push(bytes.subarray(start, off));
      continue;
    }
    parts.push(bytes.subarray(start));
    break;
  }
  return { cleanedBytes: concatBytes(parts), removedChunks: removed };
}

// ---- MP4 / MOV (ISOBMFF) ----
function parseMp4Boxes(bytes, start, end) {
  const boxes = [];
  let off = start;
  while (off + 8 <= end) {
    const rawSize = readU32BE(bytes, off);
    const type = ascii(bytes, off + 4, off + 8);
    let headerSize = 8;
    let size = rawSize;
    if (rawSize === 1) {
      if (off + 16 > end) break;
      const hi = readU32BE(bytes, off + 8);
      const lo = readU32BE(bytes, off + 12);
      size = hi * 4294967296 + lo;
      headerSize = 16;
    } else if (rawSize === 0) {
      size = end - off;
    }
    if (size < headerSize || off + size > end) break;
    boxes.push({
      type,
      start: off,
      end: off + size,
      headerSize,
      payloadStart: off + headerSize,
      payloadEnd: off + size,
    });
    off += size;
  }
  return boxes;
}

function scanMp4Ilst(bytes, box, entries, location) {
  const atoms = parseMp4Boxes(bytes, box.payloadStart, box.payloadEnd);
  for (const atom of atoms) {
    const children = parseMp4Boxes(bytes, atom.payloadStart, atom.payloadEnd);
    let label = atom.type;
    const meanBox = children.find((c) => c.type === 'mean');
    const nameBox = children.find((c) => c.type === 'name');
    if (meanBox && nameBox) {
      const mean = utf8Decoder.decode(bytes.subarray(meanBox.payloadStart + 4, meanBox.payloadEnd));
      const name = utf8Decoder.decode(bytes.subarray(nameBox.payloadStart + 4, nameBox.payloadEnd));
      label = `${mean}:${name}`;
    }
    const dataBox = children.find((c) => c.type === 'data');
    if (dataBox && dataBox.payloadEnd - dataBox.payloadStart > 8) {
      const val = utf8Decoder.decode(bytes.subarray(dataBox.payloadStart + 8, dataBox.payloadEnd));
      addEntry(entries, { group: 'MP4/MOV Metadata', key: label, value: val, location });
    } else {
      const strings = extractPrintableStrings(bytes.subarray(atom.payloadStart, atom.payloadEnd), 4).join(' · ');
      if (strings) addEntry(entries, { group: 'MP4/MOV Metadata', key: label, value: strings, location });
    }
  }
}

const STANDARD_MP4_HANDLERS = new Set([
  'videohandler',
  'soundhandler',
  'core media video',
  'core media audio',
  'subtitlehandler',
  'hintmediahandler',
]);

function isCustomMp4HandlerName(name) {
  const clean = sanitizeText(name, 120).toLowerCase();
  if (!clean) return false;
  if (STANDARD_MP4_HANDLERS.has(clean)) return false;
  if (/^iso\s*media\s*(?:file|video|audio)/i.test(clean)) return false;
  return true;
}

function scanMp4Container(bytes, start, end, entries, trail = '') {
  const boxes = parseMp4Boxes(bytes, start, end);
  for (const box of boxes) {
    const path = trail ? `${trail}/${box.type}` : box.type;
    if (box.type === 'hdlr' && box.payloadEnd - box.payloadStart > 24 && trail.includes('mdia')) {
      const handlerName = utf8Decoder.decode(bytes.subarray(box.payloadStart + 24, box.payloadEnd)).replace(/\0+$/g, '');
      if (isCustomMp4HandlerName(handlerName)) {
        addEntry(entries, {
          group: 'MP4 Handler Tag',
          key: 'hdlr.name',
          value: handlerName,
          location: path,
        });
      }
      continue;
    }
    if (box.type === 'uuid' && box.payloadEnd - box.payloadStart >= 16) {
      const uuidHex = toHex(bytes.subarray(box.payloadStart, box.payloadStart + 16));
      const rest = bytes.subarray(box.payloadStart + 16, box.payloadEnd);
      if (uuidHex === UUID_XMP) {
        parseXmpPacket(utf8Decoder.decode(rest), entries, `${path} (XMP)`);
      } else if (uuidHex === UUID_C2PA) {
        addEntry(entries, {
          group: 'C2PA / Content Credentials',
          key: 'MP4 C2PA JUMBF UUID',
          value: extractPrintableStrings(rest, 4).join(' · ') || `${rest.length} byte C2PA JUMBF`,
          location: path,
          forceAiTool: 'C2PA / Content Credentials',
          forceAiReason: 'Box UUID JUMBF MP4 membawa manifest Content Credentials / C2PA.',
        });
      } else {
        const strings = extractPrintableStrings(rest, 4).join(' · ');
        if (strings) addEntry(entries, { group: 'MP4 UUID', key: uuidHex, value: strings, location: path });
      }
      continue;
    }

    if (MP4_META_BOXES.has(box.type)) {
      if (box.type === 'c2pa' || box.type === 'jumb') {
        const strings = extractPrintableStrings(bytes.subarray(box.payloadStart, box.payloadEnd), 4).join(' · ');
        addEntry(entries, {
          group: 'C2PA / Content Credentials',
          key: box.type,
          value: strings || `${box.payloadEnd - box.payloadStart} byte C2PA`,
          location: path,
          forceAiTool: 'C2PA / Content Credentials',
          forceAiReason: `Atom MP4 ${box.type} berisi Content Credentials / C2PA.`,
        });
        continue;
      }
      if (box.type === 'XMP_') {
        parseXmpPacket(utf8Decoder.decode(bytes.subarray(box.payloadStart, box.payloadEnd)), entries, path);
        continue;
      }
      // `meta` has 4-byte version/flags header before child boxes; `udta` contains child atoms
      const childStart = box.type === 'meta' ? box.payloadStart + 4 : box.payloadStart;
      const inner = parseMp4Boxes(bytes, childStart, box.payloadEnd);
      if (inner.length > 0) {
        let recorded = false;
        for (const sub of inner) {
          if (sub.type === 'ilst') {
            scanMp4Ilst(bytes, sub, entries, `${path}/ilst`);
            recorded = true;
          } else if (sub.type === 'meta') {
            scanMp4Container(bytes, sub.start, sub.end, entries, path);
            recorded = true;
          } else if (sub.type === 'XMP_') {
            parseXmpPacket(utf8Decoder.decode(bytes.subarray(sub.payloadStart, sub.payloadEnd)), entries, `${path}/XMP_`);
            recorded = true;
          } else if (sub.type !== 'hdlr') {
            const strings = extractPrintableStrings(bytes.subarray(sub.payloadStart, sub.payloadEnd), 4).join(' · ');
            if (strings) {
              addEntry(entries, { group: 'MP4/MOV Metadata', key: sub.type, value: strings, location: `${path}/${sub.type}` });
              recorded = true;
            }
          }
        }
        if (!recorded) {
          const strings = extractPrintableStrings(bytes.subarray(box.payloadStart, box.payloadEnd), 4).join(' · ');
          if (strings) addEntry(entries, { group: 'MP4/MOV Metadata', key: box.type, value: strings, location: path });
        }
      } else {
        const strings = extractPrintableStrings(bytes.subarray(box.payloadStart, box.payloadEnd), 4).join(' · ');
        if (strings) addEntry(entries, { group: 'MP4/MOV Metadata', key: box.type, value: strings, location: path });
      }
      continue;
    }

    if (MP4_CONTAINER_BOXES.has(box.type)) {
      scanMp4Container(bytes, box.payloadStart, box.payloadEnd, entries, path);
    }
  }
}

function shouldDropMp4Box(bytes, box) {
  if (MP4_META_BOXES.has(box.type)) return true;
  if (box.type === 'uuid' && box.payloadEnd - box.payloadStart >= 16) {
    const uuidHex = toHex(bytes.subarray(box.payloadStart, box.payloadStart + 16));
    if (uuidHex === UUID_XMP || uuidHex === UUID_C2PA) return true;
    const strings = extractPrintableStrings(bytes.subarray(box.payloadStart + 16, box.payloadEnd), 4).join(' ');
    if (/c2pa|xmp|aigc|comfy|sora|wan|adobe|contentcredentials/i.test(strings)) return true;
  }
  return false;
}

function rebuildMp4BoxTree(bytes, start, end, removedCounter, trail = '', { skipConcat = false } = {}) {
  const boxes = parseMp4Boxes(bytes, start, end);
  const kept = [];
  for (const box of boxes) {
    if (shouldDropMp4Box(bytes, box)) {
      removedCounter.count += 1;
      continue;
    }
    if (box.type === 'hdlr' && box.payloadEnd - box.payloadStart > 24 && trail.includes('mdia')) {
      const handlerType = ascii(bytes, box.payloadStart + 8, box.payloadStart + 12);
      const handlerName = utf8Decoder.decode(bytes.subarray(box.payloadStart + 24, box.payloadEnd)).replace(/\0+$/g, '');
      if (isCustomMp4HandlerName(handlerName)) {
        removedCounter.count += 1;
        const replacementName = handlerType === 'soun' ? 'SoundHandler\0' : 'VideoHandler\0';
        const prefix = bytes.slice(box.payloadStart, box.payloadStart + 24);
        const nameBytes = utf8Encoder.encode(replacementName);
        const totalSize = 8 + prefix.length + nameBytes.length;
        const boxBytes = concatBytes([writeU32BE(totalSize), utf8Encoder.encode('hdlr'), prefix, nameBytes]);
        kept.push({
          type: box.type,
          oldStart: box.start,
          oldEnd: box.end,
          bytes: boxBytes,
        });
        continue;
      }
    }
    if (MP4_CONTAINER_BOXES.has(box.type)) {
      const nextTrail = trail ? `${trail}/${box.type}` : box.type;
      const inner = rebuildMp4BoxTree(bytes, box.payloadStart, box.payloadEnd, removedCounter, nextTrail);
      const totalSize = 8 + inner.bytes.length;
      const boxBytes = concatBytes([writeU32BE(totalSize), utf8Encoder.encode(box.type), inner.bytes]);
      kept.push({
        type: box.type,
        oldStart: box.start,
        oldEnd: box.end,
        bytes: boxBytes,
      });
    } else {
      kept.push({
        type: box.type,
        oldStart: box.start,
        oldEnd: box.end,
        bytes: bytes.subarray(box.start, box.end),
      });
    }
  }
  return { kept, bytes: skipConcat ? null : concatBytes(kept.map((k) => k.bytes)) };
}

function shiftMp4ChunkOffsets(buf, start, end, topLevelOffsets) {
  const boxes = parseMp4Boxes(buf, start, end);
  for (const box of boxes) {
    if (box.type === 'stco' && box.payloadEnd - box.payloadStart >= 8) {
      const count = readU32BE(buf, box.payloadStart + 4);
      for (let i = 0; i < count; i += 1) {
        const pos = box.payloadStart + 8 + i * 4;
        if (pos + 4 > box.payloadEnd) break;
        const oldVal = readU32BE(buf, pos);
        const shift = lookupTopLevelShift(oldVal, topLevelOffsets);
        if (shift !== 0) {
          const nextVal = Math.max(0, oldVal + shift);
          buf.set(writeU32BE(nextVal >>> 0), pos);
        }
      }
    } else if (box.type === 'co64' && box.payloadEnd - box.payloadStart >= 8) {
      const count = readU32BE(buf, box.payloadStart + 4);
      for (let i = 0; i < count; i += 1) {
        const pos = box.payloadStart + 8 + i * 8;
        if (pos + 8 > box.payloadEnd) break;
        const hi = readU32BE(buf, pos);
        const lo = readU32BE(buf, pos + 4);
        const oldVal = hi * 4294967296 + lo;
        const shift = lookupTopLevelShift(oldVal, topLevelOffsets);
        if (shift !== 0) {
          const nextVal = Math.max(0, oldVal + shift);
          const nextHi = Math.floor(nextVal / 4294967296) >>> 0;
          const nextLo = (nextVal >>> 0);
          buf.set(writeU32BE(nextHi), pos);
          buf.set(writeU32BE(nextLo), pos + 4);
        }
      }
    } else if (MP4_CONTAINER_BOXES.has(box.type)) {
      shiftMp4ChunkOffsets(buf, box.payloadStart, box.payloadEnd, topLevelOffsets);
    }
  }
}

function lookupTopLevelShift(offset, topLevelOffsets) {
  for (const span of topLevelOffsets) {
    if (offset >= span.oldStart && offset < span.oldEnd) {
      return span.delta;
    }
  }
  return 0;
}

function stripMp4(bytes, { asParts = false } = {}) {
  const removedCounter = { count: 0 };
  const rebuilt = rebuildMp4BoxTree(bytes, 0, bytes.length, removedCounter, '', { skipConcat: true });
  let cursor = 0;
  const topLevelOffsets = [];
  for (const box of rebuilt.kept) {
    topLevelOffsets.push({
      type: box.type,
      oldStart: box.oldStart,
      oldEnd: box.oldEnd,
      newStart: cursor,
      delta: cursor - box.oldStart,
    });
    cursor += box.bytes.length;
  }
  for (const box of rebuilt.kept) {
    if (MP4_CONTAINER_BOXES.has(box.type)) {
      shiftMp4ChunkOffsets(box.bytes, 0, box.bytes.length, topLevelOffsets);
    }
  }
  const cleanedChunks = rebuilt.kept.map((k) => k.bytes);
  if (asParts) {
    const afterEntries = [];
    for (const box of rebuilt.kept) {
      if (box.type !== 'mdat') {
        scanMp4Container(box.bytes, 0, box.bytes.length, afterEntries);
      }
    }
    return {
      cleanedBytes: null,
      cleanedChunks,
      cleanedSize: cursor,
      removedChunks: removedCounter.count,
      afterEntries,
    };
  }
  return { cleanedBytes: concatBytes(cleanedChunks), cleanedSize: cursor, removedChunks: removedCounter.count };
}

// ---- WebM / MKV (EBML) ----
function readEbmlId(bytes, off, end) {
  if (off >= end) return null;
  const first = bytes[off];
  if (first === 0) return null;
  let len = 1;
  let mask = 0x80;
  while (len <= 4 && (first & mask) === 0) {
    len += 1;
    mask >>= 1;
  }
  if (len > 4 || off + len > end) return null;
  let id = 0;
  for (let i = 0; i < len; i += 1) {
    id = id * 256 + bytes[off + i];
  }
  return { id, len };
}

function readEbmlVint(bytes, off, end) {
  if (off >= end) return null;
  const first = bytes[off];
  if (first === 0) return null;
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && (first & mask) === 0) {
    len += 1;
    mask >>= 1;
  }
  if (len > 8 || off + len > end) return null;
  let val = first & (mask - 1);
  let allOnes = val === (mask - 1);
  for (let i = 1; i < len; i += 1) {
    const b = bytes[off + i];
    if (b !== 0xff) allOnes = false;
    val = val * 256 + b;
  }
  return { val: allOnes ? -1 : val, len };
}

function collectEbmlMetadata(bytes, start, end, entries, scrubTargets) {
  let off = start;
  while (off < end) {
    const idInfo = readEbmlId(bytes, off, end);
    if (!idInfo) break;
    const sizeInfo = readEbmlVint(bytes, off + idInfo.len, end);
    if (!sizeInfo) break;
    const dataStart = off + idInfo.len + sizeInfo.len;
    const elemEnd = sizeInfo.val < 0 ? end : Math.min(end, dataStart + sizeInfo.val);
    const id = idInfo.id;

    // 0x18538067 = Segment, 0x1549A966 = Info, 0x1254C367 = Tags, 0x7373 = Tag, 0x67C8 = SimpleTag
    if (id === 0x18538067 || id === 0x1549a966 || id === 0x7373 || id === 0x67c8) {
      if (id === 0x18538067) {
        // Walk children inside Segment, skipping huge Cluster (0x1F43B675) binary payloads
        let segOff = dataStart;
        while (segOff < elemEnd) {
          const cId = readEbmlId(bytes, segOff, elemEnd);
          if (!cId) break;
          const cSz = readEbmlVint(bytes, segOff + cId.len, elemEnd);
          if (!cSz) break;
          const cDataStart = segOff + cId.len + cSz.len;
          const cEnd = cSz.val < 0 ? elemEnd : Math.min(elemEnd, cDataStart + cSz.val);
          if (cId.id === 0x1549a966) {
            collectEbmlMetadata(bytes, cDataStart, cEnd, entries, scrubTargets);
          } else if (cId.id === 0x1254c367) {
            scrubTargets.push({ start: segOff, end: cEnd, kind: 'Tags' });
            collectEbmlMetadata(bytes, cDataStart, cEnd, entries, scrubTargets);
          }
          if (cEnd <= segOff) break;
          segOff = cEnd;
        }
        break;
      }
      collectEbmlMetadata(bytes, dataStart, elemEnd, entries, scrubTargets);
    } else if (id === 0x4d80 || id === 0x5741) {
      const label = id === 0x4d80 ? 'MuxingApp' : 'WritingApp';
      const val = utf8Decoder.decode(bytes.subarray(dataStart, elemEnd));
      if (sanitizeText(val)) {
        addEntry(entries, { group: 'WebM Info', key: label, value: val, location: `WebM ${label}` });
        scrubTargets.push({ start: off, end: elemEnd, kind: label });
      }
    } else if (id === 0x45a3 || id === 0x4487) {
      const label = id === 0x45a3 ? 'TagName' : 'TagString';
      const val = utf8Decoder.decode(bytes.subarray(dataStart, elemEnd));
      if (sanitizeText(val)) {
        addEntry(entries, { group: 'WebM Tags', key: label, value: val, location: 'WebM SimpleTag' });
      }
    }

    if (elemEnd <= off) break;
    off = elemEnd;
  }
}

function writeEbmlVoidInPlace(buf, start, end) {
  const totalLen = end - start;
  if (totalLen < 2) return false;
  const rem = totalLen - 1;
  let k = 1;
  while (k <= 8) {
    const payloadLen = rem - k;
    const maxVal = (2 ** (7 * k)) - 2;
    if (payloadLen >= 0 && payloadLen <= maxVal) {
      buf[start] = 0xec; // EBML Void ID
      let v = payloadLen;
      for (let i = k - 1; i >= 0; i -= 1) {
        buf[start + 1 + i] = v & 0xff;
        v = Math.floor(v / 256);
      }
      buf[start + 1] |= (0x80 >> (k - 1));
      buf.fill(0, start + 1 + k, end);
      return true;
    }
    k += 1;
  }
  return false;
}

function stripWebm(bytes, { asParts = false } = {}) {
  const entries = [];
  const scrubTargets = [];
  collectEbmlMetadata(bytes, 0, bytes.length, entries, scrubTargets);
  const sorted = [...scrubTargets]
    .sort((a, b) => (a.start - b.start) || (b.end - a.end))
    .filter((target, idx, arr) => {
      for (let i = 0; i < idx; i += 1) {
        if (target.start >= arr[i].start && target.end <= arr[i].end) return false;
      }
      return true;
    });

  if (asParts) {
    const cleanedChunks = [];
    const remainingEntries = [];
    let cursor = 0;
    let removed = 0;
    for (const target of sorted) {
      if (target.start > cursor) {
        cleanedChunks.push(bytes.subarray(cursor, target.start));
      }
      const patch = bytes.slice(target.start, target.end);
      if (writeEbmlVoidInPlace(patch, 0, patch.length)) {
        removed += 1;
      } else {
        collectEbmlMetadata(patch, 0, patch.length, remainingEntries, []);
      }
      cleanedChunks.push(patch);
      cursor = target.end;
    }
    if (cursor < bytes.length) {
      cleanedChunks.push(bytes.subarray(cursor));
    }
    return {
      cleanedBytes: null,
      cleanedChunks,
      cleanedSize: bytes.length,
      removedChunks: removed,
      afterEntries: remainingEntries,
    };
  }

  const out = bytes.slice();
  let removed = 0;
  for (const target of sorted) {
    if (writeEbmlVoidInPlace(out, target.start, target.end)) {
      removed += 1;
    }
  }
  return { cleanedBytes: out, cleanedSize: out.length, removedChunks: removed };
}

function buildScanReportFromEntries(detected, fileSize, entries) {
  const toolSet = new Set();
  const reasonSet = new Set();
  for (const entry of entries) {
    for (const tool of entry.aiTools || []) toolSet.add(tool);
    for (const reason of entry.aiReasons || []) reasonSet.add(reason);
  }
  const aiEntriesCount = entries.filter((e) => e.isAi).length;
  return {
    ok: true,
    supported: true,
    format: detected.format,
    formatLabel: detected.label,
    mediaKind: detected.mediaKind,
    mimeType: detected.mimeType,
    ext: detected.ext,
    fileSize,
    aiDetected: toolSet.size > 0,
    detectedTools: Array.from(toolSet),
    aiSignals: Array.from(reasonSet),
    entries,
    totalEntries: entries.length,
    aiEntriesCount,
    removable: entries.length > 0,
  };
}

// ---- Public APIs ----
export async function scanMediaMetadata(input, { fileName = '', mimeType = '' } = {}) {
  const bytes = toUint8Array(input);
  const detected = detectMediaFormat(bytes, { fileName, mimeType });
  if (detected.format === 'unsupported') {
    return {
      ok: false,
      supported: false,
      format: 'unsupported',
      formatLabel: detected.label,
      mediaKind: detected.mediaKind,
      mimeType: detected.mimeType,
      fileSize: bytes.length,
      aiDetected: false,
      detectedTools: [],
      aiSignals: [],
      entries: [],
      totalEntries: 0,
      aiEntriesCount: 0,
      removable: false,
      error: 'Format file belum didukung. Gunakan PNG, JPG/JPEG, WebP, GIF, MP4, MOV, atau WebM.',
    };
  }

  const entries = [];
  if (detected.format === 'png') await scanPng(bytes, entries);
  else if (detected.format === 'jpeg') scanJpeg(bytes, entries);
  else if (detected.format === 'webp') scanWebp(bytes, entries);
  else if (detected.format === 'gif') scanGif(bytes, entries);
  else if (detected.format === 'mp4') scanMp4Container(bytes, 0, bytes.length, entries);
  else if (detected.format === 'webm') {
    const scrubTargets = [];
    collectEbmlMetadata(bytes, 0, bytes.length, entries, scrubTargets);
  }

  return buildScanReportFromEntries(detected, bytes.length, entries);
}

export async function stripMediaMetadata(input, { fileName = '', mimeType = '', asParts = false } = {}) {
  const bytes = toUint8Array(input);
  const before = await scanMediaMetadata(bytes, { fileName, mimeType });
  if (!before.supported) {
    throw new Error(before.error || 'Format file tidak didukung.');
  }

  let result;
  if (before.format === 'png') result = stripPng(bytes);
  else if (before.format === 'jpeg') result = stripJpeg(bytes);
  else if (before.format === 'webp') result = stripWebp(bytes);
  else if (before.format === 'gif') result = stripGif(bytes);
  else if (before.format === 'mp4') result = stripMp4(bytes, { asParts });
  else if (before.format === 'webm') result = stripWebm(bytes, { asParts });
  else throw new Error('Format file tidak didukung.');

  const cleanedSize = Number.isFinite(result.cleanedSize) ? result.cleanedSize : result.cleanedBytes.length;
  const cleanedChunks = result.cleanedChunks || (result.cleanedBytes ? [result.cleanedBytes] : []);
  const after = result.cleanedBytes
    ? await scanMediaMetadata(result.cleanedBytes, { fileName, mimeType })
    : buildScanReportFromEntries({
      format: before.format,
      label: before.formatLabel,
      mediaKind: before.mediaKind,
      mimeType: before.mimeType,
      ext: before.ext,
    }, cleanedSize, result.afterEntries || []);

  const removedCount = Math.max(before.totalEntries - after.totalEntries, result.removedChunks);

  return {
    ok: true,
    format: before.format,
    formatLabel: before.formatLabel,
    mediaKind: before.mediaKind,
    mimeType: before.mimeType,
    ext: before.ext,
    originalSize: bytes.length,
    cleanedSize,
    cleanedBytes: result.cleanedBytes || null,
    cleanedChunks,
    removedChunks: result.removedChunks,
    removedCount,
    before,
    after,
  };
}

export function compactScanSummary(scan) {
  if (!scan || typeof scan !== 'object') return {};
  return {
    format: scan.format || '',
    formatLabel: scan.formatLabel || '',
    mediaKind: scan.mediaKind || '',
    mimeType: scan.mimeType || '',
    aiDetected: Boolean(scan.aiDetected),
    detectedTools: Array.isArray(scan.detectedTools) ? scan.detectedTools.slice(0, 16) : [],
    aiSignals: Array.isArray(scan.aiSignals) ? scan.aiSignals.slice(0, 16) : [],
    totalEntries: Number(scan.totalEntries || 0),
    aiEntriesCount: Number(scan.aiEntriesCount || 0),
    ...(scan.aiEngine ? { aiEngine: scan.aiEngine } : {}),
    ...(scan.confidence ? { confidence: String(scan.confidence).slice(0, 32) } : {}),
    ...(scan.visualAssessment ? { visualAssessment: String(scan.visualAssessment).slice(0, 600) } : {}),
    ...(scan.aiSummary ? { aiSummary: String(scan.aiSummary).slice(0, 600) } : {}),
    ...(Number.isFinite(scan.framesAnalyzed) ? { framesAnalyzed: Number(scan.framesAnalyzed) } : {}),
    entries: Array.isArray(scan.entries)
      ? scan.entries.slice(0, 50).map((entry) => ({
        group: String(entry.group || '').slice(0, 60),
        key: String(entry.key || '').slice(0, 120),
        value: String(entry.value || '').slice(0, 300),
        location: String(entry.location || '').slice(0, 80),
        isAi: Boolean(entry.isAi),
        ...(entry.modelName ? { modelName: String(entry.modelName).slice(0, 100) } : {}),
        ...(entry.reason ? { reason: String(entry.reason).slice(0, 240) } : {}),
        ...(typeof entry.willRemove === 'boolean' ? { willRemove: entry.willRemove } : {}),
      }))
      : [],
  };
}

export function mergeAiScanFindings(binaryScan = {}, aiParsed = {}, aiMeta = {}) {
  const baseEntries = Array.isArray(binaryScan?.entries) ? binaryScan.entries : [];
  const aiTags = Array.isArray(aiParsed?.metadata_tags_to_remove) ? aiParsed.metadata_tags_to_remove : [];
  const aiModels = Array.isArray(aiParsed?.detected_models)
    ? aiParsed.detected_models.map((m) => sanitizeText(m, 100)).filter(Boolean)
    : [];

  const mergedEntries = baseEntries.map((entry) => {
    const keyLower = String(entry.key || '').toLowerCase();
    const valLower = String(entry.value || '').toLowerCase();
    const matchedTag = aiTags.find((tag) => {
      const tKey = String(tag?.tag || '').trim().toLowerCase();
      const tVal = String(tag?.value || '').trim().toLowerCase();
      return (tKey && (keyLower === tKey || keyLower.includes(tKey) || tKey.includes(keyLower)))
        || (tVal && tVal.length >= 3 && valLower.includes(tVal));
    });
    const matchedModel = matchedTag?.model_name
      ? sanitizeText(matchedTag.model_name, 100)
      : aiModels.find((m) => valLower.includes(m.toLowerCase()) || keyLower.includes(m.toLowerCase()));
    const isAi = Boolean(entry.isAi || matchedTag || matchedModel);
    return {
      ...entry,
      isAi,
      willRemove: true,
      ...(matchedModel ? { modelName: matchedModel } : {}),
      ...(matchedTag?.reason ? { reason: sanitizeText(matchedTag.reason, 240) } : {}),
    };
  });

  // Also append any newly spotted metadata/model-tag indicators reported by the AI
  // inspector that did not match an existing entry key/value directly.
  for (const tag of aiTags) {
    const tagName = sanitizeText(tag?.tag || 'Tag AI', 120);
    const tagValue = sanitizeText(tag?.value || tag?.model_name || '', 300);
    const modelName = sanitizeText(tag?.model_name || '', 100);
    const category = sanitizeText(tag?.category || 'Analisis AI', 60);
    const reason = sanitizeText(tag?.reason || '', 240);
    const alreadyExists = mergedEntries.some((entry) => {
      const ek = String(entry.key || '').toLowerCase();
      const ev = String(entry.value || '').toLowerCase();
      return (tagName && ek === tagName.toLowerCase())
        || (tagValue && ev.includes(tagValue.toLowerCase()));
    });
    if (!alreadyExists && (tagValue || modelName)) {
      const isVisualOnly = /visual|watermark|gambar|frame|video/i.test(`${category} ${tagName}`) && baseEntries.length === 0;
      mergedEntries.push({
        group: category,
        key: tagName,
        value: tagValue || modelName,
        location: isVisualOnly ? 'Deteksi Visual AI (bukan tag biner file)' : 'Metadata Tag (Terdeteksi AI)',
        isAi: true,
        willRemove: !isVisualOnly,
        ...(modelName ? { modelName } : {}),
        ...(reason ? { reason } : {}),
      });
    }
  }

  const toolSet = new Set([
    ...(Array.isArray(binaryScan?.detectedTools) ? binaryScan.detectedTools : []),
    ...aiModels,
  ]);
  const reasonSet = new Set(Array.isArray(binaryScan?.aiSignals) ? binaryScan.aiSignals : []);
  if (aiParsed?.summary) reasonSet.add(sanitizeText(aiParsed.summary, 300));

  const removableEntriesCount = baseEntries.length;
  const aiEntriesCount = mergedEntries.filter((e) => e.isAi).length;
  const aiDetected = Boolean(
    binaryScan?.aiDetected
    || aiParsed?.ai_detected === true
    || toolSet.size > 0
    || aiEntriesCount > 0,
  );

  return {
    ok: true,
    supported: true,
    format: binaryScan?.format || '',
    formatLabel: binaryScan?.formatLabel || '',
    mediaKind: binaryScan?.mediaKind || 'image',
    mimeType: binaryScan?.mimeType || '',
    ext: binaryScan?.ext || '',
    fileSize: Number(binaryScan?.fileSize || 0),
    aiDetected,
    detectedTools: Array.from(toolSet),
    aiSignals: Array.from(reasonSet),
    entries: mergedEntries,
    totalEntries: mergedEntries.length,
    removableEntriesCount,
    aiEntriesCount,
    removable: removableEntriesCount > 0,
    visualOnlyWarning: aiDetected && removableEntriesCount === 0,
    aiEngine: aiMeta?.model ? {
      provider: aiMeta.provider || 'cloudflare',
      model: aiMeta.model,
      mode: aiMeta.mode || 'binding',
      ...(aiMeta.fallback ? { fallback: true } : {}),
    } : null,
    // true = semua model AI (Cloudflare + fallback) tidak tersedia / kuotanya
    // habis, jadi pemindaian hanya memakai pembaca container biner lossless.
    // Pembersihan metadata tetap berjalan tanpa AI.
    ...(aiMeta?.skipped ? {
      aiSkipped: true,
      aiSkipReason: sanitizeText(aiMeta.skipReason || '', 300),
    } : {}),
    confidence: sanitizeText(aiParsed?.confidence || (aiDetected ? 'tinggi' : 'rendah'), 32),
    visualAssessment: sanitizeText(aiParsed?.visual_assessment || '', 600),
    aiSummary: sanitizeText(aiParsed?.summary || '', 600),
    framesAnalyzed: Number(aiMeta?.framesAnalyzed || 0),
  };
}

// Hasil scan tanpa AI: dipakai saat kuota semua model AI habis atau tidak ada
// provider vision yang aktif. Pembersihan metadata tetap lossless dan lengkap
// karena seluruh tag/atom metadata dihapus oleh pembaca container biner.
export function buildBinaryOnlyScan(binaryScan = {}, reason = '') {
  return mergeAiScanFindings(binaryScan, {}, { skipped: true, skipReason: reason });
}

export function formatBytesCompact(bytes) {
  const num = Number(bytes || 0);
  if (!Number.isFinite(num) || num <= 0) return '0 B';
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${(num / (1024 * 1024)).toFixed(2)} MB`;
}
