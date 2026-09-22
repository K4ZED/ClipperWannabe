// Baca .env dan tentukan provider mana yang aktif untuk transkrip dan pemilihan momen.
import { existsSync } from 'node:fs';
import process from 'node:process';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export const config = {
  groq: {
    apiKey: process.env.GROQ_API_KEY || null,
  },
  whisperCpp: {
    bin: process.env.WHISPER_CPP_BIN || null,
    model: process.env.WHISPER_CPP_MODEL || null,
  },
  gemini: {
    // Boleh lebih dari satu key dipisah koma (dari akun berbeda) — dirotasi otomatis kalau satu kena rate limit.
    apiKeys: (process.env.GEMINI_API_KEY || '').split(',').map((k) => k.trim()).filter(Boolean),
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
  },
  ollama: {
    host: process.env.OLLAMA_HOST || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'llama3.1',
  },
};

export function providerStatus() {
  return {
    groq: Boolean(config.groq.apiKey),
    whisperCpp: Boolean(config.whisperCpp.bin && config.whisperCpp.model),
    gemini: config.gemini.apiKeys.length > 0,
    ollama: Boolean(config.ollama.host),
  };
}
