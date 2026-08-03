#!/usr/bin/env python3
"""從一段連續錄音切出遊戲音效，最後打包成 audio sprite。

跟 slice_assets.py 是同一套路：素材放原始檔，切割規則寫成純文字，
重跑腳本就能得到一模一樣的結果。

三個步驟：

  1. analyze  自動找出「聲音在哪裡」，產生候選片段清單 + 波形圖
  2. cut      依照你標好名字的 cue sheet 切出片段（降噪、正規化、去頭尾靜音）
  3. sprite   把片段接成單一檔案 + 時間偏移表，給網頁一次載入

機器只能自動找「邊界」，沒辦法知道「第 47 段是中獎還是押注」，
所以中間一定要人工把 segments.tsv 的名字填上。

用法：

    # 1. 先看看錄音裡有哪些片段（來源可以是 mp4 / mp3 / wav …）
    python3 tools/slice_audio.py analyze audio/src/raw.mp4

    #    → audio/work/segments.tsv   候選片段（把 name 欄改成正式名稱）
    #    → audio/work/waveform.png   標了編號的波形圖，對照用
    #    → audio/work/preview/*.wav  每段的試聽檔

    # 2. 編輯 segments.tsv，只留下要用的段落並命名，然後切
    python3 tools/slice_audio.py cut audio/src/raw.mp4 --cues audio/work/segments.tsv

    #    → audio/clips/*.wav

    # 3. 打包
    python3 tools/slice_audio.py sprite

    #    → assets/audio/sprite.mp3 / sprite.ogg / sprite.json

需要的套件（都能用 pip 裝，不必系統權限）：

    pip install imageio-ffmpeg numpy pillow
"""

import argparse
import json
import os
import re
import subprocess
import sys
import wave

import numpy as np

# ── 路徑 ────────────────────────────────────────────────────────────

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK_DIR = os.path.join(ROOT, "audio", "work")
CLIP_DIR = os.path.join(ROOT, "audio", "clips")
OUT_DIR = os.path.join(ROOT, "assets", "audio")

# 中介檔一律轉成這個規格，後面所有分析都以它為準
SR = 32000          # 取樣率：機台音效都是方波/短促音，32k 綽綽有餘
# sprite 裡片段之間留的空白秒數。留得夠寬有兩個作用：播放時不會吃到隔壁，
# 而且網頁端可以靠「找出這些靜音」重新推算每段的位置 —— mp3 解碼會在開頭多出
# 編碼器延遲，硬套 json 裡的偏移量會整批位移，對 37ms 的 tick 是致命的。
SPRITE_GAP = 0.10


# ── ffmpeg ──────────────────────────────────────────────────────────

def ffmpeg_exe():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        pass
    from shutil import which
    exe = which("ffmpeg")
    if not exe:
        sys.exit("找不到 ffmpeg。請執行： pip install imageio-ffmpeg")
    return exe


FFMPEG = None


def run_ffmpeg(args):
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y"] + args
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        sys.exit("ffmpeg 失敗：\n" + " ".join(cmd) + "\n" + p.stderr)


def to_mono_wav(src, dst):
    """把任何來源（mp4 / mp3 / wav …）轉成單聲道 wav，後面都用它。"""
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    run_ffmpeg(["-i", src, "-vn", "-ac", "1", "-ar", str(SR),
                "-c:a", "pcm_s16le", dst])
    return dst


def read_wav(path):
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            sys.exit("只支援 16-bit wav：" + path)
        data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
        return data.astype(np.float32) / 32768.0, w.getframerate()


# ── 時間格式 ────────────────────────────────────────────────────────

def fmt_time(sec):
    m, s = divmod(float(sec), 60)
    return "%02d:%06.3f" % (int(m), s)


def parse_time(text):
    """接受 mm:ss.mmm、ss.mmm 兩種寫法。"""
    text = text.strip()
    if ":" in text:
        m, s = text.rsplit(":", 1)
        return float(m) * 60 + float(s)
    return float(text)


# ── 1. analyze ──────────────────────────────────────────────────────

def envelope(samples, hop):
    """把波形壓成每 hop 個取樣一格的 RMS 包絡，之後偵測與畫圖都用它。"""
    n = len(samples) // hop
    trimmed = samples[:n * hop].reshape(n, hop)
    return np.sqrt((trimmed ** 2).mean(axis=1) + 1e-12)


def find_segments(samples, sr, thresh_db, min_sound, min_silence):
    """用 RMS 門檻找出「有聲音」的區段。

    自己算而不去解析 ffmpeg silencedetect 的輸出，是因為包絡本來就要拿來
    畫波形圖，而且門檻、最短長度這些參數自己控制比較直覺。
    """
    hop = max(1, int(sr * 0.005))          # 5ms 一格
    env = envelope(samples, hop)
    env_db = 20 * np.log10(env + 1e-12)

    loud = env_db > thresh_db
    # 短暫的低谷不算分段（跑燈那種連續嗶聲中間會有小凹陷）
    gap_frames = max(1, int(min_silence / (hop / sr)))
    idx = np.flatnonzero(loud)
    if idx.size == 0:
        return [], env, hop

    segs = []
    start = idx[0]
    prev = idx[0]
    for i in idx[1:]:
        if i - prev > gap_frames:
            segs.append((start, prev))
            start = i
        prev = i
    segs.append((start, prev))

    min_frames = max(1, int(min_sound / (hop / sr)))
    out = []
    for a, b in segs:
        if b - a + 1 < min_frames:
            continue
        out.append((a * hop / sr, (b + 1) * hop / sr))
    return out, env, hop


def draw_waveform(env, hop, sr, segs, path, width=1800, row_sec=20.0):
    """畫出標了編號的波形圖，方便對照影片找出哪一段是什麼。

    每一列分成三條：上面放片段編號、中間是波形、下面是時間刻度。分開放是因為
    跑燈那種密集的片段，編號疊在波形上會整排糊掉。編號還會上下交錯，相鄰的
    窄片段才不會互相蓋住。
    """
    from PIL import Image, ImageDraw

    total = len(env) * hop / sr
    rows = max(1, int(np.ceil(total / row_sec)))
    lbl_h, wave_h, time_h, gap = 30, 84, 18, 14
    row_h = lbl_h + wave_h + time_h + gap
    img = Image.new("RGB", (width, rows * row_h + gap), (18, 17, 22))
    d = ImageDraw.Draw(img)

    def x_of(t, t0, t1):
        return int((t - t0) / max(t1 - t0, 1e-9) * (width - 1))

    for r in range(rows):
        t0, t1 = r * row_sec, min((r + 1) * row_sec, total)
        top = r * row_h + gap
        wave_top = top + lbl_h
        base = wave_top + wave_h // 2
        d.line([(0, base), (width, base)], fill=(52, 48, 60))

        # 波形包絡
        for x in range(width):
            ta = t0 + (t1 - t0) * x / width
            tb = t0 + (t1 - t0) * (x + 1) / width
            ia, ib = int(ta * sr / hop), max(int(tb * sr / hop), int(ta * sr / hop) + 1)
            chunk = env[ia:ib]
            if not len(chunk):
                continue
            h = int(min(chunk.max() * 3.2, 1.0) * (wave_h // 2 - 4))
            d.line([(x, base - h), (x, base + h)], fill=(120, 210, 255))

        # 時間刻度：每列固定切 10 格，長短錄音都看得清楚
        step = (t1 - t0) / 10 or 1
        for k in range(11):
            t = t0 + k * step
            x = min(x_of(t, t0, t1), width - 1)
            d.line([(x, wave_top), (x, wave_top + wave_h)], fill=(60, 56, 68))
            d.text((min(x + 3, width - 52), wave_top + wave_h + 3),
                   fmt_time(t), fill=(140, 134, 150))

        # 片段方框 + 編號（編號交錯兩層，避免相鄰窄片段疊字）
        level = 0
        prev_x = -999
        for i, (s, e) in enumerate(segs, 1):
            if e < t0 or s > t1:
                continue
            xa, xb = x_of(max(s, t0), t0, t1), x_of(min(e, t1), t0, t1)
            d.rectangle([xa, wave_top, max(xb, xa + 1), wave_top + wave_h],
                        outline=(255, 190, 60))
            level = 0 if xa - prev_x > 26 else 1 - level
            d.text((xa + 1, top + 2 + level * 13), str(i), fill=(255, 214, 110))
            prev_x = xa

    img.save(path)


def cmd_analyze(args):
    os.makedirs(WORK_DIR, exist_ok=True)
    mono = to_mono_wav(args.source, os.path.join(WORK_DIR, "source.wav"))
    samples, sr = read_wav(mono)

    segs, env, hop = find_segments(samples, sr, args.threshold,
                                   args.min_sound, args.min_silence)
    if not segs:
        sys.exit("沒偵測到任何聲音，試著把 --threshold 調低（例如 -50）")

    tsv = os.path.join(WORK_DIR, "segments.tsv")
    with open(tsv, "w", encoding="utf-8") as f:
        f.write("# 把 name 欄改成正式名稱，刪掉不要的列，再執行 cut\n")
        f.write("# 名稱建議：coin bet tick land win_small win_big win_bar lose\n"
                "#           special bonus double_in double_roll double_win double_lose\n"
                "#           wash payout\n")
        f.write("# name\tstart\tend\n")
        for i, (s, e) in enumerate(segs, 1):
            f.write("seg_%03d\t%s\t%s\n" % (i, fmt_time(s), fmt_time(e)))

    png = os.path.join(WORK_DIR, "waveform.png")
    draw_waveform(env, hop, sr, segs, png)

    prev_dir = os.path.join(WORK_DIR, "preview")
    os.makedirs(prev_dir, exist_ok=True)
    for old in os.listdir(prev_dir):
        os.remove(os.path.join(prev_dir, old))
    for i, (s, e) in enumerate(segs, 1):
        run_ffmpeg(["-i", mono, "-ss", "%.3f" % s, "-to", "%.3f" % e,
                    os.path.join(prev_dir, "seg_%03d.wav" % i)])

    print("總長 %s，偵測到 %d 段" % (fmt_time(len(samples) / sr), len(segs)))
    print("  片段清單 :", tsv)
    print("  波形圖   :", png)
    print("  試聽檔   :", prev_dir)
    print("\n下一步：編輯 segments.tsv 填上名稱，再執行")
    print("  python3 tools/slice_audio.py cut %s --cues %s" % (args.source, tsv))


# ── 2. cut ──────────────────────────────────────────────────────────

def read_cues(path):
    cues = []
    with open(path, encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = re.split(r"[\t,]+|\s{2,}", line)
            if len(parts) < 3:
                parts = line.split()
            if len(parts) < 3:
                sys.exit("第 %d 行看不懂（需要 名稱 開始 結束）：%s" % (lineno, line))
            name, start, end = parts[0], parse_time(parts[1]), parse_time(parts[2])
            if end <= start:
                sys.exit("第 %d 行的結束時間不在開始之後：%s" % (lineno, line))
            # 第四欄（選填）是淡出毫秒數。切在旋律中間的長片段要拉長淡出，
            # 不然結尾會斷得很突兀；短音效用預設的 3ms 就好。
            fade = float(parts[3]) if len(parts) > 3 else None
            cues.append((name, start, end, fade))
    if not cues:
        sys.exit("cue sheet 裡沒有任何有效的列：" + path)
    return cues


def cmd_cut(args):
    cues = read_cues(args.cues)
    # 還沒改過名字的候選段落不切，避免整包 seg_001 這種檔名進到成品
    named = [c for c in cues if not re.fullmatch(r"seg_\d+", c[0])]
    if not named:
        sys.exit("segments.tsv 裡的名稱都還是 seg_xxx —— 請先改成正式名稱再執行 cut")

    os.makedirs(CLIP_DIR, exist_ok=True)
    mono = to_mono_wav(args.source, os.path.join(WORK_DIR, "source.wav"))

    for name, start, end, fade in named:
        # ffmpeg 只做頻域的事：低頻隆隆聲、選用的降噪。
        #
        # 去頭尾靜音、淡入淡出、正規化全部在 numpy 做，理由有二：
        #   1. silenceremove + areverse + silenceremove 這個常見寫法會整段吃掉
        #      （實測長 0.48s 的旋律變成 0.000s），濾波器串接的行為不好預期。
        #   2. dynaudnorm 那類動態正規化會把衰減的尾音推上來、改掉音色，
        #      而這裡的目標是保留真機音色，只要固定增益的峰值正規化。
        chain = ["highpass=f=60"]
        if args.denoise:
            chain.append("afftdn=nf=-28")

        dst = os.path.join(CLIP_DIR, name + ".wav")
        run_ffmpeg(["-i", mono, "-ss", "%.3f" % start, "-to", "%.3f" % end,
                    "-af", ",".join(chain), "-ar", str(SR), "-ac", "1", dst])
        polish_clip(dst, args.trim_threshold, args.peak_db, fade_out_ms=fade)
        print("  %-14s %6.3fs  %s" % (name, wav_duration(dst), dst))

    print("\n切出 %d 段 → %s" % (len(named), CLIP_DIR))
    print("下一步： python3 tools/slice_audio.py sprite")


def wav_duration(path):
    with wave.open(path, "rb") as w:
        return w.getnframes() / w.getframerate()


def write_wav(path, samples, sr=SR):
    data = np.clip(samples, -1.0, 1.0)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((data * 32767).astype("<i2").tobytes())


def trim_silence(samples, sr, threshold_db, pad_ms=6.0):
    """削掉頭尾的靜音，前後各留一點餘裕免得切到起音。

    只看頭尾，中間的空隙一律保留 —— 中獎旋律那種「音、停、音」的結構
    不能被當成兩段。
    """
    thr = 10 ** (threshold_db / 20.0)
    loud = np.flatnonzero(np.abs(samples) > thr)
    if not len(loud):
        return samples[:0]
    pad = int(sr * pad_ms / 1000)
    return samples[max(0, loud[0] - pad):min(len(samples), loud[-1] + 1 + pad)]


def polish_clip(path, trim_db, peak_db, fade_ms=3.0, fade_out_ms=None):
    """去頭尾靜音 → 淡入淡出 → 峰值正規化。

    淡出是必要的：切點如果落在波形非零的地方，播放結束會有「喀」的爆音。
    切在旋律中間的長片段可以用 cue sheet 的第四欄指定較長的淡出。
    正規化用固定增益（不是動態的），所以片段內部的強弱關係完全不變。
    """
    samples, sr = read_wav(path)
    samples = trim_silence(samples, sr, trim_db)
    if not len(samples):
        print("  ! %s 在 %d dB 門檻下整段都算靜音，請調低 --trim-threshold"
              % (os.path.basename(path), trim_db))
        write_wav(path, samples, sr)
        return

    n = min(int(sr * fade_ms / 1000), len(samples) // 2)
    if n > 0:
        samples[:n] *= np.linspace(0.0, 1.0, n, dtype=np.float32)
    m = min(int(sr * (fade_out_ms if fade_out_ms else fade_ms) / 1000),
            len(samples) - 1)
    if m > 0:
        samples[-m:] *= np.linspace(1.0, 0.0, m, dtype=np.float32)

    peak = float(np.abs(samples).max())
    if peak > 0:
        samples *= (10 ** (peak_db / 20.0)) / peak

    write_wav(path, samples, sr)


# ── 3. sprite ───────────────────────────────────────────────────────

def cmd_sprite(args):
    if not os.path.isdir(CLIP_DIR):
        sys.exit("找不到 %s，請先執行 cut" % CLIP_DIR)
    clips = sorted(f for f in os.listdir(CLIP_DIR) if f.endswith(".wav"))
    if args.only:
        want = [n.strip() for n in args.only.split(",") if n.strip()]
        missing = [n for n in want if n + ".wav" not in clips]
        if missing:
            sys.exit("找不到這些片段：" + ", ".join(missing))
        clips = [n + ".wav" for n in want]
    if not clips:
        sys.exit("%s 裡沒有 wav" % CLIP_DIR)

    os.makedirs(OUT_DIR, exist_ok=True)
    gap = np.zeros(int(SR * SPRITE_GAP), dtype=np.float32)

    parts, index, cursor = [], {}, 0.0
    for f in clips:
        samples, sr = read_wav(os.path.join(CLIP_DIR, f))
        if sr != SR:
            sys.exit("%s 的取樣率是 %d，預期 %d —— 請重跑 cut" % (f, sr, SR))
        index[os.path.splitext(f)[0]] = [round(cursor, 4),
                                         round(len(samples) / SR, 4)]
        parts.append(samples)
        parts.append(gap)
        cursor += len(samples) / SR + SPRITE_GAP

    merged = np.concatenate(parts)
    peak = float(np.abs(merged).max()) or 1.0
    merged = (merged / peak * 0.95 * 32767).astype("<i2")

    raw = os.path.join(WORK_DIR, "sprite.wav")
    os.makedirs(WORK_DIR, exist_ok=True)
    with wave.open(raw, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(merged.tobytes())

    mp3 = os.path.join(OUT_DIR, "sprite.mp3")
    ogg = os.path.join(OUT_DIR, "sprite.ogg")
    run_ffmpeg(["-i", raw, "-c:a", "libmp3lame", "-b:a", args.bitrate, "-ac", "1", mp3])
    run_ffmpeg(["-i", raw, "-c:a", "libvorbis", "-b:a", args.bitrate, "-ac", "1", ogg])

    meta = os.path.join(OUT_DIR, "sprite.json")
    with open(meta, "w", encoding="utf-8") as f:
        json.dump({"sampleRate": SR, "clips": index}, f,
                  ensure_ascii=False, indent=2, sort_keys=True)

    print("打包 %d 段，總長 %.2fs" % (len(index), cursor))
    for p in (mp3, ogg, meta):
        print("  %-28s %6.1f KB" % (os.path.relpath(p, ROOT), os.path.getsize(p) / 1024))


# ── CLI ─────────────────────────────────────────────────────────────

def main():
    global FFMPEG
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("analyze", help="自動找出片段，產生清單與波形圖")
    a.add_argument("source", help="來源檔（mp4 / mp3 / wav …）")
    a.add_argument("--threshold", type=float, default=-42.0,
                   help="判定為有聲音的 dBFS 門檻，底噪大就調高（預設 -42）")
    a.add_argument("--min-sound", type=float, default=0.03,
                   help="片段最短秒數，太短的當雜訊丟掉（預設 0.03）")
    a.add_argument("--min-silence", type=float, default=0.08,
                   help="間隔多久才算切開，跑燈連續嗶聲要調小（預設 0.08）")
    a.set_defaults(func=cmd_analyze)

    c = sub.add_parser("cut", help="依 cue sheet 切出片段")
    c.add_argument("source", help="來源檔（跟 analyze 用同一個）")
    c.add_argument("--cues", default=os.path.join(WORK_DIR, "segments.tsv"))
    c.add_argument("--denoise", action="store_true",
                   help="開啟降噪（底噪重再開，會讓音色變金屬感）")
    c.add_argument("--trim-threshold", type=int, default=-45,
                   help="頭尾靜音的判定門檻 dB，底噪大就調高（預設 -45）")
    c.add_argument("--peak-db", type=float, default=-1.0,
                   help="正規化的目標峰值 dBFS（預設 -1）")
    c.set_defaults(func=cmd_cut)

    s = sub.add_parser("sprite", help="把片段打包成單一檔案 + 偏移表")
    s.add_argument("--bitrate", default="64k")
    s.add_argument("--only", default="",
                   help="只打包指定的片段（逗號分隔），順序照給的順序")
    s.set_defaults(func=cmd_sprite)

    args = ap.parse_args()
    FFMPEG = ffmpeg_exe()
    args.func(args)


if __name__ == "__main__":
    main()
