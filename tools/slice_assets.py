#!/usr/bin/env python3
"""切割原始機台圖，把四個零件拆成獨立的 PNG。

原圖 (34d80fa1-....jpg) 是一張「零件排版圖」：機台面板、投幣器、賠率牌、
按鍵盤各自散落在白紙上。遊戲需要把按鍵盤搬到面板正下方、與輪盤對齊，
所以必須先把零件切開。

執行： python3 tools/slice_assets.py
輸出： assets/board.png / coin.png / sign.png / panel.png

四個 bounding box 是用背景色差 (紙張底色 ~#eeeeec) 的 row/column profile
量出來的，數值寫死在這裡，重跑會得到完全一樣的結果。
"""

import os
import random
from collections import deque

from PIL import Image, ImageDraw

SRC = "34d80fa1-c09c-4050-9b85-a48dfa8796fb.jpg"
OUT_DIR = "assets"

# (left, top, right, bottom) — 以原圖 1024x909 的像素為單位
PIECES = {
    "board": (199, 72, 665, 621),   # 主面板：跑燈輪盤 + 七段顯示器
    "coin": (707, 82, 819, 297),    # 投幣器
    "sign": (689, 337, 833, 564),   # 賠率牌
    "panel": (460, 656, 840, 843),  # 按鍵盤
}

# 紙張底色，以及判定「這格是背景」的容差
BG = (238, 238, 236)
TOL = 26

# 原圖上的七段顯示器印著固定的數字（40 / 92 / 0 / 2）。遊戲要自己畫數字，
# 所以先把這些視窗塗成 LED 熄滅時的暗紅底，免得原本的字從筆劃縫隙透出來。
# 座標同樣是 board 零件內的像素，數值與 styles.css 裡的百分比一一對應。
LED_DARK = (74, 14, 13)
_METER_X0, _METER_PITCH = 51, 46.75

LED_WINDOWS = [
    (122, 51, 206, 90),    # 分數（左上四位）
    (259, 51, 344, 90),    # 得分（右上四位）
    (208, 300, 261, 340),  # 中央兩位（比倍號碼 / 特別次數）
] + [
    # 盤面下方 8 個押注計數器
    (int(_METER_X0 + i * _METER_PITCH), 479,
     int(_METER_X0 + i * _METER_PITCH) + 41, 513)
    for i in range(8)
]


def cut_background(img):
    """從四邊 flood fill，把外圍紙張底色挖成透明。

    只從邊界往內擴散，所以零件內部的淺色（例如面板的米白磁磚）不會被誤殺，
    圓角外那一圈紙張則會乾淨地變透明。
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
    """把七段顯示器視窗塗成熄滅底色，加一點雜訊避免看起來像貼上去的色塊。"""
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
