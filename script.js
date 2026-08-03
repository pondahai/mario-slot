// Game State
let credits = 1000;
let win = 0;
let bets = {};
let isSpinning = false;
let currentPos = 0;
let trackCells = [];

const MULTIPLIERS = {
    'apple': 2, 'orange': 5, 'mango': 10, 'bell': 15,
    'watermelon': 20, 'star': 30, 'seven': 40, 'bar': 50
};

// 24 track items (typical Mario machine layout)
const boardLayout = [
    'orange', 'apple', 'mango', 'apple', 'watermelon', 'apple', 'star', // Top (0-6)
    'apple', 'orange', 'bell', 'apple', 'seven',                        // Right (7-11)
    'apple', 'mango', 'apple', 'orange', 'apple', 'bell', 'bar',        // Bottom (12-18)
    'apple', 'orange', 'apple', 'mango', 'apple'                        // Left (19-23)
];

document.addEventListener('DOMContentLoaded', () => {
    initLayout();
    initTrack();
    initEditMode();
    initGameLogic();
    updateDisplays();
});

// --- Game Logic ---
function initGameLogic() {
    Object.keys(MULTIPLIERS).forEach(key => bets[key] = 0);

    document.querySelectorAll('.btn-element').forEach(btn => {
        btn.addEventListener('click', (e) => {
            if (document.body.classList.contains('edit-mode')) return;
            
            const type = btn.dataset.type;
            const item = btn.dataset.item;
            
            if (type === 'bet') {
                placeBet(item);
            } else if (type === 'control') {
                if (btn.id === 'btn-start') startSpin();
                if (btn.id === 'btn-reset') resetBets();
            }
        });
    });
}

function placeBet(itemId) {
    if (isSpinning) return;
    if (credits < 10) return;
    
    bets[itemId] += 10;
    credits -= 10;
    
    // Play a click sound if you want, or just visual
    console.log(`Bet on ${itemId}: ${bets[itemId]}`);
    updateDisplays();
}

function resetBets() {
    if (isSpinning) return;
    
    let refund = Object.values(bets).reduce((a, b) => a + b, 0);
    credits += refund;
    Object.keys(bets).forEach(k => bets[k] = 0);
    
    updateDisplays();
}

function updateDisplays() {
    document.getElementById('credit-val').innerText = credits;
    document.getElementById('win-val').innerText = win;
    
    // Size the LCD text based on container height
    document.querySelectorAll('.lcd-text').forEach(el => {
        const containerHeight = el.parentElement.offsetHeight;
        el.style.fontSize = (containerHeight * 0.8) + 'px';
    });
}

function startSpin() {
    if (isSpinning) return;
    const totalBet = Object.values(bets).reduce((a, b) => a + b, 0);
    if (totalBet === 0) return;
    
    isSpinning = true;
    win = 0;
    updateDisplays();
    
    // Clear active
    trackCells.forEach(c => c.classList.remove('active'));
    
    // Choose winner randomly (basic implementation, not weighted)
    const targetIndex = Math.floor(Math.random() * 24);
    
    let spins = 3;
    let stepsToTarget = (targetIndex - currentPos + 24) % 24;
    let totalSteps = (spins * 24) + stepsToTarget;
    
    let currentStep = 0;
    let speed = 50;
    
    function step() {
        trackCells[currentPos].classList.remove('active');
        currentPos = (currentPos + 1) % 24;
        trackCells[currentPos].classList.add('active');
        
        currentStep++;
        
        if (currentStep < totalSteps) {
            if (currentStep > totalSteps - 10) speed += 30;
            else if (currentStep > totalSteps - 20) speed += 15;
            
            setTimeout(step, speed);
        } else {
            finishSpin(targetIndex);
        }
    }
    
    setTimeout(step, speed);
}

function finishSpin(index) {
    isSpinning = false;
    const winningItem = boardLayout[index];
    const bet = bets[winningItem];
    
    if (bet > 0) {
        win = bet * MULTIPLIERS[winningItem];
        credits += win;
        // Blink the winner
        let blinks = 0;
        let blinkInt = setInterval(() => {
            trackCells[index].classList.toggle('active');
            blinks++;
            if(blinks > 5) {
                clearInterval(blinkInt);
                trackCells[index].classList.add('active');
            }
        }, 200);
    }
    updateDisplays();
}

// --- Track Generation ---
function initTrack() {
    const wrapper = document.getElementById('lights-wrapper');
    wrapper.innerHTML = '';
    trackCells = [];
    
    // 7x7 grid border mapping
    // total 24 cells
    const cellW = 100 / 7;
    const cellH = 100 / 7;
    
    for (let i = 0; i < 24; i++) {
        let div = document.createElement('div');
        div.className = 'track-light';
        div.dataset.index = i;
        div.style.width = cellW + '%';
        div.style.height = cellH + '%';
        
        // Calculate position based on index
        if (i < 7) { // Top row
            div.style.top = '0%';
            div.style.left = (i * cellW) + '%';
        } else if (i < 12) { // Right col (rows 1-5)
            div.style.top = ((i - 6) * cellH) + '%';
            div.style.left = (6 * cellW) + '%';
        } else if (i < 19) { // Bottom row (cols 6-0)
            div.style.top = (6 * cellH) + '%';
            div.style.left = ((18 - i) * cellW) + '%';
        } else { // Left col (rows 5-1)
            div.style.top = ((24 - i) * cellH) + '%';
            div.style.left = '0%';
        }
        
        wrapper.appendChild(div);
        trackCells.push(div);
    }
}

// --- Edit Mode Logic ---
function initLayout() {
    const saved = localStorage.getItem('marioSlotLayout');
    if (saved) {
        const layout = JSON.parse(saved);
        document.querySelectorAll('.overlay-element').forEach(el => {
            const id = el.id;
            if (layout[id]) {
                el.style.left = layout[id].left;
                el.style.top = layout[id].top;
                el.style.width = layout[id].width;
                el.style.height = layout[id].height;
            }
        });
    }
}

function initEditMode() {
    const btnEdit = document.getElementById('toggle-edit-btn');
    const btnSave = document.getElementById('save-layout-btn');
    const btnReset = document.getElementById('reset-layout-btn');
    
    // Add resizers to all overlay elements
    document.querySelectorAll('.overlay-element').forEach(el => {
        let resizer = document.createElement('div');
        resizer.className = 'resizer';
        el.appendChild(resizer);
        
        // Setup dragging
        let isDragging = false;
        let isResizing = false;
        let startX, startY, startW, startH, startL, startT;
        let parentW, parentH;
        
        resizer.addEventListener('mousedown', (e) => {
            if (!document.body.classList.contains('edit-mode')) return;
            e.stopPropagation();
            isResizing = true;
            startX = e.clientX; startY = e.clientY;
            startW = el.offsetWidth; startH = el.offsetHeight;
            parentW = el.parentElement.offsetWidth;
            parentH = el.parentElement.offsetHeight;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
        
        el.addEventListener('mousedown', (e) => {
            if (!document.body.classList.contains('edit-mode')) return;
            isDragging = true;
            startX = e.clientX; startY = e.clientY;
            startL = el.offsetLeft; startT = el.offsetTop;
            parentW = el.parentElement.offsetWidth;
            parentH = el.parentElement.offsetHeight;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
        
        function onMouseMove(e) {
            if (isResizing) {
                let newW = startW + (e.clientX - startX);
                let newH = startH + (e.clientY - startY);
                el.style.width = (newW / parentW * 100) + '%';
                el.style.height = (newH / parentH * 100) + '%';
            } else if (isDragging) {
                let newL = startL + (e.clientX - startX);
                let newT = startT + (e.clientY - startY);
                el.style.left = (newL / parentW * 100) + '%';
                el.style.top = (newT / parentH * 100) + '%';
            }
        }
        
        function onMouseUp() {
            isDragging = false;
            isResizing = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            updateDisplays();
        }
    });

    btnEdit.addEventListener('click', () => {
        document.body.classList.toggle('edit-mode');
        if (document.body.classList.contains('edit-mode')) {
            btnEdit.innerText = '關閉編輯模式';
            btnSave.style.display = 'inline-block';
        } else {
            btnEdit.innerText = '開啟編輯模式';
            btnSave.style.display = 'none';
        }
    });

    btnSave.addEventListener('click', () => {
        let layout = {};
        document.querySelectorAll('.overlay-element').forEach(el => {
            layout[el.id] = {
                left: el.style.left,
                top: el.style.top,
                width: el.style.width,
                height: el.style.height
            };
        });
        localStorage.setItem('marioSlotLayout', JSON.stringify(layout));
        alert('佈景位置已儲存！重整網頁也會保留。');
    });

    btnReset.addEventListener('click', () => {
        if(confirm('確定要還原所有預設位置嗎？')) {
            localStorage.removeItem('marioSlotLayout');
            location.reload();
        }
    });
}
