// Potong, reframe 9:16, dan bakar subtitle pakai ffmpeg.
import fs from 'node:fs/promises';
import path from 'node:path';
import { runFfmpeg, hasVideoToolbox } from './ffmpeg.js';

const MAX_CHARS_PER_LINE = 26;
const MAX_SUBTITLE_LINES = 3;
const PAD_BEFORE = 0.3;
const PAD_AFTER = 0.5;

// Terima "HH:MM:SS.mmm", "MM:SS.mmm", atau angka detik langsung.
export function parseTimecode(value) {
  if (typeof value === 'number') return value;
  const parts = String(value).split(':').map(Number);
  if (parts.some(Number.isNaN)) {
    throw new Error(`Format timecode tidak valid: "${value}". Pakai "HH:MM:SS.mmm" atau angka detik.`);
  }
  return parts.reduce((acc, part) => acc * 60 + part, 0);
}

export function formatTimecode(seconds) {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

function escapeForFilter(filePath) {
  return path.resolve(filePath).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function parseSrtTimestamp(ts) {
  const [hms, ms] = ts.split(',');
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s + Number(ms) / 1000;
}

function formatAssTimestamp(seconds) {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const cs = Math.round((clamped - Math.floor(clamped)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// "#RRGGBB" (atau "RRGGBB") -> "&HAABBGGRR" (format warna ASS, byte kebalik + alpha di depan).
function hexToAssColor(hex, alphaHex = '00') {
  const clean = hex.replace('#', '');
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H${alphaHex}${b}${g}${r}`.toUpperCase();
}

// Alignment ASS: 2=bawah-tengah, 8=atas-tengah, 5=tengah-tengah (numpad layout).
function positionToAlignment(position) {
  if (position === 'atas') return 8;
  if (position === 'tengah') return 5;
  return 2; // default: bawah
}

function marginVForPosition(position) {
  if (position === 'atas') return 100;
  if (position === 'tengah') return 0;
  return 260; // bawah: margin besar biar nggak ketutup UI TikTok/Instagram
}

// Parser .srt sederhana: cukup untuk kebutuhan burn-in kita, bukan validator format lengkap.
export function parseSrt(content) {
  const blocks = content.replace(/\r/g, '').trim().split(/\n\n+/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    if (lines.length < 2) continue;
    const timeLine = lines.find((line) => line.includes('-->'));
    if (!timeLine) continue;
    const [startStr, endStr] = timeLine.split('-->').map((s) => s.trim());
    const textLines = lines.slice(lines.indexOf(timeLine) + 1);
    cues.push({
      start: parseSrtTimestamp(startStr),
      end: parseSrtTimestamp(endStr),
      text: textLines.join(' ').trim(),
    });
  }
  return cues;
}

// Bungkus teks jadi maksimal MAX_SUBTITLE_LINES baris, sekitar MAX_CHARS_PER_LINE karakter per baris.
function wrapSubtitleText(text) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > MAX_CHARS_PER_LINE && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);

  if (lines.length > MAX_SUBTITLE_LINES) {
    const head = lines.slice(0, MAX_SUBTITLE_LINES - 1);
    const tail = lines.slice(MAX_SUBTITLE_LINES - 1).join(' ');
    return [...head, tail].join('\\N');
  }
  return lines.join('\\N');
}

const DEFAULT_STYLE = {
  fontFamily: 'Arial Bold',
  fontSize: 64,
  captionPosition: 'bawah', // 'atas' | 'tengah' | 'bawah'
  captionStyle: 'classic', // 'classic' (kalimat, wrap) | 'boxed' (per-kata, kotak warna)
  highlightColor: '#FDE047', // dipakai kalau captionStyle: 'boxed'
};

function buildAssHeader(style) {
  const alignment = positionToAlignment(style.captionPosition);
  const marginV = marginVForPosition(style.captionPosition);

  if (style.captionStyle === 'boxed') {
    const boxColor = hexToAssColor(style.highlightColor, '00');
    // Dua style: "Default" teks polos (buat kata yang belum/sudah lewat diucapkan),
    // "Highlight" kotak solid opaque (BorderStyle 3) — dipakai lewat override \r per-kata
    // di dalam satu baris kalimat yang sama, biar cuma kata yang lagi diucapkan yang diblok.
    return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style.fontFamily},${style.fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,${alignment},60,60,${marginV},1
Style: Highlight,${style.fontFamily},${style.fontSize},&H00000000,&H000000FF,${boxColor},${boxColor},-1,0,0,0,100,100,0,0,3,20,0,${alignment},60,60,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  }

  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style.fontFamily},${style.fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,${alignment},60,60,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

// Ubah .srt jadi .ass siap-bakar: gaya "classic" (kalimat, wrap 3 baris).
export function srtToAss(srtContent, style = {}) {
  const merged = { ...DEFAULT_STYLE, ...style, captionStyle: 'classic' };
  const cues = parseSrt(srtContent);
  const events = cues
    .map((cue) => {
      const text = wrapSubtitleText(cue.text);
      return `Dialogue: 0,${formatAssTimestamp(cue.start)},${formatAssTimestamp(cue.end)},Default,,0,0,0,,${text}`;
    })
    .join('\n');
  return buildAssHeader(merged) + events + '\n';
}

const PHRASE_PAUSE_GAP = 0.6; // jeda antar kata lebih dari ini -> anggap batas kalimat baru
const PHRASE_MAX_WORDS = 8;
const PHRASE_MAX_DURATION = 4.5;

// Kelompokkan kata jadi "kalimat tampil" berdasarkan jeda ucapan, panjang kata, dan durasi —
// semuanya dari array `words` yang sama (bukan digabung sama .srt) biar batasnya konsisten,
// nggak ada kata yang kepotong nyangkut di dua kalimat sekaligus.
function groupWordsIntoPhrases(words) {
  const phrases = [];
  let current = [];
  for (const w of words) {
    if (!w.word.trim()) continue;
    if (current.length) {
      const prev = current[current.length - 1];
      const gap = w.start - prev.end;
      const duration = w.end - current[0].start;
      if (gap > PHRASE_PAUSE_GAP || current.length >= PHRASE_MAX_WORDS || duration > PHRASE_MAX_DURATION) {
        phrases.push(current);
        current = [];
      }
    }
    current.push(w);
  }
  if (current.length) phrases.push(current);
  return phrases;
}

// Gaya "boxed": kalimat tampil UTUH seperti subtitle biasa, tapi kata yang lagi diucapkan
// dapat kotak highlight (style "Highlight" lewat override \r), sisanya teks polos (style "Default").
// Window waktu tiap kata dipaksa berurutan tanpa celah/tumpang-tindih (timestamp Groq per-kata
// kadang sedikit overlap di kata bersebelahan) biar nggak ada dua baris nongol bareng.
export function wordsToAss(words, style = {}) {
  const merged = { ...DEFAULT_STYLE, ...style, captionStyle: 'boxed' };
  const phrases = groupWordsIntoPhrases(words);

  const events = [];
  for (const phrase of phrases) {
    let cursor = phrase[0].start;
    phrase.forEach((activeWord, i) => {
      const start = cursor;
      const rawEnd = i < phrase.length - 1 ? phrase[i + 1].start : activeWord.end;
      const end = Math.max(start + 0.05, rawEnd);
      cursor = end;
      const text = phrase
        .map((w, j) => (j === i ? `{\\rHighlight}${w.word.trim()}{\\r}` : w.word.trim()))
        .join(' ');
      events.push(`Dialogue: 0,${formatAssTimestamp(start)},${formatAssTimestamp(end)},Default,,0,0,0,,${text}`);
    });
  }
  return buildAssHeader(merged) + events.join('\n') + '\n';
}

function buildReframeFilter(mode, shots) {
  if (mode === 'dinamis' && shots?.length) {
    return buildDynamicReframeFilter(shots);
  }
  if (mode === 'crop') {
    return `[0:v]crop='min(iw,ih*9/16)':ih,scale=1080:1920,setsar=1[base]`;
  }
  if (mode === 'split') {
    // Shot 2 orang bersebelahan kiri-kanan: potong jadi dua, tumpuk atas-bawah.
    return [
      `[0:v]crop=iw/2:ih:0:0,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setsar=1[top]`,
      `[0:v]crop=iw/2:ih:iw/2:0,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setsar=1[bottom]`,
      `[top][bottom]vstack=inputs=2[base]`,
    ].join(';');
  }
  // default: blur background
  return [
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=28,eq=brightness=-0.18[bg]`,
    `[0:v]scale=1080:-2[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2[base]`,
  ].join(';');
}

// Segmen "solo": crop sliver 9:16 di sekitar posisi wajah (bukan selalu tengah), lalu blur-bg seperti biasa.
function buildSoloSegmentFilter(inputLabel, outLabel, facePos) {
  // Koma di dalam ekspresi filter ffmpeg harus di-escape (\,), kalau nggak dianggap pemisah filter baru.
  const cropX = `min(max(0\\,(iw*${facePos})-(ih*9/32))\\,iw-(ih*9/16))`;
  return [
    // Background blur dari FRAME PENUH (bukan dari hasil crop) — biar tetap kelihatan ambient blur wide shot,
    // bukan blur dari gambar yang udah di-zoom (itu bikin kotak abu-abu raksasa nggak jelas).
    // setsar=1 wajib di tiap cabang: kalau nggak, SAR hasil scale bisa beda tipis antar segmen
    // (mis. 1:1 vs 10240:10239) dan bikin filter concat gagal total pas gabungin balik segmen-segmennya.
    `[${inputLabel}]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=28,eq=brightness=-0.18,setsar=1[${outLabel}bg]`,
    `[${inputLabel}]crop=ih*9/16:ih:${cropX}:0[${outLabel}c]`,
    `[${outLabel}c]scale=1080:-2,setsar=1[${outLabel}fg]`,
    `[${outLabel}bg][${outLabel}fg]overlay=(W-w)/2:(H-h)/2,setsar=1[${outLabel}]`,
  ].join(';');
}

// Segmen "wide": sama seperti mode split manual, tapi per-segmen.
function buildWideSegmentFilter(inputLabel, outLabel) {
  return [
    `[${inputLabel}]crop=iw/2:ih:0:0,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setsar=1[${outLabel}t]`,
    `[${inputLabel}]crop=iw/2:ih:iw/2:0,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setsar=1[${outLabel}b]`,
    `[${outLabel}t][${outLabel}b]vstack=inputs=2[${outLabel}]`,
  ].join(';');
}

// Mode "dinamis": potong clip jadi beberapa segmen berdasarkan deteksi wajah (lib/shotdetect.js),
// tiap segmen dapat treatment sesuai jenisnya (wide -> split, solo -> blur ikut posisi wajah),
// lalu disambung lagi pakai concat filter jadi satu video utuh.
function buildDynamicReframeFilter(shots) {
  const parts = [];
  const segLabels = [];
  shots.forEach((shot, i) => {
    const rawLabel = `dseg${i}raw`;
    const outLabel = `dseg${i}`;
    // TANPA setpts=PTS-STARTPTS dengan sengaja: reset timestamp ke 0 di sini ternyata bikin frame
    // pertama tiap segmen keluar blur (kebukti lewat testing manual, konsisten di videotoolbox maupun
    // libx264 — jadi ini bug di kombinasi trim+setpts+filter chain, bukan soal encoder). Filter concat
    // di bawah tetap benar tanpa ini karena dia nyusun ulang timestamp output sendiri secara berurutan.
    parts.push(`[0:v]trim=start=${shot.start}:end=${shot.end}[${rawLabel}]`);
    parts.push(
      shot.type === 'wide'
        ? buildWideSegmentFilter(rawLabel, outLabel)
        : buildSoloSegmentFilter(rawLabel, outLabel, shot.facePos ?? 0.5)
    );
    segLabels.push(`[${outLabel}]`);
  });
  parts.push(`${segLabels.join('')}concat=n=${shots.length}:v=1:a=0[base]`);
  return parts.join(';');
}

const WATERMARK_POSITIONS = {
  'kanan-atas': 'W-w-24:24',
  'kiri-atas': '24:24',
  'kanan-bawah': 'W-w-24:H-h-24',
  'kiri-bawah': '24:H-h-24',
};

async function encodeWithFallback(inputArgs, filterAndMapArgs, outputPath) {
  const vtAvailable = await hasVideoToolbox();
  const attempts = vtAvailable
    ? [
        // -realtime 0: VideoToolbox defaultnya asumsi live/streaming (ngejar kecepatan, bukan kualitas),
        // efeknya beberapa frame pertama tiap clip suka blur/kotak dulu sebelum bitrate-nya stabil.
        // Ini bukan live, jadi matikan mode itu biar dia boleh mikir lebih lama demi kualitas dari frame pertama.
        ['-c:v', 'h264_videotoolbox', '-b:v', '6M', '-profile:v', 'high', '-realtime', '0'],
        ['-c:v', 'libx264', '-crf', '21', '-preset', 'veryfast'],
      ]
    : [['-c:v', 'libx264', '-crf', '21', '-preset', 'veryfast']];

  const audioArgs = ['-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-movflags', '+faststart'];
  let lastErr;
  for (const encoderArgs of attempts) {
    try {
      await runFfmpeg([
        ...inputArgs,
        ...filterAndMapArgs,
        ...encoderArgs,
        ...audioArgs,
        outputPath,
      ]);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Render gagal dengan semua encoder yang dicoba. Error terakhir: ${lastErr.message}`);
}

// Render satu clip: potong dari source, reframe 9:16, bakar subtitle (kalau ada), tulis mp4 + srt ke outputDir.
// clip.style (opsional) override DEFAULT_STYLE: fontFamily, fontSize, captionPosition, captionStyle, highlightColor.
// clip.watermark (opsional): { imagePath, position: 'kanan-atas'|'kiri-atas'|'kanan-bawah'|'kiri-bawah', width }.
export async function renderClip(clip, outputDir) {
  const start = parseTimecode(clip.start) - PAD_BEFORE;
  const end = parseTimecode(clip.end) + PAD_AFTER;
  const duration = end - Math.max(0, start);
  const style = { ...DEFAULT_STYLE, ...(clip.style || {}) };

  const outputBase = clip.id || path.basename(clip.source, path.extname(clip.source));
  const outputMp4 = path.join(outputDir, `${outputBase}.mp4`);

  let assPath = null;
  if (style.captionStyle === 'boxed' && clip.words) {
    const words = JSON.parse(await fs.readFile(clip.words, 'utf8'));
    const assContent = wordsToAss(words, style);
    assPath = path.join(outputDir, `${outputBase}.ass`);
    await fs.writeFile(assPath, assContent, 'utf8');
    if (clip.srt) await fs.copyFile(clip.srt, path.join(outputDir, `${outputBase}.srt`));
  } else if (clip.srt) {
    const srtContent = await fs.readFile(clip.srt, 'utf8');
    const assContent = srtToAss(srtContent, style);
    assPath = path.join(outputDir, `${outputBase}.ass`);
    await fs.writeFile(assPath, assContent, 'utf8');
    await fs.copyFile(clip.srt, path.join(outputDir, `${outputBase}.srt`));
  }

  let shots = null;
  if (clip.reframe === 'dinamis' && clip.shots) {
    // shots dihitung relatif ke [cutStart,cutEnd] SEBELUM padding — geser supaya cocok dengan
    // input ffmpeg yang sudah mundur PAD_BEFORE detik, dan tutup ujung-ujungnya biar full-cover.
    const rawShots = JSON.parse(await fs.readFile(clip.shots, 'utf8'));
    shots = rawShots.map((s) => ({ ...s, start: s.start + PAD_BEFORE, end: s.end + PAD_BEFORE }));
    shots[0].start = 0;
    shots[shots.length - 1].end = duration;
  }

  const reframeFilter = buildReframeFilter(clip.reframe, shots);
  const filterParts = [reframeFilter];
  let currentLabel = '[base]';

  if (assPath) {
    filterParts.push(`${currentLabel}ass='${escapeForFilter(assPath)}'[subbed]`);
    currentLabel = '[subbed]';
  }

  const inputArgs = [
    '-ss', formatTimecode(Math.max(0, start)),
    '-i', clip.source,
  ];

  if (clip.watermark?.imagePath) {
    const wmWidth = clip.watermark.width || 160;
    const wmPos = WATERMARK_POSITIONS[clip.watermark.position] || WATERMARK_POSITIONS['kanan-atas'];
    // -loop 1: gambar statis butuh di-loop jadi "video" tak berhingga, kalau nggak overlay cuma nongol 1 frame.
    inputArgs.push('-loop', '1', '-i', clip.watermark.imagePath);
    filterParts.push(`[1:v]scale=${wmWidth}:-1[wm]`);
    filterParts.push(`${currentLabel}[wm]overlay=${wmPos}:shortest=1[watermarked]`);
    currentLabel = '[watermarked]';
  }

  const filterAndMapArgs = [
    '-filter_complex', filterParts.join(';'),
    '-map', currentLabel,
    '-map', '0:a?',
    '-t', String(duration),
  ];

  await encodeWithFallback(inputArgs, filterAndMapArgs, outputMp4);

  return {
    id: outputBase,
    mp4: outputMp4,
    srt: clip.srt ? path.join(outputDir, `${outputBase}.srt`) : null,
  };
}
