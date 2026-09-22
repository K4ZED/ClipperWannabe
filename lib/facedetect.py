#!/usr/bin/env python3
# Deteksi wajah pakai YuNet (ringan, CPU-only) di sekumpulan gambar hasil sampling ffmpeg.
# opencv-python-headless nggak punya backend video (nggak dikompilasi dengan FFmpeg), jadi
# baca video langsung nggak bisa — makanya sampling frame dilakukan ffmpeg dulu (lib/shotdetect.js),
# script ini cuma baca gambar-gambar itu (cv2.imread nggak butuh backend video sama sekali).
# Argumen: frames_dir interval_sec
# Output: JSON array [{t, faces: [{cx, w}, ...]}, ...] ke stdout, urut sesuai nama file.
import sys
import json
import os
import glob
import cv2

MODEL_PATH = os.path.join(os.path.dirname(__file__), 'models', 'face_detection_yunet.onnx')

def main():
    frames_dir, interval = sys.argv[1], float(sys.argv[2])
    frame_files = sorted(glob.glob(os.path.join(frames_dir, 'frame-*.jpg')))
    if not frame_files:
        print(json.dumps([]))
        return

    first = cv2.imread(frame_files[0])
    height, width = first.shape[:2]
    detector = cv2.FaceDetectorYN_create(MODEL_PATH, "", (width, height))

    samples = []
    for i, path in enumerate(frame_files):
        frame = cv2.imread(path)
        face_list = []
        if frame is not None:
            _, faces = detector.detect(frame)
            if faces is not None:
                for f in faces:
                    x, y, w, h, score = float(f[0]), float(f[1]), float(f[2]), float(f[3]), float(f[-1])
                    if score >= 0.7:
                        face_list.append({"cx": round((x + w / 2) / width, 4), "w": round(w / width, 4)})
        samples.append({"t": round(i * interval, 3), "faces": face_list})

    print(json.dumps(samples))

if __name__ == '__main__':
    main()
