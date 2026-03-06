import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, update, remove, get } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { aiWeeklyCoach, showAILoading, renderAIResponse } from "./gemini.js";

// ── FIREBASE CONFIG ──
const firebaseConfig = {
    apiKey: "AIzaSyBhVpnVtlLMy0laY8U5A5Y8lLY9s3swjkE",
    authDomain: "trading-terminal-b8006.firebaseapp.com",
    projectId: "trading-terminal-b8006",
    storageBucket: "trading-terminal-b8006.firebasestorage.app",
    messagingSenderId: "690730161822",
    appId: "1:690730161822:web:81dabfd7b4575e86860d8f",
    databaseURL: "https://trading-terminal-b8006-default-rtdb.firebaseio.com"
};
const fbApp = initializeApp(firebaseConfig);
const db    = getDatabase(fbApp);

// ── CONSTANTS ──
const monthNames = ["January","February","March","April","May","June",
                    "July","August","September","October","November","December"];

// ── STATE ──
let clusters           = {};
let selectedClusterId  = null;
let allTrades          = [];
let nodeMap            = {};
let liveStats          = {};  // { [clusterId]: { [nodeIdx]: statsObj } }
let preentryData       = {};  // { [clusterId]: { [nodeIdx]: { [fbKey]: record } } }

// Stats path — dedicated lightweight path
const statsPath = (cId, nIdx) => `isi_v6/stats/${cId}/${nIdx}`;

// ── USD/INR LIVE RATE HELPER ──
let _usdInrRate = null, _rateTs = 0;
async function getUsdInrRate() {
    const now = Date.now();
    if (_usdInrRate && (now - _rateTs) < 10 * 60 * 1000) return _usdInrRate;
    try {
        const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
        const j = await r.json();
        _usdInrRate = j.rates?.INR || 84;
        _rateTs = now;
    } catch(e) { _usdInrRate = _usdInrRate || 84; }
    return _usdInrRate;
}
async function mixedToUSD(byCurr) {
    const rate = await getUsdInrRate();
    let total = 0;
    for (const [c, v] of Object.entries(byCurr)) total += (c === '$') ? v : v / rate;
    return total;
}

function getNodeStats(cId, nIdx) {
    const cached = liveStats[cId]?.[String(nIdx)];
    if (cached) return cached;
    const node = clusters[cId]?.nodes[nIdx];
    if (node?.stats) return node.stats;
    return { currentBal: node?.balance ?? 0, trades: 0, wins: 0, winRate: 0, net: 0 };
}

// ──────────────────────────────────────────────
// FIREBASE — LOAD ALL CLUSTERS
// ──────────────────────────────────────────────
onValue(ref(db, 'isi_v6/clusters'), (snap) => {
    clusters = snap.val() || {};
    document.getElementById('fbMonStatus').textContent = '● LIVE — Firebase Connected';
    document.getElementById('fbMonStatus').style.color = '#00c805';
    populateClusterFilter();
});

// ── DEDICATED STATS LISTENER (instant, no images) ──
onValue(ref(db, 'isi_v6/stats'), (snap) => {
    liveStats = snap.val() || {};
    if (selectedClusterId) renderAll();
});

// ── PRE-ENTRY DATA LISTENER ──
onValue(ref(db, 'isi_v6/preentry'), (snap) => {
    preentryData = snap.val() || {};
});

// ──────────────────────────────────────────────
// POPULATE CLUSTER FILTER
// ──────────────────────────────────────────────
function populateClusterFilter() {
    const sel   = document.getElementById('clusterFilter');
    const saved = localStorage.getItem('mon_sel_cluster');

    sel.innerHTML = '<option value="">— Select Cluster —</option>';
    Object.entries(clusters).forEach(([id, c]) => {
        const o = document.createElement('option');
        o.value = id; o.textContent = c.title;
        sel.appendChild(o);
    });

    if (saved && clusters[saved]) {
        sel.value = saved;
        selectedClusterId = saved;
        populateAccFilter(saved);
        loadClusterData(saved);
    }
}

// ──────────────────────────────────────────────
// POPULATE ACCOUNT FILTER
// ──────────────────────────────────────────────
function populateAccFilter(clusterId) {
    const sel = document.getElementById('accFilter');
    sel.innerHTML = '<option value="ALL">All Accounts (Combined)</option>';
    sel.disabled  = false;

    const cluster = clusters[clusterId];
    if (!cluster) return;

    cluster.nodes.forEach((node, idx) => {
        const o = document.createElement('option');
        o.value       = idx;
        o.textContent = `${node.title || 'Account ' + (idx + 1)}  (${node.curr}${(node.balance || 0).toLocaleString()})`;
        sel.appendChild(o);
    });
}

// ──────────────────────────────────────────────
// LOAD ALL TRADES FOR SELECTED CLUSTER
// ──────────────────────────────────────────────
function loadClusterData(clusterId) {
    const cluster = clusters[clusterId];
    if (!cluster) return;

    allTrades = [];
    nodeMap   = {};
    let pending = cluster.nodes.length;
    if (pending === 0) { renderAll(); return; }

    cluster.nodes.forEach((node, nIdx) => {
        nodeMap[nIdx] = node;
        onValue(ref(db, `isi_v6/clusters/${clusterId}/nodes/${nIdx}/tradeHistory`), (snap) => {
            // Remove old trades from this node
            allTrades = allTrades.filter(t => t._nodeIdx !== nIdx);
            const val = snap.val();
            if (val) {
                Object.entries(val).forEach(([fbKey, trade]) => {
                    allTrades.push({
                        ...trade,
                        _nodeIdx: nIdx,
                        _fbKey:   fbKey,
                        _nodeTitle: node.title || 'Account ' + (nIdx + 1),
                        _curr: node.curr || '$'
                    });
                });
            }
            // Sort by date desc
            allTrades.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
            renderAll();
        });
    });
}

// ──────────────────────────────────────────────
// FILTER CHANGE HANDLER
// ──────────────────────────────────────────────
window.onFilterChange = function () {
    const newCluster = document.getElementById('clusterFilter').value;

    if (newCluster !== selectedClusterId) {
        selectedClusterId = newCluster || null;
        allTrades = [];
        document.getElementById('accFilter').innerHTML = '<option value="ALL">All Accounts (Combined)</option>';
        document.getElementById('accFilter').disabled  = true;

        if (selectedClusterId) {
            localStorage.setItem('mon_sel_cluster', selectedClusterId);
            populateAccFilter(selectedClusterId);
            loadClusterData(selectedClusterId);
        } else {
            localStorage.removeItem('mon_sel_cluster');
            renderAll();
        }
    } else {
        renderAll();
    }
};

// ──────────────────────────────────────────────
// GET FILTERED TRADES
// ──────────────────────────────────────────────
function getFilteredTrades() {
    const accVal  = document.getElementById('accFilter').value;
    const range   = document.getElementById('timeRange').value;
    const now     = new Date();

    let filtered = [...allTrades];

    // Account filter
    if (accVal !== 'ALL') {
        const idx = parseInt(accVal);
        filtered = filtered.filter(t => t._nodeIdx === idx);
    }

    // Time filter
    if (range !== 'all') {
        filtered = filtered.filter(t => {
            if (!t.date) return false;
            const d = new Date(t.date);
            if (range === '1week')   return (now - d) / 86400000 <= 7;
            if (range === 'current') return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
            if (range === '3months') return (now - d) / 86400000 <= 92;
            if (range === '1year')   return (now - d) / 86400000 <= 365;
            if (range === '3year')   return (now - d) / 86400000 <= 1095;
            return true;
        });
    }

    return filtered;
}

// ──────────────────────────────────────────────
// RENDER ALL
// ──────────────────────────────────────────────
function renderAll() {
    if (!selectedClusterId) {
        clearUI(); return;
    }
    const filtered = getFilteredTrades();
    renderPerformanceCard(filtered);
    renderRecentSessions();
    renderCalendar(filtered);
}

function clearUI() {
    document.getElementById('bigWr').innerText     = '0%';
    document.getElementById('currBal').innerText   = '—';
    document.getElementById('periodPl').innerText  = '$0.00';
    document.getElementById('periodPerc').innerText = '0.00%';
    document.getElementById('periodTrades').innerText = '0';
    document.getElementById('accBreakdown').innerText = 'Select a cluster to view data.';
    document.getElementById('pnl').innerText   = '$0.00';
    document.getElementById('trades').innerText = '0';
    document.getElementById('wr').innerText     = '0%';
    document.getElementById('gDays').innerText  = '0';
    document.getElementById('recentSessions').innerHTML = '<div style="color:#555; font-size:0.8rem; padding:20px;">Select a cluster to view sessions...</div>';
    document.getElementById('calendarArea').innerHTML = '';
}

// ──────────────────────────────────────────────
// PERFORMANCE OVERVIEW CARD
// ──────────────────────────────────────────────
function renderPerformanceCard(filtered) {
    const accVal  = document.getElementById('accFilter').value;
    const cluster = clusters[selectedClusterId];
    if (!cluster) return;

    const totalPl  = filtered.reduce((s, t) => s + (t.pl || 0), 0);
    const winCount = filtered.filter(t => t.type === 'Target').length;
    const wr       = filtered.length ? (winCount / filtered.length) * 100 : 0;

    document.getElementById('bigWr').innerText        = wr.toFixed(1) + '%';
    document.getElementById('periodTrades').innerText = filtered.length;

    // Period P/L — per node currency
    const plByCurr = {};
    filtered.forEach(t => {
        const nodeIdx = t._nodeIdx ?? 0;
        const c = cluster.nodes[nodeIdx]?.curr || '$';
        plByCurr[c] = (plByCurr[c] || 0) + (t.pl || 0);
    });
    const hasMixedPl = Object.keys(plByCurr).length > 1;
    let plStr = Object.entries(plByCurr).map(([c,v])=>`${v>=0?'+':''}${c}${v.toFixed(2)}`).join(' ') || '+$0.00';
    if (hasMixedPl) {
        getUsdInrRate().then(rate => {
            let usdTotal = 0;
            Object.entries(plByCurr).forEach(([c,v]) => usdTotal += (c==='$')?v:v/rate);
            const plEl2 = document.getElementById('periodPl');
            plEl2.innerHTML = plStr + ` <span style="color:#555;font-size:0.65rem;">(≈${usdTotal>=0?'+':''}$${usdTotal.toFixed(2)} USD)</span>`;
        });
    }
    const plEl = document.getElementById('periodPl');
    plEl.innerHTML   = plStr;
    plEl.style.color = totalPl >= 0 ? 'var(--accent)' : 'var(--danger)';

    // Return % — use setup balance as base, single currency only
    const startBal = accVal === 'ALL'
        ? cluster.nodes.reduce((s,n) => s+(n.balance??0), 0)
        : (cluster.nodes[parseInt(accVal)]?.balance ?? 0);
    const periodPerc  = startBal > 0 ? (totalPl / startBal) * 100 : 0;
    const percEl = document.getElementById('periodPerc');
    percEl.innerText   = (periodPerc >= 0 ? '+' : '') + periodPerc.toFixed(2) + '%';
    percEl.style.color = periodPerc >= 0 ? 'var(--accent)' : 'var(--danger)';

    const ring = document.getElementById('winRing');
    ring.className = 'win-circle ' + (wr >= 65 ? 'high' : wr >= 35 ? 'mid' : 'low');

    // Account breakdown
    const nodeEntries = accVal === 'ALL'
        ? cluster.nodes.map((n, i) => ({ n, title: n.title || 'Acc '+(i+1), idx: i }))
        : [{ n: cluster.nodes[parseInt(accVal)], title: cluster.nodes[parseInt(accVal)]?.title || 'Acc '+(parseInt(accVal)+1), idx: parseInt(accVal) }];

    const breakdown = nodeEntries.map(({ n, title, idx }) => {
        const nodeTrades = filtered.filter(t => t._nodeIdx === idx);
        const nodePl     = nodeTrades.reduce((s, t) => s + (t.pl||0), 0);
        const nodeWr     = nodeTrades.length ? ((nodeTrades.filter(t=>t.type==='Target').length/nodeTrades.length)*100).toFixed(0) : 0;
        const c          = n?.curr || '$';
        return `<b style="color:#ccc">${title}</b>: ${nodeTrades.length} trades | <span style="color:${nodePl>=0?'var(--accent)':'var(--danger)'}">${nodePl>=0?'+':''}${c}${nodePl.toFixed(0)}</span> | WR: ${nodeWr}%`;
    }).join('&nbsp;&nbsp;|&nbsp;&nbsp;');
    document.getElementById('accBreakdown').innerHTML = breakdown || '—';

    // Current Balance — from live stats cache (instant, no async needed)
    const currBalEl = document.getElementById('currBal');
    const nodesToUse = accVal === 'ALL'
        ? cluster.nodes.map((n,i) => ({n,i}))
        : [{ n: cluster.nodes[parseInt(accVal)], i: parseInt(accVal) }];

    const byCurr = {};
    nodesToUse.forEach(({n, i}) => {
        const s   = getNodeStats(selectedClusterId, i);
        const c   = n.curr || '$';
        const bal = s.currentBal ?? n.balance ?? 0;
        byCurr[c] = (byCurr[c]||0) + bal;
    });
    const byCurrEntries = Object.entries(byCurr);
    const hasMixedBal = byCurrEntries.length > 1;
    const balStr = byCurrEntries.map(([c,v]) => `${c}${v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`).join(' + ') || '$0.00';
    if (hasMixedBal) {
        mixedToUSD(byCurr).then(usdTotal => {
            getUsdInrRate().then(rate => {
                currBalEl.innerHTML = balStr + ` <span style="color:#555;font-size:0.65rem;display:block;">≈ $${usdTotal.toLocaleString('en-US',{minimumFractionDigits:2})} USD @ ₹${rate.toFixed(1)}</span>`;
            });
        });
    }
    currBalEl.innerText = balStr;
}

// ──────────────────────────────────────────────
// RECENT 6 SESSIONS
// ──────────────────────────────────────────────
function renderRecentSessions() {
    const container = document.getElementById('recentSessions');
    const accVal    = document.getElementById('accFilter').value;

    let source = [...allTrades];
    if (accVal !== 'ALL') source = source.filter(t => t._nodeIdx === parseInt(accVal));
    const recent = source.slice(0, 6); // already sorted desc

    if (!recent.length) {
        container.innerHTML = '<div style="color:#555; font-size:0.8rem; padding:20px;">No sessions found for selected filters.</div>';
        return;
    }

    container.innerHTML = recent.map(t => `
        <div class="recent-card">
            <div style="display:flex; justify-content:space-between; font-weight:bold; font-size:0.85rem;">
                <span>${t.date} | <span style="color:var(--gold)">${t._nodeTitle}</span></span>
                <div style="text-align:right;">
                    <span style="color:${(t.pl || 0) >= 0 ? 'var(--accent)' : 'var(--danger)'}">
                        ${(t.pl || 0) >= 0 ? '+' : ''}${t._curr||'$'}${Math.abs(t.pl || 0).toFixed(2)}
                    </span>
                    ${t.lockRiskAmt!=null||t.lockQty!=null?`<div style="font-size:0.62rem;color:#00c8ff;margin-top:2px;">🔒 ${t.lockRiskAmt!=null?(t._curr||'$')+Number(t.lockRiskAmt).toFixed(2):''} ${t.lockQty!=null?'Qty:'+( Number(t.lockQty)<1?Number(t.lockQty).toFixed(3):Number(t.lockQty).toFixed(2)):''}</div>`:''}
                </div>
            </div>
            <div style="font-size:0.72rem; margin-top:5px; color:var(--gold);">
                Asset: ${t.asset || '—'} | Outcome: ${t.type || '—'} | Grade: ${t.grade || '—'}
            </div>
            <div style="margin-top:7px;">
                ${t.vios && t.vios.length > 0
                    ? t.vios.map(v => `<span class="tag red">${v}</span>`).join('')
                    : '<span class="tag green">No Violations</span>'}
            </div>
            <div class="recent-lesson"><b>Lesson:</b> ${(t.psy || [])[5] || 'No lesson recorded.'}</div>
        </div>
    `).join('');
}

// ──────────────────────────────────────────────
// CALENDAR RENDER
// ──────────────────────────────────────────────
function renderCalendar(filtered) {
    const range = document.getElementById('timeRange').value;
    const now   = new Date();
    const calArea = document.getElementById('calendarArea');
    calArea.innerHTML = '';

    // Build month list
    const months = [];
    let count = 1;
    if (range === '1week')   count = 1;
    else if (range === '3months') count = 3;
    else if (range === '1year')   count = 12;
    else if (range === '3year')   count = 36;
    else if (range === 'all')     count = 60;

    for (let i = count - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push({ m: d.getMonth(), y: d.getFullYear() });
    }

    // Build daily trade map for fast lookup
    const dayMap = {}; // "YYYY-MM-DD" → { pl, trades[] }
    filtered.forEach(t => {
        if (!t.date) return;
        if (!dayMap[t.date]) dayMap[t.date] = { pl: 0, trades: [] };
        dayMap[t.date].pl     += t.pl || 0;
        dayMap[t.date].trades.push(t);
    });

    // Stats
    let tPL = 0, tTrades = 0, tWins = 0, tGreen = 0;

    months.forEach(({ m, y }) => {
        const monthDiv = document.createElement('div');
        monthDiv.className = 'month-box';

        const monthHeader = document.createElement('div');
        monthHeader.className = 'month-name';
        monthHeader.textContent = `${monthNames[m]} ${y}`;
        monthDiv.appendChild(monthHeader);

        const grid = document.createElement('div');
        grid.className = 'cal-grid';

        // Day headers
        ['SUN','MON','TUE','WED','THU','FRI','SAT'].forEach(d => {
            const h = document.createElement('div');
            h.className = 'cal-day-header';
            h.textContent = d;
            grid.appendChild(h);
        });

        // Blank cells before 1st
        const firstDay = new Date(y, m, 1).getDay();
        for (let i = 0; i < firstDay; i++) {
            grid.appendChild(document.createElement('div'));
        }

        const daysInMonth = new Date(y, m + 1, 0).getDate();

        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const info    = dayMap[dateStr];
            const dayPL   = info?.pl ?? 0;
            const dayTr   = info?.trades ?? [];

            if (info) {
                tPL    += dayPL;
                tTrades += dayTr.length;
                tWins  += dayTr.filter(t => t.type === 'Target').length;
                if (dayPL > 0) tGreen++;
            }

            const dayEl = document.createElement('div');
            dayEl.className = 'day' + (dayTr.length > 0 ? (dayPL >= 0 ? ' green-day' : ' red-day') : '');

            dayEl.innerHTML = `
                <span class="d-num">${d}</span>
                ${dayTr.length > 0 ? `
                    <span style="font-weight:bold; font-size:0.72rem; color:${dayPL >= 0 ? '#00ff41' : '#ff3131'}; text-align:center;">
                        ${dayPL >= 0 ? '+' : ''}${dayTr[0]?._curr||'$'}${Math.abs(dayPL).toFixed(0)}
                    </span>
                    <span class="d-trades">${dayTr.length} trade${dayTr.length > 1 ? 's' : ''}</span>
                ` : ''}
            `;

            if (dayTr.length > 0) {
                dayEl.onclick = () => openDayTrades(dateStr, dayTr);
                dayEl.style.cursor = 'pointer';
            }

            grid.appendChild(dayEl);
        }

        monthDiv.appendChild(grid);
        calArea.appendChild(monthDiv);
    });

    // Update stats bar
    const plEl = document.getElementById('pnl');
    plEl.innerText   = (tPL >= 0 ? '+' : '') + `$${tPL.toFixed(2)}`;
    plEl.style.color = tPL >= 0 ? 'var(--accent)' : 'var(--danger)';

    document.getElementById('trades').innerText = tTrades;
    document.getElementById('wr').innerText     = tTrades ? ((tWins / tTrades) * 100).toFixed(1) + '%' : '0%';
    document.getElementById('gDays').innerText  = tGreen;
}

// ──────────────────────────────────────────────
// OPEN DAY TRADES (List of trades for a date)
// ──────────────────────────────────────────────
window.openDayTrades = function (date, trades) {
    if (!trades.length) return;

    const totalPl = trades.reduce((s, t) => s + (t.pl || 0), 0);
    document.getElementById('modalTitle').innerHTML =
        `${date} &nbsp;|&nbsp; ${trades.length} Trade${trades.length > 1 ? 's' : ''} &nbsp;|&nbsp;
         <span style="color:${totalPl >= 0 ? 'var(--accent)' : 'var(--danger)'}">
            ${totalPl >= 0 ? '+' : ''}${trades[0]?._curr||'$'}${Math.abs(totalPl).toFixed(2)}
         </span>`;

    document.getElementById('modalBody').innerHTML = trades.map(t => `
        <div style="background:#111; padding:14px; margin-top:10px; border-radius:8px;
                    border-left:4px solid var(--gold); cursor:pointer;"
             onclick="viewDeepDive('${t._nodeIdx}','${t._fbKey}')">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <b style="font-size:0.9rem;">${t.asset || '—'} | ${t._nodeTitle}</b>
                    <br><small style="color:#666;">Grade: ${t.grade || '—'} | ${t.type || '—'} | Lot: ${t.riskQty || '—'}</small>
                    ${t.lockRiskAmt != null || t.lockQty != null ? `
                    <div style="margin-top:5px;display:flex;gap:12px;">
                        ${t.lockRiskAmt != null ? `<span style="font-size:0.65rem;color:#00c8ff;">🔒 Risk: <b>${t._curr||'$'}${Number(t.lockRiskAmt).toFixed(2)}</b></span>` : ''}
                        ${t.lockQty != null ? `<span style="font-size:0.65rem;color:#00c8ff;">🔒 Qty: <b>${Number(t.lockQty) < 1 ? Number(t.lockQty).toFixed(3) : Number(t.lockQty).toFixed(2)}</b></span>` : ''}
                    </div>` : ''}
                </div>
                <div style="color:${(t.pl || 0) >= 0 ? '#00ff41' : '#ff3131'}; font-weight:bold; font-size:1rem;">
                    ${(t.pl || 0) >= 0 ? '+' : ''}${t._curr||'$'}${Math.abs(t.pl || 0).toFixed(2)}
                </div>
            </div>
        </div>
    `).join('');

    document.getElementById('tradeModal').style.display = 'block';
};

// ──────────────────────────────────────────────
// VIEW DEEP DIVE (Single trade detail)
// ──────────────────────────────────────────────
window.viewDeepDive = function (nodeIdxStr, fbKey) {
    const nodeIdx = parseInt(nodeIdxStr);
    const t = allTrades.find(x => x._nodeIdx === nodeIdx && x._fbKey === fbKey);
    if (!t) return;

    const viosHtml   = (t.vios || []).length > 0
        ? t.vios.map(v => `<span class="tag red">${v}</span>`).join('')
        : '<span class="tag green">Clean Session</span>';
    const scalesHtml = (t.scale || []).map(s => `<span class="tag green">${s}</span>`).join('') || '—';
    const smcHtml    = (t.smcFlags || []).length > 0
        ? t.smcFlags.map(f => `<span class="tag" style="color:#c5a059;border-color:#c5a059;">${f}</span>`).join('')
        : '<span style="color:#444;font-size:0.7rem;">None recorded</span>';

    // Pre-entry record for same date + node
    const peRecords = preentryData?.[t.clusterId]?.[t.nodeIdx];
    const todayPE   = peRecords
        ? Object.values(peRecords).filter(r => r.date === t.date).sort((a,b) => (b.savedAt||'').localeCompare(a.savedAt||''))
        : [];
    const bestPE = todayPE[0];

    document.getElementById('modalTitle').innerText = `Deep-Dive: ${t.date} | ${t._nodeTitle}`;
    document.getElementById('modalBody').innerHTML = `
        <button onclick="openDayTrades('${t.date}', allTradesForDate('${t.date}'))"
            style="background:#222;color:#aaa;border:1px solid #444;padding:7px 14px;margin:12px 0;cursor:pointer;border-radius:4px;width:auto;font-size:0.75rem;">
            ← Back to Day
        </button>

        <div class="detail-grid">
            <div class="info-pane">
                <h3 style="color:var(--gold);margin-top:0;font-size:0.85rem;">1. EXECUTION CONTEXT</h3>
                <p><b>Asset:</b> ${t.asset||'—'} | <b>Position:</b> ${t.position||'—'}</p>
                <p><b>Entry:</b> ${t.entry||'—'} | <b>Exit:</b> ${t.exit||'—'}</p>
                <p><b>Outcome:</b> <span style="color:${t.type==='Target'?'#00ff41':'#ff5252'}">${t.type||'—'}</span> (${t.grade||'—'})</p>
                <p><b>Liquidity:</b> ${t.liq||'—'}</p>
                <p><b>Net P/L:</b> <span style="color:${(t.pl||0)>=0?'#00ff41':'#ff5252'};font-size:1.1rem;font-weight:bold;">
                    ${(t.pl||0)>=0?'+':''}${t._curr||'$'}${Math.abs(t.pl||0).toFixed(2)}</span></p>
            </div>
            <div class="info-pane">
                <h3 style="color:var(--gold);margin-top:0;font-size:0.85rem;">2. INSTITUTIONAL BIAS</h3>
                ${t.biasResult ? `<p style="color:#c5a059;font-size:0.78rem;font-weight:bold;">${t.biasResult}</p>` : '<p style="color:#444;">No bias recorded</p>'}
                ${t.htfMs ? `<p style="font-size:0.73rem;"><b>HTF:</b> <span style="color:#4a9eff">${t.htfMs}</span>${t.htfZone?' · '+t.htfZone:''}</p>` : ''}
                ${t.ltfMs ? `<p style="font-size:0.73rem;"><b>LTF:</b> <span style="color:#4a9eff">${t.ltfMs}</span>${t.ltfCandle?' · '+t.ltfCandle:''}</p>` : ''}
                ${t.conflict ? `<p style="color:#ff6600;font-size:0.7rem;"><b>⚠ CONFLICT:</b> ${t.conflict.slice(0,120)}</p>` : ''}
                <p style="margin-top:6px;"><b>SMC Active:</b><br>${smcHtml}</p>
            </div>
        </div>

        <div class="detail-grid" style="margin-top:14px;">
            <div class="info-pane">
                <h3 style="color:var(--gold);margin-top:0;font-size:0.85rem;">3. SYSTEM HEALTH</h3>
                <p><b>Violations:</b><br>${viosHtml}</p>
                <p><b>Scales Booked:</b><br>${scalesHtml}</p>
            </div>
            ${bestPE ? `
            <div class="info-pane" style="border-color:#1a2a00;">
                <h3 style="color:var(--accent);margin-top:0;font-size:0.85rem;">4. PRE-ENTRY ANALYSIS</h3>
                <p><b>Score:</b> <span style="color:${bestPE.score>=75?'var(--accent)':bestPE.score>=50?'var(--gold)':'var(--danger)'};font-size:1rem;font-weight:900;font-family:monospace;">${bestPE.score}/100</span></p>
                <p style="font-size:0.7rem;"><b>Timer:</b> ${Math.floor((bestPE.timerSecs||0)/60)}m ${(bestPE.timerSecs||0)%60}s analysis</p>
                ${bestPE.direction ? `<p style="font-size:0.7rem;"><b>Planned:</b> ${bestPE.direction} · RR ${bestPE.rrPlanned||'—'}</p>` : ''}
                ${bestPE.note ? `<p style="font-size:0.68rem;color:#888;font-style:italic;">"${bestPE.note.slice(0,120)}"</p>` : ''}
                ${bestPE.conflict ? `<p style="color:#ff6600;font-size:0.65rem;">⚠ Conflict noted pre-trade</p>` : ''}
                ${(bestPE.lockRiskAmt != null || bestPE.lockQty != null) ? `
                <div style="margin-top:8px;padding:8px 10px;background:#000;border:1px solid #003344;border-radius:5px;">
                    <div style="font-size:0.52rem;color:#555;letter-spacing:2px;margin-bottom:5px;">🔒 LOCKED FROM PRE-ENTRY</div>
                    <div style="display:flex;gap:18px;">
                        ${bestPE.lockRiskAmt != null ? `<div><div style="font-size:0.52rem;color:#555;">LOCK RISK</div><div style="font-size:1rem;font-weight:bold;color:#00c8ff;font-family:monospace;">${t._curr||'$'}${Number(bestPE.lockRiskAmt).toFixed(2)}</div></div>` : ''}
                        ${bestPE.lockQty != null ? `<div><div style="font-size:0.52rem;color:#555;">LOCK QTY</div><div style="font-size:1rem;font-weight:bold;color:#00c8ff;font-family:monospace;">${Number(bestPE.lockQty)<1?Number(bestPE.lockQty).toFixed(3):Number(bestPE.lockQty).toFixed(2)}</div></div>` : ''}
                    </div>
                </div>` : ''}
            </div>` : `
            <div class="info-pane" style="border-color:#1a1a00;">
                <h3 style="color:#444;margin-top:0;font-size:0.85rem;">4. PRE-ENTRY ANALYSIS</h3>
                <p style="color:#444;font-size:0.75rem;">No pre-entry record for this date.<br>Use PRE-ENTRY page before trading.</p>
            </div>`}
        </div>

        <div class="info-pane" style="margin-top:14px;">
            <h3 style="color:var(--gold);margin-top:0;font-size:0.85rem;">5. PSYCHOLOGY & LESSONS</h3>
            <div style="font-size:0.83rem;line-height:1.7;">
                <p><b>Plan vs Emotion:</b> ${(t.psy||[])[0]||'—'}</p>
                <p><b>Setup Quality:</b>   ${(t.psy||[])[1]||'—'}</p>
                <p><b>Patience:</b>         ${(t.psy||[])[2]||'—'}</p>
                <p><b>Focus / Neutrality:</b> ${(t.psy||[])[3]||'—'}</p>
                <p><b>Emotional Bias:</b>   ${(t.psy||[])[4]||'—'}</p>
                <p style="background:#000;padding:10px;border-left:3px solid var(--accent);border-radius:4px;">
                    <b>Master Lesson:</b> ${(t.psy||[])[5]||'—'}
                </p>
            </div>
        </div>

        ${t.image ? `
        <div style="margin-top:16px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <b style="color:var(--gold);font-size:0.82rem;">6. TRADE SCREENSHOT</b>
                <button class="del-ss-btn" onclick="deleteScreenshot('${nodeIdxStr}','${fbKey}')">🗑 Delete Screenshot</button>
            </div>
            <img src="${t.image}" class="screenshot-img">
        </div>` : `
        <div style="padding:20px;text-align:center;color:#444;background:#0a0a0a;border-radius:8px;margin-top:16px;border:1px dashed #333;">No Screenshot Found</div>`}

        <button onclick="downloadTradePDF('${nodeIdxStr}','${fbKey}')"
            style="width:100%;background:var(--gold);color:#000;padding:13px;font-weight:bold;margin-top:18px;border:none;border-radius:6px;cursor:pointer;font-size:0.9rem;">
            ⬇ DOWNLOAD PDF REPORT
        </button>
    `;
};

// ──────────────────────────────────────────────
// HELPER — Get all trades for a specific date (filtered by current acc filter)
// ──────────────────────────────────────────────
window.allTradesForDate = function (date) {
    const accVal = document.getElementById('accFilter').value;
    let src = allTrades.filter(t => t.date === date);
    if (accVal !== 'ALL') src = src.filter(t => t._nodeIdx === parseInt(accVal));
    return src;
};

// ──────────────────────────────────────────────
// DELETE SCREENSHOT — from Firebase + update UI
// ──────────────────────────────────────────────
window.deleteScreenshot = async function (nodeIdxStr, fbKey) {
    if (!confirm('Delete this screenshot permanently from Firebase?\n\nIt will also disappear in Trade History on index.html.')) return;

    const nodeIdx = parseInt(nodeIdxStr);
    const path    = `isi_v6/clusters/${selectedClusterId}/nodes/${nodeIdx}/tradeHistory/${fbKey}/image`;

    try {
        await update(ref(db, `isi_v6/clusters/${selectedClusterId}/nodes/${nodeIdx}/tradeHistory/${fbKey}`), {
            image: null
        });

        // Update local state
        const t = allTrades.find(x => x._nodeIdx === nodeIdx && x._fbKey === fbKey);
        if (t) t.image = null;

        alert('✅ Screenshot deleted from Firebase successfully!');
        // Re-render deep dive without screenshot
        viewDeepDive(nodeIdxStr, fbKey);
    } catch (err) {
        alert('Error: ' + err.message);
    }
};

// ──────────────────────────────────────────────
// DOWNLOAD TRADE PDF
// ──────────────────────────────────────────────
window.downloadTradePDF = function (nodeIdxStr, fbKey) {
    const t = allTrades.find(x => x._nodeIdx === parseInt(nodeIdxStr) && x._fbKey === fbKey);
    if (!t) return;

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFillColor(10, 10, 10); doc.rect(0, 0, 210, 297, 'F');
    doc.setTextColor(197, 160, 89); doc.setFontSize(18);
    doc.text('ISI INSTITUTIONAL TRADE REPORT', 14, 20);

    const rows = [
        ['Date', t.date || '—'], ['Account', t._nodeTitle || '—'],
        ['Asset', t.asset || '—'], ['Position', t.position || '—'],
        ['Outcome', t.type || '—'], ['Net P/L', `$${(t.pl || 0).toFixed(2)}`],
        ['Entry', t.entry || '—'], ['Exit', t.exit || '—'],
        ['Grade', t.grade || '—'], ['Liquidity', t.liq || '—'],
        ['Scales', (t.scale || []).join(', ') || 'None'],
        ['Violations', (t.vios || []).join(', ') || 'None'],
        ['Plan vs Emotion', (t.psy || [])[0] || '—'],
        ['Setup Quality', (t.psy || [])[1] || '—'],
        ['Master Lesson', (t.psy || [])[5] || '—']
    ];

    doc.setTextColor(255, 255, 255);
    doc.autoTable({ startY: 30, body: rows, theme: 'grid', styles: { fontSize: 9 } });

    if (t.image) {
        doc.addPage();
        doc.setTextColor(197, 160, 89); doc.setFontSize(14);
        doc.text('EXECUTION PROOF', 14, 15);
        doc.addImage(t.image, t.image.includes('png') ? 'PNG' : 'JPEG', 10, 22, 190, 130);
    }

    doc.save(`Journal_${t.date || 'trade'}_${t._nodeTitle || 'node'}.pdf`);
};

// ──────────────────────────────────────────────
// CLOSE MODAL
// ──────────────────────────────────────────────
window.closeModal = function () {
    document.getElementById('tradeModal').style.display = 'none';
};
window.onclick = function (e) {
    if (e.target.classList.contains('mon-modal')) closeModal();
};

// ──────────────────────────────────────────────
// AI WEEKLY COACH — monitoring page
// ──────────────────────────────────────────────
window.runAIWeeklyCoach = async function () {
    showAILoading('aiCoachBox');

    // Build stats from allTrades
    const wins   = allTrades.filter(t => t.type === 'Target').length;
    const losses = allTrades.filter(t => t.type === 'Stop Loss').length;
    const totalPL = allTrades.reduce((s, t) => s + (t.pl || 0), 0);
    const winRate = allTrades.length ? ((wins / allTrades.length) * 100).toFixed(1) : 0;

    // Violations count
    const vioCount = {};
    allTrades.forEach(t => (t.vios || []).forEach(v => { vioCount[v] = (vioCount[v]||0)+1; }));
    const violations = Object.entries(vioCount).sort((a,b)=>b[1]-a[1]).map(([v])=>v);

    // Grade distribution
    const gradeCount = {};
    allTrades.forEach(t => { if(t.grade) gradeCount[t.grade] = (gradeCount[t.grade]||0)+1; });

    // Best asset
    const assetPL = {};
    allTrades.forEach(t => { assetPL[t.asset||'?'] = (assetPL[t.asset||'?']||0) + (t.pl||0); });
    const assets = Object.entries(assetPL).sort((a,b)=>b[1]-a[1]).map(([a])=>a);

    // Best day
    const dayPL = {};
    allTrades.forEach(t => {
        if (!t.date) return;
        const day = new Date(t.date).toLocaleDateString('en-GB',{weekday:'long'});
        dayPL[day] = (dayPL[day]||0) + (t.pl||0);
    });
    const days = Object.entries(dayPL).sort((a,b)=>b[1]-a[1]).map(([d])=>d);

    const result = await aiWeeklyCoach({
        trades: allTrades.length, wins, losses,
        totalPL, winRate, violations,
        grades: gradeCount, assets, days
    });
    renderAIResponse('aiCoachBox', result, '🤖 AI Weekly Performance Coach');
};
