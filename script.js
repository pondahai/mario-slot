/* ─────────────────────────────────────────────────────────────
   小瑪莉（麻仔台 / 水果盤）模擬器

   玩法依照真實機台：投幣取得分數 → 用八個圖案鍵押注 → 按開始跑燈 →
   跑燈停在有押注的圖案就依賠率得分 → 得分可以「比倍」猜大小翻倍，
   或按「洗分」把得分收回分數。單一圖案押注上限 99 分。
   （參考資料見 README.md）

   盤面的 24 格、七段顯示器、按鍵位置全部是從原圖量出來的像素座標，
   換算成百分比後寫在這裡；切圖流程見 tools/slice_assets.py。
   ───────────────────────────────────────────────────────────── */

'use strict';

/* ── 機台設定 ──────────────────────────────────────────── */

const CONFIG = {
    coinValue: 10,        // 投幣器面板標示「10 元」，一枚 10 分
    exchangeRate: 5,      // 賠率牌標示「5 比 1」：退幣時 5 分換 1 枚
    maxBetPerSymbol: 99,  // 真實機台單一圖案上限 99 分
    maxCredit: 9999,      // 四位數七段顯示器
    maxScore: 9999,
    maxDoubleUps: 10,     // 連續比倍上限
    bonusMultiplier: 10,  // 彩金格：押注總額 × 10
    targetRTP: 0.90,      // 機台設定的返還率，跑燈結果會朝這個值收斂
    steer: 0.03,          // 吃分／吐分控制器的積分速率：越大修正越快、波動越小
};

/* ── 音效 ──────────────────────────────────────────────────

   音源是真機錄音，用 tools/slice_audio.py 切好、接成一個 sprite
   （assets/audio/sprite.ogg / .mp3 + sprite.json）。

   用 Web Audio 而不是 <audio> 元素：跑燈最快 34ms 就要響一次，
   <audio> 的播放延遲和重複觸發根本跟不上。

   關於偏移量：sprite.json 裡有每段的起點，但**不直接拿來用**。mp3 解碼
   會在開頭多出編碼器延遲（約 1100 個取樣），整批偏移量會一起位移，對
   37ms 的 tick 等於全錯。所以載入後改成從解碼結果裡「找出片段之間那
   0.1 秒的靜音」來重新推算邊界，json 只用來提供名稱順序與備援。      */

const Sound = {
    ctx: null,
    buffer: null,
    clips: {},          // name → [起點秒, 長度秒]
    ready: false,
    enabled: true,
    volume: 0.7,
    _master: null,
    _live: {},          // name → 正在播放的 source，長音效用來自我中斷

    /** 第一次使用者互動時才建立 AudioContext —— 瀏覽器會擋掉更早的嘗試。 */
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
            console.warn('音效載入失敗，遊戲照常運作：', err);
        }
    },

    /**
     * 從解碼後的波形找出片段邊界。
     *
     * 片段之間有 0.1 秒的數位靜音，找出這些靜音就能重建每段的位置，
     * 不受編碼器延遲影響。數量對不上時退回 json 裡的偏移量。
     */
    _mapClips(meta) {
        const names = Object.keys(meta.clips).sort(
            (a, b) => meta.clips[a][0] - meta.clips[b][0]);
        const data = this.buffer.getChannelData(0);
        const sr = this.buffer.sampleRate;
        const win = Math.max(1, Math.round(sr * 0.005));
        const quiet = 0.004;                       // 約 −48 dBFS
        const minGap = Math.round(0.05 / 0.005);   // 至少 50ms 才算間隔

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
            console.warn('音效邊界偵測到 %d 段、預期 %d 段，改用 json 偏移量',
                         regions.length, names.length);
            names.forEach(n => { out[n] = meta.clips[n].slice(); });
        }
        return out;
    },

    /** 播放一段。rate 可以微調音高，solo 會中斷同名的前一次播放。 */
    play(name, opts = {}) {
        if (!this.ready || !this.enabled) return;
        const clip = this.clips[name];
        if (!clip) return;
        if (this.ctx.state === 'suspended') this.ctx.resume();

        if (opts.solo && this._live[name]) {
            try { this._live[name].stop(); } catch (e) { /* 已經停了 */ }
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

    setEnabled(on) {
        this.enabled = on;
        if (on) this.unlock();
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

// 跑燈的四顆 tick 輪流播放。真機的跑燈是一段音階，單顆重複會很單調。
const TICKS = ['tick1', 'tick2', 'tick3', 'tick4'];

/* ── 八個可押注圖案與賠率 ──────────────────────────────── */

const SYMBOLS = {
    bar:        { name: 'BAR',  odds: 100 },
    seven:      { name: '77',   odds: 40 },
    star:       { name: '雙星', odds: 30 },
    olive:      { name: '橄欖', odds: 25 },
    bell:       { name: '鈴鐺', odds: 20 },
    watermelon: { name: '西瓜', odds: 15 },
    orange:     { name: '橘子', odds: 10 },
    apple:      { name: '蘋果', odds: 5 },
};

// 按鍵盤與盤面計數器由左到右的順序（兩者一致）
const BET_ORDER = ['bar', 'seven', 'star', 'olive', 'bell', 'watermelon', 'orange', 'apple'];

/* ── 盤面 24 格（index 0 = 左上角，順時鐘） ──────────────
   對照原圖：特別 = 戰神頭像 / 印章，彩金 = 金色紋飾。        */

const BOARD = [
    'orange', 'bell', 'special', 'bar', 'special', 'apple', 'watermelon',  //  0–6  上排
    'olive', 'olive', 'bonus', 'apple', 'orange',                          //  7–11 右排
    'orange', 'bell', 'seven', 'bar', 'seven', 'watermelon', 'watermelon', // 12–18 下排
    'star', 'star', 'bonus', 'apple', 'bell',                              // 19–23 左排
];

/* ── 版面幾何（全部是量出來的像素，換算成百分比） ─────── */

const BOARD_PX = { w: 466, h: 549 };
const RING = { x0: 67, y0: 88, cw: 48.0, ch: 48.143 };   // 7×7 外圈
const METER = { x0: 52, pitch: 46.75 };   // 尺寸與 y 由 styles.css 的 .bet-meter 決定

// 24 格在 7×7 網格上的 (col,row)，順時鐘
const RING_CELLS = (() => {
    const out = [];
    for (let c = 0; c < 7; c++) out.push([c, 0]);
    for (let r = 1; r < 6; r++) out.push([6, r]);
    for (let c = 6; c >= 0; c--) out.push([c, 6]);
    for (let r = 5; r >= 1; r--) out.push([0, r]);
    return out;
})();

const PANEL_PX = { w: 380, h: 187 };

// 上排六顆控制鍵，由左至右（黃 / 橙橙 / 紅紅 / 藍）
const CONTROL_KEYS = [
    { id: 'wash',   label: '洗分',   rect: [55, 28, 27, 42], hint: '得分收進分數；得分為 0 時退幣' },
    { id: 'betall', label: '全押',   rect: [114, 29, 29, 41], hint: '八個圖案各押 1 分' },
    { id: 'small',  label: '小',     rect: [147, 29, 30, 41], hint: '比倍猜小（1–7）' },
    { id: 'big',    label: '大',     rect: [207, 30, 28, 41], hint: '比倍猜大（8–14）' },
    { id: 'double', label: '比倍',   rect: [238, 30, 28, 41], hint: '得分翻倍挑戰' },
    { id: 'start',  label: '開始',   rect: [295, 29, 28, 41], hint: '開始跑燈' },
];

// 下排八顆押注鍵 + 上方的圖案磁磚（用來標示中獎圖案）
const BET_KEY_X = [50, 83, 116, 147, 203, 236, 267, 299];
const BET_KEY = { y: 112, h: 37, w: 29 };
const BET_ICON = { y: 78, h: 33 };

/* ── 七段顯示器 ────────────────────────────────────────── */

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

/** 把 value 寫進顯示器；blank = true 時整排熄掉（比倍時用來閃號碼）。 */
function writeDisplay(el, value, opts = {}) {
    const digits = [...el.children];
    const text = opts.blank ? '' : String(Math.max(0, Math.round(value)));
    // 靠右對齊，左邊補空白（真實機台前導零是熄的）
    const padded = text.padStart(digits.length, ' ').slice(-digits.length);
    digits.forEach((svg, i) => {
        const ch = padded[i];
        const lit = ch === ' ' ? '' : (SEG_MAP[ch] || '');
        svg.querySelectorAll('polygon').forEach(p => {
            p.setAttribute('class', lit.includes(p.dataset.seg) ? 'seg-on' : 'seg-off');
        });
    });
}

/* ── 遊戲狀態 ──────────────────────────────────────────── */

const state = {
    credit: 0,
    score: 0,
    bets: Object.fromEntries(BET_ORDER.map(k => [k, 0])),
    phase: 'idle',        // idle | spinning | won | double | reveal
    pos: 0,               // 跑燈目前位置
    doubleCount: 0,
    pendingSpecial: 0,    // 「特別」累積的免費開獎次數
    gamma: -1.5,          // 吃分／吐分控制器的積分狀態（見 pickCell）
    stakeRef: 8,          // 押注規模的移動平均，用來把控制器誤差無因次化
    totalIn: 0,           // 累計投注
    totalOut: 0,          // 累計得分
};

const el = {};
const lamps = [];
const meters = [];
const keys = {};
const iconMarks = {};

/* ── 初始化 ────────────────────────────────────────────── */

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
        `返還率設定 ${(CONFIG.targetRTP * 100).toFixed(0)}%。跑燈結果由機率控制器決定，` +
        `會依照累計投注／得分把實際返還率拉回設定值 —— 真實機台也是這樣「吃分吐分」的。`;

    state.credit = 100;   // 開機先送 100 分，免得一開始只能盯著投幣器
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
        b.title = `押 ${SYMBOLS[sym].name}（${SYMBOLS[sym].odds} 倍）　快捷鍵 ${i + 1}`;
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
        `<tr><td>${SYMBOLS[s].name}</td><td>${SYMBOLS[s].odds} 倍</td><td>${counts[s]} 格</td></tr>`);
    rows.push(`<tr><td>特別</td><td>免費再開</td><td>${counts.special} 格</td></tr>`);
    rows.push(`<tr><td>彩金</td><td>總押 ×${CONFIG.bonusMultiplier}</td><td>${counts.bonus} 格</td></tr>`);
    t.innerHTML = rows.join('');
}

function bindGlobal() {
    // 瀏覽器規定要有使用者互動才能出聲，所以第一次點擊／按鍵時才建立 AudioContext
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

/* ── 玩家動作 ──────────────────────────────────────────── */

function insertCoin() {
    if (state.phase === 'spinning' || state.phase === 'reveal') return;
    if (state.credit + CONFIG.coinValue > CONFIG.maxCredit) return flash('分數已滿');
    state.credit += CONFIG.coinValue;
    Sound.play('coin', { solo: true });
    render();
}

function placeBet(sym) {
    if (state.phase !== 'idle') return;
    if (state.bets[sym] >= CONFIG.maxBetPerSymbol) return flash(`${SYMBOLS[sym].name} 已達上限 ${CONFIG.maxBetPerSymbol}`);
    if (state.credit < 1) return flash('分數不足　請投幣');
    state.credit -= 1;
    state.bets[sym] += 1;
    Sound.play('bet');
    render();
}

function betAll() {
    if (state.phase !== 'idle') return;
    const room = BET_ORDER.filter(s => state.bets[s] < CONFIG.maxBetPerSymbol);
    if (!room.length) return flash('押注已達上限');
    if (state.credit < room.length) return flash('分數不足　請投幣');
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

/** 洗分：有得分就把得分收進分數；沒得分就退幣。 */
function wash() {
    if (state.phase === 'spinning' || state.phase === 'reveal') return;

    if (state.score > 0) {
        state.credit = Math.min(CONFIG.maxCredit, state.credit + state.score);
        flash(`洗分 ${state.score} 分`);
        state.score = 0;
        state.doubleCount = 0;
        state.phase = 'idle';
        render();
        return;
    }

    if (state.phase !== 'idle') return;
    if (state.credit <= 0) return flash('沒有分數可退');

    const coins = Math.floor(state.credit / CONFIG.exchangeRate);
    const left = state.credit % CONFIG.exchangeRate;
    if (!confirm(`退幣：${state.credit} 分 → ${coins} 枚（${CONFIG.exchangeRate} 比 1）` +
                 (left ? `，餘 ${left} 分無法整除、將一併退清。` : '') + '\n確定要退幣嗎？')) return;
    state.credit = 0;
    flash(`退出 ${coins} 枚`);
    render();
}

/* ── 開獎 ──────────────────────────────────────────────── */

function totalBet() {
    return BET_ORDER.reduce((a, s) => a + state.bets[s], 0);
}

/**
 * 挑出跑燈要停的格子。
 *
 * 真實小瑪莉不是均勻亂數。這種台子的賠率（BAR 100 倍）如果配上均勻開獎，
 * 玩家八個圖案全押就是穩賺 —— 所以機台一定是靠控制器「吃分／吐分」把
 * 返還率壓在台主設定的數字上，這裡就照這個機制做。
 *
 * 每局對 24 格各自算「如果開這一格，要賠多少（payout）」，權重為
 *
 *     weight = 基礎出現頻率 × exp(gamma × payout / 押注總額)
 *
 * gamma 是控制器的積分狀態（state.gamma）：每一局用實際賠出去的比例和
 * 設定值的差去修正它。機台賠超過設定值 → gamma 往負走 → 賠得多的格子被
 * 指數壓下去，開始吃分；賠不夠 → gamma 往正走 → 那些格子被放大，開始吐分。
 *
 * 兩個關鍵：
 *  1. gamma 要乘在 payout 上，改變權重的「斜率」。若只是對每一格加同一個
 *     偏移量，正規化時會整個消掉，等於沒有控制。
 *  2. 要用積分（逐局累加誤差）而不是比例（直接用誤差當增益）。比例控制會
 *     停在「誤差 × 增益」剛好撐住的地方，留下固定的穩態偏差。
 */
function pickCell() {
    const stake = Math.max(totalBet(), 1);

    // 賠付比例（payout / 押注），無因次，所以 gamma 不會隨押注大小失準
    const ratios = BOARD.map(sym => payoutOf(sym, stake) / stake);
    const exps = ratios.map(x => state.gamma * x);
    const top = Math.max(...exps);

    // 減掉最大值再取 exp：數值穩定；下限 −9 讓極差的格子機率趨近零但不為零
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
 * 開完獎後回饋給控制器。
 *
 * charged 是這局實際從玩家身上收走的押注 —— 「特別」送的免費開獎是 0。
 * 免費局照樣會賠分卻不進帳，所以誤差算的是「該收的抽成 − 實際賠出去的分」，
 * 免費局就變成純負誤差，控制器會在後面幾局把它吃回來。
 * 除以 stakeRef（押注規模的移動平均）只是為了讓 gamma 不隨押注大小漂移。
 */
function updateController(charged, payout) {
    state.stakeRef = state.stakeRef * 0.99 + Math.max(charged, 1) * 0.01;
    const err = (CONFIG.targetRTP * charged - payout) / state.stakeRef;
    state.gamma = Math.max(-40, Math.min(5, state.gamma + CONFIG.steer * err));
}

/** 基礎出現頻率：賠率越高的圖案越少出，讓開獎節奏像真機台。 */
function baseWeight(sym) {
    if (sym === 'special') return 0.8;
    if (sym === 'bonus') return 0.35;
    return Math.pow(20 / SYMBOLS[sym].odds, 0.6);
}

/** 若跑燈停在 sym 這一格，本局會賠給玩家多少分。 */
function payoutOf(sym, stake) {
    if (sym === 'bonus') return stake * CONFIG.bonusMultiplier;
    // 「特別」當下不賠分，但送一次免費開獎，期望值大約是押注 × 返還率
    if (sym === 'special') return stake * CONFIG.targetRTP;
    return state.bets[sym] * SYMBOLS[sym].odds;
}

function startSpin() {
    if (state.phase === 'won') return flash('請先按 比倍 或 洗分');
    if (state.phase !== 'idle') return;

    const stake = totalBet();
    const free = state.pendingSpecial > 0;
    if (!free && stake === 0) return flash('請先押注');

    state.phase = 'spinning';
    state.score = 0;
    if (free) state.pendingSpecial -= 1;
    else state.totalIn += stake;

    lamps.forEach(l => l.classList.remove('on', 'win'));
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

        // 起步加速、最後 22 步減速，跟真實跑燈的手感一樣
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
    lamps[index].classList.add('win');

    if (sym === 'special') {
        state.pendingSpecial += 1;
        updateController(charged, 0);
        state.phase = 'idle';
        showBanner('特別　押注保留　免費再開一次');
        render();
        return;
    }

    let won = 0;
    if (sym === 'bonus') {
        won = stake * CONFIG.bonusMultiplier;
        if (won > 0) showBanner(`彩金！　總押 ${stake} × ${CONFIG.bonusMultiplier}　得 ${won} 分`);
        else showBanner('彩金　但本局沒有押注');
    } else {
        const bet = state.bets[sym];
        won = bet * SYMBOLS[sym].odds;
        if (won > 0) {
            markIcon(sym);
            showBanner(`${SYMBOLS[sym].name}　${bet} × ${SYMBOLS[sym].odds}　得 ${won} 分`);
        } else {
            showBanner(`開出 ${SYMBOLS[sym].name}　沒押到`);
        }
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

/* ── 比倍（猜大小） ────────────────────────────────────── */

function enterDouble() {
    if (state.phase !== 'won') return;
    if (state.doubleCount >= CONFIG.maxDoubleUps) return flash(`已達比倍上限 ${CONFIG.maxDoubleUps} 次`);
    if (state.score * 2 > CONFIG.maxScore) return flash('得分已達上限　請洗分');
    state.phase = 'double';
    el.center.classList.add('flash');
    showBanner(`比倍第 ${state.doubleCount + 1} 次　請按 小(1–7) 或 大(8–14)`);
    render();
}

function guess(side) {
    if (state.phase !== 'double') return;

    state.phase = 'reveal';
    el.center.classList.remove('flash');
    render();

    // 1–14，小 = 1–7、大 = 8–14，各佔一半
    const n = 1 + Math.floor(Math.random() * 14);
    const win = (side === 'small') ? n <= 7 : n >= 8;

    // 號碼滾動一下再定住
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
            state.totalOut += state.score / 2;   // 翻倍多出來的部分也算機台吐出去的分
            state.phase = 'won';
            showBanner(`開 ${n}　${side === 'small' ? '小' : '大'} 中！　得分 ${state.score}`);
        } else {
            state.score = 0;
            state.doubleCount = 0;
            state.phase = 'idle';
            showBanner(`開 ${n}　${side === 'small' ? '小' : '大'} 沒中　得分歸零`);
        }
        render();
    };
    roll();
}

/* ── 畫面更新 ──────────────────────────────────────────── */

function render() {
    writeDisplay(el.credit, state.credit);
    writeDisplay(el.score, state.score);

    // 中央顯示器：閒置時顯示累積的「特別」次數，比倍時顯示號碼
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
}

function setKey(id, enabled, live) {
    const b = keys[id];
    b.disabled = !enabled;
    b.classList.toggle('live', !!live && enabled);
}

function markIcon(sym) {
    const m = iconMarks[sym];
    if (!m) return;
    m.classList.add('on');
    setTimeout(() => m.classList.remove('on'), 2200);
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
    if (sym === 'special') return '特別';
    if (sym === 'bonus') return '彩金';
    return `${SYMBOLS[sym].name}　${SYMBOLS[sym].odds} 倍`;
}
