// UI vanilla JS, tanpa build step: fetch ke server lokal + polling status.

const $ = (sel) => document.querySelector(sel);

function formatDuration(seconds) {
  if (!seconds) return '-';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

const STATE_LABELS = {
  'menganalisis': 'Menganalisis...',
  'menunggu-render': 'Menyiapkan render...',
  'rendering': 'Merender...',
  'selesai': 'Selesai',
  'error': 'Gagal',
  'dihentikan': 'Dihentikan',
  'belum-dijalankan': 'Belum dijalankan',
};

function stateBadgeClass(state) {
  if (state === 'selesai') return 'state-done';
  if (state === 'error') return 'state-error';
  if (state === 'dihentikan') return 'state-stopped';
  return 'state-progress';
}

function badge(state) {
  const label = STATE_LABELS[state] || state;
  return `<span class="status-badge ${stateBadgeClass(state)}">${label}</span>`;
}

// --- 1. Download YouTube ---
$('#btn-download').addEventListener('click', async () => {
  const urls = $('#youtube-urls').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (urls.length === 0) return;

  const btn = $('#btn-download');
  btn.disabled = true;
  const logEl = $('#download-log');
  logEl.hidden = false;
  logEl.textContent = 'Memulai download...\n';

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal memulai download.');

    const poll = setInterval(async () => {
      const statusRes = await fetch(`/api/download/${data.downloadId}/status`);
      const status = await statusRes.json();
      logEl.textContent = Object.entries(status.log || {})
        .map(([url, text]) => `--- ${url} ---\n${text}`)
        .join('\n');
      logEl.scrollTop = logEl.scrollHeight;

      if (status.done) {
        clearInterval(poll);
        btn.disabled = false;
        const summary = (status.results || [])
          .map((r) => (r.ok ? `OK: ${r.filePath}` : `GAGAL: ${r.url} - ${r.error}`))
          .join('\n');
        logEl.textContent += `\n\nSelesai.\n${summary}`;
        loadInputFiles();
      }
    }, 2000);
  } catch (err) {
    logEl.textContent = `Error: ${err.message}`;
    btn.disabled = false;
  }
});

// --- 2. File input ---
async function loadInputFiles() {
  const res = await fetch('/api/input-files');
  const files = await res.json();

  const table = $('#input-files-table');
  const emptyHint = $('#input-files-empty');
  table.hidden = files.length === 0;
  emptyHint.hidden = files.length > 0;

  const tbody = table.querySelector('tbody');
  tbody.innerHTML = '';
  for (const f of files) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="checkbox" value="${f.file}" class="file-pick"></td><td class="truncate" title="${f.file}">${f.file}</td><td>${formatDuration(f.duration)}</td><td>${f.width ? `${f.width}x${f.height}` : '-'}</td>`;
    tbody.appendChild(tr);
  }
}
$('#btn-refresh-files').addEventListener('click', loadInputFiles);

$('#btn-select-all').addEventListener('click', () => {
  const boxes = [...document.querySelectorAll('#input-files-table .file-pick')];
  const allChecked = boxes.length > 0 && boxes.every((b) => b.checked);
  boxes.forEach((b) => { b.checked = !allChecked; });
});

// --- Pengaturan tampilan ---
async function loadWatermarkFiles() {
  const res = await fetch('/api/watermark-files');
  const files = await res.json();
  const select = $('#opt-watermark-file');
  select.innerHTML = '<option value="">Tanpa watermark</option>' +
    files.map((f) => `<option value="${f}">${f}</option>`).join('');
}

// Choice-grid: pilihan visual (gambar kecil) menggantikan <select> teks biasa, biar nggak nebak-nebak.
function getChoice(name) {
  return document.querySelector(`.choice-grid[data-choice="${name}"]`).dataset.selected;
}

document.querySelectorAll('.choice-grid').forEach((grid) => {
  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('.choice-btn');
    if (!btn) return;
    grid.querySelectorAll('.choice-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    grid.dataset.selected = btn.dataset.value;
    if (grid.dataset.choice === 'caption-style') toggleHighlightColorField();
  });
});

function toggleHighlightColorField() {
  $('#opt-highlight-wrap').style.display = getChoice('caption-style') === 'boxed' ? '' : 'none';
}
toggleHighlightColorField();

// --- 3. Analisis otomatis ---
async function loadProviderStatus() {
  const res = await fetch('/api/config-status');
  const data = await res.json();
  const p = data.providers;
  const mark = (ok) => (ok ? '✓' : '✗');
  $('#provider-status').textContent =
    `Groq ${mark(p.groq)}  ·  Gemini ${mark(p.gemini)}  ·  whisper.cpp ${mark(p.whisperCpp)}  ·  Ollama ${mark(p.ollama)}`;
}

$('#btn-analyze').addEventListener('click', async () => {
  const files = [...document.querySelectorAll('#input-files-table .file-pick:checked')].map((el) => el.value);
  const genre = $('#analyze-genre').value;
  const count = Number($('#analyze-count').value) || 6;
  const statusEl = $('#analyze-status');
  statusEl.hidden = false;

  if (files.length === 0) {
    statusEl.innerHTML = '⚠️ Pilih minimal satu video dulu.';
    return;
  }

  const btn = $('#btn-analyze');
  btn.disabled = true;
  statusEl.innerHTML = badge('menganalisis');

  const reframe = getChoice('reframe');
  const style = {
    fontFamily: $('#opt-font').value,
    captionStyle: getChoice('caption-style'),
    captionPosition: getChoice('caption-position'),
    highlightColor: $('#opt-highlight-color').value,
  };
  const watermarkFile = $('#opt-watermark-file').value;
  const watermark = watermarkFile ? { file: watermarkFile, position: getChoice('watermark-position') } : null;

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files, genre, count, reframe, style, watermark }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal memulai analisis.');
    pollAnalyzeStatus(data.jobId, btn, statusEl);
  } catch (err) {
    statusEl.innerHTML = `${badge('error')} ${err.message}`;
    btn.disabled = false;
  }
});

function renderAnalyzeStatus(statusEl, status) {
  const parts = [badge(status.state)];

  if (status.files) {
    parts.push('<ul class="candidate-list">' + Object.entries(status.files)
      .map(([f, s]) => {
        const genre = status.genres?.[f];
        const label = genre ? `${s} · genre: ${genre}` : s;
        return `<li>${f}<span class="result-meta" style="margin-left:auto">${label}</span></li>`;
      })
      .join('') + '</ul>');
  }
  if (status.candidates) {
    parts.push('<p class="field-label" style="margin-top:14px">Kandidat terpilih</p>');
    parts.push('<ul class="candidate-list">' + status.candidates
      .map((c) => `<li><span class="candidate-score">${c.score}</span>${c.title}<span class="result-meta" style="margin-left:auto">${c.source}${c.genre ? ` · ${c.genre}` : ''}</span></li>`)
      .join('') + '</ul>');
  }
  if (status.clips) {
    parts.push('<p class="field-label" style="margin-top:14px">Render</p>');
    parts.push('<ul class="candidate-list">' + Object.entries(status.clips)
      .map(([id, s]) => `<li>${id}<span class="result-meta" style="margin-left:auto">${s}</span></li>`)
      .join('') + '</ul>');
  }
  if (status.message) parts.push(`<p class="hint" style="color:var(--bad)">${status.message}</p>`);

  statusEl.innerHTML = parts.join('');
}

function pollAnalyzeStatus(jobId, btn, statusEl) {
  const poll = setInterval(async () => {
    const res = await fetch(`/api/jobs/${jobId}/status`);
    const status = await res.json();
    renderAnalyzeStatus(statusEl, status);

    if (status.state === 'selesai' || status.state === 'error' || status.state === 'dihentikan') {
      clearInterval(poll);
      btn.disabled = false;
      if (status.state === 'selesai' || status.state === 'dihentikan') loadResults(jobId, status.candidates);
    }
  }, 2000);
}

// --- Job render manual (lanjutan) ---
async function loadJobs() {
  const res = await fetch('/api/jobs');
  const jobs = await res.json();
  const list = $('#jobs-list');
  list.innerHTML = '';
  for (const job of jobs) {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="job-header">
        <strong>${job.id}</strong> (${job.clipCount} clip)
        <button data-job="${job.id}" class="btn-render btn-ghost">Render</button>
      </div>
      <div class="job-status" data-status-for="${job.id}">${badge(job.status === 'selesai' ? 'selesai' : job.status)}</div>
    `;
    list.appendChild(li);
  }
  document.querySelectorAll('.btn-render').forEach((btn) => {
    btn.addEventListener('click', () => renderJob(btn.dataset.job));
  });
}
$('#btn-refresh-jobs').addEventListener('click', loadJobs);

async function renderJob(jobId) {
  const res = await fetch(`/api/jobs/${jobId}/render`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Gagal memulai render.');
    return;
  }
  pollJobStatus(jobId);
}

function pollJobStatus(jobId) {
  const statusEl = document.querySelector(`[data-status-for="${jobId}"]`);
  const poll = setInterval(async () => {
    const res = await fetch(`/api/jobs/${jobId}/status`);
    const status = await res.json();
    const clipLines = Object.entries(status.clips || {})
      .map(([id, s]) => `${id}: ${s}`)
      .join(' · ');
    statusEl.innerHTML = `${badge(status.state)} ${clipLines}`;

    if (status.state === 'selesai' || status.state === 'error' || status.state === 'dihentikan') {
      clearInterval(poll);
      if (status.state === 'selesai') loadResults(jobId);
    }
  }, 1500);
}

// --- Hasil ---
async function loadResults(jobId, candidates) {
  const res = await fetch(`/api/jobs/${jobId}/results`);
  const results = await res.json();
  const container = $('#results');
  const emptyHint = $('#results-empty');
  emptyHint.hidden = true;

  const meta = Object.fromEntries((candidates || []).map((c) => [c.id, c]));

  const heading = document.createElement('p');
  heading.className = 'results-heading';
  heading.textContent = jobId;
  container.appendChild(heading);

  for (const r of results) {
    const info = meta[r.id];
    const div = document.createElement('div');
    div.className = 'result-item';
    div.innerHTML = `
      <video src="${r.video}" controls></video>
      ${info ? `<div class="result-title">${info.score ? `<span class="candidate-score">${info.score}</span> ` : ''}${info.title}</div>
      <div class="result-meta" title="${info.reason || ''}">${info.reason || ''}</div>` : `<div class="result-title">${r.id}</div>`}
      <div class="result-links">
        <a href="${r.video}" download>MP4</a>
        ${r.srt ? `<a href="${r.srt}" download>SRT</a>` : ''}
      </div>
    `;
    container.appendChild(div);
  }
}

loadInputFiles();
loadJobs();
loadProviderStatus();
loadWatermarkFiles();
