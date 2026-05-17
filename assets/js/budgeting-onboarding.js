// ============================================================
// MrWiseMax — Onboarding Page Logic
// ============================================================

(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────
  let currentUser   = null;
  let avatarFile    = null;   // File object pending upload
  let usernameValid = false;
  let checkTimer    = null;

  // ── DOM refs ──────────────────────────────────────────────
  const usernameInput    = document.getElementById('usernameInput');
  const usernameStatus   = document.getElementById('usernameStatus');
  const nicknameInput    = document.getElementById('nicknameInput');
  const nicknameCounter  = document.getElementById('nicknameCounter');
  const avatarUploadArea = document.getElementById('avatarUploadArea');
  const avatarFileInput  = document.getElementById('avatarFileInput');
  const avatarPreview    = document.getElementById('avatarPreview');
  const avatarInitials   = document.getElementById('avatarInitials');
  const submitBtn        = document.getElementById('submitBtn');
  const submitBtnText    = document.getElementById('submitBtnText');
  const googleAvatarHint = document.getElementById('googleAvatarHint');
  const uploadHintText   = document.getElementById('uploadHintText');

  // Rule list items
  const rules = {
    length:      document.getElementById('rule-length'),
    chars:       document.getElementById('rule-chars'),
    start:       document.getElementById('rule-start'),
    consecutive: document.getElementById('rule-consecutive'),
    unique:      document.getElementById('rule-unique'),
  };

  // ── Switch Google account ─────────────────────────────────
  async function switchGoogleAccount() {
    const btn = document.getElementById('obSwitchBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Signing out…'; }

    await window.db.auth.signOut();

    // Re-trigger Google OAuth and force the account chooser to appear
    await window.db.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + '/budgeting-onboarding.html',
        queryParams: { prompt: 'select_account' },  // forces Google account picker
      },
    });
  }
  window.switchGoogleAccount = switchGoogleAccount;  // expose to inline onclick

  // ── Init ──────────────────────────────────────────────────
  async function init() {
    const { data: { session } } = await window.db.auth.getSession();
    if (!session) {
      window.location.href = 'budgeting-login.html';
      return;
    }
    currentUser = session.user;

    // Show signed-in email in the account bar
    const emailEl = document.getElementById('obAccountEmail');
    if (emailEl) emailEl.textContent = currentUser.email || '';

    // If already onboarded, skip straight to dashboard
    const { data: profile } = await window.db
      .from('profiles')
      .select('onboarding_complete, username, nickname, avatar_url, full_name')
      .eq('id', currentUser.id)
      .single();

    if (profile?.onboarding_complete) {
      window.location.href = 'budgeting-dashboard.html';
      return;
    }

    // Pre-fill initials from Google name or email
    const displayName = profile?.full_name || currentUser.user_metadata?.full_name || currentUser.email || '?';
    const initials    = displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    avatarInitials.textContent = initials;

    // Show Google avatar if available
    const googleAvatar = profile?.avatar_url || currentUser.user_metadata?.avatar_url;
    if (googleAvatar) {
      showAvatarImage(googleAvatar);
      googleAvatarHint.style.display = 'flex';
      uploadHintText.textContent = 'Click to change photo';
    }

    // Pre-fill username suggestion from email local part (sanitised)
    if (!profile?.username) {
      const emailLocal = currentUser.email?.split('@')[0] || '';
      const suggested  = emailLocal.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
      if (suggested.length >= 3) {
        usernameInput.value = suggested;
        onUsernameInput(); // trigger initial validation
      }
    }

    attachEvents();
  }

  // ── Events ────────────────────────────────────────────────
  function attachEvents() {
    usernameInput.addEventListener('input', onUsernameInput);
    nicknameInput.addEventListener('input', onNicknameInput);
    avatarUploadArea.addEventListener('click',   () => avatarFileInput.click());
    avatarUploadArea.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') avatarFileInput.click(); });
    avatarFileInput.addEventListener('change',   onAvatarChange);
    submitBtn.addEventListener('click', onSubmit);
  }

  // ── Username validation ───────────────────────────────────
  function onUsernameInput() {
    // Auto-lowercase
    const raw = usernameInput.value;
    const lowered = raw.toLowerCase();
    if (raw !== lowered) {
      const pos = usernameInput.selectionStart;
      usernameInput.value = lowered;
      usernameInput.setSelectionRange(pos, pos);
    }

    const val = usernameInput.value;
    usernameValid = false;
    updateSubmitBtn();

    // Clear pending DB check
    clearTimeout(checkTimer);

    // Run format rules immediately
    const formatOk = runFormatRules(val);

    if (!formatOk || val.length < 3) {
      setInputState('');
      setRule('unique', null);
      return;
    }

    // Debounce DB availability check (350ms)
    setRule('unique', null, '⏳');
    setInputState('checking');
    checkTimer = setTimeout(() => checkAvailability(val), 350);
  }

  function runFormatRules(val) {
    const len   = val.length;
    const chars = /^[a-z0-9-]*$/.test(val);
    const start = len === 0 || (val[0] !== '-' && val[val.length - 1] !== '-');
    const nocon = !val.includes('--');
    const lenOk = len >= 3 && len <= 30;

    setRule('length',      lenOk  ? 'pass' : (len > 0 ? 'fail' : null));
    setRule('chars',       chars  ? (len > 0 ? 'pass' : null) : 'fail');
    setRule('start',       start  ? (len > 0 ? 'pass' : null) : 'fail');
    setRule('consecutive', nocon  ? (len > 0 ? 'pass' : null) : 'fail');

    return lenOk && chars && start && nocon;
  }

  async function checkAvailability(val) {
    try {
      const { data, error } = await window.db.rpc('is_username_available', {
        requested_username: val,
        requesting_user_id: currentUser.id,
      });

      if (error) throw error;

      if (data === true) {
        setRule('unique', 'pass');
        setInputState('valid');
        usernameValid = true;
      } else {
        setRule('unique', 'fail', null, 'Already taken');
        setInputState('invalid');
        usernameValid = false;
      }
    } catch {
      setRule('unique', null, '⚠️', 'Could not verify — try again');
      setInputState('');
    }
    updateSubmitBtn();
  }

  // ── Rule & input helpers ──────────────────────────────────
  function setRule(key, state, icon, label) {
    const el = rules[key];
    if (!el) return;
    el.className = state || '';
    const defaults = {
      length:      '3–30 characters',
      chars:       'Only letters, numbers, and hyphens (-)',
      start:       'Cannot start or end with a hyphen',
      consecutive: 'No consecutive hyphens (--)',
      unique:      'Username is available',
    };
    if (icon) el.textContent = (icon + ' ') + (label || defaults[key]);
    else if (label) el.textContent = label;
    else el.textContent = defaults[key];
  }

  function setInputState(state) {
    usernameInput.classList.remove('valid', 'invalid', 'checking');
    if (state) usernameInput.classList.add(state);

    const icons = { valid: '✓', invalid: '✕', checking: '…', '': '' };
    const colors = { valid: '#4CAF50', invalid: '#F44336', checking: '#FF9800', '': '' };
    usernameStatus.textContent = icons[state] || '';
    usernameStatus.style.color = colors[state] || '';
  }

  // ── Nickname ──────────────────────────────────────────────
  function onNicknameInput() {
    const len = nicknameInput.value.length;
    nicknameCounter.textContent = `${len} / 50`;
    nicknameCounter.className = 'char-counter' + (len >= 50 ? ' at-limit' : len >= 40 ? ' near-limit' : '');
  }

  // ── Avatar ────────────────────────────────────────────────
  function onAvatarChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      alert('Image must be under 5 MB.');
      return;
    }
    avatarFile = file;
    const url = URL.createObjectURL(file);
    showAvatarImage(url);
    uploadHintText.textContent = 'Click to change photo';
    googleAvatarHint.style.display = 'none';
  }

  function showAvatarImage(src) {
    avatarInitials.style.display = 'none';
    const existing = avatarPreview.querySelector('img');
    if (existing) {
      existing.src = src;
    } else {
      const img = document.createElement('img');
      img.src = src;
      img.alt = 'Profile photo';
      avatarPreview.appendChild(img);
    }
  }

  // ── Submit ────────────────────────────────────────────────
  function updateSubmitBtn() {
    submitBtn.disabled = !usernameValid;
    submitBtnText.textContent = usernameValid
      ? 'Finish & Enter Dashboard →'
      : (usernameInput.value.length < 3 ? 'Enter username to continue' : 'Fix username to continue');
  }

  async function onSubmit() {
    if (!usernameValid) return;
    setLoading(true);

    try {
      let avatarPublicUrl = null;

      // 1. Upload avatar if a new file was selected
      if (avatarFile) {
        const ext  = avatarFile.name.split('.').pop().toLowerCase();
        const path = `${currentUser.id}/avatar.${ext}`;
        const { error: upErr } = await window.db.storage
          .from('avatars')
          .upload(path, avatarFile, { upsert: true, contentType: avatarFile.type });

        if (upErr) throw upErr;

        const { data: urlData } = window.db.storage.from('avatars').getPublicUrl(path);
        avatarPublicUrl = urlData.publicUrl;
      }

      // 2. Build profile update payload
      const updates = {
        username:             usernameInput.value.trim(),
        onboarding_complete:  true,
        updated_at:           new Date().toISOString(),
      };

      const nick = nicknameInput.value.trim();
      if (nick) updates.nickname = nick;
      if (avatarPublicUrl) updates.avatar_url_storage = avatarPublicUrl;

      // 3. Save profile
      const { error: profileErr } = await window.db
        .from('profiles')
        .update(updates)
        .eq('id', currentUser.id);

      if (profileErr) throw profileErr;

      // 4. Done — go to dashboard
      window.location.href = 'budgeting-dashboard.html';

    } catch (err) {
      console.error('Onboarding error:', err);
      alert('Something went wrong: ' + (err.message || 'Please try again.'));
      setLoading(false);
    }
  }

  function setLoading(on) {
    submitBtn.disabled = on;
    submitBtnText.innerHTML = on
      ? '<span class="spinner"></span> Saving…'
      : 'Finish & Enter Dashboard →';
  }

  // ── Boot ──────────────────────────────────────────────────
  init();
})();

