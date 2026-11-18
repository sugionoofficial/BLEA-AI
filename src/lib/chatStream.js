export function splitThinkingContent(rawText) {
  const text = String(rawText || '');
  if (!text) return { thinking: '', answer: '', isThinkingOpen: false };

  const thinkingParts = [];
  let cursor = 0;
  const answerParts = [];
  let isThinkingOpen = false;

  while (cursor < text.length) {
    const openIdx = text.indexOf('<think>', cursor);
    if (openIdx === -1) {
      answerParts.push(text.slice(cursor));
      break;
    }
    if (openIdx > cursor) {
      answerParts.push(text.slice(cursor, openIdx));
    }
    const contentStart = openIdx + 7;
    const closeIdx = text.indexOf('</think>', contentStart);
    if (closeIdx === -1) {
      thinkingParts.push(text.slice(contentStart));
      isThinkingOpen = true;
      break;
    }
    thinkingParts.push(text.slice(contentStart, closeIdx));
    cursor = closeIdx + 8;
  }

  return {
    thinking: thinkingParts.join('\n').trim(),
    answer: answerParts.join('').replace(/^\s+/, ''),
    isThinkingOpen,
  };
}

export function parseUpstreamSsePayload(data) {
  if (!data || typeof data !== 'object') return { contentDelta: '', reasoningDelta: '' };

  let contentDelta = '';
  let reasoningDelta = '';

  const choice = data?.choices?.[0];
  const delta = choice?.delta || choice?.message;
  if (delta) {
    if (typeof delta.content === 'string') {
      contentDelta += delta.content;
    } else if (Array.isArray(delta.content)) {
      contentDelta += delta.content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
    }
    if (typeof delta.reasoning_content === 'string') {
      reasoningDelta += delta.reasoning_content;
    } else if (typeof delta.reasoning === 'string') {
      reasoningDelta += delta.reasoning;
    }
  } else if (typeof data.response === 'string') {
    contentDelta += data.response;
  } else if (typeof data.result?.response === 'string') {
    contentDelta += data.result.response;
  } else if (data.delta !== undefined) {
    const deltaText = typeof data.delta === 'string'
      ? data.delta
      : (typeof data.delta?.text === 'string' ? data.delta.text : '');
    if (deltaText) {
      if (/reasoning|thinking/i.test(String(data.type || ''))) {
        reasoningDelta += deltaText;
      } else {
        contentDelta += deltaText;
      }
    }
  }

  if (typeof data.reasoning_content === 'string' && !delta?.reasoning_content) {
    reasoningDelta += data.reasoning_content;
  }

  return { contentDelta, reasoningDelta };
}

export function parseSearchRequests(text) {
  const queries = [];
  const seen = new Set();
  const re = /```search\s*([\s\S]*?)```/gi;
  let match;
  while ((match = re.exec(String(text || ''))) !== null) {
    const rawInner = String(match[1] || '').trim();
    if (!rawInner) continue;
    let query = '';
    try {
      const parsed = JSON.parse(rawInner);
      query = String(parsed?.query || parsed?.q || '').trim();
    } catch {
      query = rawInner.replace(/^query\s*:\s*/i, '').replace(/^["']|["']$/g, '').trim();
    }
    const key = query.toLowerCase();
    if (query && !seen.has(key)) {
      seen.add(key);
      queries.push(query);
    }
  }
  return queries;
}

export function stripSearchBlocks(text) {
  return String(text || '')
    .replace(/```search\s*[\s\S]*?```/gi, '')
    .trim();
}

export function isUncertainReply(text) {
  const clean = stripSearchBlocks(splitThinkingContent(text).answer || text).trim();
  if (!clean) return true;
  if (clean.length > 650) return false;
  return /\b(maaf[, ]+)?(saya |aku )?(tidak tahu|belum tahu|kurang tahu|tidak memiliki informasi|tidak mempunyai informasi|tidak punya informasi|tidak dapat menemukan|tidak menemukan jawaban|tidak dapat memastikan|tidak bisa memastikan|tidak yakin|kurang yakin|keterbatasan pengetahuan|batas pengetahuan|pengetahuan saya terbatas|tidak memiliki akses real-?time|i do not know|i don't know|i am not sure|i'm not sure|unable to answer|unable to verify|don't have access to real-?time|cannot answer|cannot verify|knowledge cutoff|as an ai)\b/i.test(clean);
}

export function thinkingStageLabel(elapsedSeconds = 0, { searchingWeb = false, hasReasoning = false, researchNote = '' } = {}) {
  if (researchNote) return researchNote;
  if (searchingWeb) return 'Mencari solusi dari berbagai sumber...';
  if (hasReasoning) return 'Berpikir secara bertahap...';
  if (elapsedSeconds < 2.5) return 'Sedang berpikir...';
  if (elapsedSeconds < 6) return 'Menganalisis konteks & menyusun jawaban...';
  if (elapsedSeconds < 12) return 'Masih memproses model AI · mohon tunggu sebentar...';
  return 'Menyempurnakan jawaban lebih mendalam...';
}
