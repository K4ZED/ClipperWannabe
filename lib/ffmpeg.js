// Wrapper tipis di atas ffmpeg/ffprobe sebagai child process.
import { spawn } from 'node:child_process';

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error(
          `${command} tidak ditemukan. Pastikan sudah terinstal dan ada di PATH (macOS: "brew install ffmpeg").`
        ));
        return;
      }
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} keluar dengan kode ${code}.\n${stderr.slice(-4000)}`));
      }
    });
  });
}

export function runFfmpeg(args) {
  return runProcess('ffmpeg', ['-y', '-hide_banner', ...args]);
}

export function runFfprobe(args) {
  return runProcess('ffprobe', args);
}

// Mengembalikan { duration, width, height } dari file media.
export async function probe(filePath) {
  const { stdout } = await runFfprobe([
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration',
    '-of', 'json',
    filePath,
  ]);
  const data = JSON.parse(stdout);
  const stream = data.streams?.[0] ?? {};
  const duration = Number(data.format?.duration ?? 0);
  return {
    duration,
    width: stream.width ?? null,
    height: stream.height ?? null,
  };
}

let videoToolboxAvailable = null;

// Cek sekali apakah encoder VideoToolbox tersedia di mesin ini, hasilnya di-cache.
export async function hasVideoToolbox() {
  if (videoToolboxAvailable !== null) return videoToolboxAvailable;
  try {
    const { stdout } = await runProcess('ffmpeg', ['-hide_banner', '-encoders']);
    videoToolboxAvailable = stdout.includes('h264_videotoolbox');
  } catch {
    videoToolboxAvailable = false;
  }
  return videoToolboxAvailable;
}

// Deteksi rentang hening lewat filter silencedetect. Dipakai untuk snapping batas potong (tahap 3+).
export async function detectSilence(filePath, noiseDb = -30, minDuration = 0.3) {
  const args = [
    '-i', filePath,
    '-vn', // buang stream video: cuma butuh audio, decode video di file 1080p panjang cuma buang-buang waktu
    '-af', `silencedetect=noise=${noiseDb}dB:d=${minDuration}`,
    '-f', 'null', '-',
  ];
  let stderr = '';
  try {
    const result = await runFfmpeg(args);
    stderr = result.stderr;
  } catch (err) {
    // ffmpeg -f null selalu keluar 0 kalau sukses; kalau gagal, lempar lagi.
    throw err;
  }

  const ranges = [];
  const startRe = /silence_start:\s*([0-9.]+)/g;
  const endRe = /silence_end:\s*([0-9.]+)/g;
  const starts = [...stderr.matchAll(startRe)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(endRe)].map((m) => Number(m[1]));
  for (let i = 0; i < Math.min(starts.length, ends.length); i += 1) {
    ranges.push({ start: starts[i], end: ends[i] });
  }
  return ranges;
}

// Ekstrak audio mono 16kHz 32kbps mp3, dipakai sebelum kirim ke provider transkrip (tahap 2+).
export async function extractAudio(inputPath, outputPath) {
  await runFfmpeg([
    '-i', inputPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-b:a', '32k',
    outputPath,
  ]);
  return outputPath;
}
