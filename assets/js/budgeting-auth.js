// ============================================================
// MrWiseMax — Authentication (Google OAuth via Supabase)
// ============================================================

const Auth = (() => {

  // Sign in with Google
  async function signInWithGoogle() {
    const { error } = await db.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + '/budgeting-dashboard.html'
      }
    });
    if (error) {
      console.error('Google sign-in error:', error.message);
      if (typeof UI !== 'undefined') UI.toast('Sign-in failed. Please try again.', 'error');
    }
  }

  // Sign out
  async function signOut() {
    await db.auth.signOut();
    window.location.href = 'index.html';
  }

  // Get current user
  async function getUser() {
    const { data: { user }, error } = await db.auth.getUser();
    if (error) return null;
    return user;
  }

  // Get session
  async function getSession() {
    const { data: { session } } = await db.auth.getSession();
    return session;
  }

  // Redirect to login if not authenticated (for dashboard)
  async function requireAuth() {
    const user = await getUser();
    if (!user) {
      window.location.href = 'budgeting-login.html';
      return null;
    }
    return user;
  }

  // Redirect to dashboard if already authenticated (for login page)
  async function redirectIfAuthed() {
    const user = await getUser();
    if (user) {
      window.location.href = 'budgeting-dashboard.html';
    }
  }

  // Listen for auth state changes
  function onAuthChange(callback) {
    db.auth.onAuthStateChange((event, session) => {
      callback(event, session);
    });
  }

  return { signInWithGoogle, signOut, getUser, getSession, requireAuth, redirectIfAuthed, onAuthChange };
})();

// ── Login page handler ────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const googleBtn = document.getElementById('google-signin-btn');
  if (googleBtn) {
    // Redirect if already logged in
    Auth.redirectIfAuthed();

    googleBtn.addEventListener('click', () => {
      googleBtn.disabled = true;
      googleBtn.innerHTML = `
        <span class="spinner" style="border-color:rgba(0,0,0,0.2);border-top-color:#333"></span>
        Connecting to Google…`;
      Auth.signInWithGoogle();
    });
  }
});

