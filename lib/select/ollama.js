// Panggil model lokal lewat Ollama, cadangan kalau Gemini gagal.
import { config } from '../../config.js';

export async function callOllama(prompt) {
  const res = await fetch(`${config.ollama.host}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollama.model,
      prompt,
      stream: false,
      format: 'json',
    }),
  }).catch((err) => {
    throw new Error(`Tidak bisa menghubungi Ollama di ${config.ollama.host}: ${err.message}`);
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama gagal (${res.status}): ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  if (!data.response) {
    throw new Error('Ollama tidak mengembalikan teks.');
  }
  return data.response;
}
