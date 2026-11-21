import {
  METADATA_MAX_FILE_BYTES,
  METADATA_SERVICE_COST,
  compactScanSummary,
  detectMediaFormat,
  scanMediaMetadata,
  stripMediaMetadata,
} from './mediaMetadata.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORAGE_BUCKET = 'ai-studio-uploads';

function supabaseBase(env) {
  return (env.SUPABASE_URL || 'https://lwknqvgnxgecptkvtkfb.supabase.co').replace(/\/+$/, '');
}

function base64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeBase64(raw) {
  const clean = String(raw || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function metadataMediaKey(env) {
  const secret = env.SUPABASE_SERVICE_ROLE_KEY || env.GITHUB_CLIENT_SECRET || env.SUPABASE_ANON_KEY || 'blea-metadata-media-dev';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`blea-metadata-media-v1:${secret}`));
  return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signMetadataContentUrl(id, env, ttlMs = 2 * 60 * 60 * 1000) {
  const exp = String(Date.now() + ttlMs);
  const msg = new TextEncoder().encode(`meta:${id}:${exp}`);
  const sigBytes = new Uint8Array(await crypto.subtle.sign('HMAC', await metadataMediaKey(env), msg));
  const sig = base64url(sigBytes);
  return `/api/metadata/content/${encodeURIComponent(id)}?exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`;
}

export async function verifyMetadataContentSig(id, exp, sig, env) {
  try {
    if (!id || !exp || !sig) return false;
    const expNum = Number(exp);
    if (!Number.isFinite(expNum) || Date.now() > expNum) return false;
    const msg = new TextEncoder().encode(`meta:${id}:${exp}`);
    return await crypto.subtle.verify('HMAC', await metadataMediaKey(env), unbase64url(sig), msg);
  } catch {
    return false;
  }
}

export function sanitizeCleanFilename(filename, ext = 'bin', jobId = '') {
  const base = String(filename || '')
    .replace(/^.*[\\/]/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);
  const shortId = String(jobId || 'file').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'file';
  if (!base) return `clean-blea-${shortId}.${ext}`;
  const hasExt = /\.[a-z0-9]{2,5}$/i.test(base);
  const withExt = hasExt ? base : `${base}.${ext}`;
  return withExt.startsWith('clean-') ? withExt : `clean-${withExt}`;
}

function encodeStoragePath(objectPath) {
  return String(objectPath || '')
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
}

async function storageRequest(env, method, objectPath, { body, headers = {} } = {}) {
  const encoded = encodeStoragePath(objectPath);
  const url = `${supabaseBase(env)}/storage/v1/object/${STORAGE_BUCKET}/${encoded}`;
  return fetch(url, {
    method,
    headers: {
      apikey: env.SUPABASE_ANON_KEY || 'sb_publishable_0M0DMfjajnpk6weWldy0iQ_lrzyuXTz',
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      ...headers,
    },
    body,
    signal: AbortSignal.timeout(45_000),
  });
}

function isSafeUserStoragePath(userId, storagePath) {
  const raw = String(storagePath || '').trim();
  if (!raw || raw.includes('..') || raw.startsWith('/')) return false;
  return raw.startsWith(`${userId}/`);
}

export async function sanitizeMetadataJobRow(row, env) {
  if (!row) return null;
  const completed = row.status === 'completed' && Boolean(row.cleaned_path);
  const resultUrl = completed ? await signMetadataContentUrl(row.id, env) : null;
  const downloadUrl = resultUrl ? `${resultUrl}&download=1` : null;
  return {
    id: row.id,
    user_id: row.user_id,
    kind: 'metadata',
    media_kind: row.media_kind,
    filename: row.filename,
    mime_type: row.mime_type,
    original_size: Number(row.original_size || 0),
    cleaned_size: Number(row.cleaned_size || 0),
    status: row.status,
    progress: Number(row.progress || 0),
    ai_detected: Boolean(row.ai_detected),
    detected_tools: Array.isArray(row.detected_tools) ? row.detected_tools : [],
    scan_before: row.scan_before && typeof row.scan_before === 'object' ? row.scan_before : {},
    scan_after: row.scan_after && typeof row.scan_after === 'object' ? row.scan_after : {},
    removed_count: Number(row.removed_count || 0),
    result_url: resultUrl,
    download_url: downloadUrl,
    credits_charged: Number(row.credits_charged || 0),
    credits_refunded: Number(row.credits_refunded || 0),
    error_message: row.error_message || null,
    created_at: row.created_at,
    updated_at: row.updated_at || row.created_at,
  };
}

async function refundMetadataCredits(env, creditRpc, userId, amount, jobId, description) {
  if (!amount || amount <= 0) return false;
  return creditRpc(env, 'refund_credits', {
    p_user_id: userId,
    p_amount: amount,
    p_description: description,
    p_generation_id: jobId,
  });
}

async function patchMetadataJob(servicePostgrest, env, jobId, patch) {
  const res = await servicePostgrest(env, `/metadata_jobs?id=eq.${encodeURIComponent(jobId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: { ...patch, updated_at: new Date().toISOString() },
  }).catch(() => null);
  if (!res?.ok) return null;
  const rows = await res.json().catch(() => []);
  return rows?.[0] || null;
}

export async function handleMetadataStart({ request, env, user, jsonResponse, servicePostgrest, creditRpc }) {
  if (!user) return jsonResponse({ error: 'Login diperlukan.' }, 401);
  const body = await request.json().catch(() => ({}));
  const filename = String(body.filename || 'media').replace(/^.*[\\/]/, '').trim().slice(0, 260) || 'media';
  const mimeType = String(body.mime_type || '').trim().slice(0, 100);
  const mediaKind = body.media_kind === 'video' || mimeType.startsWith('video/') ? 'video' : 'image';
  const originalSize = Number(body.original_size || 0);
  const scanBefore = compactScanSummary(body.scan_before);

  if (!Number.isFinite(originalSize) || originalSize <= 0 || originalSize > METADATA_MAX_FILE_BYTES) {
    return jsonResponse({
      error: `Ukuran file harus antara 1 byte dan ${Math.round(METADATA_MAX_FILE_BYTES / (1024 * 1024))} MB.`,
    }, 400);
  }

  const jobId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const insertRes = await servicePostgrest(env, '/metadata_jobs', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: [{
      id: jobId,
      user_id: user.id,
      media_kind: mediaKind,
      filename,
      mime_type: mimeType,
      original_size: originalSize,
      cleaned_size: 0,
      status: 'processing',
      progress: 15,
      ai_detected: Boolean(scanBefore.aiDetected),
      detected_tools: scanBefore.detectedTools || [],
      scan_before: scanBefore,
      scan_after: {},
      removed_count: 0,
      credits_charged: 0,
      credits_refunded: 0,
      created_at: nowIso,
      updated_at: nowIso,
    }],
  });
  if (!insertRes?.ok) {
    const errText = insertRes ? await insertRes.text().catch(() => '') : '';
    return jsonResponse({ error: 'Gagal membuat antrean pembersihan metadata.', detail: errText.slice(0, 200) }, 500);
  }
  const insertedRows = await insertRes.json().catch(() => []);
  const row = insertedRows?.[0];
  if (!row) return jsonResponse({ error: 'Gagal membaca antrean pembersihan metadata.' }, 500);

  const spent = await creditRpc(env, 'spend_credits', {
    p_user_id: user.id,
    p_amount: METADATA_SERVICE_COST,
    p_description: `Hapus metadata AI (${filename.slice(0, 120)})`,
    p_generation_id: jobId,
  });

  if (!spent) {
    await servicePostgrest(env, `/metadata_jobs?id=eq.${encodeURIComponent(jobId)}`, { method: 'DELETE' }).catch(() => {});
    return jsonResponse({
      error: `Saldo kredit BLEA Anda tidak cukup. Biaya pembersihan metadata adalah ${METADATA_SERVICE_COST} kredit.`,
      code: 'insufficient_credits',
      required: METADATA_SERVICE_COST,
    }, 402);
  }

  const patched = await patchMetadataJob(servicePostgrest, env, jobId, {
    credits_charged: METADATA_SERVICE_COST,
    progress: 25,
  });
  return jsonResponse({
    ok: true,
    cost: METADATA_SERVICE_COST,
    job: await sanitizeMetadataJobRow(patched || { ...row, credits_charged: METADATA_SERVICE_COST, progress: 25 }, env),
  });
}

export async function handleMetadataProcess({ request, env, user, jsonResponse, servicePostgrest, creditRpc }) {
  if (!user) return jsonResponse({ error: 'Login diperlukan.' }, 401);

  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  let jobId = '';
  let filename = '';
  let mimeType = '';
  let inputBytes = null;
  let storagePath = '';

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData().catch(() => null);
    if (!form) return jsonResponse({ error: 'Payload form tidak valid.' }, 400);
    jobId = String(form.get('id') || '').trim();
    const file = form.get('file');
    filename = String(form.get('filename') || (file && typeof file === 'object' ? file.name : '') || 'media').replace(/^.*[\\/]/, '').trim().slice(0, 260) || 'media';
    mimeType = String(form.get('mime_type') || (file && typeof file === 'object' ? file.type : '') || '').trim();
    if (file && typeof file === 'object' && typeof file.arrayBuffer === 'function') {
      const buf = await file.arrayBuffer();
      inputBytes = new Uint8Array(buf);
    }
  } else {
    const body = await request.json().catch(() => ({}));
    jobId = String(body.id || '').trim();
    filename = String(body.filename || 'media').replace(/^.*[\\/]/, '').trim().slice(0, 260) || 'media';
    mimeType = String(body.mime_type || '').trim();
    storagePath = String(body.storage_path || '').trim();
    if (typeof body.base64 === 'string' && body.base64.trim()) {
      try {
        inputBytes = decodeBase64(body.base64);
      } catch {
        return jsonResponse({ error: 'Data base64 file tidak valid.' }, 400);
      }
    }
  }

  let existingJob = null;
  let chargedAmount = 0;

  if (jobId) {
    if (!UUID_RE.test(jobId)) return jsonResponse({ error: 'ID proses metadata tidak valid.' }, 400);
    const rowRes = await servicePostgrest(env, `/metadata_jobs?select=*&id=eq.${encodeURIComponent(jobId)}&user_id=eq.${encodeURIComponent(user.id)}&limit=1`);
    const rows = rowRes?.ok ? await rowRes.json().catch(() => []) : [];
    existingJob = rows?.[0] || null;
    if (!existingJob) return jsonResponse({ error: 'Proses pembersihan metadata tidak ditemukan.' }, 404);
    if (existingJob.status === 'completed') {
      return jsonResponse({
        ok: true,
        job: await sanitizeMetadataJobRow(existingJob, env),
      });
    }
    if (existingJob.status === 'cancelled' || existingJob.status === 'failed') {
      return jsonResponse({ error: existingJob.error_message || 'Proses ini sudah dihentikan.' }, 409);
    }
    filename = existingJob.filename || filename;
    mimeType = existingJob.mime_type || mimeType;
    chargedAmount = Number(existingJob.credits_charged || 0);
  }

  const failAndRefund = async (message, status = 500) => {
    if (existingJob?.id) {
      let refunded = Number(existingJob.credits_refunded || 0);
      if (chargedAmount > 0 && refunded === 0) {
        const didRefund = await refundMetadataCredits(
          env,
          creditRpc,
          user.id,
          chargedAmount,
          existingJob.id,
          `Refund: gagal membersihkan metadata (${filename.slice(0, 100)})`,
        );
        if (didRefund) refunded = chargedAmount;
      }
      await patchMetadataJob(servicePostgrest, env, existingJob.id, {
        status: 'failed',
        progress: 0,
        credits_refunded: refunded,
        error_message: String(message || 'Gagal membersihkan metadata').slice(0, 300),
      });
    }
    return jsonResponse({ error: message }, status);
  };

  try {
    if (!inputBytes && storagePath) {
      if (!isSafeUserStoragePath(user.id, storagePath)) {
        return await failAndRefund('Path file unggahan tidak valid.', 403);
      }
      const dlRes = await storageRequest(env, 'GET', storagePath);
      if (!dlRes.ok) {
        return await failAndRefund('Gagal mengunduh file sementara dari penyimpanan.', 502);
      }
      inputBytes = new Uint8Array(await dlRes.arrayBuffer());
    }

    if (!inputBytes || inputBytes.length === 0) {
      return await failAndRefund('File media wajib disertakan untuk dibersihkan.', 400);
    }
    if (inputBytes.length > METADATA_MAX_FILE_BYTES) {
      return await failAndRefund(`Ukuran file melebihi batas ${Math.round(METADATA_MAX_FILE_BYTES / (1024 * 1024))} MB.`, 400);
    }

    const detected = detectMediaFormat(inputBytes, { fileName: filename, mimeType });
    if (detected.format === 'unsupported') {
      return await failAndRefund('Format file tidak didukung. Gunakan PNG, JPG/JPEG, WebP, GIF, MP4, MOV, atau WebM.', 400);
    }

    // Create & charge job now if caller hit /api/metadata/process directly without /start
    if (!existingJob) {
      const scanBefore = compactScanSummary(await scanMediaMetadata(inputBytes, { fileName: filename, mimeType: detected.mimeType }));
      const newId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      const ins = await servicePostgrest(env, '/metadata_jobs', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: [{
          id: newId,
          user_id: user.id,
          media_kind: detected.mediaKind,
          filename,
          mime_type: detected.mimeType,
          original_size: inputBytes.length,
          cleaned_size: 0,
          status: 'processing',
          progress: 25,
          ai_detected: Boolean(scanBefore.aiDetected),
          detected_tools: scanBefore.detectedTools || [],
          scan_before: scanBefore,
          scan_after: {},
          removed_count: 0,
          credits_charged: 0,
          credits_refunded: 0,
          created_at: nowIso,
          updated_at: nowIso,
        }],
      });
      if (!ins?.ok) {
        return jsonResponse({ error: 'Gagal membuat catatan pembersihan metadata.' }, 500);
      }
      const rows = await ins.json().catch(() => []);
      existingJob = rows?.[0];
      const spent = await creditRpc(env, 'spend_credits', {
        p_user_id: user.id,
        p_amount: METADATA_SERVICE_COST,
        p_description: `Hapus metadata AI (${filename.slice(0, 120)})`,
        p_generation_id: newId,
      });
      if (!spent) {
        await servicePostgrest(env, `/metadata_jobs?id=eq.${encodeURIComponent(newId)}`, { method: 'DELETE' }).catch(() => {});
        return jsonResponse({
          error: `Saldo kredit BLEA Anda tidak cukup. Biaya pembersihan metadata adalah ${METADATA_SERVICE_COST} kredit.`,
          code: 'insufficient_credits',
          required: METADATA_SERVICE_COST,
        }, 402);
      }
      chargedAmount = METADATA_SERVICE_COST;
      existingJob = await patchMetadataJob(servicePostgrest, env, newId, {
        credits_charged: METADATA_SERVICE_COST,
        progress: 45,
      }) || { ...existingJob, credits_charged: METADATA_SERVICE_COST };
    } else {
      await patchMetadataJob(servicePostgrest, env, existingJob.id, { progress: 50 });
    }

    const stripped = await stripMediaMetadata(inputBytes, { fileName: filename, mimeType: detected.mimeType });

    await patchMetadataJob(servicePostgrest, env, existingJob.id, { progress: 80 });

    const cleanName = sanitizeCleanFilename(filename, stripped.ext, existingJob.id);
    const cleanedPath = `${user.id}/metadata-clean/${existingJob.id}/${cleanName}`;
    const upRes = await storageRequest(env, 'POST', cleanedPath, {
      body: stripped.cleanedBytes,
      headers: {
        'content-type': stripped.mimeType || 'application/octet-stream',
        'x-upsert': 'true',
      },
    });
    if (!upRes.ok) {
      const upErr = await upRes.text().catch(() => '');
      return await failAndRefund(`Gagal menyimpan file hasil bersih (${upRes.status}). ${upErr.slice(0, 120)}`, 502);
    }

    if (storagePath && isSafeUserStoragePath(user.id, storagePath)) {
      await storageRequest(env, 'DELETE', storagePath).catch(() => {});
    }

    const beforeSummary = compactScanSummary(stripped.before);
    const afterSummary = compactScanSummary(stripped.after);
    const doneRow = await patchMetadataJob(servicePostgrest, env, existingJob.id, {
      media_kind: stripped.mediaKind,
      mime_type: stripped.mimeType,
      original_size: stripped.originalSize,
      cleaned_size: stripped.cleanedSize,
      status: 'completed',
      progress: 100,
      ai_detected: Boolean(beforeSummary.aiDetected),
      detected_tools: beforeSummary.detectedTools || [],
      scan_before: beforeSummary,
      scan_after: afterSummary,
      removed_count: stripped.removedCount,
      cleaned_path: cleanedPath,
      error_message: null,
    });

    const sanitized = await sanitizeMetadataJobRow(doneRow || {
      ...existingJob,
      media_kind: stripped.mediaKind,
      mime_type: stripped.mimeType,
      original_size: stripped.originalSize,
      cleaned_size: stripped.cleanedSize,
      status: 'completed',
      progress: 100,
      ai_detected: Boolean(beforeSummary.aiDetected),
      detected_tools: beforeSummary.detectedTools || [],
      scan_before: beforeSummary,
      scan_after: afterSummary,
      removed_count: stripped.removedCount,
      cleaned_path: cleanedPath,
    }, env);

    return jsonResponse({
      ok: true,
      job: sanitized,
      removedCount: stripped.removedCount,
      before: stripped.before,
      after: stripped.after,
    });
  } catch (err) {
    return await failAndRefund(String(err?.message || err || 'Gagal memproses metadata.'), 500);
  }
}

export async function handleMetadataHistory({ request, env, user, jsonResponse, servicePostgrest }) {
  if (!user) return jsonResponse({ error: 'Login diperlukan.' }, 401);
  const body = await request.json().catch(() => ({}));
  const offset = Math.max(0, Number(body?.offset || 0) || 0);
  const limit = 20;
  const res = await servicePostgrest(
    env,
    `/metadata_jobs?select=*&user_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc&offset=${offset}&limit=${limit + 1}`,
  );
  if (!res?.ok) {
    return jsonResponse({ error: 'Gagal memuat riwayat cek metadata.' }, 500);
  }
  const rows = await res.json().catch(() => []);
  const hasMore = Array.isArray(rows) && rows.length > limit;
  const slice = Array.isArray(rows) ? rows.slice(0, limit) : [];
  const jobs = await Promise.all(slice.map((row) => sanitizeMetadataJobRow(row, env)));
  return jsonResponse({ ok: true, jobs, hasMore });
}

export async function handleMetadataStatus({ request, env, user, jsonResponse, servicePostgrest }) {
  if (!user) return jsonResponse({ error: 'Login diperlukan.' }, 401);
  const body = await request.json().catch(() => ({}));
  const id = String(body?.id || '').trim();
  if (!UUID_RE.test(id)) return jsonResponse({ error: 'ID metadata tidak valid.' }, 400);
  const res = await servicePostgrest(env, `/metadata_jobs?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
  const rows = res?.ok ? await res.json().catch(() => []) : [];
  const row = rows?.[0];
  if (!row) return jsonResponse({ error: 'Riwayat metadata tidak ditemukan.' }, 404);
  if (row.user_id !== user.id && user?.app_metadata?.role !== 'admin') {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }
  return jsonResponse({ ok: true, job: await sanitizeMetadataJobRow(row, env) });
}

export async function handleMetadataContent({ request, url, env, path, getUser, jsonResponse, servicePostgrest }) {
  const id = decodeURIComponent(path.slice('metadata/content/'.length));
  if (!UUID_RE.test(id)) return jsonResponse({ error: 'Missing or invalid metadata job id' }, 400);

  const exp = url.searchParams.get('exp');
  const sig = url.searchParams.get('sig');
  const sigOk = await verifyMetadataContentSig(id, exp, sig, env);
  let user = null;
  if (!sigOk) {
    const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    user = bearer ? await getUser(env, bearer) : null;
    if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const rowRes = await servicePostgrest(env, `/metadata_jobs?select=id,user_id,filename,mime_type,cleaned_path,status&id=eq.${encodeURIComponent(id)}&limit=1`);
  const rows = rowRes?.ok ? await rowRes.json().catch(() => []) : [];
  const row = rows?.[0];
  if (!row || !row.cleaned_path) return jsonResponse({ error: 'Cleaned media not found' }, 404);
  if (!sigOk && row.user_id !== user.id && user?.app_metadata?.role !== 'admin') {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }

  const storageRes = await storageRequest(env, 'GET', row.cleaned_path);
  if (!storageRes.ok) {
    return jsonResponse({ error: 'Gagal mengambil file bersih dari penyimpanan.' }, 502);
  }

  const wantDownload = url.searchParams.get('download') === '1';
  const ext = row.mime_type === 'video/webm' ? 'webm'
    : row.mime_type === 'video/quicktime' ? 'mov'
      : row.mime_type?.startsWith('video/') ? 'mp4'
        : row.mime_type === 'image/jpeg' ? 'jpg'
          : row.mime_type === 'image/webp' ? 'webp'
            : row.mime_type === 'image/gif' ? 'gif'
              : 'png';
  const attachmentName = sanitizeCleanFilename(row.filename, ext, row.id);
  const headers = new Headers();
  headers.set('content-type', row.mime_type || storageRes.headers.get('content-type') || 'application/octet-stream');
  const len = storageRes.headers.get('content-length');
  if (len) headers.set('content-length', len);
  headers.set('content-disposition', `${wantDownload ? 'attachment' : 'inline'}; filename="${attachmentName}"`);
  headers.set('cache-control', 'private, no-store');
  headers.set('x-content-type-options', 'nosniff');

  return new Response(request.method === 'HEAD' ? null : storageRes.body, {
    status: 200,
    headers,
  });
}
