// Panggil Gemini Flash untuk deteksi genre / generasi kandidat momen. Model wajib balas JSON saja.
import { config } from '../../config.js';

const OVERLOAD_RETRY_DELAYS_MS = [3000, 8000]; // buat 503 (model lagi ramai) — biasanya sembuh dalam hitungan detik

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestOnce(prompt, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // thinkingBudget 0: task ini ekstraksi terstruktur, bukan penalaran berat — tanpa ini model 2.5 Flash
    // diam-diam "mikir" lama dulu (bisa >5 menit buat transkrip panjang) sebelum balas, sampai fetch timeout.
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Gemini API gagal (${res.status}): ${body.slice(0, 500)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('Gemini API tidak mengembalikan teks.');
  }
  return text;
}

// 503 (model lagi ramai) biasanya sembuh sendiri dalam hitungan detik — coba lagi dulu di key yang sama.
// 429 (kena limit request/kuota) beda cerita: itu limit per akun, jadi langsung pindah ke API key
// berikutnya (kalau ada, dari akun lain) daripada nunggu lama di key yang sama.
export async function callGemini(prompt) {
  const keys = config.gemini.apiKeys;
  if (keys.length === 0) {
    throw new Error('GEMINI_API_KEY belum diisi di .env.');
  }

  let lastErr;
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    const apiKey = keys[keyIndex];
    let overloadAttempt = 0;
    for (;;) {
      try {
        return await requestOnce(prompt, apiKey);
      } catch (err) {
        lastErr = err;
        if (err.status === 503 && overloadAttempt < OVERLOAD_RETRY_DELAYS_MS.length) {
          const delay = OVERLOAD_RETRY_DELAYS_MS[overloadAttempt];
          overloadAttempt += 1;
          console.warn(`[pemilihan-momen] Gemini key #${keyIndex + 1} overload (503), coba lagi dalam ${delay / 1000}s...`);
          await sleep(delay);
          continue;
        }
        if (err.status === 429 && keyIndex < keys.length - 1) {
          console.warn(`[pemilihan-momen] Gemini key #${keyIndex + 1} kena rate limit (429), pindah ke key #${keyIndex + 2}...`);
        }
        break;
      }
    }
  }
  throw lastErr;
}
