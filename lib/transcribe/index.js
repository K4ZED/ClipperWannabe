// Pilih provider transkrip: Groq dulu, whisper.cpp kalau Groq gagal/rate-limit. Fallback otomatis + tercatat di log.
import { config } from '../../config.js';
import * as groq from './groq.js';
import * as whispercpp from './whispercpp.js';

export async function transcribe(audioPath) {
  if (config.groq.apiKey) {
    try {
      return await groq.transcribe(audioPath);
    } catch (err) {
      console.warn(`[transkrip] Groq gagal (${err.message}), pindah ke whisper.cpp lokal.`);
    }
  } else {
    console.warn('[transkrip] GROQ_API_KEY tidak diisi, langsung pakai whisper.cpp lokal.');
  }

  return whispercpp.transcribe(audioPath);
}
