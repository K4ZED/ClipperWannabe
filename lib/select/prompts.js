// Kriteria per genre dan builder prompt untuk deteksi genre + generasi kandidat momen.

export const GENRES = ['komedi', 'wawancara', 'cerita', 'opini'];
export const DEFAULT_GENRE = 'wawancara';

export const GENRE_CRITERIA = {
  komedi: {
    duration: '30 sampai 90 detik',
    criteria: 'Cari punchline. Setup wajib ikut masuk ke dalam clip, kalau tidak leluconnya tidak akan sampai ke penonton. Ini satu-satunya genre di mana clip yang terlalu pendek justru merugikan — jangan potong terlalu mepet ke punchline saja.',
  },
  wawancara: {
    duration: '40 sampai 90 detik',
    criteria: 'Cari satu ide yang selesai (utuh, tidak menggantung), biasanya diawali pertanyaan host yang tajam. Boleh lebih panjang karena penonton datang untuk isinya, bukan untuk kecepatan.',
  },
  cerita: {
    duration: '30 sampai 75 detik',
    criteria: 'Cari titik baliknya saja, bukan seluruh ceritanya. Patokannya momen "ternyata" atau "akhirnya" — bagian di mana cerita berbelok atau terungkap.',
  },
  opini: {
    duration: '25 sampai 60 detik',
    criteria: 'Cari kalimat yang membuat orang ingin membantah di kolom komentar. Pernyataan tajam, berani, atau kontroversial yang berdiri sendiri.',
  },
};

const OPENING_LINE_RULES = `Kalimat pembuka clip harus berdiri sendiri sepenuhnya. Tolak kandidat yang detik pertamanya:
- diawali kata sambung (jadi, terus, nah, dan, tapi, soalnya)
- merujuk sesuatu yang belum disebut dalam clip itu sendiri (itu, tadi, yang barusan, kayak gitu)
- diawali respons ke pembicara lain (iya, betul, setuju, hmm)`;

function formatTranscriptForPrompt(transcript) {
  return transcript
    .map((seg, i) => `[${i}] (${seg.start.toFixed(1)}s-${seg.end.toFixed(1)}s) ${seg.text}`)
    .join('\n');
}

export function buildGenreDetectionPrompt(transcript) {
  const firstFiveMinutes = transcript.filter((seg) => seg.start < 5 * 60);
  const excerpt = formatTranscriptForPrompt(firstFiveMinutes);

  return `Kamu menganalisis transkrip 5 menit pertama sebuah episode podcast Bahasa Indonesia untuk menentukan genrenya.

Pilih SATU dari: komedi, wawancara, cerita, opini.
- komedi: didominasi lelucon, banyolan, timing komedi
- wawancara: format tanya-jawab host-narasumber, membahas satu topik mendalam
- cerita: satu orang bercerita pengalaman/kejadian secara naratif
- opini: membahas pandangan/pendapat tentang suatu isu

Kalau ragu atau nadanya campur, pilih "wawancara".

Transkrip:
${excerpt}

Balas HANYA dengan JSON, tanpa penjelasan lain, format persis:
{"genre": "salah satu dari empat pilihan di atas"}`;
}

export function buildCandidatePrompt(transcript, genre) {
  const criteria = GENRE_CRITERIA[genre] ?? GENRE_CRITERIA[DEFAULT_GENRE];
  const transcriptText = formatTranscriptForPrompt(transcript);

  return `Kamu mencari momen terbaik dari transkrip episode podcast Bahasa Indonesia bergenre "${genre}" untuk dijadikan clip vertikal pendek (TikTok/Reels/Shorts).

Kriteria genre "${genre}":
${criteria.criteria}
Durasi target clip: ${criteria.duration}.

${OPENING_LINE_RULES}

Transkrip (format: [indeks segmen] (mulai-akhir detik) teks):
${transcriptText}

Tugas: cari 15 KANDIDAT momen terbaik. Untuk tiap kandidat, tentukan segmen AWAL dan AKHIR memakai INDEKS segmen di atas (bukan timestamp, bukan detik) — sistem akan mengambil timestamp asli dari indeks itu. Beri skor 1-10 (10 = paling layak jadi clip) dan alasan singkat.

Balas HANYA dengan JSON array, tanpa markdown code fence, tanpa penjelasan lain, format persis:
[
  {
    "segmentStart": 0,
    "segmentEnd": 5,
    "title": "judul singkat clip",
    "hook": "kalimat pembuka clip (harus sama persis dengan teks di segmen segmentStart)",
    "score": 8,
    "reason": "alasan singkat kenapa momen ini layak"
  }
]`;
}
