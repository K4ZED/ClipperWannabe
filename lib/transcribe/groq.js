// Transkrip lewat Groq Whisper API. Kontrak: terima path audio, kembalikan { segments, words }.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import { probe, runFfmpeg, detectSilence } from '../ffmpeg.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MAX_BYTES = 25 * 1024 * 1024;
const CHUNK_TARGET_SECONDS = 20 * 60;

class RateLimitError extends Error {}

async function transcribeChunk(audioPath) {
  if (!config.groq.apiKey) {
    throw new Error('GROQ_API_KEY belum diisi di .env.');
  }

  const buffer = await fs.readFile(audioPath);
  const form = new FormData();
  form.append('file', new Blob([buffer]), path.basename(audioPath));
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'verbose_json');
  form.append('language', 'id');
  form.append('timestamp_granularities[]', 'segment');
  form.append('timestamp_granularities[]', 'word');

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.groq.apiKey}` },
    body: form,
  });

  if (res.status === 429) {
    throw new RateLimitError('Groq rate limit (429).');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Groq API gagal (${res.status}): ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  return {
    segments: (data.segments || []).map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text.trim(),
    })),
    words: (data.words || []).map((w) => ({
      start: w.start,
      end: w.end,
      word: w.word,
    })),
  };
}

// Cari titik potong terdekat dengan target di antara rentang hening yang terdeteksi.
function pickSplitPoint(silenceRanges, target, toleranceSeconds = 45) {
  let best = null;
  let bestDist = Infinity;
  for (const range of silenceRanges) {
    const midpoint = (range.start + range.end) / 2;
    const dist = Math.abs(midpoint - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = midpoint;
    }
  }
  return best !== null && bestDist <= toleranceSeconds ? best : target;
}

async function splitAudioAtSilence(audioPath, duration) {
  const silenceRanges = await detectSilence(audioPath);
  const splitPoints = [];
  let target = CHUNK_TARGET_SECONDS;
  while (target < duration) {
    splitPoints.push(pickSplitPoint(silenceRanges, target));
    target += CHUNK_TARGET_SECONDS;
  }

  const bounds = [0, ...splitPoints, duration];
  const chunks = [];
  const tmpDir = path.join(path.dirname(audioPath), '.chunks-' + path.basename(audioPath, path.extname(audioPath)));
  await fs.mkdir(tmpDir, { recursive: true });

  for (let i = 0; i < bounds.length - 1; i += 1) {
    const start = bounds[i];
    const end = bounds[i + 1];
    const chunkPath = path.join(tmpDir, `chunk-${i}.mp3`);
    await runFfmpeg(['-i', audioPath, '-ss', String(start), '-t', String(end - start), '-c', 'copy', chunkPath]);
    chunks.push({ path: chunkPath, offset: start });
  }
  return { chunks, tmpDir };
}

export async function transcribe(audioPath) {
  const stat = await fs.stat(audioPath);
  if (stat.size <= MAX_BYTES) {
    return transcribeChunk(audioPath);
  }

  // Episode panjang (>25MB, biasanya di atas ~1.5 jam): potong jadi bagian ~20 menit di titik hening.
  const { duration } = await probe(audioPath);
  const { chunks, tmpDir } = await splitAudioAtSilence(audioPath, duration);
  try {
    const allSegments = [];
    const allWords = [];
    for (const chunk of chunks) {
      const { segments, words } = await transcribeChunk(chunk.path);
      for (const seg of segments) {
        allSegments.push({ start: seg.start + chunk.offset, end: seg.end + chunk.offset, text: seg.text });
      }
      for (const w of words) {
        allWords.push({ start: w.start + chunk.offset, end: w.end + chunk.offset, word: w.word });
      }
    }
    return { segments: allSegments, words: allWords };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export { RateLimitError };
