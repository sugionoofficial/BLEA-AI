export const LIVE_RECENT_COMPLETED_MS = 12_000;
export const LIVE_FINISH_HOLD_MS = 5_000;

export function maskEmailAfter4(email) {
  const raw = String(email || '').trim();
  if (!raw) return '';
  const atIdx = raw.indexOf('@');
  if (atIdx <= 0) {
    const keep = raw.length > 4 ? 4 : Math.max(1, raw.length - 1);
    return `${raw.slice(0, keep)}****`;
  }
  const local = raw.slice(0, atIdx);
  const domain = raw.slice(atIdx + 1);
  const keep = local.length > 4 ? 4 : Math.max(1, local.length - 1);
  const maskedLocal = `${local.slice(0, keep)}****`;
  return domain ? `${maskedLocal}@${domain}` : maskedLocal;
}

export function resolveOwnerName(profile, email, { isOwn = false, viewerName = '' } = {}) {
  const fromProfile = String(profile?.full_name || '').trim();
  if (fromProfile) return fromProfile.slice(0, 80);
  const fromViewer = isOwn ? String(viewerName || '').trim() : '';
  if (fromViewer) return fromViewer.slice(0, 80);
  const rawEmail = String(email || '').trim();
  const atIdx = rawEmail.indexOf('@');
  if (atIdx > 0) {
    const local = rawEmail.slice(0, atIdx);
    const keep = local.length > 4 ? 4 : Math.max(1, local.length - 1);
    return `${local.slice(0, keep)}****`;
  }
  return 'Pengguna BLEA';
}

export function diagnosePendingGeneration(kind, row, nowMs = Date.now()) {
  if (['completed', 'failed', 'cancelled', 'expired'].includes(row?.status)) {
    return null;
  }
  const createdMs = Date.parse(row?.created_at || '') || nowMs;
  const updatedMs = Date.parse(row?.updated_at || row?.created_at || '') || createdMs;
  const ageMs = Math.max(0, nowMs - createdMs);
  const staleMs = Math.max(0, nowMs - updatedMs);
  if (kind === 'image') {
    if (row?.status === 'unknown') {
      return 'Status pengiriman tidak pasti (timeout/respons provider kosong). Admin dapat membatalkan & refund jika tidak selesai.';
    }
    if (!row?.external_job_id) {
      return 'Task ID upstream belum tersimpan (gagal sinkronisasi awal); proses ini menggantung dan tidak bisa polling otomatis.';
    }
    if (ageMs > 3 * 60_000) {
      return 'Proses gambar berlangsung lebih lama dari estimasi normal (>3 menit).';
    }
    return null;
  }
  const agentStatus = row?.metadata?.agent_status;
  if (row?.provider === 'freebeat' && agentStatus === 'action_required') {
    return 'Agen Freebeat menunggu konfirmasi lanjutan; sistem mengirim nudge otomatis berkala atau admin dapat membatalkan.';
  }
  if (row?.provider === 'freebeat' && Number(row?.progress || 0) >= 90 && staleMs > 5 * 60_000) {
    return 'Antrean Freebeat Music-to-Dance di tahap akhir (90%) tanpa pembaruan >5 menit (estimasi normal 15–60 menit, atau macet di sisi Freebeat).';
  }
  if (!row?.external_job_id && !(row?.provider === 'freebeat' && row?.metadata?.preparing_music_id) && !row?.polling_url) {
    return 'Task ID upstream belum tersimpan.';
  }
  if (staleMs > 5 * 60_000 && ageMs > 5 * 60_000) {
    return 'Belum ada pembaruan status dalam >5 menit terakhir.';
  }
  return null;
}

export function computeLiveProgress(item, nowMs = Date.now()) {
  if (!item) return 0;
  if (item.status === 'completed') return 100;
  if (['cancelled', 'failed', 'expired'].includes(item.status)) return 0;
  if (item.kind === 'video') {
    const raw = Math.max(0, Math.min(99, Number(item.progress || 0)));
    if (raw > 0) return raw;
    return item.status === 'in_progress' ? 8 : 2;
  }
  if (item.status === 'unknown' || !item.has_external_job) return 3;
  if (item.status === 'queued') return 5;
  const createdMs = Date.parse(item.created_at || '') || nowMs;
  const elapsedMs = Math.max(0, nowMs - createdMs);
  const estimated = 15 + Math.round(77 * (1 - Math.exp(-elapsedMs / 18_000)));
  return Math.max(15, Math.min(92, estimated));
}

export function getRaceTier(item) {
  if (!item) return 0;
  if (item.status === 'completed') return 3;
  if (!item.stalled && ['in_progress', 'processing'].includes(item.status)) return 2;
  if (!item.stalled && item.status === 'queued') return 1;
  return 0;
}

export function compareRaceItems(a, b, nowMs = Date.now()) {
  const tierDiff = getRaceTier(b) - getRaceTier(a);
  if (tierDiff !== 0) return tierDiff;

  if (a.status === 'completed' && b.status === 'completed') {
    const aDone = Date.parse(a.completed_at || a.updated_at || '') || 0;
    const bDone = Date.parse(b.completed_at || b.updated_at || '') || 0;
    if (bDone !== aDone) return bDone - aDone;
  }

  const progDiff = computeLiveProgress(b, nowMs) - computeLiveProgress(a, nowMs);
  if (progDiff !== 0) return progDiff;

  const bUpdated = Date.parse(b.updated_at || b.created_at || '') || 0;
  const aUpdated = Date.parse(a.updated_at || a.created_at || '') || 0;
  if (bUpdated !== aUpdated) return bUpdated - aUpdated;

  const aCreated = Date.parse(a.created_at || '') || 0;
  const bCreated = Date.parse(b.created_at || '') || 0;
  return aCreated - bCreated;
}

export function reconcileRaceEntries({
  holdMap = new Map(),
  dismissedSet = new Set(),
  incomingItems = [],
  nowMs = Date.now(),
  holdMs = LIVE_FINISH_HOLD_MS,
} = {}) {
  const nextHoldMap = new Map(holdMap);
  const nextDismissed = new Set(dismissedSet);

  for (const [key, entry] of nextHoldMap.entries()) {
    if (nowMs >= entry.expiresAt) {
      nextHoldMap.delete(key);
      nextDismissed.add(key);
    }
  }

  const activeItems = [];
  const activeKeys = new Set();

  for (const item of incomingItems || []) {
    const key = `${item.kind}:${item.id}`;
    if (item.status === 'completed') {
      if (nextDismissed.has(key)) continue;
      const existing = nextHoldMap.get(key);
      if (existing) {
        if (nowMs >= existing.expiresAt) {
          nextHoldMap.delete(key);
          nextDismissed.add(key);
          continue;
        }
        nextHoldMap.set(key, { ...existing, item });
      } else {
        nextHoldMap.set(key, {
          item,
          firstSeenAt: nowMs,
          expiresAt: nowMs + holdMs,
        });
      }
      continue;
    }

    if (['queued', 'in_progress', 'processing', 'unknown'].includes(item.status)) {
      if (!activeKeys.has(key)) {
        activeKeys.add(key);
        activeItems.push(item);
      }
    }
  }

  const heldCompletedItems = [];
  for (const [key, entry] of nextHoldMap.entries()) {
    if (nowMs >= entry.expiresAt) {
      nextHoldMap.delete(key);
      nextDismissed.add(key);
      continue;
    }
    if (!activeKeys.has(key)) {
      heldCompletedItems.push({
        ...entry.item,
        finish_first_seen_at: entry.firstSeenAt,
        finish_expires_at: entry.expiresAt,
        finish_remaining_ms: Math.max(0, entry.expiresAt - nowMs),
      });
    }
  }

  const combined = [...heldCompletedItems, ...activeItems].sort((a, b) => compareRaceItems(a, b, nowMs));
  return {
    items: combined,
    holdMap: nextHoldMap,
    dismissedSet: nextDismissed,
    activeCount: activeItems.length,
    completedHoldCount: heldCompletedItems.length,
  };
}

export function formatLiveQueueItem(
  row,
  kind,
  { isAdmin = false, viewerId = '', viewerName = '', emailMap = null, profileMap = null, nowMs = Date.now() } = {},
) {
  const isCompleted = row?.status === 'completed';
  const isOwn = Boolean(viewerId && row?.user_id === viewerId);
  const diagnostic = diagnosePendingGeneration(kind, row, nowMs);
  const canPoll = !isCompleted && (kind === 'image'
    ? Boolean(row?.external_job_id && ['queued', 'processing'].includes(row?.status))
    : Boolean(
        ['queued', 'in_progress'].includes(row?.status)
        && (row?.external_job_id || row?.polling_url || (row?.provider === 'freebeat' && row?.metadata?.preparing_music_id)),
      ));
  const profile = profileMap?.get(row.user_id) || null;
  const rawEmail = profile?.email ?? emailMap?.get(row.user_id) ?? null;
  const ownerName = resolveOwnerName(profile, rawEmail, { isOwn, viewerName });
  const ownerEmailMasked = rawEmail ? maskEmailAfter4(rawEmail) : null;

  const item = {
    id: row.id,
    kind,
    provider: row.provider,
    model: row.model,
    status: row.status,
    progress: isCompleted ? 100 : (kind === 'video' ? Number(row.progress || 0) : null),
    credits_charged: Number(row.credits_charged || 0),
    created_at: row.created_at,
    updated_at: row.updated_at || row.created_at,
    ...(isCompleted ? { completed_at: row.updated_at || new Date(nowMs).toISOString() } : {}),
    is_own: isOwn,
    owner_name: ownerName,
    owner_email_masked: ownerEmailMasked,
    has_external_job: Boolean(row?.external_job_id),
    can_poll: canPoll,
    stalled: Boolean(diagnostic),
    diagnostic,
  };
  if (isOwn || isAdmin) {
    item.prompt = String(row.prompt || '').slice(0, 400);
    item.aspect_ratio = row.aspect_ratio || null;
    item.resolution = row.resolution || null;
    item.duration = row.duration ?? null;
    item.error_message = row.error_message || null;
    item.credits_refunded = Number(row.credits_refunded || 0);
  }
  if (isAdmin) {
    item.user_id = row.user_id;
    item.user_email = rawEmail;
    item.external_job_id = row.external_job_id || null;
    item.agent_status = row?.metadata?.agent_status || null;
    item.can_cancel = !isCompleted;
  }
  return item;
}

export async function patchImageGeneration(env, rowId, patch, postgrestFn) {
  const doPatch = postgrestFn || ((path, opts) => fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method: opts?.method || 'PATCH',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      ...(opts?.headers || {}),
    },
    body: JSON.stringify(opts?.body),
    signal: AbortSignal.timeout(15_000),
  }));
  const res = await doPatch(`/image_generations?id=eq.${encodeURIComponent(rowId)}`, {
    method: 'PATCH',
    body: patch,
  }).catch(() => null);
  if (res?.ok) return true;
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'provider_key_id')) {
    const fallbackPatch = { ...patch };
    delete fallbackPatch.provider_key_id;
    const retryRes = await doPatch(`/image_generations?id=eq.${encodeURIComponent(rowId)}`, {
      method: 'PATCH',
      body: fallbackPatch,
    }).catch(() => null);
    return Boolean(retryRes?.ok);
  }
  return false;
}
