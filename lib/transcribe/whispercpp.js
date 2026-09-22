// Transkrip lewat whisper.cpp lokal (cadangan kalau Groq gagal/rate limit). Model "small" quantized:
// titik seimbang terbaik di Intel tanpa GPU — model "base" akurasi Bahasa Indonesianya turun terlalu jauh.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { config } from '../../config.js';

export async function transcribe(audioPath) {
  if (!config.whisperCpp.bin || !config.whisperCpp.model) {
    throw new Error('WHISPER_CPP_BIN / WHISPER_CPP_MODEL belum diisi di .env.');
  }

  const outPrefix = path.join(os.tmpdir(), `podclip-whisper-${Date.now()}`);
  const args = [
    '-m', config.whisperCpp.model,
    '-f', audioPath,
    '-l', 'id',
    '-oj',
    '-of', outPrefix,
    '-np',
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(config.whisperCpp.bin, args);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error(`whisper.cpp tidak ditemukan di "${config.whisperCpp.bin}". Cek WHISPER_CPP_BIN di .env.`));
        return;
      }
      reject(err);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`whisper.cpp keluar dengan kode ${code}.\n${stderr.slice(-2000)}`));
        return;
      }
      resolve();
    });
  });

  const jsonPath = `${outPrefix}.json`;
  const raw = await fs.readFile(jsonPath, 'utf8');
  await fs.rm(jsonPath, { force: true });

  const data = JSON.parse(raw);
  const segments = (data.transcription || []).map((entry) => ({
    start: entry.offsets.from / 1000,
    end: entry.offsets.to / 1000,
    text: entry.text.trim(),
  }));
  // whisper.cpp lokal belum kita setel buat kasih timestamp per kata — caption gaya "boxed"
  // otomatis fallback ke gaya "classic" kalau transkripnya dari sini (lihat server.js).
  return { segments, words: [] };
}
