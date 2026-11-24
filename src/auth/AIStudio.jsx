import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, ArrowUpRight, Check, ChevronDown, Copy, Cpu, Globe, Github, History, MessageSquarePlus, Network, Paperclip, Plus, RefreshCw, Send, Slack, Sparkles, Square, Trash2, WandSparkles, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { chatCompletionStream, fetchConnectedRepos, fetchEnabledModelItems, fetchFreeModels, fetchProviderStatus, githubLogout, githubStart, githubStatus } from '../api/unorouter';
import { fetchStudioModels } from '../studio/studioClient';
import { splitThinkingContent, thinkingStageLabel } from '../lib/chatStream';
import { useAuth } from './AuthProvider';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, UPLOAD_ACCEPT, formatBytes, oversizeMessage, partitionBySize, uploadAttachments } from '../lib/uploads';

const prompts = [
  'Bantu aku mencari arah untuk ide baru',
  'Buat kerangka konten yang terasa personal',
  'Pecah rencana besar jadi langkah kecil yang nyata',
];

// Batas unggahan dipusatkan di src/lib/uploads.js (100MB, sama dengan /agent).


// Konten pesan multimodal: teks + gambar (image_url) + tautan file.
function buildMessageContent(text, attachments) {
  const parts = [{ type: 'text', text }];
  for (const attachment of attachments) {
    if (attachment.type && attachment.type.startsWith('image/')) {
      parts.push({ type: 'image_url', image_url: { url: attachment.url } });
    } else {
      parts.push({ type: 'text', text: `[File: ${attachment.name}](${attachment.url})` });
    }
  }
  return parts;
}

function shortTitle(text) {
  const normalized = text.trim().replace(/\s+/g, ' ');
  return normalized.length > 54 ? `${normalized.slice(0, 51)}…` : normalized;
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

function codeLabel(lang) {
  const l = String(lang || '').toLowerCase();
  if (['bash', 'sh', 'shell', 'zsh'].includes(l)) return 'SKRIPT · BASH';
  if (['js', 'jsx', 'ts', 'tsx', 'javascript', 'typescript'].includes(l)) return 'KODE · JS';
  if (['py', 'python'].includes(l)) return 'KODE · PYTHON';
  if (['json'].includes(l)) return 'KODE · JSON';
  if (['css', 'scss'].includes(l)) return 'KODE · CSS';
  if (['html', 'xml', 'svg'].includes(l)) return 'KODE · HTML';
  if (['sql'].includes(l)) return 'KODE · SQL';
  if (['prompt'].includes(l)) return 'PROMPT';
  if (['java', 'kotlin', 'go', 'rust', 'c', 'cpp'].includes(l)) return `KODE · ${lang.toUpperCase()}`;
  return `BLOCK · ${(lang || 'TEXT').toUpperCase()}`;
}

function StudioThoughtAccordion({ thinking, durationSec = 0, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!thinking) return null;
  return (
    <div className="studio-thought-box">
      <button
        type="button"
        className={`studio-thought-toggle ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Sparkles size={11} />
        <span>Proses berpikir{durationSec > 0 ? ` · ${durationSec}d` : ''}</span>
        <ChevronDown size={12} />
      </button>
      {open && <pre className="studio-thought-body">{thinking}</pre>}
    </div>
  );
}

const TEMP_THINKING_CODE_LINES = [
  { num: '01', tokens: [{ cls: 'cm', text: '// Menyusun logika & konteks permintaan...' }] },
  { num: '02', tokens: [{ cls: 'kw', text: 'const ' }, { cls: 'id', text: 'ctx' }, { cls: 'op', text: ' = ' }, { cls: 'fn', text: 'analyzePrompt' }, { cls: 'op', text: '(' }, { cls: 'str', text: 'input' }, { cls: 'op', text: ');' }] },
  { num: '03', tokens: [{ cls: 'kw', text: 'const ' }, { cls: 'id', text: 'plan' }, { cls: 'op', text: ' = ' }, { cls: 'kw', text: 'await ' }, { cls: 'fn', text: 'reasonStep' }, { cls: 'op', text: '(' }, { cls: 'id', text: 'ctx' }, { cls: 'op', text: ');' }] },
  { num: '04', tokens: [{ cls: 'kw', text: 'return ' }, { cls: 'fn', text: 'streamTokens' }, { cls: 'op', text: '(' }, { cls: 'id', text: 'plan' }, { cls: 'op', text: ');' }] },
];
const TEMP_THINKING_TOTAL_CHARS = TEMP_THINKING_CODE_LINES.reduce(
  (sum, line) => sum + line.tokens.reduce((acc, tok) => acc + tok.text.length, 0),
  0,
);

export function StudioTempCodePreview({ charCount = 0 }) {
  const cycle = TEMP_THINKING_TOTAL_CHARS + 24;
  const cursorBudget = Math.max(1, charCount % cycle);
  let remaining = cursorBudget;
  let activeLineFound = false;

  const renderedLines = [];
  for (let i = 0; i < TEMP_THINKING_CODE_LINES.length; i += 1) {
    const line = TEMP_THINKING_CODE_LINES[i];
    const lineLen = line.tokens.reduce((acc, tok) => acc + tok.text.length, 0);
    if (remaining <= 0 && i > 0) break;

    let take = Math.min(lineLen, Math.max(0, remaining));
    const isActiveLine = !activeLineFound && (take < lineLen || i === TEMP_THINKING_CODE_LINES.length - 1);
    if (take < lineLen) activeLineFound = true;
    remaining -= take;

    let tokenBudget = take;
    const tokenNodes = [];
    for (let t = 0; t < line.tokens.length; t += 1) {
      if (tokenBudget <= 0) break;
      const tok = line.tokens[t];
      const slice = tok.text.slice(0, tokenBudget);
      tokenBudget -= slice.length;
      tokenNodes.push(
        <span key={t} className={`tok-${tok.cls}`}>{slice}</span>,
      );
    }

    renderedLines.push(
      <div className={`studio-temp-code-line ${isActiveLine ? 'is-active' : ''}`} key={line.num}>
        <span className="studio-temp-code-num">{line.num}</span>
        <span className="studio-temp-code-text">
          {tokenNodes}
          {isActiveLine && <span className="studio-temp-cursor" aria-hidden="true" />}
        </span>
      </div>,
    );
  }

  return (
    <div className="studio-temp-code" aria-hidden="true">
      <div className="studio-temp-code-bar">
        <span className="studio-temp-code-lights"><i /><i /><i /></span>
        <span className="studio-temp-code-title">SINTESIS · MENULIS KODE SEMENTARA</span>
      </div>
      <div className="studio-temp-code-body">
        {renderedLines}
      </div>
    </div>
  );
}

// Render pesan AI: ekstrak blok <think> secara rapi, teks biasa tetap plain,
// dan blok kode (```...```) — termasuk blok yang masih diketik sebagian — tampil sebagai blok kode.
export function StudioMessageBody({ content, reasoning = '', thinkingDurationSec = 0, isTyping = false, copiedCodeKey, onCopyCode }) {
  const parsed = splitThinkingContent(content);
  const combinedThinking = [reasoning, parsed.thinking].filter(Boolean).join('\n\n').trim();
  const displayText = parsed.answer;

  const segments = [];
  const raw = String(displayText || '');
  const fenceRegex = /```(\w*)\r?\n([\s\S]*?)(?:\r?\n?```|$)/g;
  let lastIndex = 0;
  let match;
  let idx = 0;
  while ((match = fenceRegex.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: raw.slice(lastIndex, match.index), key: `seg-${idx++}` });
    }
    const isClosed = match[0].endsWith('```') && match[0].length > 3;
    segments.push({
      type: 'code',
      lang: match[1],
      code: match[2],
      isClosed,
      key: `code-${idx++}`,
    });
    lastIndex = fenceRegex.lastIndex;
  }
  if (lastIndex < raw.length) {
    const tail = raw.slice(lastIndex);
    const pendingFence = isTyping ? tail.match(/```([a-z0-9_+-]*)$/i) : null;
    if (pendingFence && pendingFence.index !== undefined) {
      if (pendingFence.index > 0) {
        segments.push({ type: 'text', value: tail.slice(0, pendingFence.index), key: `seg-${idx++}` });
      }
      segments.push({
        type: 'code',
        lang: pendingFence[1],
        code: '',
        isClosed: false,
        key: `code-${idx++}`,
      });
    } else {
      segments.push({ type: 'text', value: tail, key: `seg-${idx++}` });
    }
  }

  const parts = [];
  if (combinedThinking) {
    parts.push(
      <StudioThoughtAccordion
        key="thought-accordion"
        thinking={combinedThinking}
        durationSec={thinkingDurationSec}
      />,
    );
  }

  const lastSegIndex = segments.length - 1;
  segments.forEach((seg, segIdx) => {
    const isLastSegment = segIdx === lastSegIndex;
    if (seg.type === 'code') {
      parts.push(
        <div className="studio-code-block" key={seg.key}>
          <div className="studio-code-head">
            <span className="studio-code-lang">{codeLabel(seg.lang)}</span>
            <button type="button" className={`studio-code-copy ${copiedCodeKey === seg.key ? 'is-copied' : ''}`} onClick={() => onCopyCode(seg.code, seg.key)} aria-label="Salin kode">
              {copiedCodeKey === seg.key ? <Check size={11} /> : <Copy size={11} />} Salin
            </button>
          </div>
          <pre className="studio-code-pre">
            <code>
              {seg.code}
              {isTyping && isLastSegment && !seg.isClosed && <span className="studio-typing-cursor" aria-hidden="true" />}
            </code>
          </pre>
        </div>,
      );
      return;
    }

    const paragraphs = seg.value.split(/\n{2,}/).filter((p) => p.length > 0 && p.trim().length > 0);
    if (!paragraphs.length && isTyping && isLastSegment) {
      parts.push(
        <p key={`${seg.key}-cursor`} className="studio-message-text">
          <span className="studio-typing-cursor" aria-hidden="true" />
        </p>,
      );
      return;
    }
    paragraphs.forEach((paragraph, pIndex) => {
      const isVeryLast = isLastSegment && pIndex === paragraphs.length - 1;
      parts.push(
        <p key={`${seg.key}-${pIndex}`} className="studio-message-text">
          {paragraph}
          {isTyping && isVeryLast && <span className="studio-typing-cursor" aria-hidden="true" />}
        </p>,
      );
    });
  });

  if (!segments.length && isTyping) {
    parts.push(
      <p key="cursor-only" className="studio-message-text">
        <span className="studio-typing-cursor" aria-hidden="true" />
      </p>,
    );
  }

  return parts;
}

// Kode galat pool OpenAI → saran yang masuk akal. Semua model OpenAI memakai
// akun yang sama, jadi "ganti model" hanya berguna untuk batas LAJU (limit
// memang per model), tidak untuk billing atau kunci yang ditolak.
const OPENAI_ERROR_HINTS = {
  openai_rate_limited: 'rate_limit',
  openai_pool_billing: 'billing',
  openai_pool_unauthorized: 'auth',
  openai_pool_failed: 'other',
  // Pool ada isinya tetapi tidak ada satu pun akun yang bisa dipakai (kredit
  // habis, kunci mati, paket OAuth tidak boleh dibagikan). Kalimatnya sudah
  // disusun server lengkap dengan tindakannya, jadi jangan ditimpa di klien.
  openai_pool_needs_attention: 'permanent',
  openai_pool_not_usable: 'permanent',
};

function formatChatErrorMessage(chatData, status) {
  // Server sudah menyusun kalimat yang tepat untuk pool OpenAI (batas laju vs
  // billing vs kunci ditolak). Jangan ditimpa lagi di klien.
  if (chatData?.code && OPENAI_ERROR_HINTS[chatData.code]) {
    return chatData?.error || 'Respons AI gagal. Coba lagi sebentar.';
  }
  const retrySec = Number(chatData?.retryAfterSec) || null;
  const raw = String(chatData?.detail || chatData?.error || '');
  if (status === 429 || chatData?.code === 'rate_limit_exceeded' || /rate_limit_exceeded|429/i.test(raw)) {
    return retrySec
      ? `Batas permintaan model tercapai (429). Coba lagi dalam ${retrySec} detik atau langsung ganti ke model lain.`
      : 'Batas permintaan model tercapai (429). Tunggu sebentar atau langsung ganti ke model lain.';
  }
  return chatData?.error || 'Respons AI gagal. Coba lagi sebentar.';
}

export function AIStudio() {
  const { user } = useAuth();
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [fallbackNotice, setFallbackNotice] = useState('');
  const [retryState, setRetryState] = useState(null);
  const [retryCountdown, setRetryCountdown] = useState(0);
  const [providerStatus, setProviderStatus] = useState(null);
  const [models, setModels] = useState([]);
  const [enabledModels, setEnabledModels] = useState([]);
  const [modelItems, setModelItems] = useState([]);
  const [selectedModel, setSelectedModel] = useState('gpt-oss-120b:free');
  // Ruang Studio memakai model OpenAI (pool akun manual), BUKAN katalog
  // provider yang terdaftar di Admin Panel. Di luar /studio/* perilakunya tetap
  // seperti sebelumnya supaya halaman lain tidak ikut berubah.
  const [studioMode] = useState(() => {
    if (typeof window === 'undefined') return false;
    return /^\/studio(\/|$)/.test(window.location.pathname || '');
  });
  const [studioPool, setStudioPool] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const [copiedCodeKey, setCopiedCodeKey] = useState('');
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  const [modelOpen, setModelOpen] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [repos, setRepos] = useState([]);
  const [selectedRepo, setSelectedRepo] = useState('');
  const [repoConnecting, setRepoConnecting] = useState(false);
  // App koneksi — seperti Arena: TIDAK otomatis terhubung; klik untuk koneksikan.
  const [appConnections, setAppConnections] = useState({ notion: false, slack: false, github: false });
  const [appConnecting, setAppConnecting] = useState(null);
  // Modal persetujuan auth login (seperti consent OAuth) — klik logo app
  // untuk koneksikan, approval dari pemilik akun.
  const [consentApp, setConsentApp] = useState(null);
  const [githubConnected, setGithubConnected] = useState(null);
  const [liveReply, setLiveReply] = useState(null);
  const endOfMessages = useRef(null);
  const conversationScrollRef = useRef(null);
  const draftRef = useRef(null);
  const sendingRef = useRef(false);
  const abortControllerRef = useRef(null);
  const liveReplyRef = useRef(null);
  const fileInputRef = useRef(null);
  const activeConversation = useMemo(() => conversations.find((conversation) => conversation.id === activeId) || null, [conversations, activeId]);
  const fullName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Kreator';
  const initials = fullName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();

  const loadSidebarData = useCallback(async () => {
    if (!user?.id) return;
    setLoadingHistory(true);
    const conversationResult = await supabase
      .from('ai_conversations')
      .select('id,user_id,title,created_at,updated_at')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false })
      .limit(100);
    if (conversationResult.error) {
      console.error('Loading AI Studio sidebar failed:', conversationResult.error);
      setError('Riwayat percakapan belum bisa dimuat. Coba muat ulang.');
    } else {
      setConversations(conversationResult.data ?? []);
    }
    setLoadingHistory(false);
  }, [user?.id]);

  const loadMessages = useCallback(async (conversationId) => {
    if (!conversationId) {
      setMessages([]);
      return;
    }
    setLoadingMessages(true);
    setError('');
    const { data, error: queryError } = await supabase
      .from('ai_messages')
      .select('id,conversation_id,user_id,role,content,created_at')
      .eq('conversation_id', conversationId)
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
      .limit(500);
    if (queryError) {
      console.error('Loading conversation failed:', queryError);
      setError('Percakapan belum bisa dibuka. Coba lagi.');
    } else {
      setMessages(data ?? []);
    }
    setLoadingMessages(false);
  }, [user?.id]);

  useEffect(() => { loadSidebarData(); }, [loadSidebarData]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await githubStatus();
        if (!cancelled) setGithubConnected(status);
      } catch { /* status opsional */ }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchConnectedRepos();
        if (!cancelled) setRepos(list);
      } catch { /* repo info opsional */ }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await fetchProviderStatus();
        if (cancelled) return;
        if (status?.error) {
          console.error('Provider status failed:', status.error);
          return;
        }
        setProviderStatus(status);
        if (status?.configured) {
          const items = await fetchEnabledModelItems();
          if (cancelled) return;
          if (Array.isArray(items) && items.length) {
            const ids = items.map((m) => m.id);
            setModelItems(items);
            setEnabledModels(ids);
            setSelectedModel((current) => ids.includes(current) ? current : ids[0]);
          } else {
            const freeModels = await fetchFreeModels();
            if (cancelled) return;
            if (Array.isArray(freeModels) && freeModels.length) {
              setModelItems(freeModels.map((id) => ({ id, provider: 'unorouter' })));
              setModels(freeModels);
              setSelectedModel((current) => freeModels.includes(current) ? current : freeModels[0]);
            }
          }
        }
      } catch (statusError) {
        console.error('Provider status failed:', statusError);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Studio: model OpenAI dari pool akun manual + status kesiapan pool.
  useEffect(() => {
    if (!studioMode) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchStudioModels({ capability: 'chat' });
        if (cancelled) return;
        const items = Array.isArray(res?.data?.modelItems) ? res.data.modelItems : [];
        setStudioPool({ ready: Boolean(res?.data?.ready), pool: res?.data?.pool || null, hint: res?.data?.hint || '' });
        if (items.length) {
          setModelItems(items);
          setEnabledModels(items.map((item) => item.id));
          setModels([]);
          setSelectedModel((current) => (items.some((item) => item.id === current) ? current : items[0].id));
          setProviderStatus({ configured: Boolean(res?.data?.ready) });
        } else {
          setProviderStatus({ configured: false });
        }
      } catch {
        if (!cancelled) setProviderStatus({ configured: false });
      }
    })();
    return () => { cancelled = true; };
  }, [studioMode]);

  useEffect(() => {
    if (retryCountdown <= 0) return undefined;
    const timer = window.setInterval(() => {
      setRetryCountdown((sec) => (sec > 1 ? sec - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryCountdown]);

  useEffect(() => {
    liveReplyRef.current = liveReply;
  }, [liveReply]);

  useEffect(() => {
    if (!liveReply) return undefined;
    const ticker = window.setInterval(() => {
      setLiveReply((cur) => {
        if (!cur) return cur;
        const rawSource = cur.rawContent || cur.finalReplyOverride || '';
        const parsed = splitThinkingContent(rawSource);
        const targetLen = parsed.answer.length;
        const elapsedSec = Math.max(0, Math.floor((Date.now() - cur.startedAt) / 1000));

        let nextShown = cur.shownChars;
        let nextTempChars = cur.tempCodeChars || 0;
        if (nextShown < targetLen) {
          const remaining = targetLen - nextShown;
          const step = remaining > 1400
            ? Math.min(12, Math.ceil(remaining / 110))
            : remaining > 500
              ? 6
              : remaining > 180
                ? 3
                : remaining > 45
                  ? 2
                  : 1;
          nextShown = Math.min(targetLen, nextShown + step);
        } else if (nextShown === 0) {
          nextTempChars += 1;
        }

        if (nextShown === cur.shownChars && elapsedSec === cur.elapsedSec && nextTempChars === (cur.tempCodeChars || 0)) {
          return cur;
        }
        return { ...cur, shownChars: nextShown, tempCodeChars: nextTempChars, elapsedSec };
      });
    }, 20);
    return () => window.clearInterval(ticker);
  }, [Boolean(liveReply)]);

  useEffect(() => {
    if (!liveReply?.streamFinished) return;
    const rawSource = liveReply.rawContent || liveReply.finalReplyOverride || '';
    const parsed = splitThinkingContent(rawSource);
    if (liveReply.shownChars < parsed.answer.length) return;

    const finalContent = parsed.answer || parsed.thinking || liveReply.explicitThinking;
    const combinedThinking = [liveReply.explicitThinking, parsed.thinking].filter(Boolean).join('\n\n').trim();
    const durationSec = Math.max(0, Math.floor((Date.now() - liveReply.startedAt) / 1000));
    const replyMessage = {
      id: liveReply.messageId || `reply-${Date.now()}`,
      conversation_id: liveReply.conversationId,
      user_id: user.id,
      role: 'assistant',
      content: finalContent,
      reasoning: combinedThinking,
      thinkingDurationSec: durationSec,
      created_at: liveReply.createdAt || new Date().toISOString(),
      model: liveReply.model,
      actions: liveReply.actions || [],
    };
    setLiveReply(null);
    setMessages((current) => [...current, replyMessage]);
    if (liveReply.conversationId) {
      supabase
        .from('ai_conversations')
        .update({ updated_at: replyMessage.created_at })
        .eq('id', liveReply.conversationId)
        .eq('user_id', user.id)
        .then(({ error: metaError }) => {
          if (metaError) console.error('Conversation meta update failed:', metaError);
        });
      setConversations((current) => current.map((item) => item.id === liveReply.conversationId
        ? { ...item, updated_at: replyMessage.created_at }
        : item).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)));
    }
  }, [liveReply, user?.id]);

  useEffect(() => {
    if (sendingRef.current) return;
    loadMessages(activeId);
  }, [activeId, loadMessages]);

  useEffect(() => {
    const el = conversationScrollRef.current;
    if (!el) {
      endOfMessages.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      return;
    }
    const nearBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 160;
    if (nearBottom || !liveReply) {
      endOfMessages.current?.scrollIntoView({ behavior: liveReply ? 'auto' : 'smooth', block: 'end' });
    }
  }, [messages.length, loadingMessages, liveReply?.id, liveReply?.shownChars, liveReply?.rawContent, liveReply?.explicitThinking, liveReply?.searchingWeb]);

  useEffect(() => {
    if (!liveReply?.id) return;
    endOfMessages.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [liveReply?.id]);

  function startNewConversation() {
    abortControllerRef.current?.abort();
    setLiveReply(null);
    setActiveId(null);
    setMessages([]);
    setDraft('');
    setError('');
    setFallbackNotice('');
    setRetryState(null);
    setRetryCountdown(0);
    draftRef.current?.focus();
  }

  async function attachFiles(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    setError('');
    // Batas 100MB per berkas; berkas yang terlalu besar dilaporkan, bukan
    // dipotong diam-diam.
    const { accepted, rejected } = partitionBySize(files, MAX_UPLOAD_BYTES);
    if (rejected.length) setError(oversizeMessage(rejected, MAX_UPLOAD_BYTES));
    if (!accepted.length) return;
    setUploading(true);
    try {
      const { uploaded, failures } = await uploadAttachments({ client: supabase, files: accepted, userId: user.id, folder: 'studio' });
      if (failures.length) setError(`"${failures[0].name}" gagal diunggah: ${failures[0].error}`);
      if (uploaded.length) setAttachments((current) => [...current, ...uploaded]);
    } finally {
      setUploading(false);
    }
  }

  function removeAttachment(id) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  const availableModels = useMemo(() => (enabledModels.length ? enabledModels : models), [enabledModels, models]);

  const resolveProviderForModel = useCallback((modelId) => {
    const found = modelItems.find((item) => item.id === modelId);
    // Di Studio, model apa pun berasal dari pool OpenAI, jadi provider
    // default-nya 'openai' — bukan 'unorouter'.
    return found?.provider || (studioMode ? 'openai' : 'unorouter');
  }, [modelItems, studioMode]);

  function stopGeneration() {
    abortControllerRef.current?.abort();
    const cur = liveReplyRef.current;
    if (cur) {
      const rawSource = cur.rawContent || cur.finalReplyOverride || '';
      const parsed = splitThinkingContent(rawSource);
      const partialAnswer = parsed.answer.slice(0, cur.shownChars).trim();
      const combinedThinking = [cur.explicitThinking, parsed.thinking].filter(Boolean).join('\n\n').trim();
      if (partialAnswer) {
        setMessages((current) => [
          ...current,
          {
            id: cur.messageId || `stopped-${Date.now()}`,
            conversation_id: cur.conversationId,
            user_id: user.id,
            role: 'assistant',
            content: partialAnswer,
            reasoning: combinedThinking,
            thinkingDurationSec: cur.elapsedSec,
            created_at: new Date().toISOString(),
            model: cur.model,
          },
        ]);
      }
    }
    setLiveReply(null);
    sendingRef.current = false;
    setSending(false);
  }

  const executeChatCompletion = useCallback(async ({ conversationId, history, modelOverride, reuseLiveReply = false, abortController = null }) => {
    const targetModel = modelOverride || selectedModel;
    const targetProvider = resolveProviderForModel(targetModel);
    const controller = abortController || new AbortController();
    abortControllerRef.current = controller;

    if (!reuseLiveReply) {
      setLiveReply({
        id: `live-${Date.now()}`,
        conversationId,
        model: targetModel,
        provider: targetProvider,
        startedAt: Date.now(),
        elapsedSec: 0,
        tempCodeChars: 0,
        searchingWeb: false,
        streamFinished: false,
        explicitThinking: '',
        rawContent: '',
        finalReplyOverride: '',
        shownChars: 0,
        actions: [],
        messageId: '',
        createdAt: '',
        fallbackFrom: '',
      });
    } else {
      setLiveReply((cur) => (cur ? { ...cur, conversationId, model: targetModel, provider: targetProvider, searchingWeb: false } : cur));
    }

    const { ok: chatOk, status: chatStatus, aborted, data: chatData } = await chatCompletionStream({
      conversationId,
      model: targetModel,
      provider: targetProvider,
      messages: history,
      github: !!githubConnected?.connected && !!selectedRepo,
      repository: selectedRepo,
      autoFallback: true,
      research: webSearchEnabled,
      signal: controller.signal,
      onMeta: (meta) => {
        if (meta?.fallbackFrom && meta?.model && meta.model !== targetModel) {
          setSelectedModel(meta.model);
          setFallbackNotice(`Batas permintaan pada ${meta.fallbackFrom} tercapai — dialihkan otomatis ke ${meta.model}.`);
        } else {
          setFallbackNotice('');
        }
        setLiveReply((cur) => (cur ? {
          ...cur,
          model: meta?.model || cur.model,
          provider: meta?.provider || cur.provider,
          fallbackFrom: meta?.fallbackFrom || cur.fallbackFrom,
        } : cur));
      },
      onThinking: (chunk) => {
        setLiveReply((cur) => (cur ? { ...cur, explicitThinking: cur.explicitThinking + chunk } : cur));
      },
      onDelta: (chunk) => {
        setLiveReply((cur) => (cur ? { ...cur, rawContent: cur.rawContent + chunk } : cur));
      },
    });

    if (aborted || controller.signal.aborted) return;

    if (chatOk && (chatData?.reply || liveReplyRef.current?.rawContent)) {
      setRetryState(null);
      setRetryCountdown(0);
      if (chatData?.fallbackFrom && chatData?.model && chatData.model !== targetModel) {
        setSelectedModel(chatData.model);
        setFallbackNotice(`Batas permintaan pada ${chatData.fallbackFrom} tercapai — dialihkan otomatis ke ${chatData.model}.`);
      }
      setLiveReply((cur) => (cur ? {
        ...cur,
        streamFinished: true,
        rawContent: cur.rawContent || chatData?.reply || '',
        finalReplyOverride: chatData?.reply || '',
        explicitThinking: chatData?.reasoning || cur.explicitThinking,
        messageId: chatData?.messageId || `reply-${Date.now()}`,
        createdAt: new Date().toISOString(),
        model: chatData?.model || cur.model,
        provider: chatData?.provider || cur.provider,
        actions: chatData?.actions || [],
      } : cur));
      return;
    }

    setLiveReply(null);
    const waitSec = Number(chatData?.retryAfterSec) || 0;
    setRetryState({
      conversationId,
      history,
      failedModel: targetModel,
      kind: OPENAI_ERROR_HINTS[chatData?.code] || '',
    });
    setRetryCountdown(waitSec);
    setError(formatChatErrorMessage(chatData, chatStatus));
  }, [selectedModel, resolveProviderForModel, githubConnected?.connected, selectedRepo, webSearchEnabled]);

  async function retryLastCompletion(overrideModel) {
    if (!retryState || sending) return;
    setSending(true);
    sendingRef.current = true;
    setError('');
    try {
      if (overrideModel) setSelectedModel(overrideModel);
      await executeChatCompletion({
        conversationId: retryState.conversationId,
        history: retryState.history,
        modelOverride: overrideModel || selectedModel,
      });
    } catch (retryErr) {
      console.error('Retry chat failed:', retryErr);
      setLiveReply(null);
      setError('Gagal menghubungi model AI. Coba lagi sebentar.');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  function pickAlternativeModel(currentModel) {
    const candidates = availableModels.filter((m) => m && m !== currentModel);
    if (!candidates.length) return '';
    return candidates.find((m) => /gemini-2\.5-flash|deepseek|qwen|glm-5|mistral/i.test(m)) || candidates[0];
  }

  async function saveMessage(event) {
    event.preventDefault();
    const content = draft.trim();
    if ((!content && !attachments.length) || sending || liveReply) return;
    const attachedFiles = [...attachments];
    const priorMessages = [...messages];
    const fileRefs = attachedFiles.map((attachment) => `[File: ${attachment.name} — ${attachment.url}]`).join('\n');
    const storedContent = fileRefs ? `${content}\n${fileRefs}` : content;
    const optimisticUserId = `temp-user-${Date.now()}`;
    const optimisticUserMsg = {
      id: optimisticUserId,
      conversation_id: activeConversation?.id || null,
      user_id: user.id,
      role: 'user',
      content: storedContent,
      created_at: new Date().toISOString(),
    };
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setSending(true);
    sendingRef.current = true;
    setError('');
    setFallbackNotice('');
    setRetryState(null);
    setRetryCountdown(0);
    setDraft('');
    setAttachments([]);
    setMessages((current) => [...current, optimisticUserMsg]);

    if (providerStatus?.configured) {
      // Tampilkan animasi berpikir & tulisan kode sementara tepat di balasan AI segera setelah kirim.
      setLiveReply({
        id: `live-${Date.now()}`,
        conversationId: activeConversation?.id || '',
        model: selectedModel,
        provider: resolveProviderForModel(selectedModel),
        startedAt: Date.now(),
        elapsedSec: 0,
        tempCodeChars: 0,
        searchingWeb: webSearchEnabled,
        streamFinished: false,
        explicitThinking: '',
        rawContent: '',
        finalReplyOverride: '',
        shownChars: 0,
        actions: [],
        messageId: '',
        createdAt: '',
        fallbackFrom: '',
      });
    }

    try {
      let conversation = activeConversation;
      if (!conversation) {
        const { data, error: createError } = await supabase
          .from('ai_conversations')
          .insert({ user_id: user.id, title: shortTitle(content) || 'Percakapan baru' })
          .select('id,user_id,title,created_at,updated_at')
          .single();
        if (createError) throw createError;
        conversation = data;
        setConversations((current) => [data, ...current]);
        setActiveId(data.id);
      } else {
        const { error: updateError } = await supabase
          .from('ai_conversations')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', conversation.id)
          .eq('user_id', user.id);
        if (updateError) throw updateError;
      }

      const { data: savedMessage, error: insertError } = await supabase
        .from('ai_messages')
        .insert({ conversation_id: conversation.id, user_id: user.id, role: 'user', content: storedContent })
        .select('id,conversation_id,user_id,role,content,created_at')
        .single();
      if (insertError) throw insertError;

      setMessages((current) => current.map((m) => (m.id === optimisticUserId ? savedMessage : m)));
      setConversations((current) => current.map((item) => item.id === conversation.id
        ? { ...item, title: item.title || shortTitle(content), updated_at: savedMessage.created_at }
        : item).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)));

      if (!providerStatus?.configured || controller.signal.aborted) return;

      setLiveReply((cur) => (cur ? { ...cur, conversationId: conversation.id } : cur));

      const history = [
        ...priorMessages,
        { role: 'user', content: buildMessageContent(content, attachedFiles) },
      ]
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => ({ role: message.role, content: message.content }));

      await executeChatCompletion({ conversationId: conversation.id, history, reuseLiveReply: true, abortController: controller });
    } catch (saveError) {
      console.error('Saving chat message failed:', saveError);
      setLiveReply(null);
      setMessages((current) => current.filter((m) => m.id !== optimisticUserId));
      setDraft(content);
      setAttachments(attachedFiles);
      setError('Pesan belum berhasil disimpan. Coba lagi sebentar.');
      await loadSidebarData();
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function deleteConversation() {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error: deleteError } = await supabase.from('ai_conversations').delete().eq('id', deleteTarget.id).eq('user_id', user.id);
    if (deleteError) {
      console.error('Deleting conversation failed:', deleteError);
      setError('Percakapan belum berhasil dihapus. Coba lagi.');
    } else {
      if (activeId === deleteTarget.id) startNewConversation();
      setConversations((current) => current.filter((item) => item.id !== deleteTarget.id));
      setDeleteTarget(null);
    }
    setDeleting(false);
  }

  function insertPrompt(prompt) {
    setDraft(prompt);
    draftRef.current?.focus();
  }

  function copyMessage(message) {
    const content = String(message.content || '');
    if (!content) return;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(content).then(() => {
        setCopiedId(message.id);
        window.setTimeout(() => setCopiedId((current) => (current === message.id ? null : current)), 2000);
      }).catch(() => {
        // Fallback: textarea copy for non-secure contexts
        const area = document.createElement('textarea');
        area.value = content;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        try { document.execCommand('copy'); setCopiedId(message.id); window.setTimeout(() => setCopiedId((current) => (current === message.id ? null : current)), 2000); } catch { /* ignore */ }
        document.body.removeChild(area);
      });
    } else {
      const area = document.createElement('textarea');
      area.value = content;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); setCopiedId(message.id); window.setTimeout(() => setCopiedId((current) => (current === message.id ? null : current)), 2000); } catch { /* ignore */ }
      document.body.removeChild(area);
    }
  }

  function copyCode(code, key) {
    const done = () => {
      setCopiedCodeKey(key);
      window.setTimeout(() => setCopiedCodeKey((current) => (current === key ? '' : current)), 2000);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(done).catch(() => {
        const area = document.createElement('textarea');
        area.value = code;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        try { document.execCommand('copy'); done(); } catch { /* ignore */ }
        document.body.removeChild(area);
      });
    } else {
      const area = document.createElement('textarea');
      area.value = code;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); done(); } catch { /* ignore */ }
      document.body.removeChild(area);
    }
  }

  // Koneksi ulang repo — seperti Arena: menggunakan autentikasi akun yang login.
  async function reconnectRepo() {
    setRepoConnecting(true);
    try {
      const list = await fetchConnectedRepos();
      setRepos(list);
      setSelectedRepo((current) => list.some((repo) => repo.fullName === current) ? current : '');
    } catch { setError('Gagal memuat repository. Coba lagi.'); }
    finally { setRepoConnecting(false); }
  }

  // Klik logo app: jika belum terhubung -> buka modal persetujuan; jika
  // terhubung -> putus koneksi.
  function handleAppChipClick(app) {
    if (appConnections[app]) {
      toggleAppConnection(app);
      return;
    }
    setConsentApp(app);
  }

  // Setujui & Hubungkan dari modal persetujuan — alur auth login.
  async function approveConsent(app) {
    setConsentApp(null);
    if (app === 'github') {
      // OAuth real: redirect ke github.com/authorize.
      try {
        const { ok, data } = await githubStart();
        if (ok && data?.url) {
          window.location.href = data.url;
          return;
        }
        setError(data?.error || 'Koneksi GitHub gagal. Hubungi administrator BLEA AI.');
      } catch (startError) {
        setError(String(startError?.message || startError));
      }
      return;
    }
    setAppConnecting(app);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    setAppConnections((current) => ({ ...current, [app]: true }));
    setAppConnecting(null);
  }

  // Toggle koneksi app — klik logo untuk koneksikan (tidak otomatis).
  async function toggleAppConnection(app) {
    if (appConnections[app]) {
      setAppConnections((current) => ({ ...current, [app]: false }));
      return;
    }
    setAppConnecting(app);
    // Alur koneksi seperti Arena (auth login) — status "Menghubungkan…".
    await new Promise((resolve) => setTimeout(resolve, 900));
    setAppConnections((current) => ({ ...current, [app]: true }));
    setAppConnecting(null);
  }

  // Tutup popover model saat klik di luar.
  useEffect(() => {
    if (!modelOpen) return undefined;
    const close = (event) => {
      if (!event.target.closest('.studio-model-wrap')) setModelOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [modelOpen]);

  // Ruang kerja Studio: navigasi utama sudah disediakan shell aplikasi, jadi
  // komponen ini tidak membungkus dirinya dalam layout kedua.
  return (
    <>
      <div className={`studio-shell studio-ready ${mobileHistoryOpen ? 'is-history-open' : ''}`}>
        <div className="studio-sidebar">
        <div className="studio-sidebar-head-mobile">
          <b>Riwayat ({conversations.length})</b>
          <button type="button" onClick={() => setMobileHistoryOpen(false)} aria-label="Tutup riwayat"><X size={15} /></button>
        </div>
        <button className="studio-new-chat" onClick={() => { startNewConversation(); setMobileHistoryOpen(false); }}><MessageSquarePlus size={15} /> Percakapan baru <Plus size={15} /></button>
        <div className="studio-history-heading"><span>RIWAYAT</span><span>{conversations.length}</span></div>
        <div className="studio-history-list">
          {loadingHistory ? <div className="studio-history-loading">Memuat riwayat...</div> : conversations.length ? conversations.map((conversation) => <div key={conversation.id} className={`studio-history-item ${activeId === conversation.id ? 'active' : ''}`}><button className="studio-history-select" onClick={() => { abortControllerRef.current?.abort(); setLiveReply(null); setActiveId(conversation.id); setError(''); setMobileHistoryOpen(false); }}><span className="history-message-icon"><MessageSquarePlus size={14} /></span><span><b>{conversation.title}</b><small>{new Date(conversation.updated_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })}</small></span></button><button className="studio-history-delete" onClick={() => setDeleteTarget(conversation)} aria-label={`Hapus percakapan ${conversation.title}`}><Trash2 size={13} /></button></div>) : <p className="studio-history-empty">Belum ada riwayat percakapan.</p>}
        </div>
        </div>

      <main className="studio-main">
        <header className="studio-topbar">
          <div className="studio-topbar-left">
            <button type="button" className="studio-history-toggle" onClick={() => setMobileHistoryOpen((v) => !v)} aria-label="Buka riwayat chat" aria-expanded={mobileHistoryOpen}>
              <History size={14} /> <span>Riwayat</span>
            </button>
            <div className="studio-breadcrumb"><span>BLEA AI</span><span>/</span><b>Chat AI</b>{activeConversation && <><span>/</span><b className="studio-current-title">{activeConversation.title}</b></>}</div>
          </div>
          <div className="studio-top-actions">
            <button type="button" className="studio-new-mobile" onClick={startNewConversation} aria-label="Percakapan baru"><Plus size={14} /></button>
            <span className={`studio-status ${providerStatus?.configured ? 'is-live' : 'is-preview'}`}><i /> <span className="studio-status-text">{providerStatus?.configured ? selectedModel : 'Pratinjau'}</span></span>
            <Link to="/app" aria-label="Kembali ke dashboard"><ArrowUpRight size={15} /></Link>
          </div>
        </header>
        <div className="studio-content">
          <div ref={conversationScrollRef} className={`studio-conversation ${(messages.length || liveReply) ? 'has-messages' : ''}`}>
            {messages.length === 0 && !loadingMessages && !liveReply ? <div className="studio-welcome"><div className="studio-welcome-icon"><WandSparkles size={20} /></div><span className="studio-eyebrow">BLEA AI STUDIO</span><h1>{activeConversation ? 'Lanjutkan idemu.' : <>Satu ruang untuk<br /><em>pikiran besarmu.</em></>}</h1><p>{providerStatus?.configured ? 'Tanya apa saja, cari web, atau tulis kode secara instan.' : 'Simpan prompt & ide; AI aktif setelah provider terhubung.'}</p><div className="studio-prompt-chips">{prompts.map((prompt) => <button key={prompt} onClick={() => insertPrompt(prompt)}>{prompt}<ArrowUpRight size={13} /></button>)}</div></div> : <div className="studio-message-list">{loadingMessages && <div className="studio-message-loading">Memuat percakapan...</div>}{messages.map((message) => <article className={`studio-message ${message.role === 'user' ? 'from-user' : 'from-assistant'}`} key={message.id}>{message.role === 'assistant' && <span className="studio-message-avatar"><Sparkles size={13} /></span>}<div className="studio-message-body"><div className="studio-message-meta"><b>{message.role === 'user' ? fullName : 'BLEA AI'}</b><time>{formatTime(message.created_at)}</time><button type="button" className={`studio-copy-button ${copiedId === message.id ? 'is-copied' : ''}`} onClick={() => copyMessage(message)} aria-label={`Salin pesan ${message.role === 'user' ? 'kamu' : 'AI'}`}>{copiedId === message.id ? <Check size={11} /> : <Copy size={11} />}</button></div>{message.role === 'assistant' ? <StudioMessageBody content={message.content} reasoning={message.reasoning} thinkingDurationSec={message.thinkingDurationSec} copiedCodeKey={copiedCodeKey} onCopyCode={copyCode} /> : <p className="studio-message-text">{message.content}</p>}</div>{message.actions?.length > 0 && <div className="studio-message-actions">{message.actions.map((action, actionIndex) => <span key={actionIndex} className={`studio-action-pill ${action.ok ? 'is-ok' : 'is-fail'}`}>{action.tool} {action.ok ? '✓' : '✗'}</span>)}</div>}</article>)}{liveReply && (() => {
              const rawSource = liveReply.rawContent || liveReply.finalReplyOverride || '';
              const parsedLive = splitThinkingContent(rawSource);
              const combinedThinking = [liveReply.explicitThinking, parsedLive.thinking].filter(Boolean).join('\n\n').trim();
              const visibleAnswer = parsedLive.answer.slice(0, liveReply.shownChars);
              const isStillThinking = !visibleAnswer;
              const stageLabel = thinkingStageLabel(liveReply.elapsedSec, {
                searchingWeb: liveReply.searchingWeb,
                hasReasoning: Boolean(combinedThinking) || parsedLive.isThinkingOpen,
              });
              return (
                <article className="studio-message from-assistant" key={liveReply.id} aria-live="polite">
                  <span className={`studio-message-avatar ${isStillThinking ? 'is-thinking' : ''}`}>
                    <Sparkles size={13} />
                  </span>
                  <div className="studio-message-body">
                    <div className="studio-message-meta">
                      <b>BLEA AI</b>
                      <time>{liveReply.model}</time>
                    </div>
                    {isStillThinking ? (
                      <div className="studio-thinking-panel" role="status">
                        <div className="studio-thinking-head">
                          <span className="studio-thinking-dots" aria-hidden="true"><i /><i /><i /></span>
                          <span className="studio-thinking-label">{stageLabel}</span>
                          {liveReply.elapsedSec > 0 && <span className="studio-thinking-timer">{liveReply.elapsedSec}d</span>}
                        </div>
                        <StudioTempCodePreview charCount={liveReply.tempCodeChars || 0} />
                        {combinedThinking && (
                          <StudioThoughtAccordion thinking={combinedThinking} durationSec={liveReply.elapsedSec} defaultOpen />
                        )}
                      </div>
                    ) : (
                      <StudioMessageBody
                        content={visibleAnswer}
                        reasoning={combinedThinking}
                        thinkingDurationSec={liveReply.elapsedSec}
                        isTyping={!liveReply.streamFinished || liveReply.shownChars < parsedLive.answer.length}
                        copiedCodeKey={copiedCodeKey}
                        onCopyCode={copyCode}
                      />
                    )}
                  </div>
                </article>
              );
            })()}<div ref={endOfMessages} /></div>}
          </div>
          {studioMode && studioPool && !studioPool.ready && (
            <div className="studio-not-connected">
              <Sparkles size={13} />
              <span>
                Pool akun OpenAI belum siap — {studioPool.hint || 'admin perlu menambahkan akun di Studio → Akun OpenAI.'}
              </span>
            </div>
          )}
          {!studioMode && activeConversation && messages.length > 0 && !providerStatus?.configured && <div className="studio-not-connected"><Sparkles size={13} /><span>Mode pratinjau — provider AI belum terhubung.</span></div>}
          {fallbackNotice && <div className="studio-fallback-notice" role="status"><Sparkles size={13} /><span>{fallbackNotice}</span><button type="button" onClick={() => setFallbackNotice('')} aria-label="Tutup pemberitahuan"><X size={13} /></button></div>}
          {error && (
            <div className="studio-error" role="alert">
              <div className="studio-error-copy">
                <span>{error}</span>
                {retryCountdown > 0 && (retryState?.kind === 'rate_limit'
                  ? <small>Tunggu {retryCountdown} detik, atau ganti model — batas laju dihitung per model.</small>
                  : <small>Perbaiki akun OpenAI di Studio → Akun OpenAI, lalu coba lagi.</small>)}
              </div>
              {retryState && (
                <div className="studio-error-actions">
                  <button type="button" className="studio-error-retry" onClick={() => retryLastCompletion()} disabled={sending || retryCountdown > 0}>
                    <RefreshCw size={12} /> {retryCountdown > 0 ? `Coba lagi (${retryCountdown}d)` : 'Coba Lagi'}
                  </button>
                  {pickAlternativeModel(selectedModel) && retryState?.kind !== 'billing' && retryState?.kind !== 'auth' && (
                    <button type="button" className="studio-error-switch" onClick={() => retryLastCompletion(pickAlternativeModel(selectedModel))} disabled={sending}>
                      Ganti ke {pickAlternativeModel(selectedModel).split(':')[0]}
                    </button>
                  )}
                </div>
              )}
              <button type="button" className="studio-error-close" onClick={() => { setError(''); setRetryState(null); setRetryCountdown(0); }} aria-label="Tutup pesan"><X size={13} /></button>
            </div>
          )}
          <div className="studio-composer-area">
            {attachments.length > 0 && (
              <div className="studio-attachments">
                {attachments.map((attachment) => <div className="studio-attachment-chip" key={attachment.id}>
                  {attachment.type.startsWith('image/') ? <img src={attachment.url} alt={attachment.name} /> : attachment.type.startsWith('video/') ? <video src={attachment.url} muted /> : <Paperclip size={13} />}
                  <span className="studio-attachment-name">{attachment.name}<small>{formatBytes(attachment.size)}</small></span>
                  <button type="button" onClick={() => removeAttachment(attachment.id)} aria-label={`Hapus ${attachment.name}`}><X size={11} /></button>
                </div>)}
              </div>
            )}
            <form className="studio-composer" onSubmit={saveMessage}><textarea ref={draftRef} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={providerStatus?.configured ? 'Tanya apa saja...' : 'Tulis ide atau prompt...'} rows={1} maxLength={20000} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} aria-label="Tulis pesan" /><div className="studio-composer-bottom"><span className="studio-composer-hint"><button type="button" className="studio-upload-button" onClick={() => fileInputRef.current?.click()} disabled={sending || uploading || Boolean(liveReply)} aria-label="Unggah foto, video, atau file"><Paperclip size={15} /></button>{providerStatus?.configured && <div className="studio-model-wrap"><button type="button" className={`studio-model-pill ${modelOpen ? 'is-open' : ''}`} onClick={() => setModelOpen((open) => !open)} aria-label="Pilih model" aria-expanded={modelOpen}><Cpu size={13} /><span className="studio-model-pill-name">{selectedModel}</span><ChevronDown size={12} /></button>{modelOpen && <div className="studio-model-popover"><div className="studio-model-popover-head"><b>Model tersedia</b><small>{enabledModels.length ? `${enabledModels.length} model aktif` : `${models.length} model gratis`}</small></div><select value={selectedModel} onChange={(event) => { setSelectedModel(event.target.value); setModelOpen(false); }} aria-label="Pilih model">{(modelItems.length ? modelItems : availableModels.map((id) => ({ id, provider: 'unorouter' }))).map((item) => <option key={`${item.provider}:${item.id}`} value={item.id}>{item.provider && item.provider !== 'unorouter' ? `${item.id} (${item.provider})` : item.id}</option>)}</select></div>}</div>}<span className="studio-composer-note">{providerStatus?.configured ? `Enter kirim · maks ${MAX_UPLOAD_LABEL}` : 'Mode pratinjau'}</span></span><button type="button" className={`studio-composer-tool ${connectionsOpen ? 'is-on' : ''}`} onClick={() => setConnectionsOpen((open) => !open)} aria-label="Koneksi agen" aria-expanded={connectionsOpen}><Network size={14} /> <span className="studio-composer-tool-label">Koneksi</span></button>{(sending || liveReply) ? <button type="button" className="studio-stop-button" onClick={stopGeneration} aria-label="Hentikan respons AI"><Square size={12} /> <span>Hentikan</span></button> : <button type="submit" disabled={(!draft.trim() && !attachments.length) || sending} aria-label={providerStatus?.configured ? 'Kirim pesan' : 'Simpan pesan'}><span>{providerStatus?.configured ? 'Kirim' : 'Simpan'}</span><Send size={14} /></button>}</div><input ref={fileInputRef} type="file" multiple className="studio-file-input" accept={UPLOAD_ACCEPT} onChange={attachFiles} /></form>
            {connectionsOpen && <div className="studio-connections">
              <div className="studio-connections-head">
                <span>Koneksi agen</span>
                <span className={`studio-connections-status ${webSearchEnabled ? 'is-on' : ''}`}>{webSearchEnabled ? 'Akses web aktif' : 'Akses web nonaktif'}</span>
              </div>
              <div className="studio-connections-row">
                <button type="button" className={`studio-conn-chip ${webSearchEnabled ? 'is-on' : ''}`} onClick={() => setWebSearchEnabled((enabled) => !enabled)} aria-pressed={webSearchEnabled}><Globe size={12} /> Akses web <i /></button>
                <button type="button" className={`studio-conn-chip ${appConnections.notion ? 'is-on' : ''}`} onClick={() => handleAppChipClick('notion')} disabled={appConnecting === 'notion'} aria-pressed={appConnections.notion}>{appConnecting === 'notion' ? <span className="studio-send-loader" /> : <BookOpen size={12} />} Notion{appConnections.notion && <i />}</button>
                <button type="button" className={`studio-conn-chip ${appConnections.slack ? 'is-on' : ''}`} onClick={() => handleAppChipClick('slack')} disabled={appConnecting === 'slack'} aria-pressed={appConnections.slack}>{appConnecting === 'slack' ? <span className="studio-send-loader" /> : <Slack size={12} />} Slack{appConnections.slack && <i />}</button>
                <button type="button" className={`studio-conn-chip ${githubConnected?.connected ? 'is-on' : ''}`} onClick={() => (githubConnected?.connected ? githubLogout().then((result) => { if (result.ok) { setGithubConnected({ ok: false, connected: false }); setRepos([]); setSelectedRepo(''); } else setError(result.data?.error || 'Gagal memutus koneksi GitHub.'); }) : setConsentApp('github'))} aria-pressed={!!githubConnected?.connected}><Github size={12} /> GitHub{githubConnected?.connected && <i />}</button>
              </div>
              <div className="studio-repos">
                <label className="studio-repos-label" htmlFor="studio-repo-select">REPOSITORY AKTIF</label>
                {!githubConnected?.connected ? <small>Hubungkan GitHub untuk memilih repository.</small> : <>
                  <div className="studio-repo-picker">
                    <select id="studio-repo-select" value={selectedRepo} onChange={(event) => setSelectedRepo(event.target.value)} disabled={!repos.length}>
                      <option value="">Pilih satu repository</option>
                      {repos.map((repo) => <option key={repo.fullName} value={repo.fullName}>{repo.fullName} ({repo.defaultBranch})</option>)}
                    </select>
                    <button type="button" onClick={reconnectRepo} disabled={repoConnecting}>{repoConnecting ? 'Memuat…' : 'Muat ulang'}</button>
                  </div>
                  <small>{selectedRepo ? `Repository aktif: ${selectedRepo} · akses agen hanya baca` : repos.length ? 'Pilih repository untuk digunakan agen.' : 'Tidak ada repository yang ditampilkan.'}</small>
                </>}
              </div>
            </div>}
          </div>
        </div>
      </main>

      {deleteTarget && <div className="studio-modal-backdrop"><section className="studio-delete-modal" role="dialog" aria-modal="true" aria-labelledby="studio-delete-title"><span className="studio-delete-icon"><Trash2 size={18} /></span><h2 id="studio-delete-title">Hapus percakapan?</h2><p>“{deleteTarget.title}” dan seluruh riwayat pesan di dalamnya akan dihapus.</p><div><button className="studio-cancel-button" onClick={() => setDeleteTarget(null)}>Batal</button><button className="studio-delete-confirm" onClick={deleteConversation} disabled={deleting}>{deleting ? 'Menghapus...' : 'Hapus percakapan'}</button></div></section></div>}

      {consentApp && <div className="studio-modal-backdrop"><section className="studio-consent-modal" role="dialog" aria-modal="true" aria-labelledby="studio-consent-title">
        <span className="studio-consent-icon">{consentApp === 'github' ? <Github size={20} /> : consentApp === 'notion' ? <BookOpen size={20} /> : <Slack size={20} />}</span>
        <h2 id="studio-consent-title">Hubungkan {consentApp === 'github' ? 'GitHub' : consentApp === 'notion' ? 'Notion' : 'Slack'}</h2>
        <p>BLEA AI ingin mengakses akun {consentApp === 'github' ? 'GitHub' : consentApp === 'notion' ? 'Notion' : 'Slack'} kamu untuk memberikan bantuan yang lebih baik — seperti agen yang bisa mengelola catatan, dokumen, dan repository.</p>
        <div className="studio-consent-account"><span>Akun BLEA AI</span><b>{fullName} · {user?.email || '—'}</b></div>
        {consentApp === 'github' && <p className="studio-consent-note">Akun GitHub kamu akan diminta login di halaman github.com setelah kamu klik Setujui &amp; Hubungkan. Pastikan akun GitHub yang benar sedang login di browser kamu. GitHub meminta izin repo yang mencakup akses baca dan tulis, termasuk repository privat; BLEA AI saat ini hanya menjalankan alat baca.</p>}
        <div className="studio-consent-permissions">
          <div className="studio-consent-perm"><Check size={12} /><span>Akses repository (read &amp; write)</span></div>
          <div className="studio-consent-perm"><Check size={12} /><span>Profil pengguna (read)</span></div>
          <div className="studio-consent-perm"><Check size={12} /><span>Putus koneksi di BLEA AI tidak mencabut izin di GitHub; cabut melalui pengaturan aplikasi GitHub.</span></div>
        </div>
        <div><button className="studio-cancel-button" onClick={() => setConsentApp(null)}>Batal</button><button className="studio-consent-approve" onClick={() => approveConsent(consentApp)}>Setujui &amp; Hubungkan</button></div>
      </section></div>}
      </div>
    </>
  );
}
