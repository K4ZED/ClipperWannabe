// Server express lokal: UI dibuka di browser, semua kerja berat (ffmpeg/yt-dlp) jalan di sini.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { probe, extractAudio, detectSilence } from './lib/ffmpeg.js';
import { renderClip } from './lib/render.js';
import { downloadAll } from './lib/download.js';
import { transcribe } from './lib/transcribe/index.js';
import { detectGenre, generateCandidates } from './lib/select/index.js';
import { determineCutBoundaries, removeOverlaps, buildClipSrt, mergeSegmentsForPrompt } from './lib/cut.js';
import { detectShotSegments } from './lib/shotdetect.js';
import { GENRES } from './lib/select/prompts.js';
import { providerStatus } from './config.js';
import {
  listJobs, readJob, writeStatus, readStatus, writeJob,
  hashSourceFile, getCachedTranscript, saveTranscript,
} from './lib/store.js';

const app = express();
const PORT = process.env.PORT || 3000;

const INPUT_DIR = path.resolve('input');
const OUTPUT_DIR = path.resolve('output');
const AUDIO_DIR = path.resolve('data/audio');
const JOBS_SRT_DIR = path.resolve('data/jobs-srt');
const JOBS_DIR = path.resolve('data/jobs');
const WATERMARKS_DIR = path.resolve('watermarks');
const REFRAME_MODES = ['blur', 'crop', 'split', 'dinamis'];
const CAPTION_POSITIONS = ['bawah', 'atas', 'tengah'];
const CAPTION_STYLES = ['classic', 'boxed'];

const AUTO_JOB_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // hasil dari analisis otomatis dihapus setelah 3 hari
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Cuma job hasil analisis otomatis (id diawali "auto-<timestamp>") yang kena hapus otomatis.
// Job yang dibuat manual (Tahap 1, JSON ditulis sendiri) tidak disentuh — itu bukan "hasil otomatis".
async function cleanupOldAutoJobs() {
  const files = await fs.readdir(JOBS_DIR).catch(() => []);
  const autoJobIds = files
    .filter((f) => f.startsWith('auto-') && f.endsWith('.json') && !f.endsWith('.status.json'))
    .map((f) => f.replace(/\.json$/, ''));

  const now = Date.now();
  for (const jobId of autoJobIds) {
    const createdAt = Number(jobId.slice('auto-'.length));
    if (!Number.isFinite(createdAt) || now - createdAt < AUTO_JOB_MAX_AGE_MS) continue;

    await Promise.all([
      fs.rm(path.join(OUTPUT_DIR, jobId), { recursive: true, force: true }),
      fs.rm(path.join(JOBS_SRT_DIR, jobId), { recursive: true, force: true }),
      fs.rm(path.join(JOBS_DIR, `${jobId}.json`), { force: true }),
      fs.rm(path.join(JOBS_DIR, `${jobId}.status.json`), { force: true }),
    ]);
    console.log(`[cleanup] Hasil otomatis "${jobId}" sudah lewat 3 hari, dihapus.`);
  }
}

app.use(express.json());
app.use(express.static('public'));
app.use('/output', express.static(OUTPUT_DIR));

// Progress download disimpan di memori saja: server lokal, satu pengguna, tidak perlu tahan restart.
const downloadJobs = new Map();

app.get('/api/jobs', async (req, res) => {
  try {
    res.json(await listJobs());
  } catch (err) {
    res.status(500).json({ error: `Gagal membaca daftar job: ${err.message}` });
  }
});

app.get('/api/jobs/:id/status', async (req, res) => {
  const status = await readStatus(req.params.id);
  if (!status) {
    res.json({ state: 'belum-dijalankan' });
    return;
  }
  res.json(status);
});

app.get('/api/jobs/:id/results', async (req, res) => {
  const jobOutputDir = path.join(OUTPUT_DIR, req.params.id);
  const files = await fs.readdir(jobOutputDir).catch(() => []);
  const mp4s = files.filter((f) => f.endsWith('.mp4'));
  const results = [];
  for (const f of mp4s) {
    // File 0 byte = render-nya gagal di tengah jalan (encoder error dll) — jangan ditawarin buat diunduh.
    const stat = await fs.stat(path.join(jobOutputDir, f)).catch(() => null);
    if (!stat || stat.size === 0) continue;
    const id = f.replace(/\.mp4$/, '');
    const hasSrt = files.includes(`${id}.srt`);
    results.push({
      id,
      video: `/output/${req.params.id}/${f}`,
      srt: hasSrt ? `/output/${req.params.id}/${id}.srt` : null,
    });
  }
  res.json(results);
});

async function runRenderJob(jobId, job) {
  const jobOutputDir = path.join(OUTPUT_DIR, jobId);
  await fs.mkdir(jobOutputDir, { recursive: true });

  const previous = await readStatus(jobId);
  const status = {
    ...(previous?.candidates ? { candidates: previous.candidates } : {}),
    state: 'rendering',
    clips: Object.fromEntries(job.clips.map((c, i) => [c.id || `clip${i + 1}`, 'menunggu'])),
  };
  await writeStatus(jobId, status);

  for (const [index, clip] of job.clips.entries()) {
    const clipId = clip.id || `clip${index + 1}`;
    status.clips[clipId] = 'merender';
    await writeStatus(jobId, status);
    try {
      await renderClip({ ...clip, id: clipId }, jobOutputDir);
      status.clips[clipId] = 'selesai';
    } catch (err) {
      status.clips[clipId] = `gagal: ${err.message}`;
    }
    await writeStatus(jobId, status);
  }

  status.state = 'selesai';
  await writeStatus(jobId, status);
}

app.post('/api/jobs/:id/render', async (req, res) => {
  const jobId = req.params.id;
  let job;
  try {
    job = await readJob(jobId);
  } catch (err) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (!job.clips || job.clips.length === 0) {
    res.status(400).json({ error: `Job "${jobId}" tidak punya daftar "clips".` });
    return;
  }
  // Balas langsung, render jalan di belakang; progress dipoll lewat /api/jobs/:id/status.
  res.json({ started: true });
  runRenderJob(jobId, job).catch((err) => {
    writeStatus(jobId, { state: 'error', message: err.message });
  });
});

app.get('/api/config-status', (req, res) => {
  res.json({ providers: providerStatus(), genres: GENRES });
});

async function getOrTranscribe(sourcePath) {
  const hash = await hashSourceFile(sourcePath);
  const cached = await getCachedTranscript(hash);
  // Cache lama (sebelum fitur timestamp per-kata) cuma nyimpen array segmen mentah, tanpa words.
  // Kalau dipakai apa adanya, caption "boxed" diam-diam gagal (words kosong) — jadi transkrip ulang saja.
  if (cached && !Array.isArray(cached)) {
    return cached;
  }

  await fs.mkdir(AUDIO_DIR, { recursive: true });
  const audioPath = path.join(AUDIO_DIR, `${hash}.mp3`);
  await extractAudio(sourcePath, audioPath);
  const result = await transcribe(audioPath);
  await saveTranscript(hash, result);
  return result;
}

// Ambil kata-kata yang jatuh dalam rentang [start, end] clip, timestamp digeser relatif ke 0 = mulainya clip.
function sliceWordsForClip(words, start, end) {
  return words
    .filter((w) => w.end > start && w.start < end)
    .map((w) => ({ start: Math.max(0, w.start - start), end: Math.min(end - start, w.end - start), word: w.word }));
}

async function runAnalyzeJob(jobId, files, genre, count, reframe, style, watermark) {
  const status = {
    state: 'menganalisis',
    files: Object.fromEntries(files.map((f) => [f, 'menunggu'])),
    genres: {},
  };
  await writeStatus(jobId, status);

  const allCandidates = [];
  for (const file of files) {
    const sourcePath = path.join(INPUT_DIR, file);
    status.files[file] = 'transkrip';
    await writeStatus(jobId, status);

    const [{ segments, words }, { duration }, silenceRanges] = await Promise.all([
      getOrTranscribe(sourcePath),
      probe(sourcePath),
      detectSilence(sourcePath),
    ]);

    // Genre dideteksi SEKALI per episode dari 5 menit pertama transkrip (bisa meleset di episode
    // yang nadanya campur — itu diterima untuk sekarang, lihat catatan di prompts.js).
    let fileGenre = genre;
    if (genre === 'auto') {
      status.files[file] = 'deteksi-genre';
      await writeStatus(jobId, status);
      fileGenre = await detectGenre(segments);
    }
    status.genres[file] = fileGenre;

    status.files[file] = 'mencari-momen';
    await writeStatus(jobId, status);

    const promptTranscript = mergeSegmentsForPrompt(segments);
    const candidates = await generateCandidates(promptTranscript, fileGenre);
    for (const candidate of candidates) {
      const { start, end } = determineCutBoundaries(candidate, promptTranscript, silenceRanges, duration, segments);
      allCandidates.push({
        source: file,
        sourcePath,
        segments,
        words,
        genre: fileGenre,
        title: candidate.title,
        hook: candidate.hook,
        score: candidate.score,
        reason: candidate.reason,
        cutStart: start,
        cutEnd: end,
      });
    }
    status.files[file] = 'selesai';
    await writeStatus(jobId, status);
  }

  const ranked = allCandidates.sort((a, b) => b.score - a.score);
  const nonOverlapping = removeOverlaps(ranked);
  const chosen = nonOverlapping.slice(0, count);

  const srtDir = path.join(JOBS_SRT_DIR, jobId);
  await fs.mkdir(srtDir, { recursive: true });

  const clips = [];
  for (const [index, candidate] of chosen.entries()) {
    const clipId = `clip${index + 1}`;
    const srtPath = path.join(srtDir, `${clipId}.srt`);
    await fs.writeFile(srtPath, buildClipSrt(candidate.segments, candidate.cutStart, candidate.cutEnd), 'utf8');

    let wordsPath = null;
    const clipWords = sliceWordsForClip(candidate.words, candidate.cutStart, candidate.cutEnd);
    if (style.captionStyle === 'boxed' && clipWords.length > 0) {
      wordsPath = path.join(srtDir, `${clipId}.words.json`);
      await fs.writeFile(wordsPath, JSON.stringify(clipWords), 'utf8');
    }

    let shotsPath = null;
    if (reframe === 'dinamis') {
      status.state = `mendeteksi-wajah (${clipId})`;
      await writeStatus(jobId, status);
      const shots = await detectShotSegments(candidate.sourcePath, candidate.cutStart, candidate.cutEnd);
      shotsPath = path.join(srtDir, `${clipId}.shots.json`);
      await fs.writeFile(shotsPath, JSON.stringify(shots), 'utf8');
      status.state = 'menunggu-render';
      await writeStatus(jobId, status);
    }

    clips.push({
      id: clipId,
      source: `input/${candidate.source}`,
      start: candidate.cutStart,
      end: candidate.cutEnd,
      srt: srtPath,
      words: wordsPath,
      shots: shotsPath,
      reframe,
      style,
      watermark,
      title: candidate.title,
      score: candidate.score,
      reason: candidate.reason,
      genre: candidate.genre,
    });
  }

  await writeJob(jobId, { clips });
  status.state = 'menunggu-render';
  status.candidates = clips.map((c) => ({ id: c.id, title: c.title, score: c.score, reason: c.reason, source: c.source, genre: c.genre }));
  await writeStatus(jobId, status);

  await runRenderJob(jobId, { clips });
}

app.get('/api/watermark-files', async (req, res) => {
  const files = await fs.readdir(WATERMARKS_DIR).catch(() => []);
  res.json(files.filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f)));
});

app.post('/api/analyze', async (req, res) => {
  const files = (req.body?.files || []).filter(Boolean);
  const genre = req.body?.genre;
  const count = Number(req.body?.count) || 6;
  const reframe = REFRAME_MODES.includes(req.body?.reframe) ? req.body.reframe : 'blur';

  const style = {
    fontFamily: req.body?.style?.fontFamily || 'Arial Bold',
    fontSize: Number(req.body?.style?.fontSize) || 64,
    captionPosition: CAPTION_POSITIONS.includes(req.body?.style?.captionPosition) ? req.body.style.captionPosition : 'bawah',
    captionStyle: CAPTION_STYLES.includes(req.body?.style?.captionStyle) ? req.body.style.captionStyle : 'classic',
    highlightColor: req.body?.style?.highlightColor || '#FDE047',
  };

  let watermark = null;
  if (req.body?.watermark?.file) {
    watermark = {
      imagePath: path.join(WATERMARKS_DIR, req.body.watermark.file),
      position: req.body.watermark.position || 'kanan-atas',
      width: Number(req.body.watermark.width) || 160,
    };
  }

  if (files.length === 0) {
    res.status(400).json({ error: 'Pilih minimal satu file dari folder input/.' });
    return;
  }
  if (genre !== 'auto' && !GENRES.includes(genre)) {
    res.status(400).json({ error: `Genre harus "auto" atau salah satu dari: ${GENRES.join(', ')}.` });
    return;
  }

  const jobId = `auto-${Date.now()}`;
  res.json({ started: true, jobId });

  runAnalyzeJob(jobId, files, genre, count, reframe, style, watermark).catch((err) => {
    writeStatus(jobId, { state: 'error', message: err.message });
  });
});

app.get('/api/input-files', async (req, res) => {
  const files = await fs.readdir(INPUT_DIR).catch(() => []);
  const videos = files.filter((f) => /\.(mp4|mov|mkv|m4v)$/i.test(f));
  const details = await Promise.all(
    videos.map(async (f) => {
      const filePath = path.join(INPUT_DIR, f);
      try {
        const info = await probe(filePath);
        return { file: f, path: filePath, ...info };
      } catch {
        return { file: f, path: filePath, duration: null, width: null, height: null };
      }
    })
  );
  res.json(details);
});

app.post('/api/download', (req, res) => {
  const urls = (req.body?.urls || []).map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) {
    res.status(400).json({ error: 'Kirim minimal satu URL YouTube di field "urls".' });
    return;
  }

  const downloadId = crypto.randomUUID();
  const state = { done: false, log: {}, results: [] };
  const MAX_LOG_LINES = 30;
  urls.forEach((u) => { state.log[u] = ''; });
  downloadJobs.set(downloadId, state);

  downloadAll(urls, (url, line) => {
    const isProgress = line.includes('[download]') && line.includes('%');
    const lines = state.log[url] ? state.log[url].split('\n') : [];
    const lastWasProgress = lines.length > 0 && lines[lines.length - 1].includes('[download]') && lines[lines.length - 1].includes('%');
    if (isProgress && lastWasProgress) {
      lines[lines.length - 1] = line.trimEnd();
    } else {
      lines.push(line.trimEnd());
    }
    state.log[url] = lines.slice(-MAX_LOG_LINES).join('\n');
  }).then((results) => {
    state.results = results;
    state.done = true;
  }).catch((err) => {
    state.done = true;
    state.error = err.message;
  });

  res.json({ downloadId });
});

app.get('/api/download/:id/status', (req, res) => {
  const state = downloadJobs.get(req.params.id);
  if (!state) {
    res.status(404).json({ error: 'Download job tidak ditemukan (mungkin server sudah restart).' });
    return;
  }
  res.json(state);
});

cleanupOldAutoJobs();
setInterval(cleanupOldAutoJobs, CLEANUP_INTERVAL_MS);

app.listen(PORT, () => {
  console.log(`Podclip jalan di http://localhost:${PORT}`);
});
