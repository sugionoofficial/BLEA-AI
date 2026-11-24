// Jembatan antara payload gaya Chat Completions (yang sudah dipakai seluruh
// BLEA) dan Responses API milik OpenAI untuk jalur OAuth.
//
// Kenapa perlu jembatan: jalur OAuth hanya boleh memanggil
// POST https://api.openai.com/v1/responses dengan `store:false` dan
// `stream:true`. Banyak field Chat Completions justru DILARANG di sana
// (`temperature`, `top_p`, `max_output_tokens`, `metadata`, `user`, …), dan
// `{role:'system'}` harus menjadi `instructions`. Modul ini menerjemahkan
// keduanya supaya kode pemanggil tidak perlu tahu bedanya.
//
// Rujukan: developers.openai.com/siwc/token-sharing-open-source/models-and-inference
//          developers.openai.com/siwc/token-sharing-open-source/preview-limitations

// Field yang diteruskan apa adanya bila ada nilainya.
const PASS_THROUGH = ['reasoning', 'text', 'include', 'service_tier'];

function toResponsesContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') { parts.push({ type: 'input_text', text: part }); continue; }
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') parts.push({ type: 'input_text', text: part.text });
    else if (part.type === 'input_text' && typeof part.text === 'string') parts.push(part);
    else if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (url) parts.push({ type: 'input_image', image_url: url });
    } else if (part.type === 'input_image') parts.push(part);
  }
  return parts;
}

/**
 * Ubah payload Chat Completions → body Responses API.
 * `{role:'system'}` dikumpulkan menjadi `instructions` karena item message
 * dengan role system ditolak pada jalur ini.
 */
export function buildResponsesBody(payload = {}, { model } = {}) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const systemParts = [];
  const input = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = String(message.role || 'user');
    if (role === 'system' || role === 'developer') {
      const text = typeof message.content === 'string'
        ? message.content
        : (Array.isArray(message.content) ? message.content.map((part) => part?.text || '').join('\n') : '');
      if (text) systemParts.push(text);
      continue;
    }
    // Histori tool-call gaya Chat Completions tidak diterjemahkan: agen BLEA
    // memakai protokol teks ```tool, jadi peran `tool` hanya konteks tambahan.
    if (role === 'tool') {
      const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      if (text) input.push({ role: 'user', content: [{ type: 'input_text', text: `[hasil tool]\n${text}` }] });
      continue;
    }
    const content = toResponsesContent(message.content);
    if (typeof content === 'string' && !content.trim()) continue;
    if (Array.isArray(content) && !content.length) continue;
    input.push({ role: role === 'assistant' ? 'assistant' : 'user', content });
  }

  const body = {
    model: String(model || payload.model || ''),
    input,
    // Wajib pada jalur paket akun (OAuth).
    store: false,
    stream: true,
  };
  const instructions = systemParts.join('\n\n').trim();
  if (instructions) body.instructions = instructions;
  for (const key of PASS_THROUGH) {
    if (payload[key] !== undefined && payload[key] !== null) body[key] = payload[key];
  }
  return body;
}

/**
 * Satu event SSE Responses → event internal BLEA ({type:'delta'|'thinking'}).
 * Mengembalikan juga sinyal selesai/gagal supaya loop stream tahu kapan berhenti.
 */
export function parseResponsesEvent(data) {
  const type = String(data?.type || '');
  if (!type) return { events: [], done: false, failed: null };
  if (type === 'response.output_text.delta') {
    return { events: data?.delta ? [{ type: 'delta', text: String(data.delta) }] : [], done: false, failed: null };
  }
  if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
    return { events: data?.delta ? [{ type: 'thinking', text: String(data.delta) }] : [], done: false, failed: null };
  }
  if (type === 'response.failed') {
    const error = data?.response?.error || {};
    return { events: [], done: true, failed: { code: error.code || 'response_failed', message: error.message || 'Respons OpenAI gagal.' } };
  }
  if (type === 'response.incomplete') {
    return { events: [], done: true, failed: { code: 'response_incomplete', message: 'Respons OpenAI tidak lengkap (batas konteks/keluaran).' } };
  }
  if (type === 'response.completed') {
    return { events: [], done: true, failed: null, response: data?.response || null };
  }
  if (type === 'error') {
    return { events: [], done: true, failed: { code: data?.code || 'stream_error', message: data?.message || 'Stream OpenAI berhenti karena galat.' } };
  }
  return { events: [], done: false, failed: null };
}

/** Kumpulkan teks jawaban dari object `response` final. */
export function extractResponsesText(response) {
  if (!response || typeof response !== 'object') return '';
  const parts = [];
  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (item?.type !== 'message') continue;
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('');
}

/** Kumpulkan function_call dari object `response` final (bentuk gaya Chat Completions). */
export function extractResponsesToolCalls(response) {
  if (!response || typeof response !== 'object') return [];
  return (Array.isArray(response.output) ? response.output : [])
    .filter((item) => item?.type === 'function_call')
    .map((item, index) => ({
      id: item.call_id || item.id || `call_${index}`,
      type: 'function',
      function: { name: String(item.name || ''), arguments: String(item.arguments || '{}') },
    }));
}

/**
 * Bentuk balasan Chat Completions dari object Responses final, supaya kode
 * agen (`extractAssistantReply`) tidak perlu diubah.
 */
export function responsesToChatCompletion(response, model = '') {
  const content = extractResponsesText(response);
  const toolCalls = extractResponsesToolCalls(response);
  return {
    id: response?.id || '',
    model: response?.model || model,
    choices: [{
      index: 0,
      finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
      message: {
        role: 'assistant',
        content,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
    }],
  };
}

/**
 * Kode galat jalur paket akun (OAuth) → sebab + tindakan yang BERBEDA.
 *
 * Semuanya berasal dari jalur yang sama (Responses API dengan token OAuth),
 * tetapi obatnya berbeda jauh:
 *   • `usage_limit`     → pemakaian paket habis sementara (HTTP 429). Tunggu /
 *                         pakai akun lain; menekan ulang memperburuk.
 *   • `not_eligible`    → akun/workspace-nya tidak boleh membagikan paket (HTTP
 *                         403). Ini PERMANEN untuk akun itu; mengulang OAuth
 *                         tidak akan mengubah apa pun.
 *   • `signin_required` → sesi OAuth tidak lagi dikenali; harus login ulang.
 *   • `unavailable`     → layanan sedang tidak tersedia; coba lagi nanti.
 *   • `unsupported`     → isi permintaan tidak didukung jalur ini (model/tool).
 *
 * Mengembalikan null bila bukan galat jalur paket.
 */
export function planUsageFailure(code, message = '') {
  const clean = `${code || ''} ${message || ''}`;
  if (/subscription_sharing_usage_limit_exceeded/i.test(clean)) {
    return {
      reason: 'usage_limit',
      status: 429,
      title: 'Batas pemakaian paket tercapai',
      action: 'Batas ini sementara. Tunggu (atau tambah akun lain di pool); '
        + 'sisa pemakaian bisa dilihat di pengaturan Usage akun OpenAI Anda.',
    };
  }
  if (/subscription_sharing_user_not_eligible|chatpass_v2_scope_not_authorized|chatpass_v2_invalid_authorization_context/i.test(clean)) {
    return {
      reason: 'not_eligible',
      status: 403,
      title: 'Paket akun ini tidak bisa dipakai aplikasi lain',
      action: 'Hanya paket Plus/Pro pada akun pribadi yang bisa dipakai lewat jalur OAuth. '
        + 'Akun Free/Go tidak bisa, dan workspace Business/Enterprise perlu izin admin. '
        + 'Mengulangi login TIDAK akan mengubahnya — tambahkan API key (dengan saldo) '
        + 'atau login dengan akun Plus/Pro.',
    };
  }
  if (/subscription_sharing_usage_unavailable|subscription_sharing_user_unavailable/i.test(clean)) {
    return { reason: 'unavailable', status: 503, title: 'Pemakaian paket tidak bisa diperiksa', action: 'Coba lagi beberapa saat lagi.' };
  }
  if (/subscription_sharing_invalid_user/i.test(clean)) {
    return { reason: 'signin_required', status: 401, title: 'Sesi OAuth tidak dikenali', action: 'Login ulang lewat tombol Connect.' };
  }
  if (/subscription_sharing_unsupported_capability|subscription_sharing_route_not_supported/i.test(clean)) {
    return {
      reason: 'unsupported',
      status: 400,
      title: 'Permintaan tidak didukung jalur paket',
      action: 'Jalur OAuth hanya untuk teks (Responses API). Gambar, audio, dan alat bawaan OpenAI tidak tersedia.',
    };
  }
  return null;
}

/** Error-code khusus jalur paket akun yang berarti "akun ini sedang habis". */
export function isSubscriptionLimitError(code, message = '') {
  const clean = `${code || ''} ${message || ''}`;
  return /subscription_sharing_usage_limit_exceeded|subscription_sharing_usage_unavailable|usage_limit|rate.?limit|quota/i.test(clean);
}

/**
 * Katalog model milik akun OAuth (`GET /v1/models` dengan access token).
 *
 * Bentuknya khas jalur paket: `{models:[{slug, display_name, visibility}]}`.
 * Akun API key mendapat `{data:[{id}]}`; keduanya diterima.
 * Best-effort: kegagalan jaringan/katalog kosong mengembalikan array kosong,
 * karena ini hanya dipakai untuk MEMILIH, bukan untuk menolak.
 */
export async function openAiResponsesModelCatalog(accessToken, { timeoutMs = 15_000, fetchImpl = null } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch('https://api.openai.com/v1/models', {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const body = await res.json().catch(() => null);
    return Array.isArray(body?.models) ? body.models : (Array.isArray(body?.data) ? body.data : []);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pilih model dari katalog yang BENAR-BENAR dimiliki akun OAuth.
 *
 * Kenapa perlu: jalur paket memakai katalog per-akun (`{models:[{slug}]}`),
 * bukan daftar model API biasa. Dulu `model_default` OAuth diisi tebakan
 * `gpt-5.1`; kalau akun tidak punya model itu, setiap permintaan gagal
 * "model not found" padahal tokennya sehat. Sekarang katalog dibaca lebih dulu.
 */
export function planModelFromCatalog(body, preferred = '') {
  const list = Array.isArray(body?.models) ? body.models
    : (Array.isArray(body?.data) ? body.data : []);
  const slugOf = (item) => String(item?.slug || item?.id || '').trim();
  const visible = list
    .filter((item) => item?.visibility === undefined || item?.visibility === 'list')
    .map(slugOf)
    .filter(Boolean);
  const want = String(preferred || '').trim();
  if (want && visible.includes(want)) return want;
  // Urutan ini hanya preferensi: yang pertama tersedia di akun itu yang dipakai.
  const preferredOrder = ['gpt-5.1', 'gpt-5', 'gpt-4o-mini', 'gpt-4o'];
  const pick = preferredOrder.find((slug) => visible.includes(slug));
  if (pick) return pick;
  if (visible.length) return visible[0];
  // Katalog tidak terbaca: jangan menukar nilai yang sudah dipilih pengguna.
  return want;
}
