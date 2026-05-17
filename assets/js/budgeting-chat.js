// ============================================================
// MrWiseMax — Chat System
// Depends on: window.db, window.App, window.UI
// ============================================================

const Chat = (() => {
  'use strict';

  // ── State ─────────────────────────────────────────────────
  let contacts = [];
  let conversations = [];
  let activeConvId = null;
  let activeOtherUser = null;
  let contactFilter = 'all';
  let contactSearch = '';
  let timeUpdateInterval = null;

  // One WebSocket channel per conversation (conv_id → channel)
  const convChannels = new Map();
  let convListChannel = null;

  // Conversations with unread messages from PRIMARY contacts
  const unreadPrimaryConvIds = new Set();

  // ── Real-time deduplication & message polling ──────────────
  const shownMsgIds = new Set();
  let lastMsgTs = null;
  let pollInterval = null;   // foreground message poll (runs while messages section is open)

  // ── Pagination state (reset on each conversation open) ─────
  const PAGE_SIZE = 30;
  let oldestLoadedTs = null;   // created_at of the oldest message currently in the DOM
  let hasMoreMessages = false;  // false once we've reached the top of history
  let isLoadingMore = false;  // guard against concurrent fetches

  // ── Typing indicator state ────────────────────────────────
  let typingBroadcastTimeout = null;  // debounce: fires typing_stop after 3 s of silence
  let typingIndicatorTimeout = null;  // auto-hide indicator after 4 s with no new event

  // ── Message interaction state ─────────────────────────────
  let replyToMsg = null;       // message object currently being replied to
  const msgDataCache = new Map();  // msgId → full message object (for context menu + real-time edits)
  let lpTimer = null;       // long-press timer handle
  let _lpJustFired = false;      // true for 600 ms after a long-press fires (suppresses image click)
  let swipeEl = null;       // touch element being swiped
  let swipeStartX = 0;
  let swipeStartY = 0;
  let swipeDirection = null;       // null = undecided, 'h' = horizontal, 'v' = vertical
  let swipeTriggered = false;

  // ── Custom audio player state ─────────────────────────────
  let _currentAudio = null;   // active HTMLAudioElement
  let _currentAudioEl = null;   // wrapper .chat-audio-player div hosting it

  // ── Voice recording state ──────────────────────────────────
  let mediaRecorder = null;
  let audioChunks = [];
  let recordingTimer = null;
  let recordingSeconds = 0;
  const MAX_RECORDING_SECS = 180;               // 3 minutes
  const MAX_FILE_BYTES = 10 * 1024 * 1024;  // 10 MB

  // ── Background badge poll ──────────────────────────────────
  // Runs every 15 s regardless of active section.
  // This is the primary unread-badge source — it reloads conversation
  // last-messages from the DB and compares them against the per-conversation
  // last-read timestamps stored in localStorage. WebSocket events are a
  // faster secondary update on top of this.
  let badgePollInterval = null;
  const LAST_READ_KEY = 'mrwisemax_chat_last_read';

  function _getLastReadTimes() {
    try { return JSON.parse(localStorage.getItem(LAST_READ_KEY) || '{}'); }
    catch (_) { return {}; }
  }

  function _setLastReadTime(convId) {
    try {
      const t = _getLastReadTimes();
      t[convId] = new Date().toISOString();
      localStorage.setItem(LAST_READ_KEY, JSON.stringify(t));
    } catch (_) { }
  }

  // Recomputes unreadPrimaryConvIds from current conversations + localStorage.
  // Called on page load and after every badge poll refresh.
  function _computeBadge() {
    const uid = App.user.id;
    const lastReadTimes = _getLastReadTimes();

    console.group('%c[Chat:Badge] Computing badge from DB state', 'color:#BB885F;font-weight:700');

    unreadPrimaryConvIds.clear();

    conversations.forEach(conv => {
      // Skip the conversation the user currently has open — they are reading it
      if (conv.id === activeConvId) {
        return;
      }

      if (!conv.lastMessage) {
        return;
      }

      // Skip if the last message was sent by the current user
      if (conv.lastMessage.sender_id === uid) {
        return;
      }

      // Determine whether the other person is a Primary contact
      const otherId = conv.user1_id === uid ? conv.user2_id : conv.user1_id;
      const contact = contacts.find(c => c.contact_id === otherId);
      const isPrimary = !contact || contact.category === 'primary';

      if (!isPrimary) {
        return;
      }

      const lastRead = lastReadTimes[conv.id] ?? null;
      const lastMsgAt = conv.lastMessage.created_at;
      const isUnread = !lastRead || lastMsgAt > lastRead;


      if (isUnread) unreadPrimaryConvIds.add(conv.id);
    });

    console.groupEnd();

    updateBadge();
  }

  // Reloads conversations from DB then recomputes the badge.
  // Called on init and every 15 s by the badge poll.
  async function _refreshBadge() {
    try {
      await Promise.all([loadContacts(), loadConversations()]);
      _computeBadge();
    } catch (e) {
      console.error('[Chat:Badge] Refresh failed:', e);
    }
  }

  function startBadgePoll() {
    if (badgePollInterval) return;
    badgePollInterval = setInterval(_refreshBadge, 15_000);
  }

  function stopBadgePoll() {
    if (!badgePollInterval) return;
    clearInterval(badgePollInterval);
    badgePollInterval = null;
  }

  // ── Public API ────────────────────────────────────────────

  async function initGlobal() {
    try {
      await Promise.all([loadContacts(), loadConversations()]);
      _computeBadge();          // Seed badge immediately from DB state
      syncConvSubscriptions();  // Open one WebSocket channel per conversation
      subscribeToNewConversations();
      startBadgePoll();         // Keep badge accurate every 15 s (WebSocket fallback)
    } catch (e) {
      console.error('[Chat] initGlobal failed:', e);
    }
  }

  async function init() {
    await Promise.all([loadContacts(), loadConversations()]);
    renderContactList();
    renderChatPlaceholder();
    wireSearchInput();
    syncConvSubscriptions();
    startTimeUpdater();
    startMessagePoll();
  }

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

    // Fetch only the single most-recent message per conversation in parallel.
    // This replaces a single unbounded query (all messages across all convs)
    // with N cheap indexed lookups that each return exactly 1 row.
    const lastMsgResults = await Promise.all(
      data.map(c =>
        db.from('messages')
          .select('id, conversation_id, content, created_at, sender_id, message_type, is_deleted')
          .eq('conversation_id', c.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
      )
    );
    const lastMsgMap = {};
    lastMsgResults.forEach(({ data: m }) => {
      if (m) lastMsgMap[m.conversation_id] = m;
    });

    conversations = data.map(c => ({
      ...c,
      otherProfile: pMap[c.user1_id === uid ? c.user2_id : c.user1_id] || null,
      lastMessage: lastMsgMap[c.id] || null,
    }));
  }

  // Loads up to PAGE_SIZE messages.
  // `before` is an ISO timestamp — when provided, only messages older than
  // that timestamp are returned (used for scroll-up pagination).
  // Results are always returned in chronological (ascending) order.
  async function loadMessages(convId, before = null) {
    let q = db.from('messages')
      .select('*')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE);
    if (before) q = q.lt('created_at', before);
    const { data } = await q;
    const msgs = (data || []).reverse();

    // Fetch reply-to previews in a single extra round-trip
    const replyIds = [...new Set(msgs.filter(m => m.reply_to_id).map(m => m.reply_to_id))];
    if (replyIds.length) {
      const { data: rMsgs } = await db.from('messages')
        .select('id, content, sender_id, message_type, file_name')
        .in('id', replyIds);
      const rMap = Object.fromEntries((rMsgs || []).map(m => [m.id, m]));
      msgs.forEach(m => { if (m.reply_to_id) m.replyTo = rMap[m.reply_to_id] ?? null; });
    }

    return msgs;
  }

  // ── Render ────────────────────────────────────────────────

  function renderContactList() {
    const el = document.getElementById('chat-contact-list');
    if (!el) return;

    const uid = App.user.id;
    const query = contactSearch.toLowerCase();
    const seen = new Set();
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
      const p = item.profile;
      const name = p.nickname || p.username || 'User';
      const av = p.avatar_url_storage || p.avatar_url;
      const isActive = item.convId === activeConvId;
      const hasUnread = item.convId ? unreadPrimaryConvIds.has(item.convId) : false;
      const isPrimary = item.category === 'primary';
      const lm = item.lastMessage;
      const lmMe = lm?.sender_id === uid;
      const lastMsg = lm
        ? lm.is_deleted
          ? 'Deleted message'
          : lm.message_type === 'audio'
            ? (lmMe ? 'You: ' : '') + '🎵 Voice message'
            : lm.message_type === 'image'
              ? (lmMe ? 'You: ' : '') + '🖼 Image'
              : lm.message_type === 'pdf'
                ? (lmMe ? 'You: ' : '') + '📄 Document'
                : (lmMe ? 'You: ' : '') + (lm.content || '').slice(0, 40) + ((lm.content || '').length > 40 ? '…' : '')
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
    win.classList.remove('open');
    win.innerHTML = `<div class="chat-placeholder">
      <div class="chat-placeholder-icon">💬</div>
      <p>Select a conversation or search for a user to start chatting.</p>
    </div>`;
  }

  async function renderMessages() {
    const win = document.getElementById('chat-window');
    if (!win || !activeConvId || !activeOtherUser) return;

    const messages = await loadMessages(activeConvId);
    const uid = App.user.id;
    const name = activeOtherUser.nickname || activeOtherUser.username || 'User';
    const av = activeOtherUser.avatar_url_storage || activeOtherUser.avatar_url;
    const contact = contacts.find(c => c.contact_id === activeOtherUser.id);
    const category = contact?.category ?? 'primary';

    // Reset pagination state for the newly opened conversation
    shownMsgIds.clear();
    lastMsgTs = null;
    oldestLoadedTs = null;
    hasMoreMessages = false;
    isLoadingMore = false;

    messages.forEach(m => {
      shownMsgIds.add(m.id);
      msgDataCache.set(m.id, m);
      if (!lastMsgTs || m.created_at > lastMsgTs) lastMsgTs = m.created_at;
    });
    if (messages.length > 0) oldestLoadedTs = messages[0].created_at;
    if (messages.length === PAGE_SIZE) hasMoreMessages = true; // may be more above

    win.innerHTML = `
      <div class="chat-header">
        <button class="chat-back-btn" onclick="Chat.closeChat()" title="Back to contacts">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 12H5"/><path d="M12 5l-7 7 7 7"/>
          </svg>
        </button>
        <div class="chat-header-user" onclick="Chat.openConversationById('${activeOtherUser.id}')">
          <div class="chat-header-avatar">${av ? `<img src="${av}" alt="${name}">` : UI.avatarInitials(name)}</div>
          <div>
            <span class="chat-header-name">${name}</span>
            <span class="chat-header-handle">@${activeOtherUser.username}</span>
          </div>
        </div>
        <div class="chat-header-right">
          <span class="chat-live-dot" title="Live"></span>
          <select class="chat-category-select"
                  onchange="Chat.setCategory('${activeOtherUser.id}', this.value)"
                  title="List category">
            <option value="primary" ${category === 'primary' ? 'selected' : ''}>Primary</option>
            <option value="general" ${category === 'general' ? 'selected' : ''}>General</option>
          </select>
        </div>
      </div>
      <div class="chat-messages" id="chat-messages-list">
        ${messages.length
        ? messages.map(m => msgBubble(m, uid)).join('')
        : '<div class="chat-no-messages">No messages yet. Say hi! 👋</div>'}
      </div>
      <div class="chat-reply-bar" id="chat-reply-bar">
        <div class="chat-reply-bar-inner">
          <div class="chat-reply-bar-indicator"></div>
          <div class="chat-reply-bar-content">
            <span class="chat-reply-bar-name" id="chat-reply-bar-name"></span>
            <span class="chat-reply-bar-text" id="chat-reply-bar-text"></span>
          </div>
          <button class="chat-reply-cancel-btn" onclick="Chat.cancelReply()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>
      <div class="chat-input-row">
        <button class="chat-attach-btn" onclick="Chat.triggerFileInput()" title="Attach image or PDF">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <button class="chat-mic-btn" id="chat-mic-btn" onclick="Chat.toggleRecording()" title="Voice message">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
        </button>
        <textarea class="chat-input" id="chat-msg-input" rows="1"
                  placeholder="Message" maxlength="2000" enterkeyhint="enter"
                  onkeydown="if(event.key==='Enter'&&!event.shiftKey&&!('ontouchstart' in window)){event.preventDefault();Chat.send();}"></textarea>
        <button class="btn btn-primary btn-sm" onclick="Chat.send()">Send</button>
      </div>
      <input type="file" id="chat-file-input" accept="image/jpeg,image/png,image/gif,image/webp,application/pdf"
             style="display:none" onchange="Chat.handleFileSelect(event)">`;

    scrollToBottom();
    wireMessagesScroll();
    _wireMessageInteractions(document.getElementById('chat-messages-list'));
    const chatInput = document.getElementById('chat-msg-input');
    chatInput?.addEventListener('input', _broadcastTyping);
    chatInput?.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
    });
  }

  function msgBubble(m, myId) {
    const isMine = m.sender_id === myId;
    const isDeleted = !!m.is_deleted;

    if (isDeleted) {
      return `<div class="chat-msg ${isMine ? 'mine' : 'theirs'}" data-msg-id="${m.id}">
        <div class="chat-bubble chat-bubble-deleted">Deleted message</div>
        <div class="chat-meta-row">
          <div class="chat-msg-time" data-ts="${m.created_at}">${UI.timeAgo(m.created_at)}</div>
        </div>
      </div>`;
    }

    // Reply-to preview
    let replyHtml = '';
    if (m.reply_to_id && m.replyTo) {
      const rt = m.replyTo;
      const rtName = rt.sender_id === myId ? 'You' : (activeOtherUser?.nickname || activeOtherUser?.username || 'User');
      const rtPrev = rt.message_type && rt.message_type !== 'text'
        ? `[${rt.message_type}]`
        : escapeHtml((rt.content || '').slice(0, 60));
      replyHtml = `<div class="chat-reply-ref" onclick="Chat.scrollToMsg('${m.reply_to_id}')">
        <span class="chat-reply-ref-name">${escapeHtml(rtName)}</span>
        <span class="chat-reply-ref-text">${rtPrev}</span>
      </div>`;
    }

    // Bubble content based on type
    const isExpired = m.expires_at && new Date(m.expires_at) < new Date();
    let content = '';

    if (m.message_type === 'audio') {
      content = isExpired
        ? `<div class="chat-media-expired">Voice message expired</div>`
        : `<div class="chat-audio-player" data-src="${m.file_url}">
            <button class="audio-play-btn" onclick="Chat._toggleAudio(this)" title="Play / Pause">
              <svg class="icon-play" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
              <svg class="icon-pause" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="display:none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
            </button>
            <div class="audio-track">
              <div class="audio-progress-fill"></div>
            </div>
            <span class="audio-time-label">0:00</span>
          </div>`;
    } else if (m.message_type === 'image') {
      content = isExpired
        ? `<div class="chat-media-expired">🖼️ This file can't be opened</div>`
        : `<img class="chat-img" src="${m.file_url}" alt="Image" loading="lazy" onclick="Chat.openImageViewer('${m.file_url}')">`;
    } else if (m.message_type === 'pdf') {
      content = isExpired
        ? `<div class="chat-media-expired">📄 This file can't be opened</div>`
        : `<a class="chat-file-link" href="${m.file_url}" target="_blank" rel="noopener">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span class="chat-file-name">${escapeHtml(m.file_name || 'document.pdf')}</span>
          </a>`;
    } else {
      content = escapeHtml(m.content || '');
    }

    const editedLabel = m.is_edited
      ? '<span class="chat-edited-label">Edited</span>' : '';

    return `<div class="chat-msg ${isMine ? 'mine' : 'theirs'}" data-msg-id="${m.id}">
      ${replyHtml}
      <div class="chat-bubble">${content}</div>
      <div class="chat-meta-row">
        <div class="chat-msg-time" data-ts="${m.created_at}">${UI.timeAgo(m.created_at)}</div>
        ${editedLabel}
      </div>
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

  // ── Scroll-up pagination ──────────────────────────────────
  // Attaches a scroll listener to the messages list once per conversation.
  // Triggers loadMoreMessages() when the user scrolls within 80 px of the top.

  function wireMessagesScroll() {
    const list = document.getElementById('chat-messages-list');
    if (!list || list.dataset.scrollWired) return;
    list.dataset.scrollWired = '1';
    list.addEventListener('scroll', () => {
      if (list.scrollTop < 80 && hasMoreMessages && !isLoadingMore) {
        loadMoreMessages();
      }
    });
  }

  async function loadMoreMessages() {
    if (isLoadingMore || !hasMoreMessages || !activeConvId || !oldestLoadedTs) return;
    isLoadingMore = true;

    const list = document.getElementById('chat-messages-list');
    if (!list) { isLoadingMore = false; return; }

    // Temporary loading row pinned to the top
    const spinner = document.createElement('div');
    spinner.className = 'chat-load-more';
    spinner.innerHTML = '<span class="chat-load-more-dot"></span><span class="chat-load-more-dot"></span><span class="chat-load-more-dot"></span>';
    list.prepend(spinner);

    const older = await loadMessages(activeConvId, oldestLoadedTs);
    spinner.remove();

    if (!older.length) {
      hasMoreMessages = false;
      // Show a permanent "start of conversation" marker
      if (!list.querySelector('.chat-history-start')) {
        const marker = document.createElement('div');
        marker.className = 'chat-history-start';
        marker.textContent = 'Beginning of conversation';
        list.prepend(marker);
      }
      isLoadingMore = false;
      return;
    }

    if (older.length < PAGE_SIZE) hasMoreMessages = false;

    // Snapshot current scroll position so the view doesn't jump after prepend
    const prevScrollHeight = list.scrollHeight;
    const prevScrollTop = list.scrollTop;

    // Build a fragment with only messages not already in the DOM
    const fragment = document.createDocumentFragment();
    older.forEach(m => {
      if (shownMsgIds.has(m.id)) return;
      shownMsgIds.add(m.id);
      msgDataCache.set(m.id, m);
      // Note: do NOT update lastMsgTs here — these are older messages,
      // and lastMsgTs must stay at the newest message for the poll to work.
      const el = document.createElement('div');
      el.innerHTML = msgBubble(m, App.user.id);
      fragment.appendChild(el.firstElementChild);
    });
    list.prepend(fragment);

    // Move cursor back so the next page loads the right older batch
    oldestLoadedTs = older[0].created_at;

    // Restore the user's scroll position (compensate for newly added height above)
    list.scrollTop = prevScrollTop + (list.scrollHeight - prevScrollHeight);

    isLoadingMore = false;
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
    _clearTypingState();
    stopRecording();
    replyToMsg = null;
    activeOtherUser = profile;

    const { data: convId, error } = await db.rpc('get_or_create_conversation', { other_user_id: profile.id });
    if (error) { UI.toast('Could not open conversation.', 'error'); return; }

    activeConvId = convId;
    markRead(convId);

    if (!conversations.find(c => c.id === convId)) {
      await loadConversations();
      syncConvSubscriptions();
    }

    renderContactList();
    await renderMessages();
    document.getElementById('chat-window')?.classList.add('open');
  }

  function closeChat() {
    _clearTypingState();
    stopRecording();
    if (_currentAudio) { _currentAudio.pause(); _resetAudioPlayer(_currentAudioEl); _currentAudio = null; _currentAudioEl = null; }
    replyToMsg = null;
    const win = document.getElementById('chat-window');
    win?.classList.remove('open');
    activeConvId = null;
    activeOtherUser = null;
    renderContactList();
    // Reset window content after the slide-out transition (200 ms)
    setTimeout(() => {
      const w = document.getElementById('chat-window');
      if (w && !w.classList.contains('open')) renderChatPlaceholder();
    }, 210);
  }

  async function ensureContact(userId) {
    if (contacts.find(c => c.contact_id === userId)) return;
    await db.from('contacts').upsert(
      [{ user_id: App.user.id, contact_id: userId, category: 'primary' }],
      { onConflict: 'user_id,contact_id' }
    );
    await loadContacts();
  }

  async function send() {
    const input = document.getElementById('chat-msg-input');
    const content = input?.value.trim();
    if (!content || !activeConvId) return;
    input.value = '';
    input.style.height = '';

    const { data: msg, error } = await db.from('messages')
      .insert([{
        conversation_id: activeConvId,
        sender_id: App.user.id,
        content,
        message_type: 'text',
        reply_to_id: replyToMsg?.id ?? null,
      }])
      .select()
      .single();

    if (error) {
      UI.toast('Could not send message.', 'error');
      input.value = content;
      return;
    }

    const replyRef = replyToMsg;  // capture before cancelReply nulls it
    cancelReply();
    if (replyRef && msg.reply_to_id) msg.replyTo = replyRef;  // attach for local render
    const list = document.getElementById('chat-messages-list');
    if (list && appendMsgToDOM(msg, list)) scrollToBottom();

    // Update last-message preview in state + mark the conversation as read
    // (we just sent something, so we've clearly seen all prior messages)
    const cv = conversations.find(c => c.id === activeConvId);
    if (cv) cv.lastMessage = msg;
    _setLastReadTime(activeConvId);
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

  // ── Deduplication helper ──────────────────────────────────

  function appendMsgToDOM(m, listEl) {
    if (shownMsgIds.has(m.id)) return false;
    shownMsgIds.add(m.id);
    msgDataCache.set(m.id, m);
    if (!lastMsgTs || m.created_at > lastMsgTs) lastMsgTs = m.created_at;
    listEl.querySelector('.chat-no-messages')?.remove();
    const el = document.createElement('div');
    el.innerHTML = msgBubble(m, App.user.id);
    listEl.appendChild(el.firstElementChild);
    return true;
  }

  // ── Foreground message poll ───────────────────────────────
  // Runs every 3 s while the messages section is open.

  function startMessagePoll() {
    if (pollInterval) return;
    pollInterval = setInterval(_pollMessages, 3000);
  }

  function stopMessagePoll() {
    clearInterval(pollInterval);
    pollInterval = null;
  }

  async function _pollMessages() {
    if (!activeConvId) return;
    const section = document.getElementById('section-messages');
    if (!section?.classList.contains('active')) return;
    const list = document.getElementById('chat-messages-list');
    if (!list) return;

    let q = db.from('messages').select('*').eq('conversation_id', activeConvId).order('created_at', { ascending: true });
    if (lastMsgTs) q = q.gt('created_at', lastMsgTs);
    const { data } = await q.limit(50);
    if (!data?.length) return;

    let hasNew = false;
    data.forEach(m => {
      if (appendMsgToDOM(m, list)) {
        hasNew = true;
        const cv = conversations.find(c => c.id === m.conversation_id);
        if (cv) cv.lastMessage = m;
      }
    });

    if (hasNew) {
      scrollToBottom();
      renderContactList();
      // Keep last-read in sync so the badge stays clear while viewing
      _setLastReadTime(activeConvId);
    }
  }

  // ── Realtime WebSocket Subscriptions ──────────────────────

  function syncConvSubscriptions() {
    const currentIds = new Set(conversations.map(c => c.id));

    for (const [id, ch] of convChannels) {
      if (!currentIds.has(id)) {
        db.removeChannel(ch);
        convChannels.delete(id);
      }
    }

    for (const conv of conversations) {
      if (convChannels.has(conv.id)) continue;
      _subscribeToConv(conv);
    }

  }

  function _subscribeToConv(conv) {
    const ch = db
      // self: false — do not echo our own broadcast events back to us
      .channel(`conv-msg-${conv.id}`, { config: { broadcast: { self: false } } })
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conv.id}` },
        handleIncomingMessage
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conv.id}` },
        handleMessageUpdate
      )
      .on('broadcast', { event: 'typing' }, p => _handleTypingEvent(conv.id, p))
      .on('broadcast', { event: 'typing_stop' }, p => _handleTypingStopEvent(conv.id, p))
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn(`[Chat:WS] ${status} on conv ${conv.id} — retrying in 4 s`, err);
          if (convChannels.get(conv.id) === ch) {
            convChannels.delete(conv.id);
            db.removeChannel(ch);
          }
          setTimeout(() => {
            if (!convChannels.has(conv.id) && conversations.find(c => c.id === conv.id)) {
              _subscribeToConv(conv);
            }
          }, 4000);
        }
      });
    convChannels.set(conv.id, ch);
  }

  function subscribeToNewConversations() {
    if (convListChannel) return;
    const uid = App.user.id;
    convListChannel = db
      .channel('chat-new-convs')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conversations', filter: `user1_id=eq.${uid}` }, handleNewConversation)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conversations', filter: `user2_id=eq.${uid}` }, handleNewConversation)
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('[Chat:WS] New-conversations channel error — retrying in 4 s', err);
          convListChannel = null;
          setTimeout(subscribeToNewConversations, 4000);
        } else {
        }
      });
  }

  async function handleNewConversation(payload) {
    const newConv = payload.new;
    if (conversations.find(c => c.id === newConv.id)) return;
    await loadConversations();
    syncConvSubscriptions();
    const section = document.getElementById('section-messages');
    if (section?.classList.contains('active')) renderContactList();
  }

  // ── Typing indicator ─────────────────────────────────────

  // Called on every keystroke in the message input.
  function _broadcastTyping() {
    if (!activeConvId) return;
    const ch = convChannels.get(activeConvId);
    if (!ch) return;

    // Broadcast typing_start immediately
    ch.send({ type: 'broadcast', event: 'typing', payload: { user_id: App.user.id } });

    // Schedule typing_stop 3 s after the last keystroke
    clearTimeout(typingBroadcastTimeout);
    typingBroadcastTimeout = setTimeout(() => {
      ch.send({ type: 'broadcast', event: 'typing_stop', payload: { user_id: App.user.id } });
    }, 3000);
  }

  function _handleTypingEvent(convId, { payload } = {}) {
    if (convId !== activeConvId) return;            // wrong conversation
    if (payload?.user_id === App.user.id) return;  // own event (shouldn't happen with self:false)

    showTypingIndicator();

    // Auto-hide after 4 s if typing_stop never arrives
    clearTimeout(typingIndicatorTimeout);
    typingIndicatorTimeout = setTimeout(hideTypingIndicator, 4000);
  }

  function _handleTypingStopEvent(convId, { payload } = {}) {
    if (convId !== activeConvId) return;
    if (payload?.user_id === App.user.id) return;
    clearTimeout(typingIndicatorTimeout);
    hideTypingIndicator();
  }

  function showTypingIndicator() {
    const list = document.getElementById('chat-messages-list');
    if (!list || list.querySelector('.chat-typing-indicator')) return;
    const el = document.createElement('div');
    el.className = 'chat-msg theirs chat-typing-indicator';
    el.innerHTML = `<div class="chat-bubble typing-bubble">
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
    </div>`;
    list.appendChild(el);
    scrollToBottom();
  }

  function hideTypingIndicator() {
    document.getElementById('chat-messages-list')
      ?.querySelector('.chat-typing-indicator')?.remove();
  }

  function _clearTypingState() {
    clearTimeout(typingBroadcastTimeout);
    clearTimeout(typingIndicatorTimeout);
    typingBroadcastTimeout = null;
    typingIndicatorTimeout = null;
    hideTypingIndicator();
  }

  // ── Context menu ─────────────────────────────────────────

  const CTX_ICONS = {
    reply: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 10h10a8 8 0 0 1 8 8v2M3 10l6-6M3 10l6 6"/></svg>`,
    copy: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect width="13" height="13" x="9" y="9" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    edit: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
    delete: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`,
  };

  function _showContextMenu(msgId, px, py) {
    _hideContextMenu();
    const m = msgDataCache.get(msgId);
    if (!m || m.is_deleted) return;

    const isMine = m.sender_id === App.user.id;
    const isText = !m.message_type || m.message_type === 'text';

    const actions = [{ icon: CTX_ICONS.reply, label: 'Reply', fn: `Chat.replyTo('${msgId}')`, danger: false }];
    if (isText && m.content) actions.push({ icon: CTX_ICONS.copy, label: 'Copy', fn: `Chat.copyMsg('${msgId}')`, danger: false });
    if (isMine && isText) actions.push({ icon: CTX_ICONS.edit, label: 'Edit', fn: `Chat.editMsg('${msgId}')`, danger: false });
    if (isMine) actions.push({ icon: CTX_ICONS.delete, label: 'Delete', fn: `Chat.deleteMsg('${msgId}')`, danger: true });

    const menu = document.createElement('div');
    menu.id = 'chat-ctx-menu';
    menu.innerHTML = actions.map(a =>
      `<button class="chat-ctx-item${a.danger ? ' danger' : ''}"
               onclick="${a.fn};Chat._hideContextMenu()">${a.icon}${a.label}</button>`
    ).join('');
    document.body.appendChild(menu);

    const mw = 160, mh = actions.length * 44 + 8;
    let lx = px - mw / 2;
    let ly = py - mh - 10;
    lx = Math.max(8, Math.min(lx, window.innerWidth - mw - 8));
    ly = Math.max(8, Math.min(ly, window.innerHeight - mh - 8));
    menu.style.left = lx + 'px';
    menu.style.top = ly + 'px';

    requestAnimationFrame(() => menu.classList.add('open'));
    setTimeout(() => document.addEventListener('click', _hideContextMenu, { once: true }), 80);
  }

  function _hideContextMenu() {
    document.getElementById('chat-ctx-menu')?.remove();
  }

  // ── Long-press + swipe wiring ─────────────────────────────

  function _wireMessageInteractions(list) {
    if (!list || list.dataset.interactionsWired) return;
    list.dataset.interactionsWired = '1';

    // Long press (500 ms) → context menu
    list.addEventListener('pointerdown', e => {
      const msgEl = e.target.closest('[data-msg-id]');
      if (!msgEl) return;
      const px = e.clientX, py = e.clientY;
      lpTimer = setTimeout(() => {
        _showContextMenu(msgEl.dataset.msgId, px, py);
        navigator.vibrate?.(40);
        _lpJustFired = true;
        setTimeout(() => { _lpJustFired = false; }, 600);
      }, 500);
    });
    let lpDownX = 0, lpDownY = 0;
    // Store pointer-down coords alongside the existing pointerdown listener
    list.addEventListener('pointerdown', e => { lpDownX = e.clientX; lpDownY = e.clientY; });
    // Only cancel long-press if finger actually moved (threshold avoids jitter on audio scrubber)
    const cancelLpAlways = () => { clearTimeout(lpTimer); lpTimer = null; };
    const cancelLpMove = e => {
      if (!lpTimer) return;
      if (Math.abs(e.clientX - lpDownX) > 10 || Math.abs(e.clientY - lpDownY) > 10) {
        clearTimeout(lpTimer); lpTimer = null;
      }
    };
    list.addEventListener('pointermove', cancelLpMove);
    list.addEventListener('pointerup', cancelLpAlways);
    list.addEventListener('pointercancel', cancelLpAlways);

    // Double-click → reply
    list.addEventListener('dblclick', e => {
      const msgEl = e.target.closest('[data-msg-id]');
      if (msgEl) replyTo(msgEl.dataset.msgId);
    });

    // Swipe right → reply (touch only)
    // Direction is locked after the first 6 px of movement so that
    // vertical scrolling never accidentally triggers a swipe.
    list.addEventListener('touchstart', e => {
      const msgEl = e.target.closest('[data-msg-id]');
      if (!msgEl) return;
      swipeEl = msgEl;
      swipeStartX = e.touches[0].clientX;
      swipeStartY = e.touches[0].clientY;
      swipeDirection = null;
      swipeTriggered = false;
    }, { passive: true });

    list.addEventListener('touchmove', e => {
      if (!swipeEl) return;
      const dx = e.touches[0].clientX - swipeStartX;
      const dy = e.touches[0].clientY - swipeStartY;

      // Wait until the finger has moved at least 10 px before locking direction.
      // Ratio check: require dy > dx*1.5 to call it vertical — biased toward
      // allowing horizontal even on slightly diagonal swipes.
      if (swipeDirection === null) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        swipeDirection = Math.abs(dy) > Math.abs(dx) * 1.5 ? 'v' : 'h';
      }

      // Vertical scroll detected — kill swipe for this gesture entirely
      if (swipeDirection === 'v') {
        swipeEl = null;
        return;
      }

      // Horizontal swipe confirmed — prevent the list from scrolling
      e.preventDefault();

      if (dx < 0) { swipeEl = null; return; }   // left swipe → ignore
      const clamped = Math.min(dx, 80);
      swipeEl.style.transform = `translateX(${clamped}px)`;
      swipeEl.style.transition = 'none';
      if (clamped >= 60 && !swipeTriggered) {
        swipeTriggered = true;
        navigator.vibrate?.(30);
      }
    }, { passive: false }); // non-passive so we can call preventDefault on horizontal swipes

    list.addEventListener('touchend', () => {
      if (!swipeEl) { swipeDirection = null; return; }
      swipeEl.style.transition = 'transform 0.2s cubic-bezier(0.4,0,0.2,1)';
      swipeEl.style.transform = 'translateX(0)';
      if (swipeTriggered) {
        replyTo(swipeEl.dataset.msgId);
      }
      swipeEl = null;
      swipeTriggered = false;
      swipeDirection = null;
    });
  }

  // ── Reply ─────────────────────────────────────────────────

  function replyTo(msgId) {
    const m = msgDataCache.get(msgId);
    if (!m || m.is_deleted) return;
    replyToMsg = m;

    const bar = document.getElementById('chat-reply-bar');
    if (!bar) return;
    const name = m.sender_id === App.user.id ? 'You' : (activeOtherUser?.nickname || activeOtherUser?.username || 'User');
    const preview = m.message_type && m.message_type !== 'text' ? `[${m.message_type}]` : (m.content || '').slice(0, 70);
    document.getElementById('chat-reply-bar-name').textContent = name;
    document.getElementById('chat-reply-bar-text').textContent = preview;
    bar.classList.add('open');
    document.getElementById('chat-msg-input')?.focus();
  }

  function cancelReply() {
    replyToMsg = null;
    document.getElementById('chat-reply-bar')?.classList.remove('open');
  }

  // ── Scroll to message (reply reference click) ─────────────

  function scrollToMsg(msgId) {
    const el = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('chat-msg-highlight');
    setTimeout(() => el.classList.remove('chat-msg-highlight'), 1900);
  }

  // ── Copy ──────────────────────────────────────────────────

  function copyMsg(msgId) {
    const m = msgDataCache.get(msgId);
    if (!m || m.is_deleted) return;
    navigator.clipboard?.writeText(m.content)
      .then(() => UI.toast('Copied!', 'success', 1500))
      .catch(() => UI.toast('Could not copy.', 'error'));
  }

  // ── Edit ──────────────────────────────────────────────────

  function editMsg(msgId) {
    const m = msgDataCache.get(msgId);
    if (!m || m.is_deleted || m.sender_id !== App.user.id || (m.message_type && m.message_type !== 'text')) return;
    const el = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!el) return;
    const bubble = el.querySelector('.chat-bubble');
    bubble.innerHTML = `<textarea class="chat-edit-input" rows="1">${escapeHtml(m.content)}</textarea>
      <div class="chat-edit-actions">
        <button class="btn btn-sm btn-primary" onclick="Chat._saveEdit('${msgId}')">Save</button>
        <button class="btn btn-sm" onclick="Chat._cancelEdit('${msgId}')">Cancel</button>
      </div>`;
    const ta = bubble.querySelector('textarea');
    ta.style.height = ta.scrollHeight + 'px';
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; });
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _saveEdit(msgId); }
      if (e.key === 'Escape') _cancelEdit(msgId);
    });
  }

  async function _saveEdit(msgId) {
    const m = msgDataCache.get(msgId);
    const el = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!m || !el) return;
    const newContent = el.querySelector('.chat-edit-input')?.value.trim();
    if (!newContent || newContent === m.content) { _cancelEdit(msgId); return; }

    const { error } = await db.from('messages').update({ content: newContent, is_edited: true }).eq('id', msgId);
    if (error) { UI.toast('Could not edit message.', 'error'); return; }

    m.content = newContent;
    m.is_edited = true;
    msgDataCache.set(msgId, m);
    _updateMsgEl(msgId);
  }

  function _cancelEdit(msgId) { _updateMsgEl(msgId); }

  // ── Delete ────────────────────────────────────────────────

  function deleteMsg(msgId) {
    UI.confirm('Delete this message for everyone?', async () => {
      const { error } = await db.from('messages').update({ is_deleted: true, content: '' }).eq('id', msgId);
      if (error) { UI.toast('Could not delete message.', 'error'); return; }
      const m = msgDataCache.get(msgId);
      if (m) { m.is_deleted = true; m.content = ''; }
      _updateMsgEl(msgId);
    }, true);
  }

  // Re-renders a cached message element in place
  function _updateMsgEl(msgId) {
    const m = msgDataCache.get(msgId);
    const el = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!m || !el) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = msgBubble(m, App.user.id);
    el.replaceWith(tmp.firstElementChild);
  }

  // ── Voice recording ───────────────────────────────────────

  async function toggleRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      stopRecording();
    } else {
      await startRecording();
    }
  }

  async function startRecording() {
    if (!activeConvId) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate:       { ideal: 48000 },
          sampleSize:       { ideal: 16 },
          channelCount:     { ideal: 1 },
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: false },  // off — browser noise suppression degrades voice naturalness
          autoGainControl:  { ideal: false },  // off — AGC causes volume pumping artifacts
          latency:          { ideal: 0 },
        },
      });
    } catch {
      UI.toast('Microphone access denied.', 'error'); return;
    }

    audioChunks = [];
    recordingSeconds = 0;

    // Pick best codec — Opus gives the highest quality at any bitrate
    const PREFERRED = [
      'audio/webm;codecs=opus',
      'audio/ogg;codecs=opus',
      'audio/webm',
      'audio/ogg',
      'audio/mp4',
    ];
    const mimeType = PREFERRED.find(t => MediaRecorder.isTypeSupported(t)) || 'audio/webm';

    mediaRecorder = new MediaRecorder(stream, {
      mimeType,
      audioBitsPerSecond: 128_000,  // 128 kbps — same as WhatsApp/Instagram voice messages
    });

    mediaRecorder.ondataavailable = e => { if (e.data.size) audioChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(audioChunks, { type: mimeType });
      audioChunks = [];
      _updateMicBtn(false);
      _clearRecordingTimer();
      await _uploadAudio(blob, mimeType);
    };

    mediaRecorder.start(100);   // 100 ms chunks — finer granularity, smoother upload
    _updateMicBtn(true);

    recordingTimer = setInterval(() => {
      recordingSeconds++;
      _updateRecordingTimerDisplay(recordingSeconds);
      if (recordingSeconds >= MAX_RECORDING_SECS) stopRecording();
    }, 1000);
  }

  function stopRecording() {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
    clearInterval(recordingTimer);
    recordingTimer = null;
    mediaRecorder.stop();
  }

  function _updateMicBtn(recording) {
    const btn = document.getElementById('chat-mic-btn');
    if (!btn) return;
    btn.classList.toggle('recording', recording);
    btn.title = recording ? 'Stop recording' : 'Voice message';
  }

  function _updateRecordingTimerDisplay(secs) {
    let el = document.getElementById('chat-rec-timer');
    if (!el) {
      el = document.createElement('div');
      el.id = 'chat-rec-timer';
      el.className = 'chat-rec-timer';
      document.querySelector('.chat-input-row')?.before(el);
    }
    const m = String(Math.floor(secs / 60)).padStart(2, '0');
    const s = String(secs % 60).padStart(2, '0');
    el.textContent = `● ${m}:${s}  /  3:00`;
  }

  function _clearRecordingTimer() {
    document.getElementById('chat-rec-timer')?.remove();
  }

  async function _uploadAudio(blob, mimeType) {
    console.group('%c[Chat:Audio] Sending voice message', 'color:#BB885F;font-weight:700');
    console.log('Active conv ID :', activeConvId);
    console.log('Blob size      :', blob.size, 'bytes');
    console.log('MIME type      :', mimeType);

    if (!activeConvId) {
      console.error('[Chat:Audio] No active conversation — aborting.');
      console.groupEnd(); return;
    }

    // ── Step 1: Storage upload ──────────────────────────────
    const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('mp4') ? 'mp4' : 'ogg';
    const path = `audio/${activeConvId}/${Date.now()}.${ext}`;
    console.log('[Chat:Audio] Step 1 — uploading to storage path:', path);

    const { data: storageData, error: upErr } = await db.storage
      .from('chat-media')
      .upload(path, blob, { contentType: mimeType });

    if (upErr) {
      console.error('[Chat:Audio] ✗ Storage upload failed:', upErr);
      console.error('  message :', upErr.message);
      console.error('  status  :', upErr.statusCode ?? upErr.status);
      console.error('  hint    : Is the "chat-media" bucket created and set to Public in Supabase Storage?');
      console.groupEnd();
      UI.toast('Could not upload voice message.', 'error'); return;
    }
    console.log('[Chat:Audio] ✓ Storage upload OK:', storageData);

    // ── Step 2: Get public URL ──────────────────────────────
    const { data: urlData } = db.storage.from('chat-media').getPublicUrl(path);
    const publicUrl = urlData.publicUrl;
    console.log('[Chat:Audio] Step 2 — public URL:', publicUrl);

    // ── Step 3: Insert message row ──────────────────────────
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 6);
    const fileName = `voice-${Date.now()}.${ext}`;

    const insertPayload = {
      conversation_id: activeConvId,
      sender_id: App.user.id,
      content: '[voice message]',
      message_type: 'audio',
      file_url: publicUrl,
      file_name: fileName,
      file_size: blob.size,
      expires_at: expiresAt.toISOString(),
    };
    console.log('[Chat:Audio] Step 3 — inserting message row:', insertPayload);

    const { data: msg, error } = await db.from('messages')
      .insert([insertPayload])
      .select()
      .single();

    if (error) {
      console.error('[Chat:Audio] ✗ DB insert failed:', error);
      console.error('  code    :', error.code);
      console.error('  message :', error.message);
      console.error('  details :', error.details);
      console.error('  hint    :', error.hint);
      console.error('  → Most likely cause: the migration SQL has NOT been run yet.');
      console.error('  → Run this in Supabase SQL editor:\n',
        'ALTER TABLE messages\n',
        '  ADD COLUMN IF NOT EXISTS is_edited    boolean DEFAULT false,\n',
        '  ADD COLUMN IF NOT EXISTS is_deleted   boolean DEFAULT false,\n',
        '  ADD COLUMN IF NOT EXISTS reply_to_id  uuid REFERENCES messages(id) ON DELETE SET NULL,\n',
        '  ADD COLUMN IF NOT EXISTS message_type text DEFAULT \'text\',\n',
        '  ADD COLUMN IF NOT EXISTS file_url     text,\n',
        '  ADD COLUMN IF NOT EXISTS file_name    text,\n',
        '  ADD COLUMN IF NOT EXISTS file_size    integer,\n',
        '  ADD COLUMN IF NOT EXISTS expires_at   timestamptz;'
      );
      console.groupEnd();
      UI.toast('Could not send voice message.', 'error'); return;
    }

    console.log('[Chat:Audio] ✓ Message row inserted:', msg);
    console.groupEnd();

    const list = document.getElementById('chat-messages-list');
    if (list && appendMsgToDOM(msg, list)) scrollToBottom();
    const cv = conversations.find(c => c.id === activeConvId);
    if (cv) cv.lastMessage = msg;
    renderContactList();
  }

  // ── File / image upload ───────────────────────────────────

  function triggerFileInput() { document.getElementById('chat-file-input')?.click(); }

  async function handleFileSelect(event) {
    const file = event.target.files?.[0];
    event.target.value = '';

    console.group('%c[Chat:File] Sending file attachment', 'color:#BB885F;font-weight:700');
    console.log('File selected  :', file?.name ?? '(none)');
    console.log('File type      :', file?.type ?? '(none)');
    console.log('File size      :', file ? `${(file.size / 1024).toFixed(1)} KB` : '(none)');
    console.log('Active conv ID :', activeConvId);

    if (!file || !activeConvId) {
      console.warn('[Chat:File] No file or no active conversation — aborting.');
      console.groupEnd(); return;
    }

    if (file.size > MAX_FILE_BYTES) {
      console.warn(`[Chat:File] File too large: ${file.size} bytes (max ${MAX_FILE_BYTES})`);
      console.groupEnd();
      UI.toast(`File too large. Maximum is ${MAX_FILE_BYTES / (1024 * 1024)} MB.`, 'error'); return;
    }

    const isImage = file.type.startsWith('image/');
    const isPdf = file.type === 'application/pdf';
    if (!isImage && !isPdf) {
      console.warn('[Chat:File] Unsupported file type:', file.type);
      console.groupEnd();
      UI.toast('Only images and PDF files are supported.', 'error'); return;
    }

    // ── Step 1: Storage upload ──────────────────────────────
    const msgType = isImage ? 'image' : 'pdf';
    const ext = file.name.split('.').pop().toLowerCase() || (isImage ? 'jpg' : 'pdf');
    const path = `files/${activeConvId}/${Date.now()}.${ext}`;
    console.log('[Chat:File] Step 1 — uploading to storage path:', path);

    const { data: storageData, error: upErr } = await db.storage
      .from('chat-media')
      .upload(path, file, { contentType: file.type });

    if (upErr) {
      console.error('[Chat:File] ✗ Storage upload failed:', upErr);
      console.error('  message :', upErr.message);
      console.error('  status  :', upErr.statusCode ?? upErr.status);
      console.error('  hint    : Is the "chat-media" bucket created and set to Public in Supabase Storage?');
      console.groupEnd();
      UI.toast('Could not upload file.', 'error'); return;
    }
    console.log('[Chat:File] ✓ Storage upload OK:', storageData);

    // ── Step 2: Get public URL ──────────────────────────────
    const { data: urlData } = db.storage.from('chat-media').getPublicUrl(path);
    const publicUrl = urlData.publicUrl;
    console.log('[Chat:File] Step 2 — public URL:', publicUrl);

    // ── Step 3: Insert message row ──────────────────────────
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 3);

    const insertPayload = {
      conversation_id: activeConvId,
      sender_id: App.user.id,
      content: msgType === 'image' ? '[image]' : '[document]',
      message_type: msgType,
      file_url: publicUrl,
      file_name: file.name,
      file_size: file.size,
      expires_at: expiresAt.toISOString(),
      reply_to_id: replyToMsg?.id ?? null,
    };
    console.log('[Chat:File] Step 3 — inserting message row:', insertPayload);

    const { data: msg, error } = await db.from('messages')
      .insert([insertPayload])
      .select()
      .single();

    if (error) {
      console.error('[Chat:File] ✗ DB insert failed:', error);
      console.error('  code    :', error.code);
      console.error('  message :', error.message);
      console.error('  details :', error.details);
      console.error('  hint    :', error.hint);
      console.error('  → Most likely cause: the migration SQL has NOT been run yet.');
      console.error('  → Run this in Supabase SQL editor:\n',
        'ALTER TABLE messages\n',
        '  ADD COLUMN IF NOT EXISTS is_edited    boolean DEFAULT false,\n',
        '  ADD COLUMN IF NOT EXISTS is_deleted   boolean DEFAULT false,\n',
        '  ADD COLUMN IF NOT EXISTS reply_to_id  uuid REFERENCES messages(id) ON DELETE SET NULL,\n',
        '  ADD COLUMN IF NOT EXISTS message_type text DEFAULT \'text\',\n',
        '  ADD COLUMN IF NOT EXISTS file_url     text,\n',
        '  ADD COLUMN IF NOT EXISTS file_name    text,\n',
        '  ADD COLUMN IF NOT EXISTS file_size    integer,\n',
        '  ADD COLUMN IF NOT EXISTS expires_at   timestamptz;'
      );
      console.groupEnd();
      UI.toast('Could not send file.', 'error'); return;
    }

    console.log('[Chat:File] ✓ Message row inserted:', msg);
    console.groupEnd();

    const replyRef = replyToMsg;
    cancelReply();
    if (replyRef && msg.reply_to_id) msg.replyTo = replyRef;
    const list = document.getElementById('chat-messages-list');
    if (list && appendMsgToDOM(msg, list)) scrollToBottom();
    const cv = conversations.find(c => c.id === activeConvId);
    if (cv) cv.lastMessage = msg;
    renderContactList();
  }

  // ── Image lightbox ────────────────────────────────────────

  function openImageViewer(url) {
    if (_lpJustFired) return;  // long-press opened context menu — don't also open lightbox
    let overlay = document.getElementById('chat-img-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'chat-img-overlay';
      overlay.className = 'chat-img-overlay';
      overlay.onclick = () => {
        overlay.classList.remove('open');
        setTimeout(() => overlay.remove(), 200);
      };
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `<img src="${url}" alt="Image">`;
    requestAnimationFrame(() => overlay.classList.add('open'));
  }

  // ── Custom audio player ───────────────────────────────────

  function _fmtAudioTime(secs) {
    const s = Math.floor(secs);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function _resetAudioPlayer(wrapper) {
    if (!wrapper) return;
    const btn = wrapper.querySelector('.audio-play-btn');
    const fill = wrapper.querySelector('.audio-progress-fill');
    const label = wrapper.querySelector('.audio-time-label');
    if (btn) { btn.querySelector('.icon-play').style.display = ''; btn.querySelector('.icon-pause').style.display = 'none'; }
    if (fill) fill.style.width = '0%';
    if (label) label.textContent = '0:00';
  }

  function _toggleAudio(btn) {
    const wrapper = btn.closest('.chat-audio-player');
    if (!wrapper) return;
    const src = wrapper.dataset.src;

    // Clicking a different player — stop the current one first
    if (_currentAudio && _currentAudioEl !== wrapper) {
      _currentAudio.pause();
      _currentAudio = null;
      _resetAudioPlayer(_currentAudioEl);
      _currentAudioEl = null;
    }

    if (!_currentAudio) {
      const audio = new Audio(src);
      _currentAudio = audio;
      _currentAudioEl = wrapper;

      const fill = wrapper.querySelector('.audio-progress-fill');
      const label = wrapper.querySelector('.audio-time-label');
      const playIcon = btn.querySelector('.icon-play');
      const pauseIcon = btn.querySelector('.icon-pause');

      audio.addEventListener('timeupdate', () => {
        if (!audio.duration) return;
        const pct = (audio.currentTime / audio.duration) * 100;
        if (fill) fill.style.width = pct + '%';
        if (label) label.textContent = _fmtAudioTime(audio.currentTime);
      });

      audio.addEventListener('ended', () => {
        _resetAudioPlayer(wrapper);
        _currentAudio = null;
        _currentAudioEl = null;
      });

      audio.addEventListener('error', () => {
        UI.toast('Could not play audio.', 'error');
        _resetAudioPlayer(wrapper);
        _currentAudio = null;
        _currentAudioEl = null;
      });

      playIcon.style.display = 'none';
      pauseIcon.style.display = '';
      audio.play().catch(() => {
        UI.toast('Could not play audio.', 'error');
        _resetAudioPlayer(wrapper);
        _currentAudio = null;
        _currentAudioEl = null;
      });
    } else {
      // Same player toggled — pause or resume
      const playIcon = btn.querySelector('.icon-play');
      const pauseIcon = btn.querySelector('.icon-pause');
      if (_currentAudio.paused) {
        _currentAudio.play();
        playIcon.style.display = 'none';
        pauseIcon.style.display = '';
      } else {
        _currentAudio.pause();
        playIcon.style.display = '';
        pauseIcon.style.display = 'none';
      }
    }
  }

  // ── Real-time message update (edit / delete) ──────────────

  function handleMessageUpdate(payload) {
    const m = payload.new;
    const cached = msgDataCache.get(m.id);
    if (cached) {
      m.replyTo = cached.replyTo;  // preserve fetched reply-to data
      msgDataCache.set(m.id, m);
    }
    // Keep conversation list preview in sync
    const cv = conversations.find(c => c.id === m.conversation_id);
    if (cv?.lastMessage?.id === m.id) { cv.lastMessage = m; renderContactList(); }
    _updateMsgEl(m.id);
  }

  function handleIncomingMessage(payload) {
    const m = payload.new;
    const convId = m.conversation_id;
    const isMyMessage = m.sender_id === App.user.id;

    console.group(`%c[Chat:WS] Incoming message — conv ${convId}`, 'color:#BB885F;font-weight:700');

    const cv = conversations.find(c => c.id === convId);
    if (cv) cv.lastMessage = m;

    const section = document.getElementById('section-messages');
    const isChatVisible = section?.classList.contains('active') ?? false;

    if (!isMyMessage) {
      if (!contacts.find(c => c.contact_id === m.sender_id)) {
        contacts.push({ user_id: App.user.id, contact_id: m.sender_id, category: 'primary', profile: null });
        db.from('contacts')
          .upsert([{ user_id: App.user.id, contact_id: m.sender_id, category: 'primary' }], { onConflict: 'user_id,contact_id' })
          .then(() => loadContacts());
      }

      if (convId === activeConvId && isChatVisible) {
        // Message arrived — stop showing the typing indicator immediately
        clearTimeout(typingIndicatorTimeout);
        hideTypingIndicator();
        const list = document.getElementById('chat-messages-list');
        if (list && appendMsgToDOM(m, list)) scrollToBottom();
      }

      const contact = contacts.find(c => c.contact_id === m.sender_id);
      const isPrimary = !contact || contact.category === 'primary';
      const isViewingThisConv = isChatVisible && convId === activeConvId;


      if (isPrimary && !isViewingThisConv) {
        unreadPrimaryConvIds.add(convId);
        updateBadge();
      }
    }

    console.groupEnd();

    if (isChatVisible) renderContactList();
  }

  function markRead(convId) {
    _setLastReadTime(convId);
    if (unreadPrimaryConvIds.delete(convId)) {
      updateBadge();
    }
  }

  function updateBadge() {
    const btn = document.querySelector('.topbar-messages-btn');
    const count = unreadPrimaryConvIds.size;

    if (!btn) {
      console.warn('[Chat:Badge] .topbar-messages-btn not found in DOM — cannot update badge');
      return;
    }

    btn.querySelector('.msg-badge')?.remove();

    if (count > 0) {
      const badge = document.createElement('span');
      badge.className = 'msg-badge';
      badge.textContent = count > 99 ? '99+' : String(count);
      btn.appendChild(badge);
    }
  }

  // ── Timestamp Updater ─────────────────────────────────────

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
    openConversationById, openConversation, closeChat,
    send, setCategory, setFilter, ensureContact,
    startTimeUpdater, stopTimeUpdater,
    startMessagePoll, stopMessagePoll,
    stopBadgePoll, stopRecording,
    // Message actions (called from inline onclick handlers)
    replyTo, cancelReply, scrollToMsg,
    copyMsg, editMsg, _saveEdit, _cancelEdit, deleteMsg,
    toggleRecording, triggerFileInput, handleFileSelect,
    openImageViewer, _hideContextMenu, _toggleAudio,
  };
})();
