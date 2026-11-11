import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, ChevronDown, Command, Cpu, FolderOpen, Layers3, LogOut, MessageSquarePlus, MoreHorizontal, Paperclip, Plus, Send, Settings2, ShieldCheck, Sparkles, Trash2, WandSparkles, X } from 'lucide-react';
import { Brand } from '../components/Brand';
import { supabase } from '../lib/supabase';
import { chatCompletion, fetchEnabledModels, fetchFreeModels, fetchProviderStatus } from '../api/unorouter';
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

export function AIStudio() {
  const { user } = useAuth();
  const navigate = useNavigate();
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
  const [profileMenu, setProfileMenu] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const endOfMessages = useRef(null);
  const draftRef = useRef(null);
  const sendingRef = useRef(false);
  const fileInputRef = useRef(null);
  const activeConversation = useMemo(() => conversations.find((conversation) => conversation.id === activeId) || null, [conversations, activeId]);
  const fullName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Kreator';
  const initials = fullName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  const isAdmin = user?.app_metadata?.role === 'admin';

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
        const status = await fetchProviderStatus();
        if (cancelled) return;
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

      const history = [...messages, { role: 'user', content: buildMessageContent(content, attachments) }]
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

  async function signOut() {
    setSigningOut(true);
    await supabase.auth.signOut();
    navigate('/login', { replace: true });
  }

  function insertPrompt(prompt) {
    setDraft(prompt);
    draftRef.current?.focus();
  }

  return (
    <div className="studio-shell studio-ready">
      <aside className="studio-sidebar">
        <div className="studio-brand"><Brand /></div>
        <div className="studio-workspace"><span><Sparkles size={14} /></span><div><b>Ruang pribadi</b><small>AI Studio · UnoRouter</small></div></div>
        <button className="studio-new-chat" onClick={startNewConversation}><MessageSquarePlus size={15} /> Percakapan baru <Plus size={15} /></button>
        <nav className="studio-primary-nav" aria-label="Navigasi workspace"><Link to="/app"><Command size={15} /> Ringkasan</Link><Link to="/projects"><Layers3 size={15} /> Proyek</Link>{isAdmin && <Link to="/admin"><ShieldCheck size={15} /> Admin panel</Link>}</nav>
        <div className="studio-history-heading"><span>RIWAYAT</span><span>{conversations.length}</span></div>
        <div className="studio-history-list">
          {loadingHistory ? <div className="studio-history-loading">Memuat riwayat...</div> : conversations.length ? conversations.map((conversation) => <div key={conversation.id} className={`studio-history-item ${activeId === conversation.id ? 'active' : ''}`}><button className="studio-history-select" onClick={() => { setActiveId(conversation.id); setError(''); }}><span className="history-message-icon"><MessageSquarePlus size={14} /></span><span><b>{conversation.title}</b><small>{new Date(conversation.updated_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })}</small></span></button><button className="studio-history-delete" onClick={() => setDeleteTarget(conversation)} aria-label={`Hapus percakapan ${conversation.title}`}><Trash2 size={13} /></button></div>) : <p className="studio-history-empty">Percakapan yang kamu simpan akan muncul di sini.</p>}
        </div>
        <div className="studio-sidebar-bottom">
          <Link to="/settings"><Settings2 size={14} /> Pengaturan akun</Link>
          <button className="studio-profile-button" onClick={() => setProfileMenu(!profileMenu)} aria-expanded={profileMenu}><i>{initials}</i><span><b>{fullName}</b><small>{user?.email}</small></span><MoreHorizontal size={16} /></button>
          {profileMenu && <div className="studio-profile-menu"><div>{user?.email}</div><button onClick={signOut} disabled={signingOut}><LogOut size={13} /> {signingOut ? 'Keluar...' : 'Keluar akun'}</button></div>}
        </div>
      </aside>

      <main className="studio-main">
        <header className="studio-topbar"><div className="studio-breadcrumb"><span>BLEA AI</span><span>/</span><b>AI Studio</b>{activeConversation && <><span>/</span><b className="studio-current-title">{activeConversation.title}</b></>}</div><div className="studio-top-actions"><span className={`studio-status ${providerStatus?.configured ? 'is-live' : 'is-preview'}`}><i /> {providerStatus?.configured ? `UNO · ${selectedModel}` : 'MODEL BELUM TERHUBUNG'}</span><Link to="/app" aria-label="Kembali ke dashboard"><ArrowUpRight size={15} /></Link></div></header>
        <div className="studio-content">
          <div className={`studio-conversation ${messages.length ? 'has-messages' : ''}`}>
            {messages.length === 0 && !loadingMessages ? <div className="studio-welcome"><div className="studio-welcome-icon"><WandSparkles size={22} /></div><span className="studio-eyebrow">BLEA AI STUDIO</span><h1>{activeConversation ? 'Lanjutkan idemu.' : <>Satu ruang untuk<br /><em>pikiran besarmu.</em></>}</h1><p>{providerStatus?.configured ? 'Tanya apa saja tentang idemu. Jawaban AI aktif dengan model teks gratis UnoRouter; riwayat tersimpan di akunmu.' : 'Catat prompt dan ide di sini. Riwayat tersimpan di akunmu; jawaban AI aktif setelah admin menghubungkan API key di panel admin.'}</p><div className="studio-prompt-chips">{prompts.map((prompt) => <button key={prompt} onClick={() => insertPrompt(prompt)}>{prompt}<ArrowUpRight size={13} /></button>)}</div></div> : <div className="studio-message-list">{loadingMessages && <div className="studio-message-loading">Memuat percakapan...</div>}{messages.map((message) => <article className={`studio-message ${message.role === 'user' ? 'from-user' : 'from-assistant'}`} key={message.id}><span className="studio-message-avatar">{message.role === 'user' ? initials.slice(0, 1) : <Sparkles size={13} />}</span><div className="studio-message-body"><div className="studio-message-meta"><b>{message.role === 'user' ? fullName : 'BLEA AI'}</b><time>{formatTime(message.created_at)}</time></div><p>{message.content}</p></div></article>)}<div ref={endOfMessages} /></div>}
          </div>
          {activeConversation && messages.length > 0 && !providerStatus?.configured && <div className="studio-not-connected"><Sparkles size={14} /><span><b>Mode pratinjau.</b> Pesanmu tersimpan, tetapi AI belum membalas karena provider model belum dihubungkan.</span></div>}
          {error && <div className="studio-error" role="alert">{error}<button onClick={() => setError('')} aria-label="Tutup pesan"><X size={13} /></button></div>}
          <div className="studio-composer-area">
            {!activeConversation && projects.length > 0 && <label className="studio-project-context"><FolderOpen size={14} /><span>Tambahkan ke proyek</span><select value={selectedProject} onChange={(event) => setSelectedProject(event.target.value)}><option value="">Tanpa proyek</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><ChevronDown size={12} /></label>}
            {activeConversation?.project_id && <div className="studio-context-pill"><FolderOpen size={13} /> {projects.find((project) => project.id === activeConversation.project_id)?.name || 'Proyek terkait'}</div>}
            {providerStatus?.configured && <div className="studio-model-block">
              <div className="studio-model-block-head">
                <span className="studio-model-block-icon"><Cpu size={14} /></span>
                <div><b>Model tersedia</b><small>{enabledModels.length ? `${enabledModels.length} model aktif · UnoRouter` : `${models.length} model gratis · UnoRouter`}</small></div>
              </div>
              <div className="studio-model-block-select">
                <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} aria-label="Pilih model">{enabledModels.length ? enabledModels.map((model) => <option key={model} value={model}>{model}</option>) : models.map((model) => <option key={model} value={model}>{model}</option>)}</select>
                <ChevronDown size={13} />
              </div>
            </div>}
            {attachments.length > 0 && (
              <div className="studio-attachments">
                {attachments.map((attachment) => <div className="studio-attachment-chip" key={attachment.id}>
                  {attachment.type.startsWith('image/') ? <img src={attachment.url} alt={attachment.name} /> : attachment.type.startsWith('video/') ? <video src={attachment.url} muted /> : <Paperclip size={13} />}
                  <span className="studio-attachment-name">{attachment.name}<small>{formatBytes(attachment.size)}</small></span>
                  <button type="button" onClick={() => removeAttachment(attachment.id)} aria-label={`Hapus ${attachment.name}`}><X size={11} /></button>
                </div>)}
              </div>
            )}
            <form className="studio-composer" onSubmit={saveMessage}><textarea ref={draftRef} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={providerStatus?.configured ? 'Tanya tentang idemu...' : 'Tulis ide atau prompt untuk disimpan...'} rows={1} maxLength={20000} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} aria-label="Tulis pesan" /><div className="studio-composer-bottom"><span className="studio-composer-hint"><button type="button" className="studio-upload-button" onClick={() => fileInputRef.current?.click()} disabled={sending || uploading} aria-label="Unggah foto, video, atau file"><Paperclip size={15} /></button>{sending ? <><span className="studio-send-loader" /> Menghubungkan AI...</> : providerStatus?.configured ? 'Tekan Enter untuk kirim · foto/video/file sampai 30MB' : <><Sparkles size={12} /> Mode pratinjau — pesan disimpan, jawaban AI belum aktif</>}</span><button type="submit" disabled={(!draft.trim() && !attachments.length) || sending} aria-label={providerStatus?.configured ? 'Kirim pesan' : 'Simpan pesan'}>{sending ? <span className="studio-send-loader" /> : <><span>{providerStatus?.configured ? 'Kirim' : 'Simpan'}</span><Send size={14} /></>}</button></div><input ref={fileInputRef} type="file" multiple className="studio-file-input" accept="image/*,video/*,audio/*,.pdf,.zip,.txt,.md,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.json" onChange={attachFiles} /></form>
            <div className="studio-privacy-note"><ShieldCheck size={12} /> Riwayat hanya dapat diakses oleh akunmu. <Link to="/projects">Kelola proyek <ArrowRight size={11} /></Link></div>
          </div>
        </div>
      </main>

      {deleteTarget && <div className="studio-modal-backdrop"><section className="studio-delete-modal" role="dialog" aria-modal="true" aria-labelledby="studio-delete-title"><span className="studio-delete-icon"><Trash2 size={18} /></span><h2 id="studio-delete-title">Hapus percakapan?</h2><p>“{deleteTarget.title}” dan seluruh riwayat pesan di dalamnya akan dihapus.</p><div><button className="studio-cancel-button" onClick={() => setDeleteTarget(null)}>Batal</button><button className="studio-delete-confirm" onClick={deleteConversation} disabled={deleting}>{deleting ? 'Menghapus...' : 'Hapus percakapan'}</button></div></section></div>}
    </div>
  );
}
