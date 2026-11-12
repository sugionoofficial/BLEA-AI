import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, ArrowUpRight, Check, ChevronDown, Copy, Cpu, Globe, FolderOpen, GitBranch, Github, MessageSquarePlus, Network, Paperclip, Plus, Send, Slack, Sparkles, Trash2, WandSparkles, X } from 'lucide-react';
import { DropXLayout } from '../dropx/DropXLayout';
import { supabase } from '../lib/supabase';
import { chatCompletion, fetchConnectedRepos, fetchEnabledModels, fetchFreeModels, fetchProviderStatus, webSearch } from '../api/unorouter';
import { useAuth } from './AuthProvider';

const prompts = [
  'Bantu aku mencari arah untuk ide baru',
  'Buat kerangka konten yang terasa personal',
  'Pecah proyek besar jadi langkah kecil',
];

const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

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

// Blok merah: kode / script / prompt dari AI tetap dapat disalin.
function StudioCodeBlock({ lang, code, copied, onCopy }) {
  return (
    <div className="studio-code-block">
      <div className="studio-code-head">
        <span className="studio-code-lang">{codeLabel(lang)}</span>
        <button type="button" className={`studio-code-copy ${copied ? 'is-copied' : ''}`} onClick={onCopy} aria-label="Salin kode">
          {copied ? <Check size={11} /> : <Copy size={11} />} Salin
        </button>
      </div>
      <pre className="studio-code-pre"><code>{code}</code></pre>
    </div>
  );
}

// Render pesan AI: teks biasa tetap plain tanpa blok; blok kode (```...```)
// ditampilkan sebagai blok merah.
function StudioMessageBody({ content, copiedCodeKey, onCopyCode }) {
  const parts = [];
  String(content || '').split(/(```[\s\S]*?```)/g).forEach((segment, index) => {
    if (segment.startsWith('```')) {
      const match = segment.match(/^```(\w*)\r?\n([\s\S]*?)\r?\n?```$/);
      if (match) {
        const key = `code-${index}`;
        parts.push(
          <StudioCodeBlock
            key={key}
            lang={match[1]}
            code={match[2]}
            copied={copiedCodeKey === key}
            onCopy={() => onCopyCode(match[2], key)}
          />,
        );
        return;
      }
    }
    segment
      .split(/\n{2,}/)
      .filter((paragraph) => paragraph.trim())
      .forEach((paragraph, pIndex) => {
        parts.push(<p key={`t-${index}-${pIndex}`} className="studio-message-text">{paragraph}</p>);
      });
  });
  return parts;
}

export function AIStudio() {
  const { user } = useAuth();
  const [projects, setProjects] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [selectedProject, setSelectedProject] = useState('');
  const [draft, setDraft] = useState('');
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [providerStatus, setProviderStatus] = useState(null);
  const [models, setModels] = useState([]);
  const [enabledModels, setEnabledModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('gpt-oss-120b:free');
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const [copiedCodeKey, setCopiedCodeKey] = useState('');
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  const [sendingWeb, setSendingWeb] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [repoConnected, setRepoConnected] = useState(true);
  const [repoConnecting, setRepoConnecting] = useState(false);
  const [connectedRepo, setConnectedRepo] = useState(null);
  // App koneksi — seperti Arena: TIDAK otomatis terhubung; klik untuk koneksikan.
  const [appConnections, setAppConnections] = useState({ notion: false, slack: false, github: false });
  const [appConnecting, setAppConnecting] = useState(null);
  // Modal persetujuan auth login (seperti consent OAuth) — klik logo app
  // untuk koneksikan, approval dari pemilik akun.
  const [consentApp, setConsentApp] = useState(null);
  const endOfMessages = useRef(null);
  const draftRef = useRef(null);
  const sendingRef = useRef(false);
  const fileInputRef = useRef(null);
  const activeConversation = useMemo(() => conversations.find((conversation) => conversation.id === activeId) || null, [conversations, activeId]);
  const fullName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Kreator';
  const initials = fullName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();

  const loadSidebarData = useCallback(async () => {
    if (!user?.id) return;
    setLoadingHistory(true);
    const [conversationResult, projectResult] = await Promise.all([
      supabase.from('ai_conversations').select('id,user_id,project_id,title,created_at,updated_at').eq('user_id', user.id).order('updated_at', { ascending: false }).limit(100),
      supabase.from('projects').select('id,name').eq('user_id', user.id).order('updated_at', { ascending: false }).limit(100),
    ]);
    if (conversationResult.error || projectResult.error) {
      console.error('Loading AI Studio sidebar failed:', conversationResult.error || projectResult.error);
      setError('Riwayat atau proyek belum bisa dimuat. Coba muat ulang.');
    } else {
      setConversations(conversationResult.data ?? []);
      setProjects(projectResult.data ?? []);
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
        const repo = await fetchConnectedRepos();
        if (!cancelled && repo) { setConnectedRepo(repo); setRepoConnected(true); }
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
          const [enabled, freeModels] = await Promise.all([fetchEnabledModels(), fetchFreeModels()]);
          if (cancelled) return;
          if (Array.isArray(enabled) && enabled.length) {
            setEnabledModels(enabled);
            setSelectedModel((current) => enabled.includes(current) ? current : enabled[0]);
          } else if (Array.isArray(freeModels) && freeModels.length) {
            setModels(freeModels);
            setSelectedModel((current) => freeModels.includes(current) ? current : freeModels[0]);
          }
        }
      } catch (statusError) {
        console.error('Provider status failed:', statusError);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (sendingRef.current) return;
    loadMessages(activeId);
    if (activeId) {
      const conversation = conversations.find((item) => item.id === activeId);
      setSelectedProject(conversation?.project_id || '');
    }
  }, [activeId, conversations, loadMessages]);

  useEffect(() => {
    endOfMessages.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, loadingMessages]);

  function startNewConversation() {
    setActiveId(null);
    setMessages([]);
    setDraft('');
    setSelectedProject('');
    setError('');
    draftRef.current?.focus();
  }

  async function attachFiles(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    setError('');
    const oversized = files.filter((file) => file.size > MAX_UPLOAD_BYTES);
    if (oversized.length) {
      setError(`${oversized.map((file) => file.name).join(', ')} melebihi batas 30MB.`);
    }
    const uploads = files.filter((file) => file.size <= MAX_UPLOAD_BYTES);
    if (!uploads.length) return;
    setUploading(true);
    try {
      const uploaded = [];
      for (const file of uploads) {
        const safeName = file.name.replace(/[^a-z0-9._-]/gi, '_').slice(0, 80);
        const path = `${user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
        const { data, error: uploadError } = await supabase.storage.from('ai-studio-uploads').upload(path, file, { contentType: file.type || 'application/octet-stream' });
        if (uploadError) {
          setError(`"${file.name}" gagal diunggah: ${uploadError.message}`);
          continue;
        }
        uploaded.push({
          id: data.path,
          name: file.name,
          size: file.size,
          type: file.type || '',
          url: data.publicUrl,
        });
      }
      if (uploaded.length) setAttachments((current) => [...current, ...uploaded]);
    } finally {
      setUploading(false);
    }
  }

  function removeAttachment(id) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  async function saveMessage(event) {
    event.preventDefault();
    const content = draft.trim();
    if ((!content && !attachments.length) || sending) return;
    setSending(true);
    sendingRef.current = true;
    setError('');

    try {
      let conversation = activeConversation;
      if (!conversation) {
        const { data, error: createError } = await supabase
          .from('ai_conversations')
          .insert({ user_id: user.id, project_id: selectedProject || null, title: shortTitle(content) || 'Percakapan baru' })
          .select('id,user_id,project_id,title,created_at,updated_at')
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

      const fileRefs = attachments.map((attachment) => `[File: ${attachment.name} — ${attachment.url}]`).join('\n');
      const storedContent = fileRefs ? `${content}\n${fileRefs}` : content;
      const { data: savedMessage, error: insertError } = await supabase
        .from('ai_messages')
        .insert({ conversation_id: conversation.id, user_id: user.id, role: 'user', content: storedContent })
        .select('id,conversation_id,user_id,role,content,created_at')
        .single();
      if (insertError) throw insertError;

      setDraft('');
      setAttachments([]);
      setMessages((current) => [...current, savedMessage]);
      setConversations((current) => current.map((item) => item.id === conversation.id
        ? { ...item, title: item.title || shortTitle(content), updated_at: savedMessage.created_at }
        : item).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)));

      if (!providerStatus?.configured) return;

      // Mode agen: akses internet — cari web sebelum menghubungi model.
      let webResults = [];
      if (webSearchEnabled && providerStatus?.configured) {
        setSendingWeb(true);
        try {
          webResults = (await webSearch(content)).slice(0, 5);
        } catch { /* pencarian web opsional — lanjut tanpa hasil jika gagal */ }
        finally { setSendingWeb(false); }
      }

      const history = [
        ...(webResults.length ? [{
          role: 'user',
          content: `Berikut hasil pencarian web terkini untuk: "${content}"\n\n${webResults.map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`).join('\n')}\n\nGunakan informasi ini bila relevan. Sebutkan sumber bila mengutip.`,
        }] : []),
        ...messages,
        { role: 'user', content: buildMessageContent(content, attachments) },
      ]
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => ({ role: message.role, content: message.content }));

      const { ok: chatOk, data: chatData } = await chatCompletion({
        conversationId: conversation.id,
        model: selectedModel,
        messages: history,
      });

      if (chatOk && chatData?.reply) {
        // append lokal + update timestamp percakapan. Edge function sudah
        // menyimpan pesan assistant ke DB — riwayat konsisten pada reload berikutnya.
        const replyMessage = {
          id: chatData.messageId || `reply-${Date.now()}`,
          conversation_id: conversation.id,
          user_id: user.id,
          role: 'assistant',
          content: chatData.reply,
          created_at: new Date().toISOString(),
        };
        setMessages((current) => [...current, replyMessage]);
        const { error: metaError } = await supabase
          .from('ai_conversations')
          .update({ updated_at: replyMessage.created_at })
          .eq('id', conversation.id)
          .eq('user_id', user.id);
        if (metaError) console.error('Conversation meta update failed:', metaError);
        setConversations((current) => current.map((item) => item.id === conversation.id
          ? { ...item, updated_at: replyMessage.created_at }
          : item).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)));
      } else {
        setError(chatData?.error || 'Respons AI gagal. Coba lagi sebentar.');
      }
    } catch (saveError) {
      console.error('Saving chat message failed:', saveError);
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
      const repo = await fetchConnectedRepos();
      if (repo) { setConnectedRepo(repo); setRepoConnected(true); }
    } catch { /* retry gagal — tetap terputus */ }
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

  return (
    <DropXLayout footer={false}>
      <div className="studio-shell studio-ready">
        <div className="studio-sidebar">
        <button className="studio-new-chat" onClick={startNewConversation}><MessageSquarePlus size={15} /> Percakapan baru <Plus size={15} /></button>
        <div className="studio-history-heading"><span>RIWAYAT</span><span>{conversations.length}</span></div>
        <div className="studio-history-list">
          {loadingHistory ? <div className="studio-history-loading">Memuat riwayat...</div> : conversations.length ? conversations.map((conversation) => <div key={conversation.id} className={`studio-history-item ${activeId === conversation.id ? 'active' : ''}`}><button className="studio-history-select" onClick={() => { setActiveId(conversation.id); setError(''); }}><span className="history-message-icon"><MessageSquarePlus size={14} /></span><span><b>{conversation.title}</b><small>{new Date(conversation.updated_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })}</small></span></button><button className="studio-history-delete" onClick={() => setDeleteTarget(conversation)} aria-label={`Hapus percakapan ${conversation.title}`}><Trash2 size={13} /></button></div>) : <p className="studio-history-empty">Percakapan yang kamu simpan akan muncul di sini.</p>}
        </div>
        </div>

      <main className="studio-main">
        <header className="studio-topbar"><div className="studio-breadcrumb"><span>BLEA AI</span><span>/</span><b>AI Studio</b>{activeConversation && <><span>/</span><b className="studio-current-title">{activeConversation.title}</b></>}</div><div className="studio-top-actions"><span className={`studio-status ${providerStatus?.configured ? 'is-live' : 'is-preview'}`}><i /> {providerStatus?.configured ? `AGEN · WEB · ${selectedModel}` : 'MODEL BELUM TERHUBUNG'}</span><Link to="/app" aria-label="Kembali ke dashboard"><ArrowUpRight size={15} /></Link></div></header>
        <div className="studio-content">
          <div className={`studio-conversation ${messages.length ? 'has-messages' : ''}`}>
            {messages.length === 0 && !loadingMessages ? <div className="studio-welcome"><div className="studio-welcome-icon"><WandSparkles size={22} /></div><span className="studio-eyebrow">BLEA AI STUDIO</span><h1>{activeConversation ? 'Lanjutkan idemu.' : <>Satu ruang untuk<br /><em>pikiran besarmu.</em></>}</h1><p>{providerStatus?.configured ? 'BLEA AI adalah agen mandiri — cerdas, tanggap, punya akses internet, dan bisa terhubung ke berbagai app seperti Notion, Slack, dan GitHub. Kode, script, dan prompt akan tampil dalam blok merah yang dapat disalin.' : 'Catat prompt dan ide di sini. Riwayat tersimpan di akunmu; jawaban AI aktif setelah admin menghubungkan API key di panel admin.'}</p><div className="studio-prompt-chips">{prompts.map((prompt) => <button key={prompt} onClick={() => insertPrompt(prompt)}>{prompt}<ArrowUpRight size={13} /></button>)}</div></div> : <div className="studio-message-list">{loadingMessages && <div className="studio-message-loading">Memuat percakapan...</div>}{messages.map((message) => <article className={`studio-message ${message.role === 'user' ? 'from-user' : 'from-assistant'}`} key={message.id}>{message.role === 'assistant' && <span className="studio-message-avatar"><Sparkles size={13} /></span>}<div className="studio-message-body"><div className="studio-message-meta"><b>{message.role === 'user' ? fullName : 'BLEA AI'}</b><time>{formatTime(message.created_at)}</time><button type="button" className={`studio-copy-button ${copiedId === message.id ? 'is-copied' : ''}`} onClick={() => copyMessage(message)} aria-label={`Salin pesan ${message.role === 'user' ? 'kamu' : 'AI'}`}>{copiedId === message.id ? <Check size={11} /> : <Copy size={11} />}</button></div>{message.role === 'assistant' ? <StudioMessageBody content={message.content} copiedCodeKey={copiedCodeKey} onCopyCode={copyCode} /> : <p className="studio-message-text">{message.content}</p>}</div></article>)}<div ref={endOfMessages} /></div>}
          </div>
          {activeConversation && messages.length > 0 && !providerStatus?.configured && <div className="studio-not-connected"><Sparkles size={14} /><span><b>Mode pratinjau.</b> Pesanmu tersimpan, tetapi AI belum membalas karena provider model belum dihubungkan.</span></div>}
          {error && <div className="studio-error" role="alert">{error}<button onClick={() => setError('')} aria-label="Tutup pesan"><X size={13} /></button></div>}
          <div className="studio-composer-area">
            {activeConversation?.project_id && <div className="studio-context-pill"><FolderOpen size={13} /> {projects.find((project) => project.id === activeConversation.project_id)?.name || 'Proyek terkait'}</div>}
            {attachments.length > 0 && (
              <div className="studio-attachments">
                {attachments.map((attachment) => <div className="studio-attachment-chip" key={attachment.id}>
                  {attachment.type.startsWith('image/') ? <img src={attachment.url} alt={attachment.name} /> : attachment.type.startsWith('video/') ? <video src={attachment.url} muted /> : <Paperclip size={13} />}
                  <span className="studio-attachment-name">{attachment.name}<small>{formatBytes(attachment.size)}</small></span>
                  <button type="button" onClick={() => removeAttachment(attachment.id)} aria-label={`Hapus ${attachment.name}`}><X size={11} /></button>
                </div>)}
              </div>
            )}
            <form className="studio-composer" onSubmit={saveMessage}><textarea ref={draftRef} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={providerStatus?.configured ? 'Tanya tentang idemu...' : 'Tulis ide atau prompt untuk disimpan...'} rows={1} maxLength={20000} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} aria-label="Tulis pesan" /><div className="studio-composer-bottom"><span className="studio-composer-hint"><button type="button" className="studio-upload-button" onClick={() => fileInputRef.current?.click()} disabled={sending || uploading} aria-label="Unggah foto, video, atau file"><Paperclip size={15} /></button>{providerStatus?.configured && <div className="studio-model-wrap"><button type="button" className={`studio-model-pill ${modelOpen ? 'is-open' : ''}`} onClick={() => setModelOpen((open) => !open)} aria-label="Pilih model" aria-expanded={modelOpen}><Cpu size={13} /> {selectedModel} <ChevronDown size={12} /></button>{modelOpen && <div className="studio-model-popover"><div className="studio-model-popover-head"><b>Model tersedia</b><small>{enabledModels.length ? `${enabledModels.length} model aktif · UnoRouter` : `${models.length} model gratis · UnoRouter`}</small></div><select value={selectedModel} onChange={(event) => { setSelectedModel(event.target.value); setModelOpen(false); }} aria-label="Pilih model">{enabledModels.length ? enabledModels.map((model) => <option key={model} value={model}>{model}</option>) : models.map((model) => <option key={model} value={model}>{model}</option>)}</select></div>}</div>}{sending ? <><span className="studio-send-loader" /> Menghubungkan AI...</> : sendingWeb ? <><span className="studio-send-loader" /> Mencari di web...</> : providerStatus?.configured ? 'Tekan Enter untuk kirim · foto/video/file sampai 30MB' : <><Sparkles size={12} /> Mode pratinjau — pesan disimpan, jawaban AI belum aktif</>}</span><button type="button" className={`studio-composer-tool ${connectionsOpen ? 'is-on' : ''}`} onClick={() => setConnectionsOpen((open) => !open)} aria-label="Koneksi agen" aria-expanded={connectionsOpen}><Network size={14} /> Koneksi</button><button type="submit" disabled={(!draft.trim() && !attachments.length) || sending} aria-label={providerStatus?.configured ? 'Kirim pesan' : 'Simpan pesan'}>{sending ? <span className="studio-send-loader" /> : <><span>{providerStatus?.configured ? 'Kirim' : 'Simpan'}</span><Send size={14} /></>}</button></div><input ref={fileInputRef} type="file" multiple className="studio-file-input" accept="image/*,video/*,audio/*,.pdf,.zip,.txt,.md,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.json" onChange={attachFiles} /></form>
            {connectionsOpen && <div className="studio-connections">
              <div className="studio-connections-head">
                <span>Koneksi agen</span>
                <span className={`studio-connections-status ${webSearchEnabled ? 'is-on' : ''}`}>{webSearchEnabled ? 'Akses web aktif' : 'Akses web nonaktif'}</span>
              </div>
              <div className="studio-connections-row">
                <button type="button" className={`studio-conn-chip ${webSearchEnabled ? 'is-on' : ''}`} onClick={() => setWebSearchEnabled((enabled) => !enabled)} aria-pressed={webSearchEnabled}><Globe size={12} /> Akses web <i /></button>
                <button type="button" className={`studio-conn-chip ${appConnections.notion ? 'is-on' : ''}`} onClick={() => handleAppChipClick('notion')} disabled={appConnecting === 'notion'} aria-pressed={appConnections.notion}>{appConnecting === 'notion' ? <span className="studio-send-loader" /> : <BookOpen size={12} />} Notion{appConnections.notion && <i />}</button>
                <button type="button" className={`studio-conn-chip ${appConnections.slack ? 'is-on' : ''}`} onClick={() => handleAppChipClick('slack')} disabled={appConnecting === 'slack'} aria-pressed={appConnections.slack}>{appConnecting === 'slack' ? <span className="studio-send-loader" /> : <Slack size={12} />} Slack{appConnections.slack && <i />}</button>
                <button type="button" className={`studio-conn-chip ${appConnections.github ? 'is-on' : ''}`} onClick={() => handleAppChipClick('github')} disabled={appConnecting === 'github'} aria-pressed={appConnections.github}>{appConnecting === 'github' ? <span className="studio-send-loader" /> : <Github size={12} />} GitHub{appConnections.github && <i />}</button>
              </div>
              <div className="studio-repos">
                <span className="studio-repos-label">REPO TERHUBUNG</span>
                {repoConnected ? (connectedRepo ? <div className="studio-repo-item"><button type="button" className="studio-repo-icon-btn" onClick={() => setRepoConnected(false)} aria-label="Putus koneksi repo"><Github size={14} /></button><div><b>{connectedRepo.fullName}</b><small>{connectedRepo.defaultBranch}</small></div><button type="button" className="studio-repo-disconnect" onClick={() => setRepoConnected(false)}>Putus</button></div> : <div className="studio-repo-item is-loading"><span className="studio-repo-icon"><GitBranch size={14} /></span><div><b>Menunggu info repo…</b></div></div>) : <div className="studio-repo-item is-disconnected"><button type="button" className="studio-repo-icon-btn" onClick={reconnectRepo} disabled={repoConnecting} aria-label="Koneksi ulang repo">{repoConnecting ? <span className="studio-send-loader" /> : <Github size={14} />}</button><div><b>Repo tidak terhubung</b><small>Koneksi ulang menggunakan autentikasi akunmu</small></div><button type="button" className="studio-repo-reconnect" onClick={reconnectRepo} disabled={repoConnecting}>{repoConnecting ? 'Menghubungkan…' : 'Koneksi ulang'}</button></div>}
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
        <div className="studio-consent-account"><span>Akun</span><b>{fullName} · {user?.email || '—'}</b></div>
        <div className="studio-consent-permissions">
          <div className="studio-consent-perm"><Check size={12} /><span>Akses repository (read)</span></div>
          <div className="studio-consent-perm"><Check size={12} /><span>Profil pengguna (read)</span></div>
        </div>
        <div><button className="studio-cancel-button" onClick={() => setConsentApp(null)}>Batal</button><button className="studio-consent-approve" onClick={() => approveConsent(consentApp)}>Setujui &amp; Hubungkan</button></div>
      </section></div>}
      </div>
    </DropXLayout>
  );
}
