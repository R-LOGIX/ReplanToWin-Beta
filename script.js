// script.js
// --- AUDIO ENGINE ---
let audioCtx;
function playSound(f, d) {
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.connect(g); g.connect(audioCtx.destination);
        o.frequency.setValueAtTime(f, audioCtx.currentTime);
        g.gain.setValueAtTime(0.05, audioCtx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + d);
        o.start(); o.stop(audioCtx.currentTime + d);
    } catch(e) {}
}

// --- HELPER ---
function toYMD(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// --- DATA ---
const KEY = 'replan_v2_data';
let state = {
    subjects: [],       // unified exams/tasks
    plan: {},
    pomodoroLog: [],    // [{date, subject, durationSec}]
    onboardingCompleted: false,
    heatmapMonth: new Date().getMonth(),
    heatmapYear: new Date().getFullYear(),
};
let isPlanEditing = false;
let pomodoroInterval = null;
let pomodoroState = {
    running: false,
    mode: 'focus', // focus / break
    timeLeft: 25 * 60,
    totalSessionSeconds: 0,
    sessionCount: 0,
    selectedSubject: '',
};

function load() {
    try {
        const saved = localStorage.getItem(KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            state = { ...state, ...parsed };
        }
    } catch(e) {}
}

function save() {
    try {
        localStorage.setItem(KEY, JSON.stringify(state));
    } catch(e) {
        console.error('Storage Save Error', e);
    }
    render();
}

// --- UI ---
function switchView(id) {
    playSound(600, 0.1);
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('nav div').forEach(n => {
        if (n.id && n.id.startsWith('nav-')) n.classList.remove('active');
    });
    const target = document.getElementById(`view-${id}`);
    if (target) {
        target.classList.add('active');
        const navEl = document.getElementById(`nav-${id}`);
        if (navEl) navEl.classList.add('active');
    }
}

function toggleMode() {
    const m = document.getElementById('in-mode').value;
    document.getElementById('ui-range').style.display = m === 'range' ? 'block' : 'none';
    document.getElementById('ui-vol').style.display = m === 'vol' ? 'block' : 'none';
    document.getElementById('ui-list').style.display = m === 'list' ? 'block' : 'none';
}

function togglePlanEdit() {
    isPlanEditing = !isPlanEditing;
    const btn = document.getElementById('btn-edit-plan');
    btn.innerText = isPlanEditing ? '✔ 完了' : '✎ 編集';
    if (!isPlanEditing) playSound(800, 0.1);
    render();
}

function updatePlanManual(date, idx, value) {
    if (state.plan[date] && state.plan[date][idx]) {
        state.plan[date][idx].desc = value;
        localStorage.setItem(KEY, JSON.stringify(state));
    }
}

// --- LOGIC ---
function addMaterial() {
    const type = document.getElementById('item-type').value; // exam / task
    const sub = document.getElementById('in-sub').value.trim();
    const date = document.getElementById('in-date').value;
    if (!sub || !date) return alert('科目名/タスク名と期日を入力してください');

    let selectedDays = Array.from(document.querySelectorAll('#in-days input[type="checkbox"]:checked')).map(cb => parseInt(cb.value));
    if (selectedDays.length === 0) {
        return alert('学習する曜日を1つ以上選択してください');
    }

    // subjectのユニークキー: name+date+type で判定
    let subject = state.subjects.find(s => s.name === sub && s.date === date && s.type === type);
    if (!subject) {
        subject = { id: Date.now(), name: sub, date: date, type: type, materials: [] };
        state.subjects.push(subject);
    }

    const mode = document.getElementById('in-mode').value;
    const rounds = parseInt(document.getElementById('in-rounds').value) || 1;
    const mId = Date.now() + Math.floor(Math.random() * 10000);

    let newMat;
    const common = { id: mId, rounds, days: selectedDays };

    if (mode === 'range') {
        let val = document.getElementById('in-val-range').value;
        val = val.replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)).replace(/\s+/g, '');
        const m = val.match(/^(\d+)[-〜~ー](\d+)$/);
        if (!m) return alert('範囲は 1-100 の形式で入力してください');
        newMat = { ...common, type: 'range', name: document.getElementById('in-name-range').value || '教材', start: parseInt(m[1]), end: parseInt(m[2]), doneRounds: new Array(rounds).fill(0), unit: document.getElementById('in-unit-range').value };
    } else if (mode === 'vol') {
        let val = document.getElementById('in-val-vol').value.replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0));
        const total = parseInt(val);
        if (!total) return alert('合計件数を入力してください');
        newMat = { ...common, type: 'vol', name: document.getElementById('in-name-vol').value || '教材', total, doneRounds: new Array(rounds).fill(0), unit: document.getElementById('in-unit-vol').value };
    } else {
        const items = document.getElementById('in-val-list').value.split(/[,、\n]/).filter(s => s.trim());
        if (items.length === 0) return alert('項目を入力してください');
        newMat = { ...common, type: 'list', name: document.getElementById('in-name-list').value || '教材', items: items.map(l => ({ l: l.trim(), d: 0 })) };
    }

    subject.materials.push(newMat);
    playSound(800, 0.2);
    save();
    alert('教材・タスクを登録しました');
}

// --- PLAN GENERATION ---
function generatePlan() {
    if (state.subjects.length === 0) return alert('先に教材/タスクを登録してください');

    playSound(400, 0.5);
    document.getElementById('loading').style.display = 'flex';

    setTimeout(() => {
        try {
            state.plan = {};
            const startDateInput = document.getElementById('sys-start-date').value;
            let globalStart = startDateInput ? new Date(startDateInput) : new Date();
            globalStart.setHours(0,0,0,0);
            const modeSelect = document.getElementById('schedule-mode').value; // 'standard' or 'alternating'

            state.subjects.forEach(subj => {
                const [ey, em, ed] = subj.date.split('-').map(Number);
                const endDate = new Date(ey, em - 1, ed);
                endDate.setHours(0,0,0,0);

                subj.materials.forEach(mat => {
                    const matDays = (mat.days && mat.days.length > 0) ? mat.days : [0,1,2,3,4,5,6];
                    let availableDates = [];
                    let curDate = new Date(globalStart);
                    while (curDate <= endDate) {
                        if (matDays.includes(curDate.getDay())) {
                            availableDates.push(new Date(curDate));
                        }
                        curDate.setDate(curDate.getDate() + 1);
                    }
                    if (availableDates.length === 0) availableDates.push(new Date(globalStart));
                    const daysCount = availableDates.length;

                    if (mat.type === 'list') {
                        // リスト型
                        let queue = [];
                        for (let r = 1; r <= mat.rounds; r++) {
                            mat.items.forEach(it => { if (it.d < r) queue.push({ l: it.l, r: r }); });
                        }
                        const perDay = Math.ceil(queue.length / daysCount);
                        let cur = 0;
                        for (let i=0; i<daysCount && cur<queue.length; i++) {
                            const k = toYMD(availableDates[i]);
                            if (!state.plan[k]) state.plan[k] = [];
                            for (let j=0; j<perDay && cur<queue.length; j++) {
                                if (queue[cur]) {
                                    const t = queue[cur++];
                                    state.plan[k].push({ sub: subj.name, mat: mat.name, desc: t.l, info: `${t.r}周目`, id: mat.id });
                                }
                            }
                        }
                    } else {
                        let unitsPerRound = mat.type === 'range' ? (mat.end - mat.start + 1) : mat.total;
                        if (!mat.doneRounds) mat.doneRounds = new Array(mat.rounds).fill(0);
                        let totalRemUnits = 0;
                        let roundInfo = [];
                        for (let r = 0; r < mat.rounds; r++) {
                            let done = mat.doneRounds[r] || 0;
                            let rem = unitsPerRound - done;
                            if (rem > 0) roundInfo.push({ round: r+1, done, rem });
                        }
                        totalRemUnits = roundInfo.reduce((a,b)=>a+b.rem, 0);
                        if (totalRemUnits <= 0) return;

                        if (modeSelect === 'alternating' && mat.rounds >= 3) {
                            // 小刻み2周＋最終仕上げ1周
                            // 全ラウンドから、最後のラウンドを除く (仕上げ用)
                            let earlyRounds = roundInfo.filter(r => r.round < mat.rounds);
                            let finalRound = roundInfo.find(r => r.round === mat.rounds);
                            let earlyTotal = earlyRounds.reduce((a,b)=>a+b.rem, 0);
                            let finalRem = finalRound ? finalRound.rem : 0;

                            // まず早期ラウンドを (2周ずつ繰り返す) つまり早期ラウンドを通常通り並べるが、スケジュールは全期間の70%を使う、残り30%で最終一周
                            let earlyDays = Math.floor(daysCount * 0.7);
                            let finalDays = daysCount - earlyDays;
                            if (finalDays < 1) finalDays = 1;

                            // 早期ラウンドを先に配置
                            let earlyQueue = [];
                            for (let r of earlyRounds) {
                                let startVal = mat.type==='range' ? mat.start + (mat.doneRounds[r.round-1]||0) : null;
                                let rem = r.rem;
                                let init = startVal;
                                while (rem > 0) {
                                    let chunk = Math.min(rem, Math.ceil(unitsPerRound * 0.2)); // 小刻み
                                    earlyQueue.push({ round: r.round, start: init, chunk });
                                    if (mat.type==='range') init += chunk;
                                    rem -= chunk;
                                }
                            }
                            // 早期ラウンドをearlyDaysに割り振り
                            let perDayEarly = Math.ceil(earlyQueue.length / earlyDays);
                            let curIdx = 0;
                            for (let i=0; i<earlyDays && curIdx < earlyQueue.length; i++) {
                                const k = toYMD(availableDates[i]);
                                if (!state.plan[k]) state.plan[k] = [];
                                let dayCnt = perDayEarly;
                                while (dayCnt > 0 && curIdx < earlyQueue.length) {
                                    let q = earlyQueue[curIdx];
                                    let desc = mat.type==='range' ? `${q.start}〜${q.start+q.chunk-1}${mat.unit||''}` : `${q.chunk}${mat.unit||''}`;
                                    state.plan[k].push({ sub: subj.name, mat: mat.name, desc, info: `${q.round}周目`, id: mat.id });
                                    if (mat.type==='range') q.start += q.chunk;
                                    q.rem = (q.rem||0) - q.chunk;
                                    if (q.rem <= 0) curIdx++;
                                    dayCnt--;
                                }
                            }
                            // 最終ラウンドを残りの日で
                            let finalQueue = [];
                            if (finalRound && finalRound.rem > 0) {
                                let rem2 = finalRound.rem;
                                let start2 = mat.type==='range' ? mat.start + (mat.doneRounds[finalRound.round-1]||0) : null;
                                while (rem2 > 0) {
                                    let chunk2 = Math.min(rem2, Math.ceil(unitsPerRound / finalDays));
                                    finalQueue.push({ round: finalRound.round, start: start2, chunk: chunk2 });
                                    if (mat.type==='range') start2 += chunk2;
                                    rem2 -= chunk2;
                                }
                            }
                            let perDayFinal = Math.ceil(finalQueue.length / finalDays);
                            let cur2 = 0;
                            for (let i=earlyDays; i<daysCount && cur2 < finalQueue.length; i++) {
                                const k = toYMD(availableDates[i]);
                                if (!state.plan[k]) state.plan[k] = [];
                                let dayCnt2 = perDayFinal;
                                while (dayCnt2 > 0 && cur2 < finalQueue.length) {
                                    let q = finalQueue[cur2];
                                    let desc = mat.type==='range' ? `${q.start}〜${q.start+q.chunk-1}${mat.unit||''}` : `${q.chunk}${mat.unit||''}`;
                                    state.plan[k].push({ sub: subj.name, mat: mat.name, desc, info: `${q.round}周目`, id: mat.id });
                                    if (mat.type==='range') q.start += q.chunk;
                                    dayCnt2--;
                                    cur2++;
                                }
                            }
                        } else {
                            // 標準均等割り
                            let queue = [];
                            for (let r of roundInfo) {
                                let startVal = mat.type==='range' ? mat.start + (mat.doneRounds[r.round-1]||0) : null;
                                let rem = r.rem;
                                queue.push({ round: r.round, start: startVal, rem });
                            }
                            let perDay = Math.ceil(totalRemUnits / daysCount);
                            let qIdx = 0;
                            for (let i=0; i<daysCount && qIdx < queue.length; i++) {
                                const k = toYMD(availableDates[i]);
                                if (!state.plan[k]) state.plan[k] = [];
                                let dayRem = perDay;
                                while (dayRem > 0 && qIdx < queue.length) {
                                    let q = queue[qIdx];
                                    let amt = Math.min(dayRem, q.rem);
                                    let desc = mat.type==='range' ? `${q.start}〜${q.start + amt - 1}${mat.unit||''}` : `${amt}${mat.unit||''}`;
                                    if (mat.type==='range') q.start += amt;
                                    state.plan[k].push({ sub: subj.name, mat: mat.name, desc: descText, info: `${q.round}周目`, id: mat.id });
                                    q.rem -= amt;
                                    dayRem -= amt;
                                    if (q.rem <= 0) qIdx++;
                                }
                            }
                        }
                    }
                });
            });
            save();
            document.getElementById('loading').style.display = 'none';
            playSound(1000, 0.3);
            switchView('home');
        } catch (e) {
            document.getElementById('loading').style.display = 'none';
            console.error(e);
            alert('エラーが発生しました');
        }
    }, 500);
}

function updateProg(matId, itIdx, val) {
    const m = findMat(matId);
    if (!m) return;
    if (m.type === 'list') {
        const r = parseInt(val) || 0;
        if (itIdx === -1) m.items.forEach(it => it.d = r);
        else m.items[itIdx].d = r;
    } else {
        let parsed = 0;
        if (m.type === 'range' && typeof val === 'string' && val.match(/\d+[-〜~ー]\d+/)) {
            let parts = val.replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)).split(/[-〜~ー]/);
            parsed = (parseInt(parts[1]) - m.start + 1) || 0;
        } else {
            parsed = parseInt(val) || 0;
        }
        if (itIdx > 0) {
            if (!m.doneRounds) m.doneRounds = new Array(m.rounds).fill(0);
            while(m.doneRounds.length < m.rounds) m.doneRounds.push(0);
            m.doneRounds[itIdx-1] = Math.max(0, parsed);
        }
    }
    save();
}

function deleteMat(subjId, mId) {
    if(!confirm('削除しますか？')) return;
    const subj = state.subjects.find(s => s.id === subjId);
    if (subj) subj.materials = subj.materials.filter(m => m.id !== mId);
    Object.keys(state.plan).forEach(k => state.plan[k] = state.plan[k].filter(t => t.id !== mId));
    save();
}

function findMat(id) {
    for (let s of state.subjects) for (let m of s.materials) if (m.id == id) return m;
    return null;
}

// --- RENDER ---
function render() {
    const today = toYMD(new Date());
    const hasPlan = Object.keys(state.plan).length > 0;
    document.getElementById('main-plan-btn').innerText = hasPlan ? '⚡ 進捗解析・AI再構築' : '✨ AI学習計画を新規生成';

    // 進捗計算
    let tAll = 0, tDone = 0;
    state.subjects.forEach(s => s.materials.forEach(m => {
        if (m.type === 'list') {
            tAll += m.items.length * m.rounds;
            tDone += m.items.reduce((sum,i)=>sum+i.d, 0);
        } else {
            let units = m.type==='range' ? (m.end-m.start+1) : m.total;
            tAll += units * m.rounds;
            tDone += (m.doneRounds || []).reduce((a,b)=>a+b, 0);
        }
    }));
    document.getElementById('stat-progress').innerText = Math.floor((tDone/(tAll||1))*100) + '%';

    if (state.subjects.length) {
        const dates = state.subjects.map(s => new Date(s.date));
        const diff = Math.ceil((Math.min(...dates) - new Date().setHours(0,0,0,0)) / 86400000);
        document.getElementById('stat-days').innerText = Math.max(0, diff) + '日';
    }

    // 今日のタスク
    const tasks = state.plan[today] || [];
    document.getElementById('today-list').innerHTML = tasks.length
        ? tasks.map(t => `<div class="item-row"><div><small>${t.sub}</small><br><b>${t.mat}: ${t.desc}</b></div><span class="status-tag">${t.info}</span></div>`).join('')
        : '<p style="text-align:center; opacity:0.5;">予定なし</p>';

    // 登録リスト（試験日を表示）
    document.getElementById('registered-list').innerHTML = state.subjects.map(s => {
        let typeLabel = s.type === 'exam' ? '📝試験' : '📌課題';
        return `<div style="margin-bottom:12px;"><div style="display:flex; justify-content:space-between;"><strong>${s.name}</strong><span style="font-size:0.8rem;">${typeLabel} 期日: ${s.date}</span></div>`
            + s.materials.map(m => `<div class="item-row"><div><small>${m.name}</small></div><button class="danger" onclick="deleteMat(${s.id}, ${m.id})">削除</button></div>`).join('')
            + `</div>`;
    }).join('') || '<p style="opacity:0.5;">登録なし</p>';

    // 進捗入力
    document.getElementById('progress-input-area').innerHTML = state.subjects.map(s => s.materials.map(m => {
        if (m.type === 'list') {
            return `<div class="glass-card"><h3>${m.name} (${s.name})</h3><div class="item-row"><span>一括</span><input type="number" onchange="updateProg(${m.id},-1,this.value)" style="width:80px;"><span>周</span></div>${m.items.map((it, idx) => `<div class="item-row"><span>${it.l}</span><input type="number" value="${it.d}" onchange="updateProg(${m.id},${idx},this.value)" style="width:60px;"></div>`).join('')}</div>`;
        } else {
            let drs = m.doneRounds || new Array(m.rounds).fill(0);
            let infoText = m.type === 'range' ? `全体範囲: ${m.start}〜${m.end}` : `全体量: ${m.total}`;
            return `<div class="glass-card"><h3>${m.name} (${s.name})</h3>
                <div style="font-size:0.8rem; color:#a0aec0; margin-bottom:8px;">${infoText} ${m.unit||''}</div>
                ${drs.map((dr, idx) => {
                    let val = dr;
                    if(m.type === 'range' && dr > 0) val = `${m.start}-${m.start + dr - 1}`;
                    return `<div class="item-row"><span>${idx+1}周目</span><input type="${m.type==='range'?'text':'number'}" value="${val}" onchange="updateProg(${m.id},${idx+1},this.value)" style="width:100px;"><span>${m.type==='range'?'':(m.unit||'')}</span></div>`;
                }).join('')}</div>`;
        }
    }).join('')).join('') || '<p style="opacity:0.5;">登録なし</p>';

    // 計画表
    let planHtml = '';
    const sortedDates = Object.keys(state.plan).sort();
    sortedDates.forEach(d => {
        planHtml += `<h4 style="color:var(--accent); border-bottom:1px solid #333; margin-bottom:10px; margin-top:20px;">${d}</h4>`;
        state.plan[d].forEach((t, idx) => {
            const content = isPlanEditing
                ? `<input type="text" class="plan-edit-input" value="${t.desc}" oninput="updatePlanManual('${d}', ${idx}, this.value)">`
                : `<b>${t.mat}: ${t.desc}</b>`;
            planHtml += `<div class="item-row"><div style="flex:1;"><small>${t.sub}</small><br>${content}</div><span class="status-tag">${t.info}</span></div>`;
        });
    });
    document.getElementById('full-plan-area').innerHTML = planHtml || '<p style="opacity:0.5;">計画がありません</p>';

    // ヒートマップ更新
    renderHeatmap();

    // ポモドーロの科目選択更新
    updatePomodoroSubjects();
}

// --- HEATMAP ---
function renderHeatmap() {
    const year = state.heatmapYear;
    const month = state.heatmapMonth;
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month+1, 0).getDate();

    document.getElementById('heatmap-month').innerText = `${year}年${month+1}月`;

    let html = '';
    // 曜日ヘッダー
    const weeks = ['日','月','火','水','木','金','土'];
    for (let w of weeks) html += `<div style="font-weight:bold; font-size:0.7rem; opacity:0.7;">${w}</div>`;
    // 空白セル
    for (let i=0; i<firstDay; i++) html += `<div></div>`;
    for (let d=1; d<=daysInMonth; d++) {
        const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const tasksToday = state.plan[dateStr] ? state.plan[dateStr].length : 0;
        let bgOpacity = 0;
        if (tasksToday > 0) bgOpacity = Math.min(1, 0.2 + tasksToday * 0.1);
        const deadlineSubject = state.subjects.find(s => s.date === dateStr);
        const deadlineClass = deadlineSubject ? 'deadline' : '';
        const todayClass = dateStr === toYMD(new Date()) ? 'today' : '';
        const taskClass = tasksToday > 0 ? 'has-task' : '';
        html += `<div class="heatmap-day ${todayClass} ${taskClass} ${deadlineClass}" style="background:rgba(0,242,255,${bgOpacity});" title="${dateStr} (${tasksToday}タスク)">
            <span class="day-num">${d}</span>
            ${tasksToday > 0 ? `<span class="task-indicator">●</span>` : ''}
        </div>`;
    }
    document.getElementById('heatmap-calendar').innerHTML = html;
}

function changeHeatmapMonth(delta) {
    state.heatmapMonth += delta;
    if (state.heatmapMonth < 0) { state.heatmapMonth = 11; state.heatmapYear--; }
    if (state.heatmapMonth > 11) { state.heatmapMonth = 0; state.heatmapYear++; }
    save();
}

// --- POMODORO ---
function openPomodoro() {
    document.getElementById('pomodoro-overlay').classList.remove('hidden');
    updatePomodoroSubjects();
    // タイマーリセット
    clearInterval(pomodoroInterval);
    pomodoroState = { running: false, mode: 'focus', timeLeft: 25*60, totalSessionSeconds: 0, sessionCount: 0, selectedSubject: document.getElementById('pomodoro-subject').value };
    updatePomodoroDisplay();
}

document.getElementById('pomodoro-close-btn').addEventListener('click', () => {
    document.getElementById('pomodoro-overlay').classList.add('hidden');
    clearInterval(pomodoroInterval);
});

document.getElementById('pomodoro-start').addEventListener('click', () => {
    if (pomodoroState.running) return;
    pomodoroState.running = true;
    pomodoroState.selectedSubject = document.getElementById('pomodoro-subject').value;
    document.getElementById('pomodoro-start').style.display = 'none';
    document.getElementById('pomodoro-pause').style.display = 'inline-block';
    pomodoroInterval = setInterval(pomodoroTick, 1000);
});

document.getElementById('pomodoro-pause').addEventListener('click', () => {
    pomodoroState.running = false;
    clearInterval(pomodoroInterval);
    document.getElementById('pomodoro-start').style.display = 'inline-block';
    document.getElementById('pomodoro-pause').style.display = 'none';
});

document.getElementById('pomodoro-reset').addEventListener('click', () => {
    clearInterval(pomodoroInterval);
    pomodoroState.running = false;
    pomodoroState.timeLeft = pomodoroState.mode === 'focus' ? 25*60 : 5*60;
    document.getElementById('pomodoro-start').style.display = 'inline-block';
    document.getElementById('pomodoro-pause').style.display = 'none';
    updatePomodoroDisplay();
});

function pomodoroTick() {
    if (!pomodoroState.running) return;
    pomodoroState.timeLeft--;
    pomodoroState.totalSessionSeconds++;
    if (pomodoroState.timeLeft <= 0) {
        clearInterval(pomodoroInterval);
        pomodoroState.running = false;
        playSound(1000, 0.3);
        // セッション終了処理
        if (pomodoroState.mode === 'focus') {
            pomodoroState.sessionCount++;
            const logEntry = {
                date: toYMD(new Date()),
                subject: pomodoroState.selectedSubject || '未設定',
                durationSec: pomodoroState.totalSessionSeconds
            };
            state.pomodoroLog.push(logEntry);
            // 休憩へ
            pomodoroState.mode = 'break';
            pomodoroState.timeLeft = 5 * 60;
            alert('集中セッション終了！ 5分休憩です。');
        } else {
            // 休憩終了
            pomodoroState.mode = 'focus';
            pomodoroState.timeLeft = 25 * 60;
            alert('休憩終了！ 次のセッションを開始してください。');
        }
        pomodoroState.totalSessionSeconds = 0;
        document.getElementById('pomodoro-start').style.display = 'inline-block';
        document.getElementById('pomodoro-pause').style.display = 'none';
        save(); // ログ保存
    }
    updatePomodoroDisplay();
}

function updatePomodoroDisplay() {
    const mins = Math.floor(pomodoroState.timeLeft / 60);
    const secs = pomodoroState.timeLeft % 60;
    document.getElementById('pomodoro-timer').innerText = `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
    document.getElementById('pomodoro-mode').innerText = pomodoroState.mode === 'focus' ? '集中' : '休憩';
    // ログ簡易表示
    const todayLog = state.pomodoroLog.filter(l => l.date === toYMD(new Date()));
    const totalToday = todayLog.reduce((sum,l)=>sum+l.durationSec, 0);
    const totalSessions = todayLog.length;
    document.getElementById('pomodoro-log').innerHTML = `
        <p style="font-size:0.8rem;">今日のセッション数: ${totalSessions} / 合計時間: ${Math.floor(totalToday/60)}分</p>
        ${todayLog.map(l => `<div style="font-size:0.7rem;">${l.subject}: ${Math.floor(l.durationSec/60)}分</div>`).join('')}
    `;
}

function updatePomodoroSubjects() {
    const sel = document.getElementById('pomodoro-subject');
    sel.innerHTML = '<option value="">未選択</option>'
        + state.subjects.map(s => `<option value="${s.name}">${s.name}</option>`).join('');
}

// --- ONBOARDING WIZARD ---
let wizardStep = 0;
function startWizard() {
    if (state.onboardingCompleted) return;
    document.getElementById('wizard-overlay').classList.remove('hidden');
    wizardStep = 1;
    setWizardStep(1);
}
function endWizard() {
    document.getElementById('wizard-overlay').classList.add('hidden');
    state.onboardingCompleted = true;
    save();
}
function setWizardStep(step) {
    const msg = document.getElementById('wizard-message');
    const btn1 = document.getElementById('wizard-btn1');
    const btn2 = document.getElementById('wizard-btn2');
    const input = document.getElementById('wizard-input');
    const confirm = document.getElementById('wizard-confirm');
    [btn1, btn2, input, confirm].forEach(el => el.style.display = 'none');
    if (step === 1) {
        msg.innerText = 'こんにちは！学習目標を一緒に設定しましょう。まず、一番重要な試験や課題はありますか？';
        btn1.innerText = 'はい、設定する';
        btn2.innerText = '後で自分でやる';
        btn1.style.display = 'block'; btn2.style.display = 'block';
    } else if (step === 2) {
        msg.innerText = '科目名/タスク名を入力してください';
        input.style.display = 'block'; confirm.style.display = 'block';
        input.value = '';
    } else if (step === 3) {
        msg.innerText = '期日を入力してください';
        input.type = 'date'; input.style.display = 'block'; confirm.style.display = 'block';
    } else if (step === 4) {
        msg.innerText = 'これで準備完了です！「AI学習計画を生成する」ボタンから計画を作りましょう。';
        btn1.innerText = 'チュートリアル完了';
        btn1.style.display = 'block';
    }
    if (step === 4) {
        document.getElementById('wizard-btn1').onclick = endWizard;
    }
}
document.getElementById('wizard-btn1').addEventListener('click', () => {
    if (wizardStep === 1) wizardStep = 2; setWizardStep(2);
});
document.getElementById('wizard-btn2').addEventListener('click', endWizard);
document.getElementById('wizard-confirm').addEventListener('click', () => {
    if (wizardStep === 2) {
        document.getElementById('in-sub').value = document.getElementById('wizard-input').value;
        wizardStep = 3; setWizardStep(3);
    } else if (wizardStep === 3) {
        document.getElementById('in-date').value = document.getElementById('wizard-input').value;
        wizardStep = 4; setWizardStep(4);
    }
});

// --- DATA EXPORT/IMPORT ---
function exportAllData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'replan_backup.json'; a.click();
    URL.revokeObjectURL(url);
    playSound(800, 0.2);
}
function importAllData() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.onchange = e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
            try {
                const imported = JSON.parse(ev.target.result);
                if (imported.subjects && imported.plan) {
                    state = { ...state, ...imported };
                    save();
                    alert('データを復元しました');
                } else {
                    alert('不正なファイル形式です');
                }
            } catch(ex) { alert('読み込みエラー'); }
        };
        reader.readAsText(file);
    };
    input.click();
}
function exportPlanTemplate() {
    // 進捗情報を除いた科目・教材構成のみエクスポート
    const template = {
        subjects: state.subjects.map(s => ({
            name: s.name,
            date: s.date,
            type: s.type,
            materials: s.materials.map(m => ({
                type: m.type,
                name: m.name,
                start: m.start,
                end: m.end,
                total: m.total,
                unit: m.unit,
                rounds: m.rounds,
                days: m.days,
                items: m.type==='list' ? m.items.map(i=>({l:i.l, d:0})) : undefined
            }))
        }))
    };
    const blob = new Blob([JSON.stringify(template, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'replan_template.json'; a.click();
    URL.revokeObjectURL(url);
    playSound(800, 0.2);
}

// --- PDF PRINT ---
function printPlan() {
    window.print();
}

// --- NOTIFICATIONS ---
function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}
function scheduleReminder() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const now = new Date();
    const evening = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0);
    if (now > evening) return; // already past
    const msUntil = evening - now;
    setTimeout(() => {
        const today = toYMD(new Date());
        const tasks = state.plan[today] || [];
        if (tasks.length > 0) {
            new Notification('ReplanToWin', { body: `今日の未完了タスク: ${tasks.length}件。確認しましょう！` });
        }
    }, msUntil);
}

// --- INIT ---
window.onload = () => {
    load();
    document.getElementById('sys-start-date').value = toYMD(new Date());
    render();
    if ('serviceWorker' in navigator) {
        const sw = "self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{});";
        navigator.serviceWorker.register(URL.createObjectURL(new Blob([sw], {type: 'application/javascript'}))).catch(()=>{});
    }
    requestNotificationPermission();
    scheduleReminder();
    if (!state.onboardingCompleted) startWizard();
};
window.addEventListener('beforeunload', save);
window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });