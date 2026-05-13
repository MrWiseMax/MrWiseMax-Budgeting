// ============================================================
// MrWiseMax — UI Utilities
// ============================================================

const UI = (() => {

  // ── Toast Notifications ──────────────────────────────────
  function toast(message, type = 'info', duration = 3500) {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    const icons = { success: '✓', error: '✕', info: 'ℹ', warning: '⚠' };
    t.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span>${message}</span>`;
    container.appendChild(t);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => t.classList.add('toast-show'));
    });
    setTimeout(() => {
      t.classList.remove('toast-show');
      setTimeout(() => t.remove(), 400);
    }, duration);
  }

  // ── Modal System ─────────────────────────────────────────
  function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.add('modal-open');
    document.body.style.overflow = 'hidden';
  }

  function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.remove('modal-open');
    document.body.style.overflow = '';
  }

  function closeAllModals() {
    document.querySelectorAll('.modal.modal-open').forEach(m => m.classList.remove('modal-open'));
    document.body.style.overflow = '';
  }

  // Close modal when clicking backdrop
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) closeAllModals();
  });

  // Close modal on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllModals();
  });

  // ── Confirm Dialog ───────────────────────────────────────
  function confirm(message, onConfirm, danger = true) {
    const msgEl = document.getElementById('confirm-message');
    const btn   = document.getElementById('confirm-ok-btn');
    if (!msgEl || !btn) return;
    msgEl.textContent = message;
    btn.className = danger ? 'btn btn-danger' : 'btn btn-primary';
    btn.onclick = () => { closeModal('confirm-modal'); onConfirm(); };
    openModal('confirm-modal');
  }

  // ── Loading State ────────────────────────────────────────
  function setLoading(el, loading) {
    if (typeof el === 'string') el = document.getElementById(el);
    if (!el) return;
    if (loading) {
      el.dataset.originalHtml = el.innerHTML;
      el.innerHTML = '<span class="spinner"></span>';
      el.disabled = true;
    } else {
      el.innerHTML = el.dataset.originalHtml || el.innerHTML;
      el.disabled = false;
    }
  }

  // ── Section Navigation ───────────────────────────────────
  function showSection(sectionId) {
    document.querySelectorAll('.dash-section').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(`section-${sectionId}`);
    if (target) target.classList.add('active');
  }

  // ── Format Utilities ─────────────────────────────────────
  function currency(amount, symbol = '$') {
    const n = parseFloat(amount) || 0;
    return symbol + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatDateInput(dateStr) {
    if (!dateStr) return new Date().toISOString().split('T')[0];
    return dateStr.split('T')[0];
  }

  function monthName(monthNum) {
    return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][monthNum] || '';
  }

  function timeAgo(dateStr) {
    const diff = Math.floor((Date.now() - new Date(dateStr)) / 1000);
    if (diff < 60)     return 'just now';
    if (diff < 3600)   return `${Math.floor(diff/60)}m ago`;
    if (diff < 86400)  return `${Math.floor(diff/3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff/86400)}d ago`;
    return formatDate(dateStr);
  }

  // ── Color Helpers ────────────────────────────────────────
  const CHART_COLORS = [
    '#BB885F','#93603B','#E8A97A','#6B4423','#D4A574',
    '#4CAF50','#2196F3','#9C27B0','#F44336','#FF9800',
    '#00BCD4','#E91E63','#8BC34A','#FF5722','#607D8B'
  ];

  function healthScoreColor(score) {
    if (score >= 80) return '#4CAF50';
    if (score >= 60) return '#BB885F';
    if (score >= 40) return '#FF9800';
    return '#F44336';
  }

  function healthScoreLabel(score) {
    if (score >= 80) return 'Excellent';
    if (score >= 60) return 'Good';
    if (score >= 40) return 'Fair';
    return 'Needs Work';
  }

  // ── Avatar Initials ──────────────────────────────────────
  function avatarInitials(name) {
    if (!name) return '?';
    return name.trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
  }

  return {
    toast, openModal, closeModal, closeAllModals, confirm,
    setLoading, showSection,
    currency, formatDate, formatDateInput, monthName, timeAgo,
    CHART_COLORS, healthScoreColor, healthScoreLabel, avatarInitials
  };
})();
