// Generasi media Studio lewat pool akun ChatGPT (OpenAI).
//
// Bedanya dengan jalur freebeat: tidak ada kredit BLEA yang dipotong, karena
// yang membayar adalah akun OpenAI milik admin. Yang dibatasi adalah KUOTA
// HARIAN per akun (kolom daily_limit di chatgpt_accounts): bila akun pertama
// habis, permintaan pindah ke akun berikutnya — sama seperti pool freebeat.
//
// Yang TIDAK dilakukan di sini: menitipkan token sesi ChatGPT ke backend
// non-publik. Semua panggilan memakai endpoint resmi (/v1/images, /v1/videos)
// dengan API key, karena hanya itu yang sah dipakai program.

import { isChatGptPoolFailure, pickChatGptAccountsFor, recordChatGptUsage } from './chatgptPool.js';

const OPENAI_IMAGE_MODELS = new Set(['gpt-image-1', 'gpt-image-1-mini', 'dall-e-3']);
const OPENAI_VIDEO_MODELS = new Set(['sora-2', 'sora-2-pro', 'sora-2-mini']);
const MAX_PROMPT_CHARS = 4000;

function supabaseBase(env) {
  return (env.SUPABASE_URL || 'https://lwknqvgnxgecptkvtkfb.supabase.co').replace(/\/+$/, '');
}

function fail(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

async function dbRequest(env, path, options = {}) {
  let res;
  try {
    res = await fetch(`${supabaseBase(env)}/rest/v1${path}`, {
      method: options.method || 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'content-type': 'application/json',
        ...(options.prefer ? { prefer: options.prefer } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    throw fail('Penyimpanan BLEA tidak dapat dihubungi.', 503);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw fail(`Penyimpanan BLEA menolak permintaan (HTTP ${res.status}). ${detail.slice(0, 200)}`.trim(), 503);
  }
  return res;
}

async function dbJson(env, path, options = {}) {
  const res = await dbRequest(env, path, options);
  return await res.json().catch(() => null);
}

function cleanPrompt(value) {
  const prompt = typeof value === 'string' ? value.trim() : '';
  if (!prompt) throw fail('Prompt kosong.', 400);
  if (prompt.length > MAX_PROMPT_CHARS) throw fail(`Prompt maksimal ${MAX_PROMPT_CHARS} karakter.`, 400);
  return prompt;
}

async function readUpstreamError(res) {
  const text = await res.text().catch(() => '');
  try {
    const data = JSON.parse(text);
    return String(data?.error?.message || data?.error || data?.message || text).slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

async function insertRow(env, row) {
  const created = await dbJson(env, '/studio_generations', { method: 'POST', prefer: 'return=representation', body: row });
  return Array.isArray(created) ? created[0] : null;
}

async function patchRow(env, id, patch) {
  try {
    await dbRequest(env, `/studio_generations?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: { ...patch, updated_at: new Date().toISOString() },
    });
  } catch { /* baris status bersifat informatif */ }
}

/**
 * Config ruang gambar/video Studio: model dari akun pool + kesiapan kuota.
 * `ready` tidak pernah dipalsukan: bila tidak ada akun siap, nilainya false.
 */
export async function studioMediaConfig(env, kind = 'image') {
  const capability = kind === 'video' ? 'video' : 'image';
  const accounts = await pickChatGptAccountsFor(env, { capability, limit: 4 }).catch(() => []);
  const models = [...(capability === 'video' ? OPENAI_VIDEO_MODELS : OPENAI_IMAGE_MODELS)];
  const preferred = accounts[0]?.model || (capability === 'video' ? 'sora-2' : 'gpt-image-1');
  return {
    kind: capability,
    provider: 'openai',
    ready: accounts.length > 0,
    models: models.map((id) => ({ id, provider: 'openai', default: id === preferred })),
    recommended: models.includes(preferred) ? preferred : models[0],
    accounts: accounts.length,
    ...(accounts.length ? {} : {
      hint: 'Tool gambar/video butuh akun ber-API key: izin OAuth “Continue with ChatGPT” hanya mencakup chat & agen. Tambahkan API key di Studio → Akun ChatGPT.',
    }),
  };
}

/**
 * Buat gambar lewat pool akun ChatGPT. Failover lintas akun sama seperti chat:
 * kuota/rate-limit/auth → catat cooldown → akun berikutnya.
 */
export async function generateStudioImage(env, user, input) {
  const model = String(input?.model || 'gpt-image-1').trim();
  if (!OPENAI_IMAGE_MODELS.has(model)) throw fail('Model gambar hanya gpt-image-1, gpt-image-1-mini, atau dall-e-3.', 400);
  const prompt = cleanPrompt(input?.prompt);
  const size = ['1024x1024', '1024x1536', '1536x1024', 'auto'].includes(String(input?.size || '')) ? String(input.size) : '1024x1024';
  const accounts = await pickChatGptAccountsFor(env, { capability: 'image', limit: 4 });
  if (!accounts.length) throw fail('Belum ada akun ChatGPT ber-API key yang siap untuk tool gambar. Izin OAuth hanya untuk chat & agen, jadi tool gambar butuh API key di Studio → Akun ChatGPT.', 503);

  const row = await insertRow(env, {
    user_id: user.id,
    kind: 'image',
    tool: 'image',
    provider: 'openai',
    model,
    prompt,
    status: 'processing',
    metadata: { size },
  });
  if (!row?.id) throw fail('Gagal menyimpan permintaan gambar.', 500);

  let lastError = '';
  for (const account of accounts) {
    let res;
    try {
      res = await fetch(`${account.apiBase}/v1/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.apiKey}` },
        body: JSON.stringify({
          model,
          prompt,
          n: 1,
          size,
          ...(model === 'dall-e-3' ? { response_format: 'url' } : {}),
        }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 300);
      await recordChatGptUsage(env, account.id, { ok: false, status: 0, error: lastError });
      continue;
    }
    if (!res.ok) {
      lastError = `HTTP ${res.status}: ${await readUpstreamError(res)}`;
      await recordChatGptUsage(env, account.id, { ok: false, status: res.status, error: lastError, counted: true });
      if (isChatGptPoolFailure(res.status, lastError)) continue;
      break;
    }
    const data = await res.json().catch(() => ({}));
    const first = Array.isArray(data?.data) ? data.data[0] : null;
    const imageUrl = first?.url || (first?.b64_json ? `data:image/png;base64,${first.b64_json}` : '');
    if (!imageUrl) {
      lastError = 'Respons gambar kosong dari API.';
      await recordChatGptUsage(env, account.id, { ok: false, status: 502, error: lastError });
      continue;
    }
    await recordChatGptUsage(env, account.id, { ok: true, status: res.status, counted: true });
    const patch = {
      status: 'completed',
      media_url: imageUrl,
      chatgpt_account_id: account.id,
      chatgpt_account_label: account.accountLabel || account.accountEmail || '',
      metadata: { size, revised_prompt: first?.revised_prompt || '' },
    };
    await patchRow(env, row.id, patch);
    return { generation: { ...row, ...patch } };
  }

  await patchRow(env, row.id, { status: 'failed', error_message: lastError || 'Semua akun pool menolak permintaan.' });
  throw fail(lastError || 'Semua akun pool menolak permintaan gambar.', 502);
}

/**
 * Buat video lewat pool akun ChatGPT (Sora). Submit asinkron: baris disimpan
 * dengan external id, lalu /api/studio/video/status mem-poll dan menyimpan
 * hasil akhirnya ke baris yang sama.
 */
export async function generateStudioVideo(env, user, input) {
  const model = String(input?.model || 'sora-2').trim();
  if (!OPENAI_VIDEO_MODELS.has(model)) throw fail('Model video hanya sora-2, sora-2-pro, atau sora-2-mini.', 400);
  const prompt = cleanPrompt(input?.prompt);
  const seconds = ['4', '8', '12'].includes(String(input?.seconds || '')) ? String(input.seconds) : '8';
  const size = typeof input?.size === 'string' && /^\d{2,4}x\d{2,4}$/.test(input.size) ? input.size : '1280x720';
  const accounts = await pickChatGptAccountsFor(env, { capability: 'video', limit: 4 });
  if (!accounts.length) throw fail('Belum ada akun ChatGPT ber-API key yang siap untuk tool video. Izin OAuth hanya untuk chat & agen, jadi tool video butuh API key di Studio → Akun ChatGPT.', 503);

  const row = await insertRow(env, {
    user_id: user.id,
    kind: 'video',
    tool: 'video',
    provider: 'openai',
    model,
    prompt,
    status: 'queued',
    metadata: { seconds, size },
  });
  if (!row?.id) throw fail('Gagal menyimpan permintaan video.', 500);

  let lastError = '';
  for (const account of accounts) {
    let res;
    try {
      res = await fetch(`${account.apiBase}/v1/videos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.apiKey}` },
        body: JSON.stringify({ model, prompt, seconds, size }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 300);
      await recordChatGptUsage(env, account.id, { ok: false, status: 0, error: lastError });
      continue;
    }
    if (!res.ok) {
      lastError = `HTTP ${res.status}: ${await readUpstreamError(res)}`;
      await recordChatGptUsage(env, account.id, { ok: false, status: res.status, error: lastError, counted: true });
      if (isChatGptPoolFailure(res.status, lastError)) continue;
      break;
    }
    const data = await res.json().catch(() => ({}));
    const videoId = String(data?.id || '');
    if (!videoId) {
      lastError = 'Respons video kosong dari API.';
      await recordChatGptUsage(env, account.id, { ok: false, status: 502, error: lastError });
      continue;
    }
    await recordChatGptUsage(env, account.id, { ok: true, status: res.status, counted: true });
    const patch = {
      status: 'processing',
      chatgpt_account_id: account.id,
      chatgpt_account_label: account.accountLabel || account.accountEmail || '',
      metadata: { seconds, size, external_id: videoId, api_base: account.apiBase },
    };
    await patchRow(env, row.id, patch);
    return { generation: { ...row, ...patch } };
  }

  await patchRow(env, row.id, { status: 'failed', error_message: lastError || 'Semua akun pool menolak permintaan.' });
  throw fail(lastError || 'Semua akun pool menolak permintaan video.', 502);
}

/** Poll status video milik satu pengguna; aman dipanggil berulang. */
export async function studioVideoStatus(env, user, id) {
  const rows = await dbJson(env, `/studio_generations?id=eq.${encodeURIComponent(String(id))}&user_id=eq.${encodeURIComponent(user.id)}&select=*&limit=1`);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw fail('Riwayat video tidak ditemukan.', 404);
  if (row.kind !== 'video') throw fail('Baris ini bukan video.', 400);
  const externalId = row.metadata?.external_id;
  if (!externalId || !['queued', 'processing'].includes(row.status)) return { generation: row };

  // Akun yang dipakai submit dipakai lagi untuk poll, supaya tugas tidak
  // berpindah ke workspace akun lain.
  const accountId = row.chatgpt_account_id;
  const accounts = await pickChatGptAccountsFor(env, { capability: 'video', limit: 4 });
  const account = accounts.find((item) => item.id === accountId) || accounts[0];
  if (!account) return { generation: row };

  const base = row.metadata?.api_base || account.apiBase;
  let res;
  try {
    res = await fetch(`${base}/v1/videos/${encodeURIComponent(externalId)}`, {
      headers: { authorization: `Bearer ${account.apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { generation: row };
  }
  if (!res.ok) return { generation: row };
  const data = await res.json().catch(() => ({}));
  const status = String(data?.status || '').toLowerCase();
  if (status === 'completed' || status === 'succeeded') {
    let contentUrl = String(data?.url || '');
    if (!contentUrl) {
      try {
        const contentRes = await fetch(`${base}/v1/videos/${encodeURIComponent(externalId)}/content`, {
          headers: { authorization: `Bearer ${account.apiKey}` },
          redirect: 'follow',
          signal: AbortSignal.timeout(30_000),
        });
        if (contentRes.ok) contentUrl = String(data?.url || '');
      } catch { /* biarkan kosong; UI menampilkan status selesai tanpa player */ }
    }
    const patch = { status: 'completed', media_url: contentUrl || row.media_url || '' };
    await patchRow(env, row.id, patch);
    return { generation: { ...row, ...patch } };
  }
  if (status === 'failed' || status === 'cancelled') {
    const patch = { status: status === 'failed' ? 'failed' : 'cancelled', error_message: String(data?.error?.message || 'Generasi video gagal.').slice(0, 300) };
    await patchRow(env, row.id, patch);
    return { generation: { ...row, ...patch } };
  }
  return { generation: row };
}

/** Simpan hasil teks (chat/agen) supaya muncul di halaman Hasil & Unduhan. */
export async function recordStudioText(env, userId, { tool = 'chat', model = '', prompt = '', output = '', metadata = {} } = {}) {
  const text = String(output || '').trim();
  if (!text) return null;
  try {
    return await insertRow(env, {
      user_id: userId,
      kind: 'text',
      tool: String(tool || 'chat').slice(0, 40),
      provider: 'openai',
      model: String(model || '').slice(0, 160),
      prompt: String(prompt || '').slice(0, MAX_PROMPT_CHARS),
      output_text: text.slice(0, 40_000),
      status: 'completed',
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
    });
  } catch {
    return null;
  }
}
