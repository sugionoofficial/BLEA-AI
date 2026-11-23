// Jembatan antara payload gaya Chat Completions (yang sudah dipakai seluruh
// BLEA) dan Responses API milik OpenAI untuk jalur OAuth "Continue with ChatGPT".
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
    // Wajib pada jalur paket ChatGPT.
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

/** Error-code khusus jalur paket ChatGPT yang berarti "akun ini sedang habis". */
export function isSubscriptionLimitError(code, message = '') {
  const clean = `${code || ''} ${message || ''}`;
  return /subscription_sharing_usage_limit_exceeded|subscription_sharing_usage_unavailable|usage_limit|rate.?limit|quota/i.test(clean);
}
