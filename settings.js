import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, set, update, onValue, remove, get, push as _fbPush } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getStorage, ref as sRef, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

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

// ═══════════════════════════════════════════════════════
// BLOCK 2 — KNOWLEDGE BASE (Settings page)
// ═══════════════════════════════════════════════════════
import { getDatabase as _getDB, ref as _ref, onValue as _onVal, push as _push, remove as _rem, update as _upd }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const _kbDB = _getDB();
let _kbEntries  = {};
let _kbEditKey  = null;
let _kbActiveCat = 'ALL';
let _kbFileData  = null;   // { name, type, size, base64, ext }
let _kbSubCount  = 0;      // sub-section counter
let _kbActiveTab = 'upload'; // 'upload' | 'text'

_onVal(_ref(_kbDB, 'isi_v6/knowledge/entries'), snap => {
    _kbEntries = snap.val() || {};
    renderKBList();
    updateKBStats();
    buildKBLinkDropdown();
});

window.onKBCatSelect = function() {
    _kbActiveCat = document.getElementById('kbCatDropdown').value;
    renderKBList();
};

// ── FILE ICONS BY EXTENSION ──
function getFileIcon(ext) {
    const m = { pdf:'📄', doc:'📝', docx:'📝', xls:'📊', xlsx:'📊',
                txt:'📃', png:'🖼', jpg:'🖼', jpeg:'🖼', gif:'🖼',
                webp:'🖼', csv:'📊', ppt:'📋', pptx:'📋' };
    return m[ext] || '📁';
}

// ── FILE UPLOAD HANDLERS ──
window.switchKBTab = function(tab) {
    _kbActiveTab = tab;
    const up = document.getElementById('tabUpload');
    const tx = document.getElementById('tabText');
    const bu = document.getElementById('tabUploadBtn');
    const bt = document.getElementById('tabTextBtn');
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

window.handleKBDrop = function(e) {
    e.preventDefault();
    document.getElementById('kbDropZone').style.borderColor = '#333';
    const file = e.dataTransfer.files[0];
    if (file) handleKBFile(file);
};

window.handleKBFile = function(file) {
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    _kbFileData = { file, name: file.name, type: file.type, size: file.size, ext };
    document.getElementById('kbFilePreview').style.display = 'block';
    document.getElementById('kbFileIcon').textContent = getFileIcon(ext);
    document.getElementById('kbFileName').textContent = file.name;
    document.getElementById('kbFileSize').textContent = (file.size/1024/1024).toFixed(2) + ' MB';
    document.getElementById('kbDropZone').style.display = 'none';
};

window.clearKBFile = function() {
    _kbFileData = null;
    document.getElementById('kbFilePreview').style.display = 'none';
    document.getElementById('kbDropZone').style.display = 'block';
    document.getElementById('kbFileInput').value = '';
};

// ── SUB-SECTIONS ──
window.addKBSubSection = function() {
    _kbSubCount++;
    const id = 'sub_' + _kbSubCount;
    const container = document.getElementById('kbSubSections');
    const div = document.createElement('div');
    div.id = id;
    div.style.cssText = 'background:#050505;border:1px solid #1a1a1a;border-radius:6px;padding:12px;position:relative;';
    div.innerHTML = `
        <button onclick="document.getElementById('${id}').remove()"
            style="position:absolute;top:8px;right:8px;background:var(--danger);color:#fff;border:none;padding:2px 8px;border-radius:3px;font-size:0.6rem;cursor:pointer;">✕</button>

        <div style="font-size:0.6rem;color:#c5a059;letter-spacing:1px;margin-bottom:8px;font-weight:bold;">SUB-SECTION ${_kbSubCount}</div>

        <div style="font-size:0.58rem;color:#555;margin-bottom:4px;">SUB-TITLE</div>
        <input type="text" placeholder="Sub-section title..."
            style="width:100%;background:#111;color:#fff;border:1px solid #222;padding:7px;border-radius:4px;font-size:0.72rem;margin-bottom:8px;"
            data-sub-title="${_kbSubCount}">

        <div style="display:flex;gap:6px;margin-bottom:8px;">
            <button onclick="switchSubTab(${_kbSubCount},'file')"
                id="subTabFile_${_kbSubCount}"
                style="padding:4px 10px;border-radius:3px;font-size:0.62rem;font-weight:bold;cursor:pointer;border:1px solid var(--gold);background:#1a1200;color:var(--gold);">
                📁 FILE
            </button>
            <button onclick="switchSubTab(${_kbSubCount},'text')"
                id="subTabText_${_kbSubCount}"
                style="padding:4px 10px;border-radius:3px;font-size:0.62rem;font-weight:bold;cursor:pointer;border:1px solid #333;background:#111;color:#666;">
                ✏ TEXT
            </button>
        </div>

        <div id="subFile_${_kbSubCount}">
            <div onclick="document.getElementById('subFileInput_${_kbSubCount}').click()"
                style="border:1px dashed #333;border-radius:4px;padding:14px;text-align:center;cursor:pointer;font-size:0.68rem;color:#555;">
                📁 Click to upload file
            </div>
            <input type="file" id="subFileInput_${_kbSubCount}" style="display:none" accept="*/*"
                onchange="handleSubFile(${_kbSubCount}, this.files[0])">
            <div id="subFilePreview_${_kbSubCount}" style="display:none;margin-top:6px;background:#111;border:1px solid #222;border-radius:4px;padding:8px;font-size:0.68rem;color:#888;"></div>
        </div>

        <div id="subText_${_kbSubCount}" style="display:none;">
            <textarea placeholder="Sub-section content..."
                style="width:100%;background:#111;color:#ccc;border:1px solid #222;padding:8px;border-radius:4px;font-size:0.7rem;resize:vertical;min-height:80px;line-height:1.5;"
                data-sub-text="${_kbSubCount}"></textarea>
        </div>`;
    container.appendChild(div);
};

window.switchSubTab = function(n, tab) {
    document.getElementById('subFile_' + n).style.display = tab === 'file' ? 'block' : 'none';
    document.getElementById('subText_' + n).style.display = tab === 'text' ? 'block' : 'none';
    document.getElementById('subTabFile_' + n).style.cssText += tab === 'file'
        ? ';border-color:var(--gold);background:#1a1200;color:var(--gold);'
        : ';border-color:#333;background:#111;color:#666;';
    document.getElementById('subTabText_' + n).style.cssText += tab === 'text'
        ? ';border-color:var(--gold);background:#1a1200;color:var(--gold);'
        : ';border-color:#333;background:#111;color:#666;';
};

window.handleSubFile = function(n, file) {
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    const prev = document.getElementById('subFilePreview_' + n);
    prev.style.display = 'block';
    prev.innerHTML = `${getFileIcon(ext)} <b>${file.name}</b> (${(file.size/1024/1024).toFixed(2)}MB)`;
    prev.dataset.name = file.name;
    prev.dataset.type = file.type;
    prev.dataset.ext  = ext;
    prev._file = file; // store raw file reference
};

// ── RENDER LIST ──
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

    const typeCols = {SOP:'#4a9eff',Checklist:'#00c805',Notes:'var(--gold)',Training:'#cc44ff',Structure:'#ff5252'};
    const typeIcons = {SOP:'📘',Checklist:'✅',Notes:'📝',Training:'🎓',Structure:'📊'};

    container.innerHTML = entries.map(([key,e]) => {
        const col  = typeCols[e.type] || '#888';
        const ico  = typeIcons[e.type] || '📁';
        const children = Object.entries(_kbEntries).filter(([,en]) => en.linkedTo === key);
        const hasFile = !!(e.file?.base64);
        const hasSubs = e.subSections && Object.keys(e.subSections).length > 0;
        return `
        <div style="background:#0a0a0a;border:1px solid #1a1a1a;border-left:4px solid ${col};border-radius:6px;margin-bottom:8px;overflow:hidden;">
            <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;"
                onclick="toggleKBCard('kbc_${key}')">
                <span style="font-size:0.9rem;">${ico}</span>
                <span style="font-size:0.58rem;border:1px solid ${col};color:${col};padding:1px 5px;border-radius:3px;font-weight:bold;text-transform:uppercase;flex-shrink:0;">${e.type}</span>
                <span style="flex:1;font-size:0.75rem;font-weight:bold;color:#ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${e.title}</span>
                ${hasFile?'<span style="font-size:0.55rem;background:#001a10;color:#00c805;border:1px solid #006600;padding:1px 5px;border-radius:3px;">📎 FILE</span>':''}
                ${hasSubs?`<span style="font-size:0.55rem;background:#0a0800;color:var(--gold);border:1px solid #444;padding:1px 5px;border-radius:3px;">${Object.keys(e.subSections).length} SUBS</span>`:''}
                <span style="font-size:0.58rem;color:#333;">${e.createdAt?new Date(e.createdAt).toLocaleDateString('en-GB'):''}</span>
                <div style="display:flex;gap:4px;flex-shrink:0;" onclick="event.stopPropagation()">
                    <button onclick="openKBInPage('${key}')" style="background:transparent;border:1px solid #222;color:#555;padding:3px 8px;border-radius:3px;font-size:0.6rem;cursor:pointer;" onmouseover="this.style.color='#4a9eff';this.style.borderColor='#4a9eff'" onmouseout="this.style.color='#555';this.style.borderColor='#222'">VIEW</button>
                    <button onclick="openKBEditEntry('${key}')" style="background:transparent;border:1px solid #222;color:#555;padding:3px 8px;border-radius:3px;font-size:0.6rem;cursor:pointer;" onmouseover="this.style.color='var(--gold)';this.style.borderColor='var(--gold)'" onmouseout="this.style.color='#555';this.style.borderColor='#222'">EDIT</button>
                    <button onclick="deleteKBEntry('${key}')" style="background:transparent;border:1px solid #222;color:#555;padding:3px 8px;border-radius:3px;font-size:0.6rem;cursor:pointer;" onmouseover="this.style.color='var(--danger)';this.style.borderColor='var(--danger)'" onmouseout="this.style.color='#555';this.style.borderColor='#222'">🗑</button>
                </div>
            </div>
            <div id="kbc_${key}" style="display:none;padding:10px 12px;border-top:1px solid #111;background:#050505;">
                ${e.desc?`<div style="font-size:0.68rem;color:#666;margin-bottom:8px;">${e.desc}</div>`:''}
                ${e.content?`<div style="font-size:0.68rem;color:#555;line-height:1.5;max-height:50px;overflow:hidden;">${e.content.slice(0,180)}...</div>`:''}
                ${children.length?`
                <div style="margin-top:8px;padding-top:8px;border-top:1px solid #0d0d0d;">
                    <div style="font-size:0.55rem;color:#444;letter-spacing:1px;margin-bottom:5px;">🔗 LINKED</div>
                    ${children.map(([ck,ce])=>`
                    <div onclick="openKBInPage('${ck}')" style="display:inline-flex;align-items:center;gap:5px;background:#0a0a0a;border:1px solid #222;padding:3px 8px;border-radius:4px;font-size:0.62rem;color:#666;cursor:pointer;margin:2px;">
                        ${typeIcons[ce.type]||'📁'} ${ce.title}
                    </div>`).join('')}
                </div>`:''}
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
    const st = document.getElementById('kbSettingsStats');
    if (!st) return;
    const c = t => all.filter(e=>e.type===t).length;
    st.textContent = `Total: ${all.length}  ·  SOP: ${c('SOP')}  ·  Checklist: ${c('Checklist')}  ·  Notes: ${c('Notes')}  ·  Training: ${c('Training')}`;
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

// ── OPEN MODAL ──
window.openKBAddEntry = function() {
    _kbEditKey = null;
    _kbFileData = null;
    _kbSubCount = 0;
    document.getElementById('kbModalHeading').textContent = 'ADD NEW ENTRY';
    ['kbEntryTitle','kbEntryDesc','kbEntryContent','kbEntryTags'].forEach(id => {
        const el = document.getElementById(id); if(el) el.value='';
    });
    document.getElementById('kbEntryType').value = _kbActiveCat !== 'ALL' ? _kbActiveCat : 'SOP';
    document.getElementById('kbSubSections').innerHTML = '';
    clearKBFile();
    buildKBLinkDropdown();
    switchKBTab('upload');
    const m = document.getElementById('kbAddModal');
    m.style.display = 'flex';
    setTimeout(() => document.getElementById('kbEntryTitle').focus(), 100);
};

window.openKBEditEntry = function(key) {
    const e = _kbEntries[key]; if(!e) return;
    _kbEditKey = key;
    _kbFileData = e.file || null;
    _kbSubCount = 0;
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
        switchKBTab('upload');
        _kbFileData = e.file; // has .url not .file
        document.getElementById('kbFilePreview').style.display = 'block';
        document.getElementById('kbDropZone').style.display = 'none';
        document.getElementById('kbFileIcon').textContent = getFileIcon(e.file.ext||'');
        document.getElementById('kbFileName').textContent = e.file.name || 'File';
        document.getElementById('kbFileSize').textContent = ((e.file.size||0)/1024/1024).toFixed(2) + ' MB';
    } else if (e.content) {
        switchKBTab('text');
    }
    document.getElementById('kbAddModal').style.display = 'flex';
};

window.closeKBModal = function() {
    document.getElementById('kbAddModal').style.display = 'none';
    _kbEditKey = null;
    _kbFileData = null;
};

// ── UPLOAD FILE TO FIREBASE STORAGE ──
async function uploadFileToStorage(file, path) {
    const storageRef = sRef(storage, path);
    await uploadBytes(storageRef, file);
    const url = await getDownloadURL(storageRef);
    return url;
}

// ── SAVE ENTRY ──
window.saveKBEntry = async function() {
    const title = document.getElementById('kbEntryTitle').value.trim();
    if (!title) { alert('Title required!'); return; }

    const btn = document.querySelector('button[onclick="saveKBEntry()"]');
    if (btn) { btn.textContent = '⏳ Uploading...'; btn.disabled = true; }

    try {
        const entryId = _kbEditKey || ('kb_' + Date.now());

        // Upload main file to Storage if present
        let fileData = null;
        if (_kbActiveTab === 'upload' && _kbFileData?.file) {
            const path = `knowledge/${entryId}/main_${_kbFileData.name}`;
            if (btn) btn.textContent = '⏳ Uploading file...';
            const url = await uploadFileToStorage(_kbFileData.file, path);
            fileData = { url, name: _kbFileData.name, type: _kbFileData.type, ext: _kbFileData.ext, size: _kbFileData.size, path };
        } else if (_kbEditKey && _kbFileData?.url) {
            fileData = _kbFileData; // keep existing
        }

        // Upload sub-section files
        const subs = {};
        const subEls = document.querySelectorAll('[data-sub-title]');
        for (const el of subEls) {
            const n   = el.dataset.subTitle;
            const txt = document.querySelector(`[data-sub-text="${n}"]`)?.value?.trim() || '';
            const fp  = document.getElementById('subFilePreview_' + n);
            let subFile = null;
            if (fp && fp.style.display !== 'none' && fp._file) {
                const subPath = `knowledge/${entryId}/sub${n}_${fp.dataset.name}`;
                if (btn) btn.textContent = `⏳ Uploading sub-file ${n}...`;
                const subUrl = await uploadFileToStorage(fp._file, subPath);
                subFile = { url: subUrl, name: fp.dataset.name, type: fp.dataset.type, ext: fp.dataset.ext, path: subPath };
            } else if (fp && fp.dataset.url) {
                subFile = { url: fp.dataset.url, name: fp.dataset.name, type: fp.dataset.type, ext: fp.dataset.ext };
            }
            subs['sub' + n] = { title: el.value.trim(), text: txt, file: subFile };
        }

        const entry = {
            title,
            type:        document.getElementById('kbEntryType').value,
            desc:        document.getElementById('kbEntryDesc').value.trim(),
            tags:        document.getElementById('kbEntryTags').value.trim(),
            linkedTo:    document.getElementById('kbEntryLink').value || '',
            content:     _kbActiveTab === 'text' ? (document.getElementById('kbEntryContent').value.trim()) : '',
            file:        fileData,
            subSections: Object.keys(subs).length ? subs : null,
            updatedAt:   new Date().toISOString()
        };

        if (btn) btn.textContent = '⏳ Saving to DB...';

        if (_kbEditKey) {
            await update(ref(db, `isi_v6/knowledge/entries/${_kbEditKey}`), entry);
        } else {
            entry.createdAt = new Date().toISOString();
            await _fbPush(ref(db, 'isi_v6/knowledge/entries'), entry);
        }
        closeKBModal();
    } catch(err) {
        alert('Save failed: ' + err.message);
        console.error(err);
    } finally {
        if (btn) { btn.textContent = '💾 SAVE TO FIREBASE'; btn.disabled = false; }
    }
};

// ── DELETE WITH MATH CAPTCHA ──
window.deleteKBEntry = function(key) {
    const e = _kbEntries[key]; if(!e) return;
    const ops = ['+','-','×'];
    const op  = ops[Math.floor(Math.random()*3)];
    let a = Math.floor(Math.random()*10)+1;
    let b = Math.floor(Math.random()*10)+1;
    if (op==='-' && b>a) [a,b]=[b,a];
    const ans = op==='+'?a+b:op==='-'?a-b:a*b;
    const userAns = prompt(`⚠ DELETE "${e.title}"?

Confirm karo: ${a} ${op} ${b} = ?`);
    if (userAns === null) return;
    if (parseInt(userAns) !== ans) { alert('❌ Galat answer! Delete cancel.'); return; }
    _rem(_ref(_kbDB, `isi_v6/knowledge/entries/${key}`));
};

// ── INIT ──
document.addEventListener('DOMContentLoaded', () => {
    buildAIDropdown();
});
