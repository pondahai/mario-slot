#!/usr/bin/env python3
"""Cắt hiệu ứng âm thanh của trò chơi từ một bản ghi liên tục, rồi đóng gói thành audio sprite.

Cùng một quy trình với slice_assets.py: nguồn giữ nguyên, quy tắc cắt viết thành
văn bản, chạy lại script sẽ ra kết quả giống hệt.

Ba bước:

  1. analyze  tự động tìm "âm thanh nằm ở đâu", tạo danh sách đoạn ứng viên + dạng sóng
  2. cut      cắt theo cue sheet đã đặt tên (khử nhiễu, chuẩn hóa, bỏ khoảng lặng đầu/cuối)
  3. sprite   nối các đoạn thành một file + bảng độ lệch thời gian, để web tải một lần

Máy chỉ tự tìm được "biên", không biết được đoạn thứ 47 là trúng thưởng hay cược,
nên bước giữa nhất định phải đặt tên thủ công trong segments.tsv.

Cách dùng:

    # 1. Xem trước trong bản ghi có những đoạn âm thanh nào (nguồn có thể là mp4 / mp3 / wav …)
    python3 tools/slice_audio.py analyze audio/src/raw.mp4

    #    → audio/work/segments.tsv   danh sách đoạn ứng viên (đổi cột name thành tên chính thức)
    #    → audio/work/waveform.png   dạng sóng có đánh số, để đối chiếu
    #    → audio/work/preview/*.wav  file nghe thử của từng đoạn

    # 2. Sửa segments.tsv, chỉ giữ lại các đoạn cần dùng và đặt tên, rồi cắt
    python3 tools/slice_audio.py cut audio/src/raw.mp4 --cues audio/work/segments.tsv

    #    → audio/clips/*.wav

    # 3. Đóng gói
    python3 tools/slice_audio.py sprite

    #    → assets/audio/sprite.mp3 / sprite.ogg / sprite.json

Thư viện cần thiết (đều cài bằng pip, không cần quyền hệ thống):

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

# ── Đường dẫn ───────────────────────────────────────────────────────

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK_DIR = os.path.join(ROOT, "audio", "work")
CLIP_DIR = os.path.join(ROOT, "audio", "clips")
OUT_DIR = os.path.join(ROOT, "assets", "audio")

# Mọi file trung gian đều chuyển về định dạng này, các bước phân tích sau đó đều dựa vào nó
SR = 32000          # Tần số lấy mẫu: âm thanh máy đều là sóng vuông/tiếng ngắn gọn, 32k là đủ
# Khoảng lặng (giây) giữa các đoạn trong sprite. Để đủ rộng để: lúc phát không lấn sang đoạn bên cạnh,
# và web có thể tìm lại vị trí từng đoạn nhờ khoảng lặng này. Bộ mã hóa mp3 thêm độ trễ ở đầu,
# dùng nguyên độ lệch trong json sẽ dịch cả bảng, với tick 37ms là sai hết.
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
        sys.exit("Không tìm thấy ffmpeg. Hãy chạy: pip install imageio-ffmpeg")
    return exe


FFMPEG = None


def run_ffmpeg(args):
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y"] + args
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        sys.exit("ffmpeg thất bại:\n" + " ".join(cmd) + "\n" + p.stderr)


def to_mono_wav(src, dst):
    """Chuyển mọi nguồn (mp4 / mp3 / wav …) thành wav mono; mọi bước sau đều dùng file này."""
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    run_ffmpeg(["-i", src, "-vn", "-ac", "1", "-ar", str(SR),
                "-c:a", "pcm_s16le", dst])
    return dst


def read_wav(path):
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            sys.exit("Chỉ hỗ trợ wav 16-bit: " + path)
        data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
        return data.astype(np.float32) / 32768.0, w.getframerate()


# ── Định dạng thời gian ─────────────────────────────────────────────

def fmt_time(sec):
    m, s = divmod(float(sec), 60)
    return "%02d:%06.3f" % (int(m), s)


def parse_time(text):
    """Nhận cả hai dạng mm:ss.mmm và ss.mmm."""
    text = text.strip()
    if ":" in text:
        m, s = text.rsplit(":", 1)
        return float(m) * 60 + float(s)
    return float(text)


# ── 1. analyze ──────────────────────────────────────────────────────

def envelope(samples, hop):
    """Nén dạng sóng thành RMS mỗi hop mẫu một giá trị; phát hiện và vẽ hình đều dùng nó."""
    n = len(samples) // hop
    trimmed = samples[:n * hop].reshape(n, hop)
    return np.sqrt((trimmed ** 2).mean(axis=1) + 1e-12)


def find_segments(samples, sr, thresh_db, min_sound, min_silence):
    """Tìm các đoạn "có tiếng" theo ngưỡng RMS.

    Tự tính chứ không phân tích output của ffmpeg silencedetect, vì bao năng lượng này
    vốn cũng dùng để vẽ dạng sóng, và tự điều khiển ngưỡng và độ dài tối thiểu trực quan hơn.
    """
    hop = max(1, int(sr * 0.005))          # 5ms một khung
    env = envelope(samples, hop)
    env_db = 20 * np.log10(env + 1e-12)

    loud = env_db > thresh_db
    # Chỗ trũng ngắn không tính là ngắt đoạn (tiếng bíp liên tục của đèn chạy có chỗ lõm nhỏ ở giữa)
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
    """Vẽ dạng sóng có đánh số, để đối chiếu với video xem đoạn nào là gì.

    Mỗi hàng chia ba phần: phía trên là số đoạn, giữa là sóng, phía dưới là mốc thời gian.
    Tách riêng vì các đoạn dày đặc như đèn chạy sẽ làm số chồng lên sóng và nhòe cả hàng.
    Số còn xen kẽ hai tầng lên xuống để các đoạn hẹp liền nhau không che nhau.
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

        # Đường bao dạng sóng
        for x in range(width):
            ta = t0 + (t1 - t0) * x / width
            tb = t0 + (t1 - t0) * (x + 1) / width
            ia, ib = int(ta * sr / hop), max(int(tb * sr / hop), int(ta * sr / hop) + 1)
            chunk = env[ia:ib]
            if not len(chunk):
                continue
            h = int(min(chunk.max() * 3.2, 1.0) * (wave_h // 2 - 4))
            d.line([(x, base - h), (x, base + h)], fill=(120, 210, 255))

        # Mốc thời gian: mỗi hàng luôn chia 10 khoảng, dù ghi âm dài hay ngắn đều dễ nhìn
        step = (t1 - t0) / 10 or 1
        for k in range(11):
            t = t0 + k * step
            x = min(x_of(t, t0, t1), width - 1)
            d.line([(x, wave_top), (x, wave_top + wave_h)], fill=(60, 56, 68))
            d.text((min(x + 3, width - 52), wave_top + wave_h + 3),
                   fmt_time(t), fill=(140, 134, 150))

        # Khung đoạn + số thứ tự (số xen kẽ hai tầng để tránh các đoạn hẹp liền nhau bị chồng chữ)
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
        sys.exit("Không phát hiện âm thanh nào, thử giảm --threshold (ví dụ -50)")

    tsv = os.path.join(WORK_DIR, "segments.tsv")
    with open(tsv, "w", encoding="utf-8") as f:
        f.write("# Đổi cột name thành tên chính thức, xóa các dòng không cần, rồi chạy cut\n")
        f.write("# Gợi ý tên: coin bet tick land win_small win_big win_bar lose\n"
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

    print("Tổng độ dài %s, phát hiện %d đoạn" % (fmt_time(len(samples) / sr), len(segs)))
    print("  Danh sách đoạn :", tsv)
    print("  Dạng sóng      :", png)
    print("  File nghe thử :", prev_dir)
    print("\nBước tiếp theo: sửa segments.tsv để điền tên, rồi chạy")
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
                sys.exit("Dòng %d không đọc được (cần: tên bắt_đầu kết_thúc): %s" % (lineno, line))
            name, start, end = parts[0], parse_time(parts[1]), parse_time(parts[2])
            if end <= start:
                sys.exit("Dòng %d: thời gian kết thúc phải sau thời gian bắt đầu: %s" % (lineno, line))
            # Cột thứ tư (không bắt buộc) là thời gian fade-out tính bằng mili giây. Đoạn dài cắt giữa giai điệu cần fade-out dài hơn,
            # nếu không phần kết sẽ bị cụt đột ngột; hiệu ứng ngắn thì dùng mặc định 3ms.
            fade = float(parts[3]) if len(parts) > 3 else None
            cues.append((name, start, end, fade))
    if not cues:
        sys.exit("Cue sheet không có dòng hợp lệ nào: " + path)
    return cues


def cmd_cut(args):
    cues = read_cues(args.cues)
    # Bỏ qua các đoạn ứng viên chưa đặt tên, tránh tên kiểu seg_001 lọt vào sản phẩm cuối
    named = [c for c in cues if not re.fullmatch(r"seg_\d+", c[0])]
    if not named:
        sys.exit("Mọi tên trong segments.tsv vẫn là seg_xxx — hãy đổi thành tên chính thức trước khi chạy cut")

    os.makedirs(CLIP_DIR, exist_ok=True)
    mono = to_mono_wav(args.source, os.path.join(WORK_DIR, "source.wav"))

    for name, start, end, fade in named:
        # ffmpeg chỉ làm phần tần số: lọc tiếng rù thấp, khử nhiễu (tùy chọn).
        #
        # Cắt khoảng lặng đầu/cuối, fade-in/fade-out và chuẩn hóa đều làm trong numpy, vì hai lý do:
        #   1. Cách viết thường gặp silenceremove + areverse + silenceremove sẽ cắt mất cả đoạn
        #      (thử nghiệm: giai điệu dài 0.48s thành 0.000s), chuỗi bộ lọc không dự đoán được.
        #   2. Chuẩn hóa động như dynaudnorm sẽ đẩy phần đuôi đang tắt dần lên và làm đổi âm sắc;
        #      mục tiêu ở đây là giữ âm sắc máy thật, nên chỉ dùng chuẩn hóa đỉnh với hệ số cố định.
        chain = ["highpass=f=60"]
        if args.denoise:
            chain.append("afftdn=nf=-28")

        dst = os.path.join(CLIP_DIR, name + ".wav")
        run_ffmpeg(["-i", mono, "-ss", "%.3f" % start, "-to", "%.3f" % end,
                    "-af", ",".join(chain), "-ar", str(SR), "-ac", "1", dst])
        polish_clip(dst, args.trim_threshold, args.peak_db, fade_out_ms=fade)
        print("  %-14s %6.3fs  %s" % (name, wav_duration(dst), dst))

    print("\nĐã cắt %d đoạn → %s" % (len(named), CLIP_DIR))
    print("Bước tiếp theo: python3 tools/slice_audio.py sprite")


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
    """Cắt khoảng lặng ở đầu và cuối, chừa một chút đệm để không cắt mất phần bắt đầu của âm.

    Chỉ xét đầu và cuối; khoảng trống ở giữa luôn được giữ lại, vì cấu trúc
    "tiếng – dừng – tiếng" của giai điệu trúng thưởng không được tách thành hai đoạn.
    """
    thr = 10 ** (threshold_db / 20.0)
    loud = np.flatnonzero(np.abs(samples) > thr)
    if not len(loud):
        return samples[:0]
    pad = int(sr * pad_ms / 1000)
    return samples[max(0, loud[0] - pad):min(len(samples), loud[-1] + 1 + pad)]


def polish_clip(path, trim_db, peak_db, fade_ms=3.0, fade_out_ms=None):
    """Bỏ khoảng lặng đầu/cuối → fade-in/fade-out → chuẩn hóa đỉnh.

    Fade-out là bắt buộc: nếu điểm cắt rơi vào chỗ sóng khác 0 thì lúc kết thúc sẽ có tiếng "tách".
    Đoạn dài cắt giữa giai điệu có thể chỉ định fade-out dài hơn ở cột thứ tư của cue sheet.
    Chuẩn hóa dùng hệ số cố định (không động), nên độ mạnh nhẹ bên trong đoạn không đổi.
    """
    samples, sr = read_wav(path)
    samples = trim_silence(samples, sr, trim_db)
    if not len(samples):
        print("  ! %s toàn bộ là khoảng lặng ở ngưỡng %d dB, hãy giảm --trim-threshold"
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
        sys.exit("Không tìm thấy %s, hãy chạy cut trước" % CLIP_DIR)
    clips = sorted(f for f in os.listdir(CLIP_DIR) if f.endswith(".wav"))
    if args.only:
        want = [n.strip() for n in args.only.split(",") if n.strip()]
        missing = [n for n in want if n + ".wav" not in clips]
        if missing:
            sys.exit("Không tìm thấy các đoạn sau: " + ", ".join(missing))
        clips = [n + ".wav" for n in want]
    if not clips:
        sys.exit("Không có file wav nào trong %s" % CLIP_DIR)

    os.makedirs(OUT_DIR, exist_ok=True)
    gap = np.zeros(int(SR * SPRITE_GAP), dtype=np.float32)

    parts, index, cursor = [], {}, 0.0
    for f in clips:
        samples, sr = read_wav(os.path.join(CLIP_DIR, f))
        if sr != SR:
            sys.exit("%s có tần số lấy mẫu %d, cần %d — hãy chạy lại cut" % (f, sr, SR))
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

    print("Đã đóng gói %d đoạn, tổng độ dài %.2fs" % (len(index), cursor))
    for p in (mp3, ogg, meta):
        print("  %-28s %6.1f KB" % (os.path.relpath(p, ROOT), os.path.getsize(p) / 1024))


# ── CLI ─────────────────────────────────────────────────────────────

def main():
    global FFMPEG
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("analyze", help="Tự động tìm đoạn âm thanh, tạo danh sách và dạng sóng")
    a.add_argument("source", help="File nguồn (mp4 / mp3 / wav …)")
    a.add_argument("--threshold", type=float, default=-42.0,
                   help="Ngưỡng dBFS để coi là có tiếng; nhiễu nền lớn thì tăng lên (mặc định -42)")
    a.add_argument("--min-sound", type=float, default=0.03,
                   help="Độ dài tối thiểu của đoạn (giây), đoạn ngắn hơn sẽ bị coi là nhiễu (mặc định 0.03)")
    a.add_argument("--min-silence", type=float, default=0.08,
                   help="Khoảng lặng bao lâu thì tách đoạn (giây); tiếng bíp liên tục của đèn chạy thì giảm xuống (mặc định 0.08)")
    a.set_defaults(func=cmd_analyze)

    c = sub.add_parser("cut", help="Cắt đoạn theo cue sheet")
    c.add_argument("source", help="File nguồn (dùng cùng file với analyze)")
    c.add_argument("--cues", default=os.path.join(WORK_DIR, "segments.tsv"))
    c.add_argument("--denoise", action="store_true",
                   help="Bật khử nhiễu (nếu nhiễu nền lớn; bật lên sẽ làm âm sắc bị kim loại)")
    c.add_argument("--trim-threshold", type=int, default=-45,
                   help="Ngưỡng dB để xác định khoảng lặng đầu/cuối; nhiễu nền lớn thì tăng lên (mặc định -45)")
    c.add_argument("--peak-db", type=float, default=-1.0,
                   help="Mức đỉnh dBFS đích khi chuẩn hóa (mặc định -1)")
    c.set_defaults(func=cmd_cut)

    s = sub.add_parser("sprite", help="Đóng gói các đoạn thành một file + bảng độ lệch")
    s.add_argument("--bitrate", default="64k")
    s.add_argument("--only", default="",
                   help="Chỉ đóng gói các đoạn được chỉ định (phân cách bằng dấu phẩy), theo đúng thứ tự đã cho")
    s.set_defaults(func=cmd_sprite)

    args = ap.parse_args()
    FFMPEG = ffmpeg_exe()
    args.func(args)


if __name__ == "__main__":
    main()
