/* ─────────────────────────────────────────────────────────────
   Tiểu Mary (Mary nhỏ / khay trái cây) — mô phỏng máy

   Cách chơi giống máy thật: bỏ xu để có điểm → đặt cược bằng tám nút hình →
   bấm Quay để đèn chạy → đèn dừng ở hình đã cược thì nhận thưởng theo tỷ lệ.
   Điểm thắng có thể "Gấp đôi" bằng cách đoán lớn/nhỏ, hoặc bấm "Rút điểm"
   để chuyển điểm thắng về điểm. Cược tối đa 99 điểm cho mỗi hình.
   (Tài liệu tham khảo xem README.md)

   24 ô của bảng, bảy đoạn LED và vị trí các nút đều là tọa độ pixel đo từ
   ảnh gốc, đổi sang phần trăm rồi ghi ở đây; quy trình cắt ảnh xem
   tools/slice_assets.py.
   ───────────────────────────────────────────────────────────── */

'use strict';

/* ── Cấu hình máy ──────────────────────────────────────── */

const CONFIG = {
    coinValue: 10,        // Khe xu ghi "10 đồng", mỗi xu = 10 điểm
    exchangeRate: 5,      // Bảng tỷ lệ ghi "5 đổi 1": khi trả xu, 5 điểm đổi 1 xu
    maxBetPerSymbol: 99,  // Máy thật giới hạn 99 điểm cho mỗi hình
    maxCredit: 9999,      // Màn LED 7 đoạn bốn chữ số
    maxScore: 9999,
    maxDoubleUps: 10,     // Số lần gấp đôi liên tiếp tối đa
    bonusMultiplier: 10,  // Ô jackpot: tổng tiền cược × 10
    targetRTP: 0.90,      // Tỷ lệ hoàn trả đặt cho máy; kết quả đèn sẽ hội tụ về giá trị này
    steer: 0.03,          // Tốc độ tích lũy của bộ điều khiển ăn/nhả điểm: lớn thì chỉnh nhanh hơn, dao động ít hơn
};

/* ── Âm thanh ──────────────────────────────────────────────

   Nguồn âm là bản ghi âm máy thật, được tools/slice_audio.py cắt và
   nối thành một sprite (assets/audio/sprite.ogg / .mp3 + sprite.json).

   Dùng Web Audio thay vì phần tử <audio>: đèn chạy nhanh nhất 34ms
   phát một tiếng, độ trễ và phát lặp của <audio> không theo kịp.

   Về độ lệch: sprite.json có điểm bắt đầu của từng đoạn, nhưng **không dùng
   trực tiếp**. Khi giải mã mp3, trình duyệt thêm độ trễ của bộ mã hóa
   (khoảng 1100 mẫu) và cả bảng độ lệch bị dịch theo, với tick 37ms là sai
   hết. Vì vậy sau khi tải, code tìm lại khoảng im lặng 0.1 giây giữa các
   đoạn trong dữ liệu đã giải mã để tính biên; json chỉ dùng cho thứ tự tên và
   phương án dự phòng.                                                     */

const Sound = {
    ctx: null,
    buffer: null,
    clips: {},          // tên → [giây bắt đầu, độ dài (giây)]
    ready: false,
    enabled: true,
    volume: 0.7,
    _master: null,
    _live: {},          // tên → nguồn đang phát; dùng để tự ngắt âm thanh dài

    /** Chỉ tạo AudioContext khi người dùng tương tác lần đầu — trình duyệt sẽ chặn các lần thử trước đó. */
    unlock() {
        if (!this.ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            this.ctx = new AC();
            this._master = this.ctx.createGain();
            this._master.connect(this.ctx.destination);
            this._applyVolume();
            this.load();
        }
        if (this.ctx.state === 'suspended') this.ctx.resume();
    },

    async load() {
        try {
            const meta = await (await fetch('assets/audio/sprite.json')).json();
            const probe = document.createElement('audio');
            const ext = probe.canPlayType('audio/ogg; codecs=vorbis') ? 'ogg' : 'mp3';
            const raw = await (await fetch('assets/audio/sprite.' + ext)).arrayBuffer();
            this.buffer = await this.ctx.decodeAudioData(raw);
            this.clips = this._mapClips(meta);
            this.ready = true;
        } catch (err) {
            console.warn('Tải âm thanh thất bại, trò chơi vẫn chạy bình thường:', err);
        }
    },

    /**
     * Tìm biên của các đoạn từ dạng sóng đã giải mã.
     *
     * Giữa các đoạn có 0.1 giây im lặng kỹ thuật số; tìm những khoảng im lặng
     * này là dựng lại được vị trí từng đoạn, không bị ảnh hưởng bởi độ trễ
     * của bộ mã hóa. Nếu số đoạn không khớp thì quay về độ lệch trong json.
     */
    _mapClips(meta) {
        const names = Object.keys(meta.clips).sort(
            (a, b) => meta.clips[a][0] - meta.clips[b][0]);
        const data = this.buffer.getChannelData(0);
        const sr = this.buffer.sampleRate;
        const win = Math.max(1, Math.round(sr * 0.005));
        const quiet = 0.004;                       // khoảng −48 dBFS
        const minGap = Math.round(0.05 / 0.005);   // khoảng cách tối thiểu 50ms mới tính là ngắt

        const regions = [];
        let start = -1, run = 0;
        for (let i = 0; i + win <= data.length; i += win) {
            let peak = 0;
            for (let j = i; j < i + win; j++) {
                const v = Math.abs(data[j]);
                if (v > peak) peak = v;
            }
            if (peak > quiet) {
                if (start < 0) start = i;
                run = 0;
            } else if (start >= 0 && ++run >= minGap) {
                regions.push([start / sr, (i - run * win) / sr]);
                start = -1;
                run = 0;
            }
        }
        if (start >= 0) regions.push([start / sr, data.length / sr]);

        const out = {};
        if (regions.length === names.length) {
            names.forEach((n, i) => {
                out[n] = [regions[i][0], regions[i][1] - regions[i][0]];
            });
        } else {
            console.warn('Phát hiện %d đoạn âm thanh, dự kiến %d đoạn; dùng độ lệch từ json',
                         regions.length, names.length);
            names.forEach(n => { out[n] = meta.clips[n].slice(); });
        }
        return out;
    },

    /** Phát một đoạn. rate để chỉnh cao độ nhẹ; solo sẽ ngắt lần phát trước cùng tên. */
    play(name, opts = {}) {
        if (!this.ready || !this.enabled) return;
        const clip = this.clips[name];
        if (!clip) return;
        if (this.ctx.state === 'suspended') this.ctx.resume();

        if (opts.solo && this._live[name]) {
            try { this._live[name].stop(); } catch (e) { /* đã dừng rồi */ }
        }

        const src = this.ctx.createBufferSource();
        src.buffer = this.buffer;
        src.playbackRate.value = opts.rate || 1;
        const gain = this.ctx.createGain();
        gain.gain.value = opts.gain == null ? 1 : opts.gain;
        src.connect(gain).connect(this._master);
        src.start(0, clip[0], clip[1]);
        if (opts.solo) {
            this._live[name] = src;
            src.onended = () => { if (this._live[name] === src) this._live[name] = null; };
        }
    },

    /** Dừng một âm thanh dài đang phát (chỉ có tác dụng với âm phát bằng solo). */
    stop(name) {
        const src = this._live[name];
        if (!src) return;
        try { src.stop(); } catch (e) { /* đã phát xong */ }
        this._live[name] = null;
    },

    setEnabled(on) {
        this.enabled = on;
        if (on) this.unlock();
        else Object.keys(this._live).forEach(n => this.stop(n));
        localStorage.setItem('marioSlotSound', on ? '1' : '0');
    },

    setVolume(v) {
        this.volume = v;
        this._applyVolume();
        localStorage.setItem('marioSlotVolume', String(v));
    },

    _applyVolume() {
        if (this._master) this._master.gain.value = this.volume;
    },
};

// Bốn tiếng tick phát luân phiên khi đèn chạy. Máy thật có đèn chạy theo một dãy nốt, lặp một tiếng sẽ rất đơn điệu.
const TICKS = ['tick1', 'tick2', 'tick3', 'tick4'];

/* ── Tám hình có thể cược và tỷ lệ thưởng ──────────────── */

const SYMBOLS = {
    bar:        { name: 'BAR',       odds: 100 },
    seven:      { name: '77',        odds: 40 },
    star:       { name: 'Sao đôi',   odds: 30 },
    olive:      { name: 'Ô liu',     odds: 25 },
    bell:       { name: 'Chuông',    odds: 20 },
    watermelon: { name: 'Dưa hấu',   odds: 15 },
    orange:     { name: 'Cam',       odds: 10 },
    apple:      { name: 'Táo',       odds: 5 },
};

// Thứ tự từ trái sang phải của nút cược và bộ đếm trên bảng (hai bên khớp nhau)
const BET_ORDER = ['bar', 'seven', 'star', 'olive', 'bell', 'watermelon', 'orange', 'apple'];

/* ── 24 ô của bảng (index 0 = góc trên bên trái, theo chiều kim đồng hồ) ──────────────
   Đối chiếu ảnh gốc: đặc biệt = đầu tướng / con dấu, jackpot = hoa văn vàng.        */

const BOARD = [
    'orange', 'bell', 'special', 'bar', 'special', 'apple', 'watermelon',  //  0–6  hàng trên
    'olive', 'olive', 'bonus', 'apple', 'orange',                          //  7–11 cột phải
    'orange', 'bell', 'seven', 'bar', 'seven', 'watermelon', 'watermelon', // 12–18 hàng dưới
    'star', 'star', 'bonus', 'apple', 'bell',                              // 19–23 cột trái
];

/* ── Hình học bố cục (toàn bộ là pixel đo được, đổi sang phần trăm) ─────── */

const BOARD_PX = { w: 466, h: 549 };
const RING = { x0: 67, y0: 88, cw: 48.0, ch: 48.143 };   // vòng ngoài 7×7
const METER = { x0: 52, pitch: 46.75 };   // kích thước và y do .bet-meter trong styles.css quyết định

// Vị trí (cột,hàng) của 24 ô trên lưới 7×7, theo chiều kim đồng hồ
const RING_CELLS = (() => {
    const out = [];
    for (let c = 0; c < 7; c++) out.push([c, 0]);
    for (let r = 1; r < 6; r++) out.push([6, r]);
    for (let c = 6; c >= 0; c--) out.push([c, 6]);
    for (let r = 5; r >= 1; r--) out.push([0, r]);
    return out;
})();

const PANEL_PX = { w: 380, h: 187 };

// Sáu nút điều khiển hàng trên, từ trái sang phải (vàng / cam cam / đỏ đỏ / xanh)
const CONTROL_KEYS = [
    { id: 'wash',   label: 'Rút',       rect: [55, 28, 27, 42],  hint: 'Chuyển điểm thắng vào điểm; nếu điểm thắng là 0 thì trả xu' },
    { id: 'betall', label: 'Tất cả',    rect: [114, 29, 29, 41], hint: 'Cược 1 điểm cho cả tám hình' },
    { id: 'small',  label: 'Nhỏ',       rect: [147, 29, 30, 41], hint: 'Gấp đôi: đoán Nhỏ (1–7)' },
    { id: 'big',    label: 'Lớn',       rect: [207, 30, 28, 41], hint: 'Gấp đôi: đoán Lớn (8–14)' },
    { id: 'double', label: 'Gấp đôi',   rect: [238, 30, 28, 41], hint: 'Thử gấp đôi điểm thắng' },
    { id: 'start',  label: 'Quay',      rect: [295, 29, 28, 41], hint: 'Bắt đầu chạy đèn' },
];

// Tám nút cược hàng dưới + ô hiển thị hình phía trên (dùng để đánh dấu hình trúng)
const BET_KEY_X = [50, 83, 116, 147, 203, 236, 267, 299];
const BET_KEY = { y: 112, h: 37, w: 29 };
const BET_ICON = { y: 78, h: 33 };

/* ── Màn LED 7 đoạn ────────────────────────────────────── */

const SEG_MAP = {
    0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg',
    5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
};

const SEG_SHAPE = (() => {
    const t = 18, xL = 14, xR = 86, yT = 14, yM = 90, yB = 166;
    const hLen = xR - xL, vLen = yM - yT;
    const h = (x, y) => `${x},${y} ${x + t / 2},${y - t / 2} ${x + hLen - t / 2},${y - t / 2} ` +
                        `${x + hLen},${y} ${x + hLen - t / 2},${y + t / 2} ${x + t / 2},${y + t / 2}`;
    const v = (x, y) => `${x},${y} ${x + t / 2},${y + t / 2} ${x + t / 2},${y + vLen - t / 2} ` +
                        `${x},${y + vLen} ${x - t / 2},${y + vLen - t / 2} ${x - t / 2},${y + t / 2}`;
    return { a: h(xL, yT), d: h(xL, yB), g: h(xL, yM), b: v(xR, yT), c: v(xR, yM), e: v(xL, yM), f: v(xL, yT) };
})();

function buildDigit() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '-6 0 112 184');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.classList.add('seg-digit');
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('transform', 'skewX(-5) translate(6,0)');
    for (const key of 'abcdefg') {
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        p.setAttribute('points', SEG_SHAPE[key]);
        p.setAttribute('class', 'seg-off');
        p.dataset.seg = key;
        g.appendChild(p);
    }
    svg.appendChild(g);
    return svg;
}

function fillDisplay(el, count) {
    el.innerHTML = '';
    for (let i = 0; i < count; i++) el.appendChild(buildDigit());
}

/** Ghi value vào màn hình; blank = true thì tắt sáng cả dãy (dùng để nhấp nháy số khi gấp đôi). */
function writeDisplay(el, value, opts = {}) {
    const digits = [...el.children];
    const text = opts.blank ? '' : String(Math.max(0, Math.round(value)));
    // Căn phải, phần bên trái đệm khoảng trắng (máy thật thì số 0 đứng đầu bị tắt)
    const padded = text.padStart(digits.length, ' ').slice(-digits.length);
    digits.forEach((svg, i) => {
        const ch = padded[i];
        const lit = ch === ' ' ? '' : (SEG_MAP[ch] || '');
        svg.querySelectorAll('polygon').forEach(p => {
            p.setAttribute('class', lit.includes(p.dataset.seg) ? 'seg-on' : 'seg-off');
        });
    });
}

/* ── Trạng thái trò chơi ───────────────────────────────── */

const state = {
    credit: 0,
    score: 0,
    bets: Object.fromEntries(BET_ORDER.map(k => [k, 0])),
    phase: 'idle',        // idle | spinning | won | double | reveal
    pos: 0,               // vị trí hiện tại của đèn chạy
    doubleCount: 0,
    pendingSpecial: 0,    // số lượt quay miễn phí tích lũy từ "đặc biệt"
    gamma: -1.5,          // trạng thái tích lũy của bộ điều khiển ăn/nhả điểm (xem pickCell)
    stakeRef: 8,          // trung bình trượt của quy mô cược, dùng để không thứ nguyên hóa sai số của bộ điều khiển
    totalIn: 0,           // tổng tiền đã cược
    totalOut: 0,          // tổng điểm đã trả ra
};

/* ── Lưu trạng thái ────────────────────────────────────────

   Đóng tab rồi mở lại, máy vẫn ở đúng trạng thái cũ: điểm, tiền cược, số lần
   "đặc biệt" còn lại, và cả trạng thái tích lũy (gamma) cùng thống kê của bộ
   điều khiển. Phải lưu luôn trạng thái bộ điều khiển: nếu chỉ lưu điểm thì
   tải lại trang đồng nghĩa xóa trí nhớ ăn/nhả điểm của máy, và người chơi có
   thể reset bộ điều khiển về 0 bằng cách tải lại.

   Trạng thái đang quay (spinning) và đang mở số gấp đôi (reveal) là trạng thái
   trung gian của hoạt ảnh nên không lưu; nếu tắt lúc đó thì khi mở lại sẽ quay
   về trạng thái ổn định trước đó (tiền cược còn, ván đó coi như chưa diễn ra). */

const SAVE_KEY = 'marioSlotSave';
const SAVE_VERSION = 1;

function saveState() {
    if (state.phase === 'spinning' || state.phase === 'reveal') return;
    try {
        localStorage.setItem(SAVE_KEY, JSON.stringify({
            v: SAVE_VERSION,
            credit: state.credit,
            score: state.score,
            bets: state.bets,
            // Tắt giữa lúc gấp đôi thì khi mở lại dừng ở trạng thái "có điểm thắng", để người chơi tự quyết định có đoán tiếp không
            phase: state.phase === 'double' ? 'won' : state.phase,
            pos: state.pos,
            doubleCount: state.doubleCount,
            pendingSpecial: state.pendingSpecial,
            gamma: state.gamma,
            stakeRef: state.stakeRef,
            totalIn: state.totalIn,
            totalOut: state.totalOut,
        }));
    } catch (e) {
        // Chế độ ẩn danh hoặc hết dung lượng: không lưu được thì thôi, vẫn chơi bình thường
    }
}

/** Đọc lại dữ liệu đã lưu và nạp vào state. Trả về có đọc được hay không. */
function loadState() {
    let saved;
    try {
        const raw = localStorage.getItem(SAVE_KEY);
        if (!raw) return false;
        saved = JSON.parse(raw);
    } catch (e) {
        return false;
    }
    if (!saved || saved.v !== SAVE_VERSION) return false;

    const num = (v, min, max, dflt) =>
        (typeof v === 'number' && isFinite(v)) ? Math.min(max, Math.max(min, v)) : dflt;

    state.credit = Math.round(num(saved.credit, 0, CONFIG.maxCredit, 0));
    state.score = Math.round(num(saved.score, 0, CONFIG.maxScore, 0));
    state.pos = Math.round(num(saved.pos, 0, 23, 0));
    state.doubleCount = Math.round(num(saved.doubleCount, 0, CONFIG.maxDoubleUps, 0));
    state.pendingSpecial = Math.round(num(saved.pendingSpecial, 0, 99, 0));
    state.gamma = num(saved.gamma, -50, 50, -1.5);
    state.stakeRef = num(saved.stakeRef, 1, 1e9, 8);
    state.totalIn = num(saved.totalIn, 0, 1e12, 0);
    state.totalOut = num(saved.totalOut, 0, 1e12, 0);

    const bets = saved.bets || {};
    BET_ORDER.forEach(s => {
        state.bets[s] = Math.round(num(bets[s], 0, CONFIG.maxBetPerSymbol, 0));
    });

    // Chỉ khi "có điểm thắng đang chờ xử lý" mới ở lại won, còn lại đều về idle để có thể đặt cược
    state.phase = (saved.phase === 'won' && state.score > 0) ? 'won' : 'idle';
    if (state.phase === 'idle') state.doubleCount = 0;   // số lần gấp đôi chỉ tính trong cùng một khoản điểm thắng

    return true;
}

const el = {};
const lamps = [];
const meters = [];
const keys = {};
const iconMarks = {};

/* ── Khởi tạo ──────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
    el.credit = document.getElementById('disp-credit');
    el.score = document.getElementById('disp-score');
    el.center = document.getElementById('disp-center');
    el.banner = document.getElementById('banner');

    fillDisplay(el.credit, 4);
    fillDisplay(el.score, 4);
    fillDisplay(el.center, 2);

    buildLamps();
    buildMeters();
    buildKeys();
    buildOddsTable();
    bindGlobal();

    document.getElementById('rtp-note').textContent =
        `Tỷ lệ hoàn trả đặt ${(CONFIG.targetRTP * 100).toFixed(0)}%. Kết quả đèn chạy do bộ điều khiển xác suất quyết định, ` +
        `bộ này dựa trên tổng cược và điểm đã trả để kéo tỷ lệ hoàn trả thực tế về giá trị đã đặt — máy thật cũng ăn điểm và nhả điểm như vậy.`;

    const resumed = loadState();
    if (!resumed) state.credit = 100;   // lần đầu mở máy tặng 100 điểm để khỏi chỉ nhìn khe xu

    // Đèn dừng ở vị trí lần trước, để thấy máy tiếp tục từ ván trước
    lamps[state.pos].classList.add('landed');
    if (resumed) {
        showBanner(state.score > 0
            ? `Tiếp tục ván trước　điểm ${state.credit}　điểm thắng ${state.score}`
            : `Tiếp tục ván trước　điểm ${state.credit}`);
    }

    render();
});

function buildLamps() {
    const layer = document.getElementById('lamp-layer');
    RING_CELLS.forEach(([c, r], i) => {
        const d = document.createElement('div');
        d.className = 'lamp';
        d.style.left = pct(RING.x0 + c * RING.cw, BOARD_PX.w);
        d.style.top = pct(RING.y0 + r * RING.ch, BOARD_PX.h);
        d.title = `${i}　${labelOf(BOARD[i])}`;
        layer.appendChild(d);
        lamps.push(d);
    });
}

function buildMeters() {
    const layer = document.getElementById('bet-meters');
    BET_ORDER.forEach((sym, i) => {
        const m = document.createElement('div');
        m.className = 'bet-meter';
        m.style.left = pct(METER.x0 + i * METER.pitch, BOARD_PX.w);
        fillDisplay(m, 2);
        layer.appendChild(m);
        meters.push(m);
    });
}

function buildKeys() {
    const layer = document.getElementById('key-layer');

    CONTROL_KEYS.forEach(spec => {
        const b = document.createElement('button');
        b.className = 'key key-control';
        b.type = 'button';
        b.textContent = spec.label;
        b.title = `${spec.label} — ${spec.hint}`;
        place(b, spec.rect[0], spec.rect[1], spec.rect[2], spec.rect[3]);
        b.addEventListener('click', () => onControl(spec.id));
        layer.appendChild(b);
        keys[spec.id] = b;
    });

    BET_ORDER.forEach((sym, i) => {
        const x = BET_KEY_X[i];

        const mark = document.createElement('div');
        mark.className = 'icon-mark';
        place(mark, x, BET_ICON.y, BET_KEY.w, BET_ICON.h);
        layer.appendChild(mark);
        iconMarks[sym] = mark;

        const b = document.createElement('button');
        b.className = 'key key-bet';
        b.type = 'button';
        b.title = `Cược ${SYMBOLS[sym].name} (${SYMBOLS[sym].odds} lần)　Phím tắt ${i + 1}`;
        b.innerHTML = '<span class="amt"></span>';
        place(b, x, BET_KEY.y, BET_KEY.w, BET_KEY.h);
        b.addEventListener('click', () => placeBet(sym));
        layer.appendChild(b);
        keys['bet_' + sym] = b;
    });
}

function place(node, x, y, w, h) {
    node.style.left = pct(x, PANEL_PX.w);
    node.style.top = pct(y, PANEL_PX.h);
    node.style.width = pct(w, PANEL_PX.w);
    node.style.height = pct(h, PANEL_PX.h);
}

const pct = (v, total) => (v / total * 100).toFixed(3) + '%';

function buildOddsTable() {
    const t = document.getElementById('odds-table');
    const counts = {};
    BOARD.forEach(s => { counts[s] = (counts[s] || 0) + 1; });
    const rows = BET_ORDER.map(s =>
        `<tr><td>${SYMBOLS[s].name}</td><td>${SYMBOLS[s].odds} lần</td><td>${counts[s]} ô</td></tr>`);
    rows.push(`<tr><td>Đặc biệt</td><td>Quay miễn phí</td><td>${counts.special} ô</td></tr>`);
    rows.push(`<tr><td>Jackpot</td><td>Tổng cược ×${CONFIG.bonusMultiplier}</td><td>${counts.bonus} ô</td></tr>`);
    t.innerHTML = rows.join('');
}

function bindGlobal() {
    // Trình duyệt yêu cầu có tương tác của người dùng mới được phát tiếng, nên chỉ tạo AudioContext ở lần bấm/phím đầu tiên
    const unlock = () => Sound.unlock();
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });

    const soundToggle = document.getElementById('sound-toggle');
    const volumeSlider = document.getElementById('volume-slider');
    Sound.enabled = localStorage.getItem('marioSlotSound') !== '0';
    Sound.volume = parseFloat(localStorage.getItem('marioSlotVolume') || '0.7');
    soundToggle.checked = Sound.enabled;
    volumeSlider.value = Sound.volume;
    soundToggle.addEventListener('change', e => Sound.setEnabled(e.target.checked));
    volumeSlider.addEventListener('input', e => Sound.setVolume(parseFloat(e.target.value)));

    document.getElementById('coin-slot').addEventListener('click', insertCoin);

    document.getElementById('debug-toggle').addEventListener('change', e => {
        document.body.classList.toggle('debug', e.target.checked);
    });

    const SHORTCUTS = {
        ' ': () => onControl('start'), q: () => onControl('wash'), w: () => onControl('betall'),
        a: () => onControl('small'), s: () => onControl('big'), d: () => onControl('double'),
        c: insertCoin,
    };

    document.addEventListener('keydown', e => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.target.matches('input, textarea')) return;
        const k = e.key.toLowerCase();
        if (k >= '1' && k <= '8') { e.preventDefault(); placeBet(BET_ORDER[+k - 1]); return; }
        const fn = SHORTCUTS[k];
        if (fn) { e.preventDefault(); fn(); }
    });
}

/* ── Thao tác của người chơi ───────────────────────────── */

function insertCoin() {
    if (state.phase === 'spinning' || state.phase === 'reveal') return;
    if (state.credit + CONFIG.coinValue > CONFIG.maxCredit) return flash('Điểm đã đầy');
    state.credit += CONFIG.coinValue;
    Sound.play('coin', { solo: true });
    render();
}

function placeBet(sym) {
    if (state.phase !== 'idle') return;
    if (state.bets[sym] >= CONFIG.maxBetPerSymbol) return flash(`${SYMBOLS[sym].name} đã đạt giới hạn ${CONFIG.maxBetPerSymbol}`);
    if (state.credit < 1) return flash('Không đủ điểm, hãy bỏ xu');
    state.credit -= 1;
    state.bets[sym] += 1;
    Sound.play('bet');
    render();
}

function betAll() {
    if (state.phase !== 'idle') return;
    const room = BET_ORDER.filter(s => state.bets[s] < CONFIG.maxBetPerSymbol);
    if (!room.length) return flash('Cược đã đạt giới hạn');
    if (state.credit < room.length) return flash('Không đủ điểm, hãy bỏ xu');
    state.credit -= room.length;
    room.forEach(s => { state.bets[s] += 1; });
    Sound.play('bet');
    render();
}

function onControl(id) {
    switch (id) {
        case 'start':  return startSpin();
        case 'betall': return betAll();
        case 'wash':   return wash();
        case 'double': return enterDouble();
        case 'big':    return guess('big');
        case 'small':  return guess('small');
    }
}

/** Rút điểm: có điểm thắng thì chuyển vào điểm; không có thì trả xu. */
function wash() {
    if (state.phase === 'spinning' || state.phase === 'reveal') return;

    if (state.score > 0) {
        clearWinFx();
        Sound.stop('win');
        state.credit = Math.min(CONFIG.maxCredit, state.credit + state.score);
        flash(`Rút ${state.score} điểm`);
        state.score = 0;
        state.doubleCount = 0;
        state.phase = 'idle';
        render();
        return;
    }

    if (state.phase !== 'idle') return;
    if (state.credit <= 0) return flash('Không có điểm để trả');

    const coins = Math.floor(state.credit / CONFIG.exchangeRate);
    const left = state.credit % CONFIG.exchangeRate;
    if (!confirm(`Trả xu: ${state.credit} điểm → ${coins} xu (${CONFIG.exchangeRate} điểm = 1 xu)` +
                 (left ? `, dư ${left} điểm không chia hết, sẽ trả hết luôn.` : '') + '\nBạn có chắc muốn trả xu không?')) return;
    state.credit = 0;
    flash(`Đã trả ${coins} xu`);
    render();
}

/* ── Quay thưởng ───────────────────────────────────────── */

function totalBet() {
    return BET_ORDER.reduce((a, s) => a + state.bets[s], 0);
}

/**
 * Chọn ô để đèn dừng lại.
 *
 * Máy thật không quay bằng số ngẫu nhiên đều. Với bảng tỷ lệ này (BAR 100 lần),
 * nếu quay đều thì người chơi cược cả tám hình sẽ chắc chắn thắng — nên máy
 * phải dùng bộ điều khiển "ăn điểm/nhả điểm" để giữ tỷ lệ hoàn trả quanh giá
 * trị chủ máy đặt. Code ở đây làm đúng theo cơ chế đó.
 *
 * Mỗi ván tính cho 24 ô: nếu dừng ở ô này thì máy phải trả bao nhiêu (payout),
 * và trọng số là
 *
 *     weight = tần suất cơ bản × exp(gamma × payout / tổng cược)
 *
 * gamma là trạng thái tích lũy của bộ điều khiển (state.gamma): mỗi ván nó được
 * chỉnh theo chênh lệch giữa tỷ lệ đã trả thực tế và giá trị đã đặt. Máy trả
 * quá giá trị đặt → gamma đi xuống → các ô trả nhiều bị đè xuống theo hàm mũ,
 * máy bắt đầu ăn điểm; trả chưa đủ → gamma đi lên → các ô đó được khuếch đại,
 * máy bắt đầu nhả điểm.
 *
 * Hai điểm then chốt:
 *  1. gamma phải nhân với payout, để thay đổi "độ dốc" của trọng số. Nếu chỉ cộng
 *     cùng một độ lệch cho mọi ô thì khi chuẩn hóa nó sẽ triệt tiêu hết, không còn điều khiển gì.
 *  2. Dùng tích phân (cộng dồn sai số qua các ván) chứ không dùng tỷ lệ (lấy
 *     chính sai số làm hệ số khuếch đại). Điều khiển tỷ lệ sẽ dừng ở chỗ
 *     "sai số × hệ số" vừa đủ giữ, để lại độ lệch ổn định cố định.
 */
function pickCell() {
    const stake = Math.max(totalBet(), 1);

    // Tỷ lệ trả (payout / cược), không thứ nguyên, nên gamma không bị lệch khi cược lớn hay nhỏ
    const ratios = BOARD.map(sym => payoutOf(sym, stake) / stake);
    const exps = ratios.map(x => state.gamma * x);
    const top = Math.max(...exps);

    // Trừ giá trị lớn nhất trước khi lấy exp cho ổn định số; cận dưới −9 làm xác suất các ô bị loại gần bằng 0 nhưng không bằng 0
    const weights = BOARD.map((sym, i) =>
        baseWeight(sym) * Math.exp(Math.max(exps[i] - top, -9)));

    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < weights.length; i++) {
        r -= weights[i];
        if (r <= 0) return i;
    }
    return weights.length - 1;
}

/**
 * Cập nhật bộ điều khiển sau khi mở thưởng.
 *
 * charged là số tiền cược thực sự thu từ người chơi trong ván này; lượt "đặc biệt"
 * miễn phí có charged = 0. Lượt miễn phí vẫn trả điểm nhưng không vào sổ, nên sai
 * số tính là "phí thu lẽ ra phải có − điểm thực tế đã trả", lượt miễn phí sẽ
 * thành sai số âm thuần túy và bộ điều khiển sẽ bù lại trong vài ván sau.
 * Chia cho stakeRef (trung bình trượt quy mô cược) chỉ để gamma không trôi theo độ lớn cược.
 */
function updateController(charged, payout) {
    state.stakeRef = state.stakeRef * 0.99 + Math.max(charged, 1) * 0.01;
    const err = (CONFIG.targetRTP * charged - payout) / state.stakeRef;
    state.gamma = Math.max(-40, Math.min(5, state.gamma + CONFIG.steer * err));
}

/** Tần suất cơ bản: hình có tỷ lệ càng cao thì càng ít xuất hiện, để nhịp quay giống máy thật. */
function baseWeight(sym) {
    if (sym === 'special') return 0.8;
    if (sym === 'bonus') return 0.35;
    return Math.pow(20 / SYMBOLS[sym].odds, 0.6);
}

/** Nếu đèn dừng ở ô sym, máy sẽ trả cho người chơi bao nhiêu điểm trong ván này. */
function payoutOf(sym, stake) {
    if (sym === 'bonus') return stake * CONFIG.bonusMultiplier;
    // "Đặc biệt" không trả điểm ngay, nhưng cho một lượt quay miễn phí; kỳ vọng xấp xỉ tiền cược × tỷ lệ hoàn trả
    if (sym === 'special') return stake * CONFIG.targetRTP;
    return state.bets[sym] * SYMBOLS[sym].odds;
}

function startSpin() {
    if (state.phase === 'won') return flash('Hãy bấm Gấp đôi hoặc Rút điểm trước');
    if (state.phase !== 'idle') return;

    const stake = totalBet();
    const free = state.pendingSpecial > 0;
    if (!free && stake === 0) return flash('Hãy cược trước');

    state.phase = 'spinning';
    state.score = 0;
    if (free) state.pendingSpecial -= 1;
    else state.totalIn += stake;

    lamps.forEach(l => l.classList.remove('on', 'landed', 'win'));
    clearWinFx();
    Sound.stop('win');
    hideBanner();
    render();

    const target = pickCell();
    const laps = 3 + Math.floor(Math.random() * 2);
    const steps = laps * 24 + ((target - state.pos + 24) % 24);

    let i = 0;
    const tick = () => {
        lamps[state.pos].classList.remove('on');
        state.pos = (state.pos + 1) % 24;
        lamps[state.pos].classList.add('on');
        Sound.play(TICKS[i % TICKS.length]);
        i++;

        if (i >= steps) return settle(target, stake, free ? 0 : stake);

        // Lúc đầu tăng tốc, 22 bước cuối giảm tốc, giống cảm giác của đèn chạy thật
        const left = steps - i;
        let delay = 34;
        if (i < 12) delay = 90 - i * 5;
        if (left < 22) delay = 34 + Math.pow(22 - left, 2) * 1.6;
        setTimeout(tick, delay);
    };
    setTimeout(tick, 90);
}

function settle(index, stake, charged) {
    const sym = BOARD[index];
    // landed = đèn dừng ở đây (dù trúng hay không); win = chỉ nhấp nháy khi thật sự trúng
    lamps[index].classList.add('landed');

    if (sym === 'special') {
        state.pendingSpecial += 1;
        updateController(charged, 0);
        state.phase = 'idle';
        lamps[index].classList.add('win');
        showBanner('Đặc biệt　Giữ nguyên cược　Quay miễn phí thêm một lần');
        render();
        return;
    }

    let won = 0;
    if (sym === 'bonus') {
        won = stake * CONFIG.bonusMultiplier;
        if (won > 0) showBanner(`Jackpot!　Tổng cược ${stake} × ${CONFIG.bonusMultiplier}　được ${won} điểm`);
        else showBanner('Jackpot　nhưng ván này không có cược');
    } else {
        const bet = state.bets[sym];
        won = bet * SYMBOLS[sym].odds;
        if (won > 0) {
            markIcon(sym);
            showBanner(`${SYMBOLS[sym].name}　${bet} × ${SYMBOLS[sym].odds}　được ${won} điểm`);
        } else {
            showBanner(`Ra ${SYMBOLS[sym].name}　không cược ô này`);
        }
    }

    if (won > 0) {
        lamps[index].classList.add('win');
        Sound.play('win', { solo: true });
    }

    won = Math.min(won, CONFIG.maxScore);
    state.score = won;
    state.totalOut += won;
    updateController(charged, won);
    clearBets();
    state.doubleCount = 0;
    state.phase = won > 0 ? 'won' : 'idle';
    render();
}

function clearBets() {
    BET_ORDER.forEach(s => { state.bets[s] = 0; });
}

/* ── Gấp đôi (đoán lớn nhỏ) ───────────────────────────── */

function enterDouble() {
    if (state.phase !== 'won') return;
    if (state.doubleCount >= CONFIG.maxDoubleUps) return flash(`Đã đạt giới hạn gấp đôi ${CONFIG.maxDoubleUps} lần`);
    if (state.score * 2 > CONFIG.maxScore) return flash('Điểm thắng đã đạt giới hạn, hãy rút điểm');
    state.phase = 'double';
    el.center.classList.add('flash');
    showBanner(`Gấp đôi lần ${state.doubleCount + 1}　Bấm Nhỏ (1–7) hoặc Lớn (8–14)`);
    render();
}

function guess(side) {
    if (state.phase !== 'double') return;

    state.phase = 'reveal';
    el.center.classList.remove('flash');
    render();

    // 1–14: Nhỏ = 1–7, Lớn = 8–14, mỗi bên một nửa
    const n = 1 + Math.floor(Math.random() * 14);
    const win = (side === 'small') ? n <= 7 : n >= 8;
    const sideName = side === 'small' ? 'Nhỏ' : 'Lớn';

    // Số lăn một lúc rồi mới dừng lại
    let rolls = 0;
    const roll = () => {
        rolls++;
        if (rolls < 12) {
            Sound.play(TICKS[rolls % TICKS.length]);
            writeDisplay(el.center, 1 + Math.floor(Math.random() * 14));
            setTimeout(roll, 40 + rolls * 8);
            return;
        }
        writeDisplay(el.center, n);

        if (win) {
            state.doubleCount += 1;
            state.score = Math.min(CONFIG.maxScore, state.score * 2);
            state.totalOut += state.score / 2;   // phần điểm nhân thêm khi gấp đôi cũng tính là máy đã trả ra
            state.phase = 'won';
            showBanner(`Mở ${n}　${sideName} trúng!　Điểm thắng ${state.score}`);
        } else {
            state.score = 0;
            state.doubleCount = 0;
            state.phase = 'idle';
            showBanner(`Mở ${n}　${sideName} không trúng, điểm thắng về 0`);
        }
        render();
    };
    roll();
}

/* ── Cập nhật màn hình ─────────────────────────────────── */

function render() {
    writeDisplay(el.credit, state.credit);
    writeDisplay(el.score, state.score);

    // Màn hình giữa: lúc rảnh hiển thị số lần "đặc biệt" tích lũy, lúc gấp đôi hiển thị số đang mở
    if (state.phase === 'double') writeDisplay(el.center, 0, { blank: true });
    else if (state.phase !== 'reveal') {
        writeDisplay(el.center, state.pendingSpecial, { blank: state.pendingSpecial === 0 });
    }

    BET_ORDER.forEach((sym, i) => {
        const amount = state.bets[sym];
        writeDisplay(meters[i], amount, { blank: amount === 0 });
        meters[i].classList.toggle('armed', amount > 0 && state.phase === 'idle');
        keys['bet_' + sym].querySelector('.amt').textContent = amount || '';
    });

    const idle = state.phase === 'idle';
    const won = state.phase === 'won';
    const doubling = state.phase === 'double';
    const busy = state.phase === 'spinning' || state.phase === 'reveal';

    BET_ORDER.forEach(sym => { keys['bet_' + sym].disabled = !idle; });

    setKey('betall', idle, false);
    setKey('start', idle && (totalBet() > 0 || state.pendingSpecial > 0), idle && totalBet() > 0);
    setKey('double', won, won);
    setKey('big', doubling, doubling);
    setKey('small', doubling, doubling);
    setKey('wash', !busy && (state.score > 0 || (idle && state.credit > 0)), won);

    document.getElementById('coin-slot').disabled = busy;

    // render() là điểm chung cho mọi thay đổi trạng thái, đặt lưu ở đây thì không bị sót
    saveState();
}

function setKey(id, enabled, live) {
    const b = keys[id];
    b.disabled = !enabled;
    b.classList.toggle('live', !!live && enabled);
}

function markIcon(sym) {
    const m = iconMarks[sym];
    if (m) m.classList.add('on');
}

/** Tắt nhấp nháy của ô trúng (ô trên bảng + biểu tượng trên bàn phím). Trạng thái đứng yên thì giữ nguyên. */
function clearWinFx() {
    lamps.forEach(l => l.classList.remove('win'));
    Object.values(iconMarks).forEach(m => m.classList.remove('on'));
}

let bannerTimer = null;
function showBanner(text, ms = 2600) {
    el.banner.textContent = text;
    el.banner.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(hideBanner, ms);
}
function hideBanner() {
    el.banner.classList.remove('show');
}
const flash = text => showBanner(text, 1500);

function labelOf(sym) {
    if (sym === 'special') return 'Đặc biệt';
    if (sym === 'bonus') return 'Jackpot';
    return `${SYMBOLS[sym].name}　${SYMBOLS[sym].odds} lần`;
}
