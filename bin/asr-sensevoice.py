#!/usr/bin/env python3
"""SenseVoice 语音转写：给网课/视频出文字（本地离线，App 自带模型）。

用法：
  asr-sensevoice.py <音频或视频文件> [--out FILE]
  asr-sensevoice.py --bv BV1xxxx [--p 3] [--start 00:00 --end 03:00] [--out FILE]

说明：
  - --bv 走 yt-dlp 下 B 站该分P音频（可只下 --start ~ --end 一段），下完即删；
  - 其它输入用 ffmpeg 转 16k 单声道 wav，按 25 秒切块转写再拼（避免长音频爆内存）；
  - 输出纯文本，每段一行；--out 不给就打印 stdout。
  - 数字/下标/负号 SenseVoice 容易听错，成稿前必须按数学常识人工还原。
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile

MODEL_DIR = os.path.join(os.environ.get("DSH_HOME", "/root/.dsh"),
                        "speech-to-text/sensevoice/models/sensevoice-onnx")
MODEL = os.path.join(MODEL_DIR, "model.int8.onnx")
TOKENS = os.path.join(MODEL_DIR, "tokens.txt")
YTDLP = shutil.which("yt-dlp") or "/opt/python/bin/yt-dlp"


def die(msg):
    print(f"[asr] {msg}", file=sys.stderr)
    sys.exit(1)


def to_wav(src, dest):
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", src, "-ar", "16000", "-ac", "1", dest],
        capture_output=True, text=True)
    if r.returncode != 0:
        die(f"ffmpeg 转 wav 失败：{r.stderr[-300:]}")


def fetch_bili(bv, page, start, end, dest_dir):
    url = f"https://www.bilibili.com/video/{bv}" + (f"?p={page}" if page else "")
    out = os.path.join(dest_dir, f"{bv}-p{page or 1}.%(ext)s")
    cmd = [YTDLP, "-q", "--no-warnings", "-f", "ba[ext=m4a]/ba"]
    if start or end:
        cmd += ["--download-sections", f"*{start or '0:00'}-{end or '99:59:59'}"]
    cmd += ["-o", out, url]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        die(f"yt-dlp 下载失败：{r.stderr[-300:]}")
    for f in sorted(os.listdir(dest_dir)):
        if f.startswith(f"{bv}-p{page or 1}."):
            return os.path.join(dest_dir, f)
    die("yt-dlp 下载没找到文件")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input", nargs="?", help="音频/视频文件路径")
    ap.add_argument("--bv", help="B 站 BV 号（自动下载）")
    ap.add_argument("--p", type=int, default=1, help="分P，默认 1")
    ap.add_argument("--start", default="", help="起，如 0:00")
    ap.add_argument("--end", default="", help="止，如 3:00")
    ap.add_argument("--out", help="输出 txt 路径")
    ap.add_argument("--chunk", type=int, default=25, help="切块秒数，默认 25")
    args = ap.parse_args()
    if not args.input and not args.bv:
        die("给一个文件，或 --bv 加 --p/--start/--end")

    tmp = tempfile.mkdtemp(prefix="asr-")
    try:
        if args.bv:
            src = fetch_bili(args.bv, args.p, args.start, args.end, tmp)
        else:
            src = args.input
        wav = os.path.join(tmp, "a.wav")
        to_wav(src, wav)

        import wave
        import numpy as np
        import sherpa_onnx

        rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=MODEL, tokens=TOKENS, num_threads=3, use_itn=True, language="zh")

        with wave.open(wav) as w:
            sr = w.getframerate()
            total = w.getnframes()
            step = args.chunk * sr
            texts = []
            pos = 0
            while pos < total:
                w.setpos(pos)
                n = min(step, total - pos)
                buf = w.readframes(n)
                samples = np.frombuffer(buf, dtype=np.int16).astype(np.float32) / 32768.0
                st = rec.create_stream()
                st.accept_waveform(sr, samples)
                rec.decode_stream(st)
                t = (st.result.text or "").strip()
                if t:
                    texts.append(t)
                pos += n
            print(f"[asr] {total / sr:.0f}s 音频，{len(texts)} 段", file=sys.stderr)
        text = "\n".join(texts)
        if args.out:
            with open(args.out, "w", encoding="utf-8") as f:
                f.write(text + "\n")
            print(f"[asr] 已写 {args.out}（{len(text)} 字）", file=sys.stderr)
        else:
            print(text)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
