import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, push, get, query, orderByChild, startAt } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { aiValidateSetup, aiMarketContext, showAILoading, renderAIResponse } from "./gemini.js";

const firebaseConfig = {
    apiKey: "AIzaSyBhVpnVtlLMy0laY8U5A5Y8lLY9s3swjkE",
    authDomain: "trading-terminal-b8006.firebaseapp.com",
    projectId: "trading-terminal-b8006",
    storageBucket: "trading-terminal-b8006.firebasestorage.app",
    messagingSenderId: "690730161822",
    appId: "1:690730161822:web:81dabfd7b4575e86860d8f",
    databaseURL: "https://trading-terminal-b8006-default-rtdb.firebaseio.com"
};
const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

// ── STATE ──
let clusters           = {};
let selectedClusterId  = null;
let selectedNodeIdx    = null;
let selectedSlotIdx    = null;  // selected slot index in preentry
let lockRiskAmt        = 0;     // locked risk amount for this session
let lockQty            = null;  // locked quantity calculated
let analysisStart      = null;
let analysisTimerInt   = null;
let analysisElapsed    = 0; // seconds

// ── HELPER: getDaySlots (same logic as index.js) ──
function getDaySlots(node, dayName) {
    const raw = node?.times?.[dayName];
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.filter(s => s && s.start);
    if (raw.start) return [{ start: raw.start, end: raw.end||'', expire: raw.expire||'', risk: raw.risk ?? node.risk ?? 0.35 }];
    return [];
}
function timeToMinutes(t) {
    if (!t) return null;
    const [h, m] = t.split(':').map(Number);
    return isNaN(h) ? null : h * 60 + m;
}
function formatCountdown(s) {
    if (s <= 0) return '00:00:00';
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

// Pre-entry data state
const peData = {
    readiness:    {},   // { shower, sleep, noemo, noloss, screen, plan }
    htf:          {},   // { ms, zone }
    ltf:          {},   // { ms, candle }
    smm:          {},   // { liqHunt, orderBlock, ... }
    mstate:       null,
    volatility:   null,
    asset:        'XAUUSD',
    direction:    '',
    entryZone:    '',
    stopZone:     '',
    targetZone:   '',
    rrPlanned:    '',
    note:         '',
    timerSecs:    0,
    savedAt:      null
};

// ── FIREBASE CLUSTERS ──
onValue(ref(db, 'isi_v6/clusters'), (snap) => {
    clusters = snap.val() || {};
    document.getElementById('peFbStatus').textContent = '● LIVE';
    document.getElementById('peFbStatus').className   = 'fb-dot live';
    populateClusters();
    loadTodayHistory();
});

function populateClusters() {
    const sel   = document.getElementById('peClusterSel');
    const saved = localStorage.getItem('isi_sel_cluster');
    sel.innerHTML = '<option value="">— Cluster —</option>';
    Object.entries(clusters).forEach(([id, c]) => {
        const o = document.createElement('option');
        o.value = id; o.textContent = c.title;
        sel.appendChild(o);
    });
    if (saved && clusters[saved]) {
        sel.value = saved;
        selectedClusterId = saved;
        populateAccounts(saved);
        const savedNode = localStorage.getItem('isi_sel_node');
        if (savedNode !== null && savedNode !== '') {
            document.getElementById('peAccountSel').value = savedNode;
            selectedNodeIdx = parseInt(savedNode);
        }
    }
}

function populateAccounts(clusterId) {
    const sel = document.getElementById('peAccountSel');
    sel.innerHTML = '<option value="">— Account —</option>';
    sel.disabled  = false;
    const nodes = clusters[clusterId]?.nodes || [];
    nodes.forEach((n, i) => {
        const o = document.createElement('option');
        o.value = i;
        o.textContent = `${n.title || 'Account ' + (i+1)} [#${n.order||i+1}]`;
        sel.appendChild(o);
    });
}

window.onPeClusterChange = function () {
    selectedClusterId = document.getElementById('peClusterSel').value || null;
    selectedNodeIdx   = null;
    const accSel = document.getElementById('peAccountSel');
    accSel.innerHTML = '<option value="">— Account —</option>';
    accSel.disabled  = true;
    if (selectedClusterId) {
        localStorage.setItem('isi_sel_cluster', selectedClusterId);
        populateAccounts(selectedClusterId);
    }
    loadTodayHistory();
};

window.onPeAccountChange = function () {
    const val = document.getElementById('peAccountSel').value;
    selectedNodeIdx = val !== '' ? parseInt(val) : null;
    selectedSlotIdx = null;
    if (selectedNodeIdx !== null) localStorage.setItem('isi_sel_node', selectedNodeIdx);
    loadTodayHistory();
    renderPeTimerSlider();
    renderPeSlotSelector();
};

// ── TIMER SLIDER (same cards as dashboard) ──
function renderPeTimerSlider() {
    const grid = document.getElementById('peTimerSlider');
    if (!grid) return;
    grid.innerHTML = '';
    const dayName = ['SUN','MON','TUE','WED','THU','FRI','SAT'][new Date().getDay()];
    const now     = new Date();
    const nowMin  = now.getHours() * 60 + now.getMinutes();

    let cards = [];
    Object.entries(clusters).forEach(([cId, cluster]) => {
        (cluster.nodes || []).forEach((node, nIdx) => {
            getDaySlots(node, dayName).forEach((slot, slotIdx) => {
                if (slot.start) cards.push({ cId, cluster, node, nIdx, slot, slotIdx });
            });
        });
    });

    if (!cards.length) {
        grid.innerHTML = '<div style="color:#444;font-size:0.72rem;padding:8px;">No slots scheduled for today.</div>';
        return;
    }

    cards.forEach(({ cId, cluster, node, nIdx, slot, slotIdx }) => {
        const isSelected = cId === selectedClusterId && nIdx === selectedNodeIdx && slotIdx === selectedSlotIdx;
        const startMin   = timeToMinutes(slot.start);
        const endMin     = timeToMinutes(slot.end);
        const expMin     = timeToMinutes(slot.expire);
        let phase = 'idle', stText = 'SCHEDULED', stColor = '#c5a059';
        if (startMin !== null && nowMin >= startMin && expMin !== null && nowMin >= expMin) {
            phase = 'done'; stText = 'EXPIRED'; stColor = '#444';
        } else if (startMin !== null && endMin !== null && nowMin >= startMin && nowMin < endMin) {
            phase = 'live'; stText = '● LIVE'; stColor = '#00c805';
        } else if (startMin !== null && nowMin < startMin) {
            phase = 'pre'; stText = 'SCHEDULED'; stColor = '#c5a059';
        }
        const totalSlots = getDaySlots(node, dayName).length;
        const slotLabel  = totalSlots > 1 ? ` · S${slotIdx+1}/${totalSlots}` : '';
        const border     = isSelected ? '2px solid var(--gold)' : '1px solid #222';
        const bg         = isSelected ? '#0a0800' : '#050505';

        const card = document.createElement('div');
        card.style.cssText = `min-width:160px;flex:0 0 160px;background:${bg};border:${border};border-radius:8px;padding:10px 12px;cursor:pointer;`;
        card.innerHTML = `
            <div style="font-size:0.58rem;color:#555;letter-spacing:1px;">${cluster.title}</div>
            <div style="font-size:0.75rem;font-weight:bold;color:${isSelected?'var(--gold)':'#ccc'};margin:2px 0;">${node.title||'Account '+(nIdx+1)}${slotLabel}</div>
            <div style="font-size:0.65rem;color:#888;">${slot.start||'--'} → ${slot.expire||slot.end||'--'}</div>
            <div style="font-size:0.62rem;color:var(--accent);margin-top:3px;">${slot.risk||0.35}% risk</div>
            <div style="font-size:0.68rem;font-weight:bold;color:${stColor};margin-top:4px;">${stText}</div>`;
        card.dataset.cid     = cId;
        card.dataset.nidx    = nIdx;
        card.dataset.slotidx = slotIdx;
        grid.appendChild(card);
    });

    // Seamless loop — duplicate all cards (cloneNode)
    Array.from(grid.children).forEach(c => grid.appendChild(c.cloneNode(true)));

    // Event delegation — original + cloned cards dono ke liye
    grid.onclick = (e) => {
        const c = e.target.closest('[data-cid]');
        if (c) selectPeSlot(c.dataset.cid, parseInt(c.dataset.nidx), parseInt(c.dataset.slotidx));
    };

    // Dynamic speed: ~4s per card, 8s min, 25s max
    grid.style.animationDuration = Math.max(8, Math.min(25, cards.length * 4)) + 's';
}

// When a timer card is clicked in preentry slider
function selectPeSlot(cId, nIdx, slotIdx) {
    // Update dropdowns
    const clSel = document.getElementById('peClusterSel');
    const acSel = document.getElementById('peAccountSel');
    if (clSel.value !== cId) {
        clSel.value = cId;
        selectedClusterId = cId;
        localStorage.setItem('isi_sel_cluster', cId);
        populateAccounts(cId);
    }
    if (parseInt(acSel.value) !== nIdx) {
        acSel.value = nIdx;
        selectedNodeIdx = nIdx;
        localStorage.setItem('isi_sel_node', nIdx);
    }
    selectedSlotIdx = slotIdx;
    renderPeTimerSlider(); // re-highlight
    renderPeSlotSelector();
    loadTodayHistory();
}

// ── SLOT SELECTOR DROPDOWN ──
function renderPeSlotSelector() {
    const wrap = document.getElementById('peSlotWrap');
    const sel  = document.getElementById('peSlotSel');
    if (!wrap || !sel) return;

    if (selectedNodeIdx === null || !selectedClusterId) { wrap.style.display = 'none'; return; }

    const node    = clusters[selectedClusterId]?.nodes[selectedNodeIdx];
    if (!node) { wrap.style.display = 'none'; return; }

    const dayName = ['SUN','MON','TUE','WED','THU','FRI','SAT'][new Date().getDay()];
    const slots   = getDaySlots(node, dayName);

    if (slots.length <= 1) {
        wrap.style.display = 'none';
        if (slots.length === 1) { selectedSlotIdx = 0; updatePeLockRisk(); }
        return;
    }

    wrap.style.display = '';
    sel.innerHTML = '';
    slots.forEach((sl, si) => {
        const opt = document.createElement('option');
        opt.value = si;
        opt.textContent = `Slot ${si+1}: ${sl.start||'--'} → ${sl.expire||sl.end||'--'} (${sl.risk||0.35}% risk)`;
        sel.appendChild(opt);
    });

    // Auto-select based on selectedSlotIdx or time
    if (selectedSlotIdx !== null && slots[selectedSlotIdx]) {
        sel.value = selectedSlotIdx;
    } else {
        const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
        let autoIdx = 0;
        for (let si = 0; si < slots.length; si++) {
            const ss = timeToMinutes(slots[si].start);
            const se = timeToMinutes(slots[si].expire || slots[si].end);
            if (ss !== null && nowMin >= ss && (se === null || nowMin < se)) { autoIdx = si; break; }
        }
        sel.value = autoIdx;
        selectedSlotIdx = autoIdx;
    }
    updatePeLockRisk();
}

window.onPeSlotChange = function() {
    const sel = document.getElementById('peSlotSel');
    selectedSlotIdx = sel ? parseInt(sel.value) : null;
    renderPeTimerSlider(); // re-highlight selected card
    updatePeLockRisk();
    calcQty(); // recalculate qty with new risk
};

function updatePeLockRisk() {
    const node = clusters[selectedClusterId]?.nodes[selectedNodeIdx];
    if (!node) return;
    const dayName = ['SUN','MON','TUE','WED','THU','FRI','SAT'][new Date().getDay()];
    const slots   = getDaySlots(node, dayName);
    const slot    = (selectedSlotIdx !== null && slots[selectedSlotIdx]) ? slots[selectedSlotIdx] : (slots[0] || {});
    const riskPct = slot.risk || 0.35;

    // Get live balance from localStorage stats cache or node balance
    const statsKey = `isi_stats_${selectedClusterId}_${selectedNodeIdx}`;
    let liveBal = node.balance || 0;
    try {
        const cached = JSON.parse(localStorage.getItem(statsKey) || 'null');
        if (cached?.currentBal) liveBal = cached.currentBal;
    } catch(e) {}

    lockRiskAmt = liveBal * riskPct / 100;

    const bar    = document.getElementById('peLockRiskBar');
    const pctEl  = document.getElementById('peLockRiskPct');
    const amtEl  = document.getElementById('peLockRiskAmt');
    const balEl  = document.getElementById('peLockBal');
    if (bar) bar.style.display = 'flex';
    if (pctEl) pctEl.textContent = riskPct + '%';
    if (amtEl) amtEl.textContent = (node.curr||'$') + lockRiskAmt.toFixed(2);
    if (balEl) balEl.textContent = (node.curr||'$') + liveBal.toLocaleString('en-US',{minimumFractionDigits:2});

    calcQty(); // auto-recalculate
}

// ── READINESS ──
window.toggleReady = function (el, key) {
    el.classList.toggle('checked');
    peData.readiness[key] = el.classList.contains('checked');
    updateReadinessScore();
    recalcScore();
};

function updateReadinessScore() {
    const total   = Object.keys(peData.readiness).length;
    const checked = Object.values(peData.readiness).filter(Boolean).length;
    const el = document.getElementById('readinessScore');
    const pct = total ? (checked / 6) * 100 : 0;
    const color = pct === 100 ? 'var(--accent)' : pct >= 50 ? 'var(--gold)' : 'var(--danger)';
    el.style.color = color;
    el.style.borderColor = color;
    el.textContent = `Readiness: ${checked}/6 — ${
        pct === 100 ? '✅ FULLY READY TO ANALYZE' :
        pct >= 50   ? '⚡ Partially ready' :
                      '⚠ Not ready — complete items above'
    }`;
}

// ── ANALYSIS TIMER ──
window.startAnalysisTimer = function () {
    if (analysisTimerInt) return;
    if (!analysisStart) {
        analysisStart = new Date();
        document.getElementById('analysisSince').textContent =
            `Analysis started at ${analysisStart.toLocaleTimeString('en-GB', {hour12:false})}`;
    }
    analysisTimerInt = setInterval(() => {
        analysisElapsed++;
        peData.timerSecs = analysisElapsed;
        const m = Math.floor(analysisElapsed / 60);
        const s = analysisElapsed % 60;
        document.getElementById('timerMM').textContent = String(m).padStart(2,'0');
        document.getElementById('timerSS').textContent = String(s).padStart(2,'0');
        const status = document.getElementById('timerStatus');
        if (analysisElapsed >= 900) {         // 15+ min = excellent
            status.textContent = '✅ 15+ MIN — READY';
            status.style.color = 'var(--accent)';
        } else if (analysisElapsed >= 300) {  // 5-15 min = good
            status.textContent = '⚡ ANALYZING...';
            status.style.color = 'var(--gold)';
        } else {
            status.textContent = '🔄 ANALYZING...';
            status.style.color = '#888';
        }
        recalcScore();
    }, 1000);
};

window.resetAnalysisTimer = function () {
    clearInterval(analysisTimerInt);
    analysisTimerInt = null;
    analysisElapsed  = 0;
    analysisStart    = null;
    peData.timerSecs = 0;
    document.getElementById('timerMM').textContent = '00';
    document.getElementById('timerSS').textContent = '00';
    document.getElementById('timerStatus').textContent = '⏸ NOT STARTED';
    document.getElementById('timerStatus').style.color = '#888';
    document.getElementById('analysisSince').textContent = 'Chart analysis not yet started for this session';
    recalcScore();
};

// ── STRUCTURE BUTTONS ──
window.setStruct = function (btn) {
    const tf  = btn.dataset.tf;   // htf / ltf
    const key = btn.dataset.key;  // ms / zone / candle
    const val = btn.dataset.val;
    const typ = btn.dataset.type; // bull / bear / neut

    // Deselect siblings with same tf+key
    document.querySelectorAll(`.struct-btn[data-tf="${tf}"][data-key="${key}"]`).forEach(b => {
        b.classList.remove('active-bull','active-bear','active-neut');
    });
    btn.classList.add(`active-${typ}`);

    if (!peData[tf]) peData[tf] = {};
    peData[tf][key] = val;

    checkConflict();
    updateBiasResult();
    recalcScore();
};

// ── SMM TOGGLE ──
window.toggleSmm = function (btn) {
    const key = btn.dataset.key;
    btn.classList.toggle('sel');
    peData.smm[key] = btn.classList.contains('sel');
    recalcScore();
};

// ── MARKET STATE ──
window.setMarketState = function (btn) {
    document.querySelectorAll('.mstate-btn').forEach(b => {
        b.classList.remove('sel-bull','sel-bear','sel-neut');
    });
    btn.classList.add(btn.dataset.cls);
    peData.mstate = btn.dataset.val;
    recalcScore();
};

// ── VOLATILITY ──
window.setVolatility = function (btn) {
    document.querySelectorAll('[data-key="vol"]').forEach(b => {
        b.classList.remove('active-bull','active-bear','active-neut');
    });
    btn.classList.add('active-neut');
    peData.volatility = btn.dataset.val;
    recalcScore();
};

// ── RR CALCULATOR ──
window.calcRR = function () {
    const entry  = parseFloat(document.getElementById('peEntryZone').value);
    const sl     = parseFloat(document.getElementById('peStopZone').value);
    const target = parseFloat(document.getElementById('peTargetZone').value);
    if (!entry || !sl || !target) { document.getElementById('peRR').textContent = '—'; return; }

    const risk   = Math.abs(entry - sl);
    const reward = Math.abs(target - entry);
    if (risk === 0) { document.getElementById('peRR').textContent = '—'; return; }

    const rr = (reward / risk).toFixed(2);
    peData.rrPlanned = rr;
    const color = rr >= 3 ? 'var(--accent)' : rr >= 2 ? 'var(--gold)' : 'var(--danger)';
    document.getElementById('peRR').style.color = color;
    document.getElementById('peRR').textContent = `1 : ${rr}`;
    recalcScore();
    calcQty(); // auto quantity when entry + SL change
};

// ── AUTO QUANTITY CALCULATOR ──
window.calcQty = function() {
    const entry   = parseFloat(document.getElementById('peEntryZone').value);
    const sl      = parseFloat(document.getElementById('peStopZone').value);
    const wrap    = document.getElementById('peQtyCalcWrap');
    const qtyEl   = document.getElementById('peLockQty');
    const distEl  = document.getElementById('peCalcSLDist');
    const amtEl   = document.getElementById('peCalcRiskAmt');
    const pctEl   = document.getElementById('peCalcRiskPct');
    const lblEl   = document.getElementById('peLockQtyLabel');

    if (!wrap) return;

    const node    = clusters[selectedClusterId]?.nodes[selectedNodeIdx];
    if (!node || !selectedClusterId || selectedNodeIdx === null) { wrap.style.display = 'none'; return; }

    const dayName = ['SUN','MON','TUE','WED','THU','FRI','SAT'][new Date().getDay()];
    const slots   = getDaySlots(node, dayName);
    const slot    = (selectedSlotIdx !== null && slots[selectedSlotIdx]) ? slots[selectedSlotIdx] : (slots[0] || {});
    const riskPct = slot.risk || 0.35;

    // Live balance
    let liveBal = node.balance || 0;
    try {
        const cached = JSON.parse(localStorage.getItem(`isi_stats_${selectedClusterId}_${selectedNodeIdx}`) || 'null');
        if (cached?.currentBal) liveBal = cached.currentBal;
    } catch(e) {}

    const rAmt = liveBal * riskPct / 100;
    lockRiskAmt = rAmt;

    // Update risk display fields
    if (amtEl) amtEl.textContent = (node.curr||'$') + rAmt.toFixed(2);
    if (pctEl) pctEl.textContent = riskPct + '%';

    wrap.style.display = '';

    if (!entry || !sl || isNaN(entry) || isNaN(sl)) {
        if (distEl) distEl.textContent = '—';
        if (qtyEl)  qtyEl.textContent  = '—';
        if (lblEl)  lblEl.textContent  = 'Enter entry + SL to calculate';
        lockQty = null;
        return;
    }

    // ── SIMPLE FORMULA: Qty = Risk Amount ÷ |Entry - SL| ──
    const slDist = Math.abs(entry - sl);
    if (distEl) distEl.textContent = slDist.toFixed(5);

    const qty = rAmt / slDist;
    lockQty = qty;

    if (qtyEl) qtyEl.textContent = qty.toFixed(4);
    if (lblEl) lblEl.textContent = `${(node.curr||'$')}${rAmt.toFixed(2)} ÷ ${slDist.toFixed(5)} = ${qty.toFixed(4)} units`;
};

// ── CONFLICT DETECTION ──
function checkConflict() {
    const htfMs  = peData.htf?.ms  || '';
    const ltfMs  = peData.ltf?.ms  || '';
    const htfZn  = peData.htf?.zone || '';
    const ltfCn  = peData.ltf?.candle || '';

    const htfBull = htfMs.includes('BULL') || htfMs === 'TREND_BULL';
    const htfBear = htfMs.includes('BEAR');
    const ltfBull = ltfMs.includes('BULL') || ltfCn === 'REJECTION' || ltfCn === 'MITIGATION';
    const ltfBear = ltfMs.includes('BEAR');

    const premiumZone = htfZn === 'PREMIUM' || htfZn === 'SUPPLY';
    const discountZone = htfZn === 'DISCOUNT' || htfZn === 'DEMAND';

    let conflict = false;
    let conflictMsg = '';

    if (htfBull && ltfBear) {
        conflict = true;
        conflictMsg = `HTF shows BULLISH structure (${htfMs}) but LTF shows BEARISH (${ltfMs}). ` +
            `Institutional bias is LONG — LTF shorting is counter-trend. ` +
            `Wait for LTF to confirm bullish before entry.`;
    } else if (htfBear && ltfBull) {
        conflict = true;
        conflictMsg = `HTF shows BEARISH structure (${htfMs}) but LTF shows BULLISH (${ltfMs}). ` +
            `Institutional bias is SHORT — LTF buying is counter-trend. ` +
            `Wait for LTF to confirm bearish before entry.`;
    } else if (discountZone && ltfBear && htfBull) {
        conflict = true;
        conflictMsg = `Price is in HTF DISCOUNT/DEMAND zone (institutional buy area) but LTF is bearish. ` +
            `This may be final liquidity sweep before reversal — wait for LTF CHoCH or BOS.`;
    } else if (premiumZone && ltfBull && htfBear) {
        conflict = true;
        conflictMsg = `Price is in HTF PREMIUM/SUPPLY zone (institutional sell area) but LTF is bullish. ` +
            `This may be final push (stop hunt) before reversal — wait for LTF BOS bearish.`;
    }

    const alertEl = document.getElementById('conflictAlert');
    const warnEl  = document.getElementById('sessionWarning');
    if (conflict) {
        alertEl.classList.add('vis');
        document.getElementById('conflictDetail').textContent = conflictMsg;
        warnEl.style.display = 'block';
    } else {
        alertEl.classList.remove('vis');
        warnEl.style.display = 'none';
    }

    peData.conflict = conflict ? conflictMsg : '';
    return conflict;
}

// ── BIAS RESULT ──
function updateBiasResult() {
    const htfMs  = peData.htf?.ms  || '';
    const ltfMs  = peData.ltf?.ms  || '';
    const htfZn  = peData.htf?.zone || '';
    const ltfCn  = peData.ltf?.candle || '';
    const el     = document.getElementById('biasResult');

    const htfBull = htfMs.includes('BULL') || htfMs === 'TREND_BULL';
    const htfBear = htfMs.includes('BEAR');
    const ltfBull = ltfMs.includes('BULL') || ['MITIGATION','REJECTION','ENGULF','PINBAR','IMPULSE'].includes(ltfCn);
    const ltfBear = ltfMs.includes('BEAR');
    const discZone = htfZn === 'DISCOUNT' || htfZn === 'DEMAND';
    const premZone = htfZn === 'PREMIUM'  || htfZn === 'SUPPLY';

    let bias = '', bg = '', color = '';

    if (htfBull && ltfBull && discZone) {
        bias = '🟢 STRONG INSTITUTIONAL LONG BIAS — HTF + LTF + ZONE ALIGNED ▲';
        bg = '#001a00'; color = 'var(--accent)';
    } else if (htfBear && ltfBear && premZone) {
        bias = '🔴 STRONG INSTITUTIONAL SHORT BIAS — HTF + LTF + ZONE ALIGNED ▼';
        bg = '#1a0000'; color = 'var(--danger)';
    } else if (htfBull && ltfBull) {
        bias = '🟡 BULLISH BIAS — HTF + LTF ALIGNED ▲ (Zone not confirmed)';
        bg = '#0d0900'; color = 'var(--gold)';
    } else if (htfBear && ltfBear) {
        bias = '🟡 BEARISH BIAS — HTF + LTF ALIGNED ▼ (Zone not confirmed)';
        bg = '#0d0900'; color = 'var(--gold)';
    } else if (htfBull && discZone) {
        bias = '🔵 BULLISH SETUP — In Discount/Demand, LTF confirmation needed';
        bg = '#000d1a'; color = '#4a9eff';
    } else if (htfBear && premZone) {
        bias = '🔵 BEARISH SETUP — In Premium/Supply, LTF confirmation needed';
        bg = '#000d1a'; color = '#4a9eff';
    } else if (htfMs || ltfMs) {
        bias = '⚪ PARTIAL DATA — Complete both HTF and LTF analysis for full bias';
        bg = '#0a0a0a'; color = '#888';
    } else {
        bias = 'Select HTF + LTF structure to generate institutional bias';
        bg = '#0a0a0a'; color = '#555';
    }

    el.style.background = bg;
    el.style.color = color;
    el.style.borderColor = color || '#222';
    el.textContent = bias;
    peData.biasResult = bias;
}

// ── INSTITUTIONAL SCORE ──
function recalcScore() {
    let score = 0;
    const breakdown = [];

    // Readiness (max 15)
    const readinessCount = Object.values(peData.readiness).filter(Boolean).length;
    const rScore = Math.round((readinessCount / 6) * 15);
    score += rScore;
    breakdown.push({ label: 'Trader Readiness', score: rScore, max: 15,
        color: rScore >= 12 ? 'var(--accent)' : rScore >= 8 ? 'var(--gold)' : 'var(--danger)' });

    // Analysis time (max 20)
    let tScore = 0;
    if (analysisElapsed >= 900)      tScore = 20; // 15+ min
    else if (analysisElapsed >= 600) tScore = 16; // 10-15 min
    else if (analysisElapsed >= 300) tScore = 12; // 5-10 min
    else if (analysisElapsed >= 120) tScore = 7;  // 2-5 min
    else if (analysisElapsed >= 60)  tScore = 3;  // 1-2 min
    score += tScore;
    breakdown.push({ label: 'Analysis Time', score: tScore, max: 20,
        color: tScore >= 16 ? 'var(--accent)' : tScore >= 10 ? 'var(--gold)' : 'var(--danger)' });

    // HTF + LTF alignment (max 25)
    const htfMs = peData.htf?.ms || '';
    const ltfMs = peData.ltf?.ms || '';
    const htfZn = peData.htf?.zone || '';
    const ltfCn = peData.ltf?.candle || '';
    const htfBull = htfMs.includes('BULL') || htfMs === 'TREND_BULL';
    const htfBear = htfMs.includes('BEAR');
    const ltfBull = ltfMs.includes('BULL') || ['MITIGATION','REJECTION','ENGULF','PINBAR','IMPULSE'].includes(ltfCn);
    const ltfBear = ltfMs.includes('BEAR');
    const zoneAligned = (htfBull && (htfZn==='DISCOUNT'||htfZn==='DEMAND')) ||
                        (htfBear && (htfZn==='PREMIUM'||htfZn==='SUPPLY'));
    const conflict = checkConflict();

    let bScore = 0;
    if (htfMs && ltfMs && !conflict)           bScore += 15;
    else if (htfMs && ltfMs && conflict)       bScore += 5;
    else if (htfMs || ltfMs)                   bScore += 7;
    if (htfZn)                                  bScore += 5;
    if (ltfCn && ltfCn !== 'NO_SIGNAL')         bScore += 5;
    bScore = Math.min(bScore, 25);
    score += bScore;
    breakdown.push({ label: 'HTF/LTF Alignment', score: bScore, max: 25,
        color: bScore >= 20 ? 'var(--accent)' : bScore >= 13 ? 'var(--gold)' : 'var(--danger)' });

    // Smart money concepts (max 15)
    const smmCount = Object.values(peData.smm).filter(Boolean).length;
    const sScore = Math.min(smmCount * 3, 15);
    score += sScore;
    breakdown.push({ label: 'SMC Confluence', score: sScore, max: 15,
        color: sScore >= 12 ? 'var(--accent)' : sScore >= 6 ? 'var(--gold)' : '#555' });

    // Market state + volatility (max 10)
    let mScore = 0;
    if (peData.mstate)    mScore += 5;
    if (peData.volatility) mScore += 5;
    score += mScore;
    breakdown.push({ label: 'Market Context', score: mScore, max: 10,
        color: mScore >= 8 ? 'var(--accent)' : mScore >= 5 ? 'var(--gold)' : '#555' });

    // Trade plan (max 15)
    let pScore = 0;
    const dir = document.getElementById('peDirection')?.value;
    if (dir && dir !== '')                       pScore += 5;
    if (document.getElementById('peEntryZone')?.value)  pScore += 2;
    if (document.getElementById('peStopZone')?.value)   pScore += 2;
    if (document.getElementById('peTargetZone')?.value) pScore += 2;
    if (peData.rrPlanned && parseFloat(peData.rrPlanned) >= 2) pScore += 4;
    score += pScore;
    breakdown.push({ label: 'Trade Plan', score: pScore, max: 15,
        color: pScore >= 12 ? 'var(--accent)' : pScore >= 7 ? 'var(--gold)' : '#555' });

    score = Math.min(score, 100);

    // Update ring
    const circumference = 201;
    const offset = circumference - (score / 100) * circumference;
    const ring = document.getElementById('scoreRingCircle');
    const ringColor = score >= 75 ? 'var(--accent)' : score >= 50 ? 'var(--gold)' : score >= 30 ? '#ff6600' : 'var(--danger)';
    ring.style.strokeDashoffset = offset;
    ring.style.stroke = ringColor;

    document.getElementById('iScoreNum').textContent = score;
    document.getElementById('iScoreNum').style.color = ringColor;

    // Breakdown lines
    document.getElementById('scoreLines').innerHTML = breakdown.map(b => `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <span style="color:#666;font-size:0.65rem;">${b.label}</span>
            <span style="color:${b.color};font-weight:bold;font-size:0.7rem;font-family:monospace;">${b.score}/${b.max}</span>
        </div>
        <div class="sd-bar"><div class="sd-fill" style="width:${(b.score/b.max)*100}%;background:${b.color};"></div></div>
    `).join('');

    // Proceed button
    const btn = document.getElementById('proceedBtn');
    if (conflict) {
        btn.className = 'conflict';
        btn.textContent = `⚠ CONFLICT DETECTED — Score: ${score}/100 — Proceed with caution`;
    } else if (score >= 60 && analysisElapsed >= 300) {
        btn.className = 'ready';
        btn.textContent = `✅ ANALYSIS COMPLETE — Score: ${score}/100 — PROCEED TO TERMINAL`;
    } else if (score >= 40) {
        btn.className = 'locked';
        btn.textContent = `⏳ SCORE: ${score}/100 — Need 60+ and 5 min analysis to proceed`;
    } else {
        btn.className = 'locked';
        btn.textContent = `⏳ COMPLETE ANALYSIS — Current Score: ${score}/100`;
    }

    peData._score = score;
    peData._conflict = conflict;
};

// ── PROCEED / SAVE ──
window.proceedToTerminal = async function () {
    const score  = peData._score || 0;
    const elapsed = analysisElapsed;

    if (elapsed < 300 && score < 75) {
        const confirm_ = confirm(
            `Analysis time is only ${Math.floor(elapsed/60)}m ${elapsed%60}s and score is ${score}/100.\n\n` +
            `Institutional standard requires minimum 5 minutes chart analysis.\n\n` +
            `Proceed anyway? (Not recommended)`
        );
        if (!confirm_) return;
    }

    // Save pre-entry record to Firebase
    if (selectedClusterId !== null && selectedNodeIdx !== null) {
        const record = {
            date:        new Date().toISOString().slice(0,10),
            savedAt:     new Date().toISOString(),
            clusterId:   selectedClusterId,
            nodeIdx:     selectedNodeIdx,
            slotIdx:     selectedSlotIdx,
            score:       score,
            timerSecs:   elapsed,
            readiness:   { ...peData.readiness },
            htf:         { ...peData.htf },
            ltf:         { ...peData.ltf },
            smm:         Object.keys(peData.smm).filter(k => peData.smm[k]),
            mstate:      peData.mstate,
            volatility:  peData.volatility,
            biasResult:  peData.biasResult || '',
            conflict:    peData.conflict   || '',
            asset:       document.getElementById('peAsset').value,
            direction:   document.getElementById('peDirection').value,
            entryZone:   document.getElementById('peEntryZone').value,
            stopZone:    document.getElementById('peStopZone').value,
            targetZone:  document.getElementById('peTargetZone').value,
            rrPlanned:   peData.rrPlanned || '',
            note:        document.getElementById('peNote').value,
            lockRiskAmt: lockRiskAmt || 0,
            lockQty:     lockQty    || null,
        };

        try {
            await push(ref(db, `isi_v6/preentry/${selectedClusterId}/${selectedNodeIdx}`), record);
            // Store in localStorage so terminal can read it
            localStorage.setItem('isi_last_preentry', JSON.stringify(record));
        } catch(e) {
            console.warn('Pre-entry save error:', e);
        }
    }

    // Stop timer
    clearInterval(analysisTimerInt);
    location.href = 'index.html';
};

window.goToTerminal = function () {
    if (!confirm('Go to terminal without saving pre-entry analysis?')) return;
    location.href = 'index.html';
};

// ── LOAD TODAY'S HISTORY ──
function loadTodayHistory() {
    if (!selectedClusterId || selectedNodeIdx === null) return;
    const today = new Date().toISOString().slice(0,10);

    get(ref(db, `isi_v6/preentry/${selectedClusterId}/${selectedNodeIdx}`)).then(snap => {
        const data = snap.val();
        const list = document.getElementById('peHistoryList');
        if (!data) {
            list.innerHTML = '<div style="color:#444;font-size:0.78rem;padding:14px;text-align:center;">No pre-entry sessions today.</div>';
            return;
        }

        const todayItems = Object.values(data)
            .filter(r => r.date === today)
            .sort((a,b) => (b.savedAt||'').localeCompare(a.savedAt||''));

        if (!todayItems.length) {
            list.innerHTML = '<div style="color:#444;font-size:0.78rem;padding:14px;text-align:center;">No pre-entry sessions today.</div>';
            return;
        }

        list.innerHTML = todayItems.map(r => {
            const mins = Math.floor((r.timerSecs||0)/60);
            const secs = (r.timerSecs||0) % 60;
            const hasConflict = !!r.conflict;
            const cls = hasConflict ? 'conflict' : r.score >= 60 ? 'went-live' : 'skipped';
            const time = new Date(r.savedAt).toLocaleTimeString('en-GB',{hour12:false,hour:'2-digit',minute:'2-digit'});
            return `
            <div class="pe-history-item ${cls}">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <div>
                        <span style="color:var(--gold);font-weight:bold;font-size:0.82rem;">${time}</span>
                        <span style="color:#555;font-size:0.65rem;margin-left:8px;">${r.asset || '—'} | ${r.direction || '—'}</span>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-family:monospace;font-weight:bold;color:${r.score>=75?'var(--accent)':r.score>=50?'var(--gold)':'var(--danger)'};">${r.score}/100</div>
                        <div style="font-size:0.58rem;color:#555;">${mins}m ${secs}s analysis</div>
                    </div>
                </div>
                <div style="font-size:0.65rem;color:#666;margin-top:5px;">${r.biasResult||'—'}</div>
                ${r.conflict ? `<div style="font-size:0.62rem;color:#ff6600;margin-top:4px;">⚠ ${r.conflict.slice(0,80)}...</div>` : ''}
                ${r.note ? `<div style="font-size:0.63rem;color:#555;margin-top:4px;font-style:italic;">"${r.note.slice(0,100)}${r.note.length>100?'...':''}"</div>` : ''}
            </div>`;
        }).join('');
    });
}

// Set today's date
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.ready-item').forEach(el => el.classList.remove('checked'));
    updateReadinessScore();
    recalcScore();
});

// ── AI VALIDATE SETUP ──
window.aiValidateSetupNow = async function () {
    showAILoading('aiValidateBox');
    const result = await aiValidateSetup({
        ...peData,
        direction: document.getElementById('peDirection')?.value,
        _score: peData._score
    });
    renderAIResponse('aiValidateBox', result, '🤖 AI Setup Validation');
};

// ── AI MARKET CONTEXT ──
window.aiMarketContextNow = async function () {
    showAILoading('aiMarketBox');
    const smcActive = Object.keys(peData.smm || {}).filter(k => peData.smm[k]).join(', ') || 'None';
    const result = await aiMarketContext(
        peData.htf?.ms, peData.ltf?.ms, peData.htf?.zone,
        peData.mstate, peData.volatility, smcActive
    );
    renderAIResponse('aiMarketBox', result, '🤖 AI Market Context');
};
