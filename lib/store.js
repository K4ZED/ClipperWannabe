// Baca/tulis definisi job (clip manual) dan status render, semuanya file JSON di disk.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const JOBS_DIR = path.resolve('data/jobs');
const TRANSCRIPTS_DIR = path.resolve('data/transcripts');

function isStatusFile(filename) {
  return filename.endsWith('.status.json');
}

export async function listJobs() {
  const files = await fs.readdir(JOBS_DIR).catch(() => []);
  const jobFiles = files.filter((f) => f.endsWith('.json') && !isStatusFile(f));
  const jobs = [];
  for (const filename of jobFiles) {
    const id = filename.replace(/\.json$/, '');
    const job = JSON.parse(await fs.readFile(path.join(JOBS_DIR, filename), 'utf8'));
    const status = await readStatus(id);
    jobs.push({
      id,
      clipCount: job.clips?.length ?? 0,
      status: status?.state ?? 'belum-dijalankan',
    });
  }
  return jobs;
}

export async function readJob(id) {
  const filePath = path.join(JOBS_DIR, `${id}.json`);
  const raw = await fs.readFile(filePath, 'utf8').catch(() => {
    throw new Error(`Job "${id}" tidak ditemukan di data/jobs/${id}.json`);
  });
  return JSON.parse(raw);
}

export async function writeStatus(id, status) {
  const filePath = path.join(JOBS_DIR, `${id}.status.json`);
  await fs.writeFile(filePath, JSON.stringify(status, null, 2), 'utf8');
}

export async function readStatus(id) {
  const filePath = path.join(JOBS_DIR, `${id}.status.json`);
  const raw = await fs.readFile(filePath, 'utf8').catch(() => null);
  return raw ? JSON.parse(raw) : null;
}

// Hash dari ukuran file + mtime + nama, bukan isi file (jauh lebih cepat, cukup andal untuk cache lokal).
export async function hashSourceFile(filePath) {
  const stat = await fs.stat(filePath);
  const key = `${path.basename(filePath)}:${stat.size}:${stat.mtimeMs}`;
  return crypto.createHash('sha1').update(key).digest('hex');
}

export async function getCachedTranscript(hash) {
  const filePath = path.join(TRANSCRIPTS_DIR, `${hash}.json`);
  const raw = await fs.readFile(filePath, 'utf8').catch(() => null);
  return raw ? JSON.parse(raw) : null;
}

export async function saveTranscript(hash, transcript) {
  await fs.mkdir(TRANSCRIPTS_DIR, { recursive: true });
  await fs.writeFile(path.join(TRANSCRIPTS_DIR, `${hash}.json`), JSON.stringify(transcript, null, 2), 'utf8');
}

export async function writeJob(id, job) {
  await fs.mkdir(JOBS_DIR, { recursive: true });
  await fs.writeFile(path.join(JOBS_DIR, `${id}.json`), JSON.stringify(job, null, 2), 'utf8');
}
