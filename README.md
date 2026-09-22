# Podclip

Tool lokal untuk mengubah episode podcast panjang jadi clip vertikal (9:16) siap upload ke TikTok/Instagram/Shorts. Transkrip, cari momen terbaik, potong, reframe, dan bakar subtitle, semuanya otomatis.

## Fitur

- **Download** episode langsung dari YouTube (yt-dlp), atau taruh file video manual di `input/`.
- **Transkripsi otomatis** (Groq Whisper API, dengan whisper.cpp lokal sebagai cadangan).
- **Pemilihan momen otomatis** pakai LLM (Gemini, dengan Ollama lokal sebagai cadangan): cari bagian paling menarik, potong di batas hening terdekat, jaga kalimat pembuka tetap enak didengar.
- **Deteksi genre otomatis** per episode (wawancara, komedi, cerita, opini) untuk menyesuaikan gaya pemilihan momen.
- **Reframe 9:16**: blur background, crop tengah, split atas-bawah (buat shot 2 orang berdampingan), atau **dinamis** (deteksi wajah otomatis buat gonta-ganti mode wide/solo sesuai momen).
- **Subtitle**: gaya klasik (kalimat, wrap otomatis) atau **boxed** (kalimat utuh, kata yang lagi diucapkan dapat kotak highlight warna, sinkron ke ucapan).
- Font, posisi caption, dan watermark bisa diatur, semua lewat UI visual (bukan dropdown teks).
- Proses multi-episode sekaligus, hasil dirangking & di-dedupe lintas episode.

## Kebutuhan sistem

- [Node.js](https://nodejs.org) 20+
- [ffmpeg](https://ffmpeg.org) & ffprobe di PATH
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) di PATH (kalau mau download dari YouTube)
- Python 3.9+ (cuma kalau mau pakai mode reframe **dinamis**, deteksi wajah)

```bash
brew install ffmpeg yt-dlp
```

## Instalasi

```bash
git clone https://github.com/K4ZED/ClipperWannabe.git
cd ClipperWannabe
npm install
cp .env.example .env
```

Isi `.env` dengan API key kamu (lihat komentar di dalam file). Tanpa `GROQ_API_KEY` / `GEMINI_API_KEY`, tool otomatis pakai fallback lokal (whisper.cpp / Ollama) kalau sudah terpasang.

### Opsional: mode reframe "Dinamis" (deteksi wajah)

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Tanpa langkah ini, mode reframe lain (blur, crop, split) tetap jalan normal. Cuma mode "Dinamis" yang butuh venv ini.

## Menjalankan

```bash
npm start
```

Buka [http://localhost:3000](http://localhost:3000).

Alur pakainya: **Langkah 1** download/siapkan video → **Langkah 2** pilih video, atur genre/jumlah clip/gaya tampilan, klik "Analisis & Render" → **Langkah 3** hasil clip muncul, langsung bisa ditonton & diunduh.

## Struktur folder

```
server.js          Express server + orkestrasi pipeline
lib/                Logika inti (transkripsi, pemilihan momen, cut, render, deteksi wajah)
public/             Frontend (HTML/CSS/JS polos, tanpa build step)
input/              Taruh video sumber di sini
output/             Hasil clip per job
data/               Cache transkrip, status job, file .srt/.ass sementara
```

## Catatan

Ini alat internal buat kebutuhan sendiri, bukan produk yang dipublikasikan. Dijalankan lokal, tanpa autentikasi.
