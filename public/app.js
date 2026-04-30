const state = { session: '', pollTimer: null };

function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo(0, 0);
}

// ── Setup ─────────────────────────────────────────────────────────────────────
async function loadSessions() {
  try {
    const sessions = await fetch('/sessions').then(r => r.json());
    const wrap = document.getElementById('prev-sessions-wrap');
    const list = document.getElementById('prev-sessions');
    if (!sessions.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'flex';
    list.innerHTML = '';
    sessions.forEach(s => {
      const el = document.createElement('div');
      el.className = 'session-item';
      el.innerHTML = `<span class="name">${s.name}</span><span class="count">${s.frames} snímků</span>`;
      el.addEventListener('click', () => { document.getElementById('session-input').value = s.name; });
      list.appendChild(el);
    });
  } catch {}
}

document.getElementById('btn-to-guide').addEventListener('click', () => {
  const raw = document.getElementById('session-input').value.trim();
  state.session = raw.replace(/[^a-z0-9_-]/gi, '_') || 'hlava_01';
  document.getElementById('guide-session-name').textContent = state.session;
  show('screen-guide');
});

// ── Guide ─────────────────────────────────────────────────────────────────────
document.getElementById('back-guide').addEventListener('click', () => show('screen-setup'));

document.getElementById('btn-to-upload').addEventListener('click', async () => {
  document.getElementById('upload-session-name').textContent = state.session;
  show('screen-upload');
  await loadQR();
  startPolling();
});

// ── Upload / QR ───────────────────────────────────────────────────────────────
document.getElementById('back-upload').addEventListener('click', () => {
  stopPolling();
  show('screen-guide');
});

async function loadQR() {
  try {
    const d = await fetch('/qr').then(r => r.json());
    document.getElementById('qr-img').src = d.qr;
    document.getElementById('qr-url').textContent = d.url;
    if (d.r2Ready) document.getElementById('r2-badge').style.display = 'block';
  } catch {
    document.getElementById('qr-card').style.display = 'none';
  }
}

// ── Status polling ────────────────────────────────────────────────────────────
const STATUS_LABELS = {
  idle:        { text: 'čekám',       cls: 'pill-idle' },
  downloading: { text: '⬇️ stahuju',  cls: 'pill-proc' },
  extracting:  { text: '🎞 extrahuji', cls: 'pill-proc' },
  done:        { text: '✅ hotovo',    cls: 'pill-ok'   },
  error:       { text: '❌ chyba',     cls: 'pill-err'  },
};

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(pollStatus, 2500);
}
function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function pollStatus() {
  try {
    const job = await fetch(`/jobs/${state.session}`).then(r => r.json());
    [1, 2, 3].forEach(n => {
      const v    = `v${n}`;
      const data = job[v] || { status: 'idle', frames: 0 };
      updateVideoStatus(n, data);
    });

    // Show total frames counter when any video is processing/done
    const total = job.totalFrames || 0;
    const anyActive = [1,2,3].some(n => ['downloading','extracting','done'].includes((job[`v${n}`]||{}).status));
    const tw = document.getElementById('total-frames-wrap');
    if (anyActive) {
      tw.style.display = 'block';
      document.getElementById('total-frames-count').textContent = total;
    }

    // All done → show result
    const allDone = [1,2,3].every(n => (job[`v${n}`]||{}).status === 'done');
    if (allDone && total > 0) {
      stopPolling();
      setTimeout(() => showResult(total), 1200);
    }
  } catch {}
}

function updateVideoStatus(n, data) {
  const { status, frames } = data;
  const pill  = document.getElementById(`vpill${n}`);
  const sub   = document.getElementById(`vsub${n}`);
  const label = STATUS_LABELS[status] || STATUS_LABELS.idle;

  pill.textContent = label.text;
  pill.className   = `vstatus-pill ${label.cls}`;

  if (status === 'downloading') sub.textContent = 'Stahuji z R2…';
  else if (status === 'extracting') sub.textContent = 'Extrahuji snímky…';
  else if (status === 'done') sub.textContent = `${frames} snímků hotovo`;
  else if (status === 'error') sub.textContent = data.error || 'Chyba';
  else if (status === 'idle') sub.textContent = 'Čekám na nahrání…';
}

// ── Result ────────────────────────────────────────────────────────────────────
async function showResult(totalFrames) {
  document.getElementById('result-session-name').textContent = state.session;
  document.getElementById('result-count').textContent = totalFrames || '…';

  // ZIP download link
  const dlBtn = document.getElementById('btn-download');
  dlBtn.href = `/sessions/${state.session}/download`;
  dlBtn.download = `${state.session}_frames.zip`;

  try {
    const d = await fetch(`/sessions/${state.session}`).then(r => r.json());
    document.getElementById('result-count').textContent = d.frames;

    // Show local path only when running locally (has drive letter or /home)
    const pathWrap = document.getElementById('result-path-wrap');
    const isCloud  = d.dir && !d.dir.match(/^[A-Z]:|^\/home|^\/Users/i);
    if (isCloud) {
      pathWrap.style.display = 'none'; // cloud: no local path to show
    } else {
      document.getElementById('result-path').textContent = d.dir;
    }

    const grid = document.getElementById('preview-grid');
    grid.innerHTML = '';
    d.files.slice(0, 8).forEach(f => {
      const img = document.createElement('img');
      img.src = `/captures/${state.session}/${f}`;
      img.loading = 'lazy';
      grid.appendChild(img);
    });
  } catch {}

  show('screen-result');
}

document.getElementById('back-result').addEventListener('click', () => {
  show('screen-upload');
  startPolling();
});

document.getElementById('btn-new').addEventListener('click', () => {
  state.session = '';
  stopPolling();
  loadSessions();
  show('screen-setup');
});

// ── Init ──────────────────────────────────────────────────────────────────────
loadSessions();
