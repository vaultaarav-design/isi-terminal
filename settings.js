import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, set, update, onValue, remove, get } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

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
// BUILD NODE UI
// ─────────────────────────────────────────────────────────
window.buildNodeUI = function(existingNodes = null) {
    const qty  = parseInt(document.getElementById('nodeQty').value);
    const grid = document.getElementById('nodeGrid');
    grid.innerHTML = '';
    if (qty === 0) return;

    for (let i = 0; i < qty; i++) {
        const ex      = existingNodes ? (existingNodes[i] || {}) : {};
        const exTimes = ex.times || {};
        let dayHtml   = '';

        days.forEach(day => {
            const t = exTimes[day] || {};
            dayHtml += `
            <div class="day-card">
                <div class="day-name">${day}</div>
                <div class="day-times">
                    <input type="time" class="time-start"  data-day="${day}" data-node="${i}" value="${t.start  ||''}">
                    <input type="time" class="time-end"    data-day="${day}" data-node="${i}" value="${t.end    ||''}">
                    <input type="time" class="time-expire" data-day="${day}" data-node="${i}" value="${t.expire ||''}">
                </div>
            </div>`;
        });

        grid.innerHTML += `
        <div class="node-setup-card">
            <div class="input-row">
                <input type="text"   class="node-title"   placeholder="Account Name" value="${ex.title   || 'Account '+(i+1)}">
                <select class="node-curr">
                    <option value="$" ${(ex.curr||'$')==='$'?'selected':''}>$ USD</option>
                    <option value="₹" ${(ex.curr||'')==='₹'?'selected':''}>₹ INR</option>
                </select>
                <input type="number" class="node-balance" placeholder="Setup Balance (initial capital)" value="${ex.balance ?? 100000}" title="Setup/Initial Balance — NOT live trading balance">
            </div>
            <div class="days-grid">${dayHtml}</div>
            <div class="risk-qty-row">
                <div style="display:flex;gap:10px;align-items:center;">
                    <label>Risk %</label>
                    <input type="number" class="node-risk"  value="${ex.risk    ?? 0.35}" step="0.01" style="width:60px;">
                </div>
                <div class="qty-range">
                    <label>Qty</label>
                    <input type="number" class="qty-from"  value="${ex.qtyFrom ?? 1}"  style="width:45px;">
                    <span>-</span>
                    <input type="number" class="qty-to"    value="${ex.qtyTo   ?? 10}" style="width:45px;">
                </div>
                <div>
                    <label>Trade #</label>
                    <input type="number" class="node-order" value="${ex.order  ?? (i+1)}" style="width:45px;">
                </div>
            </div>
        </div>`;
    }
};

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
    if (parseInt(document.getElementById('nodeQty').value) === 0) return alert('Nodes select karo!');

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
                    nodeTimes[day] = {
                        start:  card.querySelector(`.time-start[data-day="${day}"][data-node="${i}"]`).value,
                        end:    card.querySelector(`.time-end[data-day="${day}"][data-node="${i}"]`).value,
                        expire: card.querySelector(`.time-expire[data-day="${day}"][data-node="${i}"]`).value
                    };
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
                    nodeTimes[day] = {
                        start:  card.querySelector(`.time-start[data-day="${day}"][data-node="${i}"]`).value,
                        end:    card.querySelector(`.time-end[data-day="${day}"][data-node="${i}"]`).value,
                        expire: card.querySelector(`.time-expire[data-day="${day}"][data-node="${i}"]`).value
                    };
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

    // Per-currency totals (mixed currency clusters handled correctly)
    const byCurrency = {};
    nodes.forEach((n, i) => {
        const c   = n.curr || '$';
        const bal = statsArr[i].currentBal ?? n.balance ?? 0;
        byCurrency[c] = (byCurrency[c] || 0) + bal;
    });
    const aumStr = Object.entries(byCurrency)
        .map(([c, v]) => fmtBal(c, v))
        .join(' + ');

    const totalTrades = statsArr.reduce((s, st) => s + (st.trades || 0), 0);

    const netByCurr = {};
    nodes.forEach((n, i) => {
        const c = n.curr || '$';
        netByCurr[c] = (netByCurr[c] || 0) + (statsArr[i].net || 0);
    });
    const netStr = Object.entries(netByCurr)
        .map(([c, v]) => `<span style="color:${v>=0?'var(--accent)':'var(--danger)'};">${v>=0?'+':''}${fmtBal(c,v)}</span>`)
        .join(' ');

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

// ─────────────────────────────────────────────────────────
// MULTI-AI KEY MANAGEMENT
// ─────────────────────────────────────────────────────────
const AI_PROVIDERS = {
    gemini:     { label:'Gemini 2.0 Flash',    icon:'🟡' },
    groq:       { label:'Groq Llama 3.3 70B',  icon:'🟢' },
    openrouter: { label:'OpenRouter Mistral',   icon:'🔵' },
    cohere:     { label:'Cohere Command',       icon:'🟣' }
};

window.saveKey = function (provider) {
    const val = document.getElementById('key_' + provider)?.value?.trim();
    const st  = document.getElementById('status_' + provider);
    if (!val) {
        if (st) { st.textContent = '⚠ Key empty hai'; st.style.color = '#ff5252'; }
        return;
    }
    localStorage.setItem('isi_key_' + provider, val);
    if (st) { st.textContent = '✅ Saved! AI active ho gayi.'; st.style.color = '#00c805'; }
    refreshStatusRow();
};

window.testKey = async function (provider) {
    const key = document.getElementById('key_' + provider)?.value?.trim()
             || localStorage.getItem('isi_key_' + provider) || '';
    const st  = document.getElementById('status_' + provider);
    if (!key) {
        if (st) { st.textContent = '⚠ Pehle key enter karo'; st.style.color = '#ff6600'; }
        return;
    }
    if (st) { st.textContent = '⏳ Testing...'; st.style.color = '#888'; }

    try {
        let ok = false;
        if (provider === 'gemini') {
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
                { method:'POST', headers:{'Content-Type':'application/json'},
                  body: JSON.stringify({contents:[{parts:[{text:'Say OK'}]}],generationConfig:{maxOutputTokens:5}}) });
            ok = r.ok;
        } else if (provider === 'groq') {
            const r = await fetch('https://api.groq.com/openai/v1/chat/completions',
                { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
                  body: JSON.stringify({model:'llama-3.3-70b-versatile',messages:[{role:'user',content:'Say OK'}],max_tokens:5}) });
            ok = r.ok;
        } else if (provider === 'openrouter') {
            const r = await fetch('https://openrouter.ai/api/v1/chat/completions',
                { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+key,'HTTP-Referer':location.origin},
                  body: JSON.stringify({model:'mistralai/mistral-7b-instruct:free',messages:[{role:'user',content:'Say OK'}],max_tokens:5}) });
            ok = r.ok;
        } else if (provider === 'cohere') {
            const r = await fetch('https://api.cohere.ai/v1/generate',
                { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
                  body: JSON.stringify({model:'command',prompt:'Say OK',max_tokens:5}) });
            ok = r.ok;
        }
        if (st) {
            st.textContent = ok ? '✅ Key valid hai! AI ready.' : '❌ Key invalid ya expired.';
            st.style.color = ok ? '#00c805' : '#ff5252';
        }
    } catch(e) {
        if (st) { st.textContent = '❌ Network error: ' + e.message; st.style.color = '#ff5252'; }
    }
};

window.saveAIProvider = function () {
    const val = document.getElementById('aiProviderSel')?.value;
    if (val) localStorage.setItem('isi_ai_provider', val);
};

function refreshStatusRow() {
    const row = document.getElementById('aiStatusRow');
    if (!row) return;
    row.innerHTML = Object.entries(AI_PROVIDERS).map(([k,p]) => {
        const hasKey = !!(localStorage.getItem('isi_key_' + k));
        const isActive = localStorage.getItem('isi_ai_provider') === k ||
                         (localStorage.getItem('isi_ai_provider') || 'auto') === 'auto' && hasKey;
        return `<span class="ai-badge ${hasKey?'on':'off'}">${p.icon} ${p.label.split(' ')[0]} ${hasKey?'✓':'—'}</span>`;
    }).join('');
}

// Load all saved keys + provider on page open
(function loadAllKeys() {
    Object.keys(AI_PROVIDERS).forEach(p => {
        const saved = localStorage.getItem('isi_key_' + p);
        if (!saved) return;
        const el = document.getElementById('key_' + p);
        if (el) el.value = saved;
        const st = document.getElementById('status_' + p);
        if (st) { st.textContent = '✅ Key saved'; st.style.color = '#00c805'; }
    });
    const pref = localStorage.getItem('isi_ai_provider') || 'auto';
    const sel  = document.getElementById('aiProviderSel');
    if (sel) sel.value = pref;
    const orModel = localStorage.getItem('isi_or_model');
    if (orModel) {
        const ms = document.getElementById('or_model');
        if (ms) ms.value = orModel;
    }
    refreshStatusRow();
})();
