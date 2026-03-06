import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, set, update, onValue, remove, get, push as _fbPush } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getStorage, ref as sRef, uploadBytesResumable, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

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
const db      = getDatabase(app);
const storage = getStorage(app);

const days = ['MON','TUE','WED','THU','FRI'];
let editingClusterId = null;

// Stats path — dedicated lightweight path, no images here
// Always use String(nIdx) — Firebase object keys are strings
const statsPath = (cId, nIdx) => `isi_v6/stats/${cId}/${String(nIdx)}`;

// Helper: get live stats for a node (new path first, fallback to old nodes path)
async function getLiveStats(cId, nIdx, fallbackBalance) {
    try {
        const snap = await get(ref(db, statsPath(cId, nIdx)));
        if (snap.val()) return snap.val();
        // Try old location for migration
        const oldSnap = await get(ref(db, `isi_v6/clusters/${cId}/nodes/${nIdx}/stats`));
        if (oldSnap.val()) {
            // Migrate: write to new path
            await set(ref(db, statsPath(cId, nIdx)), oldSnap.val());
            return oldSnap.val();
        }
    } catch(e) {}
    return { currentBal: fallbackBalance || 0, trades: 0, wins: 0, winRate: 0, net: 0 };
}

// ─────────────────────────────────────────────────────────
// HELPER — format balance with correct currency symbol
// ─────────────────────────────────────────────────────────
function fmtBal(curr, val) {
    return `${curr}${Number(val||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
}

// ─────────────────────────────────────────────────────────
// USD/INR LIVE RATE + CONVERSION HELPER
// ─────────────────────────────────────────────────────────
let _usdInrRate   = null;   // cached rate
let _rateTs       = 0;      // last fetch timestamp

async function getUsdInrRate() {
    const now = Date.now();
    if (_usdInrRate && (now - _rateTs) < 10 * 60 * 1000) return _usdInrRate; // 10-min cache
    try {
        const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
        const j = await r.json();
        _usdInrRate = j.rates?.INR || 84;
        _rateTs = now;
    } catch(e) {
        _usdInrRate = _usdInrRate || 84; // fallback ~84
    }
    return _usdInrRate;
}

// Convert a value in `curr` to USD
async function toUSD(val, curr) {
    if (curr === '$') return val;
    const rate = await getUsdInrRate();
    return val / rate;
}

// Convert a mixed {curr: amount} object → total USD
async function mixedToUSD(byCurr) {
    const rate = await getUsdInrRate();
    let total = 0;
    for (const [c, v] of Object.entries(byCurr)) {
        total += (c === '$') ? v : v / rate;
    }
    return total;
}

// ─────────────────────────────────────────────────────────
// BUILD NODE UI
// ─────────────────────────────────────────────────────────
window.buildNodeUI = function(existingNodes = null) {
    const sel  = document.getElementById('nodeQty');
    const wrap = document.getElementById('customNodeWrap');
    if (sel.value === 'custom') {
        if (wrap) wrap.style.display = 'flex';
        document.getElementById('nodeGrid').innerHTML = '';
        return;
    }
    if (wrap) wrap.style.display = 'none';
    const qty  = parseInt(sel.value);
    const grid = document.getElementById('nodeGrid');
    grid.innerHTML = '';
    if (qty === 0 || isNaN(qty)) return;

    for (let i = 0; i < qty; i++) {
        const ex      = existingNodes ? (existingNodes[i] || {}) : {};
        const exTimes = ex.times || {};
        let dayHtml   = '';

        days.forEach(day => {
            // Support both old format {start,end,expire} and new array format [{start,end,expire,risk}]
            const rawT = exTimes[day];
            let slots = [];
            if (Array.isArray(rawT)) {
                slots = rawT;
            } else if (rawT && rawT.start) {
                slots = [{ start: rawT.start, end: rawT.end || '', expire: rawT.expire || '', risk: ex.risk ?? 0.35 }];
            } else {
                slots = [{ start: '', end: '', expire: '', risk: ex.risk ?? 0.35 }];
            }

            const slotsHtml = slots.map((s, si) => `
                <div class="time-slot" data-day="${day}" data-node="${i}" data-slot="${si}" style="display:grid;grid-template-columns:1fr 1fr 1fr 60px 22px;gap:3px;margin-bottom:3px;align-items:center;">
                    <input type="time" class="slot-start"  value="${s.start||''}" >
                    <input type="time" class="slot-end"    value="${s.end||''}"   >
                    <input type="time" class="slot-expire" value="${s.expire||''}" >
                    <input type="number" class="slot-risk" value="${s.risk ?? ex.risk ?? 0.35}" step="0.01" min="0.01" max="10" title="Risk % for this slot" style="width:100%;padding:4px;background:#000;border:1px solid #444;color:#fff;font-size:0.65rem;border-radius:3px;" placeholder="R%">
                    <button type="button" onclick="removeSlot(this)" style="background:#3a0000;color:#ff5252;border:1px solid #ff5252;border-radius:3px;cursor:pointer;font-size:0.7rem;width:22px;height:22px;padding:0;" title="Remove">✕</button>
                </div>`).join('');

            dayHtml += `
            <div class="day-card" style="padding-bottom:6px;">
                <div class="day-name" style="display:flex;justify-content:space-between;align-items:center;">
                    <span>${day}</span>
                    <button type="button" onclick="addSlot(this,'${day}',${i})"
                        style="background:transparent;color:var(--gold);border:1px dashed var(--gold);border-radius:3px;font-size:0.55rem;padding:1px 5px;cursor:pointer;" title="Add slot">+ slot</button>
                </div>
                <div style="font-size:0.55rem;color:#444;display:grid;grid-template-columns:1fr 1fr 1fr 60px 22px;gap:3px;margin:4px 0 3px;">
                    <span>Start</span><span>End</span><span>Expire</span><span>Risk%</span><span></span>
                </div>
                <div class="slots-container" data-day="${day}" data-node="${i}">
                    ${slotsHtml}
                </div>
            </div>`;
        });

        grid.innerHTML += `
        <div class="node-setup-card">
            <div class="input-row">
                <input type="text"   class="node-title"   placeholder="Account Name" value="${ex.title || 'Account ' + (i + 1)}">
                <select class="node-curr">
                    <option value="$" ${(ex.curr || '$') === '$' ? 'selected' : ''}>$ USD</option>
                    <option value="₹" ${(ex.curr || '') === '₹' ? 'selected' : ''}>₹ INR</option>
                </select>
                <input type="number" class="node-balance" placeholder="Setup Balance" value="${ex.balance ?? 100000}" title="Initial Capital">
            </div>
            <div class="days-grid">${dayHtml}</div>
            <div class="risk-qty-row">
                <div style="display:flex;gap:10px;align-items:center;">
                    <label>Default Risk%</label>
                    <input type="number" class="node-risk" value="${ex.risk ?? 0.35}" step="0.01" style="width:60px;">
                </div>
                <div class="qty-range">
                    <label>Qty</label>
                    <input type="number" class="qty-from" value="${ex.qtyFrom ?? 1}"  style="width:45px;">
                    <span>-</span>
                    <input type="number" class="qty-to"   value="${ex.qtyTo   ?? 10}" style="width:45px;">
                </div>
                <div>
                    <label>Trade #</label>
                    <input type="number" class="node-order" value="${ex.order ?? (i + 1)}" style="width:45px;">
                </div>
            </div>
        </div>`;
    }
};

// ─────────────────────────────────────────────────────────
// CUSTOM NODE COUNT APPLY
// ─────────────────────────────────────────────────────────
window.applyCustomNodes = function() {
    const countEl = document.getElementById('customNodeCount');
    const count   = parseInt(countEl ? countEl.value : 0);
    if (!count || count < 1 || count > 20) { alert('1 se 20 ke beech count daalo!'); return; }
    const wrap = document.getElementById('customNodeWrap');
    if (wrap) wrap.style.display = 'none';
    // Build grid manually with custom count
    const grid = document.getElementById('nodeGrid');
    grid.innerHTML = '';
    // Temporarily override nodeQty value so buildNodeUI loop uses it
    const sel = document.getElementById('nodeQty');
    const origVal = sel.value;
    // We manually build using the same template logic as buildNodeUI
    // Reuse buildNodeUI by faking qty via data attribute
    sel.dataset.customCount = count;
    // Call a minimal inline build
    for (let i = 0; i < count; i++) {
        let dayHtml = '';
        ['MON','TUE','WED','THU','FRI'].forEach(day => {
            dayHtml += `
            <div class="day-card" style="padding-bottom:6px;">
                <div class="day-name" style="display:flex;justify-content:space-between;align-items:center;">
                    <span>${day}</span>
                    <button type="button" onclick="addSlot(this,'${day}',${i})"
                        style="background:transparent;color:var(--gold);border:1px dashed var(--gold);border-radius:3px;font-size:0.55rem;padding:1px 5px;cursor:pointer;">+ slot</button>
                </div>
                <div style="font-size:0.55rem;color:#444;display:grid;grid-template-columns:1fr 1fr 1fr 60px 22px;gap:3px;margin:4px 0 3px;">
                    <span>Start</span><span>End</span><span>Expire</span><span>Risk%</span><span></span>
                </div>
                <div class="slots-container" data-day="${day}" data-node="${i}">
                    <div class="time-slot" data-day="${day}" data-node="${i}" data-slot="0" style="display:grid;grid-template-columns:1fr 1fr 1fr 60px 22px;gap:3px;margin-bottom:3px;align-items:center;">
                        <input type="time" class="slot-start" value="">
                        <input type="time" class="slot-end"   value="">
                        <input type="time" class="slot-expire" value="">
                        <input type="number" class="slot-risk" value="0.35" step="0.01" min="0.01" max="10" style="width:100%;padding:4px;background:#000;border:1px solid #444;color:#fff;font-size:0.65rem;border-radius:3px;" placeholder="R%">
                        <button type="button" onclick="removeSlot(this)" style="background:#3a0000;color:#ff5252;border:1px solid #ff5252;border-radius:3px;cursor:pointer;font-size:0.7rem;width:22px;height:22px;padding:0;">✕</button>
                    </div>
                </div>
            </div>`;
        });
        grid.innerHTML += `
        <div class="node-setup-card">
            <div class="input-row">
                <input type="text"   class="node-title"   placeholder="Account Name" value="Account ${i+1}">
                <select class="node-curr">
                    <option value="$" selected>$ USD</option>
                    <option value="₹">₹ INR</option>
                </select>
                <input type="number" class="node-balance" placeholder="Setup Balance" value="100000">
            </div>
            <div class="days-grid">${dayHtml}</div>
            <div class="risk-qty-row">
                <div style="display:flex;gap:10px;align-items:center;">
                    <label>Default Risk%</label>
                    <input type="number" class="node-risk" value="0.35" step="0.01" style="width:60px;">
                </div>
                <div class="qty-range">
                    <label>Qty</label>
                    <input type="number" class="qty-from" value="1"  style="width:45px;">
                    <span>-</span>
                    <input type="number" class="qty-to"   value="10" style="width:45px;">
                </div>
                <div>
                    <label>Trade #</label>
                    <input type="number" class="node-order" value="${i+1}" style="width:45px;">
                </div>
            </div>
        </div>`;
    }
};

// ─────────────────────────────────────────────────────────
// ADD / REMOVE SLOT HELPERS
// ─────────────────────────────────────────────────────────
window.addSlot = function(btn, day, nodeIdx) {
    const container = btn.closest('.day-card').querySelector('.slots-container');
    const slotIdx = container.querySelectorAll('.time-slot').length;
    const defaultRisk = container.closest('.node-setup-card').querySelector('.node-risk')?.value || '0.35';
    const div = document.createElement('div');
    div.className = 'time-slot';
    div.dataset.day  = day;
    div.dataset.node = nodeIdx;
    div.dataset.slot = slotIdx;
    div.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr 60px 22px;gap:3px;margin-bottom:3px;align-items:center;';
    div.innerHTML = `
        <input type="time" class="slot-start"  value="" placeholder="Start">
        <input type="time" class="slot-end"    value="" placeholder="End">
        <input type="time" class="slot-expire" value="" placeholder="Expire">
        <input type="number" class="slot-risk" value="${defaultRisk}" step="0.01" min="0.01" max="10" title="Risk % for this slot" style="width:100%;padding:4px;background:#000;border:1px solid #444;color:#fff;font-size:0.65rem;border-radius:3px;" placeholder="Risk%">
        <button type="button" onclick="removeSlot(this)" style="background:#3a0000;color:#ff5252;border:1px solid #ff5252;border-radius:3px;cursor:pointer;font-size:0.7rem;width:22px;height:22px;padding:0;flex-shrink:0;" title="Remove slot">✕</button>`;
    container.appendChild(div);
};

window.removeSlot = function(btn) {
    const slot = btn.closest('.time-slot');
    const container = slot.parentElement;
    if (container.querySelectorAll('.time-slot').length <= 1) {
        slot.querySelectorAll('input[type="time"]').forEach(i => i.value = '');
        return;
    }
    slot.remove();
};

function collectDaySlots(card, day, nodeIdx) {
    const container = card.querySelector(`.slots-container[data-day="${day}"][data-node="${nodeIdx}"]`);
    if (!container) return [];
    const slots = [];
    container.querySelectorAll('.time-slot').forEach(slotEl => {
        const start  = slotEl.querySelector('.slot-start')?.value  || '';
        const end    = slotEl.querySelector('.slot-end')?.value    || '';
        const expire = slotEl.querySelector('.slot-expire')?.value || '';
        const risk   = parseFloat(slotEl.querySelector('.slot-risk')?.value) || parseFloat(card.querySelector('.node-risk')?.value) || 0.35;
        if (start || end || expire) slots.push({ start, end, expire, risk });
    });
    return slots;
}

// ─────────────────────────────────────────────────────────
// RESET FORM
// ─────────────────────────────────────────────────────────
function resetForm() {
    editingClusterId = null;
    document.getElementById('deskTitle').value    = '';
    document.getElementById('resetKey').value     = '';
    document.getElementById('nodeQty').value      = '0';
    document.getElementById('nodeGrid').innerHTML = '';
    const btn = document.getElementById('btnDeploy');
    btn.textContent = 'DEPLOY CLUSTER';
    btn.style.cssText = '';
    const cancel = document.getElementById('btnCancelEdit');
    if (cancel) cancel.style.display = 'none';
    const banner = document.getElementById('editModeBanner');
    if (banner) banner.style.display = 'none';
}

// ─────────────────────────────────────────────────────────
// DEPLOY / UPDATE
// EDIT  → update() per field — tradeHistory NEVER touched
// NEW   → set() on fresh path
// ─────────────────────────────────────────────────────────
document.getElementById('btnDeploy').onclick = async () => {
    const title = document.getElementById('deskTitle').value.trim();
    const pass  = document.getElementById('resetKey').value.trim();
    if (!title || !pass) return alert('Cluster Name aur Security Key daalo!');
    const nodeCards = document.querySelectorAll('.node-setup-card');
    if (!nodeCards.length) return alert('Nodes select karo!');

    const btn = document.getElementById('btnDeploy');
    btn.textContent = editingClusterId ? 'UPDATING...' : 'DEPLOYING...';

    try {
        if (editingClusterId) {
            // ── EDIT: only metadata — NEVER touch tradeHistory / equityPoints ──
            await update(ref(db, `isi_v6/clusters/${editingClusterId}`), { title, resetKey: pass });

            const cards = document.querySelectorAll('.node-setup-card');
            for (let i = 0; i < cards.length; i++) {
                const card      = cards[i];
                const nodeTimes = {};
                days.forEach(day => {
                    const slots1 = collectDaySlots(card, day, i);
                    nodeTimes[day] = slots1.length ? slots1 : [];
                });

                const newSetupBalance = parseFloat(card.querySelector('.node-balance').value);

                // Update only config — NOT stats, NOT tradeHistory, NOT equityPoints
                await update(ref(db, `isi_v6/clusters/${editingClusterId}/nodes/${i}`), {
                    title:   card.querySelector('.node-title').value,
                    curr:    card.querySelector('.node-curr').value,
                    balance: newSetupBalance,   // this is the SETUP balance (reference only)
                    times:   nodeTimes,
                    risk:    parseFloat(card.querySelector('.node-risk').value),
                    qtyFrom: parseInt(card.querySelector('.qty-from').value),
                    qtyTo:   parseInt(card.querySelector('.qty-to').value),
                    order:   parseInt(card.querySelector('.node-order').value),
                });

                // Only reset stats.currentBal if NO trades yet
                const s = await getLiveStats(editingClusterId, i, newSetupBalance);
                if (!s.trades || s.trades === 0) {
                    // No trades — safe to reset balance
                    await set(ref(db, statsPath(editingClusterId, i)), {
                        currentBal: newSetupBalance,
                        trades: 0, wins: 0, winRate: 0, net: 0
                    });
                }
                // If trades exist — stats path stays as-is (trading logic owns it)
            }
            alert('✅ Cluster updated! Trade history safe hai.');
            resetForm();

        } else {
            // ── NEW CLUSTER ──
            const clusterId = title.toLowerCase().replace(/\s+/g,'_');
            const cluster   = { title, resetKey: pass, nodes: [] };
            document.querySelectorAll('.node-setup-card').forEach((card, i) => {
                const nodeTimes = {};
                days.forEach(day => {
                    const slots2 = collectDaySlots(card, day, i);
                    nodeTimes[day] = slots2.length ? slots2 : [];
                });
                const b = parseFloat(card.querySelector('.node-balance').value);
                cluster.nodes.push({
                    title:   card.querySelector('.node-title').value,
                    curr:    card.querySelector('.node-curr').value,
                    balance: b,
                    times:   nodeTimes,
                    risk:    parseFloat(card.querySelector('.node-risk').value),
                    qtyFrom: parseInt(card.querySelector('.qty-from').value),
                    qtyTo:   parseInt(card.querySelector('.qty-to').value),
                    order:   parseInt(card.querySelector('.node-order').value),
                });
            });
            await set(ref(db, `isi_v6/clusters/${clusterId}`), cluster);
            // Write initial stats to dedicated path
            for (let i = 0; i < cluster.nodes.length; i++) {
                await set(ref(db, statsPath(clusterId, i)), {
                    currentBal: cluster.nodes[i].balance,
                    trades: 0, wins: 0, winRate: 0, net: 0
                });
            }
            alert('✅ Cluster deployed!');
            resetForm();
        }
    } catch (err) {
        alert('Firebase Error: ' + err.message);
    } finally {
        btn.textContent = editingClusterId ? '💾 UPDATE CLUSTER' : 'DEPLOY CLUSTER';
        if (editingClusterId) { btn.style.background='linear-gradient(45deg,#1565c0,#42a5f5)'; btn.style.color='#fff'; }
    }
};

// ─────────────────────────────────────────────────────────
// ACTIVE CLUSTERS LIST
// Fetch live stats per-node via get() so balance is always fresh
// Per-node currency shown individually — no mixed-currency sum
// ─────────────────────────────────────────────────────────
async function renderClusterCard(id, cluster) {
    const nodes = cluster.nodes || [];

    // Fetch live stats from dedicated lightweight path
    const statsArr = await Promise.all(
        nodes.map((n, i) => getLiveStats(id, i, n.balance))
    );

    // Per-currency totals
    const byCurrency = {};
    nodes.forEach((n, i) => {
        const c   = n.curr || '$';
        const bal = statsArr[i].currentBal ?? n.balance ?? 0;
        byCurrency[c] = (byCurrency[c] || 0) + bal;
    });

    // Individual display string
    const aumIndividualStr = Object.entries(byCurrency)
        .map(([c, v]) => fmtBal(c, v))
        .join(' + ');

    // USD-converted total for mixed clusters
    const hasMixed = Object.keys(byCurrency).length > 1;
    const aumUsdTotal = await mixedToUSD(byCurrency);
    const usdRate = await getUsdInrRate();
    const aumStr  = hasMixed
        ? `${aumIndividualStr} <span style="color:#555;font-size:0.6rem;">(≈ $${aumUsdTotal.toFixed(2)} @ ₹${usdRate.toFixed(1)})</span>`
        : aumIndividualStr;

    const totalTrades = statsArr.reduce((s, st) => s + (st.trades || 0), 0);

    const netByCurr = {};
    nodes.forEach((n, i) => {
        const c = n.curr || '$';
        netByCurr[c] = (netByCurr[c] || 0) + (statsArr[i].net || 0);
    });
    const netHasMixed = Object.keys(netByCurr).length > 1;
    const netUsdTotal = await mixedToUSD(netByCurr);
    const netIndividual = Object.entries(netByCurr)
        .map(([c, v]) => `<span style="color:${v>=0?'var(--accent)':'var(--danger)'};">${v>=0?'+':''}${fmtBal(c,v)}</span>`)
        .join(' ');
    const netStr = netHasMixed
        ? `${netIndividual} <span style="color:#555;font-size:0.6rem;">(≈ ${netUsdTotal>=0?'+':''}$${netUsdTotal.toFixed(2)} USD)</span>`
        : netIndividual;

    return `
    <div class="active-card" id="acard_${id}">
        <div style="display:flex;justify-content:space-between;align-items:center;">
            <div>
                <strong style="color:var(--gold);font-size:0.95rem;">${cluster.title}</strong>
                <div style="font-size:0.6rem;color:#555;margin-top:2px;">${nodes.length} nodes · ${totalTrades} trades</div>
            </div>
            <div style="display:flex;gap:6px;">
                <button onclick="editCluster('${id}')"
                    style="background:var(--accent);color:#000;border:none;padding:6px 12px;border-radius:3px;cursor:pointer;font-weight:bold;font-size:0.75rem;">✏ EDIT</button>
                <button onclick="deleteCluster('${id}','${cluster.resetKey}')"
                    style="background:var(--danger);color:#fff;border:none;padding:6px 12px;border-radius:3px;cursor:pointer;font-weight:bold;font-size:0.75rem;">✕ DEL</button>
            </div>
        </div>

        <div class="metrics" style="margin-top:10px;">
            <div><small>Live AUM</small><div class="m-val" style="color:var(--gold);font-size:0.8rem;">${aumStr}</div></div>
            <div><small>Net P&L</small><div class="m-val" style="font-size:0.8rem;">${netStr||'—'}</div></div>
            <div><small>Trades</small><div class="m-val">${totalTrades}</div></div>
            <div><small>Status</small><div class="m-val" style="color:var(--accent)">● LIVE</div></div>
        </div>

        <div style="margin-top:10px;border-top:1px solid #1a1a1a;padding-top:8px;">
            ${nodes.map((n, i) => {
                const s       = statsArr[i];
                const liveBal = s.currentBal ?? n.balance ?? 0;
                const net     = s.net     || 0;
                const trades  = s.trades  || 0;
                const wr      = s.winRate || 0;
                return `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;${i>0?'border-top:1px solid #111;':''}">
                    <span style="color:#888;font-size:0.68rem;">${n.title||'Acc '+(i+1)}</span>
                    <div style="display:flex;gap:8px;font-size:0.68rem;font-family:monospace;">
                        <span style="color:var(--gold);font-weight:bold;">${fmtBal(n.curr||'$',liveBal)}</span>
                        <span style="color:${net>=0?'var(--accent)':'var(--danger)'};">${net>=0?'+':''}${fmtBal(n.curr||'$',net)}</span>
                        <span style="color:#555;">T:${trades} WR:${wr}%</span>
                    </div>
                </div>`;
            }).join('')}
        </div>
    </div>`;
}

onValue(ref(db, 'isi_v6/clusters'), async (snap) => {
    const list = document.getElementById('activeList');
    const data = snap.val();
    if (!data) {
        list.innerHTML = '<div style="color:#555;font-size:0.82rem;padding:20px;text-align:center;">No clusters deployed yet.</div>';
        return;
    }
    list.innerHTML = '<div style="color:#555;font-size:0.75rem;padding:10px;">Loading live balances...</div>';
    const cards = await Promise.all(Object.entries(data).map(([id, c]) => renderClusterCard(id, c)));
    list.innerHTML = cards.join('');
});

// ─────────────────────────────────────────────────────────
// EDIT CLUSTER
// ─────────────────────────────────────────────────────────
window.editCluster = (id) => {
    const key = prompt('🔑 Security Key enter karo:');
    if (!key) return;
    get(ref(db, `isi_v6/clusters/${id}`)).then(snap => {
        const cluster = snap.val();
        if (!cluster)                  return alert('Cluster not found!');
        if (cluster.resetKey !== key)  return alert('❌ Wrong Security Key!');

        editingClusterId = id;
        document.getElementById('deskTitle').value = cluster.title;
        document.getElementById('resetKey').value  = cluster.resetKey;

        const nodeCount  = cluster.nodes.length;
        const sel        = document.getElementById('nodeQty');
        let found = false;
        for (const o of sel.options) { if (parseInt(o.value)===nodeCount){sel.value=o.value;found=true;break;} }
        if (!found) {
            const o=document.createElement('option'); o.value=nodeCount; o.textContent=`${nodeCount} Nodes`;
            sel.appendChild(o); sel.value=nodeCount;
        }

        window.buildNodeUI(cluster.nodes);

        const btn = document.getElementById('btnDeploy');
        btn.textContent='💾 UPDATE CLUSTER';
        btn.style.background='linear-gradient(45deg,#1565c0,#42a5f5)';
        btn.style.color='#fff';

        let cancel = document.getElementById('btnCancelEdit');
        if (!cancel) {
            cancel=document.createElement('button');
            cancel.id='btnCancelEdit';
            cancel.style.cssText='width:100%;padding:12px;background:#1a1a1a;color:#888;border:1px solid #333;border-radius:6px;margin-top:10px;cursor:pointer;font-size:0.85rem;font-weight:bold;';
            cancel.onclick=resetForm;
            btn.insertAdjacentElement('afterend',cancel);
        }
        cancel.textContent='✕ Cancel Edit'; cancel.style.display='block';

        let banner=document.getElementById('editModeBanner');
        if (!banner) {
            banner=document.createElement('div'); banner.id='editModeBanner';
            banner.style.cssText='background:#0a1a2a;border:1px solid #1565c0;border-left:4px solid #42a5f5;padding:10px 14px;border-radius:4px;margin-bottom:14px;font-size:0.78rem;color:#42a5f5;font-weight:bold;';
            document.getElementById('nodeGrid').insertAdjacentElement('beforebegin',banner);
        }
        banner.style.display='block';
        banner.textContent=`✏ EDIT MODE — ${cluster.title} (${nodeCount} nodes)`;
        document.querySelector('.config-area').scrollTo({top:0,behavior:'smooth'});

    }).catch(err => alert('Firebase Error: '+err.message));
};

// ─────────────────────────────────────────────────────────
// DELETE CLUSTER
// ─────────────────────────────────────────────────────────
window.deleteCluster = (id, key) => {
    const entered = prompt('⚠️ Delete karne ke liye Security Key:');
    if (!entered) return;
    if (entered !== key) return alert('❌ Wrong Key!');
    if (!confirm('Pakka? Saara trade history permanently delete hoga!')) return;
    remove(ref(db,`isi_v6/clusters/${id}`))
        .then(()=>alert('✅ Deleted.'))
        .catch(err=>alert('Error: '+err.message));
};

// ─────────────────────────────────────────────────────────
// PRE-ENTRY CONFIG — Save to localStorage
// ─────────────────────────────────────────────────────────
window.savePreEntryConfig = function () {
    const config = {
        minAnalysisTime: parseInt(document.getElementById('minAnalysisTime')?.value || 300),
        minEntryScore:   parseInt(document.getElementById('minEntryScore')?.value   || 60),
        conflictBlock:   document.getElementById('conflictBlock')?.value || 'block'
    };
    localStorage.setItem('isi_preentry_config', JSON.stringify(config));
    const st = document.getElementById('preEntryConfigStatus');
    if (st) { st.textContent = '✅ Config saved!'; st.style.color = 'var(--accent)'; }
    setTimeout(() => { if (st) st.textContent = ''; }, 2000);
};

// Load saved config on page load
(function loadPreEntryConfig() {
    try {
        const cfg = JSON.parse(localStorage.getItem('isi_preentry_config') || '{}');
        if (cfg.minAnalysisTime !== undefined) {
            const el = document.getElementById('minAnalysisTime');
            if (el) el.value = String(cfg.minAnalysisTime);
        }
        if (cfg.minEntryScore !== undefined) {
            const el = document.getElementById('minEntryScore');
            if (el) el.value = String(cfg.minEntryScore);
        }
        if (cfg.conflictBlock !== undefined) {
            const el = document.getElementById('conflictBlock');
            if (el) el.value = cfg.conflictBlock;
        }
    } catch(e) {}
})();

// ═══════════════════════════════════════════════════════
// BLOCK 1 — AI INTEGRATION MANAGER
// ═══════════════════════════════════════════════════════

// Built-in providers
const BUILTIN_AI = [
    { id:'gemini',     name:'🟡 Gemini 2.0 Flash',   desc:'Free: 15 req/min · 1500/day',        link:'https://aistudio.google.com',  ph:'AIzaSy...' },
    { id:'groq',       name:'🟢 Groq Llama 3.3 70B', desc:'Free: 30 req/min · 14,400/day · Fastest', link:'https://console.groq.com',     ph:'gsk_...' },
    { id:'openrouter', name:'🔵 OpenRouter',          desc:'Free models: Mistral, Llama, Gemma', link:'https://openrouter.ai',         ph:'sk-or-...' },
    { id:'cohere',     name:'🟣 Cohere Command',      desc:'Free trial: 20 req/min',             link:'https://dashboard.cohere.com',  ph:'...' },
];

function getAllAIProviders() {
    const custom = JSON.parse(localStorage.getItem('isi_custom_ai') || '[]');
    return [...BUILTIN_AI, ...custom.map(c => ({
        id: 'custom_' + c.id, name: '⚪ ' + c.name,
        desc: c.url, link: c.freeLink || '#', ph: 'API Key...',
        custom: true, model: c.model, url: c.url
    }))];
}

function buildAIDropdown() {
    const sel = document.getElementById('aiProviderDropdown');
    if (!sel) return;
    const saved = localStorage.getItem('isi_ai_provider') || 'auto';
    sel.innerHTML = '<option value="auto">⚡ AUTO (best available use karega)</option>';
    getAllAIProviders().forEach(p => {
        const hasKey = !!localStorage.getItem('isi_key_' + p.id);
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name + (hasKey ? ' ✓' : '');
        sel.appendChild(opt);
    });
    sel.value = saved;
    onProviderSelect();
    refreshAIStatusRow();
}

window.onProviderSelect = function() {
    const sel = document.getElementById('aiProviderDropdown');
    if (!sel) return;
    const id = sel.value;
    if (id === 'auto') {
        document.getElementById('aiKeyPanel').style.opacity = '0.4';
        document.getElementById('aiKeyPanel').style.pointerEvents = 'none';
        localStorage.setItem('isi_ai_provider','auto');
        return;
    }
    document.getElementById('aiKeyPanel').style.opacity = '1';
    document.getElementById('aiKeyPanel').style.pointerEvents = 'auto';
    localStorage.setItem('isi_ai_provider', id);

    const p = getAllAIProviders().find(x => x.id === id);
    if (!p) return;
    document.getElementById('aiKeyLabel').textContent = p.name;
    document.getElementById('aiKeyDesc').textContent  = p.desc;
    document.getElementById('aiKeyLink').href         = p.link;
    document.getElementById('aiKeyInput').placeholder = p.ph;
    document.getElementById('aiKeyInput').value = localStorage.getItem('isi_key_' + id) || '';
    document.getElementById('aiKeyStatus').textContent = '';
    refreshAIStatusRow();
};

window.saveAIKey = function() {
    const id  = document.getElementById('aiProviderDropdown').value;
    const val = document.getElementById('aiKeyInput').value.trim();
    const st  = document.getElementById('aiKeyStatus');
    if (!val || id === 'auto') { if(st){st.textContent='⚠ Provider select karo aur key daalo';st.style.color='#ff6600';} return; }
    localStorage.setItem('isi_key_' + id, val);
    if(st){st.textContent='✅ Key saved! AI ready.';st.style.color='#00c805';}
    buildAIDropdown();
};

window.testAIKey = async function() {
    const id  = document.getElementById('aiProviderDropdown').value;
    const key = document.getElementById('aiKeyInput').value.trim() || localStorage.getItem('isi_key_' + id) || '';
    const st  = document.getElementById('aiKeyStatus');
    if (!key || id === 'auto') { if(st){st.textContent='⚠ Key daalo pehle';st.style.color='#ff6600';} return; }
    if(st){st.textContent='⏳ Testing...';st.style.color='#888';}
    try {
        let ok = false;
        if (id === 'gemini') {
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
                {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:'Say OK'}]}],generationConfig:{maxOutputTokens:5}})});
            ok = r.ok;
        } else if (id === 'groq') {
            const r = await fetch('https://api.groq.com/openai/v1/chat/completions',
                {method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},body:JSON.stringify({model:'llama-3.3-70b-versatile',messages:[{role:'user',content:'OK'}],max_tokens:5})});
            ok = r.ok;
        } else if (id === 'openrouter') {
            const r = await fetch('https://openrouter.ai/api/v1/chat/completions',
                {method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key,'HTTP-Referer':location.origin},body:JSON.stringify({model:'mistralai/mistral-7b-instruct:free',messages:[{role:'user',content:'OK'}],max_tokens:5})});
            ok = r.ok;
        } else if (id === 'cohere') {
            const r = await fetch('https://api.cohere.ai/v1/generate',
                {method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},body:JSON.stringify({model:'command',prompt:'Say OK',max_tokens:5})});
            ok = r.ok;
        } else { ok = true; } // custom — assume ok if key present
        if(st){st.textContent=ok?'✅ Key valid! AI ready.':'❌ Key invalid ya expired.';st.style.color=ok?'#00c805':'#ff5252';}
    } catch(e) {
        if(st){st.textContent='❌ Network error';st.style.color='#ff5252';}
    }
};

function refreshAIStatusRow() {
    const row = document.getElementById('aiAllStatus');
    const badge = document.getElementById('aiActiveBadge');
    if (!row) return;
    const providers = getAllAIProviders();
    let activeLabel = 'AUTO';
    row.innerHTML = providers.map(p => {
        const has = !!localStorage.getItem('isi_key_' + p.id);
        const short = p.name.split(' ').slice(1,3).join(' ');
        if (has && localStorage.getItem('isi_ai_provider') === p.id) activeLabel = short;
        return `<span style="background:${has?'#001800':'#0a0a0a'};border:1px solid ${has?'#006600':'#1a1a1a'};
            color:${has?'#00c805':'#333'};padding:3px 9px;border-radius:4px;font-size:0.58rem;font-weight:bold;">
            ${has?'✓':'—'} ${short}</span>`;
    }).join('');
    if (badge) badge.textContent = '⚡ ' + activeLabel;
}

// ── CUSTOM AI ──
window.addCustomAI = function() {
    document.getElementById('caiName').value = '';
    document.getElementById('caiUrl').value  = '';
    document.getElementById('caiModel').value= '';
    document.getElementById('caiKey').value  = '';
    document.getElementById('caiLink').value = '';
    const m = document.getElementById('customAIModal');
    m.style.display = 'flex';
};
window.closeCustomAI = function() { document.getElementById('customAIModal').style.display='none'; };
window.saveCustomAI = function() {
    const name  = document.getElementById('caiName').value.trim();
    const url   = document.getElementById('caiUrl').value.trim();
    const model = document.getElementById('caiModel').value.trim();
    const key   = document.getElementById('caiKey').value.trim();
    const link  = document.getElementById('caiLink').value.trim();
    if (!name || !url) return alert('Name aur URL required!');
    const customs = JSON.parse(localStorage.getItem('isi_custom_ai') || '[]');
    const id = Date.now().toString(36);
    customs.push({ id, name, url, model, freeLink: link });
    localStorage.setItem('isi_custom_ai', JSON.stringify(customs));
    if (key) localStorage.setItem('isi_key_custom_' + id, key);
    closeCustomAI();
    buildAIDropdown();
};


// ═══════════════════════════════════════════════════════
// BLOCK 2 — KNOWLEDGE BASE (Settings page)
// All DB calls use top-level: db, ref, onValue, update, remove, _fbPush
// ═══════════════════════════════════════════════════════

let _kbEntries   = {};
let _kbEditKey   = null;
let _kbActiveCat = 'ALL';
let _kbFileData  = null;        // { file(raw File obj), name, type, size, ext }
let _kbSubCount  = 0;
let _kbActiveTab = 'upload';    // 'upload' | 'text'
const _kbSubFiles = new Map();  // subCount(string) → raw File object

// ── Firebase listener ──
onValue(ref(db, 'isi_v6/knowledge/entries'), snap => {
    _kbEntries = snap.val() || {};
    renderKBList();
    updateKBStats();
    buildKBLinkDropdown();
});

window.onKBCatSelect = function() {
    _kbActiveCat = document.getElementById('kbCatDropdown').value;
    renderKBList();
};

// ── File Icons ──
function getFileIcon(ext) {
    const m = { pdf:'📄', doc:'📝', docx:'📝', xls:'📊', xlsx:'📊',
                txt:'📃', png:'🖼', jpg:'🖼', jpeg:'🖼', gif:'🖼',
                webp:'🖼', csv:'📊', ppt:'📋', pptx:'📋', mp4:'🎬', mp3:'🎵' };
    return m[(ext||'').toLowerCase()] || '📁';
}

// ── Tab switch ──
window.switchKBTab = function(tab) {
    _kbActiveTab = tab;
    const up = document.getElementById('tabUpload');
    const tx = document.getElementById('tabText');
    const bu = document.getElementById('tabUploadBtn');
    const bt = document.getElementById('tabTextBtn');
    if (!up || !tx) return;
    if (tab === 'upload') {
        up.style.display = 'block'; tx.style.display = 'none';
        bu.style.cssText += ';border-color:var(--gold);background:#1a1200;color:var(--gold);';
        bt.style.cssText += ';border-color:#333;background:#111;color:#666;';
    } else {
        up.style.display = 'none'; tx.style.display = 'block';
        bt.style.cssText += ';border-color:var(--gold);background:#1a1200;color:var(--gold);';
        bu.style.cssText += ';border-color:#333;background:#111;color:#666;';
    }
};

// ── Drag & drop ──
window.handleKBDrop = function(e) {
    e.preventDefault();
    document.getElementById('kbDropZone').style.borderColor = '#333';
    const file = e.dataTransfer.files[0];
    if (file) handleKBFile(file);
};

// ── Main file select ──
window.handleKBFile = function(file) {
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    _kbFileData = { file, name: file.name, type: file.type, size: file.size, ext };
    document.getElementById('kbFilePreview').style.display = 'block';
    document.getElementById('kbFileIcon').textContent = getFileIcon(ext);
    document.getElementById('kbFileName').textContent = file.name;
    document.getElementById('kbFileSize').textContent = (file.size / 1024 / 1024).toFixed(2) + ' MB';
    document.getElementById('kbDropZone').style.display = 'none';
};

window.clearKBFile = function() {
    _kbFileData = null;
    const fp = document.getElementById('kbFilePreview');
    const dz = document.getElementById('kbDropZone');
    const fi = document.getElementById('kbFileInput');
    if (fp) fp.style.display = 'none';
    if (dz) dz.style.display = 'block';
    if (fi) fi.value = '';
};

// ── Sub-sections ──
window.addKBSubSection = function() {
    _kbSubCount++;
    const id = 'sub_' + _kbSubCount;
    const n  = _kbSubCount;
    const container = document.getElementById('kbSubSections');
    const div = document.createElement('div');
    div.id = id;
    div.style.cssText = 'background:#050505;border:1px solid #1a1a1a;border-radius:6px;padding:12px;position:relative;';
    div.innerHTML = `
        <button onclick="removeSubSection('${id}', ${n})"
            style="position:absolute;top:8px;right:8px;background:var(--danger);color:#fff;border:none;padding:2px 8px;border-radius:3px;font-size:0.6rem;cursor:pointer;">✕</button>
        <div style="font-size:0.6rem;color:#c5a059;letter-spacing:1px;margin-bottom:8px;font-weight:bold;">SUB-SECTION ${n}</div>
        <div style="font-size:0.58rem;color:#555;margin-bottom:4px;">SUB-TITLE</div>
        <input type="text" placeholder="Sub-section title..."
            style="width:100%;background:#111;color:#fff;border:1px solid #222;padding:7px;border-radius:4px;font-size:0.72rem;margin-bottom:8px;"
            data-sub-title="${n}">
        <div style="display:flex;gap:6px;margin-bottom:8px;">
            <button onclick="switchSubTab(${n},'file')" id="subTabFile_${n}"
                style="padding:4px 10px;border-radius:3px;font-size:0.62rem;font-weight:bold;cursor:pointer;border:1px solid var(--gold);background:#1a1200;color:var(--gold);">
                📁 FILE
            </button>
            <button onclick="switchSubTab(${n},'text')" id="subTabText_${n}"
                style="padding:4px 10px;border-radius:3px;font-size:0.62rem;font-weight:bold;cursor:pointer;border:1px solid #333;background:#111;color:#666;">
                ✏ TEXT
            </button>
        </div>
        <div id="subFile_${n}">
            <div onclick="document.getElementById('subFileInput_${n}').click()"
                style="border:1px dashed #333;border-radius:4px;padding:14px;text-align:center;cursor:pointer;font-size:0.68rem;color:#555;">
                📁 Click to upload file
            </div>
            <input type="file" id="subFileInput_${n}" style="display:none" accept="*/*"
                onchange="handleSubFile(${n}, this.files[0])">
            <div id="subFilePreview_${n}" style="display:none;margin-top:6px;background:#111;border:1px solid #222;border-radius:4px;padding:8px;font-size:0.68rem;color:#888;"></div>
        </div>
        <div id="subText_${n}" style="display:none;">
            <textarea placeholder="Sub-section content..."
                style="width:100%;background:#111;color:#ccc;border:1px solid #222;padding:8px;border-radius:4px;font-size:0.7rem;resize:vertical;min-height:80px;line-height:1.5;"
                data-sub-text="${n}"></textarea>
        </div>`;
    container.appendChild(div);
};

window.removeSubSection = function(divId, n) {
    const el = document.getElementById(divId);
    if (el) el.remove();
    _kbSubFiles.delete(String(n));
};

window.switchSubTab = function(n, tab) {
    const sf = document.getElementById('subFile_' + n);
    const st = document.getElementById('subText_' + n);
    const bf = document.getElementById('subTabFile_' + n);
    const bt = document.getElementById('subTabText_' + n);
    if (!sf || !st) return;
    sf.style.display = tab === 'file' ? 'block' : 'none';
    st.style.display = tab === 'text' ? 'block' : 'none';
    if (bf) bf.style.cssText += tab==='file' ? ';border-color:var(--gold);background:#1a1200;color:var(--gold);' : ';border-color:#333;background:#111;color:#666;';
    if (bt) bt.style.cssText += tab==='text' ? ';border-color:var(--gold);background:#1a1200;color:var(--gold);' : ';border-color:#333;background:#111;color:#666;';
};

window.handleSubFile = function(n, file) {
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    _kbSubFiles.set(String(n), file);  // Store raw File in Map
    const prev = document.getElementById('subFilePreview_' + n);
    if (!prev) return;
    prev.style.display = 'block';
    prev.innerHTML = `${getFileIcon(ext)} <b>${file.name}</b> · ${(file.size/1024/1024).toFixed(2)}MB
        <span style="font-size:0.55rem;color:#00c805;margin-left:6px;">✓ Ready</span>`;
    prev.dataset.name = file.name;
    prev.dataset.type = file.type;
    prev.dataset.ext  = ext;
};

// ═══════════════════════════════
// UPLOAD TO FIREBASE STORAGE
// with real-time progress bar
// ═══════════════════════════════
function setProgressBar(pct, label, transferred, total) {
    const bar     = document.getElementById('kbUploadBar');
    const fill    = document.getElementById('kbUploadBarFill');
    const pctEl   = document.getElementById('kbUploadBarPct');
    const bytesEl = document.getElementById('kbUploadBytes');
    const btn     = document.querySelector('button[onclick="saveKBEntry()"]');

    if (bar)   bar.style.display = 'block';
    if (fill)  fill.style.width  = Math.min(pct, 100) + '%';
    if (pctEl) pctEl.textContent = `⏳ ${label} — ${Math.round(pct)}%`;
    if (bytesEl && transferred !== undefined) {
        bytesEl.textContent = `${(transferred/1024/1024).toFixed(2)} MB / ${(total/1024/1024).toFixed(2)} MB`;
    }
    if (btn) {
        btn.textContent = `⏳ ${Math.round(pct)}%`;
        btn.disabled    = true;
        btn.style.background = '#1a1200';
        btn.style.color      = '#c5a059';
        btn.style.border     = '1px solid #c5a059';
    }
}

function clearProgressBar() {
    const bar = document.getElementById('kbUploadBar');
    if (bar) bar.style.display = 'none';
}

function resetSaveBtn(text, isErr) {
    clearProgressBar();
    const btn = document.querySelector('button[onclick="saveKBEntry()"]');
    if (!btn) return;
    btn.textContent = text;
    btn.disabled    = false;
    btn.style.border = '';
    btn.style.background = isErr ? 'var(--danger)' : 'var(--gold)';
    btn.style.color      = isErr ? '#fff' : '#000';
}

async function uploadOneFile(file, storagePath) {
    return new Promise((resolve, reject) => {
        const storageRef = sRef(storage, storagePath);
        const task = uploadBytesResumable(storageRef, file);
        task.on('state_changed',
            (snap) => {
                const pct = (snap.bytesTransferred / snap.totalBytes) * 100;
                setProgressBar(pct, `Uploading ${file.name}`, snap.bytesTransferred, snap.totalBytes);
            },
            (err) => reject(new Error('Upload failed: ' + err.message)),
            async () => {
                try {
                    const url = await getDownloadURL(task.snapshot.ref);
                    resolve(url);
                } catch(e) { reject(e); }
            }
        );
    });
}

// ═══════════════════════════════
// SAVE ENTRY
// ═══════════════════════════════
window.saveKBEntry = async function() {
    const title = (document.getElementById('kbEntryTitle')?.value || '').trim();
    if (!title) { alert('Title required!'); return; }

    const btn = document.querySelector('button[onclick="saveKBEntry()"]');
    if (btn) { btn.textContent = '⏳ Preparing...'; btn.disabled = true; btn.style.background='#1a1200'; btn.style.color='#c5a059'; }

    try {
        const entryId = _kbEditKey || ('kb_' + Date.now().toString(36));

        // ── 1. Upload main file ──
        let fileData = null;
        if (_kbActiveTab === 'upload' && _kbFileData?.file instanceof File) {
            const safeName    = _kbFileData.name.replace(/[^a-zA-Z0-9._-]/g, '_');
            const storagePath = `knowledge/${entryId}/main_${safeName}`;
            const url = await uploadOneFile(_kbFileData.file, storagePath);
            fileData = {
                url,
                name:  _kbFileData.name,
                type:  _kbFileData.type  || '',
                ext:   _kbFileData.ext   || '',
                size:  _kbFileData.size  || 0,
                path:  storagePath
            };
        } else if (_kbFileData?.url) {
            fileData = _kbFileData; // existing — keep
        }

        // ── 2. Upload sub-section files ──
        const subs = {};
        const subTitleEls = document.querySelectorAll('[data-sub-title]');
        let si = 0;
        for (const el of subTitleEls) {
            si++;
            const n   = el.dataset.subTitle;
            const txt = (document.querySelector(`[data-sub-text="${n}"]`)?.value || '').trim();
            const fp  = document.getElementById('subFilePreview_' + n);
            let subFile = null;

            const rawFile = _kbSubFiles.get(String(n));
            if (rawFile instanceof File) {
                const safeSub = rawFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
                const subPath = `knowledge/${entryId}/sub${n}_${safeSub}`;
                const subUrl  = await uploadOneFile(rawFile, subPath);
                subFile = {
                    url:  subUrl,
                    name: fp?.dataset?.name || rawFile.name,
                    type: fp?.dataset?.type || rawFile.type,
                    ext:  fp?.dataset?.ext  || rawFile.name.split('.').pop().toLowerCase(),
                    path: subPath
                };
            } else if (fp?.dataset?.url) {
                subFile = { url: fp.dataset.url, name: fp.dataset.name, type: fp.dataset.type, ext: fp.dataset.ext };
            }

            if (el.value.trim() || txt || subFile) {
                subs['sub' + n] = { title: el.value.trim(), text: txt, file: subFile };
            }
        }

        // ── 3. Build entry object ──
        const entry = {
            title,
            type:        document.getElementById('kbEntryType')?.value   || 'SOP',
            desc:        (document.getElementById('kbEntryDesc')?.value   || '').trim(),
            tags:        (document.getElementById('kbEntryTags')?.value   || '').trim(),
            linkedTo:    document.getElementById('kbEntryLink')?.value    || '',
            content:     _kbActiveTab === 'text'
                            ? (document.getElementById('kbEntryContent')?.value || '').trim()
                            : '',
            file:        fileData,
            subSections: Object.keys(subs).length ? subs : null,
            updatedAt:   new Date().toISOString()
        };

        // ── 4. Save to Realtime DB ──
        if (btn) { btn.textContent = '⏳ Saving...'; }
        clearProgressBar();

        if (_kbEditKey) {
            await update(ref(db, `isi_v6/knowledge/entries/${_kbEditKey}`), entry);
        } else {
            entry.createdAt = new Date().toISOString();
            await _fbPush(ref(db, 'isi_v6/knowledge/entries'), entry);
        }

        resetSaveBtn('✅ Saved!', false);
        setTimeout(() => closeKBModal(), 700);

    } catch(err) {
        console.error('saveKBEntry:', err);
        resetSaveBtn('❌ ' + err.message.slice(0, 35), true);
        setTimeout(() => resetSaveBtn('💾 SAVE TO FIREBASE', false), 3500);
    }
};

// ── Render list ──
function renderKBList() {
    const container = document.getElementById('kbSettingsList');
    if (!container) return;

    let entries = Object.entries(_kbEntries);
    if (_kbActiveCat !== 'ALL') entries = entries.filter(([,e]) => e.type === _kbActiveCat);
    entries.sort((a,b) => (b[1].createdAt||'').localeCompare(a[1].createdAt||''));

    if (!entries.length) {
        container.innerHTML = `<div style="text-align:center;padding:24px;color:#333;font-size:0.72rem;border:1px dashed #1a1a1a;border-radius:6px;">
            Koi entry nahi. "+ ADD ENTRY" se shuru karo.</div>`;
        return;
    }

    const typeCols  = {SOP:'#4a9eff',Checklist:'#00c805',Notes:'var(--gold)',Training:'#cc44ff',Structure:'#ff5252'};
    const typeIcons = {SOP:'📘',Checklist:'✅',Notes:'📝',Training:'🎓',Structure:'📊'};

    container.innerHTML = entries.map(([key,e]) => {
        const col      = typeCols[e.type]  || '#888';
        const ico      = typeIcons[e.type] || '📁';
        const children = Object.entries(_kbEntries).filter(([,en]) => en.linkedTo === key);
        const hasFile  = !!(e.file?.url);
        const hasSubs  = e.subSections && Object.keys(e.subSections).length > 0;

        return `
        <div style="background:#0a0a0a;border:1px solid #1a1a1a;border-left:4px solid ${col};border-radius:6px;margin-bottom:8px;overflow:hidden;">
            <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;" onclick="toggleKBCard('kbc_${key}')">
                <span>${ico}</span>
                <span style="font-size:0.5rem;border:1px solid ${col};color:${col};padding:1px 5px;border-radius:3px;font-weight:bold;text-transform:uppercase;">${e.type}</span>
                <span style="flex:1;font-size:0.75rem;font-weight:bold;color:#ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${e.title}</span>
                ${hasFile  ? '<span style="font-size:0.5rem;background:#001a10;color:#00c805;border:1px solid #003a1a;padding:1px 5px;border-radius:3px;">📎 FILE</span>' : ''}
                ${hasSubs  ? `<span style="font-size:0.5rem;background:#0a0800;color:var(--gold);border:1px solid #2a1a00;padding:1px 5px;border-radius:3px;">${Object.keys(e.subSections).length} SUBS</span>` : ''}
                <span style="font-size:0.58rem;color:#333;">${e.createdAt ? new Date(e.createdAt).toLocaleDateString('en-GB') : ''}</span>
                <div style="display:flex;gap:4px;flex-shrink:0;" onclick="event.stopPropagation()">
                    <button onclick="openKBInPage('${key}')" style="background:transparent;border:1px solid #222;color:#555;padding:3px 8px;border-radius:3px;font-size:0.6rem;cursor:pointer;" onmouseover="this.style.borderColor='#4a9eff';this.style.color='#4a9eff'" onmouseout="this.style.borderColor='#222';this.style.color='#555'">VIEW</button>
                    <button onclick="openKBEditEntry('${key}')" style="background:transparent;border:1px solid #222;color:#555;padding:3px 8px;border-radius:3px;font-size:0.6rem;cursor:pointer;" onmouseover="this.style.borderColor='var(--gold)';this.style.color='var(--gold)'" onmouseout="this.style.borderColor='#222';this.style.color='#555'">EDIT</button>
                    <button onclick="deleteKBEntry('${key}')" style="background:transparent;border:1px solid #222;color:#555;padding:3px 8px;border-radius:3px;font-size:0.6rem;cursor:pointer;" onmouseover="this.style.borderColor='var(--danger)';this.style.color='var(--danger)'" onmouseout="this.style.borderColor='#222';this.style.color='#555'">🗑</button>
                </div>
            </div>
            <div id="kbc_${key}" style="display:none;padding:10px 12px;border-top:1px solid #0d0d0d;background:#050505;font-size:0.68rem;color:#555;line-height:1.6;">
                ${e.desc ? `<div style="margin-bottom:6px;color:#666;">${e.desc}</div>` : ''}
                ${e.content ? `<div style="max-height:50px;overflow:hidden;">${e.content.slice(0,160)}...</div>` : ''}
                ${children.length ? `
                <div style="margin-top:8px;padding-top:6px;border-top:1px solid #0a0a0a;">
                    <div style="font-size:0.53rem;color:#333;letter-spacing:1px;margin-bottom:4px;">🔗 LINKED</div>
                    ${children.map(([ck,ce]) => `<span onclick="openKBInPage('${ck}')" style="display:inline-flex;align-items:center;gap:4px;background:#0a0a0a;border:1px solid #1a1a1a;padding:2px 7px;border-radius:3px;font-size:0.6rem;color:#555;cursor:pointer;margin:2px;">${typeIcons[ce.type]||'📁'} ${ce.title}</span>`).join('')}
                </div>` : ''}
            </div>
        </div>`;
    }).join('');
}

window.toggleKBCard = function(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
};

window.openKBInPage = function(key) {
    window.open('knowledge.html#' + key, '_blank');
};

function updateKBStats() {
    const all = Object.values(_kbEntries);
    const el  = document.getElementById('kbSettingsStats');
    if (!el) return;
    const c   = t => all.filter(e => e.type === t).length;
    el.textContent = `Total: ${all.length}  ·  SOP: ${c('SOP')}  ·  Checklist: ${c('Checklist')}  ·  Notes: ${c('Notes')}  ·  Training: ${c('Training')}`;
}

function buildKBLinkDropdown() {
    const sel = document.getElementById('kbEntryLink');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">— No parent link —</option>';
    Object.entries(_kbEntries).forEach(([k,e]) => {
        if (k === _kbEditKey) return;
        const opt = document.createElement('option');
        opt.value = k;
        opt.textContent = `[${e.type}] ${e.title}`;
        sel.appendChild(opt);
    });
    if (cur) sel.value = cur;
}

// ── Open add modal ──
window.openKBAddEntry = function() {
    _kbEditKey = null;
    _kbFileData = null;
    _kbSubCount = 0;
    _kbSubFiles.clear();

    document.getElementById('kbModalHeading').textContent = 'ADD NEW ENTRY';
    ['kbEntryTitle','kbEntryDesc','kbEntryContent','kbEntryTags'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    document.getElementById('kbEntryType').value = (_kbActiveCat !== 'ALL') ? _kbActiveCat : 'SOP';
    document.getElementById('kbSubSections').innerHTML = '';
    clearKBFile();
    buildKBLinkDropdown();
    switchKBTab('upload');
    resetSaveBtn('💾 SAVE TO FIREBASE', false);
    clearProgressBar();

    document.getElementById('kbAddModal').style.display = 'flex';
    setTimeout(() => document.getElementById('kbEntryTitle')?.focus(), 100);
};

// ── Open edit modal ──
window.openKBEditEntry = function(key) {
    const e = _kbEntries[key]; if (!e) return;
    _kbEditKey = key;
    _kbFileData = null;
    _kbSubCount = 0;
    _kbSubFiles.clear();

    document.getElementById('kbModalHeading').textContent = 'EDIT ENTRY';
    document.getElementById('kbEntryTitle').value   = e.title   || '';
    document.getElementById('kbEntryDesc').value    = e.desc    || '';
    document.getElementById('kbEntryContent').value = e.content || '';
    document.getElementById('kbEntryTags').value    = e.tags    || '';
    document.getElementById('kbEntryType').value    = e.type    || 'SOP';
    document.getElementById('kbSubSections').innerHTML = '';

    buildKBLinkDropdown();
    document.getElementById('kbEntryLink').value = e.linkedTo || '';

    if (e.file?.url) {
        _kbFileData = e.file; // existing url — no raw File
        switchKBTab('upload');
        document.getElementById('kbFilePreview').style.display = 'block';
        document.getElementById('kbDropZone').style.display    = 'none';
        document.getElementById('kbFileIcon').textContent = getFileIcon(e.file.ext || '');
        document.getElementById('kbFileName').textContent = e.file.name || 'File';
        document.getElementById('kbFileSize').textContent = ((e.file.size || 0) / 1024 / 1024).toFixed(2) + ' MB';
    } else if (e.content) {
        switchKBTab('text');
    } else {
        switchKBTab('upload');
    }

    resetSaveBtn('💾 SAVE TO FIREBASE', false);
    clearProgressBar();
    document.getElementById('kbAddModal').style.display = 'flex';
};

// ── Close modal ──
window.closeKBModal = function() {
    document.getElementById('kbAddModal').style.display = 'none';
    _kbEditKey  = null;
    _kbFileData = null;
    _kbSubFiles.clear();
    _kbSubCount = 0;
    clearProgressBar();
    resetSaveBtn('💾 SAVE TO FIREBASE', false);
};

// ── Delete with math captcha ──
window.deleteKBEntry = function(key) {
    const e = _kbEntries[key]; if (!e) return;
    const ops = ['+','-','×'];
    const op  = ops[Math.floor(Math.random() * 3)];
    let a = Math.floor(Math.random() * 10) + 1;
    let b = Math.floor(Math.random() * 10) + 1;
    if (op === '-' && b > a) [a, b] = [b, a];
    const ans = op === '+' ? a+b : op === '-' ? a-b : a*b;
    const userAns = prompt(`⚠ DELETE "${e.title}"?\n\nSolve to confirm: ${a} ${op} ${b} = ?`);
    if (userAns === null) return;
    if (parseInt(userAns) !== ans) { alert('❌ Wrong answer! Delete cancelled.'); return; }
    remove(ref(db, `isi_v6/knowledge/entries/${key}`));
};

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
    buildAIDropdown();
});
