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
  } else if (typeof data.delta === 'string') {
    if (/reasoning|thinking/i.test(String(data.type || ''))) {
      reasoningDelta += data.delta;
    } else {
      contentDelta += data.delta;
    }
  }

  if (typeof data.reasoning_content === 'string' && !delta?.reasoning_content) {
    reasoningDelta += data.reasoning_content;
  }

  return { contentDelta, reasoningDelta };
}

export function thinkingStageLabel(elapsedSeconds = 0, { searchingWeb = false, hasReasoning = false } = {}) {
  if (searchingWeb) return 'Mencari informasi terbaru di web...';
  if (hasReasoning) return 'Berpikir secara bertahap...';
  if (elapsedSeconds < 2.5) return 'Sedang berpikir...';
  if (elapsedSeconds < 6) return 'Menganalisis konteks & menyusun jawaban...';
  if (elapsedSeconds < 12) return 'Masih memproses model AI · mohon tunggu sebentar...';
  return 'Menyempurnakan jawaban lebih mendalam...';
}
