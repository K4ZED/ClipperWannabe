// Download episode dari YouTube lewat yt-dlp, untuk campaign yang sudah mengizinkan clipping.
import { spawn } from 'node:child_process';
import path from 'node:path';

const INPUT_DIR = path.resolve('input');

// Jalankan yt-dlp untuk satu URL, panggil onProgress(text) tiap baris output supaya UI bisa live-update.
export function downloadFromYoutube(url, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const outputTemplate = path.join(INPUT_DIR, '%(title)s.%(ext)s');
    const args = [
      '--no-playlist',
      // Dibatasi 1080p: hasil akhir selalu di-reframe ke lebar 1080, jadi sumber di atas itu cuma buang bandwidth dan disk.
      '-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b[height<=1080]/b',
      '--merge-output-format', 'mp4',
      '--restrict-filenames',
      '--newline', // paksa satu baris per update progress, bukan overwrite via \r, supaya kebaca saat di-pipe ke UI
      '--print', 'after_move:filepath',
      '-o', outputTemplate,
      url,
    ];

    const child = spawn('yt-dlp', args);
    let stdout = '';
    let stderr = '';

    // yt-dlp bisa kirim data terpotong di tengah baris; buffer sampai ketemu newline baru diteruskan ke onProgress.
    function makeLineEmitter() {
      let buffer = '';
      return (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) onProgress(`${line}\n`);
      };
    }
    const emitStdout = makeLineEmitter();
    const emitStderr = makeLineEmitter();

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      emitStdout(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      emitStderr(chunk);
    });

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error(
          'yt-dlp tidak ditemukan. Pastikan sudah terinstal dan ada di PATH (macOS: "brew install yt-dlp").'
        ));
        return;
      }
      reject(err);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Download gagal untuk ${url} (kode ${code}).\n${stderr.slice(-2000)}`));
        return;
      }
      const lines = stdout.trim().split('\n').filter(Boolean);
      const filePath = lines[lines.length - 1];
      if (!filePath) {
        reject(new Error(`Download selesai tapi path file tidak terbaca untuk ${url}.`));
        return;
      }
      resolve({ url, filePath: path.resolve(filePath) });
    });
  });
}

// Download berurutan (bukan paralel) supaya log per URL tetap jelas dan tidak membebani bandwidth/CPU sekaligus.
export async function downloadAll(urls, onProgress = () => {}) {
  const results = [];
  for (const url of urls) {
    try {
      const result = await downloadFromYoutube(url, (text) => onProgress(url, text));
      results.push({ ...result, ok: true });
    } catch (err) {
      results.push({ url, ok: false, error: err.message });
    }
  }
  return results;
}
