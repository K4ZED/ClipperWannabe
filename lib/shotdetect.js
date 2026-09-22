// Deteksi kapan framing wide (2 orang) vs fokus 1 orang, buat mode reframe "dinamis".
// Sampling wajah tiap SAMPLE_INTERVAL detik: ffmpeg ekstrak frame jadi gambar (opencv-python-headless
// nggak punya backend buat baca video langsung), lalu lib/facedetect.py jalanin YuNet di gambar itu.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runFfmpeg } from './ffmpeg.js';

const SAMPLE_INTERVAL = 0.75;
const MIN_SEGMENT_DURATION = 1.5; // debounce: hindari kedip ganti mode gara-gara 1 sample salah deteksi
const WIDE_SEPARATION_THRESHOLD = 0.15; // 2 wajah dianggap "wide" kalau jaraknya cukup jauh secara horizontal

const PYTHON_BIN = path.resolve('.venv/bin/python3');
const SCRIPT_PATH = path.resolve('lib/facedetect.py');

async function extractSampleFrames(videoPath, start, end, tmpDir) {
  await fs.mkdir(tmpDir, { recursive: true });
  await runFfmpeg([
    '-ss', String(start),
    '-i', videoPath,
    '-t', String(end - start),
    '-vf', `fps=1/${SAMPLE_INTERVAL}`,
    '-q:v', '4',
    path.join(tmpDir, 'frame-%04d.jpg'),
  ]);
}

function sampleFaces(framesDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [SCRIPT_PATH, framesDir, String(SAMPLE_INTERVAL)]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error('Python venv (.venv) atau lib/facedetect.py tidak ditemukan untuk deteksi wajah.'));
        return;
      }
      reject(err);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`facedetect.py gagal (kode ${code}): ${stderr.slice(-500)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Output facedetect.py bukan JSON valid: ${stdout.slice(0, 300)}`));
      }
    });
  });
}

// Klasifikasi tiap sample: 'wide' (2+ wajah terpisah jauh), 'solo' (1 wajah dominan), atau null (nggak jelas).
function classifySample(sample) {
  const faces = sample.faces;
  if (faces.length === 0) return { type: null, facePos: null };
  if (faces.length === 1) return { type: 'solo', facePos: faces[0].cx };

  const sorted = [...faces].sort((a, b) => a.cx - b.cx);
  const spread = sorted[sorted.length - 1].cx - sorted[0].cx;
  if (spread >= WIDE_SEPARATION_THRESHOLD) return { type: 'wide', facePos: null };
  // Wajah > 1 tapi berdempetan (kemungkinan deteksi ganda buat orang yang sama) — anggap solo.
  const avgCx = faces.reduce((sum, f) => sum + f.cx, 0) / faces.length;
  return { type: 'solo', facePos: avgCx };
}

// Gabungkan sample jadi segmen kontinu, dengan debounce durasi minimum biar nggak kedip-kedip.
function buildSegments(samples, clipDuration) {
  const classified = samples.map((s) => ({ t: s.t, ...classifySample(s) }));

  const raw = [];
  let current = null;
  for (const c of classified) {
    if (c.type === null) {
      if (current) current.end = c.t;
      continue;
    }
    if (!current || current.type !== c.type) {
      if (current) current.end = c.t;
      current = { type: c.type, start: c.t, end: c.t, facePositions: [] };
      raw.push(current);
    } else {
      current.end = c.t;
    }
    if (c.facePos !== null) current.facePositions.push(c.facePos);
  }
  if (raw.length === 0) return [{ start: 0, end: clipDuration, type: 'solo', facePos: 0.5 }];
  raw[raw.length - 1].end = clipDuration;
  raw[0].start = 0;

  // Debounce: gabungkan segmen yang lebih pendek dari MIN_SEGMENT_DURATION ke tetangga sebelumnya.
  const merged = [raw[0]];
  for (let i = 1; i < raw.length; i += 1) {
    const seg = raw[i];
    if (seg.end - seg.start < MIN_SEGMENT_DURATION) {
      merged[merged.length - 1].end = seg.end;
      merged[merged.length - 1].facePositions.push(...seg.facePositions);
    } else {
      merged.push(seg);
    }
  }

  return merged.map((seg) => ({
    start: seg.start,
    end: seg.end,
    type: seg.type,
    facePos: seg.facePositions.length ? seg.facePositions.reduce((a, b) => a + b, 0) / seg.facePositions.length : 0.5,
  }));
}

// videoPath: source asli. start/end: rentang clip (detik, relatif ke source). clipDuration = end - start.
export async function detectShotSegments(videoPath, start, end) {
  const tmpDir = path.join(os.tmpdir(), `podclip-shots-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    await extractSampleFrames(videoPath, start, end, tmpDir);
    const samples = await sampleFaces(tmpDir);
    return buildSegments(samples, end - start);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
