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
  const convChannels = new Map();
  let convListChannel = null;

  // Conversations with unread messages from PRIMARY contacts
  const unreadPrimaryConvIds = new Set();

  // ── Real-time deduplication & message polling ──────────────
  const shownMsgIds = new Set();
  let lastMsgTs     = null;
  let pollInterval  = null;   // foreground message poll (runs while messages section is open)

  // ── Pagination state (reset on each conversation open) ─────
  const PAGE_SIZE      = 30;
  let oldestLoadedTs   = null;   // created_at of the oldest message currently in the DOM
  let hasMoreMessages  = false;  // false once we've reached the top of history
  let isLoadingMore    = false;  // guard against concurrent fetches

  // ── Background badge poll ──────────────────────────────────
  // Runs every 15 s regardless of active section.
  // This is the primary unread-badge source — it reloads conversation
  // last-messages from the DB and compares them against the per-conversation
  // last-read timestamps stored in localStorage. WebSocket events are a
  // faster secondary update on top of this.
  let badgePollInterval = null;
  const LAST_READ_KEY   = 'mrwisemax_chat_last_read';

  function _getLastReadTimes() {
    try { return JSON.parse(localStorage.getItem(LAST_READ_KEY) || '{}'); }
    catch (_) { return {}; }
  }

  function _setLastReadTime(convId) {
    try {
      const t = _getLastReadTimes();
      t[convId] = new Date().toISOString();
      localStorage.setItem(LAST_READ_KEY, JSON.stringify(t));
      console.log(`[Chat:Badge] Saved last-read for conv ${convId}:`, t[convId]);
    } catch (_) {}
  }

  // Recomputes unreadPrimaryConvIds from current conversations + localStorage.
  // Called on page load and after every badge poll refresh.
  function _computeBadge() {
    const uid          = App.user.id;
    const lastReadTimes = _getLastReadTimes();

    console.group('%c[Chat:Badge] Computing badge from DB state', 'color:#BB885F;font-weight:700');
    console.log('Conversations loaded :', conversations.length);
    console.log('Last-read times (localStorage):', lastReadTimes);

    unreadPrimaryConvIds.clear();

    conversations.forEach(conv => {
      // Skip the conversation the user currently has open — they are reading it
      if (conv.id === activeConvId) {
        console.log(`  Conv ${conv.id} — skipped (currently open)`);
        return;
      }

      if (!conv.lastMessage) {
        console.log(`  Conv ${conv.id} — skipped (no messages)`);
        return;
      }

      // Skip if the last message was sent by the current user
      if (conv.lastMessage.sender_id === uid) {
        console.log(`  Conv ${conv.id} — skipped (last msg is mine)`);
        return;
      }

      // Determine whether the other person is a Primary contact
      const otherId = conv.user1_id === uid ? conv.user2_id : conv.user1_id;
      const contact = contacts.find(c => c.contact_id === otherId);
      const isPrimary = !contact || contact.category === 'primary';

      if (!isPrimary) {
        console.log(`  Conv ${conv.id} — skipped (General contact)`);
        return;
      }

      const lastRead   = lastReadTimes[conv.id] ?? null;
      const lastMsgAt  = conv.lastMessage.created_at;
      const isUnread   = !lastRead || lastMsgAt > lastRead;

      console.log(
        `  Conv ${conv.id} — lastMsg: ${lastMsgAt} | lastRead: ${lastRead ?? 'never'} → ${isUnread ? '%cUNREAD' : '%cREAD'}`,
        isUnread ? 'color:#F44336;font-weight:700' : 'color:#4CAF50'
      );

      if (isUnread) unreadPrimaryConvIds.add(conv.id);
    });

    console.log('Unread primary conv count:', unreadPrimaryConvIds.size, [...unreadPrimaryConvIds]);
    console.groupEnd();

    updateBadge();
  }

  // Reloads conversations from DB then recomputes the badge.
  // Called on init and every 15 s by the badge poll.
  async function _refreshBadge() {
    console.log('[Chat:Badge] Refreshing badge (DB reload)...');
    try {
      await Promise.all([loadContacts(), loadConversations()]);
      _computeBadge();
    } catch (e) {
      console.error('[Chat:Badge] Refresh failed:', e);
    }
  }

  function startBadgePoll() {
    if (badgePollInterval) return;
    console.log('[Chat:Badge] Background badge poll started (every 15 s)');
    badgePollInterval = setInterval(_refreshBadge, 15_000);
  }

  function stopBadgePoll() {
    if (!badgePollInterval) return;
    clearInterval(badgePollInterval);
    badgePollInterval = null;
    console.log('[Chat:Badge] Background badge poll stopped');
  }

  // ── Public API ────────────────────────────────────────────

  async function initGlobal() {
    console.log('[Chat] initGlobal — loading contacts & conversations...');
    try {
      await Promise.all([loadContacts(), loadConversations()]);
      console.log('[Chat] initGlobal — data loaded. Contacts:', contacts.length, '| Conversations:', conversations.length);
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
          .select('id, conversation_id, content, created_at, sender_id')
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
      lastMessage:  lastMsgMap[c.id] || null,
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
      .order('created_at', { ascending: false })   // DESC so LIMIT cuts the oldest
      .limit(PAGE_SIZE);
    if (before) q = q.lt('created_at', before);
    const { data } = await q;
    return (data || []).reverse();                 // flip back to chronological order
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
    const uid      = App.user.id;
    const name     = activeOtherUser.nickname || activeOtherUser.username || 'User';
    const av       = activeOtherUser.avatar_url_storage || activeOtherUser.avatar_url;
    const contact  = contacts.find(c => c.contact_id === activeOtherUser.id);
    const category = contact?.category ?? 'primary';

    // Reset pagination state for the newly opened conversation
    shownMsgIds.clear();
    lastMsgTs       = null;
    oldestLoadedTs  = null;
    hasMoreMessages = false;
    isLoadingMore   = false;

    messages.forEach(m => {
      shownMsgIds.add(m.id);
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
      <div class="chat-input-row">
        <input type="text" class="chat-input" id="chat-msg-input"
               placeholder="Type a message…" maxlength="2000"
               onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();Chat.send();}">
        <button class="btn btn-primary btn-sm" onclick="Chat.send()">Send</button>
      </div>`;

    scrollToBottom();
    wireMessagesScroll();
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
    const prevScrollTop    = list.scrollTop;

    // Build a fragment with only messages not already in the DOM
    const fragment = document.createDocumentFragment();
    older.forEach(m => {
      if (shownMsgIds.has(m.id)) return;
      shownMsgIds.add(m.id);
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
    const win = document.getElementById('chat-window');
    win?.classList.remove('open');
    activeConvId    = null;
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

    console.log(`[Chat:WS] Active channels: ${convChannels.size} (conversations: ${conversations.length})`);
  }

  function _subscribeToConv(conv) {
    console.log(`[Chat:WS] Opening channel for conv ${conv.id}...`);
    const ch = db
      .channel(`conv-msg-${conv.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conv.id}` },
        handleIncomingMessage
      )
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          console.log(`%c[Chat:WS] ✓ Subscribed to conv ${conv.id}`, 'color:#4CAF50;font-weight:700');
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
        } else {
          console.log(`[Chat:WS] Channel status for conv ${conv.id}: ${status}`, err ?? '');
        }
      });
    convChannels.set(conv.id, ch);
  }

  function subscribeToNewConversations() {
    if (convListChannel) return;
    const uid = App.user.id;
    console.log('[Chat:WS] Opening new-conversations channel...');
    convListChannel = db
      .channel('chat-new-convs')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conversations', filter: `user1_id=eq.${uid}` }, handleNewConversation)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conversations', filter: `user2_id=eq.${uid}` }, handleNewConversation)
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          console.log('%c[Chat:WS] ✓ Subscribed to new-conversations channel', 'color:#4CAF50;font-weight:700');
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('[Chat:WS] New-conversations channel error — retrying in 4 s', err);
          convListChannel = null;
          setTimeout(subscribeToNewConversations, 4000);
        } else {
          console.log(`[Chat:WS] New-conversations channel status: ${status}`, err ?? '');
        }
      });
  }

  async function handleNewConversation(payload) {
    const newConv = payload.new;
    if (conversations.find(c => c.id === newConv.id)) return;
    console.log('[Chat:WS] New conversation detected:', newConv.id);
    await loadConversations();
    syncConvSubscriptions();
    const section = document.getElementById('section-messages');
    if (section?.classList.contains('active')) renderContactList();
  }

  function handleIncomingMessage(payload) {
    const m           = payload.new;
    const convId      = m.conversation_id;
    const isMyMessage = m.sender_id === App.user.id;

    console.group(`%c[Chat:WS] Incoming message — conv ${convId}`, 'color:#BB885F;font-weight:700');
    console.log('Message payload       :', m);
    console.log('Is my own message     :', isMyMessage);

    const cv = conversations.find(c => c.id === convId);
    if (cv) cv.lastMessage = m;

    const section       = document.getElementById('section-messages');
    const isChatVisible = section?.classList.contains('active') ?? false;
    console.log('Messages section open :', isChatVisible);
    console.log('Active conv ID        :', activeConvId);
    console.log('This message conv ID  :', convId);

    if (!isMyMessage) {
      if (!contacts.find(c => c.contact_id === m.sender_id)) {
        console.log('Sender not in contacts — auto-adding as Primary');
        contacts.push({ user_id: App.user.id, contact_id: m.sender_id, category: 'primary', profile: null });
        db.from('contacts')
          .upsert([{ user_id: App.user.id, contact_id: m.sender_id, category: 'primary' }], { onConflict: 'user_id,contact_id' })
          .then(() => loadContacts());
      }

      if (convId === activeConvId && isChatVisible) {
        console.log('Appending to open chat window (real-time)');
        const list = document.getElementById('chat-messages-list');
        if (list && appendMsgToDOM(m, list)) scrollToBottom();
      } else {
        console.log('Not appending to DOM —',
          convId !== activeConvId ? 'different conversation is open' : 'messages section is not visible');
      }

      const contact           = contacts.find(c => c.contact_id === m.sender_id);
      const isPrimary         = !contact || contact.category === 'primary';
      const isViewingThisConv = isChatVisible && convId === activeConvId;

      console.log('Sender contact entry  :', contact ?? '(none — treated as Primary)');
      console.log('Sender is Primary     :', isPrimary);
      console.log('User viewing this conv:', isViewingThisConv);

      if (isPrimary && !isViewingThisConv) {
        unreadPrimaryConvIds.add(convId);
        console.log('%c→ Badge will show. Unread primary convs:', 'color:#4CAF50;font-weight:700',
          [...unreadPrimaryConvIds]);
        updateBadge();
      } else if (!isPrimary) {
        console.log('%c→ Badge NOT shown — sender is in General list', 'color:#FF9800;font-weight:700');
      } else {
        console.log('%c→ Badge NOT shown — user is actively viewing this conversation', 'color:#2196F3;font-weight:700');
      }
    } else {
      console.log('Own outgoing message — skipping badge logic');
    }

    console.groupEnd();

    if (isChatVisible) renderContactList();
  }

  function markRead(convId) {
    _setLastReadTime(convId);
    if (unreadPrimaryConvIds.delete(convId)) {
      console.log(`[Chat:Badge] Marked conv ${convId} as read. Remaining unread:`, [...unreadPrimaryConvIds]);
      updateBadge();
    }
  }

  function updateBadge() {
    const btn   = document.querySelector('.topbar-messages-btn');
    const count = unreadPrimaryConvIds.size;

    if (!btn) {
      console.warn('[Chat:Badge] .topbar-messages-btn not found in DOM — cannot update badge');
      return;
    }

    btn.querySelector('.msg-badge')?.remove();

    if (count > 0) {
      const badge = document.createElement('span');
      badge.className   = 'msg-badge';
      badge.textContent = count > 99 ? '99+' : String(count);
      btn.appendChild(badge);
      console.log(`%c[Chat:Badge] Badge VISIBLE — showing ${badge.textContent} unread primary conversation(s)`,
        'color:#F44336;font-weight:700');
    } else {
      console.log('[Chat:Badge] Badge HIDDEN — no unread primary conversations');
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
    stopBadgePoll,
  };
})();
