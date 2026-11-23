// /api/agent — one agent turn: model call → tool call → tool result → final
// answer, streamed as SSE.
//
// Server-side instead of a browser loop (which is how /studio works) because:
// the provider key stays in the Worker, the tool loop cannot be driven by
// tampered client code, and search / URL fetching happen inside the same trust
// boundary as /api/search.
//
// The browser never receives the tool loop's internals other than the events
// below; `done.reply` is the only text that becomes the assistant message.
//
// Events (consumed by src/agent/agentClient.js):
//   {type:'meta',     model, provider, skills?, fallback?, credits?, attachments?}
//   {type:'step',     index, label, status:'start'|'done'|'error', detail, progress?}
//   {type:'skill',    id, resource, source}
//   {type:'clips',    clips, sourceUrl, durationSec}   // rencana klip, menunggu konfirmasi
//   {type:'delta',    text}
//   {type:'done',     ok, reply, actions, skills, stopReason, model, provider}
//   {type:'error',    error, code}

export const MAX_TOOL_ROUNDS = 3;

function encodeSse(event) {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

function sameOriginRequest(request, url) {
  const origin = request.headers.get('origin');
  return !origin || origin === url.origin;
}

function isRateLimited(attempt) {
  return !attempt.ok && [429, 502, 503, 504].includes(attempt.status);
}

/**
 * @param {object} deps Worker helpers, injected so this module can be tested
 *   without Workers globals: getUser, servicePostgrest, webSearch,
 *   sendChatCompletionRequest, chatUpstreamTimeoutMs, buildFallbackCandidates,
 *   hasWorkersAiBinding, buildSystemPrompt, availableSkillIds,
 *   loadSkillSection, runTool, extractAssistantReply, parseAgentToolCall,
 *   findTool, availableToolNames, describeToolCall, summarizeToolResult,
 *   normalizeAgentAttachments, buildAttachmentContent.
 */
export async function handleAgentTurn(request, url, env, deps) {
  if (!sameOriginRequest(request, url)) {
    return Response.json({ error: 'Origin tidak diizinkan' }, { status: 403 });
  }

  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!token) return Response.json({ error: 'Login diperlukan' }, { status: 401 });
  const user = await deps.getUser(env, token);
  if (!user) return Response.json({ error: 'Token tidak sah' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((message) => message && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string' && message.content.trim())
    .slice(-24)
    .map((message) => ({ role: message.role, content: message.content.slice(0, 12_000) }));
  if (!messages.length) return Response.json({ error: 'Pesan kosong' }, { status: 400 });

  // Lampiran: klien sudah memvalidasi 100MB, tetapi klien bisa dimanipulasi.
  // Yang diperiksa di sini hanya batas jumlah dan keaslian URL (bucket BLEA,
  // milik user ini) — Worker tidak bisa memeriksa ukuran byte tanpa mengunduh.
  const attachments = deps.normalizeAgentAttachments(body.attachments, user.id);
  if (attachments.error) return Response.json({ error: attachments.error }, { status: 400 });

  const provider = String(body.provider || 'unorouter').trim().toLowerCase();
  const requestedModel = String(body.model || '').trim();
  if (!requestedModel) return Response.json({ error: 'Model belum dipilih' }, { status: 400 });

  const pinnedSkill = String(body.skill || '').trim();
  const pinnedResource = String(body.resource || '').trim();
  const blueprint = typeof body.blueprint === 'string' ? body.blueprint.slice(0, 4_000) : '';
  // Digest analisis video dari browser (lihat src/lib/videoAnalysis.js). Ini
  // data yang dikirim klien, jadi diperlakukan sebagai input tak tepercaya:
  // hanya dipakai sebagai konteks teks, tidak pernah sebagai perintah.
  const videoAnalysis = deps.normalizeVideoAnalysis(body.videoAnalysis);

  // Provider credentials, resolved once (failover may swap the model, never the
  // provider list).
  const keyByProvider = new Map();
  const keyRes = await deps.servicePostgrest(env, '/provider_api_keys?select=provider,api_key,base_url');
  for (const row of (await keyRes.json().catch(() => [])) || []) {
    keyByProvider.set(String(row.provider || 'unorouter').toLowerCase(), row);
  }
  const keyRow = keyByProvider.get(provider);
  let apiKey = keyRow?.api_key || (provider === 'unorouter' && requestedModel.endsWith(':free') ? 'use-free' : '');
  if (provider === 'cloudflare' && !apiKey && deps.hasWorkersAiBinding(env)) apiKey = 'binding:AI';
  if (!apiKey) return Response.json({ error: `API key untuk provider "${provider}" belum dikonfigurasi.` }, { status: 400 });

  // Only a page-pinned skill loads up front; everything else arrives through
  // `load_skill` inside the loop, so a false keyword match never burns context.
  const loadedSkills = [];
  let pinnedSection = '';
  if (pinnedSkill && deps.availableSkillIds.includes(pinnedSkill)) {
    try {
      pinnedSection = await deps.loadSkillSection(pinnedSkill, { resourceId: pinnedResource });
      loadedSkills.push(pinnedSkill);
    } catch (error) {
      pinnedSection = '';
      console.warn('agent: pinned skill gagal dimuat', String(error));
    }
  }

  // Harga per giliran (opsional). Modalitas `agent_turn` sengaja terpisah dari
  // `text` supaya admin bisa memberi harga untuk agen tanpa mengubah harga
  // chat. Tanpa baris harga, agen gratis seperti /api/chat.
  const turnPriceRes = await deps.servicePostgrest(
    env,
    `/credit_model_prices?provider=eq.${encodeURIComponent(provider)}&model=eq.${encodeURIComponent(requestedModel)}&modality=eq.agent_turn&active=eq.true&select=credits&limit=1`,
  ).catch(() => null);
  const turnPriceRows = turnPriceRes?.ok ? await turnPriceRes.json().catch(() => []) : [];
  const turnPrice = Number(turnPriceRows?.[0]?.credits) || 0;

  let charged = 0;
  let chargeId = '';
  if (turnPrice > 0) {
    // Ditagih sebelum panggilan model pertama: lebih baik menolak giliran
    // daripada menanggung biaya provider tanpa saldo.
    chargeId = crypto.randomUUID();
    const paid = await deps.chargeCredits(env, user.id, turnPrice, `Agen · ${requestedModel}`, chargeId);
    if (!paid) {
      return Response.json(
        { error: `Saldo kredit tidak cukup untuk giliran agen ini (${turnPrice} kredit). Isi kredit di halaman Kredit.`, code: 'insufficient_credits', credits: turnPrice },
        { status: 402 },
      );
    }
    charged = turnPrice;
  }
  const refundTurn = async () => {
    if (charged > 0) await deps.refundCredits(env, user.id, charged, chargeId, 'Refund agen: giliran gagal');
  };

  // Lampiran hanya menempel pada pesan pengguna terakhir: mengulanginya di
  // setiap giliran akan menggandakan biaya token untuk gambar yang sama.
  const withAttachments = attachments.items.length
    ? messages.map((message, index) => (
      index === messages.length - 1 && message.role === 'user'
        ? { role: 'user', content: deps.buildAttachmentContent(message.content, attachments.items) }
        : message
    ))
    : messages;

  const turnMessages = [
    {
      role: 'system',
      content: deps.buildSystemPrompt({
        skillIds: deps.availableSkillIds,
        workspace: { blueprint, videoAnalysis: videoAnalysis.text },
        pinnedSection,
      }),
    },
    ...withAttachments,
  ];

  let activeModel = requestedModel;
  let activeProvider = provider;
  let activeApiKey = apiKey;
  let activeBaseUrl = keyRow?.base_url || '';

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event) => controller.enqueue(encodeSse(event));
      const actions = [];
      let finalReply = '';
      let stopReason = 'final';

      try {
        emit({
          type: 'meta',
          model: activeModel,
          provider: activeProvider,
          credits: charged,
          attachments: attachments.items.map((item) => ({ name: item.name, kind: item.kind })),
        });
        if (pinnedSection) emit({ type: 'skill', id: pinnedSkill, resource: pinnedResource, source: 'anthropics/skills' });

        for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
          const readLabel = round === 0 ? 'Membaca permintaan' : 'Menilai hasil alat';
          emit({ type: 'step', index: round, label: readLabel, status: 'start' });

          // A tool turn makes up to four upstream calls; without this the page
          // looks frozen for 10–30 s between steps. Best-effort and unawaited so
          // a closed stream can never reject the turn.
          const ticker = setInterval(() => {
            try {
              emit({ type: 'step', index: round, label: readLabel, status: 'start', progress: true });
            } catch { /* stream sudah ditutup */ }
          }, 2_500);

          let attempt = await deps.sendChatCompletionRequest({
            provider: activeProvider,
            model: activeModel,
            apiKey: activeApiKey,
            baseUrl: activeBaseUrl,
            payload: { model: activeModel, messages: turnMessages, stream: false },
            timeoutMs: deps.chatUpstreamTimeoutMs(activeProvider),
            env,
          }).finally(() => clearInterval(ticker));

          if (isRateLimited(attempt)) {
            const alt = deps.buildFallbackCandidates({
              primaryProvider: activeProvider,
              primaryModel: activeModel,
              keyByProvider,
              env,
            })[0];
            if (alt) {
              const retry = await deps.sendChatCompletionRequest({
                provider: alt.provider,
                model: alt.model,
                apiKey: alt.apiKey,
                baseUrl: alt.baseUrl,
                payload: { model: alt.model, messages: turnMessages, stream: false },
                timeoutMs: deps.chatUpstreamTimeoutMs(alt.provider),
                env,
              });
              if (retry.ok) {
                attempt = retry;
                activeProvider = alt.provider;
                activeModel = alt.model;
                activeApiKey = alt.apiKey;
                activeBaseUrl = alt.baseUrl;
                emit({ type: 'meta', model: activeModel, provider: activeProvider, fallback: true });
              }
            }
          }

          if (!attempt.ok) {
            const info = attempt.errorInfo || {};
            emit({ type: 'step', index: round, label: readLabel, status: 'error' });
            emit({
              type: 'error',
              error: info.friendlyMessage || 'Model tidak bisa dihubungi.',
              code: info.code || `http_${attempt.status || 0}`,
            });
            await refundTurn();
            return;
          }
          emit({ type: 'step', index: round, label: readLabel, status: 'done' });

          const reply = deps.extractAssistantReply(attempt.data) || '';
          const call = deps.parseAgentToolCall(reply);

          if (!call) {
            finalReply = reply.trim();
            stopReason = finalReply ? 'final' : 'empty_reply';
            break;
          }

          if (call.error) {
            turnMessages.push({ role: 'assistant', content: reply });
            turnMessages.push({
              role: 'user',
              content: `Sistem: panggilan alat ditolak (${call.error}). Tulis ulang sebagai JSON yang sah atau jawab tanpa alat.`,
            });
            continue;
          }

          const tool = deps.findTool(call.name);
          if (!tool) {
            actions.push({ tool: call.name, ok: false, summary: 'alat tidak dikenal' });
            turnMessages.push({ role: 'assistant', content: reply });
            turnMessages.push({
              role: 'user',
              content: `Sistem: alat "${call.name}" tidak ada. Alat yang tersedia: ${deps.availableToolNames.join(', ')}.`,
            });
            continue;
          }

          const detail = deps.describeToolCall(call.name, call.arguments);
          emit({ type: 'step', index: round, label: `Menjalankan ${call.name}`, status: 'start', detail });

          const result = await deps.runTool(tool, call.arguments, {
            search: deps.webSearch,
            loadSkillSection: deps.loadSkillSection,
            availableSkillIds: deps.availableSkillIds,
            fetchImpl: deps.fetchImpl || fetch,
          });
          const ok = !String(result).startsWith('Alat gagal');
          const summary = deps.summarizeToolResult(call.name, result, call.arguments);
          actions.push({ tool: call.name, ok, summary });
          emit({ type: 'step', index: round, label: `Menjalankan ${call.name}`, status: ok ? 'done' : 'error', detail: summary });

          if (call.name === 'propose_clips' && ok) {
            const proposal = deps.normalizeClipProposal(call.arguments, { durationSec: videoAnalysis.durationSec });
            if (!proposal.error) {
              emit({
                type: 'clips',
                clips: proposal.clips,
                durationSec: videoAnalysis.durationSec,
                sourceUrl: attachments.items.find((item) => item.kind === 'video')?.url || '',
              });
            }
          }

          if (call.name === 'load_skill' && ok) {
            const skillId = String(call.arguments.skill || '');
            if (!loadedSkills.includes(skillId)) {
              loadedSkills.push(skillId);
              emit({ type: 'skill', id: skillId, resource: String(call.arguments.resource || ''), source: 'anthropics/skills' });
            }
          }

          turnMessages.push({ role: 'assistant', content: reply });
          turnMessages.push({
            role: 'user',
            content: `Hasil alat ${call.name}:\n${result}\n\nLanjutkan tugas. Jika sudah cukup, jawab pengguna secara final tanpa blok \`tool\`.`,
          });
        }

        if (!finalReply) {
          // Tidak ada jawaban model yang bisa dipakai: jangan tagih giliran.
          await refundTurn();
          charged = 0;
          stopReason = 'tool_budget';
          finalReply = 'Batas alat untuk giliran ini sudah habis dan jawaban final belum terbentuk. Lihat panel langkah untuk hasil alat terakhir, lalu persempit permintaan.';
        }

        emit({ type: 'delta', text: finalReply });
        emit({
          type: 'done',
          ok: true,
          reply: finalReply,
          actions,
          skills: loadedSkills,
          stopReason,
          model: activeModel,
          provider: activeProvider,
          credits: charged,
        });
      } catch (error) {
        await refundTurn();
        emit({ type: 'error', error: String(error?.message || error).slice(0, 400), code: 'agent_failed' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
