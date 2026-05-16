// ============================================================
// MrWiseMax — Chat System
// Depends on: window.db, window.App, window.UI
// ============================================================

const Chat = (() => {
  'use strict';

  // ── State ─────────────────────────────────────────────────
  let contacts        = [];     // { user_id, contact_id, category, profile }
  let conversations   = [];     // { id, user1_id, user2_id, otherProfile, lastMessage }
  let activeConvId    = null;
  let activeOtherUser = null;   // { id, username, nickname, avatar_url, avatar_url_storage }
  let realtimeSub     = null;
  let contactFilter   = 'all';  // 'all' | 'primary' | 'general'
  let contactSearch   = '';

  // ── Public API ────────────────────────────────────────────

  async function init() {
    await Promise.all([loadContacts(), loadConversations()]);
    renderContactList();
    renderChatPlaceholder();
    wireSearchInput();
  }

  // Called from community page / user search when clicking "Message"
  async function startChat(userId, displayName, username) {
    // Add to contacts if not already there
    await ensureContact(userId);
    // Navigate to messages section
    navigateTo('messages');
    // Open conversation with this user
    await openConversation({ id: userId, username, nickname: displayName, avatar_url: null, avatar_url_storage: null });
  }

  // ── Data ──────────────────────────────────────────────────

  async function loadContacts() {
    const { data } = await db.from('contacts')
      .select('*, profiles!contacts_contact_id_fkey(id, username, nickname, avatar_url, avatar_url_storage)')
      .eq('user_id', App.user.id)
      .order('created_at', { ascending: false });
    contacts = (data || []).map(c => ({ ...c, profile: c.profiles }));
  }

  async function loadConversations() {
    const uid = App.user.id;
    const { data } = await db.from('conversations')
      .select('*')
      .or(`user1_id.eq.${uid},user2_id.eq.${uid}`)
      .order('created_at', { ascending: false });

    if (!data?.length) { conversations = []; return; }

    // Fetch other participants' profiles
    const otherIds = data.map(c => c.user1_id === uid ? c.user2_id : c.user1_id);
    const uniq = [...new Set(otherIds)];
    const { data: profiles } = await db.from('profiles')
      .select('id, username, nickname, avatar_url, avatar_url_storage')
      .in('id', uniq);
    const pMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));

    // Fetch last message for each conversation
    const convIds = data.map(c => c.id);
    const { data: lastMsgs } = await db.from('messages')
      .select('conversation_id, content, created_at, sender_id')
      .in('conversation_id', convIds)
      .order('created_at', { ascending: false });

    const lastMsgMap = {};
    (lastMsgs || []).forEach(m => {
      if (!lastMsgMap[m.conversation_id]) lastMsgMap[m.conversation_id] = m;
    });

    conversations = data.map(c => ({
      ...c,
      otherProfile: pMap[c.user1_id === uid ? c.user2_id : c.user1_id] || null,
      lastMessage:  lastMsgMap[c.id] || null,
    }));
  }

  async function loadMessages(convId) {
    const { data } = await db.from('messages')
      .select('*')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: true })
      .limit(100);
    return data || [];
  }

  // ── Render ────────────────────────────────────────────────

  function renderContactList() {
    const el = document.getElementById('chat-contact-list');
    if (!el) return;

    const uid = App.user.id;
    const query = contactSearch.toLowerCase();

    // Merge contacts and conversations, de-duped by other user ID
    const seen = new Set();
    const items = [];

    // First: contacts (have explicit category)
    contacts.forEach(c => {
      const p = c.profile;
      if (!p) return;
      if (query && !p.username?.toLowerCase().includes(query) && !(p.nickname || '').toLowerCase().includes(query)) return;
      if (contactFilter !== 'all' && c.category !== contactFilter) return;
      if (seen.has(p.id)) return;
      seen.add(p.id);

      const conv = conversations.find(cv => cv.otherProfile?.id === p.id);
      items.push({ profile: p, category: c.category, lastMessage: conv?.lastMessage || null, convId: conv?.id || null });
    });

    // Then: conversations with non-contact users
    conversations.forEach(cv => {
      const p = cv.otherProfile;
      if (!p || seen.has(p.id)) return;
      if (query && !p.username?.toLowerCase().includes(query) && !(p.nickname || '').toLowerCase().includes(query)) return;
      if (contactFilter !== 'all') return; // non-contacts only show in 'all'
      seen.add(p.id);
      items.push({ profile: p, category: 'general', lastMessage: cv.lastMessage, convId: cv.id });
    });

    if (!items.length) {
      el.innerHTML = `<div class="chat-empty-contacts">
        ${query ? `No contacts match "${query}"` : 'No conversations yet.<br>Search for a user to start chatting.'}
      </div>`;
      return;
    }

    el.innerHTML = items.map(item => {
      const p    = item.profile;
      const name = p.nickname || p.username || 'User';
      const av   = p.avatar_url_storage || p.avatar_url;
      const isActive = item.convId === activeConvId;
      const lastMsg  = item.lastMessage
        ? (item.lastMessage.sender_id === uid ? 'You: ' : '') + item.lastMessage.content.slice(0, 40) + (item.lastMessage.content.length > 40 ? '…' : '')
        : 'Say hello!';
      const isPrimary = item.category === 'primary';

      return `<div class="chat-contact-item ${isActive ? 'active' : ''}" onclick="Chat.openConversationById('${p.id}')">
        <div class="chat-contact-avatar">${av ? `<img src="${av}" alt="${name}">` : UI.avatarInitials(name)}</div>
        <div class="chat-contact-info">
          <div class="chat-contact-top">
            <span class="chat-contact-name">${name}</span>
            ${isPrimary ? '<span class="chat-primary-badge">Primary</span>' : ''}
          </div>
          <span class="chat-contact-last">${lastMsg}</span>
        </div>
      </div>`;
    }).join('');
  }

  function renderChatPlaceholder() {
    const win = document.getElementById('chat-window');
    if (!win) return;
    win.innerHTML = `<div class="chat-placeholder">
      <div class="chat-placeholder-icon">💬</div>
      <p>Select a conversation or search for a user to start chatting.</p>
    </div>`;
  }

  async function renderMessages() {
    const win = document.getElementById('chat-window');
    if (!win || !activeConvId || !activeOtherUser) return;

    const messages = await loadMessages(activeConvId);
    const uid      = App.user.id;
    const name     = activeOtherUser.nickname || activeOtherUser.username || 'User';
    const av       = activeOtherUser.avatar_url_storage || activeOtherUser.avatar_url;

    // Find contact entry for category management
    const contactEntry = contacts.find(c => c.contact_id === activeOtherUser.id);
    const category     = contactEntry?.category || 'general';

    win.innerHTML = `
      <div class="chat-header">
        <div class="chat-header-user" onclick="Chat.openConversationById('${activeOtherUser.id}')">
          <div class="chat-header-avatar">${av ? `<img src="${av}" alt="${name}">` : UI.avatarInitials(name)}</div>
          <div>
            <span class="chat-header-name">${name}</span>
            <span class="chat-header-handle">@${activeOtherUser.username}</span>
          </div>
        </div>
        <select class="chat-category-select" onchange="Chat.setCategory('${activeOtherUser.id}', this.value)" title="List category">
          <option value="general" ${category === 'general' ? 'selected' : ''}>General</option>
          <option value="primary" ${category === 'primary' ? 'selected' : ''}>Primary</option>
        </select>
      </div>
      <div class="chat-messages" id="chat-messages-list">
        ${messages.length
          ? messages.map(m => msgBubble(m, uid)).join('')
          : '<div class="chat-no-messages">No messages yet. Say hi! 👋</div>'}
      </div>
      <div class="chat-input-row">
        <input type="text" class="chat-input" id="chat-msg-input"
               placeholder="Type a message…" maxlength="2000"
               onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();Chat.send();}">
        <button class="btn btn-primary btn-sm" onclick="Chat.send()">Send</button>
      </div>`;

    scrollToBottom();
    subscribeToConversation(activeConvId);
  }

  function msgBubble(m, myId) {
    const isMine = m.sender_id === myId;
    return `<div class="chat-msg ${isMine ? 'mine' : 'theirs'}">
      <div class="chat-bubble">${escapeHtml(m.content)}</div>
      <div class="chat-msg-time">${UI.timeAgo(m.created_at)}</div>
    </div>`;
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function scrollToBottom() {
    const el = document.getElementById('chat-messages-list');
    if (el) setTimeout(() => { el.scrollTop = el.scrollHeight; }, 50);
  }

  // ── Actions ───────────────────────────────────────────────

  async function openConversationById(userId) {
    // Look up profile from contacts or conversations
    let profile = contacts.find(c => c.contact_id === userId)?.profile
               || conversations.find(cv => cv.otherProfile?.id === userId)?.otherProfile;

    // Fallback: fetch from DB
    if (!profile) {
      const { data } = await db.from('profiles')
        .select('id, username, nickname, avatar_url, avatar_url_storage')
        .eq('id', userId).single();
      profile = data;
    }

    if (profile) await openConversation(profile);
  }

  async function openConversation(profile) {
    activeOtherUser = profile;

    // Get or create conversation
    const { data: convId, error } = await db.rpc('get_or_create_conversation', { other_user_id: profile.id });
    if (error) { UI.toast('Could not open conversation.', 'error'); return; }

    activeConvId = convId;

    // Ensure they're in our conversations list
    if (!conversations.find(c => c.id === convId)) {
      await loadConversations();
    }

    renderContactList();
    await renderMessages();
  }

  async function ensureContact(userId) {
    if (contacts.find(c => c.contact_id === userId)) return;
    await db.from('contacts').upsert([{ user_id: App.user.id, contact_id: userId, category: 'general' }], { onConflict: 'user_id,contact_id' });
    await loadContacts();
  }

  async function send() {
    const input   = document.getElementById('chat-msg-input');
    const content = input?.value.trim();
    if (!content || !activeConvId) return;
    input.value = '';

    const { error } = await db.from('messages').insert([{
      conversation_id: activeConvId,
      sender_id:       App.user.id,
      content,
    }]);
    if (error) { UI.toast('Could not send message.', 'error'); input.value = content; }
  }

  async function setCategory(userId, category) {
    await db.from('contacts').upsert(
      [{ user_id: App.user.id, contact_id: userId, category }],
      { onConflict: 'user_id,contact_id' }
    );
    const entry = contacts.find(c => c.contact_id === userId);
    if (entry) entry.category = category;
    else await loadContacts();
    renderContactList();
    UI.toast(`Moved to ${category === 'primary' ? 'Primary' : 'General'}.`, 'success');
  }

  // ── Realtime ──────────────────────────────────────────────

  function subscribeToConversation(convId) {
    if (realtimeSub) { db.removeChannel(realtimeSub); realtimeSub = null; }

    realtimeSub = db.channel(`conv-${convId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'messages',
        filter: `conversation_id=eq.${convId}`,
      }, async (payload) => {
        const list = document.getElementById('chat-messages-list');
        if (!list) return;

        const m  = payload.new;
        const el = document.createElement('div');
        el.innerHTML = msgBubble(m, App.user.id);
        list.appendChild(el.firstElementChild);
        scrollToBottom();

        // Update last message in conversations list
        const cv = conversations.find(c => c.id === convId);
        if (cv) cv.lastMessage = m;
        renderContactList();
      })
      .subscribe();
  }

  // ── Filter & Search ───────────────────────────────────────

  function setFilter(filter) {
    contactFilter = filter;
    document.querySelectorAll('.chat-filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === filter);
    });
    renderContactList();
  }

  function wireSearchInput() {
    const input = document.getElementById('chat-search-input');
    if (!input || input.dataset.wired) return;
    input.dataset.wired = '1';
    input.addEventListener('input', () => { contactSearch = input.value; renderContactList(); });
  }

  // ── Public exports ────────────────────────────────────────
  return { init, startChat, openConversationById, openConversation, send, setCategory, setFilter, ensureContact };
})();
