// Tentukan batas potong final: timestamp dari segmen transkrip, digeser ke jeda hening terdekat,
// lalu dikasih padding. Batas potong TIDAK PERNAH langsung dari angka yang disebut model.
const MAX_SNAP_SECONDS = 2;
const PAD_BEFORE = 0.3;
const PAD_AFTER = 0.5;

// Titik mulai: cari akhir hening (silence_end) terdekat, maksimal geser 2 detik.
function snapStart(rawStart, silenceRanges) {
  let best = rawStart;
  let bestDist = Infinity;
  for (const range of silenceRanges) {
    const dist = Math.abs(range.end - rawStart);
    if (dist < bestDist) {
      bestDist = dist;
      best = range.end;
    }
  }
  return bestDist <= MAX_SNAP_SECONDS ? best : rawStart;
}

// Titik akhir: cari awal hening (silence_start) terdekat, maksimal geser 2 detik.
function snapEnd(rawEnd, silenceRanges) {
  let best = rawEnd;
  let bestDist = Infinity;
  for (const range of silenceRanges) {
    const dist = Math.abs(range.start - rawEnd);
    if (dist < bestDist) {
      bestDist = dist;
      best = range.start;
    }
  }
  return bestDist <= MAX_SNAP_SECONDS ? best : rawEnd;
}

// Groq bisa balikin ratusan/ribuan segmen super pendek untuk episode panjang (mis. 1800+ segmen buat 56 menit).
// Itu bikin prompt ke model kegedean dan requestnya gagal/lambat. Gabungkan jadi blok ~targetSeconds
// sebelum dikirim ke model pemilihan momen — batas grup tetap jatuh persis di batas segmen asli Whisper,
// jadi tidak mengorbankan akurasi titik potong (snapping ke hening tetap pakai timestamp asli).
export function mergeSegmentsForPrompt(transcript, targetSeconds = 12) {
  const merged = [];
  let group = [];
  let groupStart = null;

  for (const seg of transcript) {
    if (group.length === 0) groupStart = seg.start;
    group.push(seg);
    if (seg.end - groupStart >= targetSeconds) {
      merged.push({ start: groupStart, end: seg.end, text: group.map((s) => s.text).join(' ') });
      group = [];
    }
  }
  if (group.length > 0) {
    merged.push({ start: groupStart, end: group[group.length - 1].end, text: group.map((s) => s.text).join(' ') });
  }
  return merged;
}

function normalizeText(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
}

// candidate.hook seharusnya sama persis dengan teks segmen pembuka (diminta di prompt), tapi segmentStart
// yang dikirim ke model adalah indeks transkrip yang SUDAH DIGABUNG jadi blok ~12 detik (lihat
// mergeSegmentsForPrompt) — jadi awal blok itu bisa saja bukan awal kalimat yang sebenarnya dimaksud model
// (mis. nyangkut sisa kalimat orang lain di depannya). Cocokkan hook ke transkrip ASLI (belum digabung)
// untuk dapat indeks segmen yang presisi di batas kalimat.
function findHookIndex(transcript, hook) {
  if (!hook) return -1;
  const target = normalizeText(hook);
  if (!target) return -1;

  const exactIndex = transcript.findIndex((seg) => normalizeText(seg.text) === target);
  if (exactIndex !== -1) return exactIndex;

  const targetPrefix = target.split(/\s+/).slice(0, 4).join(' ');
  return transcript.findIndex((seg) => normalizeText(seg.text).startsWith(targetPrefix));
}

// Model kadang lolos meletakkan kata sambung/respons di detik pertama meski sudah dilarang eksplisit di
// prompt (LLM tidak 100% patuh instruksi) — ini pengaman di level kode, bukan cuma andalan prompt.
// Daftar dari spec: kata sambung, rujukan yang belum disebut, respons ke pembicara lain — plus beberapa
// kata sejenis yang punya fungsi sama (mis. "padahal" = kontrastif seperti "tapi").
const BANNED_OPENERS = [
  'jadi', 'terus', 'nah', 'dan', 'tapi', 'soalnya', 'padahal', 'karena', 'makanya',
  'itu', 'tadi', 'yang barusan', 'kayak gitu', 'gitu',
  'iya', 'betul', 'setuju', 'hmm', 'oh', 'eh',
  'gak', 'ga', 'nggak', 'enggak', 'kaga', 'engga',
];

function startsWithBannedWord(text) {
  const normalized = normalizeText(text);
  return BANNED_OPENERS.some((w) => normalized === w || normalized.startsWith(`${w} `));
}

// Cari indeks segmen pertama mulai dari startIndex yang TIDAK diawali kata terlarang, dibatasi beberapa
// segmen ke depan supaya tidak melenceng jauh dari momen yang dimaksud model.
function findCleanOpeningIndex(transcript, startIndex, maxLookahead = 6) {
  const end = Math.min(transcript.length, startIndex + maxLookahead);
  for (let i = startIndex; i < end; i += 1) {
    if (!startsWithBannedWord(transcript[i].text)) return i;
  }
  return startIndex;
}

// candidate: { segmentStart, segmentEnd } berupa INDEKS segmen transkrip (yang dikirim ke model), bukan detik.
// promptTranscript: transkrip yang sudah digabung (yang indeksnya dirujuk candidate).
// fullTranscript: transkrip asli buat cari titik mulai presisi lewat hook + validasi kalimat pembuka.
export function determineCutBoundaries(candidate, promptTranscript, silenceRanges, episodeDuration, fullTranscript) {
  let rawStart;
  let minStart = 0; // batas bawah: padding TIDAK BOLEH masuk balik ke ujung segmen sebelumnya yang sengaja dihindari
  if (fullTranscript) {
    const groupStartTime = promptTranscript[candidate.segmentStart].start;
    let anchorIndex = findHookIndex(fullTranscript, candidate.hook);
    if (anchorIndex === -1) {
      anchorIndex = fullTranscript.findIndex((seg) => seg.start >= groupStartTime);
      if (anchorIndex === -1) anchorIndex = 0;
    }
    const cleanIndex = findCleanOpeningIndex(fullTranscript, anchorIndex);
    rawStart = fullTranscript[cleanIndex].start;
    minStart = cleanIndex > 0 ? fullTranscript[cleanIndex - 1].end : 0;
  } else {
    rawStart = promptTranscript[candidate.segmentStart].start;
  }
  const rawEnd = promptTranscript[candidate.segmentEnd].end;

  const snappedStart = snapStart(rawStart, silenceRanges);
  const snappedEnd = snapEnd(rawEnd, silenceRanges);

  const start = Math.max(0, minStart, snappedStart - PAD_BEFORE);
  const end = episodeDuration ? Math.min(episodeDuration, snappedEnd + PAD_AFTER) : snappedEnd + PAD_AFTER;

  return { start, end };
}

function formatSrtTimestamp(seconds) {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

// Potong transkrip episode ke rentang [start, end] clip, timestamp digeser relatif ke 0 = mulainya clip.
export function buildClipSrt(transcript, start, end) {
  const cues = transcript.filter((seg) => seg.end > start && seg.start < end);
  return cues
    .map((seg, i) => {
      const relStart = Math.max(0, seg.start - start);
      const relEnd = Math.min(end - start, seg.end - start);
      return `${i + 1}\n${formatSrtTimestamp(relStart)} --> ${formatSrtTimestamp(relEnd)}\n${seg.text}\n`;
    })
    .join('\n');
}

// Buang kandidat yang rentang waktunya tumpang tindih dengan kandidat berskor lebih tinggi yang sudah dipilih.
export function removeOverlaps(rankedCandidates) {
  const selected = [];
  for (const candidate of rankedCandidates) {
    const overlaps = selected.some((s) =>
      s.source === candidate.source &&
      candidate.cutStart < s.cutEnd &&
      candidate.cutEnd > s.cutStart
    );
    if (!overlaps) selected.push(candidate);
  }
  return selected;
}
