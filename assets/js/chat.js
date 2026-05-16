// ============================================================
// MrWiseMax — Chat System
// Depends on: window.db, window.App, window.UI
// ============================================================

const Chat = (() => {
  'use strict';

  // ── State ─────────────────────────────────────────────────
  let contacts        = [];
  let conversations   = [];
  let activeConvId    = null;
  let activeOtherUser = null;
  let contactFilter   = 'all';
  let contactSearch   = '';
  let timeUpdateInterval = null;

  // One WebSocket channel per conversation (conv_id → channel)
  // NOTE: Supabase Realtime postgres_changes only supports `eq` as a filter
  // operator — `in` is not valid. We therefore create one channel per
  // conversation so every subscription uses `conversation_id=eq.<id>`.
  const convChannels = new Map();

  // Conversations with unread messages from PRIMARY contacts
  const unreadPrimaryConvIds = new Set();

  // ── Public API ────────────────────────────────────────────

  // Called once at dashboard startup — starts background badge tracking
  async function initGlobal() {
    try {
      await Promise.all([loadContacts(), loadConversations()]);
      syncConvSubscriptions();
    } catch (_) { /* non-critical on startup */ }
  }

  // Called when the user opens the messages section
  async function init() {
    await Promise.all([loadContacts(), loadConversations()]);
    renderContactList();
    renderChatPlaceholder();
    wireSearchInput();
    syncConvSubscriptions();
    startTimeUpdater();
  }

  // Called from community / user search → "Message" button
  async function startChat(userId, displayName, username) {
    await ensureContact(userId);
    navigateTo('messages');
    await openConversation({
      id: userId, username, nickname: displayName,
      avatar_url: null, avatar_url_storage: null,
    });
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

    const otherIds = [...new Set(data.map(c => c.user1_id === uid ? c.user2_id : c.user1_id))];
    const { data: profiles } = await db.from('profiles')
      .select('id, username, nickname, avatar_url, avatar_url_storage')
      .in('id', otherIds);
    const pMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));

    const { data: lastMsgs } = await db.from('messages')
      .select('conversation_id, content, created_at, sender_id')
      .in('conversation_id', data.map(c => c.id))
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

    const uid   = App.user.id;
    const query = contactSearch.toLowerCase();
    const seen  = new Set();
    const items = [];

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

    conversations.forEach(cv => {
      const p = cv.otherProfile;
      if (!p || seen.has(p.id)) return;
      if (query && !p.username?.toLowerCase().includes(query) && !(p.nickname || '').toLowerCase().includes(query)) return;
      if (contactFilter !== 'all') return;
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
      const p         = item.profile;
      const name      = p.nickname || p.username || 'User';
      const av        = p.avatar_url_storage || p.avatar_url;
      const isActive  = item.convId === activeConvId;
      const hasUnread = item.convId ? unreadPrimaryConvIds.has(item.convId) : false;
      const isPrimary = item.category === 'primary';
      const lastMsg   = item.lastMessage
        ? (item.lastMessage.sender_id === uid ? 'You: ' : '') +
          item.lastMessage.content.slice(0, 40) +
          (item.lastMessage.content.length > 40 ? '…' : '')
        : 'Say hello!';

      return `<div class="chat-contact-item ${isActive ? 'active' : ''} ${hasUnread ? 'has-unread' : ''}"
                   onclick="Chat.openConversationById('${p.id}')">
        <div class="chat-contact-avatar">${av ? `<img src="${av}" alt="${name}">` : UI.avatarInitials(name)}</div>
        <div class="chat-contact-info">
          <div class="chat-contact-top">
            <span class="chat-contact-name">${name}</span>
            ${isPrimary ? '<span class="chat-primary-badge">Primary</span>' : ''}
          </div>
          <span class="chat-contact-last">${lastMsg}</span>
        </div>
        ${hasUnread ? '<span class="chat-unread-dot"></span>' : ''}
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
    const contact  = contacts.find(c => c.contact_id === activeOtherUser.id);
    const category = contact?.category ?? 'primary';

    win.innerHTML = `
      <div class="chat-header">
        <div class="chat-header-user" onclick="Chat.openConversationById('${activeOtherUser.id}')">
          <div class="chat-header-avatar">${av ? `<img src="${av}" alt="${name}">` : UI.avatarInitials(name)}</div>
          <div>
            <span class="chat-header-name">${name}</span>
            <span class="chat-header-handle">@${activeOtherUser.username}</span>
          </div>
        </div>
        <select class="chat-category-select"
                onchange="Chat.setCategory('${activeOtherUser.id}', this.value)"
                title="List category">
          <option value="primary" ${category === 'primary' ? 'selected' : ''}>Primary</option>
          <option value="general" ${category === 'general' ? 'selected' : ''}>General</option>
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
  }

  function msgBubble(m, myId) {
    const isMine = m.sender_id === myId;
    return `<div class="chat-msg ${isMine ? 'mine' : 'theirs'}">
      <div class="chat-bubble">${escapeHtml(m.content)}</div>
      <div class="chat-msg-time" data-ts="${m.created_at}">${UI.timeAgo(m.created_at)}</div>
    </div>`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function scrollToBottom() {
    const el = document.getElementById('chat-messages-list');
    if (el) setTimeout(() => { el.scrollTop = el.scrollHeight; }, 50);
  }

  // ── Actions ───────────────────────────────────────────────

  async function openConversationById(userId) {
    let profile = contacts.find(c => c.contact_id === userId)?.profile
               || conversations.find(cv => cv.otherProfile?.id === userId)?.otherProfile;
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

    const { data: convId, error } = await db.rpc('get_or_create_conversation', { other_user_id: profile.id });
    if (error) { UI.toast('Could not open conversation.', 'error'); return; }

    activeConvId = convId;
    markRead(convId);

    // If this is a new conversation, refresh list and add its subscription
    if (!conversations.find(c => c.id === convId)) {
      await loadConversations();
      syncConvSubscriptions();
    }

    renderContactList();
    await renderMessages();
  }

  async function ensureContact(userId) {
    if (contacts.find(c => c.contact_id === userId)) return;
    // Default to 'primary' so new chats show badge notifications immediately
    await db.from('contacts').upsert(
      [{ user_id: App.user.id, contact_id: userId, category: 'primary' }],
      { onConflict: 'user_id,contact_id' }
    );
    await loadContacts();
  }

  async function send() {
    const input   = document.getElementById('chat-msg-input');
    const content = input?.value.trim();
    if (!content || !activeConvId) return;
    input.value = '';

    const { data: msg, error } = await db.from('messages')
      .insert([{ conversation_id: activeConvId, sender_id: App.user.id, content }])
      .select()
      .single();

    if (error) {
      UI.toast('Could not send message.', 'error');
      input.value = content;
      return;
    }

    // Append own message to UI immediately (optimistic)
    const list = document.getElementById('chat-messages-list');
    if (list) {
      list.querySelector('.chat-no-messages')?.remove();
      const el = document.createElement('div');
      el.innerHTML = msgBubble(msg, App.user.id);
      list.appendChild(el.firstElementChild);
      scrollToBottom();
    }

    const cv = conversations.find(c => c.id === activeConvId);
    if (cv) cv.lastMessage = msg;
    renderContactList();
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

  // ── Realtime WebSocket Subscriptions ──────────────────────
  //
  // Supabase Realtime postgres_changes supports ONLY `eq` as a row filter
  // operator. The `in` operator does not work. We therefore open one channel
  // per conversation — each using `conversation_id=eq.<id>` — and keep them
  // in `convChannels` so we never create duplicates and can tear them down
  // cleanly when conversations are removed.

  function syncConvSubscriptions() {
    const currentIds = new Set(conversations.map(c => c.id));

    // Remove channels for conversations no longer in our list
    for (const [id, ch] of convChannels) {
      if (!currentIds.has(id)) {
        db.removeChannel(ch);
        convChannels.delete(id);
      }
    }

    // Open a channel for each conversation we don't have one for yet
    for (const conv of conversations) {
      if (convChannels.has(conv.id)) continue;
      const ch = db
        .channel(`conv-msg-${conv.id}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'messages',
            filter: `conversation_id=eq.${conv.id}`,
          },
          handleIncomingMessage
        )
        .subscribe();
      convChannels.set(conv.id, ch);
    }
  }

  function handleIncomingMessage(payload) {
    const m           = payload.new;
    const convId      = m.conversation_id;
    const isMyMessage = m.sender_id === App.user.id;

    // Update last-message preview in state
    const cv = conversations.find(c => c.id === convId);
    if (cv) cv.lastMessage = m;

    const section       = document.getElementById('section-messages');
    const isChatVisible = section?.classList.contains('active') ?? false;

    // Append incoming message to the open chat window (not our own — those are
    // already appended optimistically in send())
    if (!isMyMessage && convId === activeConvId && isChatVisible) {
      const list = document.getElementById('chat-messages-list');
      if (list) {
        list.querySelector('.chat-no-messages')?.remove();
        const el = document.createElement('div');
        el.innerHTML = msgBubble(m, App.user.id);
        list.appendChild(el.firstElementChild);
        scrollToBottom();
      }
    }

    // Refresh contact-list preview while on the messages page
    if (isChatVisible) renderContactList();

    // Badge: increment only when the messages page is NOT visible AND
    // the sender is in our PRIMARY contacts list
    if (!isMyMessage && !isChatVisible) {
      const contact = contacts.find(c => c.contact_id === m.sender_id);
      if (contact?.category === 'primary') {
        unreadPrimaryConvIds.add(convId);
        updateBadge();
      }
    }
  }

  function markRead(convId) {
    if (unreadPrimaryConvIds.delete(convId)) updateBadge();
  }

  function updateBadge() {
    const btn = document.querySelector('.topbar-messages-btn');
    if (!btn) return;
    btn.querySelector('.msg-badge')?.remove();
    const count = unreadPrimaryConvIds.size;
    if (count > 0) {
      const badge = document.createElement('span');
      badge.className   = 'msg-badge';
      badge.textContent = count > 99 ? '99+' : String(count);
      btn.appendChild(badge);
    }
  }

  // ── Timestamp Updater ─────────────────────────────────────
  // Ticks every 60 s while the messages section is open.
  // Only updates elements already rendered in #chat-messages-list.

  function startTimeUpdater() {
    if (timeUpdateInterval) return;
    timeUpdateInterval = setInterval(() => {
      document.querySelectorAll('#chat-messages-list .chat-msg-time[data-ts]')
        .forEach(el => { el.textContent = UI.timeAgo(el.dataset.ts); });
    }, 60_000);
  }

  function stopTimeUpdater() {
    if (timeUpdateInterval) { clearInterval(timeUpdateInterval); timeUpdateInterval = null; }
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
  return {
    init, initGlobal, startChat,
    openConversationById, openConversation,
    send, setCategory, setFilter, ensureContact,
    startTimeUpdater, stopTimeUpdater,
  };
})();
