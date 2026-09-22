// Pilih provider pemilihan momen: Gemini dulu, Ollama lokal kalau gagal. Model wajib balas JSON saja.
import { config } from '../../config.js';
import { callGemini } from './gemini.js';
import { callOllama } from './ollama.js';
import { buildGenreDetectionPrompt, buildCandidatePrompt, DEFAULT_GENRE, GENRES } from './prompts.js';

function stripCodeFence(text) {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
}

function tryParseJson(text) {
  try {
    return JSON.parse(stripCodeFence(text));
  } catch {
    return null;
  }
}

// Panggil provider, coba parse JSON, retry sekali kalau parse gagal, baru pindah ke provider berikutnya.
async function callWithJsonRetry(callFn, prompt) {
  let raw = await callFn(prompt);
  let parsed = tryParseJson(raw);
  if (parsed !== null) return parsed;

  raw = await callFn(`${prompt}\n\nPERINGATAN: balasan sebelumnya bukan JSON valid. Balas ULANG hanya dengan JSON murni, tanpa markdown, tanpa penjelasan.`);
  parsed = tryParseJson(raw);
  if (parsed !== null) return parsed;

  throw new Error('Gagal parse JSON setelah retry.');
}

async function runWithFallback(prompt) {
  let geminiError = null;
  if (config.gemini.apiKeys.length > 0) {
    try {
      return await callWithJsonRetry(callGemini, prompt);
    } catch (err) {
      geminiError = err;
      console.warn(`[pemilihan-momen] Gemini gagal (${err.message}), pindah ke Ollama lokal.`);
    }
  } else {
    console.warn('[pemilihan-momen] GEMINI_API_KEY tidak diisi, langsung pakai Ollama lokal.');
  }

  try {
    return await callWithJsonRetry(callOllama, prompt);
  } catch (ollamaError) {
    // Tampilkan kegagalan Gemini yang ASLI, bukan cuma kegagalan Ollama (yang di laptop ini
    // belum tentu terpasang) — kalau Ollama sampai dicoba, itu tandanya Gemini duluan yang bermasalah.
    if (geminiError) {
      throw new Error(`Gemini: ${geminiError.message} — Ollama (cadangan): ${ollamaError.message}`);
    }
    throw ollamaError;
  }
}

export async function detectGenre(transcript) {
  try {
    const result = await runWithFallback(buildGenreDetectionPrompt(transcript));
    if (result && GENRES.includes(result.genre)) {
      return result.genre;
    }
  } catch (err) {
    console.warn(`[pemilihan-momen] Deteksi genre gagal (${err.message}), pakai default "${DEFAULT_GENRE}".`);
  }
  return DEFAULT_GENRE;
}

export async function generateCandidates(transcript, genre) {
  const result = await runWithFallback(buildCandidatePrompt(transcript, genre));
  if (!Array.isArray(result)) {
    throw new Error('Provider pemilihan momen tidak mengembalikan array kandidat.');
  }
  return result.filter((c) =>
    Number.isInteger(c.segmentStart) &&
    Number.isInteger(c.segmentEnd) &&
    c.segmentEnd >= c.segmentStart &&
    c.segmentStart >= 0 &&
    c.segmentStart < transcript.length &&
    c.segmentEnd < transcript.length
  );
}
