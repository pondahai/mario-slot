#!/usr/bin/env python3
"""Cắt ảnh máy gốc, tách bốn chi tiết thành các PNG riêng.

Ảnh gốc (34d80fa1-....jpg) là một "ảnh sắp xếp chi tiết": bảng máy, khe xu,
bảng tỷ lệ và bàn phím nút bấm nằm rải rác trên nền giấy trắng. Trò chơi cần
đưa bàn phím xuống ngay dưới bảng và thẳng hàng với vòng quay, nên phải cắt
các chi tiết ra trước.

Chạy:   python3 tools/slice_assets.py
Đầu ra: assets/board.png / coin.png / sign.png / panel.png

Bốn bounding box được đo từ profile chênh lệch màu nền (nền giấy ~#eeeeec)
theo hàng/cột, giá trị cố định trong code nên chạy lại sẽ ra kết quả giống hệt.
"""

import os
import random
from collections import deque

from PIL import Image, ImageDraw

SRC = "34d80fa1-c09c-4050-9b85-a48dfa8796fb.jpg"
OUT_DIR = "assets"

# (left, top, right, bottom) — theo pixel của ảnh gốc 1024x909
PIECES = {
    "board": (199, 72, 665, 621),   # Bảng chính: vòng quay đèn chạy + màn LED 7 đoạn
    "coin": (707, 82, 819, 297),    # Khe đút xu
    "sign": (689, 337, 833, 564),   # Bảng tỷ lệ thưởng
    "panel": (460, 656, 840, 843),  # Bàn phím nút bấm
}

# Màu nền giấy và ngưỡng sai số để nhận diện "ô này là nền"
BG = (238, 238, 236)
TOL = 26

# Trên ảnh gốc, màn LED 7 đoạn in sẵn các số cố định (40 / 92 / 0 / 2). Trò chơi tự vẽ số,
# nên các cửa sổ này được tô thành màu đỏ sẫm của LED đã tắt, tránh chữ gốc lọt qua khe nét.
# Tọa độ tính theo pixel trong chi tiết board; giá trị khớp 1-1 với tỷ lệ phần trăm trong styles.css.
LED_DARK = (74, 14, 13)
_METER_X0, _METER_PITCH = 51, 46.75

LED_WINDOWS = [
    (122, 51, 206, 90),    # Điểm (bốn chữ số bên trái trên)
    (259, 51, 344, 90),    # Điểm thắng (bốn chữ số bên phải trên)
    (208, 300, 261, 340),  # Hai chữ số giữa (số gấp đôi / số lần đặc biệt)
] + [
    # 8 bộ đếm cược bên dưới bảng
    (int(_METER_X0 + i * _METER_PITCH), 479,
     int(_METER_X0 + i * _METER_PITCH) + 41, 513)
    for i in range(8)
]


def cut_background(img):
    """Flood fill từ bốn cạnh, xóa màu nền giấy thành trong suốt.

    Chỉ lan từ biên vào trong, nên màu sáng bên trong chi tiết (ví dụ gạch
    men trắng ngà của bàn phím) không bị xóa nhầm, còn vùng giấy quanh góc bo
    tròn sẽ trong suốt sạch sẽ.
    """
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()

    def is_bg(x, y):
        r, g, b, _ = px[x, y]
        return abs(r - BG[0]) + abs(g - BG[1]) + abs(b - BG[2]) < TOL

    seen = [[False] * h for _ in range(w)]
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if not seen[x][y] and is_bg(x, y):
                seen[x][y] = True
                q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if not seen[x][y] and is_bg(x, y):
                seen[x][y] = True
                q.append((x, y))

    while q:
        x, y = q.popleft()
        px[x, y] = (0, 0, 0, 0)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not seen[nx][ny] and is_bg(nx, ny):
                seen[nx][ny] = True
                q.append((nx, ny))

    return img


def blank_led_windows(img):
    """Tô các cửa sổ LED 7 đoạn thành màu LED tắt, thêm chút nhiễu để không giống mảng màu dán lên."""
    d = ImageDraw.Draw(img)
    rng = random.Random(20240803)
    for box in LED_WINDOWS:
        d.rectangle(box, fill=LED_DARK + (255,))
        x0, y0, x1, y1 = box
        for _ in range((x1 - x0) * (y1 - y0) // 7):
            x = rng.randrange(x0, x1)
            y = rng.randrange(y0, y1)
            n = rng.randint(-7, 7)
            img.putpixel((x, y), (LED_DARK[0] + n, LED_DARK[1] + n // 2,
                                  LED_DARK[2] + n // 2, 255))
    return img


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src = Image.open(os.path.join(root, SRC))
    out_dir = os.path.join(root, OUT_DIR)
    os.makedirs(out_dir, exist_ok=True)

    for name, box in PIECES.items():
        piece = cut_background(src.crop(box))
        if name == "board":
            piece = blank_led_windows(piece)
        path = os.path.join(out_dir, name + ".png")
        piece.save(path)
        print("%-6s %-18s %s" % (name, "%dx%d" % piece.size, path))


if __name__ == "__main__":
    main()
