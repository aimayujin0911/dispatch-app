// ===== グローバル =====
const API = '/api';
let map = null;
let mapMarkers = [];
let currentPage = 'dashboard';
let calendarDate = new Date();
let dragState = null;
let resizeState = null;
let justDragged = false;
let shipmentDragState = null;
let _bgSyncTimer = null; // D&D後のバックグラウンド同期タイマー

// ===== モバイル対応 =====
function isMobile() { return window.innerWidth <= 768; }
let _touchTimer = null;
let _touchStartPos = null;
let _touchStartTime = 0;

// ===== ドライバーカラー =====
const _driverColors = [
    { bg: '#dbeafe', text: '#1e40af', border: '#3b82f6', badge: '#eff6ff' },  // 青
    { bg: '#dcfce7', text: '#166534', border: '#22c55e', badge: '#f0fdf4' },  // 緑
    { bg: '#fef3c7', text: '#92400e', border: '#f59e0b', badge: '#fffbeb' },  // 黄
    { bg: '#fce7f3', text: '#9d174d', border: '#ec4899', badge: '#fdf2f8' },  // ピンク
    { bg: '#e0e7ff', text: '#3730a3', border: '#6366f1', badge: '#eef2ff' },  // インディゴ
    { bg: '#ccfbf1', text: '#115e59', border: '#14b8a6', badge: '#f0fdfa' },  // ティール
    { bg: '#fee2e2', text: '#991b1b', border: '#ef4444', badge: '#fef2f2' },  // 赤
    { bg: '#f3e8ff', text: '#6b21a8', border: '#a855f7', badge: '#faf5ff' },  // 紫
    { bg: '#ffedd5', text: '#9a3412', border: '#f97316', badge: '#fff7ed' },  // オレンジ
    { bg: '#e0f2fe', text: '#075985', border: '#0ea5e9', badge: '#f0f9ff' },  // スカイ
    { bg: '#fef9c3', text: '#854d0e', border: '#eab308', badge: '#fefce8' },  // ライム
    { bg: '#ede9fe', text: '#5b21b6', border: '#8b5cf6', badge: '#f5f3ff' },  // バイオレット
];
function getDriverColor(driverId) {
    if (!driverId) return _driverColors[0];
    return _driverColors[(driverId - 1) % _driverColors.length];
}

// ===== ジオコーディング＆距離計算 =====
const _geocodeCache = {}; // 住所 → {lat, lng}

// APIレスポンスの案件データから座標をプリロード（Nominatim呼び出し不要に）
function preloadGeoFromShipments(shipments) {
    for (const s of shipments) {
        if (s.pickup_lat && s.pickup_lng && s.pickup_address) {
            _geocodeCache[s.pickup_address] = { lat: s.pickup_lat, lng: s.pickup_lng };
        }
        if (s.delivery_lat && s.delivery_lng && s.delivery_address) {
            _geocodeCache[s.delivery_address] = { lat: s.delivery_lat, lng: s.delivery_lng };
        }
    }
}

async function geocodeAddress(address) {
    if (!address) return null;
    // 短い住所は無視
    if (address.length < 3) return null;
    // キャッシュチェック
    if (_geocodeCache[address]) return _geocodeCache[address];
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&countrycodes=jp&limit=1`, {
            headers: { 'Accept-Language': 'ja' }
        });
        const data = await res.json();
        if (data && data.length > 0) {
            const result = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
            _geocodeCache[address] = result;
            return result;
        }
    } catch (e) { console.warn('Geocode failed:', address, e); }
    return null;
}

// Haversine公式で2点間の直線距離(km)
function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 直線距離→推定移動時間(分) : 直線×1.4倍÷平均時速
function estimateTravelMinutes(straightKm) {
    const roadKm = straightKm * 1.4;
    // 100km超は高速想定(60km/h)、それ以下は一般道(35km/h)の加重平均
    const avgSpeed = roadKm > 100 ? 55 : roadKm > 50 ? 45 : 35;
    return Math.ceil(roadKm / avgSpeed * 60);
}

// 2つの住所間の移動時間(分)を推定
async function estimateTravelTime(fromAddress, toAddress) {
    const [from, to] = await Promise.all([geocodeAddress(fromAddress), geocodeAddress(toAddress)]);
    if (!from || !to) return null;
    const distKm = haversineDistance(from.lat, from.lng, to.lat, to.lng);
    return { distKm: Math.round(distKm * 10) / 10, minutes: estimateTravelMinutes(distKm), fromCoord: from, toCoord: to };
}

// ドライバーの既存配車と新しい案件の間で移動時間が現実的かチェック
async function checkTravelFeasibility(driverDispatches, newShipment, newStart, newEnd, allShipments) {
    const warnings = [];
    if (!driverDispatches || driverDispatches.length === 0) return warnings;

    for (const d of driverDispatches) {
        const existingShipment = allShipments.find(s => s.id === d.shipment_id);
        if (!existingShipment) continue;

        const dEnd = d.end_time;    // 既存の終了
        const dStart = d.start_time; // 既存の開始

        // 新案件が既存案件の後に来る場合: 既存の降ろし地→新の積み地
        if (newStart >= dEnd) {
            const gapMin = timeToMinutes(newStart) - timeToMinutes(dEnd);
            const travel = await estimateTravelTime(existingShipment.delivery_address, newShipment.pickup_address);
            if (travel && travel.minutes > gapMin) {
                warnings.push(`⚠️ ${existingShipment.client_name}の降ろし地→${newShipment.client_name}の積み地まで推定${travel.minutes}分（${travel.distKm}km）ですが、隙間は${gapMin}分しかありません`);
            }
        }
        // 新案件が既存案件の前に来る場合: 新の降ろし地→既存の積み地
        if (newEnd <= dStart) {
            const gapMin = timeToMinutes(dStart) - timeToMinutes(newEnd);
            const travel = await estimateTravelTime(newShipment.delivery_address, existingShipment.pickup_address);
            if (travel && travel.minutes > gapMin) {
                warnings.push(`⚠️ ${newShipment.client_name}の降ろし地→${existingShipment.client_name}の積み地まで推定${travel.minutes}分（${travel.distKm}km）ですが、隙間は${gapMin}分しかありません`);
            }
        }
    }
    return warnings;
}

function scheduleBgSync(delaySec = 5) {
    if (_bgSyncTimer) clearTimeout(_bgSyncTimer);
    _bgSyncTimer = setTimeout(() => { _bgSyncTimer = null; loadDispatchCalendar(); }, delaySec * 1000);
}
function cancelBgSync() {
    if (_bgSyncTimer) { clearTimeout(_bgSyncTimer); _bgSyncTimer = null; }
}

// ===== テーブルソート =====
const _tableData = {};  // テーブルID → {data, renderFn, sortKey, sortDir}

function setupTableSort(tableId, data, renderFn) {
    _tableData[tableId] = { data: data, renderFn: renderFn, sortKey: null, sortDir: 'asc' };
    // thead のクリックイベント設定
    const tbody = document.getElementById(tableId);
    if (!tbody) return;
    const thead = tbody.closest('table')?.querySelector('thead');
    if (!thead || thead.dataset.sortBound) return;
    thead.dataset.sortBound = '1';
    thead.querySelectorAll('th.sortable').forEach(th => {
        th.addEventListener('click', () => {
            const key = th.dataset.sort;
            const isNum = th.dataset.type === 'number';
            const td = _tableData[tableId];
            if (!td) return;
            // 同じキーなら方向反転、違うキーならasc
            if (td.sortKey === key) {
                td.sortDir = td.sortDir === 'asc' ? 'desc' : 'asc';
            } else {
                td.sortKey = key;
                td.sortDir = 'asc';
            }
            // ソート
            td.data.sort((a, b) => {
                let va = a[key], vb = b[key];
                if (va == null) va = '';
                if (vb == null) vb = '';
                if (isNum) { va = Number(va) || 0; vb = Number(vb) || 0; }
                else { va = String(va).toLowerCase(); vb = String(vb).toLowerCase(); }
                if (va < vb) return td.sortDir === 'asc' ? -1 : 1;
                if (va > vb) return td.sortDir === 'asc' ? 1 : -1;
                return 0;
            });
            // ヘッダーUI更新
            thead.querySelectorAll('th.sortable').forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
            th.classList.add(td.sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
            // 再描画
            td.renderFn(td.data);
        });
    });
}

// ===== 初期化 =====
document.addEventListener('DOMContentLoaded', async () => {
    // URLパラメータからトークン受け取り（サブドメインリダイレクト時）
    const urlParams = new URLSearchParams(location.search);
    if (urlParams.get('auth_token')) {
        localStorage.setItem('access_token', urlParams.get('auth_token'));
        try {
            const authUser = JSON.parse(decodeURIComponent(urlParams.get('auth_user') || '{}'));
            if (authUser.id) localStorage.setItem('user', JSON.stringify(authUser));
        } catch(e) {}
        // URLからパラメータを消す
        history.replaceState(null, '', '/');
    }

    // 認証チェック
    if (!checkAuth()) return;
    document.body.style.visibility = 'visible';

    const today = new Date();
    const dateEl = document.getElementById('currentDate');
    if (dateEl) dateEl.textContent =
        today.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });

    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => navigateTo(item.dataset.page));
    });

    document.getElementById('menuToggle').addEventListener('click', () => {
        toggleSidebar();
    });

    // ユーザー情報読み込み
    loadUserInfo();
    // スマホは配車表を初期表示、PCはダッシュボード
    if (isMobile()) {
        navigateTo('dispatches');
    } else {
        loadDashboard();
    }
});

// ===== ナビゲーション =====
function navigateTo(page) {
    currentPage = page;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(`page-${page}`).classList.add('active');
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector(`.nav-item[data-page="${page}"]`).classList.add('active');

    const titles = {
        dashboard: 'ダッシュボード', dispatches: '配車表', shipments: '案件管理',
        clients: '荷主管理', partners: '協力会社管理', vehicles: '車両管理', drivers: 'ドライバー管理',
        documents: '書類管理', map: '地図表示'
    };
    document.getElementById('pageTitle').textContent = titles[page] || '';

    const loaders = {
        dashboard: loadDashboard, dispatches: loadDispatchCalendar, shipments: loadShipments,
        clients: loadClients, partners: loadPartners, vehicles: loadVehicles, drivers: loadDrivers,
        documents: loadDocuments, map: initMap, users: loadUsers
    };
    if (loaders[page]) loaders[page]();
    // モバイルでのみサイドバーを閉じる
    if (window.innerWidth <= 768) {
        document.getElementById('sidebar').classList.remove('open');
    }
    // ボトムナビのアクティブ更新
    document.querySelectorAll('.mobile-bottom-nav button').forEach(b => {
        b.classList.toggle('active', b.dataset.page === page);
    });
    // 未配車FABは配車表ページのみ表示
    document.querySelectorAll('.unassigned-fab, .unassigned-slide-panel').forEach(el => {
        el.style.display = page === 'dispatches' ? '' : 'none';
    });
}

// ===== サイドバー開閉 =====
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const content = document.querySelector('.content');
    if (window.innerWidth <= 768) {
        // モバイル: open クラスで表示切替
        sidebar.classList.toggle('open');
    } else {
        // デスクトップ: collapsed → アイコンのみ表示、ホバーで展開
        sidebar.classList.toggle('collapsed');
        if (content) content.classList.toggle('sidebar-collapsed');
    }
}

// ===== 認証 =====
function getToken() { return localStorage.getItem('access_token'); }
function authHeaders() {
    const token = getToken();
    const h = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
}
function getLoginUrl(isLogout) {
    // ルートドメインの /login を返す（サブドメインにログインページを置かない）
    var h = location.hostname;
    var ds = ['hakoprofor.jp', 'unsoubako.com'];
    var suffix = isLogout ? '?logout=1' : '';
    for (var i = 0; i < ds.length; i++) {
        if (h === ds[i] || h.endsWith('.' + ds[i])) return 'https://' + ds[i] + '/login' + suffix;
    }
    return '/login' + suffix;
}
function checkAuth() {
    if (!getToken()) { location.href = getLoginUrl(); return false; }
    // ドライバーはドライバーアプリのみアクセス可
    const u = JSON.parse(localStorage.getItem('user') || '{}');
    if (u.role === 'driver') { location.href = '/m/attendance'; return false; }
    return true;
}
function logout() {
    localStorage.removeItem('access_token');
    localStorage.removeItem('user_info');
    location.href = getLoginUrl(true);
}
async function loadUserInfo() {
    try {
        const resp = await fetch(API + '/auth/me', { headers: authHeaders() });
        if (!resp.ok) { logout(); return null; }
        const user = await resp.json();
        localStorage.setItem('user_info', JSON.stringify(user));
        // ヘッダーにユーザー情報表示
        const userEl = document.getElementById('currentUser');
        if (userEl) {
            let html = '';
            // テナント切替はtenant-switcher.jsに統一
            // 管理者: 拠点切替ドロップダウン
            if (user.can_switch_branch && user.branches && user.branches.length > 1) {
                html += `<select onchange="switchBranch(this.value)" style="font-size:0.75rem;padding:2px 6px;border-radius:4px;border:1px solid rgba(255,255,255,0.3);background:rgba(255,255,255,0.1);color:#fff;cursor:pointer">`;
                user.branches.forEach(b => {
                    html += `<option value="${b.id}" ${b.id === user.branch_id ? 'selected' : ''} style="color:#000">${b.name}</option>`;
                });
                html += `</select> `;
            } else if (user.branch_name) {
                html += `<span style="font-size:0.75rem;opacity:0.8">📍${user.branch_name}</span> `;
            }
            // ロールバッジ
            const roleLabels = {admin:'管理者',manager:'拠点管理者',dispatcher:'配車担当',operator:'運営管理者'};
            html += `<span style="font-size:0.65rem;padding:1px 5px;border-radius:3px;background:rgba(255,255,255,0.15);color:rgba(255,255,255,0.85)">${roleLabels[user.role]||user.role}</span> `;
            html += `${user.name} `;
            userEl.innerHTML = html;
        }
        // ロールに基づいてサイドバーのサブアプリリンクを制御
        applyRoleAccess(user);
        return user;
    } catch(e) { return null; }
}

async function switchTenant(tenantId) {
    try {
        const resp = await fetch(API + '/auth/switch-tenant', {
            method: 'PUT', headers: authHeaders(),
            body: JSON.stringify({ tenant_id: tenantId })
        });
        if (resp.ok) {
            const data = await resp.json();
            localStorage.setItem('access_token', data.access_token);
            if (data.user) localStorage.setItem('user', JSON.stringify(data.user));
            // テナントのサブドメインにリダイレクト
            var h = location.hostname;
            var ds = ['hakoprofor.jp', 'unsoubako.com'];
            var md = '';
            for (var i = 0; i < ds.length; i++) {
                if (h === ds[i] || h.endsWith('.' + ds[i])) { md = ds[i]; break; }
            }
            if (md) {
                location.href = 'https://' + tenantId + '.' + md + '/?auth_token=' + encodeURIComponent(data.access_token) + '&auth_user=' + encodeURIComponent(JSON.stringify(data.user));
            } else {
                location.reload();
            }
        }
    } catch(e) { console.error(e); }
}

async function switchBranch(branchId) {
    try {
        const resp = await fetch(API + '/auth/switch-branch', {
            method: 'PUT', headers: authHeaders(),
            body: JSON.stringify({ branch_id: parseInt(branchId) })
        });
        if (resp.ok) {
            const data = await resp.json();
            localStorage.setItem('access_token', data.access_token);
            location.reload();
        }
    } catch(e) { console.error(e); }
}

function applyRoleAccess(user) {
    if (user.role === 'admin') {
        // 管理者: ユーザー管理を表示
        const navUsers = document.getElementById('nav-users');
        if (navUsers) navUsers.style.display = '';
    }
    if (user.role === 'dispatcher') {
        // 配車担当: サブアプリリンクを非表示
        document.querySelectorAll('.nav-item[onclick*="app/billing"]').forEach(el => el.style.display = 'none');
        const subHeader = document.querySelector('.sub-app-header');
        if (subHeader) subHeader.style.display = 'none';
    }
}

// ===== ユーザー管理（管理者のみ） =====
async function loadUsers() {
    const users = await apiGet('/auth/users');
    if (!Array.isArray(users)) return;
    const roleLabels = {admin:'管理者',manager:'拠点管理者',dispatcher:'配車担当'};
    document.getElementById('users-table').innerHTML = users.map(u => `<tr>
        <td><strong>${u.name}</strong></td>
        <td>${u.email}</td>
        <td><span class="badge badge-${u.role === 'admin' ? 'blue' : u.role === 'manager' ? 'green' : 'gray'}">${roleLabels[u.role] || u.role}</span></td>
        <td>${u.branch_name || '-'}</td>
        <td>${u.is_active ? '✅ 有効' : '❌ 無効'}</td>
        <td>
            <button class="btn btn-sm btn-edit" onclick="editUser(${u.id})">編集</button>
            <button class="btn btn-sm" style="background:#ef4444;color:#fff;font-size:0.75rem;padding:2px 8px" onclick="deleteUser(${u.id},'${u.name}')">削除</button>
        </td>
    </tr>`).join('');
}

async function openUserModal(user = null) {
    const isEdit = !!user;
    const branches = await apiGet('/auth/branches');
    document.getElementById('modal-title').textContent = isEdit ? 'ユーザー編集' : 'ユーザー追加';
    document.getElementById('modal-body').innerHTML = `
        <div class="form-group"><label>名前</label><input type="text" id="f-u-name" value="${user?.name || ''}"></div>
        <div class="form-group"><label>メールアドレス</label><input type="email" id="f-u-email" value="${user?.email || ''}"></div>
        <div class="form-group"><label>パスワード${isEdit ? '（変更する場合のみ）' : ''}</label><input type="password" id="f-u-password" placeholder="${isEdit ? '空欄なら変更なし' : ''}"></div>
        <div class="form-row">
            <div class="form-group"><label>権限</label>
                <select id="f-u-role">
                    <option value="admin" ${user?.role === 'admin' ? 'selected' : ''}>管理者</option>
                    <option value="manager" ${user?.role === 'manager' ? 'selected' : ''}>拠点管理者</option>
                    <option value="dispatcher" ${!user || user?.role === 'dispatcher' ? 'selected' : ''}>配車担当</option>
                </select>
            </div>
            <div class="form-group"><label>所属拠点</label>
                <select id="f-u-branch">
                    <option value="">-- 未設定 --</option>
                    ${branches.map(b => `<option value="${b.id}" ${user?.branch_id === b.id ? 'selected' : ''}>${b.name}</option>`).join('')}
                </select>
            </div>
        </div>
        ${isEdit ? `<div class="form-group"><label>状態</label><select id="f-u-active"><option value="true" ${user?.is_active !== false ? 'selected' : ''}>有効</option><option value="false" ${user?.is_active === false ? 'selected' : ''}>無効</option></select></div>` : ''}
        <div class="form-actions">
            <button class="btn" onclick="closeModal()">キャンセル</button>
            <button class="btn btn-primary" onclick="saveUser(${user?.id || 'null'})">${isEdit ? '更新' : '追加'}</button>
        </div>`;
    showModal();
}

async function saveUser(id) {
    const data = {
        name: document.getElementById('f-u-name').value,
        email: document.getElementById('f-u-email').value,
        role: document.getElementById('f-u-role').value,
        branch_id: parseInt(document.getElementById('f-u-branch').value) || null,
    };
    const pw = document.getElementById('f-u-password').value;
    if (pw) data.password = pw;
    else if (!id) return alert('パスワードを入力してください');
    const activeEl = document.getElementById('f-u-active');
    if (activeEl) data.is_active = activeEl.value === 'true';
    if (!data.name || !data.email) return alert('名前とメールは必須です');

    if (id) {
        await apiPut(`/auth/users/${id}`, data);
    } else {
        const resp = await apiPost('/auth/users', data);
        if (resp.detail) return alert(resp.detail);
    }
    closeModal();
    loadUsers();
}

async function editUser(id) {
    const users = await apiGet('/auth/users');
    const u = users.find(x => x.id === id);
    if (u) openUserModal(u);
}

async function deleteUser(id, name) {
    if (!confirm(`${name}さんを削除しますか？`)) return;
    await apiDelete(`/auth/users/${id}`);
    loadUsers();
}

// ===== データキャッシュ =====
const _cache = {};
const CACHE_TTL = 30000; // 30秒

function cachedApiGet(url) {
    const entry = _cache[url];
    if (entry && Date.now() - entry.ts < CACHE_TTL) return Promise.resolve(entry.data);
    return apiGet(url).then(data => { _cache[url] = { data, ts: Date.now() }; return data; });
}

function invalidateCache(prefix) {
    if (!prefix) { Object.keys(_cache).forEach(k => delete _cache[k]); return; }
    Object.keys(_cache).forEach(k => { if (k.startsWith(prefix)) delete _cache[k]; });
}

// ===== API ヘルパー =====
async function apiGet(url) {
    const resp = await fetch(API + url, { headers: authHeaders() });
    if (resp.status === 401) { logout(); return []; }
    return resp.json();
}
async function apiPost(url, data) {
    const resp = await fetch(API + url, { method: 'POST', headers: authHeaders(), body: JSON.stringify(data) });
    if (resp.status === 401) { logout(); return {}; }
    invalidateCache(); // 書き込み後はキャッシュクリア
    return resp.json();
}
async function apiPut(url, data) {
    const resp = await fetch(API + url, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(data) });
    if (resp.status === 401) { logout(); return {}; }
    invalidateCache();
    return resp.json();
}
async function apiDelete(url) {
    const resp = await fetch(API + url, { method: 'DELETE', headers: authHeaders() });
    if (resp.status === 401) { logout(); return {}; }
    invalidateCache();
    return resp.json();
}

// ===== ダッシュボード =====
async function loadDashboard() {
    const data = await apiGet('/dashboard');
    document.getElementById('stat-today-dispatches').textContent = data.today_dispatches;
    document.getElementById('stat-unassigned').textContent = data.unassigned_shipments;
    const normalVehicles = data.vehicles.total - (data.vehicles.maintenance || 0);
    document.getElementById('stat-vehicles-active').innerHTML = `${normalVehicles}<small>/${data.vehicles.total}</small>`;
    document.getElementById('stat-monthly-revenue').textContent = `¥${data.monthly_revenue.toLocaleString()}`;

    const vTotal = data.vehicles.total || 1;
    document.getElementById('vehicle-status-bars').innerHTML = `
        ${statusBar('通常', normalVehicles, vTotal, 'blue')}
        ${statusBar('整備中', data.vehicles.maintenance, vTotal, 'orange')}`;

    const dTotal = data.drivers.total || 1;
    document.getElementById('driver-status-bars').innerHTML = `
        ${statusBar('運行中', data.drivers.active, dTotal, 'blue')}
        ${statusBar('待機中', data.drivers.standby, dTotal, 'green')}`;

    const maxRev = Math.max(...data.revenue_trend.map(r => r.revenue), 1);
    document.getElementById('revenue-chart').innerHTML = data.revenue_trend.map(r => {
        const h = Math.max((r.revenue / maxRev) * 160, 2);
        return `<div class="chart-bar-wrapper">
            <div class="chart-value">${r.revenue > 0 ? '¥' + (r.revenue / 1000).toFixed(0) + 'k' : ''}</div>
            <div class="chart-bar" style="height:${h}px"></div>
            <div class="chart-label">${r.date.slice(5)}</div>
        </div>`;
    }).join('');
}

function statusBar(label, count, total, color) {
    const pct = Math.round((count / total) * 100);
    return `<div class="status-bar">
        <div class="status-bar-label"><span>${label}</span><span>${count}台</span></div>
        <div class="status-bar-track"><div class="status-bar-fill ${color}" style="width:${pct}%"></div></div>
    </div>`;
}

// ===== 配車表（車両×時間ガントチャート） =====
const CAL_DAYS = 3;
let HOUR_START = 0;
let HOUR_END = 24;
let HOUR_COUNT = HOUR_END - HOUR_START;
let selectedDayIndex = 0;
let _mFilterTypes = []; // 選択中の車種（複数）
let _mFilterCaps = [];  // 選択中の積載量（複数）

async function loadDispatchCalendar() {
    // スクロール位置を保存
    const wrapper = document.querySelector('.gantt-wrapper');
    const savedScrollTop = wrapper ? wrapper.scrollTop : 0;
    const savedScrollLeft = wrapper ? wrapper.scrollLeft : 0;

    const baseDate = new Date(calendarDate);
    baseDate.setHours(0, 0, 0, 0);

    const [dispatches, vehicles, shipments, partners] = await Promise.all([
        apiGet(`/dispatches?week_start=${fmt(baseDate)}`),
        cachedApiGet('/vehicles'),
        cachedApiGet('/shipments'),
        cachedApiGet('/partners'),
    ]);
    // キャッシュ更新（配車は日付依存なので都度更新）
    _cache['/vehicles'] = { data: vehicles, ts: Date.now() };
    _cache['/shipments'] = { data: shipments, ts: Date.now() };
    _cache['/partners'] = { data: partners, ts: Date.now() };
    _cache['_lastDispatches'] = { data: dispatches, ts: Date.now() };

    const days = [];
    const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
    for (let i = 0; i < CAL_DAYS; i++) {
        const d = new Date(baseDate);
        d.setDate(d.getDate() + i);
        days.push(d);
    }
    const dayStrs = days.map(d => fmt(d));

    const vehicleTypes = [...new Set(vehicles.map(v => v.type))];
    const capacities = [...new Set(vehicles.map(v => v.capacity))].sort((a, b) => a - b);
    // PC版フィルター（単一選択、後方互換）
    const filterType = document.getElementById('cal-filter-type')?.value || '';
    const filterCap = document.getElementById('cal-filter-cap')?.value || '';
    let filteredVehicles = vehicles;
    if (isMobile()) {
        // スマホ版: 複数選択フィルター
        if (_mFilterTypes.length > 0) filteredVehicles = filteredVehicles.filter(v => _mFilterTypes.includes(v.type));
        if (_mFilterCaps.length > 0) filteredVehicles = filteredVehicles.filter(v => _mFilterCaps.includes(String(v.capacity)));
    } else {
        if (filterType) filteredVehicles = filteredVehicles.filter(v => v.type === filterType);
        if (filterCap) filteredVehicles = filteredVehicles.filter(v => v.capacity == parseFloat(filterCap));
    }
    // Requirement 5: 整備中の車両を一番下に並び替え
    filteredVehicles = [
        ...filteredVehicles.filter(v => v.status !== '整備中'),
        ...filteredVehicles.filter(v => v.status === '整備中'),
    ];

    if (selectedDayIndex >= CAL_DAYS) selectedDayIndex = 0;
    const activeDayStr = dayStrs[selectedDayIndex];
    const dayDispatches = dispatches.filter(d => d.date === activeDayStr);

    const hours = [];
    for (let h = HOUR_START; h < HOUR_END; h++) hours.push(h);

    // 日付またぎ配車: この日に関係する配車を抽出
    const dayDispatches2 = dispatches.filter(d => {
        if (d.date === activeDayStr) return true;
        if (d.end_date && d.date <= activeDayStr && d.end_date >= activeDayStr) return true;
        return false;
    });

    const activeDayDate = days[selectedDayIndex];
    const activeDateLabel = `${activeDayDate.getFullYear()}年${activeDayDate.getMonth() + 1}月${activeDayDate.getDate()}日(${dayNames[activeDayDate.getDay()]})`;

    const calContainer = document.getElementById('dispatch-calendar');

    // ===== マトリクスビュー（transia テナント用） =====
    if (!isMobile() && localStorage.getItem('dispatchViewMode') === 'matrix') {
        await renderMatrixView(calContainer, dispatches, vehicles, shipments, partners, filteredVehicles, baseDate);
        // 未配車パネルはマトリクスビューでも表示するため、ここではreturnしない
        // → 未配車パネル処理は後続のコードで実行
        // ただし gantt/mobile 部分はスキップ
    } else
    // ===== モバイル: 縦ガントモード =====
    if (isMobile()) {
        const hasUndo = (_lastAutoDispatchIds.length > 0 && _lastAutoDispatchDay === activeDayStr) || (_lastResetData.length > 0 && _lastResetDay === activeDayStr);
        const undoFn = _lastResetData.length > 0 && _lastResetDay === activeDayStr ? 'undoReset' : 'undoAutoDispatch';
        const hasDispatches = dayDispatches.filter(d => !d.partner_id).length > 0;
        const filterActive = _mFilterTypes.length > 0 || _mFilterCaps.length > 0;
        const mobileControlsHtml = `
            <div class="m-cal-controls">
                <div class="m-cal-row">
                    <button class="m-cal-btn" onclick="changeDays(-1)">◀</button>
                    ${days.map((d, i) => `<button class="m-cal-tab ${i === selectedDayIndex ? 'active' : ''} ${isToday(d) ? 'today' : ''}" onclick="selectedDayIndex=${i};loadDispatchCalendar()">${(d.getMonth()+1)}/${d.getDate()}</button>`).join('')}
                    <button class="m-cal-btn" onclick="changeDays(1)">▶</button>
                    <button class="m-cal-btn" onclick="calendarDate=new Date();selectedDayIndex=0;loadDispatchCalendar()">今日</button>
                    <label class="m-cal-btn m-cal-date-label">📅<input type="date" class="m-cal-date-input" value="${activeDayStr}" onchange="calendarDate=new Date(this.value+'T00:00:00');selectedDayIndex=0;loadDispatchCalendar()"></label>
                    <button class="m-cal-btn" onclick="resetDispatches('${activeDayStr}')" style="${hasDispatches ? '' : 'opacity:0.4;pointer-events:none'}">🔄</button>
                    ${hasUndo ? `<button class="m-cal-btn" onclick="${undoFn}()">↩</button>` : ''}
                </div>
                <div class="m-cal-row" style="margin-top:2px;gap:4px">
                    <button class="m-cal-btn" onclick="showMobileFilterModal()" style="font-size:0.65rem;${filterActive ? 'color:#ea580c;font-weight:700' : ''}">絞り込み（${filteredVehicles.length}台）</button>
                    <select id="cal-hour-start" class="m-cal-select" onchange="changeHourRange()" style="max-width:58px">
                        ${Array.from({length:24}, (_,h) => `<option value="${h}" ${HOUR_START === h ? 'selected' : ''}>${String(h).padStart(2,'0')}:00</option>`).join('')}
                    </select>
                    <span style="font-size:0.6rem;color:#6b7280">〜</span>
                    <select id="cal-hour-end" class="m-cal-select" onchange="changeHourRange()" style="max-width:58px">
                        ${Array.from({length:24}, (_,i) => i+1).map(h => `<option value="${h}" ${HOUR_END === h ? 'selected' : ''}>${h === 24 ? '24:00' : String(h).padStart(2,'0')+':00'}</option>`).join('')}
                    </select>
                </div>
            </div>`;

        // 縦ガントHTML生成
        const totalMin = HOUR_COUNT * 60;
        const rowH = 40; // 1時間あたりの高さ(px)
        const screenW = window.innerWidth;
        const timeColW = 36;
        // 画面幅に4列収まるように列幅計算。5台以上は横スクロール
        const visibleCols = Math.min(filteredVehicles.length, 4);
        const colW = Math.floor((screenW - timeColW) / visibleCols);
        // D&D用にグリッド情報をグローバル保存
        window._mGridInfo = { timeColW, colW, rowH, vehicles: filteredVehicles, hourStart: HOUR_START };
        // ヘッダー（固定、スクロールしない）
        let headerHtml = `<div class="vg-header-row" style="display:flex;">
            <div class="vg-corner" style="width:${timeColW}px;min-width:${timeColW}px;flex-shrink:0;">時刻</div>`;
        filteredVehicles.forEach(v => {
            const shortNum = v.number.split(' ').slice(-1)[0] || v.number;
            const tzIcon = (v.temperature_zone === '冷蔵' || v.temperature_zone === '冷凍') ? '❄' : (v.temperature_zone === '冷蔵冷凍兼用' ? '❄' : '');
            const pgIcon = v.has_power_gate ? 'PG' : '';
            headerHtml += `<div class="vg-vehicle-header" style="width:${colW}px;min-width:${colW}px;flex-shrink:0;" onclick="showMobileVehicleDetail(${v.id})">${shortNum}<br><span style="font-size:0.45rem;opacity:0.7">${v.type} ${v.capacity}t ${tzIcon}${pgIcon}</span></div>`;
        });
        headerHtml += `</div>`;

        // 時間セル（スクロール可能エリア）
        let vgHtml = `<div class="vertical-gantt-wrapper">
            <div class="vertical-gantt" style="position:relative;grid-template-columns:${timeColW}px repeat(${filteredVehicles.length}, ${colW}px);grid-template-rows:repeat(${HOUR_COUNT}, ${rowH}px)">`;

        // 時間行×車両列
        for (let h = HOUR_START; h < HOUR_START + HOUR_COUNT; h++) {
            const hLabel = h >= 24 ? `翌${String(h - 24).padStart(2, '0')}` : String(h).padStart(2, '0');
            vgHtml += `<div class="vg-time-label">${hLabel}</div>`;
            filteredVehicles.forEach(v => {
                vgHtml += `<div class="vg-cell" data-vehicle-id="${v.id}" data-hour="${h}"></div>`;
            });
        }
        // バーを配置（position:absolute でグリッド内に重ねる）
        // 各車両の配車をまとめる
        const vehicleDispatches = {};
        filteredVehicles.forEach((v, vi) => { vehicleDispatches[v.id] = { index: vi, dispatches: [] }; });
        dayDispatches2.forEach(d => {
            if (vehicleDispatches[d.vehicle_id]) {
                vehicleDispatches[d.vehicle_id].dispatches.push(d);
            }
        });

        // バーのHTML（グリッド内にabsolute配置）
        let barsHtml = '';
        Object.entries(vehicleDispatches).forEach(([vid, vdata]) => {
            // 時間重複を検出してインデント計算
            const sorted = [...vdata.dispatches].sort((a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time));
            const lanes = {}; // dispatchId → lane (0 = no overlap, 1+ = overlapping)
            sorted.forEach((d, i) => {
                let lane = 0;
                for (let j = 0; j < i; j++) {
                    const prev = sorted[j];
                    if (timeToMinutes(d.start_time) < timeToMinutes(prev.end_time) && timeToMinutes(d.end_time) > timeToMinutes(prev.start_time)) {
                        lane = Math.max(lane, (lanes[prev.id] || 0) + 1);
                    }
                }
                lanes[d.id] = lane;
            });

            vdata.dispatches.forEach(d => {
                const startMin = timeToMinutes(d.start_time);
                const endMin = timeToMinutes(d.end_time);
                const topPct = ((startMin - HOUR_START * 60) / totalMin) * 100;
                const heightPct = ((endMin - startMin) / totalMin) * 100;
                const indent = (lanes[d.id] || 0) * 8; // 重複時に左から8pxずつインデント
                const leftPx = timeColW + vdata.index * colW + 2 + indent;
                const wc = getWeightColor(d.weight, d.vehicle_capacity);
                const driverName = d.driver_name || '';
                const pickup = (d.pickup_address || '').substring(0, 6);
                const delivery = (d.delivery_address || '').substring(0, 6);
                const topPx = (startMin - HOUR_START * 60) / 60 * rowH;
                const heightPx = (endMin - startMin) / 60 * rowH;
                // 積載超過チェック
                const capKg = (d.vehicle_capacity || 0) * 1000;
                const isOverload = capKg > 0 && d.weight > capKg;
                const capPct = capKg > 0 ? Math.round(d.weight / capKg * 100) : 0;
                const overloadStyle = isOverload ? 'border:2px solid #dc2626;' : '';
                const overloadIcon = isOverload ? `<span style="color:#dc2626;font-size:0.5rem;font-weight:700">🚨${capPct}%</span> ` : '';

                const barW = colW - 6 - indent;
                const dc = getDriverColor(d.driver_id);
                barsHtml += `<div class="vg-bar" data-id="${d.id}" style="background:${isOverload ? '#fee2e2' : wc.bg};color:${isOverload ? '#991b1b' : wc.text};border-left:3px solid ${dc.border};left:${leftPx}px;width:${barW}px;top:${topPx}px;height:${Math.max(heightPx, 20)}px;${overloadStyle}${indent > 0 ? 'opacity:0.9;' : ''}" onclick="showDispatchDetail(${d.id})" ontouchstart="mTouchStart(event,${d.id})" ontouchend="mTouchEnd(event,${d.id})" title="${driverName}\n${d.start_time}-${d.end_time}\n${d.pickup_address}→${d.delivery_address}${isOverload ? '\n🚨積載超過'+capPct+'%' : ''}">
                    <span class="vg-bar-driver" style="background:${dc.bg};color:${dc.text};border:1px solid ${dc.border}">${overloadIcon}${driverName}</span>
                    ${heightPx >= 40 ? `<span class="vg-bar-addr">${pickup}→${delivery}</span>` : ''}
                    ${heightPx >= 55 ? `<span class="vg-bar-addr" style="font-size:0.45rem">${d.start_time}-${d.end_time}</span>` : ''}
                </div>`;
            });
        });

        vgHtml += barsHtml + `</div></div>`;

        calContainer.innerHTML = mobileControlsHtml + headerHtml + vgHtml;

        // スクロール位置復元 + ヘッダー横スクロール同期
        const vWrapper = document.querySelector('.vertical-gantt-wrapper');
        const vHeader = document.querySelector('.vg-header-row');
        if (vWrapper) {
            vWrapper.scrollTop = savedScrollTop;
            vWrapper.scrollLeft = savedScrollLeft;
            if (vHeader) vHeader.scrollLeft = savedScrollLeft;
            vWrapper.addEventListener('scroll', () => {
                if (vHeader) vHeader.scrollLeft = vWrapper.scrollLeft;
            });
        }

        // 未配車パネルはデスクトップと同じ処理（この後で実行される）
        // モバイル時はガント後のインジケーターは省略
        // 未配車パネル処理に進む
    } else {
    // ===== デスクトップ: 通常の横ガント =====
    calContainer.innerHTML = `
        <div class="cal-controls" style="gap:8px">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:nowrap">
                <button class="btn btn-sm" onclick="changeDays(-1)" title="前日">◀ 前日</button>
                <button class="btn btn-sm" onclick="calendarDate=new Date();selectedDayIndex=0;loadDispatchCalendar()">今日</button>
                <button class="btn btn-sm" onclick="changeDays(1)" title="翌日">翌日 ▶</button>
                <span style="font-size:1.1rem;font-weight:700;margin:0 4px;color:var(--text-dark,#1e293b);white-space:nowrap">${activeDateLabel}</span>
                <input type="date" class="input-date" value="${fmt(baseDate)}" onchange="calendarDate=new Date(this.value+'T00:00:00');selectedDayIndex=0;loadDispatchCalendar()" title="日付を選択" style="width:140px">
                <div class="cal-day-tabs" style="display:flex;gap:2px">
                    ${days.map((d, i) => `<button class="cal-day-tab ${i === selectedDayIndex ? 'active' : ''} ${isToday(d) ? 'today' : ''}" onclick="selectedDayIndex=${i};loadDispatchCalendar()">${(d.getMonth() + 1)}/${d.getDate()}(${dayNames[d.getDay()]})</button>`).join('')}
                </div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:nowrap">
                <button class="btn btn-sm" onclick="printDispatchTable()" title="印刷">🖨</button>
                <button class="btn btn-sm" onclick="resetDispatches('${activeDayStr}')" title="この日の配車をリセット（協力会社除く）" style="background:${dayDispatches.filter(d => !d.partner_id).length > 0 ? '#dc2626' : '#9ca3af'};color:#fff;font-weight:600" ${dayDispatches.filter(d => !d.partner_id).length === 0 ? 'disabled' : ''}>🔄 リセット</button>
                ${(_lastAutoDispatchIds.length > 0 && _lastAutoDispatchDay === activeDayStr) || (_lastResetData.length > 0 && _lastResetDay === activeDayStr) ? `<button class="btn btn-sm" onclick="${_lastResetData.length > 0 && _lastResetDay === activeDayStr ? 'undoReset' : 'undoAutoDispatch'}()" title="直前の操作を取り消し" style="background:#64748b;color:#fff">↩ 元に戻す (${_lastResetData.length > 0 && _lastResetDay === activeDayStr ? _lastResetData.length : _lastAutoDispatchIds.length}件)</button>` : ''}
                <select id="cal-hour-start" class="select" onchange="changeHourRange()" title="開始時刻" style="width:70px">
                    ${Array.from({length:24}, (_,h) => `<option value="${h}" ${HOUR_START === h ? 'selected' : ''}>${String(h).padStart(2,'0')}:00</option>`).join('')}
                </select>
                <span style="color:var(--text-light);font-size:0.8rem">〜</span>
                <select id="cal-hour-end" class="select" onchange="changeHourRange()" title="終了時刻" style="width:80px">
                    ${Array.from({length:24}, (_,i) => i+1).map(h => `<option value="${h}" ${HOUR_END === h || (HOUR_END > 24 && h === HOUR_END - 24) ? 'selected' : ''}>${h === 24 ? '24:00' : String(h).padStart(2,'0')+':00'}</option>`).join('')}
                </select>
                <select id="cal-filter-type" class="select" onchange="loadDispatchCalendar()" style="margin-left:auto">
                    <option value="">全車種</option>
                    ${vehicleTypes.map(t => `<option value="${t}" ${filterType === t ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
                <select id="cal-filter-cap" class="select" onchange="loadDispatchCalendar()">
                    <option value="">全車格</option>
                    ${capacities.map(c => `<option value="${c}" ${filterCap == c ? 'selected' : ''}>${c}t</option>`).join('')}
                </select>
                ${(() => { const ui = JSON.parse(localStorage.getItem('user_info') || '{}'); return ui.tenant_id === 'transia' ? '<button class="btn btn-sm" onclick="toggleDispatchViewMode()" style="background:#ea580c;color:#fff;font-weight:600;margin-left:8px" title="マトリクス表示に切替">マトリクス表示</button>' : ''; })()}
            </div>
        </div>
        <div class="cal-legend" style="display:flex;gap:10px;padding:2px 8px;font-size:0.7rem;color:#64748b;align-items:center;flex-wrap:wrap">
            <span style="font-weight:600;color:#475569">積載率:</span>
            <span style="display:inline-flex;align-items:center;gap:3px"><span style="width:12px;height:12px;background:#eff6ff;border-left:3px solid #93c5fd;border-radius:2px;display:inline-block"></span>~20%</span>
            <span style="display:inline-flex;align-items:center;gap:3px"><span style="width:12px;height:12px;background:#dbeafe;border-left:3px solid #60a5fa;border-radius:2px;display:inline-block"></span>~40%</span>
            <span style="display:inline-flex;align-items:center;gap:3px"><span style="width:12px;height:12px;background:#bfdbfe;border-left:3px solid #3b82f6;border-radius:2px;display:inline-block"></span>~60%</span>
            <span style="display:inline-flex;align-items:center;gap:3px"><span style="width:12px;height:12px;background:#93c5fd;border-left:3px solid #2563eb;border-radius:2px;display:inline-block"></span>~80%</span>
            <span style="display:inline-flex;align-items:center;gap:3px"><span style="width:12px;height:12px;background:#60a5fa;border-left:3px solid #1d4ed8;border-radius:2px;display:inline-block"></span>80%~</span>
            <span style="margin-left:8px;display:inline-flex;align-items:center;gap:3px"><span style="width:12px;height:12px;border:2px solid #f97316;border-radius:2px;display:inline-block"></span>重複</span>
            <span style="display:inline-flex;align-items:center;gap:3px"><span style="width:12px;height:12px;background:#fee2e2;border:2px solid #dc2626;border-radius:2px;display:inline-block"></span>積載超過</span>
            <span style="display:inline-flex;align-items:center;gap:3px"><span style="width:2px;height:14px;background:#ef4444;display:inline-block"></span>現在時刻</span>
        </div>
        <div class="gantt-wrapper" id="gantt-print-area">
            <div class="gantt-grid" style="grid-template-columns: 140px repeat(${HOUR_COUNT}, 1fr);">
                <div class="cal-header cal-vehicle-col">車両</div>
                ${hours.map(h => `<div class="cal-header gantt-hour-header">${h >= 24 ? '翌' + String(h - 24).padStart(2, '0') : String(h).padStart(2, '0')}</div>`).join('')}
                ${buildGanttRows(activeDayStr, dayDispatches2, filteredVehicles)}
                ${buildPartnerRows(activeDayStr, dayDispatches2, partners)}
            </div>
        </div>`;

    // 現在時刻インジケーター
    if (activeDayStr === fmt(new Date())) {
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const totalMin = HOUR_COUNT * 60;
        const nowLeft = ((nowMin - HOUR_START * 60) / totalMin) * 100;
        if (nowLeft >= 0 && nowLeft <= 100) {
            const ganttGrid = document.querySelector('.gantt-grid');
            const wrapper = document.getElementById('gantt-print-area');
            if (ganttGrid && wrapper) {
                wrapper.style.position = 'relative';
                const gridW = ganttGrid.offsetWidth;
                const gridH = ganttGrid.offsetHeight;
                const colW = (gridW - 140) / HOUR_COUNT;
                const pxLeft = 140 + ((nowMin - HOUR_START * 60) / 60) * colW;
                const indicator = document.createElement('div');
                indicator.className = 'now-indicator';
                indicator.style.cssText = `position:absolute;left:${pxLeft}px;top:0;height:${gridH}px;width:2px;background:#ef4444;z-index:8;pointer-events:none`;
                const timeLabel = document.createElement('div');
                timeLabel.style.cssText = 'position:sticky;top:0;background:#ef4444;color:#fff;font-size:0.65rem;padding:1px 5px;border-radius:3px;white-space:nowrap;font-weight:600;transform:translateX(-50%);width:fit-content';
                timeLabel.textContent = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
                indicator.appendChild(timeLabel);
                wrapper.appendChild(indicator);
            }
        }
    }

    // スクロール位置を復元
    const newWrapper = document.querySelector('.gantt-wrapper');
    if (newWrapper) {
        newWrapper.scrollTop = savedScrollTop;
        newWrapper.scrollLeft = savedScrollLeft;
    }
    } // end of desktop gantt else block

    // 【機能3】未配車案件パネル（その日に該当する案件のみ表示）
    const unassigned = shipments.filter(s => {
        if (s.status !== '未配車') return false;
        return isShipmentForDate(s, activeDayStr);
    });
    const panel = document.getElementById('unassigned-panel');
    if (unassigned.length > 0) {
        panel.innerHTML = `<h3 style="margin-bottom:12px;display:flex;align-items:center;gap:12px">📦 未配車案件 - ${activeDayStr} (${unassigned.length}件)
            <button class="btn btn-sm btn-primary" onclick="openQuickShipmentModal('${activeDayStr}')" style="font-size:0.75rem;padding:2px 10px">＋ 案件追加</button>
            <button class="btn btn-sm" onclick="autoDispatch('${activeDayStr}')" style="background:#ea580c;color:#fff;font-weight:600;font-size:0.75rem;padding:2px 10px">⚡ 自動配車</button>
        </h3>
            <div class="unassigned-list">
                ${unassigned.map(s => {
                    const freqLabel = s.frequency_type === '単発' ? '' : s.frequency_type === '毎日' ? ' 🔁毎日' : ` 🔁${s.frequency_days}`;
                    // Requirement 6: 品目と積載量を表示
                    const cargoDesc = s.cargo_description ? `<span style="font-size:0.78rem;color:#6b7280">${s.cargo_description}</span>` : '';
                    const weightDesc = s.weight > 0 ? `<span style="font-size:0.78rem;color:#6b7280">${s.weight}kg</span>` : '';
                    const timeStr = s.pickup_time || s.delivery_time
                        ? `<span style="color:#1d4ed8;font-weight:700;white-space:nowrap">${s.pickup_time || '?'}→${s.delivery_time || '?'}</span>`
                        : (s.time_note ? `<span style="color:#6b7280;white-space:nowrap">${s.time_note}</span>` : '');
                    return `<div class="unassigned-item" draggable="false" onmousedown="startShipmentDrag(event, ${s.id}, '${s.client_name}', '${(s.pickup_address||'').replace(/'/g,"\\'")}', '${(s.delivery_address||'').replace(/'/g,"\\'")}', '${activeDayStr}')" onclick="if(!justDragged){openQuickDispatchModal('${activeDayStr}','08:00','17:00', null, ${s.id})}">
                    <div style="display:flex;flex-direction:column;gap:1px;min-width:0;flex:1;overflow:hidden">
                        <div style="display:flex;justify-content:space-between;align-items:center;gap:4px">
                            <strong style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.name || s.client_name}</strong>
                            ${timeStr}
                        </div>
                        <div style="font-size:0.7rem;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.pickup_address} → ${s.delivery_address}</div>
                        <div style="display:flex;gap:4px;align-items:center">
                            ${cargoDesc}${weightDesc}
                            <span style="margin-left:auto;font-size:0.7rem">¥${s.price.toLocaleString()}</span>
                        </div>
                    </div>
                </div>`;
                }).join('')}
            </div>`;
    } else {
        panel.innerHTML = `<h3 style="margin-bottom:8px;display:flex;align-items:center;gap:12px">📦 未配車案件 - ${activeDayStr}
            <button class="btn btn-sm btn-primary" onclick="openQuickShipmentModal('${activeDayStr}')" style="font-size:0.75rem;padding:2px 10px">＋ 案件追加</button>
        </h3><p style="color:var(--text-light);font-size:0.85rem">この日の未配車案件はありません ✅</p>`;
    }

    // モバイル: FAB + スライドパネルで未配車表示（0件でも表示）
    if (isMobile()) {
        document.querySelectorAll('.unassigned-fab, .unassigned-slide-panel').forEach(el => el.remove());
        const fab = document.createElement('button');
        fab.className = 'unassigned-fab';
        fab.innerHTML = unassigned.length > 0
            ? `📦<span class="fab-badge">${unassigned.length}</span>`
            : `📦`;
        fab.onclick = () => {
            const sp = document.querySelector('.unassigned-slide-panel');
            if (sp) sp.classList.toggle('open');
        };
        document.body.appendChild(fab);

        const sp = document.createElement('div');
        sp.className = 'unassigned-slide-panel';
        sp.innerHTML = `<span class="panel-handle"></span>
            <h3 style="font-size:0.9rem;margin-bottom:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">📦 未配車 ${unassigned.length}件
                <button class="btn btn-sm btn-primary" onclick="closeMobileUnassigned();openQuickShipmentModal('${activeDayStr}')" style="font-size:0.65rem;padding:2px 8px">＋ 追加</button>
                ${unassigned.length > 0 ? `<button class="btn btn-sm" onclick="closeMobileUnassigned();autoDispatch('${activeDayStr}')" style="background:#ea580c;color:#fff;font-size:0.65rem;padding:2px 8px">⚡ 自動配車</button>` : ''}
            </h3>
            ${unassigned.length > 0 ? unassigned.map(s => `<div class="m-unassigned-item" data-shipment-id="${s.id}" style="padding:8px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:6px;cursor:pointer;-webkit-user-select:none;user-select:none" onclick="openQuickDispatchModal('${activeDayStr}','08:00','17:00',null,${s.id})" ontouchstart="mUnassignedTouchStart(event,${s.id},'${(s.name||s.client_name).replace(/'/g,"\\'")}')">
                <strong style="font-size:0.8rem">${s.name || s.client_name}</strong>
                ${s.pickup_time ? `<span style="color:#1d4ed8;font-size:0.7rem;float:right">${s.pickup_time}→${s.delivery_time}</span>` : ''}
                <div style="font-size:0.65rem;color:#6b7280;margin-top:2px">${s.pickup_address} → ${s.delivery_address}</div>
                <div style="font-size:0.65rem;color:#6b7280">${s.cargo_description || ''} ${s.weight}kg ¥${s.price.toLocaleString()}</div>
            </div>`).join('') : '<p style="color:#9ca3af;font-size:0.8rem;text-align:center;margin-top:16px">未配車案件はありません ✅</p>'}`;
        document.body.appendChild(sp);
    }
}

// ===== マトリクスビュー =====
let _matrixMonthStart = null; // マトリクスビューの月開始日

function toggleDispatchViewMode() {
    const current = localStorage.getItem('dispatchViewMode') || 'gantt';
    localStorage.setItem('dispatchViewMode', current === 'matrix' ? 'gantt' : 'matrix');
    loadDispatchCalendar();
}

function matrixChangeMonth(dir) {
    if (!_matrixMonthStart) _matrixMonthStart = new Date();
    _matrixMonthStart.setMonth(_matrixMonthStart.getMonth() + dir);
    _matrixMonthStart.setDate(1);
    loadDispatchCalendar();
}

function matrixGoToday() {
    _matrixMonthStart = new Date();
    _matrixMonthStart.setDate(1);
    loadDispatchCalendar();
}

function matrixSelectMonth(value) {
    // value is "YYYY-MM" from <input type="month">
    if (!value) return;
    const [y, m] = value.split('-').map(Number);
    _matrixMonthStart = new Date(y, m - 1, 1);
    loadDispatchCalendar();
}

// Legacy alias for week navigation (unused but kept for safety)
function matrixChangeWeek(dir) { matrixChangeMonth(dir > 0 ? 1 : -1); }

// 時間帯定義
const MATRIX_PERIODS = [
    { label: '深夜', startH: 0, endH: 4 },
    { label: '早朝', startH: 4, endH: 8 },
    { label: '午前', startH: 8, endH: 12 },
    { label: '午後', startH: 12, endH: 16 },
    { label: '夕方', startH: 16, endH: 20 },
    { label: '夜間', startH: 20, endH: 24 },
];

function getTimePeriodIndex(timeStr) {
    if (!timeStr) return 2; // デフォルト午前
    const h = parseInt(timeStr.split(':')[0], 10);
    for (let i = 0; i < MATRIX_PERIODS.length; i++) {
        if (h >= MATRIX_PERIODS[i].startH && h < MATRIX_PERIODS[i].endH) return i;
    }
    return 0;
}

// 配車が複数時間帯にまたがるか判定
function getDispatchPeriodSpan(d) {
    const startIdx = getTimePeriodIndex(d.start_time);
    const endIdx = d.end_time ? getTimePeriodIndex(d.end_time) : startIdx;
    return { startIdx, endIdx: Math.max(startIdx, endIdx) };
}

// 車両詳細ツールチップ表示
function showVehicleTooltip(e, vehicleId) {
    e.stopPropagation();
    // 既存ツールチップを削除
    const old = document.querySelector('.matrix-vehicle-tooltip');
    if (old) old.remove();
    // 車両データ取得
    cachedApiGet('/vehicles').then(vehicles => {
        const v = vehicles.find(x => x.id === vehicleId);
        if (!v) return;
        const tip = document.createElement('div');
        tip.className = 'matrix-vehicle-tooltip';
        const inspDate = v.inspection_date || '未設定';
        const tempZone = v.temperature_zone || '常温';
        const pg = v.has_power_gate ? 'あり' : 'なし';
        const notes = v.notes || '';
        tip.innerHTML = `
            <div class="mvt-title">${v.number}</div>
            <div class="mvt-row"><span class="mvt-label">車種:</span> ${v.vehicle_type || '-'}</div>
            <div class="mvt-row"><span class="mvt-label">積載量:</span> ${v.capacity || '-'}t</div>
            <div class="mvt-row"><span class="mvt-label">温度帯:</span> ${tempZone}</div>
            <div class="mvt-row"><span class="mvt-label">パワーゲート:</span> ${pg}</div>
            <div class="mvt-row"><span class="mvt-label">車検日:</span> ${inspDate}</div>
            ${notes ? `<div class="mvt-row"><span class="mvt-label">備考:</span> ${notes}</div>` : ''}
        `;
        document.body.appendChild(tip);
        // 位置決定
        const rect = e.target.closest('.matrix-vehicle-header').getBoundingClientRect();
        tip.style.top = (rect.bottom + 4) + 'px';
        tip.style.left = Math.max(4, rect.left) + 'px';
        // クリックで閉じる
        const close = (ev) => { if (!tip.contains(ev.target)) { tip.remove(); document.removeEventListener('click', close); } };
        setTimeout(() => document.addEventListener('click', close), 10);
    });
}

// マトリクスD&D
let _matrixDragData = null;

function matrixDragStart(e, dispatchId, vehicleId, dateStr, periodIdx) {
    _matrixDragData = { dispatchId, vehicleId, dateStr, periodIdx };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dispatchId));
    e.target.closest('.matrix-dispatch-item').style.opacity = '0.4';
}

function matrixDragEnd(e) {
    e.target.closest('.matrix-dispatch-item').style.opacity = '1';
    _matrixDragData = null;
}

function matrixDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const cell = e.target.closest('.matrix-cell, .matrix-empty-cell');
    if (cell) cell.classList.add('matrix-drop-target');
}

function matrixDragLeave(e) {
    const cell = e.target.closest('.matrix-cell, .matrix-empty-cell');
    if (cell) cell.classList.remove('matrix-drop-target');
}

async function matrixDrop(e, targetVehicleId, targetDateStr, targetPeriodIdx) {
    e.preventDefault();
    const cell = e.target.closest('.matrix-cell, .matrix-empty-cell');
    if (cell) cell.classList.remove('matrix-drop-target');
    if (!_matrixDragData) return;
    const { dispatchId, vehicleId, dateStr, periodIdx } = _matrixDragData;
    _matrixDragData = null;
    // 同じセルならスキップ
    if (vehicleId === targetVehicleId && dateStr === targetDateStr && periodIdx === targetPeriodIdx) return;
    // 新しい時間帯に合わせてstart_time/end_timeを調整
    const p = MATRIX_PERIODS[targetPeriodIdx];
    const newStart = String(p.startH).padStart(2, '0') + ':00';
    const newEnd = String(p.endH === 24 ? 23 : p.endH).padStart(2, '0') + (p.endH === 24 ? ':59' : ':00');
    try {
        await apiPut('/dispatches/' + dispatchId, {
            vehicle_id: targetVehicleId,
            date: targetDateStr,
            start_time: newStart,
            end_time: newEnd,
        });
        invalidateCache();
        loadDispatchCalendar();
    } catch (err) {
        console.error('Matrix D&D update failed:', err);
        loadDispatchCalendar();
    }
}

async function renderMatrixView(calContainer, dispatches, allVehicles, shipments, partners, filteredVehicles, baseDate) {
    // 月の開始日
    if (!_matrixMonthStart) {
        _matrixMonthStart = new Date(baseDate);
        _matrixMonthStart.setDate(1);
    }
    const monthStart = new Date(_matrixMonthStart);
    monthStart.setHours(0, 0, 0, 0);
    monthStart.setDate(1);

    // 当月の日数を計算（28-31日）
    const NUM_DAYS = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
    const matrixDays = [];
    const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
    for (let i = 0; i < NUM_DAYS; i++) {
        const d = new Date(monthStart);
        d.setDate(d.getDate() + i);
        matrixDays.push(d);
    }
    const matrixDayStrs = matrixDays.map(d => fmt(d));

    // 30日分の配車データを取得
    const rangeStartStr = fmt(matrixDays[0]);
    const rangeEndStr = fmt(matrixDays[NUM_DAYS - 1]);
    const allDispatches = await apiGet(`/dispatches?date_from=${rangeStartStr}&date_to=${rangeEndStr}`);
    const rangeDispatches = allDispatches.filter(d => d.date >= rangeStartStr && d.date <= rangeEndStr);

    // ドライバー情報を取得
    const drivers = await cachedApiGet('/drivers');
    const driverMap = {};
    drivers.forEach(d => { driverMap[d.id] = d; });

    // 車両ごとのドライバー名を決定
    const vehicleDriverNames = {};
    const vehicleDriverIds = {};
    filteredVehicles.forEach(v => {
        let driverName = '';
        let driverId = null;
        if (v.default_driver_id && driverMap[v.default_driver_id]) {
            driverName = driverMap[v.default_driver_id].name;
            driverId = v.default_driver_id;
        } else {
            const vDispatches = rangeDispatches.filter(d => d.vehicle_id === v.id && d.driver_name);
            if (vDispatches.length > 0) {
                driverName = vDispatches[vDispatches.length - 1].driver_name;
                driverId = vDispatches[vDispatches.length - 1].driver_id;
            }
        }
        vehicleDriverNames[v.id] = driverName;
        vehicleDriverIds[v.id] = driverId;
    });

    // 月ラベル
    const monthLabel = `${monthStart.getFullYear()}年${monthStart.getMonth() + 1}月`;

    // コントロール部分 — 年月ピッカー付き
    const monthValue = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}`;
    let controlsHtml = `
        <div class="cal-controls" style="gap:8px">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:nowrap">
                <button class="btn btn-sm" onclick="matrixChangeMonth(-1)" title="前月">◀</button>
                <input type="month" class="input-date" value="${monthValue}" onchange="matrixSelectMonth(this.value)" title="年月を選択" style="width:160px;font-size:0.9rem">
                <button class="btn btn-sm" onclick="matrixChangeMonth(1)" title="翌月">▶</button>
                <button class="btn btn-sm" onclick="matrixGoToday()">今月</button>
                <span style="font-size:1.1rem;font-weight:700;margin:0 4px;color:var(--text-dark,#1e293b);white-space:nowrap">${monthLabel}</span>
            </div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:nowrap;margin-left:auto">
                <button class="btn btn-sm" onclick="toggleDispatchViewMode()" style="background:#ea580c;color:#fff;font-weight:600">ガントに切替</button>
            </div>
        </div>`;

    // テーブル構築 — transposed: rows=dates, cols=vehicles
    // Each cell contains 6 time-period slots as thin horizontal dividers
    let tableHtml = `<div class="matrix-wrapper"><table class="matrix-table"><thead>`;

    // ヘッダー行: 日付コーナー + 各車両 (4行: 番号, ドライバー名, 車種, 車台番号)
    tableHtml += `<tr class="matrix-header-row1"><th class="matrix-corner-header matrix-date-header-sticky">日付</th>`;
    filteredVehicles.forEach(v => {
        const shortNum = v.number.split(' ').slice(-1)[0] || v.number;
        const vType = v.vehicle_type || v.type || '';
        const cap = v.capacity ? v.capacity + 't' : '';
        const typeLabel = vType + (cap ? cap : '');
        const driverName = vehicleDriverNames[v.id] || '';
        const chassisNum = v.chassis_number || '';
        // 車台番号の末尾4桁を表示
        const chassisShort = chassisNum.length > 4 ? chassisNum.slice(-4) : chassisNum;

        tableHtml += `<th class="matrix-vehicle-col-header" onclick="showVehicleTooltip(event, ${v.id})" style="cursor:pointer">`;
        tableHtml += `<div class="mvh-number">${shortNum}</div>`;
        tableHtml += `<div class="mvh-driver-name">${driverName || '&nbsp;'}</div>`;
        if (typeLabel) tableHtml += `<div class="mvh-info">${typeLabel}</div>`;
        if (chassisShort) tableHtml += `<div class="mvh-chassis">${chassisShort}</div>`;
        tableHtml += `</th>`;
    });
    tableHtml += `</tr></thead><tbody>`;

    // 各日付の行
    matrixDays.forEach((day, dayIdx) => {
        const dayStr = matrixDayStrs[dayIdx];
        const dow = day.getDay();
        const isSat = dow === 6;
        const isSun = dow === 0;
        const isTodayFlag = isToday(day);

        let rowCls = 'matrix-date-row';
        if (isTodayFlag) rowCls += ' matrix-today-row';
        else if (isSun) rowCls += ' matrix-sunday-row';
        else if (isSat) rowCls += ' matrix-saturday-row';

        tableHtml += `<tr class="${rowCls}">`;

        // 日付ラベル（sticky left）— "1 月" format
        let dateCls = 'matrix-date-header-sticky matrix-date-label';
        if (isTodayFlag) dateCls += ' matrix-today-label';
        else if (isSun) dateCls += ' matrix-sunday-label';
        else if (isSat) dateCls += ' matrix-saturday-label';
        const dayLabel = `<span class="matrix-date-num">${day.getDate()}</span><span class="matrix-date-dow">${dayNames[dow]}</span>`;
        tableHtml += `<td class="${dateCls}">${dayLabel}</td>`;

        // 各車両のセル
        filteredVehicles.forEach(v => {
            // この車両・この日付の全配車を取得
            const dayDispatches = rangeDispatches
                .filter(d => d.vehicle_id === v.id && d.date === dayStr)
                .sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));

            // 6スロットに振り分け
            const slots = [[], [], [], [], [], []];
            dayDispatches.forEach(d => {
                const pIdx = getTimePeriodIndex(d.start_time);
                slots[pIdx].push(d);
            });

            let cellCls = 'matrix-cell-t';
            if (isTodayFlag) cellCls += ' matrix-today-cell';
            else if (isSun) cellCls += ' matrix-sunday-cell';
            else if (isSat) cellCls += ' matrix-saturday-cell';

            const hasAny = dayDispatches.length > 0;

            if (!hasAny) {
                // 空セル — click to create
                tableHtml += `<td class="${cellCls} matrix-empty-cell" onclick="openQuickDispatchModal('${dayStr}','08:00','17:00',${v.id})" ondragover="matrixDragOver(event)" ondragleave="matrixDragLeave(event)" ondrop="matrixDrop(event,${v.id},'${dayStr}',2)">`;
                tableHtml += `<div class="matrix-slots-empty"></div>`;
                tableHtml += `</td>`;
            } else {
                tableHtml += `<td class="${cellCls}" ondragover="matrixDragOver(event)" ondragleave="matrixDragLeave(event)" ondrop="matrixDrop(event,${v.id},'${dayStr}',2)">`;
                tableHtml += `<div class="matrix-slots">`;
                slots.forEach((slotArr, pIdx) => {
                    const period = MATRIX_PERIODS[pIdx];
                    const slotCls = pIdx > 0 ? ' matrix-slot-border' : '';
                    tableHtml += `<div class="matrix-slot${slotCls}" onclick="if(!event.target.closest('.matrix-dispatch-item'))openQuickDispatchModal('${dayStr}','${String(period.startH).padStart(2,'0')}:00','${String(period.endH === 24 ? 23 : period.endH).padStart(2,'0')}:${period.endH === 24 ? '59' : '00'}',${v.id})" ondragover="matrixDragOver(event)" ondragleave="matrixDragLeave(event)" ondrop="event.stopPropagation();matrixDrop(event,${v.id},'${dayStr}',${pIdx})">`;
                    slotArr.forEach(d => {
                        const ddc = getDriverColor(d.driver_id);
                        const borderColor = ddc ? ddc.border : '#94a3b8';
                        const bgColor = ddc ? ddc.bg : '#f8fafc';
                        // Line 1: route (pickup～delivery)
                        const pickup = (d.pickup_address || '').split(/[　 ]/)[0] || '';
                        const delivery = (d.delivery_address || '').split(/[　 ]/)[0] || '';
                        const pickupShort = pickup.length > 4 ? pickup.substring(0, 4) : pickup;
                        const deliveryShort = delivery.length > 4 ? delivery.substring(0, 4) : delivery;
                        const routeLabel = pickupShort && deliveryShort ? `${pickupShort}～${deliveryShort}` : (pickupShort || deliveryShort || '');
                        // Line 2: area/cargo (方面 or cargo description)
                        const shipment = shipments.find(s => s.id === d.shipment_id);
                        const areaLabel = (d.delivery_address || '').includes('方面') ? (d.delivery_address || '').split(/[　 ]/).find(s => s.includes('方面')) || '' : (shipment?.cargo_description || d.cargo_type || '');
                        // Line 3: additional info (client name or vehicle count)
                        const extraLabel = d.client_name || shipment?.client_name || '';

                        tableHtml += `<div class="matrix-dispatch-item" draggable="true" ondragstart="matrixDragStart(event,${d.id},${v.id},'${dayStr}',${pIdx})" ondragend="matrixDragEnd(event)" style="border-left-color:${borderColor};background:${bgColor}" onclick="event.stopPropagation();showDispatchDetail(${d.id})" title="${d.driver_name || ''}\n${d.start_time}-${d.end_time}\n${d.pickup_address}→${d.delivery_address}">`;
                        tableHtml += `<div class="matrix-dispatch-route">${routeLabel}</div>`;
                        if (areaLabel) tableHtml += `<div class="matrix-dispatch-area">${areaLabel}</div>`;
                        if (extraLabel) tableHtml += `<div class="matrix-dispatch-extra">${extraLabel}</div>`;
                        tableHtml += `</div>`;
                    });
                    tableHtml += `</div>`;
                });
                tableHtml += `</div>`;
                tableHtml += `</td>`;
            }
        });
        tableHtml += `</tr>`;
    });

    tableHtml += `</tbody></table></div>`;

    calContainer.innerHTML = controlsHtml + tableHtml;

    // 今日の行にスクロール
    const todayIdx = matrixDays.findIndex(d => isToday(d));
    if (todayIdx > 0) {
        const wrapper = calContainer.querySelector('.matrix-wrapper');
        if (wrapper) {
            const todayRow = wrapper.querySelectorAll('.matrix-date-row')[todayIdx];
            if (todayRow) {
                wrapper.scrollTop = todayRow.offsetTop - 60;
            }
        }
    }
}

// 未配車アイテムからD&D
let _mUnassignedDrag = null;
function mUnassignedTouchStart(e, shipmentId, name) {
    const touch = e.touches[0];
    const startTime = Date.now();
    const startPos = { x: touch.clientX, y: touch.clientY };
    const item = e.target.closest('.m-unassigned-item');
    let timer = setTimeout(() => {
        timer = null;
        e.preventDefault();
        navigator.vibrate && navigator.vibrate(30);
        // 未配車パネルを閉じて配車表を露出
        closeMobileUnassigned();
        // ゴーストバーを作成
        const ghost = document.createElement('div');
        ghost.className = 'vg-bar';
        ghost.style.cssText = `position:fixed;left:${touch.clientX - 40}px;top:${touch.clientY - 15}px;width:80px;height:30px;background:#ea580c;color:#fff;border-radius:4px;z-index:200;font-size:0.6rem;padding:4px;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;`;
        ghost.textContent = name;
        document.body.appendChild(ghost);
        document.body.classList.add('no-select');
        _mUnassignedDrag = { shipmentId, ghost, name };
        // touchmove/touchend on document
        document.addEventListener('touchmove', mUnassignedMove, { passive: false });
        document.addEventListener('touchend', mUnassignedEnd);
    }, 400);
    const moveHandler = (ev) => {
        const t = ev.touches[0];
        if (Math.abs(t.clientX - startPos.x) > 8 || Math.abs(t.clientY - startPos.y) > 8) {
            clearTimeout(timer); timer = null;
            item.removeEventListener('touchmove', moveHandler);
        }
    };
    item.addEventListener('touchmove', moveHandler, { passive: true });
    item.addEventListener('touchend', () => { if (timer) clearTimeout(timer); item.removeEventListener('touchmove', moveHandler); }, { once: true });
}
function mUnassignedMove(e) {
    if (!_mUnassignedDrag) return;
    e.preventDefault();
    const touch = e.touches[0];
    _mUnassignedDrag.ghost.style.left = (touch.clientX - 40) + 'px';
    _mUnassignedDrag.ghost.style.top = (touch.clientY - 15) + 'px';
    // ドロップ先シャドウ
    const grid = document.querySelector('.vertical-gantt');
    if (grid) {
        const old = grid.querySelector('.vg-drop-ghost');
        if (old) old.remove();
        const cellInfo = getCellFromTouch(touch.clientX, touch.clientY);
        if (cellInfo && window._mGridInfo) {
            const { timeColW, colW, rowH } = window._mGridInfo;
            const gh = document.createElement('div');
            gh.className = 'vg-drop-ghost';
            gh.style.cssText = `position:absolute;left:${timeColW + cellInfo.colIdx * colW + 2}px;top:${cellInfo.rowIdx * rowH}px;width:${colW - 6}px;height:${rowH * 4}px;background:rgba(234,88,12,0.2);border:2px dashed #ea580c;border-radius:4px;pointer-events:none;z-index:5;`;
            grid.appendChild(gh);
        }
    }
}
function mUnassignedEnd(e) {
    document.removeEventListener('touchmove', mUnassignedMove);
    document.removeEventListener('touchend', mUnassignedEnd);
    document.body.classList.remove('no-select');
    if (!_mUnassignedDrag) return;
    _mUnassignedDrag.ghost.remove();
    const grid = document.querySelector('.vertical-gantt');
    if (grid) { const gh = grid.querySelector('.vg-drop-ghost'); if (gh) gh.remove(); }
    const touch = e.changedTouches[0];
    const cellInfo = getCellFromTouch(touch.clientX, touch.clientY);
    if (cellInfo && cellInfo.vehicleId && !isNaN(cellInfo.hour)) {
        // 新規配車を作成（楽観的UI）
        createDispatchFromDrop(_mUnassignedDrag.shipmentId, cellInfo.vehicleId, cellInfo.hour);
    }
    _mUnassignedDrag = null;
}
async function createDispatchFromDrop(shipmentId, vehicleId, hour) {
    const days2 = [];
    for (let i = 0; i < CAL_DAYS; i++) { const d = new Date(calendarDate); d.setDate(d.getDate() + i); days2.push(d); }
    const activeDayStr2 = `${days2[selectedDayIndex].getFullYear()}-${String(days2[selectedDayIndex].getMonth()+1).padStart(2,'0')}-${String(days2[selectedDayIndex].getDate()).padStart(2,'0')}`;
    const [shipments, dispatches, drivers] = await Promise.all([
        cachedApiGet('/shipments'), cachedApiGet('/dispatches'), cachedApiGet('/drivers')
    ]);
    const s = shipments.find(x => x.id === shipmentId);
    const startTime = s?.pickup_time || `${String(hour).padStart(2,'0')}:00`;
    const endTime = s?.delivery_time || `${String(Math.min(hour + 4, 23)).padStart(2,'0')}:00`;

    // ドライバー自動選択: この車両に既存ドライバーがいればそのIDを使う
    let driverId = null;
    const existingOnVehicle = dispatches.find(d => d.vehicle_id === vehicleId && d.date === activeDayStr2 && d.driver_id);
    if (existingOnVehicle) {
        driverId = existingOnVehicle.driver_id;
    } else {
        // 空いてるドライバーから最初の1人
        const busyDriverIds = new Set(dispatches.filter(d => d.date === activeDayStr2).map(d => d.driver_id));
        const available = drivers.find(d => d.status !== '非番' && !busyDriverIds.has(d.id));
        if (available) driverId = available.id;
    }
    if (!driverId) {
        alert('利用可能なドライバーが見つかりません。手動で配車してください。');
        return;
    }

    // 楽観的UI: キャッシュに仮データを注入して即再描画
    const fakeDispatch = {
        id: -Date.now(), shipment_id: shipmentId, vehicle_id: vehicleId, driver_id: driverId,
        date: activeDayStr2, start_time: startTime, end_time: endTime, status: '予定',
        driver_name: drivers.find(d => d.id === driverId)?.name || '',
        vehicle_number: '', shipment_name: s?.name || '', client_name: s?.client_name || '',
        pickup_address: s?.pickup_address || '', delivery_address: s?.delivery_address || '',
        cargo_description: s?.cargo_description || '', weight: s?.weight || 0, price: s?.price || 0,
        pickup_time: s?.pickup_time || '', delivery_time: s?.delivery_time || '',
        vehicle_capacity: 0,
    };
    // キャッシュに仮配車を追加
    if (_cache['/dispatches']?.data) _cache['/dispatches'].data.push(fakeDispatch);
    // 案件ステータスを配車済みに
    if (_cache['/shipments']?.data) {
        const cs = _cache['/shipments'].data.find(x => x.id === shipmentId);
        if (cs) cs.status = '配車済み';
    }
    loadDispatchCalendar();

    // バックグラウンドでAPI実行→完了後に正式データで同期
    apiPost('/dispatches', {
        shipment_id: shipmentId, vehicle_id: vehicleId, driver_id: driverId,
        date: activeDayStr2, start_time: startTime, end_time: endTime,
    }).then(() => {
        invalidateCache('/dispatches');
        invalidateCache('/shipments');
        scheduleBgSync(2);
    }).catch(e => {
        alert('配車作成に失敗: ' + e.message);
        invalidateCache('/dispatches');
        invalidateCache('/shipments');
        loadDispatchCalendar();
    });
}

function closeMobileUnassigned() {
    const sp = document.querySelector('.unassigned-slide-panel');
    if (sp) sp.classList.remove('open');
}

// Requirement 1: ドライバー重複チェック（時間重複がある場合、重複先の車両番号を返す）
async function checkDriverConflict(driverId, dateStr, startTime, endTime, excludeVehicleId, excludeDispatchId) {
    const dispatches = await apiGet(`/dispatches?target_date=${dateStr}`);
    const newStart = timeToMinutes(startTime);
    const newEnd = timeToMinutes(endTime);
    for (const d of dispatches) {
        if (d.driver_id !== driverId) continue;
        if (excludeVehicleId && d.vehicle_id === excludeVehicleId) continue;
        if (excludeDispatchId && d.id === excludeDispatchId) continue;
        const dStart = timeToMinutes(d.start_time);
        const dEnd = timeToMinutes(d.end_time);
        // 時間が重複しているかチェック
        if (newStart < dEnd && newEnd > dStart) {
            return d.vehicle_number || `車両ID:${d.vehicle_id}`;
        }
    }
    return null;
}

function buildGanttRows(dayStr, dispatches, vehicles) {
    // Requirement 1 & 2: ドライバー重複チェック用マップを構築
    const driverDispatchMap = {};
    dispatches.forEach(d => {
        if (!d.driver_id) return;
        if (!driverDispatchMap[d.driver_id]) driverDispatchMap[d.driver_id] = [];
        driverDispatchMap[d.driver_id].push(d);
    });
    // 同じ日に複数車両に割り当てられているドライバーIDのセット
    const conflictDriverIds = new Set();
    Object.entries(driverDispatchMap).forEach(([driverId, dList]) => {
        const vehicleIds = new Set(dList.map(d => d.vehicle_id));
        if (vehicleIds.size > 1) conflictDriverIds.add(parseInt(driverId));
    });

    let html = '';
    vehicles.forEach(v => {
        const isMaintenance = v.status === '整備中';
        const statusCls = v.status === '整備中' ? 'orange' : 'blue';

        if (isMaintenance) {
            // 整備中: 半分の高さでコンパクト表示
            html += `<div class="cal-vehicle-label" style="opacity:0.45;background:#f1f5f9;padding:2px 8px;min-height:auto;height:20px;display:flex;flex-direction:row;align-items:center;gap:6px">`;
            html += `<span class="badge badge-orange" style="font-size:0.55rem;padding:0 3px;line-height:1.3">整備中</span>`;
            html += `<span style="font-size:0.68rem;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${v.number}</span>`;
            html += `</div>`;
            html += `<div style="grid-column:2/-1;background:#f1f5f9;opacity:0.35;height:20px;display:flex;align-items:center;padding-left:8px;font-size:0.65rem;color:#94a3b8;border-bottom:1px solid #e5e7eb">${v.notes || v.type}</div>`;
            return;
        }

        html += `<div class="cal-vehicle-label">`;
        const driverLabel = v.default_driver_name ? `<span style="font-size:0.7rem;color:#475569;font-weight:500;margin-left:4px">${v.default_driver_name}</span>` : '';
        html += `<div class="cal-vehicle-name">${v.number}${driverLabel}</div>`;
        const tempBadge = v.temperature_zone && v.temperature_zone !== '常温' ? `<span style="font-size:0.6rem;color:#0891b2;font-weight:600">❄${v.temperature_zone}</span>` : '';
        const pgBadge = v.has_power_gate ? '<span style="font-size:0.6rem;color:#7c3aed">PG</span>' : '';
        html += `<div class="cal-vehicle-info"><span class="badge badge-${statusCls}" style="font-size:0.65rem;padding:1px 6px">${v.status}</span> ${v.type} ${v.capacity ? v.capacity + 't' : ''} ${tempBadge} ${pgBadge}</div>`;
        html += `</div>`;

        const timelineClick = `openQuickDispatchModal('${dayStr}', '08:00', '17:00', ${v.id})`;
        html += `<div class="gantt-timeline" data-vehicle-id="${v.id}" data-maintenance="false" style="grid-column: 2 / -1;" onclick="${timelineClick}">`;

        for (let h = HOUR_START; h <= HOUR_END; h++) {
            const left = ((h - HOUR_START) / HOUR_COUNT) * 100;
            html += `<div class="gantt-gridline" style="left:${left}%"></div>`;
        }

        const vDispatches = dispatches.filter(d => d.vehicle_id === v.id);
        // 重なりを検出して段(row)を割り当て
        // まずlane計算だけ先にやる
        const lanes = [];
        const dispatchLanes = vDispatches.map(d => {
            let startMin, endMin, isMultiDay = false, dayLabel = '';
            if (d.end_date && d.end_date !== d.date) {
                isMultiDay = true;
                if (dayStr === d.date) {
                    startMin = timeToMinutes(d.start_time);
                    endMin = HOUR_END * 60;
                    dayLabel = '▶';
                } else if (dayStr === d.end_date) {
                    startMin = HOUR_START * 60;
                    endMin = timeToMinutes(d.end_time);
                    dayLabel = '▶';
                } else {
                    startMin = HOUR_START * 60;
                    endMin = HOUR_END * 60;
                    dayLabel = '⇥ 継続中';
                }
            } else {
                startMin = timeToMinutes(d.start_time);
                endMin = timeToMinutes(d.end_time);
            }
            let lane = 0;
            while (lanes[lane] && lanes[lane] > startMin) { lane++; }
            lanes[lane] = endMin;
            return { ...d, lane, startMin, endMin, isMultiDay, dayLabel };
        });
        const maxLanes = Math.max(lanes.length, 1);
        const laneHeight = 32;
        const timelineMinH = maxLanes * laneHeight + 8;

        // 複数レーンの場合、直前のtimeline HTMLにmin-heightを注入
        if (maxLanes > 1) {
            // 最後に追加したtimelineのstyleにmin-heightを追加
            html = html.replace(
                new RegExp(`data-vehicle-id="${v.id}" data-maintenance="false" style="grid-column: 2 / -1;"`),
                `data-vehicle-id="${v.id}" data-maintenance="false" style="grid-column: 2 / -1; min-height:${timelineMinH}px;"`
            );
        }

        const totalMin = HOUR_COUNT * 60;
        dispatchLanes.forEach(d => {
            const left = ((d.startMin - HOUR_START * 60) / totalMin) * 100;
            const width = ((d.endMin - d.startMin) / totalMin) * 100;
            const wc = getWeightColor(d.weight, d.vehicle_capacity);
            const capPct = (d.weight > 0 && d.vehicle_capacity > 0) ? Math.round(d.weight / (d.vehicle_capacity * 1000) * 100) : 0;
            const capBadge = capPct > 0 ? ` [${capPct}%]` : '';
            const isOverload = capPct > 100;
            const multiDayTag = d.isMultiDay ? ` 📅${d.date}〜${d.end_date}` : '';
            const cargoInfo = d.cargo_description ? ` / ${d.cargo_description}` : '';
            const weightInfo = d.weight > 0 ? ` ${d.weight}kg` : '';
            const top = d.lane * laneHeight + 4;
            const barH = laneHeight - 6;
            const multiDayClass = d.isMultiDay ? ' multi-day' : '';
            // 積載超過警告（赤枠＋赤背景）
            const overloadStyle = isOverload ? 'border:2px solid #dc2626;box-shadow:0 0 6px rgba(220,38,38,0.4);' : '';
            // ドライバー重複警告（オレンジ枠）
            const driverConflict = d.driver_id && conflictDriverIds.has(d.driver_id);
            const conflictStyle = driverConflict ? 'border:2px solid #f97316;box-shadow:0 0 4px rgba(249,115,22,0.5);' : '';
            const conflictIcon = driverConflict ? '⚠ ' : '';
            // ドライバー名を色付きバッジで表示
            const driverColor = getDriverColor(d.driver_id);
            const driverBadge = d.driver_name && driverColor
                ? `<span style="display:inline-block;padding:0 5px;border-radius:3px;border:1.5px solid ${driverColor.border};background:${driverColor.bg};color:${driverColor.text};font-weight:700;font-size:0.72rem;line-height:1.4;margin-right:4px;white-space:nowrap">${conflictIcon}${d.driver_name}</span>`
                : (d.driver_name ? `${conflictIcon}${d.driver_name}` : '');
            const driverLabel = d.driver_name ? `${conflictIcon}${d.driver_name}` : '';
            // 元の指定時間と配車時間が異なる場合
            const hasPreset = d.pickup_time && d.delivery_time;
            const timeChanged = hasPreset && (d.pickup_time !== d.start_time || d.delivery_time !== d.end_time);
            const overloadBg = isOverload ? `background:#fee2e2;color:#991b1b;border-left:3px solid #dc2626;` : '';
            const weightStyle = isOverload ? overloadBg : `background:${wc.bg};color:${wc.text};border-left:3px solid ${wc.border};`;
            const overloadWarn = isOverload ? `\n🚨 積載超過: ${capPct}% (${d.weight}kg / ${d.vehicle_capacity * 1000}kg)` : '';
            const presetTooltip = timeChanged ? `\n📋 元の指定時間: ${d.pickup_time}〜${d.delivery_time}` : '';
            html += `<div class="gantt-bar${multiDayClass}" data-id="${d.id}" data-vehicle-id="${v.id}" data-start="${d.start_time}" data-end="${d.end_time}" style="${weightStyle}left:${Math.max(left, 0)}%;width:${Math.min(width, 100 - left)}%;top:${top}px;bottom:auto;height:${barH}px;${overloadStyle}${conflictStyle}" onmousedown="event.stopPropagation();startGanttDrag(event, ${d.id}, ${v.id})" onclick="event.stopPropagation()" title="${driverLabel}\n${d.start_time}-${d.end_time} ${d.pickup_address || ''} → ${d.delivery_address || ''}${cargoInfo}${weightInfo}${capBadge}${multiDayTag}${presetTooltip}${driverConflict ? '\n⚠ このドライバーは同日に別車両にも配車されています' : ''}${overloadWarn}">`;
            html += `<div class="gantt-bar-resize gantt-bar-resize-left" onmousedown="event.stopPropagation();event.preventDefault();startGanttResize(event, ${d.id}, 'left', '${d.start_time}', '${d.end_time}')"></div>`;
            // ドライバー名 + 積み地→降ろし地（時間非表示、均等切り詰め）
            const overloadIcon = isOverload ? `<span style="color:#dc2626;font-weight:700;font-size:0.7rem" title="積載超過${capPct}%">🚨${capPct}%</span> ` : '';
            if (d.isMultiDay && dayStr !== d.date) {
                html += `<span class="gantt-bar-text">${d.dayLabel}</span>`;
            } else if (d.isMultiDay && dayStr !== d.end_date) {
                html += `<span class="gantt-bar-text">${overloadIcon}${driverBadge} ${d.pickup_address || ''} ▶</span>`;
            } else {
                const pickup = d.pickup_address || '';
                const delivery = d.delivery_address || '';
                html += `<span class="gantt-bar-text">${overloadIcon}${driverBadge} <span class="bar-addr-pickup">${pickup}</span>→<span class="bar-addr-delivery">${delivery}</span></span>`;
            }
            html += `<div class="gantt-bar-resize gantt-bar-resize-right" onmousedown="event.stopPropagation();event.preventDefault();startGanttResize(event, ${d.id}, 'right', '${d.start_time}', '${d.end_time}')"></div>`;
            html += `</div>`;
        });
        html += `</div>`;
    });
    return html;
}

// 協力会社行を配車表下部に追加（配車がある場合のみ表示）
function buildPartnerRows(dayStr, dispatches, partners) {
    const partnerDispatches = dispatches.filter(d => d.partner_id || d.is_partner);
    if (partnerDispatches.length === 0) return '';

    // 配車がある協力会社のみグループ化
    const partnerMap = {};
    partnerDispatches.forEach(d => {
        const pName = d.partner_name || '不明';
        if (!partnerMap[pName]) partnerMap[pName] = [];
        partnerMap[pName].push(d);
    });

    let html = '';
    html += `<div style="grid-column:1/-1;height:2px;background:#e2e8f0;margin:2px 0"></div>`;
    html += `<div style="grid-column:1/-1;padding:4px 12px;font-size:0.72rem;font-weight:700;color:#64748b;background:#f8fafc">🤝 協力会社</div>`;

    Object.entries(partnerMap).forEach(([pName, pDispatches]) => {
        html += `<div class="cal-vehicle-label" style="background:#fef3c7">`;
        html += `<div class="cal-vehicle-name" style="font-size:0.78rem">${pName}</div>`;
        html += `<div class="cal-vehicle-info"><span class="badge badge-purple" style="font-size:0.6rem;padding:1px 5px;background:#ede9fe;color:#7c3aed;border:1px solid #c4b5fd">協力</span></div>`;
        html += `</div>`;

        // data-vehicle-id="partner-xxx" で D&D 対応
        const pId = partners.find(p => p.name === pName)?.id || 0;
        html += `<div class="gantt-timeline" data-vehicle-id="partner-${pId}" data-maintenance="false" style="grid-column: 2 / -1;background:#fffbeb;" onclick="openQuickDispatchModal('${dayStr}', '08:00', '17:00', null, null, ${pId})">`;

        for (let h = HOUR_START; h <= HOUR_END; h++) {
            const left = ((h - HOUR_START) / HOUR_COUNT) * 100;
            html += `<div class="gantt-grid-line" style="left:${left}%"></div>`;
        }

        const lanes = [];
        const totalMin = HOUR_COUNT * 60;
        pDispatches.filter(d => {
            if (d.date === dayStr) return true;
            if (d.end_date && d.date <= dayStr && d.end_date >= dayStr) return true;
            return false;
        }).forEach(d => {
            let startMin = timeToMinutes(d.start_time);
            let endMin = timeToMinutes(d.end_time);
            let lane = 0;
            while (lanes[lane] && lanes[lane] > startMin) { lane++; }
            lanes[lane] = endMin;

            const left = ((startMin - HOUR_START * 60) / totalMin) * 100;
            const width = ((endMin - startMin) / totalMin) * 100;
            const wc = getWeightColor(d.weight, d.vehicle_capacity);
            const top = lane * 32 + 4;
            const cargoShort = d.cargo_description ? ` [${d.cargo_description}]` : '';

            html += `<div class="gantt-bar" data-id="${d.id}" data-vehicle-id="${d.vehicle_id}" data-start="${d.start_time}" data-end="${d.end_time}" style="background:${wc.bg};color:${wc.text};border-left:3px solid ${wc.border};left:${Math.max(left, 0)}%;width:${Math.min(width, 100 - left)}%;top:${top}px;bottom:auto;height:26px;" onmousedown="event.stopPropagation();startGanttDrag(event, ${d.id}, ${d.vehicle_id})" onclick="event.stopPropagation()" title="${pName}\n${d.start_time}-${d.end_time} ${d.pickup_address || ''} → ${d.delivery_address || ''}${cargoShort}">`;
            html += `<div class="gantt-bar-resize gantt-bar-resize-left" onmousedown="event.stopPropagation();event.preventDefault();startGanttResize(event, ${d.id}, 'left', '${d.start_time}', '${d.end_time}')"></div>`;
            html += `<span class="gantt-bar-text"><span class="bar-addr-pickup">${d.pickup_address || ''}</span>→<span class="bar-addr-delivery">${d.delivery_address || ''}</span></span>`;
            html += `<div class="gantt-bar-resize gantt-bar-resize-right" onmousedown="event.stopPropagation();event.preventDefault();startGanttResize(event, ${d.id}, 'right', '${d.start_time}', '${d.end_time}')"></div>`;
            html += `</div>`;
        });

        html += `</div>`;
    });
    return html;
}

// 【機能9】印刷用配車表
function printDispatchTable() {
    window.print();
}

// ===== ガントバー ドラッグ＆ドロップ（車両＋時間移動） =====
// ===== モバイル タッチD&D (Googleカレンダー方式) =====
let _mDrag = null; // { dispatchId, bar, ghost, startX, startY, isDragging, wrapper }

function mTouchStart(e, dispatchId) {
    const touch = e.touches[0];
    _touchStartTime = Date.now();
    _touchStartPos = { x: touch.clientX, y: touch.clientY };
    const bar = e.target.closest('.vg-bar');
    // テキスト選択を防止
    if (window.getSelection) window.getSelection().removeAllRanges();

    _touchTimer = setTimeout(() => {
        _touchTimer = null;
        // ロングプレス → D&Dモード開始
        if (bar) {
            e.preventDefault();
            navigator.vibrate && navigator.vibrate(30); // 触覚フィードバック
            const grid = bar.closest('.vertical-gantt');
            const gridRect = grid ? grid.getBoundingClientRect() : null;
            const wrapEl = document.querySelector('.vertical-gantt-wrapper');
            // バー内のタッチ位置オフセットを記録
            const barRect = bar.getBoundingClientRect();
            const offsetInBarY = touch.clientY - barRect.top;
            const offsetInBarX = touch.clientX - barRect.left;
            _mDrag = {
                dispatchId,
                bar,
                isDragging: true,
                startX: touch.clientX,
                startY: touch.clientY,
                origLeft: bar.style.left,
                origTop: bar.style.top,
                wrapper: grid,
                gridRect,
                wrapEl,
                scrollTopAtStart: wrapEl ? wrapEl.scrollTop : 0,
                scrollLeftAtStart: wrapEl ? wrapEl.scrollLeft : 0,
                offsetInBarY, // バー上端からの距離
                offsetInBarX, // バー左端からの距離
            };
            bar.style.opacity = '0.7';
            bar.style.boxShadow = '0 4px 16px rgba(0,0,0,0.3)';
            bar.style.zIndex = '50';
            bar.style.transform = 'scale(1.05)';
            bar.style.transition = 'transform 0.15s, box-shadow 0.15s';
            // スクロール・テキスト選択無効化
            document.body.classList.add('no-select');
            const wrapper = document.querySelector('.vertical-gantt-wrapper');
            if (wrapper) wrapper.style.overflow = 'hidden';
        }
    }, 400);

    // touchmove/touchendをbarに追加
    if (bar) {
        bar.addEventListener('touchmove', mTouchMove, { passive: false });
        bar.addEventListener('touchend', mTouchEndDrag, { passive: false });
    }
}

// タッチ座標からグリッドのセル（車両ID、時刻）を計算
function getCellFromTouch(clientX, clientY) {
    const wrap = _mDrag?.wrapEl || document.querySelector('.vertical-gantt-wrapper');
    if (!wrap || !window._mGridInfo) return null;
    const wrapRect = wrap.getBoundingClientRect();
    // バー内オフセット補正（長押し位置を考慮、_mDragがある場合のみ）
    const offY = _mDrag?.offsetInBarY || 0;
    const offX = _mDrag?.offsetInBarX || 0;
    const relX = (clientX - offX) - wrapRect.left + wrap.scrollLeft;
    const relY = (clientY - offY) - wrapRect.top + wrap.scrollTop;
    const { timeColW, colW, rowH, vehicles, hourStart } = window._mGridInfo;
    if (relX < timeColW) return null;
    const colIdx = Math.floor((relX - timeColW) / colW);
    if (colIdx < 0 || colIdx >= vehicles.length) return null;
    const rowIdx = Math.floor(relY / rowH);
    const hour = hourStart + rowIdx;
    return { vehicleId: vehicles[colIdx].id, hour, colIdx, rowIdx };
}

function mTouchMove(e) {
    const touch = e.touches[0];
    // ロングプレス前に指が動いたらキャンセル
    if (_touchTimer) {
        const dx = Math.abs(touch.clientX - _touchStartPos.x);
        const dy = Math.abs(touch.clientY - _touchStartPos.y);
        if (dx > 8 || dy > 8) {
            clearTimeout(_touchTimer);
            _touchTimer = null;
        }
        return;
    }
    if (!_mDrag || !_mDrag.isDragging) return;
    e.preventDefault();

    const dx = touch.clientX - _mDrag.startX;
    const dy = touch.clientY - _mDrag.startY;
    _mDrag.bar.style.transform = `translate(${dx}px, ${dy}px) scale(1.05)`;

    // ドロップ先のシャドウプレビュー（座標計算ベース）
    const wrapper = _mDrag.wrapper;
    if (wrapper) {
        const oldGhost = wrapper.querySelector('.vg-drop-ghost');
        if (oldGhost) oldGhost.remove();

        const cellInfo = getCellFromTouch(touch.clientX, touch.clientY);
        if (cellInfo && window._mGridInfo) {
            const { timeColW, colW, rowH } = window._mGridInfo;
            const barH = parseFloat(_mDrag.bar.style.height) || 40;
            const ghostLeft = timeColW + cellInfo.colIdx * colW + 2;
            const ghostTop = cellInfo.rowIdx * rowH;
            const ghost = document.createElement('div');
            ghost.className = 'vg-drop-ghost';
            ghost.style.cssText = `position:absolute;left:${ghostLeft}px;top:${ghostTop}px;width:${colW - 6}px;height:${barH}px;background:rgba(234,88,12,0.2);border:2px dashed #ea580c;border-radius:4px;pointer-events:none;z-index:5;`;
            wrapper.appendChild(ghost);
            _mDrag._lastCell = cellInfo;
        }
    }
}

function mTouchEndDrag(e) {
    const bar = e.target.closest('.vg-bar') || (_mDrag && _mDrag.bar);
    if (bar) {
        bar.removeEventListener('touchmove', mTouchMove);
        bar.removeEventListener('touchend', mTouchEndDrag);
    }

    if (_touchTimer) {
        clearTimeout(_touchTimer);
        _touchTimer = null;
        const elapsed = Date.now() - _touchStartTime;
        if (elapsed < 300) {
            showDispatchDetail(_mDrag ? _mDrag.dispatchId : 0);
        }
        _mDrag = null;
        return;
    }

    if (!_mDrag || !_mDrag.isDragging) { _mDrag = null; return; }

    // リセットスタイル
    _mDrag.bar.style.opacity = '';
    _mDrag.bar.style.boxShadow = '';
    _mDrag.bar.style.zIndex = '';
    _mDrag.bar.style.transform = '';
    _mDrag.bar.style.transition = '';

    // スクロール・テキスト選択復元
    document.body.classList.remove('no-select');
    const wrapperEl = document.querySelector('.vertical-gantt-wrapper');
    if (wrapperEl) wrapperEl.style.overflow = '';

    // セルハイライト解除 + ゴースト削除
    if (_mDrag.wrapper) {
        _mDrag.wrapper.querySelectorAll('.vg-cell').forEach(c => c.style.background = '');
        const ghost = _mDrag.wrapper.querySelector('.vg-drop-ghost');
        if (ghost) ghost.remove();
    }

    // ドロップ先を判定（座標計算ベース）
    const touch = e.changedTouches[0];
    const cellInfo = getCellFromTouch(touch.clientX, touch.clientY);
    if (cellInfo && cellInfo.vehicleId && !isNaN(cellInfo.hour)) {
        applyMobileDrop(_mDrag.dispatchId, cellInfo.vehicleId, cellInfo.hour);
        _mDrag = null;
        return;
    }
    // ドロップ先なし → 元に戻す
    _mDrag = null;
    loadDispatchCalendar();
}

async function applyMobileDrop(dispatchId, vehicleId, hour) {
    try {
        const dispatches = await cachedApiGet('/dispatches');
        const d = dispatches.find(x => x.id === dispatchId);
        if (!d) return;

        // 元の時間幅を維持
        const origStartMin = timeToMinutes(d.start_time);
        const origEndMin = timeToMinutes(d.end_time);
        const duration = origEndMin - origStartMin;
        const newStartMin = hour * 60;
        const newEndMin = newStartMin + duration;
        const newStart = `${String(Math.floor(newStartMin / 60)).padStart(2, '0')}:${String(newStartMin % 60).padStart(2, '0')}`;
        const newEnd = `${String(Math.floor(newEndMin / 60)).padStart(2, '0')}:${String(newEndMin % 60).padStart(2, '0')}`;

        // 時間変更がある場合、指定時間からの変更か確認
        const timeChanged = newStart !== d.start_time || newEnd !== d.end_time;
        if (timeChanged && d.shipment_id) {
            const allShipments = await cachedApiGet('/shipments');
            const shipment = allShipments.find(s => s.id === d.shipment_id);
            if (shipment && shipment.pickup_time && shipment.delivery_time) {
                const backToPreset = newStart === shipment.pickup_time && newEnd === shipment.delivery_time;
                if (!backToPreset) {
                    const confirmed = await showConfirm(
                        `⚠️ 指定時間: ${shipment.pickup_time}〜${shipment.delivery_time}\n\n` +
                        `変更後: ${newStart}〜${newEnd}\n\n指定時間外に変更しますか？`
                    );
                    if (!confirmed) { loadDispatchCalendar(); return; }
                }
            }
        }

        // 車両変更時: その車両に既存ドライバーがいれば変更確認
        let updateData = { vehicle_id: vehicleId, start_time: newStart, end_time: newEnd };
        if (vehicleId !== d.vehicle_id) {
            const allDispatches = await cachedApiGet('/dispatches');
            const existingOnVehicle = allDispatches.find(x => x.vehicle_id === vehicleId && x.date === d.date && x.driver_id && x.id !== dispatchId);
            if (existingOnVehicle && existingOnVehicle.driver_id !== d.driver_id) {
                const driverName = existingOnVehicle.driver_name || `ID:${existingOnVehicle.driver_id}`;
                const changeDriver = await showConfirm(
                    `🚛 この車両には ${driverName} が配車されています。\n\nドライバーを ${driverName} に変更しますか？`
                );
                if (changeDriver) {
                    updateData.driver_id = existingOnVehicle.driver_id;
                }
            }
        }

        // 楽観的UI: バーを即座にDOM上で移動
        if (window._mGridInfo) {
            const { timeColW, colW, rowH } = window._mGridInfo;
            const grid = document.querySelector('.vertical-gantt');
            const bar = grid?.querySelector(`.vg-bar[data-id="${dispatchId}"]`) ||
                        grid?.querySelector(`[onclick*="showDispatchDetail(${dispatchId})"]`);
            if (bar) {
                const vIdx = window._mGridInfo.vehicles.findIndex(v => v.id === vehicleId);
                if (vIdx >= 0) {
                    const newTopPx = (hour * 60 - HOUR_START * 60) / 60 * rowH;
                    bar.style.left = (timeColW + vIdx * colW + 2) + 'px';
                    bar.style.top = newTopPx + 'px';
                    bar.style.transform = '';
                    bar.style.opacity = '1';
                }
            }
        }

        // バックグラウンドでAPI更新
        apiPut(`/dispatches/${dispatchId}`, updateData).then(() => {
            invalidateCache('/dispatches');
            scheduleBgSync(3);
        }).catch(e => {
            alert('移動に失敗: ' + e.message);
            loadDispatchCalendar();
        });
    } catch (e) {
        alert('移動に失敗: ' + e.message);
        loadDispatchCalendar();
    }
}

function mTouchEnd(e, dispatchId) {
    // mTouchEndDragで処理されなかった場合のフォールバック
    if (_touchTimer) {
        clearTimeout(_touchTimer);
        _touchTimer = null;
        const elapsed = Date.now() - _touchStartTime;
        if (elapsed < 300) {
            showDispatchDetail(dispatchId);
        }
    }
}
function showMobileActionSheet(dispatchId) {
    const sheet = document.getElementById('mobile-action-sheet');
    if (!sheet) return;
    const body = document.getElementById('action-sheet-body');
    body.innerHTML = `
        <div style="text-align:center;font-weight:700;margin-bottom:12px;color:#475569">配車操作</div>
        <button onclick="closeMobileActionSheet();showDispatchDetail(${dispatchId})">📋 詳細を表示</button>
        <button onclick="closeMobileActionSheet();openEditDispatchModal(${dispatchId})">✏️ 編集</button>
        <button onclick="closeMobileActionSheet();mobileChangeVehicle(${dispatchId})">🚛 車両を変更</button>
        <button onclick="closeMobileActionSheet();mobileChangeTime(${dispatchId})">⏰ 時間を変更</button>
        <button onclick="closeMobileActionSheet();generateTransportRequest(${dispatchId})">📄 輸送依頼書</button>
        <button onclick="closeMobileActionSheet();generateVehicleNotification(${dispatchId})">📋 車番連絡票</button>
        <button class="action-sheet-cancel" onclick="closeMobileActionSheet()">キャンセル</button>
    `;
    sheet.style.display = 'flex';
}
function showMobileFilterModal() {
    const vehicles = _cache['/vehicles']?.data || [];
    const vehicleTypes = [...new Set(vehicles.map(v => v.type))];
    const capacities = [...new Set(vehicles.map(v => v.capacity))].sort((a, b) => a - b);
    document.getElementById('modal-title').textContent = '絞り込み';
    document.getElementById('modal-body').innerHTML = `
        <div style="margin-bottom:12px">
            <div style="font-size:0.8rem;font-weight:600;margin-bottom:6px">車種</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
                ${vehicleTypes.map(t => `<label class="m-filter-chip ${_mFilterTypes.includes(t) ? 'active' : ''}" style="font-size:0.75rem;padding:6px 12px" onclick="this.classList.toggle('active')"><input type="checkbox" class="mf-type" value="${t}" ${_mFilterTypes.includes(t) ? 'checked' : ''} hidden>${t}</label>`).join('')}
            </div>
        </div>
        <div style="margin-bottom:12px">
            <div style="font-size:0.8rem;font-weight:600;margin-bottom:6px">積載量</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
                ${capacities.map(c => `<label class="m-filter-chip ${_mFilterCaps.includes(String(c)) ? 'active' : ''}" style="font-size:0.75rem;padding:6px 12px" onclick="this.classList.toggle('active')"><input type="checkbox" class="mf-cap" value="${c}" ${_mFilterCaps.includes(String(c)) ? 'checked' : ''} hidden>${c}t</label>`).join('')}
            </div>
        </div>
        <div class="form-actions" style="margin-top:16px;gap:8px">
            <button class="btn" onclick="_mFilterTypes=[];_mFilterCaps=[];closeModal();loadDispatchCalendar()">クリア</button>
            <button class="btn btn-primary" onclick="applyMobileFilter()">適用</button>
        </div>`;
    showModal();
}
function applyMobileFilter() {
    _mFilterTypes = [...document.querySelectorAll('.mf-type:checked')].map(el => el.value);
    _mFilterCaps = [...document.querySelectorAll('.mf-cap:checked')].map(el => el.value);
    closeModal();
    loadDispatchCalendar();
}

function toggleMFilter(type, value) {
    const arr = type === 'type' ? _mFilterTypes : _mFilterCaps;
    const idx = arr.indexOf(value);
    if (idx >= 0) arr.splice(idx, 1);
    else arr.push(value);
    // チップのactive状態をトグル（再描画せずUI更新）
    const chip = event.target.closest('.m-filter-chip');
    if (chip) chip.classList.toggle('active');
}

function toggleMobileMore() {
    const menu = document.getElementById('mobileMoreMenu');
    if (menu) menu.style.display = menu.style.display === 'none' ? '' : 'none';
}

function closeMobileActionSheet() {
    const sheet = document.getElementById('mobile-action-sheet');
    if (sheet) sheet.style.display = 'none';
}

async function mobileChangeVehicle(dispatchId) {
    const vehicles = await cachedApiGet('/vehicles');
    const activeV = vehicles.filter(v => v.status !== '整備中');
    const options = activeV.map(v => `${v.id}:${v.number} (${v.type} ${v.capacity}t)`);
    const sheet = document.getElementById('mobile-action-sheet');
    const body = document.getElementById('action-sheet-body');
    body.innerHTML = `
        <div style="text-align:center;font-weight:700;margin-bottom:12px">🚛 車両を選択</div>
        ${activeV.map(v => `<button onclick="mobileApplyVehicle(${dispatchId},${v.id})">${v.number}<br><span style="font-size:0.75rem;color:#64748b">${v.type} ${v.capacity}t</span></button>`).join('')}
        <button class="action-sheet-cancel" onclick="closeMobileActionSheet()">キャンセル</button>
    `;
    sheet.style.display = 'flex';
}
async function mobileApplyVehicle(dispatchId, vehicleId) {
    closeMobileActionSheet();
    try {
        await apiPut(`/dispatches/${dispatchId}`, { vehicle_id: vehicleId });
        invalidateCache('/dispatches');
        loadDispatchCalendar();
    } catch (e) { alert('車両変更に失敗しました: ' + e.message); }
}

async function mobileChangeTime(dispatchId) {
    const dispatches = await cachedApiGet('/dispatches');
    const d = dispatches.find(x => x.id === dispatchId);
    if (!d) return;
    const newStart = prompt('開始時間を入力 (例: 08:00)', d.start_time);
    if (!newStart) return;
    const newEnd = prompt('終了時間を入力 (例: 12:00)', d.end_time);
    if (!newEnd) return;
    try {
        await apiPut(`/dispatches/${dispatchId}`, { start_time: newStart, end_time: newEnd });
        invalidateCache('/dispatches');
        loadDispatchCalendar();
    } catch (e) { alert('時間変更に失敗しました: ' + e.message); }
}

function startGanttDrag(e, dispatchId, vehicleId) {
    if (isMobile()) return; // モバイルではD&D無効
    if (e.target.classList.contains('gantt-bar-resize')) return;
    e.preventDefault();
    cancelBgSync(); // ドラッグ中のバックグラウンド同期を防止
    const bar = e.target.closest('.gantt-bar');
    const timeline = bar.closest('.gantt-timeline');
    const origStart = bar.dataset.start;
    const origEnd = bar.dataset.end;
    const duration = timeToMinutes(origEnd) - timeToMinutes(origStart);
    dragState = {
        id: dispatchId,
        vehicleId: vehicleId,
        bar: bar,
        barLeft: bar.style.left,
        barWidth: bar.style.width,
        origStart: origStart,
        origEnd: origEnd,
        duration: duration,
        newStart: origStart,
        newEnd: origEnd,
        startX: e.clientX,
        startY: e.clientY,
        timelineWidth: timeline.offsetWidth,
        dragging: false,
        targetVehicleId: vehicleId,
        ghost: null,
    };
    document.addEventListener('mousemove', onGanttDragMove);
    document.addEventListener('mouseup', onGanttDragEnd);
}

function removeGhost() {
    if (dragState && dragState.ghost) {
        dragState.ghost.remove();
        dragState.ghost = null;
    }
}

function calcDragTime(dx) {
    const totalMin = HOUR_COUNT * 60;
    const pxPerMin = dragState.timelineWidth / totalMin;
    const step = 15;
    const deltaMins = Math.round(dx / pxPerMin / step) * step;
    let newStartMin = timeToMinutes(dragState.origStart) + deltaMins;
    newStartMin = Math.max(HOUR_START * 60, Math.min(newStartMin, HOUR_END * 60 - dragState.duration));
    const newEndMin = newStartMin + dragState.duration;
    return { newStart: minutesToTime(newStartMin), newEnd: minutesToTime(newEndMin), newStartMin, newEndMin };
}

function updateGhostPosition(ghost, newStartMin, newEndMin) {
    const totalMin = HOUR_COUNT * 60;
    const left = ((newStartMin - HOUR_START * 60) / totalMin) * 100;
    const width = ((newEndMin - newStartMin) / totalMin) * 100;
    ghost.style.left = Math.max(left, 0) + '%';
    ghost.style.width = Math.min(width, 100 - left) + '%';
    ghost.innerHTML = `<span class="gantt-ghost-label">${minutesToTime(newStartMin)} - ${minutesToTime(newEndMin)}</span>`;
}

function onGanttDragMove(e) {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = Math.abs(e.clientY - dragState.startY);
    const absDx = Math.abs(dx);

    if (!dragState.dragging && (absDx > 5 || dy > 5)) {
        dragState.dragging = true;
        dragState.bar.classList.add('dragging');
        document.body.style.cursor = 'grabbing';
    }
    if (!dragState.dragging) return;

    const { newStart, newEnd, newStartMin, newEndMin } = calcDragTime(dx);
    dragState.newStart = newStart;
    dragState.newEnd = newEnd;

    document.querySelectorAll('.gantt-timeline.drag-over').forEach(el => el.classList.remove('drag-over'));
    document.getElementById('unassigned-panel')?.classList.remove('drag-over');

    const elements = document.elementsFromPoint(e.clientX, e.clientY);
    const timeline = elements.find(el => el.classList.contains('gantt-timeline'));
    const unassignedPanel = elements.find(el => el.id === 'unassigned-panel' || el.closest('#unassigned-panel'));

    if (unassignedPanel) {
        dragState.droppedOnUnassigned = true;
        dragState.targetVehicleId = null;
        document.getElementById('unassigned-panel')?.classList.add('drag-over');
        removeGhost();
    } else if (timeline) {
        dragState.droppedOnUnassigned = false;
        // Requirement 5: 整備中の車両にはドロップ不可
        if (timeline.dataset.maintenance === 'true') {
            dragState.targetVehicleId = null;
            removeGhost();
            return;
        }
        const vid = parseInt(timeline.dataset.vehicleId);
        dragState.targetVehicleId = vid;
        if (vid !== dragState.vehicleId) timeline.classList.add('drag-over');

        if (!dragState.ghost || dragState.ghost.parentElement !== timeline) {
            removeGhost();
            const ghost = document.createElement('div');
            ghost.className = 'gantt-bar gantt-bar-ghost';
            ghost.style.pointerEvents = 'none';
            timeline.appendChild(ghost);
            dragState.ghost = ghost;
        }
        updateGhostPosition(dragState.ghost, newStartMin, newEndMin);
    } else {
        dragState.droppedOnUnassigned = false;
        dragState.targetVehicleId = null;
        removeGhost();
    }
}

async function onGanttDragEnd(e) {
    document.removeEventListener('mousemove', onGanttDragMove);
    document.removeEventListener('mouseup', onGanttDragEnd);
    document.body.style.cursor = '';
    document.querySelectorAll('.gantt-timeline.drag-over').forEach(el => el.classList.remove('drag-over'));
    document.getElementById('unassigned-panel')?.classList.remove('drag-over');
    removeGhost();

    if (!dragState) return;
    const { id, vehicleId, dragging, targetVehicleId, bar, origStart, origEnd, newStart, newEnd } = dragState;
    if (bar) bar.classList.remove('dragging');
    const droppedOnUnassigned = dragState.droppedOnUnassigned;
    dragState = null;

    if (!dragging) { showDispatchDetail(id); return; }

    justDragged = true;
    setTimeout(() => { justDragged = false; }, 200);

    // 未配車パネルにドロップ → 配車を削除して案件を未配車に戻す
    if (droppedOnUnassigned) {
        if (!await showConfirm('この配車を取り消して未配車に戻しますか？')) return;
        const cachedDispatches = _cache['_lastDispatches']?.data || await apiGet('/dispatches');
        const d = cachedDispatches.find(x => x.id === id);
        if (d && d.shipment_id) {
            await apiPut(`/shipments/${d.shipment_id}`, { status: '未配車' });
        }
        await apiDelete(`/dispatches/${id}`);
        invalidateCache('/shipments');
        invalidateCache('/dispatches');
        loadDispatchCalendar();
        return;
    }

    const vehicleChanged = targetVehicleId && targetVehicleId !== vehicleId;
    const timeChanged = newStart !== origStart || newEnd !== origEnd;

    if (vehicleChanged || timeChanged) {
        // 勤務時間外チェック（車両変更時）
        if (vehicleChanged) {
            const allDispatches2 = _cache['_lastDispatches']?.data || await cachedApiGet('/dispatches');
            const thisDisp = allDispatches2.find(x => x.id === id);
            const targetDispatches = allDispatches2.filter(x => x.vehicle_id === targetVehicleId);
            const targetDriverId = targetDispatches.length > 0 ? targetDispatches[0].driver_id : null;
            if (targetDriverId) {
                const allDrivers = await cachedApiGet('/drivers');
                const driver = allDrivers.find(d => d.id === targetDriverId);
                if (driver) {
                    const ws = driver.work_start || '08:00';
                    const we = driver.work_end || '17:00';
                    const barStart = timeChanged ? newStart : origStart;
                    const barEnd = timeChanged ? newEnd : origEnd;
                    if (barStart < ws || barEnd > we) {
                        if (!await showConfirm(`⚠ ${driver.name}の勤務時間は${ws}〜${we}ですが、この案件（${barStart}〜${barEnd}）は時間外にかかります。割り当てますか？`)) {
                            loadDispatchCalendar();
                            return;
                        }
                    }
                }
            }
        }

        // 移動時間チェック（車両変更 or 時間変更時）
        {
            const allDispatches3 = _cache['_lastDispatches']?.data || await cachedApiGet('/dispatches');
            const thisDisp3 = allDispatches3.find(x => x.id === id);
            const allShipments3 = await cachedApiGet('/shipments');
            const thisShipment = thisDisp3 ? allShipments3.find(s => s.id === thisDisp3.shipment_id) : null;
            if (thisShipment) {
                const checkVehicle = vehicleChanged ? targetVehicleId : vehicleId;
                const otherDispatches = allDispatches3.filter(x => x.vehicle_id == checkVehicle && x.id !== id);
                const barStart = timeChanged ? newStart : origStart;
                const barEnd = timeChanged ? newEnd : origEnd;
                const travelWarnings = await checkTravelFeasibility(otherDispatches, thisShipment, barStart, barEnd, allShipments3);
                if (travelWarnings.length > 0) {
                    if (!await showConfirm(travelWarnings.join('\n') + '\n\nこのまま割り当てますか？')) {
                        loadDispatchCalendar();
                        return;
                    }
                }
            }
        }

        // Requirement 4: 案件に元々時間が設定されている場合のみ警告
        if (timeChanged) {
            const allDispatches = _cache['_lastDispatches']?.data || await cachedApiGet('/dispatches');
            const thisDispatch = allDispatches.find(x => x.id === id);
            if (thisDispatch && thisDispatch.shipment_id) {
                const allShipments = await cachedApiGet('/shipments');
                const shipment = allShipments.find(s => s.id === thisDispatch.shipment_id);
                if (shipment && shipment.pickup_time && shipment.delivery_time) {
                    // 指定時間に戻す場合は警告不要
                    const backToPreset = newStart === shipment.pickup_time && newEnd === shipment.delivery_time;
                    if (!backToPreset && !await showConfirm(`この案件には元々の指定時間（${shipment.pickup_time}〜${shipment.delivery_time}）がありますが変更しますか？`)) {
                        loadDispatchCalendar();
                        return;
                    }
                }
            }
        }

        // オプティミスティック更新: DOM直接操作で即座に反映
        if (bar) {
            if (timeChanged) {
                const totalMin = HOUR_COUNT * 60;
                const newL = ((timeToMinutes(newStart) - HOUR_START * 60) / totalMin) * 100;
                const newW = ((timeToMinutes(newEnd) - timeToMinutes(newStart)) / totalMin) * 100;
                bar.style.left = newL + '%';
                bar.style.width = Math.max(newW, 0.5) + '%';
            }
            if (vehicleChanged) {
                const newTimeline = document.querySelector(`.gantt-timeline[data-vehicle-id="${targetVehicleId}"]`);
                if (newTimeline) newTimeline.appendChild(bar);
            }
        }

        // バックグラウンドでAPI送信 → 完了後にデータ同期
        const update = {};
        if (vehicleChanged) update.vehicle_id = targetVehicleId;
        if (timeChanged) { update.start_time = newStart; update.end_time = newEnd; }
        fetch(API + `/dispatches/${id}`, {
            method: 'PUT',
            headers: authHeaders(),
            body: JSON.stringify(update)
        }).then(resp => {
            if (!resp.ok) {
                resp.json().catch(() => ({})).then(err => {
                    alert('配車の更新に失敗しました: ' + (err.detail || resp.statusText));
                    loadDispatchCalendar(); // エラー時はフルリロードで復元
                });
                return;
            }
            // 成功: キャッシュを更新して静かに同期（デバウンス: 最後のD&Dから5秒後に1回だけ）
            invalidateCache('/dispatches');
            invalidateCache('_lastDispatches');
            scheduleBgSync(5);
        }).catch(e => {
            alert('配車の更新に失敗しました: ' + e.message);
            loadDispatchCalendar();
        });
    }
}

// ===== 未配車案件ドラッグ＆ドロップ =====
function startShipmentDrag(e, shipmentId, clientName, pickup, delivery, dayStr) {
    e.preventDefault();
    cancelBgSync(); // ドラッグ中のバックグラウンド同期を防止
    shipmentDragState = {
        shipmentId, clientName, pickup, delivery, dayStr,
        startX: e.clientX, startY: e.clientY,
        dragging: false, ghost: null, targetVehicleId: null, dropTime: '08:00',
    };
    document.addEventListener('mousemove', onShipmentDragMove);
    document.addEventListener('mouseup', onShipmentDragEnd);
}

function onShipmentDragMove(e) {
    if (!shipmentDragState) return;
    const dx = Math.abs(e.clientX - shipmentDragState.startX);
    const dy = Math.abs(e.clientY - shipmentDragState.startY);
    if (!shipmentDragState.dragging && (dx > 5 || dy > 5)) {
        shipmentDragState.dragging = true;
        document.body.style.cursor = 'grabbing';
    }
    if (!shipmentDragState.dragging) return;

    document.querySelectorAll('.gantt-timeline.drag-over').forEach(el => el.classList.remove('drag-over'));

    const elements = document.elementsFromPoint(e.clientX, e.clientY);
    const timeline = elements.find(el => el.classList.contains('gantt-timeline'));

    if (timeline) {
        // Requirement 5: 整備中の車両にはドロップ不可
        if (timeline.dataset.maintenance === 'true') {
            shipmentDragState.targetVehicleId = null;
            if (shipmentDragState.ghost) { shipmentDragState.ghost.remove(); shipmentDragState.ghost = null; }
            return;
        }
        const vid = parseInt(timeline.dataset.vehicleId);
        shipmentDragState.targetVehicleId = vid;
        timeline.classList.add('drag-over');

        // 時間を計算
        const rect = timeline.getBoundingClientRect();
        const relX = e.clientX - rect.left;
        const pct = relX / rect.width;
        const totalMin = HOUR_COUNT * 60;
        const mins = HOUR_START * 60 + pct * totalMin;
        const snapped = Math.round(mins / 15) * 15;
        const startMin = Math.max(HOUR_START * 60, Math.min(snapped, HOUR_END * 60 - 60));
        shipmentDragState.dropTime = minutesToTime(startMin);

        // ゴーストバー表示
        if (!shipmentDragState.ghost || shipmentDragState.ghost.parentElement !== timeline) {
            if (shipmentDragState.ghost) shipmentDragState.ghost.remove();
            const ghost = document.createElement('div');
            ghost.className = 'gantt-bar gantt-bar-ghost ev-green';
            ghost.style.pointerEvents = 'none';
            timeline.appendChild(ghost);
            shipmentDragState.ghost = ghost;
        }
        const left = ((startMin - HOUR_START * 60) / totalMin) * 100;
        const width = (60 / totalMin) * 100; // デフォルト1時間幅
        shipmentDragState.ghost.style.left = left + '%';
        shipmentDragState.ghost.style.width = width + '%';
        shipmentDragState.ghost.innerHTML = `<span class="gantt-ghost-label">${shipmentDragState.dropTime} ${shipmentDragState.clientName}</span>`;
    } else {
        shipmentDragState.targetVehicleId = null;
        if (shipmentDragState.ghost) { shipmentDragState.ghost.remove(); shipmentDragState.ghost = null; }
    }
}

async function onShipmentDragEnd(e) {
    document.removeEventListener('mousemove', onShipmentDragMove);
    document.removeEventListener('mouseup', onShipmentDragEnd);
    document.body.style.cursor = '';
    document.querySelectorAll('.gantt-timeline.drag-over').forEach(el => el.classList.remove('drag-over'));

    if (!shipmentDragState) return;
    const { shipmentId, dayStr, dragging, targetVehicleId, dropTime, ghost } = shipmentDragState;
    if (ghost) ghost.remove();
    shipmentDragState = null;

    if (!dragging) return;
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 200);

    if (!targetVehicleId) return;

    // 案件・ドライバー・協力会社・配車を並列取得（キャッシュ利用）
    const [allShipments, drivers, partners, existingDispatches] = await Promise.all([
        cachedApiGet('/shipments'),
        cachedApiGet('/drivers'),
        cachedApiGet('/partners'),
        apiGet(`/dispatches?target_date=${dayStr}`),
    ]);
    const shipment = allShipments.find(s => s.id === shipmentId);
    const hasPresetTimes = shipment && shipment.pickup_time && shipment.delivery_time;

    // 指定時間がある場合はそれを使う
    let startTime = dropTime;
    let endTime;
    if (hasPresetTimes) {
        startTime = shipment.pickup_time;
        endTime = shipment.delivery_time;
    } else {
        const endMin = timeToMinutes(dropTime) + 60;
        endTime = minutesToTime(Math.min(endMin, HOUR_END * 60));
    }
    const availableDrivers = drivers.filter(d => d.status !== '非番');

    // 同日に別車両で配車されているドライバーに⚠マーク
    const busyDriverMap = {};
    existingDispatches.forEach(x => {
        if (x.driver_id) {
            if (!busyDriverMap[x.driver_id]) busyDriverMap[x.driver_id] = [];
            busyDriverMap[x.driver_id].push(x.vehicle_number || `車両${x.vehicle_id}`);
        }
    });

    const vehicleDispatches = existingDispatches.filter(d => d.vehicle_id === targetVehicleId);
    let autoDriverId = '';
    let autoDriverNote = '';
    if (vehicleDispatches.length > 0) {
        const existing = vehicleDispatches[0];
        if (existing.driver_id && !existing.notes?.startsWith('partner:')) {
            autoDriverId = existing.driver_id;
            autoDriverNote = `<div style="margin-bottom:8px;padding:6px 10px;background:#dbeafe;border-radius:6px;font-size:0.8rem;color:#1e40af">💡 この車両の既存配車（${existing.driver_name}）からドライバーを自動選択しました</div>`;
        }
    }

    const presetNote = hasPresetTimes ? `<div style="margin-bottom:12px;padding:8px 12px;background:#fef3c7;border-radius:6px;font-size:0.82rem;color:#92400e">⚠ この案件には指定時間（${shipment.pickup_time}〜${shipment.delivery_time}）が設定されています${shipment.time_note ? ' / ' + shipment.time_note : ''}</div>` : '';

    document.getElementById('modal-title').textContent = '配車確定';
    document.getElementById('modal-body').innerHTML = `
        <div style="margin-bottom:16px;padding:12px;background:#f0fdf4;border-radius:8px;font-size:0.85rem">
            <div><strong>日付:</strong> ${dayStr}</div>
            <div><strong>時間:</strong> ${startTime} 〜 ${endTime}</div>
            ${shipment ? `<div><strong>荷主:</strong> ${shipment.client_name}</div>
            <div><strong>荷物:</strong> ${shipment.cargo_description || '-'} ${shipment.weight ? shipment.weight + 'kg' : ''}</div>
            <div><strong>区間:</strong> ${shipment.pickup_address || '-'} → ${shipment.delivery_address || '-'}</div>` : ''}
        </div>
        ${presetNote}
        ${autoDriverNote}
        <div class="form-row">
            <div class="form-group">
                <label>ドライバー（自社）</label>
                <select id="f-sd-driver" onchange="document.getElementById('f-sd-partner').value=''; checkDriverWorkTime(this, '${startTime}', '${endTime}')">
                    <option value="">-- 選択 --</option>
                    ${availableDrivers.map(d => {
                        const busy = busyDriverMap[d.id];
                        const ws = d.work_start || '08:00';
                        const we = d.work_end || '17:00';
                        const outOfHours = startTime < ws || endTime > we;
                        const warn = busy ? `⚠ [${busy.join(',')}] ` : '';
                        const offWarn = outOfHours ? '🕐時間外 ' : '';
                        return `<option value="${d.id}" ${d.id == autoDriverId ? 'selected' : ''} data-ws="${ws}" data-we="${we}">${offWarn}${warn}${d.name} (${d.license_type}) ${ws}〜${we}</option>`;
                    }).join('')}
                </select>
                <div id="driver-work-warn"></div>
            </div>
            <div class="form-group">
                <label>または 協力会社</label>
                <select id="f-sd-partner" onchange="document.getElementById('f-sd-driver').value=''">
                    <option value="">-- 選択 --</option>
                    ${partners.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
                </select>
            </div>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>開始時刻</label>
                <input type="time" id="f-sd-start" value="${startTime}" ${hasPresetTimes ? `data-preset="${shipment.pickup_time}" onchange="warnTimeChange(this,'${shipment.pickup_time}','${shipment.delivery_time}')"` : ''}>
            </div>
            <div class="form-group">
                <label>終了時刻</label>
                <input type="time" id="f-sd-end" value="${endTime}" ${hasPresetTimes ? `data-preset="${shipment.delivery_time}" onchange="warnTimeChange(this,'${shipment.pickup_time}','${shipment.delivery_time}')"` : ''}>
            </div>
        </div>
        <div class="form-actions">
            <button class="btn" onclick="closeModal()">キャンセル</button>
            <button class="btn btn-primary" onclick="confirmShipmentDrop(${targetVehicleId}, ${shipmentId}, '${dayStr}')">配車する</button>
        </div>`;
    showModal();
    // 自動選択されたドライバーの勤務時間外チェック
    const driverSel = document.getElementById('f-sd-driver');
    if (driverSel && driverSel.value) checkDriverWorkTime(driverSel, startTime, endTime);
}

function checkDriverWorkTime(sel, startTime, endTime) {
    const opt = sel.options[sel.selectedIndex];
    if (!opt || !opt.value) return;
    const ws = opt.dataset.ws;
    const we = opt.dataset.we;
    if (ws && we && (startTime < ws || endTime > we)) {
        const warnDiv = document.getElementById('driver-work-warn');
        if (warnDiv) warnDiv.innerHTML = `<div style="padding:6px 10px;background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;font-size:0.8rem;color:#991b1b;margin-top:4px">⚠ このドライバーの勤務時間（${ws}〜${we}）外です</div>`;
    } else {
        const warnDiv = document.getElementById('driver-work-warn');
        if (warnDiv) warnDiv.innerHTML = '';
    }
}

async function warnTimeChange(el, presetStart, presetEnd) {
    if (!await showConfirm('すでに時間が指定されている案件ですが移動させますか？')) {
        document.getElementById('f-sd-start').value = presetStart;
        document.getElementById('f-sd-end').value = presetEnd;
    }
}

async function confirmShipmentDrop(vehicleId, shipmentId, dayStr) {
    const driverId = parseInt(document.getElementById('f-sd-driver').value) || 0;
    const partnerId = parseInt(document.getElementById('f-sd-partner').value) || 0;
    if (!driverId && !partnerId) return alert('ドライバーまたは協力会社を選択してください');
    const startTime = document.getElementById('f-sd-start').value;
    const endTime = document.getElementById('f-sd-end').value;
    // ドライバー重複チェック
    if (driverId) {
        const conflict = await checkDriverConflict(driverId, dayStr, startTime, endTime, vehicleId);
        if (conflict) {
            alert(`このドライバーは同日に別の車両（${conflict}）で配車されています。\n時間が重複しているため配車できません。`);
            return;
        }
    }
    const postData = {
        shipment_id: shipmentId,
        date: dayStr,
        start_time: startTime,
        end_time: endTime,
    };
    if (partnerId) {
        // 協力会社配車: vehicle_id不要
        postData.partner_id = partnerId;
    } else {
        // 自社配車
        postData.vehicle_id = vehicleId;
        postData.driver_id = driverId;
    }
    await apiPost('/dispatches', postData);
    closeModal();
    loadDispatchCalendar();
}

// ===== 配車リセット =====
let _lastResetData = []; // リセット前の配車データ（復元用）
let _lastResetDay = '';

async function resetDispatches(dayStr) {
    const dispatches = await apiGet(`/dispatches?target_date=${dayStr}`);
    const toReset = dispatches.filter(d => !d.partner_id); // 協力会社以外
    if (toReset.length === 0) return alert('リセットする配車がありません');

    if (!await showConfirm(`⚠️ ${dayStr} の配車 ${toReset.length}件（協力会社除く）をリセットします。\n\n案件は未配車に戻ります。\nリセット後は「↩ 元に戻す」で復元できます。\n\nよろしいですか？`)) return;

    showAutoDispatchLoading(true, 'リセット中...');

    // リセット前のデータを保存（復元用）
    _lastResetData = toReset.map(d => ({
        id: d.id,
        shipment_id: d.shipment_id,
        vehicle_id: d.vehicle_id,
        driver_id: d.driver_id,
        date: d.date,
        start_time: d.start_time,
        end_time: d.end_time,
        end_date: d.end_date,
        status: d.status,
        notes: d.notes,
    }));
    _lastResetDay = dayStr;

    let ok = 0, ng = 0;
    for (const d of toReset) {
        try {
            if (d.shipment_id) {
                await apiPut(`/shipments/${d.shipment_id}`, { status: '未配車' });
            }
            await apiDelete(`/dispatches/${d.id}`);
            ok++;
        } catch (e) { console.error('Reset failed:', d.id, e); ng++; }
    }
    // 自動配車のundoデータもクリア
    _lastAutoDispatchIds = [];
    _lastAutoDispatchDay = '';
    showAutoDispatchLoading(false);
    invalidateCache('/shipments');
    invalidateCache('/dispatches');
    invalidateCache('_lastDispatches');
    loadDispatchCalendar();
    alert(`配車をリセットしました\n✅ 削除: ${ok}件${ng > 0 ? `\n❌ 失敗: ${ng}件` : ''}\n\n※「↩ 元に戻す」で復元できます`);
}

async function undoReset() {
    if (_lastResetData.length === 0) return alert('復元するデータがありません');
    if (!await showConfirm(`リセット前の配車（${_lastResetData.length}件）を復元しますか？`)) return;

    let ok = 0, ng = 0;
    for (const d of _lastResetData) {
        try {
            await apiPost('/dispatches', {
                shipment_id: d.shipment_id,
                vehicle_id: d.vehicle_id,
                driver_id: d.driver_id,
                date: d.date,
                start_time: d.start_time,
                end_time: d.end_time,
                end_date: d.end_date,
                status: d.status || '予定',
                notes: d.notes || '',
            });
            ok++;
        } catch (e) { console.error('Undo reset failed:', d, e); ng++; }
    }
    _lastResetData = [];
    _lastResetDay = '';
    invalidateCache('/shipments');
    invalidateCache('/dispatches');
    invalidateCache('_lastDispatches');
    loadDispatchCalendar();
    alert(`配車を復元しました\n✅ 復元: ${ok}件${ng > 0 ? `\n❌ 失敗: ${ng}件` : ''}`);
}

// ===== 自動配車 =====
let _lastAutoDispatchIds = []; // 直前の自動配車で作成された配車ID
let _lastAutoDispatchDay = '';

async function undoAutoDispatch() {
    if (_lastAutoDispatchIds.length === 0) return alert('取り消す自動配車がありません');
    if (!await showConfirm(`直前の自動配車（${_lastAutoDispatchIds.length}件）を取り消しますか？\n案件は未配車に戻ります。`)) return;
    let ok = 0, ng = 0;
    // キャッシュを無効化して最新データを取得
    invalidateCache('/dispatches');
    invalidateCache('_lastDispatches');
    const allDispatches = await apiGet('/dispatches');
    for (const id of _lastAutoDispatchIds) {
        try {
            const d = allDispatches.find(x => x.id === id);
            if (d && d.shipment_id) {
                await apiPut(`/shipments/${d.shipment_id}`, { status: '未配車' });
            }
            await apiDelete(`/dispatches/${id}`);
            ok++;
        } catch (e) { console.error('Undo failed for dispatch', id, e); ng++; }
    }
    _lastAutoDispatchIds = [];
    _lastAutoDispatchDay = '';
    invalidateCache('/shipments');
    invalidateCache('/dispatches');
    invalidateCache('_lastDispatches');
    loadDispatchCalendar();
    alert(`自動配車を取り消しました\n✅ 取消: ${ok}件${ng > 0 ? `\n❌ 失敗: ${ng}件` : ''}`);
}

// ===== 配車表からの簡易案件追加 =====
async function openQuickShipmentModal(dayStr) {
    const clients = await cachedApiGet('/clients');
    document.getElementById('modal-title').textContent = '📦 案件追加（配車表）';
    document.getElementById('modal-body').innerHTML = `
        <div class="form-group">
            <label>荷主</label>
            <select id="qs-client">
                <option value="">-- 選択 --</option>
                ${clients.map(c => `<option value="${c.name}">${c.name}</option>`).join('')}
            </select>
        </div>
        <div class="form-row">
            <div class="form-group"><label>荷物内容</label><input type="text" id="qs-cargo" placeholder="例: 鋼材"></div>
            <div class="form-group"><label>重量(kg)</label><input type="number" id="qs-weight" value="0"></div>
        </div>
        <div class="form-row">
            <div class="form-group"><label>積地</label><input type="text" id="qs-pickup" placeholder="例: 東京都江東区"></div>
            <div class="form-group"><label>卸地</label><input type="text" id="qs-delivery" placeholder="例: 埼玉県さいたま市"></div>
        </div>
        <div class="form-row">
            <div class="form-group"><label>集荷時間</label><input type="time" id="qs-pickup-time"></div>
            <div class="form-group"><label>配達時間</label><input type="time" id="qs-delivery-time"></div>
        </div>
        <div class="form-row">
            <div class="form-group"><label>運賃(円)</label><input type="number" id="qs-price" value="0"></div>
            <div class="form-group"><label>温度帯</label>
                <select id="qs-temp-zone">${['常温','冷蔵','冷凍','チルド'].map(t => `<option>${t}</option>`).join('')}</select>
            </div>
        </div>
        <div id="qs-feasibility" style="margin-top:12px;padding:10px;border-radius:8px;background:#f0fdf4;display:none"></div>
        <div class="form-actions" style="margin-top:16px">
            <button class="btn" onclick="closeModal()">キャンセル</button>
            <button class="btn" onclick="checkQuickShipmentFeasibility('${dayStr}')" style="background:#3b82f6;color:#fff">🔍 配車可能チェック</button>
            <button class="btn btn-primary" onclick="saveQuickShipment('${dayStr}')">追加</button>
        </div>`;
    showModal();
}

async function checkQuickShipmentFeasibility(dayStr) {
    const weight = parseInt(document.getElementById('qs-weight').value) || 0;
    const pickupTime = document.getElementById('qs-pickup-time').value || '08:00';
    const deliveryTime = document.getElementById('qs-delivery-time').value || (minutesToTime(Math.min(timeToMinutes(pickupTime) + 240, 22 * 60)));
    const pickupAddr = document.getElementById('qs-pickup').value;
    const deliveryAddr = document.getElementById('qs-delivery').value;

    const [drivers, vehicles, dispatches] = await Promise.all([
        cachedApiGet('/drivers'),
        cachedApiGet('/vehicles'),
        apiGet(`/dispatches?target_date=${dayStr}`),
    ]);

    const activeVehicles = vehicles.filter(v => v.status !== '整備中');
    const activeDrivers = drivers.filter(d => d.status !== '非番');
    const panel = document.getElementById('qs-feasibility');
    panel.style.display = 'block';

    const tempZone = document.getElementById('qs-temp-zone').value;

    // 現状で配車可能か判定
    const result = findAvailableSlot(activeVehicles, activeDrivers, dispatches, weight, pickupTime, deliveryTime, pickupAddr, deliveryAddr, tempZone);

    if (result.available) {
        panel.style.background = '#f0fdf4';
        panel.innerHTML = `<div style="color:#16a34a;font-weight:700">✅ 配車可能</div>
            <div style="font-size:0.85rem;margin-top:4px">
                🚚 ${result.vehicle.number}（${result.vehicle.vehicle_type} ${result.vehicle.capacity}t）<br>
                👤 ${result.driver.name}（${result.driver.work_start || '08:00'}〜${result.driver.work_end || '17:00'}）
            </div>`;
    } else {
        // リセット判定: 協力会社案件以外を除外して再チェック
        const partnerDispatches = dispatches.filter(d => d.is_partner_dispatch);
        const resetResult = findAvailableSlot(activeVehicles, activeDrivers, partnerDispatches, weight, pickupTime, deliveryTime, pickupAddr, deliveryAddr, tempZone);

        if (resetResult.available) {
            // リセットで影響を受ける配車数を算出
            const nonPartnerCount = dispatches.filter(d => !d.is_partner_dispatch).length;
            panel.style.background = '#fefce8';
            panel.innerHTML = `<div style="color:#ca8a04;font-weight:700">⚠️ 現状では配車不可</div>
                <div style="font-size:0.85rem;margin-top:4px;color:#854d0e">
                    理由: ${result.reason}<br><br>
                    💡 <strong>協力会社案件を除く配車（${nonPartnerCount}件）をリセットすれば配車可能</strong><br>
                    🚚 ${resetResult.vehicle.number}（${resetResult.vehicle.vehicle_type} ${resetResult.vehicle.capacity}t）<br>
                    👤 ${resetResult.driver.name}
                </div>`;
        } else {
            panel.style.background = '#fef2f2';
            panel.innerHTML = `<div style="color:#dc2626;font-weight:700">❌ 配車不可</div>
                <div style="font-size:0.85rem;margin-top:4px;color:#991b1b">
                    ${result.reason}<br>
                    リセットしても配車可能な車両・ドライバーがありません。<br>
                    協力会社への依頼を検討してください。
                </div>`;
        }
    }
}

function findAvailableSlot(vehicles, drivers, existingDispatches, weight, startTime, endTime, pickupAddr, deliveryAddr, tempZone) {
    // 車両ごとの既存スロット
    const vehicleSlots = {};
    vehicles.forEach(v => { vehicleSlots[v.id] = []; });
    existingDispatches.forEach(d => {
        if (d.vehicle_id && vehicleSlots[d.vehicle_id]) {
            vehicleSlots[d.vehicle_id].push({ start: d.start_time, end: d.end_time });
        }
    });

    // ドライバーごとの既存スロット
    const driverSlots = {};
    drivers.forEach(d => { driverSlots[d.id] = []; });
    existingDispatches.forEach(d => {
        if (d.driver_id && driverSlots[d.driver_id]) {
            driverSlots[d.driver_id].push({ start: d.start_time, end: d.end_time, vehicleId: d.vehicle_id });
        }
    });

    // 車両⇔ドライバーマッピング
    const vehicleDriverMap = {};
    const driverVehicleMap = {};
    existingDispatches.forEach(d => {
        if (d.vehicle_id && d.driver_id) {
            if (!vehicleDriverMap[d.vehicle_id]) vehicleDriverMap[d.vehicle_id] = d.driver_id;
            if (!driverVehicleMap[d.driver_id]) driverVehicleMap[d.driver_id] = d.vehicle_id;
        }
    });

    function hasTimeConflict(slots, s, e) { return slots.some(sl => s < sl.end && e > sl.start); }

    let noCapacity = 0, noTime = 0, noDriver = 0, noTempZone = 0;

    for (const v of vehicles) {
        // 温度帯チェック
        const sTz = tempZone || '常温';
        const vTz = v.temperature_zone || '常温';
        if (sTz !== '常温') {
            const ok = vTz === sTz || vTz === '冷蔵冷凍兼用' || (sTz === 'チルド' && (vTz === '冷蔵' || vTz === '冷凍'));
            if (!ok) { noTempZone++; continue; }
        }
        const capacityKg = (v.capacity || 0) * 1000;
        if (capacityKg > 0 && weight > capacityKg) { noCapacity++; continue; }
        if (hasTimeConflict(vehicleSlots[v.id] || [], startTime, endTime)) { noTime++; continue; }

        // ドライバー探索
        const existingDriverId = vehicleDriverMap[v.id];
        let bestDriver = null;

        if (existingDriverId) {
            const d = drivers.find(dr => dr.id === existingDriverId);
            if (d) {
                const ws = d.work_start || '08:00', we = d.work_end || '17:00';
                if (startTime >= ws && endTime <= we && !hasTimeConflict(driverSlots[d.id] || [], startTime, endTime)) {
                    bestDriver = d;
                }
            }
        }
        if (!bestDriver) {
            for (const d of drivers) {
                const ws = d.work_start || '08:00', we = d.work_end || '17:00';
                if (startTime < ws || endTime > we) continue;
                if (hasTimeConflict(driverSlots[d.id] || [], startTime, endTime)) continue;
                if (driverVehicleMap[d.id] && driverVehicleMap[d.id] !== v.id) continue;
                bestDriver = d;
                break;
            }
        }
        if (!bestDriver) { noDriver++; continue; }

        return { available: true, vehicle: v, driver: bestDriver };
    }

    // 理由を構築
    const reasons = [];
    if (noTempZone > 0) reasons.push(`温度帯不適合: ${noTempZone}台`);
    if (noCapacity > 0) reasons.push(`積載量不足: ${noCapacity}台`);
    if (noTime > 0) reasons.push(`時間帯重複: ${noTime}台`);
    if (noDriver > 0) reasons.push(`対応可能ドライバーなし: ${noDriver}台`);
    return { available: false, reason: reasons.join('、') || '利用可能な車両がありません' };
}

async function saveQuickShipment(dayStr) {
    const client = document.getElementById('qs-client').value;
    const cargo = document.getElementById('qs-cargo').value;
    const weight = parseInt(document.getElementById('qs-weight').value) || 0;
    const pickup = document.getElementById('qs-pickup').value;
    const delivery = document.getElementById('qs-delivery').value;
    const pickupTime = document.getElementById('qs-pickup-time').value;
    const deliveryTime = document.getElementById('qs-delivery-time').value;
    const price = parseInt(document.getElementById('qs-price').value) || 0;
    const tempZone = document.getElementById('qs-temp-zone').value;

    if (!client) return alert('荷主を選択してください');

    try {
        await apiPost('/shipments', {
            client_name: client,
            cargo_description: cargo,
            weight: weight,
            pickup_address: pickup,
            delivery_address: delivery,
            pickup_date: dayStr,
            delivery_date: dayStr,
            pickup_time: pickupTime,
            delivery_time: deliveryTime,
            price: price,
            temperature_zone: tempZone,
            status: '未配車',
            frequency_type: '単発',
        });
        closeModal();
        invalidateCache('/shipments');
        loadDispatchCalendar();
    } catch (e) {
        alert('案件追加に失敗しました: ' + e.message);
    }
}

function showAutoDispatchLoading(show, msg = '自動配車を計算中...') {
    let overlay = document.getElementById('auto-dispatch-loading');
    if (show) {
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'auto-dispatch-loading';
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999';
            overlay.innerHTML = `<div style="background:#fff;padding:32px 48px;border-radius:12px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.3)">
                <div style="width:48px;height:48px;border:4px solid #e5e7eb;border-top:4px solid #ea580c;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 16px"></div>
                <div id="auto-dispatch-msg" style="font-size:1rem;font-weight:600;color:#1e293b">${msg}</div>
            </div>`;
            document.body.appendChild(overlay);
        } else {
            overlay.style.display = 'flex';
            const m = document.getElementById('auto-dispatch-msg');
            if (m) m.textContent = msg;
        }
    } else if (overlay) {
        overlay.remove();
    }
}

async function autoDispatch(dayStr) {
    showAutoDispatchLoading(true, 'データを読み込み中...');
    const [shipments, drivers, vehicles, existingDispatches] = await Promise.all([
        cachedApiGet('/shipments'),
        cachedApiGet('/drivers'),
        cachedApiGet('/vehicles'),
        apiGet(`/dispatches?target_date=${dayStr}`),
    ]);

    // DB保存済みの座標をプリロード（Nominatim呼び出し不要に）
    preloadGeoFromShipments(shipments);

    // 未配車案件（その日に該当するもの）
    const unassigned = shipments.filter(s => s.status === '未配車' && isShipmentForDate(s, dayStr));
    if (unassigned.length === 0) { showAutoDispatchLoading(false); return alert('未配車の案件がありません'); }

    // 稼働中の車両（整備中除外）
    const activeVehicles = vehicles.filter(v => v.status !== '整備中');
    // 非番でないドライバー
    const activeDrivers = drivers.filter(d => d.status !== '非番');

    // 車両ごとの既存配車スロットを構築
    const vehicleSlots = {};
    activeVehicles.forEach(v => { vehicleSlots[v.id] = []; });
    existingDispatches.forEach(d => {
        if (d.vehicle_id && vehicleSlots[d.vehicle_id]) {
            vehicleSlots[d.vehicle_id].push({ start: d.start_time, end: d.end_time, weight: d.shipment_weight || 0 });
        }
    });

    // ドライバーごとの既存配車
    const driverSlots = {};
    activeDrivers.forEach(d => { driverSlots[d.id] = []; });
    existingDispatches.forEach(d => {
        if (d.driver_id && driverSlots[d.driver_id]) {
            driverSlots[d.driver_id].push({ start: d.start_time, end: d.end_time, vehicleId: d.vehicle_id });
        }
    });

    // 車両⇔ドライバーマッピング（既存配車から推定、原則固定）
    const vehicleDriverMap = {};
    const driverVehicleMap = {};
    existingDispatches.forEach(d => {
        if (d.vehicle_id && d.driver_id) {
            if (!vehicleDriverMap[d.vehicle_id]) vehicleDriverMap[d.vehicle_id] = d.driver_id;
            if (!driverVehicleMap[d.driver_id]) driverVehicleMap[d.driver_id] = d.vehicle_id;
        }
    });

    // 時間重複チェック
    function hasTimeConflict(slots, start, end) {
        return slots.some(s => start < s.end && end > s.start);
    }

    // 免許で運転可能かチェック（車両総重量ベース: capacity(積載t)から推定）
    function canDrive(licenseType, vehicleCapacity) {
        const cap = vehicleCapacity || 0;
        const license = (licenseType || '普通').trim();
        if (license.includes('大型')) return true;
        if (license.includes('中型') && !license.includes('準')) return cap <= 6.5;
        if (license.includes('準中型')) return cap <= 4.5;
        // 普通免許
        return cap <= 2;
    }

    // 地理的近さスコア（住所の先頭一致で判定）
    function geoScore(addr1, addr2) {
        if (!addr1 || !addr2) return 0;
        const a = addr1.replace(/\s/g, ''), b = addr2.replace(/\s/g, '');
        let score = 0;
        for (let i = 0; i < Math.min(a.length, b.length, 10); i++) {
            if (a[i] === b[i]) score++; else break;
        }
        return score;
    }

    // ジオコーディングを事前にバッチ取得（Nominatimは1req/sec制限）
    const allAddresses = new Set();
    unassigned.forEach(s => { if (s.pickup_address) allAddresses.add(s.pickup_address); if (s.delivery_address) allAddresses.add(s.delivery_address); });
    existingDispatches.forEach(d => { if (d.delivery_address) allAddresses.add(d.delivery_address); if (d.pickup_address) allAddresses.add(d.pickup_address); });
    // キャッシュにないものだけ順次取得（レート制限対応）
    const uncached = [...allAddresses].filter(a => !_geocodeCache[a]);
    if (uncached.length > 0) {
        showAutoDispatchLoading(true, `座標を取得中... (0/${uncached.length})`);
        let i = 0;
        for (const addr of uncached) {
            i++;
            showAutoDispatchLoading(true, `座標を取得中... (${i}/${uncached.length})`);
            await geocodeAddress(addr);
            await new Promise(r => setTimeout(r, 1100)); // Nominatim 1req/sec
        }
    }
    showAutoDispatchLoading(true, '最適な配車を計算中...');

    // Haversineベースの移動時間チェック
    function checkTravelGap(fromDeliveryAddr, toPickupAddr, gapMinutes) {
        const from = _geocodeCache[fromDeliveryAddr];
        const to = _geocodeCache[toPickupAddr];
        if (!from || !to) return { ok: true, minutes: 0, distKm: 0 }; // 不明時はOK扱い
        const distKm = haversineDistance(from.lat, from.lng, to.lat, to.lng);
        const minutes = estimateTravelMinutes(distKm);
        return { ok: minutes <= gapMinutes, minutes, distKm: Math.round(distKm * 10) / 10 };
    }

    // 積み合わせ判定：同方面かつ時間重複 → 同じ車両に積める
    function canConsolidate(shipmentA, shipmentB) {
        if (!shipmentA.pickup_address || !shipmentB.pickup_address) return false;
        if (!shipmentA.delivery_address || !shipmentB.delivery_address) return false;
        // 積み地が近い AND 降ろし地が近い → 同方面
        const pickupScore = geoScore(shipmentA.pickup_address, shipmentB.pickup_address);
        const deliveryScore = geoScore(shipmentA.delivery_address, shipmentB.delivery_address);
        return pickupScore >= 3 && deliveryScore >= 3;
    }

    // 車両ごとの最後の降ろし地を取得
    const vehicleLastDelivery = {};
    existingDispatches.forEach(d => {
        if (d.vehicle_id && d.delivery_address) {
            const existing = vehicleLastDelivery[d.vehicle_id];
            if (!existing || d.end_time > existing.end_time) {
                vehicleLastDelivery[d.vehicle_id] = { address: d.delivery_address, end_time: d.end_time };
            }
        }
    });

    // 車両ごとの配車済み案件リスト（積み合わせ判定用）
    const vehicleShipments = {};
    existingDispatches.forEach(d => {
        if (d.vehicle_id && d.shipment_id) {
            if (!vehicleShipments[d.vehicle_id]) vehicleShipments[d.vehicle_id] = [];
            const s = shipments.find(x => x.id === d.shipment_id);
            if (s) vehicleShipments[d.vehicle_id].push(s);
        }
    });

    const assignments = [];
    const failed = [];

    // 案件を時間順にソート（指定時間あり優先）
    unassigned.sort((a, b) => {
        const aTime = a.pickup_time || '99:99';
        const bTime = b.pickup_time || '99:99';
        return aTime.localeCompare(bTime);
    });

    const noTimeShipments = [];
    for (const s of unassigned) {
        // 時間指定なしの案件はスキップ
        if (!s.pickup_time || !s.delivery_time) {
            noTimeShipments.push(s);
            continue;
        }
        const startTime = s.pickup_time;
        const endTime = s.delivery_time;
        const weight = s.weight || 0;
        let assigned = false;

        // 各車両をスコアリングして最適順に試す
        const candidates = [];
        for (const v of activeVehicles) {
            // 温度帯チェック: 案件の温度帯に車両が対応してるか
            const shipTempZone = s.temperature_zone || '常温';
            const vehTempZone = v.temperature_zone || '常温';
            if (shipTempZone !== '常温') {
                // 冷蔵案件 → 冷蔵/冷蔵冷凍兼用車両のみ
                // 冷凍案件 → 冷凍/冷蔵冷凍兼用車両のみ
                // チルド案件 → 冷蔵/冷凍/冷蔵冷凍兼用車両
                const canHandle = vehTempZone === shipTempZone
                    || vehTempZone === '冷蔵冷凍兼用'
                    || (shipTempZone === 'チルド' && (vehTempZone === '冷蔵' || vehTempZone === '冷凍'));
                if (!canHandle) continue;
            }
            // 積載量チェック（kg → t変換）
            const capacityKg = (v.capacity || 0) * 1000;
            const currentLoad = (vehicleSlots[v.id] || []).reduce((sum, sl) => sum + (sl.weight || 0), 0);

            // 積み合わせ可能か？（時間重複してるけど同方面なら同じ車に積める）
            const existingShipmentsOnVehicle = vehicleShipments[v.id] || [];
            const isConsolidatable = existingShipmentsOnVehicle.some(es => canConsolidate(es, s));

            if (isConsolidatable && capacityKg > 0 && (currentLoad + weight) <= capacityKg) {
                // 積み合わせ：時間重複OK、重量合計が積載量以内
            } else {
                // 通常：積載量・時間重複チェック
                if (capacityKg > 0 && weight > capacityKg) continue;
                if (hasTimeConflict(vehicleSlots[v.id], startTime, endTime)) continue;
            }

            // スコア計算
            let score = 0;
            const lastDel = vehicleLastDelivery[v.id];
            if (lastDel && s.pickup_address) {
                score = geoScore(lastDel.address, s.pickup_address) * 10;
                // 移動時間が現実的かチェック
                if (lastDel.end_time <= startTime) {
                    const gapMin = timeToMinutes(startTime) - timeToMinutes(lastDel.end_time);
                    const travel = checkTravelGap(lastDel.address, s.pickup_address, gapMin);
                    if (travel.ok) {
                        score += 15; // 移動可能 → 高スコア
                    } else {
                        score -= 20; // 移動不可能 → 大幅減点（ただし排除はしない）
                    }
                }
            }
            // 積み合わせ可能ならボーナス
            if (isConsolidatable) score += 25;
            // 既にこの車両にドライバーが乗ってればボーナス
            if (vehicleDriverMap[v.id]) score += 3;
            candidates.push({ vehicle: v, score, consolidated: isConsolidatable });
        }

        // スコア高い順にソート
        candidates.sort((a, b) => b.score - a.score);

        for (const { vehicle: v, consolidated } of candidates) {
            // ドライバーを探す（この車両に既に配車されてるドライバー優先）
            let bestDriver = null;
            const existingDriverId = vehicleDriverMap[v.id];

            if (existingDriverId) {
                // 同じ車両には同じドライバーを強制固定（勤務時間チェック不要）
                const d = activeDrivers.find(dr => dr.id === existingDriverId);
                if (d && canDrive(d.license_type, v.capacity)) {
                    bestDriver = d;
                }
            }

            // 既存ドライバーが無理なら空いてるドライバーを探す（車両固定＋免許チェック）
            if (!bestDriver) {
                for (const d of activeDrivers) {
                    if (!canDrive(d.license_type, v.capacity)) continue;
                    const ws = d.work_start || '08:00';
                    const we = d.work_end || '17:00';
                    if (startTime < ws || endTime > we) continue;
                    // 混載でない場合のみ時間重複チェック
                    if (!consolidated && hasTimeConflict(driverSlots[d.id] || [], startTime, endTime)) continue;
                    // ドライバーが既に別車両に固定されている場合はスキップ
                    if (driverVehicleMap[d.id] && driverVehicleMap[d.id] !== v.id) continue;
                    const driverVehicles = new Set((driverSlots[d.id] || []).map(sl => sl.vehicleId));
                    if (driverVehicles.size > 0 && !driverVehicles.has(v.id)) continue;
                    bestDriver = d;
                    break;
                }
            }

            if (!bestDriver) continue;

            assignments.push({
                shipment: s, vehicle: v, driver: bestDriver,
                startTime, endTime, consolidated: !!consolidated,
            });

            // スロットを更新
            vehicleSlots[v.id].push({ start: startTime, end: endTime, weight });
            // 積み合わせ用の案件リストも更新
            if (!vehicleShipments[v.id]) vehicleShipments[v.id] = [];
            vehicleShipments[v.id].push(s);
            if (!driverSlots[bestDriver.id]) driverSlots[bestDriver.id] = [];
            driverSlots[bestDriver.id].push({ start: startTime, end: endTime, vehicleId: v.id });
            if (!vehicleDriverMap[v.id]) vehicleDriverMap[v.id] = bestDriver.id;
            // 降ろし地マップも更新
            if (s.delivery_address) {
                vehicleLastDelivery[v.id] = { address: s.delivery_address, end_time: endTime };
            }
            assigned = true;
            break;
        }
        if (!assigned) failed.push(s);
    }

    // 時間指定なし案件をfailedに追加
    noTimeShipments.forEach(s => failed.push(s));

    if (assignments.length === 0) return alert(`自動配車できる案件がありませんでした。\n${noTimeShipments.length > 0 ? `（時間指定なし: ${noTimeShipments.length}件は自動配車対象外）\n` : ''}（車両・ドライバーの空きや勤務時間が合わない可能性があります）`);

    // プレビュー表示
    let previewHtml = `<div style="max-height:400px;overflow-y:auto">`;
    previewHtml += `<div style="margin-bottom:8px;font-size:0.85rem;color:#059669;font-weight:600">✅ 配車可能: ${assignments.length}件</div>`;
    previewHtml += `<table style="width:100%;font-size:0.8rem;border-collapse:collapse">
        <thead><tr style="background:#f1f5f9"><th style="padding:4px 6px;text-align:left">案件</th><th style="padding:4px 6px">ルート</th><th style="padding:4px 6px">時間</th><th style="padding:4px 6px">車両</th><th style="padding:4px 6px">ドライバー</th></tr></thead><tbody>`;
    assignments.forEach(a => {
        const pickup = a.shipment.pickup_address ? a.shipment.pickup_address.split(/[都道府県市区町村郡]/).slice(-1)[0]?.substring(0,6) || a.shipment.pickup_address.substring(0,8) : '-';
        const delivery = a.shipment.delivery_address ? a.shipment.delivery_address.split(/[都道府県市区町村郡]/).slice(-1)[0]?.substring(0,6) || a.shipment.delivery_address.substring(0,8) : '-';
        previewHtml += `<tr style="border-bottom:1px solid #e5e7eb">
            <td style="padding:4px 6px">${a.consolidated ? '📦 ' : ''}${a.shipment.client_name} ${a.shipment.cargo_description || ''}${a.consolidated ? ' <span style="color:#ea580c;font-size:0.7rem">(積合)</span>' : ''}</td>
            <td style="padding:4px 6px;text-align:center;font-size:0.72rem">${pickup}→${delivery}</td>
            <td style="padding:4px 6px;text-align:center">${a.startTime}〜${a.endTime}</td>
            <td style="padding:4px 6px;text-align:center">${a.vehicle.number}</td>
            <td style="padding:4px 6px;text-align:center">${a.driver.name}</td>
        </tr>`;
    });
    previewHtml += `</tbody></table>`;
    if (failed.length > 0) {
        previewHtml += `<div style="margin-top:12px;font-size:0.85rem;color:#f59e0b;font-weight:600">📋 未割当: ${failed.length}件（協力会社等で対応）</div>`;
        previewHtml += `<div style="font-size:0.78rem;color:#64748b">${failed.map(s => s.client_name + ' ' + (s.cargo_description || '')).join('、')}</div>`;
    }
    previewHtml += `</div>`;

    showAutoDispatchLoading(false);
    document.getElementById('modal-title').textContent = '⚡ 自動配車プレビュー';
    document.getElementById('modal-body').innerHTML = previewHtml + `
        <div class="form-actions" style="margin-top:16px">
            <button class="btn" onclick="closeModal()">キャンセル</button>
            <button class="btn btn-primary" id="btn-auto-dispatch-confirm">この内容で配車する (${assignments.length}件)</button>
        </div>`;
    showModal();

    document.getElementById('btn-auto-dispatch-confirm').onclick = async () => {
        document.getElementById('btn-auto-dispatch-confirm').disabled = true;
        document.getElementById('btn-auto-dispatch-confirm').textContent = '配車中...';
        let ok = 0, ng = 0;
        const createdIds = [];
        for (const a of assignments) {
            try {
                const result = await apiPost('/dispatches', {
                    shipment_id: a.shipment.id,
                    vehicle_id: a.vehicle.id,
                    driver_id: a.driver.id,
                    date: dayStr,
                    start_time: a.startTime,
                    end_time: a.endTime,
                });
                if (result && result.id) createdIds.push(result.id);
                ok++;
            } catch (e) { ng++; }
        }
        _lastAutoDispatchIds = createdIds;
        _lastAutoDispatchDay = dayStr;
        closeModal();
        invalidateCache('/shipments');
        invalidateCache('/dispatches');
        invalidateCache('_lastDispatches');
        loadDispatchCalendar();
        alert(`自動配車完了！\n✅ 成功: ${ok}件${ng > 0 ? `\n❌ 失敗: ${ng}件` : ''}\n\n※「↩ 元に戻す」ボタンで取り消せます`);
    };
}

async function createTransportRequestFromShipmentAndShow(shipmentId, partnerId) {
    const shipments = await apiGet('/shipments');
    const s = shipments.find(x => x.id === shipmentId);
    if (!s) return;
    const result = await apiPost('/transport-requests', {
        partner_id: partnerId,
        shipment_id: shipmentId,
        request_date: new Date().toISOString().split('T')[0],
        pickup_date: s.pickup_date,
        pickup_time: s.pickup_time || '',
        delivery_date: s.delivery_date,
        delivery_time: s.delivery_time || '',
        pickup_address: s.pickup_address,
        delivery_address: s.delivery_address,
        cargo_description: s.cargo_description || '',
        cargo_weight: s.weight || 0,
        freight_amount: s.price || 0,
        status: '下書き',
    });
    if (result.id) {
        // 輸送依頼書を即時ポップアップ表示
        setTimeout(() => printTransportRequest(result.id), 500);
    }
}

// ===== ガントバーリサイズ =====
function startGanttResize(e, dispatchId, edge, startTime, endTime) {
    if (isMobile()) return;
    const timeline = e.target.closest('.gantt-timeline');
    resizeState = {
        id: dispatchId, edge: edge, startX: e.clientX,
        timelineWidth: timeline.offsetWidth,
        origStart: startTime, origEnd: endTime,
        newStart: startTime, newEnd: endTime,
    };
    document.addEventListener('mousemove', onGanttResizeMove);
    document.addEventListener('mouseup', onGanttResizeEnd);
    document.body.style.cursor = 'ew-resize';
}

function onGanttResizeMove(e) {
    if (!resizeState) return;
    const dx = e.clientX - resizeState.startX;
    const totalMin = HOUR_COUNT * 60;
    const pxPerMin = resizeState.timelineWidth / totalMin;
    const step = 15;
    const deltaMins = Math.round(dx / pxPerMin / step) * step;

    if (resizeState.edge === 'right') {
        const newEnd = timeToMinutes(resizeState.origEnd) + deltaMins;
        const minEnd = timeToMinutes(resizeState.origStart) + step;
        resizeState.newEnd = minutesToTime(Math.max(newEnd, minEnd));
        resizeState.newStart = resizeState.origStart;
    } else {
        const newStart = timeToMinutes(resizeState.origStart) + deltaMins;
        const maxStart = timeToMinutes(resizeState.origEnd) - step;
        resizeState.newStart = minutesToTime(Math.min(Math.max(newStart, HOUR_START * 60), maxStart));
        resizeState.newEnd = resizeState.origEnd;
    }

    const bar = document.querySelector(`.gantt-bar[data-id="${resizeState.id}"]`);
    if (bar) {
        const startMin = timeToMinutes(resizeState.newStart);
        const endMin = timeToMinutes(resizeState.newEnd);
        const left = ((startMin - HOUR_START * 60) / totalMin) * 100;
        const width = ((endMin - startMin) / totalMin) * 100;
        bar.style.left = Math.max(left, 0) + '%';
        bar.style.width = Math.min(width, 100 - left) + '%';
        const startEl = bar.querySelector('.gantt-bar-start');
        const endEl = bar.querySelector('.gantt-bar-end');
        if (startEl) startEl.textContent = resizeState.newStart;
        if (endEl) endEl.textContent = resizeState.newEnd;
    }
}

async function onGanttResizeEnd() {
    document.removeEventListener('mousemove', onGanttResizeMove);
    document.removeEventListener('mouseup', onGanttResizeEnd);
    document.body.style.cursor = '';
    if (!resizeState) return;
    const { id, newStart, newEnd, origStart, origEnd } = resizeState;
    resizeState = null;
    if (newStart === origStart && newEnd === origEnd) return;
    // Requirement 4: 案件に元々時間が設定されている場合のみ警告
    const allDispatches = await apiGet('/dispatches');
    const thisDispatch = allDispatches.find(x => x.id === id);
    if (thisDispatch && thisDispatch.shipment_id) {
        const allShipments = await apiGet('/shipments');
        const shipment = allShipments.find(s => s.id === thisDispatch.shipment_id);
        if (shipment && shipment.pickup_time && shipment.delivery_time) {
            if (!await showConfirm(`この案件には元々の指定時間（${shipment.pickup_time}〜${shipment.delivery_time}）がありますが変更しますか？`)) {
                loadDispatchCalendar();
                return;
            }
        }
    }
    try {
        const resp = await fetch(API + `/dispatches/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ start_time: newStart, end_time: newEnd })
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            alert('時間の保存に失敗しました: ' + (err.detail || resp.statusText));
        }
    } catch (e) {
        alert('時間の保存に失敗しました: ' + e.message);
    }
    loadDispatchCalendar();
}

function getDispatchColor(status) {
    return { '予定': 'ev-blue', '運行中': 'ev-green', 'キャンセル': 'ev-red' }[status] || 'ev-blue';
}

// 重量に応じた色を返す（重いほど濃い青）
function getWeightColor(weight, vehicleCapacity) {
    if (!weight || weight <= 0 || !vehicleCapacity || vehicleCapacity <= 0) return { bg: '#eff6ff', border: '#93c5fd', text: '#1e40af' }; // 未設定: 極薄青
    // 積載率(%)で5段階
    const pct = (weight / (vehicleCapacity * 1000)) * 100;
    const level = pct > 100 ? 4 : pct >= 80 ? 4 : pct >= 60 ? 3 : pct >= 40 ? 2 : pct >= 20 ? 1 : 0;
    const colors = [
        { bg: '#eff6ff', border: '#93c5fd', text: '#1e40af' },  // ~20%: 極薄青
        { bg: '#dbeafe', border: '#60a5fa', text: '#1e40af' },  // ~40%: 薄青
        { bg: '#bfdbfe', border: '#3b82f6', text: '#1e3a8a' },  // ~60%: 中青
        { bg: '#93c5fd', border: '#2563eb', text: '#1e3a8a' },  // ~80%: 濃青
        { bg: '#60a5fa', border: '#1d4ed8', text: '#fff' },     // 80%~: 最濃
    ];
    return colors[level];
}

const DRIVER_COLORS = [
    { bg: '#ede9fe', border: '#7c3aed', text: '#5b21b6' },
    { bg: '#fce7f3', border: '#db2777', text: '#9d174d' },
    { bg: '#e0f2fe', border: '#0284c7', text: '#075985' },
    { bg: '#fef3c7', border: '#d97706', text: '#92400e' },
    { bg: '#d1fae5', border: '#059669', text: '#065f46' },
    { bg: '#fee2e2', border: '#dc2626', text: '#991b1b' },
    { bg: '#e0e7ff', border: '#4f46e5', text: '#3730a3' },
    { bg: '#ffedd5', border: '#ea580c', text: '#9a3412' },
    { bg: '#f0fdf4', border: '#16a34a', text: '#166534' },
    { bg: '#fdf4ff', border: '#a855f7', text: '#7e22ce' },
];
const driverColorMap = {};
function getDriverColor(driverId) {
    if (!driverId) return null;
    if (!driverColorMap[driverId]) {
        const idx = Object.keys(driverColorMap).length % DRIVER_COLORS.length;
        driverColorMap[driverId] = DRIVER_COLORS[idx];
    }
    return driverColorMap[driverId];
}

function changeDays(dir) {
    calendarDate.setDate(calendarDate.getDate() + dir);
    loadDispatchCalendar();
}

function changeHourRange() {
    const newStart = parseInt(document.getElementById('cal-hour-start').value);
    let newEnd = parseInt(document.getElementById('cal-hour-end').value);
    // 翌日またぎ: 開始が終了以上の場合、24を足す（例: 5〜4 → 5〜28）
    if (newEnd <= newStart) {
        newEnd += 24;
    }
    HOUR_START = newStart;
    HOUR_END = newEnd;
    HOUR_COUNT = HOUR_END - HOUR_START;
    loadDispatchCalendar();
}

function isToday(d) {
    const t = new Date();
    return d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
}

function fmt(d) {
    if (!d.getFullYear) return d;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// 案件がその日に該当するか判定（単発=集荷日一致、毎日=範囲内、曜日指定=曜日+範囲内）
function isShipmentForDate(s, dateStr) {
    const d = new Date(dateStr);
    const pickup = s.pickup_date;
    const delivery = s.delivery_date;
    // 単発: 集荷日〜配達日の範囲内
    if (s.frequency_type === '単発' || !s.frequency_type) {
        return dateStr >= pickup && dateStr <= delivery;
    }
    // 毎日: 集荷日以降
    if (s.frequency_type === '毎日') {
        return dateStr >= pickup;
    }
    // 曜日指定: 集荷日以降 かつ 該当曜日
    if (s.frequency_type === '曜日指定') {
        if (dateStr < pickup) return false;
        const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
        const dayName = dayNames[d.getDay()];
        const specifiedDays = (s.frequency_days || '').split(',');
        return specifiedDays.includes(dayName);
    }
    return false;
}

function timeToMinutes(t) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
}

function minutesToTime(mins) {
    mins = Math.max(0, Math.min(mins, 24 * 60));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    // 24:00は23:59として保存（DB String(5)制約）
    if (h >= 24) return '23:59';
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function calcDuration(start, end) {
    return timeToMinutes(end) - timeToMinutes(start);
}

// ===== 配車作成モーダル =====
async function openQuickDispatchModal(date, startTime, endTime, preselectedVehicleId, preselectedShipmentId, preselectedPartnerId) {
    if (justDragged) { justDragged = false; return; }
    const [vehicles, drivers, shipments, clients, partners, dayDispatches] = await Promise.all([
        cachedApiGet('/vehicles'), cachedApiGet('/drivers'), cachedApiGet('/shipments'), cachedApiGet('/clients'), cachedApiGet('/partners'),
        apiGet(`/dispatches?target_date=${date}`)
    ]);
    const availableVehicles = vehicles.filter(v => v.status !== '整備中');
    // 同日に別車両で配車されているドライバーに⚠マーク
    const qdBusyMap = {};
    dayDispatches.forEach(x => {
        if (x.driver_id) {
            if (!qdBusyMap[x.driver_id]) qdBusyMap[x.driver_id] = [];
            qdBusyMap[x.driver_id].push(x.vehicle_number || `車両${x.vehicle_id}`);
        }
    });
    const driverLabel = (d, warn) => `${warn}${d.name} (${d.license_type}) ${d.work_start || '08:00'}〜${d.work_end || '17:00'}`;
    // 出発時刻時点で出勤中のドライバーのみ表示
    const onDutyDrivers = drivers.filter(d => {
        if (d.status === '非番') return false;
        const ws = d.work_start || '08:00';
        const we = d.work_end || '17:00';
        return startTime >= ws && startTime < we;
    });
    const allNonOffDrivers = drivers.filter(d => d.status !== '非番');
    const unassigned = shipments.filter(s => s.status === '未配車');

    document.getElementById('modal-title').textContent = '配車作成';
    document.getElementById('modal-body').innerHTML = `
        <div class="form-row">
            <div class="form-group">
                <label>開始日</label>
                <input type="date" id="f-qd-date" value="${date}">
            </div>
            <div class="form-group">
                <label>終了日（日またぎの場合）</label>
                <input type="date" id="f-qd-end-date" value="" placeholder="同日なら空欄">
            </div>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>開始時刻</label>
                <input type="time" id="f-qd-start" value="${startTime}" onchange="filterDriversByTime()">
            </div>
            <div class="form-group">
                <label>終了時刻</label>
                <input type="time" id="f-qd-end" value="${endTime}">
            </div>
        </div>
        <div class="form-group">
            <label>車両 ${preselectedPartnerId ? '<span style="font-size:0.75rem;color:#7c3aed">（協力会社配車のため不要）</span>' : ''}</label>
            <select id="f-qd-vehicle" ${preselectedPartnerId ? 'disabled' : ''}>
                <option value="">-- 選択 --</option>
                ${availableVehicles.map(v => `<option value="${v.id}" ${preselectedVehicleId === v.id ? 'selected' : ''}>${v.number} (${v.type} ${v.capacity}t)</option>`).join('')}
            </select>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>ドライバー（自社）</label>
                <select id="f-qd-driver" onchange="if(this.value)document.getElementById('f-qd-partner').value=''">
                    <option value="">-- 選択 --</option>
                    <optgroup label="出勤中（${startTime}時点）" id="f-qd-driver-onduty">
                        ${onDutyDrivers.map(d => { const w = qdBusyMap[d.id] ? `⚠[${qdBusyMap[d.id].join(',')}] ` : ''; return `<option value="${d.id}">${w}${d.name} (${d.license_type}) ${d.work_start}〜${d.work_end}</option>`; }).join('')}
                    </optgroup>
                    <optgroup label="その他（出勤時間外）">
                        ${allNonOffDrivers.filter(d => !onDutyDrivers.find(od => od.id === d.id)).map(d => { const w = qdBusyMap[d.id] ? `⚠[${qdBusyMap[d.id].join(',')}] ` : ''; return `<option value="${d.id}" style="color:#94a3b8">${w}${d.name} (${d.license_type}) ${d.work_start}〜${d.work_end} ※時間外</option>`; }).join('')}
                    </optgroup>
                </select>
            </div>
            <div class="form-group">
                <label>または 協力会社</label>
                <select id="f-qd-partner" onchange="if(this.value){document.getElementById('f-qd-driver').value='';document.getElementById('f-qd-vehicle').disabled=!!this.value}else{document.getElementById('f-qd-vehicle').disabled=false}">
                    <option value="">-- 選択 --</option>
                    ${partners.map(p => `<option value="${p.id}" ${preselectedPartnerId == p.id ? 'selected' : ''}>${p.name}</option>`).join('')}
                </select>
            </div>
        </div>
        <div class="form-group">
            <label>案件（既存から選択）</label>
            <select id="f-qd-shipment" onchange="toggleManualAddress()">
                <option value="">-- 手動入力 --</option>
                ${unassigned.map(s => `<option value="${s.id}" ${preselectedShipmentId === s.id ? 'selected' : ''}>${s.client_name}: ${s.pickup_address} → ${s.delivery_address} (¥${s.price.toLocaleString()})</option>`).join('')}
            </select>
        </div>
        <div id="manual-address" ${preselectedShipmentId ? 'style="display:none"' : ''}>
            <div class="form-group">
                <label>荷主名</label>
                <select id="f-qd-client-select" onchange="document.getElementById('f-qd-client').value=this.value">
                    <option value="">-- 選択してください --</option>
                    ${clients.map(c => `<option value="${c.name}">${c.name}</option>`).join('')}
                </select>
                <input type="hidden" id="f-qd-client" value="">
            </div>
            <div class="form-group">
                <label>積地</label>
                <input type="text" id="f-qd-pickup" placeholder="東京都大田区...">
            </div>
            <div class="form-group">
                <label>卸地</label>
                <input type="text" id="f-qd-delivery" placeholder="神奈川県横浜市...">
            </div>
        </div>
        <div class="form-group">
            <label>備考</label>
            <textarea id="f-qd-notes"></textarea>
        </div>
        <div class="form-actions">
            <button class="btn" onclick="closeModal()">キャンセル</button>
            <button class="btn btn-primary" onclick="saveQuickDispatch()">配車する</button>
        </div>`;
    showModal();
}

async function filterDriversByTime() {
    const startTime = document.getElementById('f-qd-start').value;
    if (!startTime) return;
    const drivers = await cachedApiGet('/drivers');
    const sel = document.getElementById('f-qd-driver');
    const currentVal = sel.value;
    const onDuty = drivers.filter(d => d.status !== '非番' && startTime >= (d.work_start || '08:00') && startTime < (d.work_end || '17:00'));
    const offDuty = drivers.filter(d => d.status !== '非番' && !onDuty.find(od => od.id === d.id));
    sel.innerHTML = `<option value="">-- 選択 --</option>
        <optgroup label="出勤中（${startTime}時点）">
            ${onDuty.map(d => `<option value="${d.id}" ${d.id == currentVal ? 'selected' : ''}>${d.name} (${d.license_type}) ${d.work_start}〜${d.work_end}</option>`).join('')}
        </optgroup>
        <optgroup label="その他（出勤時間外）">
            ${offDuty.map(d => `<option value="${d.id}" ${d.id == currentVal ? 'selected' : ''} style="color:#94a3b8">${d.name} (${d.license_type}) ${d.work_start}〜${d.work_end} ※時間外</option>`).join('')}
        </optgroup>`;
}

function toggleManualAddress() {
    const shipmentId = document.getElementById('f-qd-shipment').value;
    document.getElementById('manual-address').style.display = shipmentId ? 'none' : 'block';
}

async function saveQuickDispatch() {
    const vehicleId = parseInt(document.getElementById('f-qd-vehicle').value) || 0;
    const driverId = parseInt(document.getElementById('f-qd-driver').value) || 0;
    const partnerId = parseInt(document.getElementById('f-qd-partner').value) || 0;
    if (!partnerId && (!vehicleId || !driverId)) return alert('車両とドライバー、または協力会社を選択してください');
    if (partnerId && !vehicleId) {
        // 協力会社の場合、最初の車両をダミーで使用
        const vehicles = await apiGet('/vehicles');
        const firstVehicle = vehicles.find(v => v.status !== '整備中');
        if (!firstVehicle) return alert('利用可能な車両がありません');
        document.getElementById('f-qd-vehicle').value = firstVehicle.id;
    }
    const date = document.getElementById('f-qd-date').value;
    if (!date) return alert('日付を選択してください');

    // Requirement 1: ドライバー重複チェック
    const startTimeVal = document.getElementById('f-qd-start').value;
    const endTimeVal = document.getElementById('f-qd-end').value;
    const actualVehicleId = parseInt(document.getElementById('f-qd-vehicle').value) || vehicleId;
    if (driverId) {
        const conflict = await checkDriverConflict(driverId, date, startTimeVal, endTimeVal, actualVehicleId);
        if (conflict) {
            alert(`このドライバーは同日に別の車両（${conflict}）で配車されています。\n時間が重複しているため配車できません。`);
            return;
        }
    }

    const endDate = document.getElementById('f-qd-end-date').value;
    const shipmentId = document.getElementById('f-qd-shipment').value;
    const data = {
        vehicle_id: actualVehicleId, driver_id: driverId || null, partner_id: partnerId || null, date: date,
        start_time: document.getElementById('f-qd-start').value,
        end_time: document.getElementById('f-qd-end').value,
        notes: document.getElementById('f-qd-notes').value,
    };
    if (endDate && endDate !== date) data.end_date = endDate;

    if (shipmentId) {
        data.shipment_id = parseInt(shipmentId);
    } else {
        data.pickup_address = document.getElementById('f-qd-pickup').value;
        data.delivery_address = document.getElementById('f-qd-delivery').value;
        data.client_name = document.getElementById('f-qd-client').value;
    }

    await apiPost('/dispatches', data);
    closeModal();
    loadDispatchCalendar();
}

// ===== 配車詳細・編集 =====
function showMobileVehicleDetail(vehicleId) {
    // 既存の吹き出しを閉じる
    document.querySelectorAll('.vg-vehicle-tooltip').forEach(el => el.remove());
    const vehicles = _cache['/vehicles']?.data || [];
    const v = vehicles.find(x => x.id === vehicleId);
    if (!v) return;
    const header = event.target.closest('.vg-vehicle-header');
    if (!header) return;
    const rect = header.getBoundingClientRect();
    const tz = v.temperature_zone || '常温';
    const pg = v.has_power_gate ? '✅' : '−';
    const tip = document.createElement('div');
    tip.className = 'vg-vehicle-tooltip';
    tip.innerHTML = `
        <div style="font-size:0.7rem;line-height:1.6">
            <strong>${v.number}</strong><br>
            ${v.type} / ${v.capacity}t<br>
            温度: ${tz} / PG: ${pg}<br>
            ${v.status}
            ${v.notes ? `<br><span style="color:#6b7280">${v.notes}</span>` : ''}
        </div>`;
    tip.style.cssText = `position:fixed;left:${Math.min(rect.left, window.innerWidth - 180)}px;top:${rect.bottom + 4}px;z-index:100;background:#1e293b;color:#fff;padding:8px 12px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.3);max-width:180px;`;
    document.body.appendChild(tip);
    // 3秒後 or タップで閉じる
    setTimeout(() => tip.remove(), 3000);
    tip.onclick = () => tip.remove();
    document.addEventListener('touchstart', function closeTip() {
        tip.remove();
        document.removeEventListener('touchstart', closeTip);
    }, { once: true });
}

async function showDispatchDetail(id) {
    const dispatches = await apiGet('/dispatches');
    const d = dispatches.find(x => x.id === id);
    if (!d) return;

    // 【機能8】積載効率
    const capInfo = (d.weight > 0 && d.vehicle_capacity > 0) ? `<div><strong>積載効率:</strong> ${d.weight.toLocaleString()}kg / ${(d.vehicle_capacity * 1000).toLocaleString()}kg (${Math.round(d.weight / (d.vehicle_capacity * 1000) * 100)}%)</div>` : '';
    const priceInfo = d.price > 0 ? `<div><strong>運賃:</strong> ¥${d.price.toLocaleString()}</div>` : '';
    // 元の指定時間と配車時間が異なる場合
    const hasPresetDetail = d.pickup_time && d.delivery_time;
    const timeChangedDetail = hasPresetDetail && (d.pickup_time !== d.start_time || d.delivery_time !== d.end_time);
    const presetTimeInfo = timeChangedDetail
        ? `<div style="padding:6px 10px;background:#fef3c7;border-radius:6px;font-size:0.82rem;color:#92400e">📋 元の指定時間: ${d.pickup_time} 〜 ${d.delivery_time}${d.time_note ? ' (' + d.time_note + ')' : ''}</div>`
        : '';

    document.getElementById('modal-title').textContent = '配車詳細';
    document.getElementById('modal-body').innerHTML = `
        <div style="display:grid;gap:12px">
            <div><strong>日付:</strong> ${d.date}</div>
            <div><strong>時間:</strong> ${d.start_time} 〜 ${d.end_time}</div>
            ${presetTimeInfo}
            <div><strong>車両:</strong> ${d.vehicle_number}</div>
            <div><strong>ドライバー:</strong> ${d.driver_name}</div>
            <div><strong>荷主:</strong> ${d.client_name || '-'}</div>
            <div><strong>荷物:</strong> ${d.cargo_description || '-'}${d.weight > 0 ? ' (' + d.weight.toLocaleString() + 'kg)' : ''}</div>
            <div><strong>温度帯:</strong> ${d.temperature_zone && d.temperature_zone !== '常温' ? '❄ ' + d.temperature_zone : '常温'}${d.transport_type === '危険物' ? ' ⚠️ 危険物' : ''}</div>
            <div><strong>積地:</strong> ${d.pickup_address || '-'}</div>
            <div><strong>卸地:</strong> ${d.delivery_address || '-'}</div>
            ${capInfo}${priceInfo}
            <div style="font-size:0.82rem;color:#64748b"><strong>車両温度帯:</strong> ${d.vehicle_temp_zone && d.vehicle_temp_zone !== '常温' ? '❄ ' + d.vehicle_temp_zone : '常温'} ${d.vehicle_has_power_gate ? '| PG有' : ''}</div>
            <div><strong>ステータス:</strong> ${statusBadge(d.status)}</div>
            <div><strong>備考:</strong> ${d.notes || '-'}</div>
        </div>
        <div class="form-actions" style="flex-wrap:wrap;justify-content:center;gap:6px">
            <button class="btn btn-danger" onclick="deleteDispatch(${d.id})">削除</button>
            <button class="btn btn-edit" onclick="editDispatch(${d.id})">✎ 編集</button>
            <button class="btn btn-sm" onclick="printDispatchInstruction(${d.id})" title="運行指示書">🖨 指示書</button>
            <button class="btn btn-sm" onclick="showDocSendOptions('vehicle-notification', ${d.id})" title="車番連絡票">📋 車番連絡</button>
            ${d.is_partner ? `<button class="btn btn-sm" onclick="showDocSendOptions('transport-request', ${d.id})" title="輸送依頼書">📄 依頼書</button>` : ''}
            <button class="btn" onclick="closeModal()">閉じる</button>
        </div>`;
    showModal();
}

// 【機能4】運行指示書印刷（貨物自動車運送事業輸送安全規則 第9条の3準拠）
async function printDispatchInstruction(id) {
    const dispatches = await apiGet('/dispatches');
    const d = dispatches.find(x => x.id === id);
    if (!d) return;
    const settings = await apiGet('/settings');
    const today = new Date().toLocaleDateString('ja-JP');
    const printWin = window.open('', '_blank', 'width=800,height=1000');
    printWin.document.write(`<!DOCTYPE html><html><head><title>運行指示書</title>
        <style>
        @page{size:A4;margin:15mm}
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic','Meiryo',sans-serif;padding:20mm 15mm;color:#000;font-size:11pt;line-height:1.5}
        h1{font-size:18pt;text-align:center;letter-spacing:8pt;margin-bottom:6px;font-weight:700}
        .subtitle{text-align:center;font-size:9pt;color:#555;margin-bottom:16px}
        .doc-header{display:flex;justify-content:space-between;margin-bottom:14px;font-size:9.5pt}
        .doc-header .left{line-height:1.8}
        .doc-header .right{text-align:right;line-height:1.8}
        .company-name{font-size:11pt;font-weight:700}
        table{width:100%;border-collapse:collapse;margin-bottom:12px}
        th,td{border:1px solid #000;padding:6px 10px;font-size:10pt;vertical-align:top}
        th{background:#f0f0f0;font-weight:600;text-align:center;white-space:nowrap}
        .sec-title{background:#333;color:#fff;font-weight:700;font-size:10pt;padding:5px 10px;text-align:left}
        .timeline-table th{width:80px}
        .timeline-table td.time-col{width:100px;text-align:center;font-weight:600}
        .timeline-table td.place-col{width:auto}
        .timeline-table td.action-col{width:120px;text-align:center}
        .notes-area{min-height:50px}
        .sign-section{margin-top:20px;display:flex;justify-content:flex-end;gap:0}
        .sign-box{border:1px solid #000;width:80px;height:70px;text-align:center;font-size:8.5pt;font-weight:600}
        .sign-box .sign-label{background:#f0f0f0;border-bottom:1px solid #000;padding:3px 0}
        .sign-box .sign-space{height:48px}
        .legal-note{margin-top:12px;font-size:7.5pt;color:#666;text-align:center}
        .wide-th{width:100px}
        </style></head><body>
        <h1>運 行 指 示 書</h1>
        <div class="subtitle">貨物自動車運送事業輸送安全規則 第9条の3</div>

        <div class="doc-header">
            <div class="left">
                <span class="company-name">${settings.company_name || ''}</span><br>
                ${settings.address || ''}<br>
                TEL: ${settings.phone || ''}<br>
                事業者番号: ${settings.registration_number || ''}
            </div>
            <div class="right">
                作成日: ${today}<br>
                指示書番号: DI-${String(d.id).padStart(4,'0')}
            </div>
        </div>

        <table>
            <tr>
                <th class="wide-th">乗務員氏名</th>
                <td style="font-size:12pt;font-weight:700">${d.driver_name}</td>
                <th class="wide-th">車両番号</th>
                <td style="font-size:12pt;font-weight:700">${d.vehicle_number}</td>
            </tr>
            <tr>
                <th>車種</th>
                <td>${d.vehicle_type || '-'}</td>
                <th>運行日</th>
                <td style="font-weight:600">${d.date}${d.end_date && d.end_date !== d.date ? ' 〜 ' + d.end_date : ''}</td>
            </tr>
        </table>

        <table>
            <tr><td class="sec-title" colspan="4">運行経路・スケジュール</td></tr>
        </table>
        <table class="timeline-table">
            <tr>
                <th>区分</th>
                <th>時刻</th>
                <th>地点・作業内容</th>
                <th>注意事項</th>
            </tr>
            <tr>
                <td style="text-align:center;font-weight:600">出庫</td>
                <td class="time-col">${d.start_time || '-'}</td>
                <td class="place-col">営業所出発</td>
                <td>出庫前点検実施</td>
            </tr>
            <tr>
                <td style="text-align:center;font-weight:600">積込</td>
                <td class="time-col">${d.start_time || '-'}</td>
                <td class="place-col">${d.pickup_address || '-'}${d.client_name ? ' (' + d.client_name + ')' : ''}</td>
                <td>${d.cargo_description || '-'}</td>
            </tr>
            <tr>
                <td style="text-align:center;font-weight:600">荷卸</td>
                <td class="time-col">${d.end_time || '-'}</td>
                <td class="place-col">${d.delivery_address || '-'}</td>
                <td>-</td>
            </tr>
            <tr>
                <td style="text-align:center;font-weight:600">帰庫</td>
                <td class="time-col">${d.end_time || '-'}</td>
                <td class="place-col">営業所帰着</td>
                <td>帰庫後点呼実施</td>
            </tr>
        </table>

        <table>
            <tr><td class="sec-title" colspan="2">休憩・注意事項</td></tr>
            <tr><th style="width:100px">休憩地点</th><td class="notes-area">（　　　　　　　　　　）　休憩時間：　　　分</td></tr>
            <tr><th>注意箇所</th><td class="notes-area">（運行経路上の危険箇所・工事情報等）</td></tr>
            <tr><th>備考</th><td class="notes-area">${d.notes || ''}</td></tr>
        </table>

        <div class="sign-section">
            <div class="sign-box"><div class="sign-label">運行管理者</div><div class="sign-space"></div></div>
            <div class="sign-box"><div class="sign-label">補助者</div><div class="sign-space"></div></div>
            <div class="sign-box"><div class="sign-label">乗務員</div><div class="sign-space"></div></div>
        </div>

        <div class="legal-note">※正副2部作成し、正本は乗務員が携行、副本は営業所で1年間保管すること（貨物自動車運送事業輸送安全規則 第9条の3）</div>
        <script>window.print();<\/script></body></html>`);
}

// 【機能7】配車から日報自動生成
async function autoReportFromDispatch(id) {
    const dispatches = await apiGet('/dispatches');
    const d = dispatches.find(x => x.id === id);
    if (!d) return;
    if (!await showConfirm(`${d.driver_name}の日報を${d.date}分で自動作成しますか？`)) return;
    await apiPost('/reports', {
        driver_id: d.driver_id,
        date: d.date,
        start_time: d.start_time,
        end_time: d.end_time,
        distance_km: 0,
        fuel_liters: 0,
        notes: `自動生成: ${d.vehicle_number} ${d.pickup_address || ''} → ${d.delivery_address || ''}`,
    });
    alert('日報を作成しました');
    closeModal();
}

async function editDispatch(id) {
    const [dispatches, vehicles, drivers] = await Promise.all([
        apiGet('/dispatches'), apiGet('/vehicles'), apiGet('/drivers')
    ]);
    const d = dispatches.find(x => x.id === id);
    if (!d) return;
    const availableVehicles = vehicles.filter(v => v.status !== '整備中' || v.id === d.vehicle_id);
    const availableDrivers = drivers.filter(dr => dr.status !== '非番' || dr.id === d.driver_id);

    // 同日に別車両で配車されているドライバーに⚠マーク
    const dayDispatches = dispatches.filter(x => x.date === d.date && x.id !== d.id);
    const busyDriverMap = {};
    dayDispatches.forEach(x => {
        if (x.driver_id) {
            if (!busyDriverMap[x.driver_id]) busyDriverMap[x.driver_id] = [];
            busyDriverMap[x.driver_id].push(x.vehicle_number || `車両${x.vehicle_id}`);
        }
    });

    document.getElementById('modal-title').textContent = '配車編集';
    document.getElementById('modal-body').innerHTML = `
        <div class="form-row">
            <div class="form-group">
                <label>開始日</label>
                <input type="date" id="f-ed-date" value="${d.date}">
            </div>
            <div class="form-group">
                <label>終了日（日またぎ）</label>
                <input type="date" id="f-ed-end-date" value="${d.end_date || ''}">
            </div>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>開始時刻</label>
                <input type="time" id="f-ed-start" value="${d.start_time}">
            </div>
            <div class="form-group">
                <label>終了時刻</label>
                <input type="time" id="f-ed-end" value="${d.end_time}">
            </div>
        </div>
        <div class="form-group">
            <label>車両</label>
            <select id="f-ed-vehicle">
                ${availableVehicles.map(v => `<option value="${v.id}" ${v.id === d.vehicle_id ? 'selected' : ''}>${v.number} (${v.type} ${v.capacity}t)</option>`).join('')}
            </select>
        </div>
        <div class="form-group">
            <label>ドライバー</label>
            <select id="f-ed-driver">
                ${availableDrivers.map(dr => {
                    const busy = busyDriverMap[dr.id];
                    const warn = busy ? `⚠ [${busy.join(',')}]` : '';
                    return `<option value="${dr.id}" ${dr.id === d.driver_id ? 'selected' : ''}>${warn}${dr.name} (${dr.license_type}) ${dr.work_start || '08:00'}〜${dr.work_end || '17:00'}</option>`;
                }).join('')}
            </select>
        </div>
        <div class="form-group">
            <label>積地</label>
            <input type="text" id="f-ed-pickup" value="${d.pickup_address || ''}">
        </div>
        <div class="form-group">
            <label>卸地</label>
            <input type="text" id="f-ed-delivery" value="${d.delivery_address || ''}">
        </div>
        <div class="form-group">
            <label>備考</label>
            <textarea id="f-ed-notes">${d.notes || ''}</textarea>
        </div>
        <div class="form-actions">
            <button class="btn" onclick="closeModal()">キャンセル</button>
            <button class="btn btn-primary" onclick="saveEditDispatch(${d.id})">更新</button>
        </div>`;
    showModal();
}

async function saveEditDispatch(id) {
    const endDate = document.getElementById('f-ed-end-date').value;
    const dateVal = document.getElementById('f-ed-date').value;
    const startTimeVal = document.getElementById('f-ed-start').value;
    const endTimeVal = document.getElementById('f-ed-end').value;
    const vehicleIdVal = parseInt(document.getElementById('f-ed-vehicle').value);
    const driverIdVal = parseInt(document.getElementById('f-ed-driver').value);

    // Requirement 1: ドライバー重複チェック（自分自身は除外）
    if (driverIdVal) {
        const conflict = await checkDriverConflict(driverIdVal, dateVal, startTimeVal, endTimeVal, vehicleIdVal, id);
        if (conflict) {
            alert(`このドライバーは同日に別の車両（${conflict}）で配車されています。\n時間が重複しているため配車できません。`);
            return;
        }
    }

    const data = {
        start_time: startTimeVal,
        end_time: endTimeVal,
        vehicle_id: vehicleIdVal,
        driver_id: driverIdVal,
        pickup_address: document.getElementById('f-ed-pickup').value,
        delivery_address: document.getElementById('f-ed-delivery').value,
        notes: document.getElementById('f-ed-notes').value,
    };
    if (dateVal) data.date = dateVal;
    if (endDate) data.end_date = endDate;
    const resp = await fetch(API + `/dispatches/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        alert('更新に失敗しました: ' + (err.detail || resp.statusText));
        return;
    }
    closeModal();
    loadDispatchCalendar();
}

async function deleteDispatch(id) {
    if (!await showConfirm('この配車を削除しますか？')) return;
    // 紐づく案件を未配車に戻す
    const dispatches = await apiGet('/dispatches');
    const d = dispatches.find(x => x.id === id);
    if (d && d.shipment_id) {
        await apiPut(`/shipments/${d.shipment_id}`, { status: '未配車' });
    }
    await apiDelete(`/dispatches/${id}`);
    closeModal();
    loadDispatchCalendar();
}

// ===== 車両管理 =====
async function loadVehicles() {
    const vehicles = await apiGet('/vehicles');
    function renderVehicles(list) {
        document.getElementById('vehicles-table').innerHTML = list.map(v => {
            let inspBadge = '-';
            if (v.inspection_expiry) {
                const daysLeft = Math.ceil((new Date(v.inspection_expiry) - new Date()) / 86400000);
                if (daysLeft < 0) inspBadge = `<span class="badge badge-red">期限切れ</span>`;
                else if (daysLeft <= 30) inspBadge = `<span class="badge badge-orange">${v.inspection_expiry} (残${daysLeft}日)</span>`;
                else inspBadge = `${v.inspection_expiry}`;
            }
            const tz = v.temperature_zone && v.temperature_zone !== '常温' ? `<span style="color:#0891b2;font-size:0.8rem">❄${v.temperature_zone}</span>` : '<span style="color:#94a3b8;font-size:0.8rem">常温</span>';
            const pg = v.has_power_gate ? '<span style="color:#7c3aed;font-size:0.75rem;font-weight:600">PG</span>' : '';
            return `<tr>
                <td><strong><a href="#" onclick="event.preventDefault();editVehicle(${v.id})" class="link-cell">${v.number}</a></strong></td>
                <td style="font-size:0.8rem;font-family:monospace">${v.chassis_number || '-'}</td>
                <td>${v.type}</td>
                <td>${tz} ${pg}</td>
                <td>${v.capacity.toLocaleString()}</td>
                <td>${statusBadge(v.status)}</td>
                <td>${inspBadge}</td>
                <td>
                    <button class="btn btn-sm btn-edit" onclick="editVehicle(${v.id})">編集</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteVehicle(${v.id})">削除</button>
                </td>
            </tr>`;
        }).join('') || '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:40px">車両が登録されていません</td></tr>';
    }
    renderVehicles(vehicles);
    setupTableSort('vehicles-table', vehicles, renderVehicles);
}

function openVehicleModal(vehicle = null) {
    const isEdit = !!vehicle;
    document.getElementById('modal-title').textContent = isEdit ? '車両編集' : '車両追加';
    document.getElementById('modal-body').innerHTML = `
        <div class="form-row">
            <div class="form-group">
                <label>車両番号（ナンバー）</label>
                <input type="text" id="f-v-number" value="${vehicle?.number || ''}" placeholder="品川 100 あ 1234">
            </div>
            <div class="form-group">
                <label>車台番号</label>
                <input type="text" id="f-v-chassis" value="${vehicle?.chassis_number || ''}" placeholder="ABC-1234567">
            </div>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>車種</label>
                <select id="f-v-type">
                    ${['ウイング車', '平ボディ', 'バン', 'トレーラー', 'ユニック車', 'ダンプ', 'タンクローリー', '軽貨物', 'その他'].map(t =>
                        `<option ${vehicle?.type === t ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
            </div>
            <div class="form-group">
                <label>積載量(t)</label>
                <input type="number" id="f-v-capacity" value="${vehicle?.capacity || 4}" step="0.1">
            </div>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>温度帯</label>
                <select id="f-v-temp-zone">
                    ${['常温', '冷蔵', '冷凍', '冷蔵冷凍兼用'].map(t =>
                        `<option ${vehicle?.temperature_zone === t ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
            </div>
            <div class="form-group" style="display:flex;align-items:end;gap:8px;padding-bottom:6px">
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap">
                    <input type="checkbox" id="f-v-power-gate" ${vehicle?.has_power_gate ? 'checked' : ''}> パワーゲート
                </label>
            </div>
            <div class="form-group">
                <label>ステータス</label>
                <select id="f-v-status">
                    ${['通常', '整備中'].map(s =>
                        `<option ${vehicle?.status === s ? 'selected' : ''}>${s}</option>`).join('')}
                </select>
            </div>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>初度登録年月</label>
                <input type="month" id="f-v-first-reg" value="${vehicle?.first_registration || ''}">
            </div>
            <div class="form-group">
                <label>車検有効期限</label>
                <input type="date" id="f-v-inspection" value="${vehicle?.inspection_expiry || ''}">
            </div>
        </div>
        <div class="form-group">
            <label>備考</label>
            <textarea id="f-v-notes">${vehicle?.notes || ''}</textarea>
        </div>
        <div class="form-actions">
            <button class="btn" onclick="closeModal()">キャンセル</button>
            <button class="btn btn-primary" onclick="saveVehicle(${vehicle?.id || 'null'})">${isEdit ? '更新' : '追加'}</button>
        </div>`;
    showModal();
}

async function saveVehicle(id) {
    const data = {
        number: document.getElementById('f-v-number').value,
        chassis_number: document.getElementById('f-v-chassis').value,
        type: document.getElementById('f-v-type').value,
        temperature_zone: document.getElementById('f-v-temp-zone').value,
        has_power_gate: document.getElementById('f-v-power-gate').checked,
        capacity: parseFloat(document.getElementById('f-v-capacity').value),
        status: document.getElementById('f-v-status').value,
        first_registration: document.getElementById('f-v-first-reg').value,
        inspection_expiry: document.getElementById('f-v-inspection').value,
        notes: document.getElementById('f-v-notes').value,
    };
    if (!data.number) return alert('車両番号を入力してください');
    if (id) await apiPut(`/vehicles/${id}`, data); else await apiPost('/vehicles', data);
    closeModal(); loadVehicles();
}

async function editVehicle(id) {
    const vehicles = await apiGet('/vehicles');
    const v = vehicles.find(x => x.id === id);
    if (v) openVehicleModal(v);
}

async function deleteVehicle(id) {
    if (!await showConfirm('この車両を削除しますか？')) return;
    await apiDelete(`/vehicles/${id}`); loadVehicles();
}

// ===== ドライバー管理（【機能1】労働時間管理付き） =====
async function loadDrivers() {
    const [drivers, dispatches] = await Promise.all([
        apiGet('/drivers'), apiGet('/dispatches')
    ]);

    // 月間稼働時間計算
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const monthEnd = fmt(now);
    const yearStart = `${now.getFullYear()}-01-01`;

    const driverHours = {};
    const driverYearHours = {};
    dispatches.forEach(d => {
        const mins = calcDuration(d.start_time, d.end_time);
        if (d.date >= monthStart && d.date <= monthEnd) {
            driverHours[d.driver_id] = (driverHours[d.driver_id] || 0) + mins;
        }
        if (d.date >= yearStart && d.date <= monthEnd) {
            driverYearHours[d.driver_id] = (driverYearHours[d.driver_id] || 0) + mins;
        }
    });

    // 【機能1】年間労働時間アラート
    const yearLimit = 960 * 60; // 960時間 = 57600分
    let alertHtml = '';
    drivers.forEach(dr => {
        const yearMins = driverYearHours[dr.id] || 0;
        const yearHours = Math.round(yearMins / 60);
        const pct = Math.round(yearMins / yearLimit * 100);
        if (pct >= 80) {
            const cls = pct >= 95 ? 'red' : 'orange';
            alertHtml += `<div class="alert alert-${cls}">⚠ ${dr.name}: 年間${yearHours}h / 960h (${pct}%) ${pct >= 95 ? '- 上限間近！' : ''}</div>`;
        }
    });
    document.getElementById('driver-work-hours').innerHTML = alertHtml;

    function renderDrivers(list) {
        document.getElementById('drivers-table').innerHTML = list.map(d => {
            const monthMins = driverHours[d.id] || 0;
            const monthH = Math.floor(monthMins / 60);
            const monthM = monthMins % 60;
            const yearMins = driverYearHours[d.id] || 0;
            const yearH = Math.round(yearMins / 60);
            const pct = Math.round(yearMins / yearLimit * 100);
            const barColor = pct >= 95 ? 'red' : pct >= 80 ? 'orange' : 'blue';
            return `<tr>
                <td><a href="#" onclick="event.preventDefault();editDriver(${d.id})" style="color:#2563eb;font-weight:600;text-decoration:none">${d.name}</a></td>
                <td>${d.phone || '-'}</td>
                <td>${d.license_type}</td>
                <td>${statusBadge(d.status)}</td>
                <td>
                    <div style="font-size:0.8rem">${monthH}h${monthM > 0 ? String(monthM).padStart(2,'0') + 'm' : ''}/月</div>
                    <div class="mini-bar"><div class="mini-bar-fill ${barColor}" style="width:${Math.min(pct, 100)}%"></div></div>
                    <div style="font-size:0.7rem;color:var(--text-light)">年間 ${yearH}h/960h</div>
                </td>
                <td>${d.notes || '-'}</td>
                <td>
                    <button class="btn btn-sm btn-edit" onclick="editDriver(${d.id})">編集</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteDriver(${d.id})">削除</button>
                </td>
            </tr>`;
        }).join('') || '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:40px">ドライバーが登録されていません</td></tr>';
    }
    renderDrivers(drivers);
    setupTableSort('drivers-table', drivers, renderDrivers);
}

function openDriverModal(driver = null) {
    const isEdit = !!driver;
    document.getElementById('modal-title').textContent = isEdit ? 'ドライバー編集' : 'ドライバー追加';
    document.getElementById('modal-body').innerHTML = `
        <div class="form-group">
            <label>名前</label>
            <input type="text" id="f-d-name" value="${driver?.name || ''}">
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>電話番号</label>
                <input type="tel" id="f-d-phone" value="${driver?.phone || ''}">
            </div>
            <div class="form-group">
                <label>免許種別</label>
                <select id="f-d-license">
                    ${['普通', '準中型', '中型', '大型', '大型特殊', 'けん引'].map(l =>
                        `<option ${driver?.license_type === l ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
            </div>
        </div>
        <div class="form-group">
            <label>ステータス</label>
            <select id="f-d-status">
                ${['待機中', '運行中', '休憩中', '非番'].map(s =>
                    `<option ${driver?.status === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
        </div>
        <p style="font-size:.8rem;color:#64748b;margin:12px 0 6px;border-top:1px solid #e2e8f0;padding-top:12px">勤怠アプリ ログイン設定</p>
        <div class="form-row">
            <div class="form-group">
                <label>メールアドレス</label>
                <input type="email" id="f-d-email" value="${driver?.email || ''}" placeholder="driver@example.com">
            </div>
            <div class="form-group">
                <label>パスワード${isEdit ? '（変更時のみ入力）' : ''}</label>
                <input type="password" id="f-d-password" placeholder="${isEdit ? '変更なしは空欄' : 'パスワード'}">
            </div>
        </div>
        ${isEdit && driver?.has_login ? '<p style="font-size:.78rem;color:#16a34a;margin-bottom:8px">✅ 勤怠アプリログイン設定済み</p>' : ''}
        <p style="font-size:.8rem;color:#64748b;margin:12px 0 6px;border-top:1px solid #e2e8f0;padding-top:12px">出勤予定</p>
        <div class="form-row">
            <div class="form-group">
                <label>出勤開始</label>
                <input type="time" id="f-d-work-start" value="${driver?.work_start || '08:00'}">
            </div>
            <div class="form-group">
                <label>出勤終了</label>
                <input type="time" id="f-d-work-end" value="${driver?.work_end || '17:00'}">
            </div>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>免許有効期限</label>
                <input type="text" id="f-d-license-exp" value="${driver?.license_expiry || ''}" placeholder="2027-03-15">
            </div>
            <div class="form-group">
                <label>有給残日数</label>
                <input type="number" id="f-d-leave" value="${driver?.paid_leave_balance ?? 10}" step="0.5">
            </div>
        </div>
        <div class="form-group">
            <label>備考</label>
            <textarea id="f-d-notes">${driver?.notes || ''}</textarea>
        </div>
        <div class="form-actions">
            <button class="btn" onclick="closeModal()">キャンセル</button>
            <button class="btn btn-primary" onclick="saveDriver(${driver?.id || 'null'})">${isEdit ? '更新' : '追加'}</button>
        </div>`;
    showModal();
}

async function saveDriver(id) {
    const data = {
        name: document.getElementById('f-d-name').value,
        phone: document.getElementById('f-d-phone').value,
        email: document.getElementById('f-d-email').value,
        license_type: document.getElementById('f-d-license').value,
        license_expiry: document.getElementById('f-d-license-exp').value,
        status: document.getElementById('f-d-status').value,
        paid_leave_balance: parseFloat(document.getElementById('f-d-leave').value) || 10,
        work_start: document.getElementById('f-d-work-start').value || '08:00',
        work_end: document.getElementById('f-d-work-end').value || '17:00',
        notes: document.getElementById('f-d-notes').value,
    };
    const pw = document.getElementById('f-d-password').value;
    if (pw) data.password = pw;
    if (!data.name) return alert('名前を入力してください');
    if (id) await apiPut(`/drivers/${id}`, data); else await apiPost('/drivers', data);
    closeModal(); loadDrivers();
}

async function editDriver(id) {
    const drivers = await apiGet('/drivers');
    const d = drivers.find(x => x.id === id);
    if (d) openDriverModal(d);
}

async function deleteDriver(id) {
    if (!await showConfirm('このドライバーを削除しますか？')) return;
    await apiDelete(`/drivers/${id}`); loadDrivers();
}

// ===== 案件管理 =====
async function loadShipments() {
    const shipments = await apiGet('/shipments');
    function renderShipments(list) {
        document.getElementById('shipments-table').innerHTML = list.map(s => {
            const freqLabel = s.frequency_type === '単発' ? '単発' : s.frequency_type === '毎日' ? '🔁毎日' : `🔁${s.frequency_days}`;
            return `<tr>
                <td><a href="#" onclick="event.preventDefault();editShipment(${s.id})" class="link-cell">${s.name || '(未設定)'}</a></td>
                <td><a href="#" onclick="event.preventDefault();openClientDetailByName('${s.client_name}')" style="color:#2563eb;font-weight:600">${s.client_name}</a></td>
                <td>${s.cargo_description || '-'} <span style="font-size:0.7rem;padding:1px 4px;border-radius:3px;background:${s.transport_type === '冷凍' ? '#dbeafe' : s.transport_type === '冷蔵' ? '#e0f2fe' : s.transport_type === 'チルド' ? '#fef3c7' : s.transport_type === '危険物' ? '#fee2e2' : '#f1f5f9'};color:${s.transport_type === '危険物' ? '#dc2626' : '#334155'}">${s.transport_type || 'ドライ'}</span></td>
                <td style="font-size:0.8rem;line-height:1.4"><span style="white-space:nowrap">${s.pickup_address}</span><br><span style="color:#6b7280">→ ${s.delivery_address}</span></td>
                <td>${s.pickup_date}</td>
                <td style="font-size:0.8rem">${s.pickup_time || s.delivery_time ? (s.pickup_time || '-') + '→' + (s.delivery_time || '-') : (s.time_note || '-')}</td>
                <td>¥${s.price.toLocaleString()} ${s.unit_price_type && s.unit_price_type !== '個建' ? `<span style="font-size:0.65rem;color:#64748b">(${s.unit_price_type})</span>` : ''}</td>
                <td style="white-space:nowrap">${freqLabel}</td>
                <td style="white-space:nowrap">
                    <button class="btn btn-sm btn-edit" onclick="editShipment(${s.id})">編集</button>
                </td>
            </tr>`;
        }).join('') || '<tr><td colspan="9" style="text-align:center;color:#94a3b8;padding:40px">案件が登録されていません</td></tr>';
    }
    renderShipments(shipments);
    setupTableSort('shipments-table', shipments, renderShipments);
}

async function openShipmentModal(shipment = null) {
    const isEdit = !!shipment;
    const today = new Date().toISOString().split('T')[0];
    const rawFreqType = shipment?.frequency_type || '単発';
    const isTeiki = (rawFreqType === '毎日' || rawFreqType === '曜日指定');
    const freqCategory = isTeiki ? '定期' : '単発';
    const freqDays = (shipment?.frequency_days || '').split(',').filter(Boolean);
    const hasYokujitsuOroshi = (shipment?.time_note || '').includes('翌日卸');
    const clients = await apiGet('/clients');
    document.getElementById('modal-title').textContent = isEdit ? '案件編集' : '新規案件';
    document.getElementById('modal-body').innerHTML = `
        <div class="form-group" style="background:#eef2ff;padding:10px;border-radius:8px;margin-bottom:12px">
            <label style="font-weight:700;margin-bottom:6px;display:block">案件種別</label>
            <div style="display:flex;gap:16px">
                <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-weight:600">
                    <input type="radio" name="f-s-freq-category" value="単発" ${freqCategory === '単発' ? 'checked' : ''} onchange="toggleFreqCategory()"> 単発
                </label>
                <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-weight:600">
                    <input type="radio" name="f-s-freq-category" value="定期" ${freqCategory === '定期' ? 'checked' : ''} onchange="toggleFreqCategory()"> 定期
                </label>
            </div>
        </div>
        <div class="form-group">
            <label>案件名</label>
            <input type="text" id="f-s-name" value="${shipment?.name || ''}" placeholder="例: A社定期便">
        </div>
        <div class="form-group">
            <label>荷主名</label>
            <select id="f-s-client-select" onchange="onClientSelect()">
                <option value="">-- 選択してください --</option>
                ${clients.map(c => `<option value="${c.name}" ${shipment?.client_name === c.name ? 'selected' : ''}>${c.name}</option>`).join('')}
            </select>
            <input type="hidden" id="f-s-client" value="${shipment?.client_name || ''}">
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>荷物内容</label>
                <input type="text" id="f-s-cargo" value="${shipment?.cargo_description || ''}">
            </div>
            <div class="form-group">
                <label>重量(kg)</label>
                <input type="number" id="f-s-weight" value="${shipment?.weight || 0}">
            </div>
        </div>
        <div class="form-group">
            <label>積地</label>
            <input type="text" id="f-s-pickup" value="${shipment?.pickup_address || ''}">
        </div>
        <div class="form-group">
            <label>卸地</label>
            <input type="text" id="f-s-delivery" value="${shipment?.delivery_address || ''}">
        </div>
        <div id="shipment-tanpatsu-dates" style="display:${freqCategory === '単発' ? 'block' : 'none'}">
            <div class="form-row">
                <div class="form-group">
                    <label>集荷日</label>
                    <input type="date" id="f-s-pickup-date" value="${shipment?.pickup_date || today}">
                </div>
                <div class="form-group">
                    <label>集荷時間</label>
                    <input type="time" id="f-s-pickup-time-tanpatsu" value="${shipment?.pickup_time || ''}">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>配達日</label>
                    <input type="date" id="f-s-delivery-date" value="${shipment?.delivery_date || today}">
                </div>
                <div class="form-group">
                    <label>配達時間</label>
                    <input type="time" id="f-s-delivery-time-tanpatsu" value="${shipment?.delivery_time || ''}">
                </div>
            </div>
        </div>
        <div id="shipment-teiki-fields" style="display:${freqCategory === '定期' ? 'block' : 'none'}">
            <div class="form-row" style="align-items:end">
                <div class="form-group">
                    <label>集荷時間</label>
                    <input type="time" id="f-s-pickup-time-teiki" value="${shipment?.pickup_time || ''}">
                </div>
                <div class="form-group">
                    <label>配達時間</label>
                    <input type="time" id="f-s-delivery-time-teiki" value="${shipment?.delivery_time || ''}">
                </div>
                <div class="form-group" style="padding-bottom:6px">
                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap">
                        <input type="checkbox" id="f-s-yokujitsu-oroshi" ${hasYokujitsuOroshi ? 'checked' : ''}> 翌日卸
                    </label>
                </div>
            </div>
            <div class="form-group">
                <label>頻度</label>
                <select id="f-s-freq-type-teiki" onchange="toggleFreqDays()">
                    ${['毎日', '曜日指定'].map(f =>
                        `<option ${rawFreqType === f ? 'selected' : ''}>${f}</option>`).join('')}
                </select>
            </div>
            <div class="form-group" id="freq-days-group" style="display:${rawFreqType === '曜日指定' ? 'block' : 'none'}">
                <label>曜日選択</label>
                <div class="freq-days-row">
                    ${['月', '火', '水', '木', '金', '土', '日'].map(d =>
                        `<label class="freq-day-check"><input type="checkbox" value="${d}" ${freqDays.includes(d) ? 'checked' : ''}> ${d}</label>`).join('')}
                </div>
            </div>
        </div>
        <div class="form-group">
            <label>時間備考（AM指定、午前必着など）</label>
            <input type="text" id="f-s-time-note" value="${(shipment?.time_note || '').replace('翌日卸', '').replace(/^[、,\s]+|[、,\s]+$/g, '')}" placeholder="例: AM指定、13:00-15:00">
        </div>
        <div class="form-row" style="background:#f8fafc;padding:8px;border-radius:6px;margin-bottom:8px">
            <div class="form-group">
                <label>待機時間(分)</label>
                <input type="number" id="f-s-waiting" value="${shipment?.waiting_time || 0}" min="0">
            </div>
            <div class="form-group">
                <label>積込時間(分)</label>
                <input type="number" id="f-s-loading" value="${shipment?.loading_time || 0}" min="0">
            </div>
            <div class="form-group">
                <label>荷卸時間(分)</label>
                <input type="number" id="f-s-unloading" value="${shipment?.unloading_time || 0}" min="0">
            </div>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>輸送タイプ</label>
                <select id="f-s-transport-type">
                    ${['ドライ','冷蔵','冷凍','チルド','危険物'].map(t => `<option ${shipment?.transport_type === t ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
            </div>
            <div class="form-group">
                <label>単価種別</label>
                <select id="f-s-unit-type" onchange="calcShipmentPrice()">
                    ${['車建','kg単価','ケース単価','個建','才建'].map(t => `<option ${shipment?.unit_price_type === t ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
            </div>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>単価</label>
                <input type="number" step="0.01" id="f-s-unit-price" value="${shipment?.unit_price || 0}" oninput="calcShipmentPrice()">
            </div>
            <div class="form-group">
                <label>数量</label>
                <input type="number" step="0.01" id="f-s-unit-qty" value="${shipment?.unit_quantity || 0}" oninput="calcShipmentPrice()">
            </div>
            <div class="form-group">
                <label>運賃(円) <span id="f-s-price-calc" style="font-size:0.7rem;color:#64748b"></span></label>
                <input type="number" id="f-s-price" value="${shipment?.price || 0}">
            </div>
        </div>
        <div class="form-group">
            <label>備考</label>
            <textarea id="f-s-notes">${shipment?.notes || ''}</textarea>
        </div>
        <div class="form-actions">
            ${isEdit ? `<button class="btn btn-danger" onclick="confirmDeleteShipment(${shipment.id})">削除</button>` : ''}
            <button class="btn" onclick="closeModal()">キャンセル</button>
            <button class="btn btn-primary" onclick="saveShipment(${shipment?.id || 'null'})">${isEdit ? '更新' : '追加'}</button>
        </div>`;
    showModal();
}

function calcShipmentPrice() {
    const unitPrice = parseFloat(document.getElementById('f-s-unit-price').value) || 0;
    const qty = parseFloat(document.getElementById('f-s-unit-qty').value) || 0;
    const type = document.getElementById('f-s-unit-type').value;
    const calc = Math.round(unitPrice * qty);
    const label = document.getElementById('f-s-price-calc');
    if (unitPrice > 0 && qty > 0) {
        label.textContent = `(${unitPrice} × ${qty} = ¥${calc.toLocaleString()})`;
        document.getElementById('f-s-price').value = calc;
    } else {
        label.textContent = '';
    }
}

function toggleFreqCategory() {
    const category = document.querySelector('input[name="f-s-freq-category"]:checked').value;
    document.getElementById('shipment-tanpatsu-dates').style.display = category === '単発' ? 'block' : 'none';
    document.getElementById('shipment-teiki-fields').style.display = category === '定期' ? 'block' : 'none';
}

function toggleFreqDays() {
    const type = document.getElementById('f-s-freq-type-teiki').value;
    document.getElementById('freq-days-group').style.display = type === '曜日指定' ? 'block' : 'none';
}

async function saveShipment(id) {
    const freqCategory = document.querySelector('input[name="f-s-freq-category"]:checked').value;
    let freqType, freqDays = '', pickupDate, deliveryDate, pickupTime, deliveryTime;

    if (freqCategory === '定期') {
        freqType = document.getElementById('f-s-freq-type-teiki').value;
        if (freqType === '曜日指定') {
            freqDays = [...document.querySelectorAll('#freq-days-group input:checked')].map(cb => cb.value).join(',');
        }
        pickupDate = '';
        deliveryDate = '';
        pickupTime = document.getElementById('f-s-pickup-time-teiki').value;
        deliveryTime = document.getElementById('f-s-delivery-time-teiki').value;
    } else {
        freqType = '単発';
        pickupDate = document.getElementById('f-s-pickup-date').value;
        deliveryDate = document.getElementById('f-s-delivery-date').value;
        pickupTime = document.getElementById('f-s-pickup-time-tanpatsu').value;
        deliveryTime = document.getElementById('f-s-delivery-time-tanpatsu').value;
    }

    // Build time_note: combine 翌日卸 marker with user-entered time note
    let timeNoteParts = [];
    if (freqCategory === '定期' && document.getElementById('f-s-yokujitsu-oroshi').checked) {
        timeNoteParts.push('翌日卸');
    }
    const userTimeNote = document.getElementById('f-s-time-note').value.trim();
    if (userTimeNote) timeNoteParts.push(userTimeNote);
    const timeNote = timeNoteParts.join('、');

    const data = {
        name: document.getElementById('f-s-name').value,
        client_name: document.getElementById('f-s-client').value,
        cargo_description: document.getElementById('f-s-cargo').value,
        weight: parseFloat(document.getElementById('f-s-weight').value),
        pickup_address: document.getElementById('f-s-pickup').value,
        delivery_address: document.getElementById('f-s-delivery').value,
        pickup_date: pickupDate,
        pickup_time: pickupTime,
        delivery_date: deliveryDate,
        delivery_time: deliveryTime,
        time_note: timeNote,
        price: parseInt(document.getElementById('f-s-price').value),
        transport_type: document.getElementById('f-s-transport-type').value,
        unit_price_type: document.getElementById('f-s-unit-type').value,
        unit_price: parseFloat(document.getElementById('f-s-unit-price').value) || 0,
        unit_quantity: parseFloat(document.getElementById('f-s-unit-qty').value) || 0,
        frequency_type: freqType,
        frequency_days: freqDays,
        waiting_time: parseInt(document.getElementById('f-s-waiting').value) || 0,
        loading_time: parseInt(document.getElementById('f-s-loading').value) || 0,
        unloading_time: parseInt(document.getElementById('f-s-unloading').value) || 0,
        notes: document.getElementById('f-s-notes').value,
    };
    if (!data.client_name || !data.pickup_address || !data.delivery_address) return alert('荷主名、積地、卸地は必須です');
    if (id) await apiPut(`/shipments/${id}`, data); else await apiPost('/shipments', data);
    closeModal(); loadShipments();
}

async function editShipment(id) {
    const shipments = await apiGet('/shipments');
    const s = shipments.find(x => x.id === id);
    if (s) openShipmentModal(s);
}

async function confirmDeleteShipment(id) {
    if (!await showConfirm('この案件を削除しますか？')) return;
    await apiDelete(`/shipments/${id}`);
    closeModal();
    loadShipments();
}

async function deleteShipment(id) {
    if (!await showConfirm('この案件を削除しますか？')) return;
    await apiDelete(`/shipments/${id}`); loadShipments();
}

// ===== 荷主管理 =====
async function loadClients() {
    const clients = await apiGet('/clients');
    function renderClients(list) {
        document.getElementById('clients-table').innerHTML = list.map(c => `
            <tr>
                <td><a href="#" onclick="event.preventDefault();openClientDetailModal(${c.id})" style="color:#2563eb;font-weight:600">${c.name}</a></td>
                <td>${c.address || '-'}</td>
                <td>${c.phone || '-'}</td>
                <td>${c.contact_person || '-'}</td>
                <td>${c.billing_email || '-'}</td>
                <td>${c.payment_terms || '-'}</td>
                <td>
                    <button class="btn btn-sm" onclick="openClientDetailModal(${c.id})" title="詳細">📋</button>
                    <button class="btn btn-sm btn-edit" onclick="editClient(${c.id})">編集</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteClient(${c.id})">削除</button>
                </td>
            </tr>
        `).join('') || '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:40px">荷主企業が登録されていません</td></tr>';
    }
    renderClients(clients);
    setupTableSort('clients-table', clients, renderClients);
}

function openClientModal(client = null) {
    const isEdit = !!client;
    document.getElementById('modal-title').textContent = isEdit ? '荷主編集' : '新規荷主';
    document.getElementById('modal-body').innerHTML = `
        <div class="form-group"><label>企業名</label><input type="text" id="f-cl-name" value="${client?.name || ''}"></div>
        <div class="form-group"><label>住所</label><input type="text" id="f-cl-address" value="${client?.address || ''}"></div>
        <div class="form-row">
            <div class="form-group"><label>電話番号</label><input type="text" id="f-cl-phone" value="${client?.phone || ''}"></div>
            <div class="form-group"><label>FAX</label><input type="text" id="f-cl-fax" value="${client?.fax || ''}"></div>
        </div>
        <div class="form-group"><label>担当者</label><input type="text" id="f-cl-contact" value="${client?.contact_person || ''}"></div>
        <h4 style="margin:16px 0 8px;padding-top:12px;border-top:1px solid #e2e8f0;color:#475569">請求先情報</h4>
        <div class="form-group"><label>請求先住所</label><input type="text" id="f-cl-billing-addr" value="${client?.billing_address || ''}" placeholder="本社と異なる場合のみ"></div>
        <div class="form-row">
            <div class="form-group"><label>請求担当者</label><input type="text" id="f-cl-billing-contact" value="${client?.billing_contact || ''}"></div>
            <div class="form-group"><label>請求先メール</label><input type="email" id="f-cl-billing-email" value="${client?.billing_email || ''}" placeholder="invoice@example.com"></div>
        </div>
        <div class="form-group"><label>支払条件</label><input type="text" id="f-cl-payment-terms" value="${client?.payment_terms || '月末締め翌月末払い'}"></div>
        <div class="form-row">
            <div class="form-group"><label>適格請求書番号</label><input type="text" id="f-cl-tax-id" value="${client?.tax_id || ''}"></div>
            <div class="form-group"><label>振込先</label><input type="text" id="f-cl-bank" value="${client?.bank_info || ''}"></div>
        </div>
        <div class="form-group"><label>備考</label><textarea id="f-cl-notes">${client?.notes || ''}</textarea></div>
        <div class="form-actions">
            <button class="btn" onclick="closeModal()">キャンセル</button>
            <button class="btn btn-primary" onclick="saveClient(${client?.id || 'null'})">${isEdit ? '更新' : '追加'}</button>
        </div>`;
    showModal();
}

async function saveClient(id) {
    const data = {
        name: document.getElementById('f-cl-name').value,
        address: document.getElementById('f-cl-address').value,
        phone: document.getElementById('f-cl-phone').value,
        fax: document.getElementById('f-cl-fax').value,
        contact_person: document.getElementById('f-cl-contact').value,
        billing_address: document.getElementById('f-cl-billing-addr').value,
        billing_contact: document.getElementById('f-cl-billing-contact').value,
        billing_email: document.getElementById('f-cl-billing-email').value,
        payment_terms: document.getElementById('f-cl-payment-terms').value,
        tax_id: document.getElementById('f-cl-tax-id').value,
        bank_info: document.getElementById('f-cl-bank').value,
        notes: document.getElementById('f-cl-notes').value,
    };
    if (!data.name) return alert('企業名は必須です');
    if (id) await apiPut(`/clients/${id}`, data); else await apiPost('/clients', data);
    closeModal(); loadClients();
}

async function editClient(id) {
    const c = await apiGet(`/clients/${id}`);
    if (c) openClientModal(c);
}

async function deleteClient(id) {
    if (!await showConfirm('この荷主企業を削除しますか？')) return;
    await apiDelete(`/clients/${id}`); loadClients();
}

// 荷主詳細モーダル（案件情報からも呼び出し可能）
async function openClientDetailModal(clientId) {
    const c = await apiGet(`/clients/${clientId}`);
    if (!c) return alert('荷主情報が見つかりません');
    const notesLog = c.notes_log || [];
    document.getElementById('modal-title').textContent = `荷主詳細: ${c.name}`;
    document.getElementById('modal-body').innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:0.88rem;margin-bottom:16px">
            <div><strong>住所:</strong> ${c.address || '-'}</div>
            <div><strong>電話:</strong> ${c.phone || '-'}</div>
            <div><strong>FAX:</strong> ${c.fax || '-'}</div>
            <div><strong>担当者:</strong> ${c.contact_person || '-'}</div>
        </div>
        <div style="background:#f0f9ff;padding:12px;border-radius:8px;margin-bottom:16px">
            <h4 style="margin:0 0 8px;color:#1e40af;font-size:0.9rem">請求先情報</h4>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.85rem">
                <div><strong>請求先住所:</strong> ${c.billing_address || c.address || '-'}</div>
                <div><strong>請求担当:</strong> ${c.billing_contact || '-'}</div>
                <div><strong>メール:</strong> ${c.billing_email || '-'}</div>
                <div><strong>支払条件:</strong> ${c.payment_terms || '-'}</div>
                <div><strong>適格番号:</strong> ${c.tax_id || '-'}</div>
            </div>
        </div>
        <div><strong>備考:</strong> ${c.notes || '-'}</div>
        <h4 style="margin:16px 0 8px;border-top:1px solid #e2e8f0;padding-top:12px">連絡・対応履歴</h4>
        <div style="max-height:200px;overflow-y:auto;margin-bottom:12px" id="client-notes-list">
            ${notesLog.length === 0 ? '<p style="color:#94a3b8;font-size:0.85rem">履歴はまだありません</p>' :
            notesLog.map(n => `<div style="padding:8px 12px;border-left:3px solid #3b82f6;margin-bottom:8px;background:#f8fafc;border-radius:0 6px 6px 0">
                <div style="font-size:0.75rem;color:#64748b">${n.date} ${n.created_by ? '/ ' + n.created_by : ''}</div>
                <div style="font-size:0.88rem">${n.content}</div>
                <button class="btn btn-sm btn-danger" onclick="deleteClientNote(${clientId},${n.id})" style="margin-top:4px;font-size:0.7rem;padding:2px 6px">削除</button>
            </div>`).join('')}
        </div>
        <div style="display:flex;gap:8px">
            <input type="text" id="f-cl-note-content" placeholder="連絡内容を入力..." style="flex:1">
            <button class="btn btn-sm btn-primary" onclick="addClientNote(${clientId})">追加</button>
        </div>
        <div class="form-actions" style="margin-top:16px">
            <button class="btn" onclick="editClient(${clientId})">編集</button>
            <button class="btn" onclick="closeModal()">閉じる</button>
        </div>`;
    showModal();
}

async function openClientDetailByName(name) {
    const clients = await apiGet('/clients');
    const c = clients.find(x => x.name === name);
    if (c) openClientDetailModal(c.id);
}

async function addClientNote(clientId) {
    const content = document.getElementById('f-cl-note-content').value.trim();
    if (!content) return;
    await apiPost(`/clients/${clientId}/notes`, { content, created_by: '' });
    openClientDetailModal(clientId);
}

async function deleteClientNote(clientId, noteId) {
    await apiDelete(`/clients/${clientId}/notes/${noteId}`);
    openClientDetailModal(clientId);
}

function onClientSelect() {
    const sel = document.getElementById('f-s-client-select');
    const input = document.getElementById('f-s-client');
    if (sel.value) input.value = sel.value;
}

// ===== 【機能6】地図表示（GPS動態管理） =====
const GEOCODE_CACHE = {
    '東京都': [35.6812, 139.7671], '東京都大田区': [35.5614, 139.7160], '東京都大田区平和島': [35.5780, 139.7390],
    '東京都江東区': [35.6729, 139.8172], '東京都江東区有明': [35.6340, 139.7886],
    '東京都品川区': [35.6091, 139.7300], '東京都品川区東品川': [35.6100, 139.7480],
    '東京都新宿区': [35.6938, 139.7034], '東京都渋谷区': [35.6640, 139.6982],
    '東京都中央区': [35.6709, 139.7719], '東京都墨田区': [35.7107, 139.8015],
    '神奈川県横浜市': [35.4437, 139.6380], '神奈川県横浜市港北区': [35.5310, 139.6324],
    '神奈川県横浜市鶴見区': [35.5085, 139.6770], '神奈川県川崎市': [35.5308, 139.7030],
    '神奈川県藤沢市': [35.3390, 139.4896],
    '埼玉県さいたま市': [35.8617, 139.6455], '埼玉県さいたま市大宮区': [35.9064, 139.6260],
    '千葉県千葉市': [35.6074, 140.1065], '千葉県千葉市美浜区': [35.6372, 140.0594],
    '千葉県船橋市': [35.6946, 139.9828],
    '茨城県つくば市': [36.0835, 140.0765],
    '静岡県浜松市': [34.7108, 137.7261], '静岡県浜松市中区': [34.7108, 137.7261],
    '静岡県沼津市': [35.0955, 138.8626],
    '群馬県高崎市': [36.3219, 139.0032],
};

function haversineDistance(coord1, coord2) {
    const R = 6371; // km
    const dLat = (coord2[0] - coord1[0]) * Math.PI / 180;
    const dLon = (coord2[1] - coord1[1]) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(coord1[0] * Math.PI / 180) * Math.cos(coord2[0] * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) * 1.3; // 1.3x for road distance estimate
}

function simpleGeocode(address) {
    if (!address) return null;
    let bestMatch = null;
    let bestLen = 0;
    for (const [key, coords] of Object.entries(GEOCODE_CACHE)) {
        if (address.includes(key) && key.length > bestLen) {
            bestMatch = coords;
            bestLen = key.length;
        }
    }
    if (bestMatch) {
        return [bestMatch[0] + (Math.random() - 0.5) * 0.005, bestMatch[1] + (Math.random() - 0.5) * 0.005];
    }
    return null;
}

function initMap() {
    if (!map) {
        map = L.map('map').setView([35.6812, 139.7671], 9);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors'
        }).addTo(map);
    }
    // 日付ピッカー初期化
    const mapDateEl = document.getElementById('map-date');
    if (mapDateEl && !mapDateEl.value) {
        mapDateEl.value = fmt(new Date());
    }
    setTimeout(() => map.invalidateSize(), 100);
    // フィルタ選択肢を更新
    loadMapFilters();
    loadMapMarkers();
}

async function loadMapFilters() {
    const vehicles = await apiGet('/vehicles');
    const clients = await apiGet('/clients');
    const vSel = document.getElementById('map-filter-vehicle');
    const cSel = document.getElementById('map-filter-client');
    if (vSel && vSel.options.length <= 1) {
        vehicles.forEach(v => { const o = document.createElement('option'); o.value = v.id; o.textContent = v.number; vSel.appendChild(o); });
    }
    if (cSel && cSel.options.length <= 1) {
        clients.forEach(c => { const o = document.createElement('option'); o.value = c.name; o.textContent = c.name; cSel.appendChild(o); });
    }
}

function changeMapDate(delta) {
    const mapDateEl = document.getElementById('map-date');
    const current = new Date(mapDateEl.value || fmt(new Date()));
    current.setDate(current.getDate() + delta);
    mapDateEl.value = fmt(current);
    loadMapMarkers();
}

function setMapDateToday() {
    document.getElementById('map-date').value = fmt(new Date());
    loadMapMarkers();
}

async function loadMapMarkers() {
    const dispatches = await apiGet('/dispatches');
    mapMarkers.forEach(m => map.removeLayer(m));
    mapMarkers = [];

    // 選択日の配車を表示
    const mapDateEl = document.getElementById('map-date');
    const selectedDate = mapDateEl ? mapDateEl.value : fmt(new Date());
    let todayDispatches = dispatches.filter(d => d.date === selectedDate);

    // フィルタ適用
    const filterVehicle = document.getElementById('map-filter-vehicle')?.value || '';
    const filterClient = document.getElementById('map-filter-client')?.value || '';
    const filterStatus = document.getElementById('map-filter-status')?.value || '';
    if (filterVehicle) todayDispatches = todayDispatches.filter(d => d.vehicle_id == filterVehicle);
    if (filterClient) todayDispatches = todayDispatches.filter(d => d.client_name === filterClient);
    if (filterStatus) todayDispatches = todayDispatches.filter(d => d.status === filterStatus);
    const dateLabel = selectedDate === fmt(new Date()) ? '本日' : selectedDate;
    const statusEl = document.getElementById('map-status');
    if (statusEl) statusEl.textContent = `${dateLabel}の配車: ${todayDispatches.length}件`;

    if (todayDispatches.length === 0) {
        const m = L.marker([35.6812, 139.7671]).addTo(map)
            .bindPopup(`<strong>${dateLabel}の配車なし</strong><br>配車を作成するとここに表示されます`).openPopup();
        mapMarkers.push(m);
        return;
    }

    // 車両ごとに色を割り当て
    const vehicleIds = [...new Set(todayDispatches.map(d => d.vehicle_id))];
    const VEHICLE_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#6366f1'];
    const vehicleColorMap = {};
    vehicleIds.forEach((vid, i) => { vehicleColorMap[vid] = VEHICLE_COLORS[i % VEHICLE_COLORS.length]; });

    // 凡例表示
    const legendHtml = vehicleIds.map(vid => {
        const d = todayDispatches.find(x => x.vehicle_id === vid);
        const color = vehicleColorMap[vid];
        return `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:0.8rem"><span style="width:12px;height:12px;border-radius:50%;background:${color};display:inline-block"></span>${d.vehicle_number}</span>`;
    }).join('');
    const statusEl2 = document.getElementById('map-status');
    if (statusEl2) statusEl2.innerHTML = `${dateLabel}の配車: ${todayDispatches.length}件 &nbsp; ${legendHtml}`;

    const bounds = [];
    todayDispatches.forEach(d => {
        if (!d.pickup_address && !d.delivery_address) return;
        const vColor = vehicleColorMap[d.vehicle_id];
        const statusLabel = d.status === '運行中' ? '🟢' : d.status === '予定' ? '🔵' : '⚪';

        const pickupCoords = simpleGeocode(d.pickup_address);
        const deliveryCoords = simpleGeocode(d.delivery_address);

        if (pickupCoords) {
            const icon = L.divIcon({ className: 'map-icon', html: `<div style="background:${vColor};color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.3)">積</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
            const m = L.marker(pickupCoords, { icon }).addTo(map)
                .bindPopup(`<strong style="color:${vColor}">${d.vehicle_number}</strong><br>${d.driver_name}<br>📦 ${d.pickup_address}<br>${d.start_time}〜${d.end_time}<br>${statusBadgeHtml(d.status)}`);
            mapMarkers.push(m);
            bounds.push(pickupCoords);
        }
        if (deliveryCoords) {
            const icon = L.divIcon({ className: 'map-icon', html: `<div style="background:${vColor};color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.3)">卸</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
            const m = L.marker(deliveryCoords, { icon }).addTo(map)
                .bindPopup(`<strong style="color:${vColor}">🏁 ${d.vehicle_number}</strong><br>${d.delivery_address}<br>${d.driver_name}`);
            mapMarkers.push(m);
            bounds.push(deliveryCoords);
        }
        if (pickupCoords && deliveryCoords) {
            const distKm = haversineDistance(pickupCoords, deliveryCoords);
            const estMinutes = Math.round(distKm / 40 * 60); // 平均40km/h想定
            const estHours = Math.floor(estMinutes / 60);
            const estMins = estMinutes % 60;
            const timeStr = estHours > 0 ? `約${estHours}時間${estMins > 0 ? estMins + '分' : ''}` : `約${estMins}分`;
            const line = L.polyline([pickupCoords, deliveryCoords], {
                color: vColor, weight: 4, opacity: 0.8, dashArray: '8, 6'
            }).addTo(map);
            line.bindPopup(`<strong style="color:${vColor}">${d.vehicle_number}</strong><br>${d.pickup_address} → ${d.delivery_address}<br>📏 直線距離: ${distKm.toFixed(1)}km<br>🕐 推定所要: ${timeStr}（一般道平均40km/h）<br>🛣️ 高速利用時: 約${Math.round(distKm / 70 * 60)}分（平均70km/h）`);
            mapMarkers.push(line);
        }
    });

    if (bounds.length > 0) map.fitBounds(bounds, { padding: [40, 40] });
}

function statusBadgeHtml(status) {
    const colors = { '予定': 'blue', '運行中': 'green', '完了': 'gray', 'キャンセル': 'red' };
    return `<span style="background:${colors[status] === 'blue' ? '#dbeafe' : colors[status] === 'green' ? '#dcfce7' : '#f1f5f9'};padding:2px 8px;border-radius:8px;font-size:0.75rem;font-weight:600">${status}</span>`;
}

// ===== 【機能2,5】売上・請求管理 =====
function getRevMonth() {
    const el = document.getElementById('rev-month');
    if (!el || !el.value) {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
    return el.value;
}

function changeRevMonth(delta) {
    const current = getRevMonth();
    const [y, m] = current.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    document.getElementById('rev-month').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    loadRevenue();
}

function setRevMonthCurrent() {
    const now = new Date();
    document.getElementById('rev-month').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    loadRevenue();
}

async function loadRevenue() {
    // 月セレクタ初期化
    const monthEl = document.getElementById('rev-month');
    if (!monthEl.value) {
        const now = new Date();
        monthEl.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
    const [yearStr, monStr] = monthEl.value.split('-');
    const year = parseInt(yearStr), month = parseInt(monStr);
    const monthStart = `${yearStr}-${monStr}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const monthEnd = `${yearStr}-${monStr}-${String(lastDay).padStart(2, '0')}`;

    const [shipments, dispatches] = await Promise.all([
        apiGet('/shipments'), apiGet('/dispatches')
    ]);

    // 該当月の完了案件
    const completed = shipments.filter(s =>
        s.status === '完了' && s.delivery_date >= monthStart && s.delivery_date <= monthEnd
    );
    const totalRevenue = completed.reduce((sum, s) => sum + s.price, 0);
    const uninvoiced = completed.filter(s => !s.invoice_status || s.invoice_status === '未請求');
    const uninvoicedTotal = uninvoiced.reduce((sum, s) => sum + s.price, 0);

    document.getElementById('rev-monthly').textContent = `¥${totalRevenue.toLocaleString()}`;
    document.getElementById('rev-completed').textContent = completed.length;
    const avg = completed.length > 0 ? Math.round(totalRevenue / completed.length) : 0;
    document.getElementById('rev-avg').textContent = `¥${avg.toLocaleString()}`;
    document.getElementById('rev-uninvoiced').textContent = `¥${uninvoicedTotal.toLocaleString()}`;

    // 車両別売上（該当月の配車から）
    const monthDispatches = dispatches.filter(d => d.date >= monthStart && d.date <= monthEnd);
    const vehicleRevenue = {};
    monthDispatches.forEach(d => {
        if (d.price > 0) {
            const key = d.vehicle_number || '不明';
            vehicleRevenue[key] = (vehicleRevenue[key] || 0) + d.price;
        }
    });
    const maxVRev = Math.max(...Object.values(vehicleRevenue), 1);
    document.getElementById('rev-by-vehicle').innerHTML = Object.entries(vehicleRevenue)
        .sort((a, b) => b[1] - a[1])
        .map(([name, rev]) => `<div class="rev-bar-row">
            <span class="rev-bar-label">${name}</span>
            <div class="rev-bar-track"><div class="rev-bar-fill" style="width:${(rev / maxVRev) * 100}%"></div></div>
            <span class="rev-bar-value">¥${rev.toLocaleString()}</span>
        </div>`).join('') || '<p style="color:var(--text-light);font-size:0.85rem">データなし</p>';

    // 荷主別売上
    const clientRevenue = {};
    completed.forEach(s => {
        if (s.price > 0) clientRevenue[s.client_name] = (clientRevenue[s.client_name] || 0) + s.price;
    });
    const maxCRev = Math.max(...Object.values(clientRevenue), 1);
    document.getElementById('rev-by-client').innerHTML = Object.entries(clientRevenue)
        .sort((a, b) => b[1] - a[1])
        .map(([name, rev]) => `<div class="rev-bar-row">
            <span class="rev-bar-label">${name}</span>
            <div class="rev-bar-track"><div class="rev-bar-fill green" style="width:${(rev / maxCRev) * 100}%"></div></div>
            <span class="rev-bar-value">¥${rev.toLocaleString()}</span>
        </div>`).join('') || '<p style="color:var(--text-light);font-size:0.85rem">データなし</p>';

    // 請求フィルタ
    const invoiceFilter = document.getElementById('rev-filter-invoice')?.value || '';
    let filtered = completed;
    if (invoiceFilter) {
        filtered = completed.filter(s => (s.invoice_status || '未請求') === invoiceFilter);
    }

    // 請求管理テーブル
    let totalInvoice = 0;
    document.getElementById('revenue-table').innerHTML = filtered.map(s => {
        totalInvoice += s.price;
        const invStatus = s.invoice_status || '未請求';
        const invBadge = invStatus === '入金済' ? '<span class="badge badge-green">入金済</span>'
            : invStatus === '請求済' ? '<span class="badge badge-blue">請求済</span>'
            : '<span class="badge badge-orange">未請求</span>';
        return `<tr>
            <td><input type="checkbox" class="inv-check" data-id="${s.id}"></td>
            <td>${s.name || '-'}</td>
            <td><strong>${s.client_name}</strong></td>
            <td style="font-size:0.8rem">${s.pickup_address} → ${s.delivery_address}</td>
            <td>${s.delivery_date}</td>
            <td><strong>¥${s.price.toLocaleString()}</strong></td>
            <td>${invBadge}</td>
            <td style="font-size:0.8rem">${s.invoice_date || '-'}</td>
            <td>
                <select onchange="updateInvoiceStatus(${s.id}, this.value)" style="font-size:0.8rem;padding:2px 4px;border:1px solid #d1d5db;border-radius:4px">
                    <option ${invStatus === '未請求' ? 'selected' : ''}>未請求</option>
                    <option ${invStatus === '請求済' ? 'selected' : ''}>請求済</option>
                    <option ${invStatus === '入金済' ? 'selected' : ''}>入金済</option>
                </select>
            </td>
        </tr>`;
    }).join('') + (filtered.length > 0 ? `<tr style="background:#f8fafc;font-weight:700">
        <td></td><td colspan="4" style="text-align:right">合計 (${filtered.length}件)</td>
        <td>¥${totalInvoice.toLocaleString()}</td>
        <td colspan="3"></td>
    </tr>` : `<tr><td colspan="9" style="text-align:center;color:#94a3b8;padding:40px">${monthEl.value} の該当案件がありません</td></tr>`);
}

async function updateInvoiceStatus(shipmentId, status) {
    const today = fmt(new Date());
    const data = { invoice_status: status };
    if (status === '請求済' || status === '入金済') data.invoice_date = today;
    if (status === '未請求') data.invoice_date = null;
    await apiPut(`/shipments/${shipmentId}`, data);
    loadRevenue();
}

function toggleAllInvoiceChecks(master) {
    document.querySelectorAll('.inv-check').forEach(cb => cb.checked = master.checked);
}

async function bulkInvoice() {
    const checked = [...document.querySelectorAll('.inv-check:checked')].map(cb => parseInt(cb.dataset.id));
    if (checked.length === 0) return alert('請求する案件を選択してください');
    if (!await showConfirm(`${checked.length}件を請求済にしますか？`)) return;
    const today = fmt(new Date());
    for (const id of checked) {
        await apiPut(`/shipments/${id}`, { invoice_status: '請求済', invoice_date: today });
    }
    loadRevenue();
}

// 請求書印刷（適格請求書/インボイス制度対応）
async function printInvoice(clientName) {
    const [shipments, settings, clients] = await Promise.all([
        apiGet('/shipments'), apiGet('/settings'), apiGet('/clients')
    ]);
    const client = clients.find(c => c.name === clientName);
    const monthEl = document.getElementById('rev-month');
    const month = monthEl ? monthEl.value : new Date().toISOString().slice(0, 7);
    const [year, mon] = month.split('-');
    const monthStart = `${month}-01`;
    const monthEnd = `${month}-31`;

    const items = shipments.filter(s =>
        s.status === '完了' && s.client_name === clientName &&
        s.delivery_date >= monthStart && s.delivery_date <= monthEnd
    );
    if (items.length === 0) return alert('該当月の完了案件がありません');

    const subtotal = items.reduce((sum, s) => sum + s.price, 0);
    const taxRate = settings.tax_rate || 10;
    const tax = Math.floor(subtotal * taxRate / 100);
    const total = subtotal + tax;
    const today = new Date();
    const invoiceNo = `INV-${year}${mon}-${String(items[0]?.id || 1).padStart(4, '0')}`;
    const dueDate = settings.payment_terms?.includes('翌月末') ? `${parseInt(mon) === 12 ? parseInt(year) + 1 : year}/${parseInt(mon) === 12 ? '01' : String(parseInt(mon) + 1).padStart(2, '0')}/末日` : '別途ご案内';

    const itemRows = items.map((s, i) => `
        <tr>
            <td style="text-align:center">${i + 1}</td>
            <td>${s.delivery_date}</td>
            <td>${s.name || '-'}</td>
            <td style="font-size:9pt">${s.pickup_address || ''} → ${s.delivery_address || ''}</td>
            <td style="text-align:right">¥${s.price.toLocaleString()}</td>
        </tr>
    `).join('');

    const pw = window.open('', '_blank', 'width=800,height=1100');
    pw.document.write(`<!DOCTYPE html><html><head><title>請求書 ${clientName}</title>
    <style>
    @page{size:A4;margin:15mm}
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Hiragino Sans','Yu Gothic','Meiryo',sans-serif;padding:20mm 15mm;color:#000;font-size:10pt;line-height:1.5}
    h1{font-size:22pt;text-align:center;letter-spacing:12pt;margin-bottom:4px;font-weight:700;border-bottom:3px double #000;padding-bottom:8px}
    .inv-header{display:flex;justify-content:space-between;margin:16px 0}
    .inv-header .left{flex:1}
    .inv-header .right{text-align:right;font-size:9pt;line-height:1.8}
    .client-name{font-size:16pt;font-weight:700;border-bottom:2px solid #000;padding-bottom:4px;margin-bottom:8px}
    .total-box{background:#f0f0f0;border:2px solid #000;padding:12px 20px;text-align:center;margin:16px 0;font-size:14pt;font-weight:700}
    table{width:100%;border-collapse:collapse;margin:12px 0}
    th,td{border:1px solid #000;padding:5px 8px;font-size:9.5pt}
    th{background:#f0f0f0;font-weight:600;text-align:center;white-space:nowrap}
    .summary-table{width:50%;margin-left:auto}
    .summary-table td{text-align:right}
    .summary-table th{text-align:left;width:40%}
    .bank-box{border:1px solid #000;padding:10px;margin:12px 0;font-size:9pt;line-height:1.8}
    .bank-box .bank-title{font-weight:700;margin-bottom:4px}
    .seal{position:relative;display:inline-block;width:60px;height:60px;border:2px solid #c00;border-radius:50%;text-align:center;line-height:60px;font-size:7pt;color:#c00;font-weight:700;margin-left:8px;vertical-align:middle}
    .footer{margin-top:16px;font-size:8pt;color:#666;text-align:center}
    .company-block{font-size:9pt;line-height:1.8}
    </style></head><body>
    <h1>請 求 書</h1>
    <div class="inv-header">
        <div class="left">
            <div class="client-name">${clientName} 御中</div>
            ${client?.address ? `<div style="font-size:9pt">${client.address}</div>` : ''}
            <div style="margin-top:12px;font-size:10pt">下記の通りご請求申し上げます。</div>
            <div class="total-box">ご請求金額: ¥${total.toLocaleString()}-（税込）</div>
        </div>
        <div class="right">
            <div style="margin-bottom:8px">
                <strong>請求書番号:</strong> ${invoiceNo}<br>
                <strong>発行日:</strong> ${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日<br>
                <strong>お支払期限:</strong> ${dueDate}<br>
                <strong>お支払条件:</strong> ${settings.payment_terms || '-'}
            </div>
            <div class="company-block" style="border:1px solid #ccc;padding:8px;border-radius:4px">
                <strong>${settings.company_name || ''}</strong>
                ${settings.seal_text ? `<span class="seal">${settings.seal_text.substring(0, 6)}</span>` : ''}
                <br>
                〒${settings.postal_code || ''} ${settings.address || ''}<br>
                TEL: ${settings.phone || ''} / FAX: ${settings.fax || ''}<br>
                ${settings.email ? 'E-mail: ' + settings.email + '<br>' : ''}
                ${settings.representative || ''}<br>
                <strong>登録番号: ${settings.registration_number || ''}</strong>
            </div>
        </div>
    </div>

    <table>
        <thead>
            <tr><th style="width:30px">No</th><th style="width:80px">日付</th><th>案件名</th><th>区間</th><th style="width:90px">金額(税抜)</th></tr>
        </thead>
        <tbody>
            ${itemRows}
        </tbody>
    </table>

    <table class="summary-table">
        <tr><th>小計</th><td>¥${subtotal.toLocaleString()}</td></tr>
        <tr><th>消費税(${taxRate}%)</th><td>¥${tax.toLocaleString()}</td></tr>
        <tr style="font-weight:700;font-size:11pt"><th>合計（税込）</th><td>¥${total.toLocaleString()}</td></tr>
    </table>

    <div class="bank-box">
        <div class="bank-title">■ お振込先</div>
        ${(settings.bank_info || '').replace(/\n/g, '<br>')}
    </div>

    ${settings.invoice_note ? `<p style="font-size:8.5pt;color:#333;margin-top:8px">※ ${settings.invoice_note}</p>` : ''}

    <div class="footer">
        本請求書は適格請求書（インボイス）として発行しています。<br>
        ${settings.company_name || ''} / 登録番号: ${settings.registration_number || ''} / TEL: ${settings.phone || ''}
    </div>
    </body></html>`);
    pw.document.close();
    setTimeout(() => pw.print(), 300);
}

// 請求書一覧印刷
function printInvoiceList() {
    window.print();
}

// ===== 【機能7】日報（自動生成機能付き） =====
async function loadReports() {
    const reports = await apiGet('/reports');
    document.getElementById('reports-table').innerHTML = reports.map(r => `
        <tr>
            <td>${r.date}</td>
            <td>${r.driver_name}</td>
            <td>${r.start_time || '-'}</td>
            <td>${r.end_time || '-'}</td>
            <td>${r.distance_km}</td>
            <td>${r.fuel_liters}</td>
            <td>${r.notes || '-'}</td>
            <td><button class="btn btn-sm btn-danger" onclick="deleteReport(${r.id})">削除</button></td>
        </tr>
    `).join('') || '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:40px">日報がありません</td></tr>';
}

// 【機能7】配車データから日報一括自動生成
async function autoGenerateReports() {
    const today = fmt(new Date());
    const dispatches = await apiGet(`/dispatches?target_date=${today}`);
    if (dispatches.length === 0) return alert('本日の配車データがありません');
    if (!await showConfirm(`本日(${today})の配車 ${dispatches.length}件から日報を自動生成しますか？`)) return;

    let created = 0;
    for (const d of dispatches) {
        await apiPost('/reports', {
            driver_id: d.driver_id,
            date: d.date,
            start_time: d.start_time,
            end_time: d.end_time,
            distance_km: 0,
            fuel_liters: 0,
            notes: `自動生成: ${d.vehicle_number} ${d.pickup_address || ''} → ${d.delivery_address || ''}`,
        });
        created++;
    }
    alert(`${created}件の日報を作成しました`);
    loadReports();
}

async function openReportModal() {
    const drivers = await apiGet('/drivers');
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('modal-title').textContent = '日報作成';
    document.getElementById('modal-body').innerHTML = `
        <div class="form-group">
            <label>ドライバー</label>
            <select id="f-r-driver">
                <option value="">-- 選択 --</option>
                ${drivers.map(d => `<option value="${d.id}">${d.name}</option>`).join('')}
            </select>
        </div>
        <div class="form-group"><label>日付</label><input type="date" id="f-r-date" value="${today}"></div>
        <div class="form-row">
            <div class="form-group"><label>出発時刻</label><input type="time" id="f-r-start"></div>
            <div class="form-group"><label>帰着時刻</label><input type="time" id="f-r-end"></div>
        </div>
        <div class="form-row">
            <div class="form-group"><label>走行距離(km)</label><input type="number" id="f-r-distance" value="0" step="0.1"></div>
            <div class="form-group"><label>給油量(L)</label><input type="number" id="f-r-fuel" value="0" step="0.1"></div>
        </div>
        <div class="form-group"><label>備考</label><textarea id="f-r-notes"></textarea></div>
        <div class="form-actions">
            <button class="btn" onclick="closeModal()">キャンセル</button>
            <button class="btn btn-primary" onclick="saveReport()">保存</button>
        </div>`;
    showModal();
}

async function saveReport() {
    const data = {
        driver_id: parseInt(document.getElementById('f-r-driver').value),
        date: document.getElementById('f-r-date').value,
        start_time: document.getElementById('f-r-start').value,
        end_time: document.getElementById('f-r-end').value,
        distance_km: parseFloat(document.getElementById('f-r-distance').value),
        fuel_liters: parseFloat(document.getElementById('f-r-fuel').value),
        notes: document.getElementById('f-r-notes').value,
    };
    if (!data.driver_id) return alert('ドライバーを選択してください');
    await apiPost('/reports', data); closeModal(); loadReports();
}

async function deleteReport(id) {
    if (!await showConfirm('この日報を削除しますか？')) return;
    await apiDelete(`/reports/${id}`); loadReports();
}

// ===== ユーティリティ =====
function statusBadge(status) {
    const colors = {
        '通常': 'blue', '整備中': 'orange',
        '待機中': 'green', '運行中': 'blue', '休憩中': 'orange', '非番': 'gray',
        '未配車': 'orange', '運行中': 'blue', '完了': 'green', 'キャンセル': 'red', '予定': 'purple',
    };
    return `<span class="badge badge-${colors[status] || 'gray'}">${status}</span>`;
}

function showModal() { document.getElementById('modal-overlay').classList.add('active'); }
function closeModal() { document.getElementById('modal-overlay').classList.remove('active'); }

// ===== モーダル確認ダイアログ（confirm()の代替） =====
function showConfirm(message) {
    return new Promise(resolve => {
        const overlay = document.getElementById('confirm-overlay');
        document.getElementById('confirm-message').textContent = message;
        overlay.classList.add('active');
        window._confirmResolve = resolve;
    });
}
function confirmOk() {
    document.getElementById('confirm-overlay').classList.remove('active');
    if (window._confirmResolve) { window._confirmResolve(true); window._confirmResolve = null; }
}
function confirmCancel() {
    document.getElementById('confirm-overlay').classList.remove('active');
    if (window._confirmResolve) { window._confirmResolve(false); window._confirmResolve = null; }
}

// ===== 協力会社管理 =====
async function loadPartners() {
    const [partners, invoices] = await Promise.all([
        apiGet('/partners'), apiGet('/partner-invoices')
    ]);
    function renderPartners(list) {
        document.getElementById('partners-table').innerHTML = list.map(p => `<tr>
            <td><strong>${p.name}</strong></td>
            <td style="font-size:0.8rem">${p.address || '-'}</td>
            <td style="font-size:0.8rem">${p.phone || '-'}${p.fax ? '<br>FAX:' + p.fax : ''}</td>
            <td>${p.contact_person || '-'}</td>
            <td style="font-size:0.8rem">${p.payment_terms || '-'}</td>
            <td>
                <button class="btn btn-sm btn-edit" onclick="editPartner(${p.id})">編集</button>
                <button class="btn btn-sm btn-danger" onclick="deletePartner(${p.id})">削除</button>
            </td>
        </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:40px">協力会社が登録されていません</td></tr>';
    }
    renderPartners(partners);
    setupTableSort('partners-table', partners, renderPartners);

    function renderInvoices(list) {
        document.getElementById('partner-invoices-table').innerHTML = list.map(inv => {
            const sBadge = inv.status === '支払済' ? '<span class="badge badge-green">支払済</span>'
                : inv.status === '確認済' ? '<span class="badge badge-blue">確認済</span>'
                : inv.status === '差戻' ? '<span class="badge badge-red">差戻</span>'
                : '<span class="badge badge-orange">未確認</span>';
            return `<tr>
                <td>${inv.invoice_number || '-'}</td>
                <td><strong>${inv.partner_name}</strong></td>
                <td>${inv.invoice_date || '-'}</td>
                <td>${inv.due_date || '-'}</td>
                <td><strong>¥${(inv.total_amount + inv.tax_amount).toLocaleString()}</strong></td>
                <td>${sBadge}</td>
                <td>
                    <select onchange="updatePartnerInvoiceStatus(${inv.id}, this.value)" style="font-size:0.8rem;padding:2px 4px;border:1px solid #d1d5db;border-radius:4px">
                        <option ${inv.status === '未確認' ? 'selected' : ''}>未確認</option>
                        <option ${inv.status === '確認済' ? 'selected' : ''}>確認済</option>
                        <option ${inv.status === '支払済' ? 'selected' : ''}>支払済</option>
                        <option ${inv.status === '差戻' ? 'selected' : ''}>差戻</option>
                    </select>
                    <button class="btn btn-sm btn-danger" onclick="deletePartnerInvoice(${inv.id})">削除</button>
                </td>
            </tr>`;
        }).join('') || '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:40px">請求書がありません</td></tr>';
    }
    renderInvoices(invoices);
    setupTableSort('partner-invoices-table', invoices, renderInvoices);
}

function openPartnerModal(partner = null) {
    const isEdit = !!partner;
    document.getElementById('modal-title').textContent = isEdit ? '協力会社編集' : '協力会社追加';
    document.getElementById('modal-body').innerHTML = `
        <div class="form-group"><label>会社名</label><input type="text" id="f-pt-name" value="${partner?.name || ''}"></div>
        <div class="form-group"><label>住所</label><input type="text" id="f-pt-address" value="${partner?.address || ''}"></div>
        <div class="form-row">
            <div class="form-group"><label>電話番号</label><input type="text" id="f-pt-phone" value="${partner?.phone || ''}"></div>
            <div class="form-group"><label>FAX</label><input type="text" id="f-pt-fax" value="${partner?.fax || ''}"></div>
        </div>
        <div class="form-row">
            <div class="form-group"><label>担当者</label><input type="text" id="f-pt-contact" value="${partner?.contact_person || ''}"></div>
            <div class="form-group"><label>支払条件</label><input type="text" id="f-pt-terms" value="${partner?.payment_terms || '月末締め翌月末払い'}"></div>
        </div>
        <div class="form-group"><label>振込先情報</label><textarea id="f-pt-bank">${partner?.bank_info || ''}</textarea></div>
        <div class="form-group"><label>備考</label><textarea id="f-pt-notes">${partner?.notes || ''}</textarea></div>
        <div class="form-actions">
            <button class="btn" onclick="closeModal()">キャンセル</button>
            <button class="btn btn-primary" onclick="savePartner(${partner?.id || 'null'})">${isEdit ? '更新' : '追加'}</button>
        </div>`;
    showModal();
}

async function savePartner(id) {
    const data = {
        name: document.getElementById('f-pt-name').value,
        address: document.getElementById('f-pt-address').value,
        phone: document.getElementById('f-pt-phone').value,
        fax: document.getElementById('f-pt-fax').value,
        contact_person: document.getElementById('f-pt-contact').value,
        payment_terms: document.getElementById('f-pt-terms').value,
        bank_info: document.getElementById('f-pt-bank').value,
        notes: document.getElementById('f-pt-notes').value,
    };
    if (!data.name) return alert('会社名は必須です');
    if (id) await apiPut(`/partners/${id}`, data); else await apiPost('/partners', data);
    closeModal(); loadPartners();
}

async function editPartner(id) {
    const partners = await apiGet('/partners');
    const p = partners.find(x => x.id === id);
    if (p) openPartnerModal(p);
}

async function deletePartner(id) {
    if (!await showConfirm('この協力会社を削除しますか？')) return;
    await apiDelete(`/partners/${id}`); loadPartners();
}

async function openPartnerInvoiceModal() {
    const partners = await apiGet('/partners');
    const today = fmt(new Date());
    document.getElementById('modal-title').textContent = '協力会社請求書登録';
    document.getElementById('modal-body').innerHTML = `
        <div class="form-group"><label>協力会社</label>
            <select id="f-pi-partner">${partners.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}</select>
        </div>
        <div class="form-row">
            <div class="form-group"><label>請求書番号</label><input type="text" id="f-pi-number" placeholder="INV-001"></div>
            <div class="form-group"><label>請求日</label><input type="date" id="f-pi-date" value="${today}"></div>
        </div>
        <div class="form-row">
            <div class="form-group"><label>支払期日</label><input type="date" id="f-pi-due"></div>
            <div class="form-group"><label>対象期間(開始)</label><input type="date" id="f-pi-start"></div>
        </div>
        <div class="form-row">
            <div class="form-group"><label>金額(税抜)</label><input type="number" id="f-pi-amount" value="0"></div>
            <div class="form-group"><label>消費税</label><input type="number" id="f-pi-tax" value="0"></div>
        </div>
        <div class="form-group"><label>備考</label><textarea id="f-pi-notes"></textarea></div>
        <div style="border-top:1px solid #e2e8f0;padding-top:12px;margin-top:12px">
            <label style="font-weight:600;font-size:0.85rem;color:#475569">📎 PDFスキャン読込（自動解析）</label>
            <input type="file" id="f-pi-pdf" accept=".pdf" onchange="scanPartnerInvoicePDF()" style="margin-top:6px">
            <div id="f-pi-scan-result" style="font-size:0.82rem;color:#059669;margin-top:4px"></div>
        </div>
        <div class="form-actions">
            <button class="btn" onclick="closeModal()">キャンセル</button>
            <button class="btn btn-primary" onclick="savePartnerInvoice()">登録</button>
        </div>`;
    showModal();
}

async function scanPartnerInvoicePDF() {
    const file = document.getElementById('f-pi-pdf').files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    document.getElementById('f-pi-scan-result').textContent = 'スキャン中...';
    try {
        const resp = await fetch('/api/partner-invoices/upload-pdf', { method: 'POST', body: formData });
        const result = await resp.json();
        if (result.auto_parsed) {
            if (result.total_amount) document.getElementById('f-pi-amount').value = result.total_amount;
            if (result.tax_amount) document.getElementById('f-pi-tax').value = result.tax_amount;
            if (result.invoice_number) document.getElementById('f-pi-number').value = result.invoice_number;
            if (result.invoice_date) document.getElementById('f-pi-date').value = result.invoice_date;
            if (result.due_date) document.getElementById('f-pi-due').value = result.due_date;
            document.getElementById('f-pi-scan-result').textContent = '✅ PDF解析完了 - 金額等を自動入力しました';
        } else {
            document.getElementById('f-pi-scan-result').textContent = '⚠ PDF解析できませんでした（手動入力してください）';
        }
        // pdfファイル名を隠しフィールドに保存
        if (result.pdf_filename) {
            window._partnerInvoicePdf = result.pdf_filename;
        }
    } catch(e) {
        document.getElementById('f-pi-scan-result').textContent = '❌ アップロードに失敗しました';
    }
}

async function savePartnerInvoice() {
    const data = {
        partner_id: parseInt(document.getElementById('f-pi-partner').value),
        invoice_number: document.getElementById('f-pi-number').value,
        invoice_date: document.getElementById('f-pi-date').value || null,
        due_date: document.getElementById('f-pi-due').value || null,
        total_amount: parseInt(document.getElementById('f-pi-amount').value) || 0,
        tax_amount: parseInt(document.getElementById('f-pi-tax').value) || 0,
        notes: document.getElementById('f-pi-notes').value,
    };
    await apiPost('/partner-invoices', data);
    closeModal(); loadPartners();
}

async function updatePartnerInvoiceStatus(id, status) {
    const data = { status };
    if (status === '支払済') data.payment_date = fmt(new Date());
    await apiPut(`/partner-invoices/${id}`, data);
    loadPartners();
}

async function deletePartnerInvoice(id) {
    if (!await showConfirm('この請求書を削除しますか？')) return;
    await apiDelete(`/partner-invoices/${id}`); loadPartners();
}

// ===== 書類管理 =====
async function loadDocuments() {
    const [trs, vns] = await Promise.all([
        apiGet('/transport-requests'), apiGet('/vehicle-notifications')
    ]);
    document.getElementById('transport-requests-table').innerHTML = trs.map(r => {
        const sBadge = r.status === '完了' ? '<span class="badge badge-green">完了</span>'
            : r.status === '受諾' ? '<span class="badge badge-blue">受諾</span>'
            : r.status === '送付済' ? '<span class="badge badge-purple">送付済</span>'
            : '<span class="badge badge-orange">下書き</span>';
        return `<tr>
            <td>${r.request_number || '-'}</td>
            <td><strong>${r.partner_name}</strong></td>
            <td>${r.pickup_date || '-'}</td>
            <td style="font-size:0.8rem">${r.pickup_address} → ${r.delivery_address}</td>
            <td style="font-size:0.8rem">${r.cargo_description || '-'}</td>
            <td>¥${(r.freight_amount || 0).toLocaleString()}</td>
            <td>${sBadge}</td>
            <td>
                <button class="btn btn-sm" onclick="printTransportRequest(${r.id})">🖨 PDF</button>
                <button class="btn btn-sm btn-edit" onclick="editTransportRequest(${r.id})">編集</button>
                <button class="btn btn-sm btn-danger" onclick="deleteTransportRequest(${r.id})">削除</button>
            </td>
        </tr>`;
    }).join('') || '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:40px">輸送依頼書がありません</td></tr>';

    document.getElementById('vehicle-notifications-table').innerHTML = vns.map(v => {
        const sBadge = v.status === '送付済' ? '<span class="badge badge-green">送付済</span>' : '<span class="badge badge-orange">未送付</span>';
        return `<tr>
            <td>${v.arrival_date || '-'}</td>
            <td>${v.arrival_time || '-'}</td>
            <td><strong>${v.vehicle_number || '-'}</strong></td>
            <td>${v.driver_name || '-'}</td>
            <td style="font-size:0.8rem">${v.destination_name || '-'}<br>${v.destination_address || ''}</td>
            <td style="font-size:0.8rem">${v.cargo_description || '-'}</td>
            <td>${sBadge}</td>
            <td>
                <button class="btn btn-sm" onclick="printVehicleNotification(${v.id})">🖨 PDF</button>
                <button class="btn btn-sm btn-danger" onclick="deleteVehicleNotification(${v.id})">削除</button>
            </td>
        </tr>`;
    }).join('') || '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:40px">車番連絡票がありません</td></tr>';
}

async function openTransportRequestModal(shipment = null) {
    const partners = await apiGet('/partners');
    const today = fmt(new Date());
    document.getElementById('modal-title').textContent = '輸送依頼書作成';
    document.getElementById('modal-body').innerHTML = `
        <div class="form-group"><label>依頼先 協力会社</label>
            <select id="f-tr-partner">${partners.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}</select>
        </div>
        <div class="form-row">
            <div class="form-group"><label>依頼日</label><input type="date" id="f-tr-req-date" value="${today}"></div>
            <div class="form-group"><label>車種指定</label>
                <select id="f-tr-vehicle-type"><option value="">指定なし</option>
                    ${['ウイング車','平ボディ','冷凍車','冷蔵車','バン','トレーラー','大型','4t','2t'].map(t => `<option>${t}</option>`).join('')}
                </select>
            </div>
        </div>
        <div class="form-row">
            <div class="form-group"><label>集荷日</label><input type="date" id="f-tr-pickup-date" value="${shipment?.pickup_date || ''}"></div>
            <div class="form-group"><label>集荷時間</label><input type="text" id="f-tr-pickup-time" value="${shipment?.pickup_time || ''}" placeholder="08:00 / AM指定"></div>
        </div>
        <div class="form-group"><label>積地</label><input type="text" id="f-tr-pickup-addr" value="${shipment?.pickup_address || ''}"></div>
        <div class="form-group"><label>積地 担当者・連絡先</label><input type="text" id="f-tr-pickup-contact"></div>
        <div class="form-row">
            <div class="form-group"><label>配達日</label><input type="date" id="f-tr-delivery-date" value="${shipment?.delivery_date || ''}"></div>
            <div class="form-group"><label>配達時間</label><input type="text" id="f-tr-delivery-time" value="${shipment?.delivery_time || ''}" placeholder="14:00 / PM必着"></div>
        </div>
        <div class="form-group"><label>卸地</label><input type="text" id="f-tr-delivery-addr" value="${shipment?.delivery_address || ''}"></div>
        <div class="form-group"><label>卸地 担当者・連絡先</label><input type="text" id="f-tr-delivery-contact"></div>
        <div class="form-row">
            <div class="form-group"><label>荷物内容</label><input type="text" id="f-tr-cargo" value="${shipment?.cargo_description || ''}"></div>
            <div class="form-group"><label>数量</label><input type="text" id="f-tr-quantity" placeholder="10パレット"></div>
        </div>
        <div class="form-row">
            <div class="form-group"><label>重量(kg)</label><input type="number" id="f-tr-weight" value="${shipment?.weight || 0}"></div>
            <div class="form-group"><label>運賃</label><input type="number" id="f-tr-amount" value="${shipment?.price || 0}"></div>
        </div>
        <div class="form-group"><label>特記事項</label><textarea id="f-tr-instructions" placeholder="荷扱注意、温度管理、パレット回収等"></textarea></div>
        <div class="form-actions">
            <button class="btn" onclick="closeModal()">キャンセル</button>
            <button class="btn btn-primary" onclick="saveTransportRequest()">作成</button>
        </div>`;
    showModal();
}

async function saveTransportRequest() {
    const data = {
        partner_id: parseInt(document.getElementById('f-tr-partner').value),
        request_date: document.getElementById('f-tr-req-date').value || null,
        pickup_date: document.getElementById('f-tr-pickup-date').value || null,
        pickup_time: document.getElementById('f-tr-pickup-time').value,
        delivery_date: document.getElementById('f-tr-delivery-date').value || null,
        delivery_time: document.getElementById('f-tr-delivery-time').value,
        pickup_address: document.getElementById('f-tr-pickup-addr').value,
        pickup_contact: document.getElementById('f-tr-pickup-contact').value,
        delivery_address: document.getElementById('f-tr-delivery-addr').value,
        delivery_contact: document.getElementById('f-tr-delivery-contact').value,
        cargo_description: document.getElementById('f-tr-cargo').value,
        cargo_quantity: document.getElementById('f-tr-quantity').value,
        cargo_weight: parseFloat(document.getElementById('f-tr-weight').value) || 0,
        vehicle_type_required: document.getElementById('f-tr-vehicle-type').value,
        freight_amount: parseInt(document.getElementById('f-tr-amount').value) || 0,
        special_instructions: document.getElementById('f-tr-instructions').value,
    };
    await apiPost('/transport-requests', data);
    closeModal(); loadDocuments();
}

async function editTransportRequest(id) {
    const trs = await apiGet('/transport-requests');
    const r = trs.find(x => x.id === id);
    if (!r) return;
    const partners = await apiGet('/partners');
    document.getElementById('modal-title').textContent = '輸送依頼書編集';
    document.getElementById('modal-body').innerHTML = `
        <div class="form-group"><label>依頼先</label>
            <select id="f-tre-partner">${partners.map(p => `<option value="${p.id}" ${p.id === r.partner_id ? 'selected' : ''}>${p.name}</option>`).join('')}</select>
        </div>
        <div class="form-row">
            <div class="form-group"><label>集荷日</label><input type="date" id="f-tre-pickup-date" value="${r.pickup_date || ''}"></div>
            <div class="form-group"><label>集荷時間</label><input type="text" id="f-tre-pickup-time" value="${r.pickup_time || ''}"></div>
        </div>
        <div class="form-group"><label>積地</label><input type="text" id="f-tre-pickup-addr" value="${r.pickup_address || ''}"></div>
        <div class="form-row">
            <div class="form-group"><label>配達日</label><input type="date" id="f-tre-delivery-date" value="${r.delivery_date || ''}"></div>
            <div class="form-group"><label>配達時間</label><input type="text" id="f-tre-delivery-time" value="${r.delivery_time || ''}"></div>
        </div>
        <div class="form-group"><label>卸地</label><input type="text" id="f-tre-delivery-addr" value="${r.delivery_address || ''}"></div>
        <div class="form-row">
            <div class="form-group"><label>荷物</label><input type="text" id="f-tre-cargo" value="${r.cargo_description || ''}"></div>
            <div class="form-group"><label>運賃</label><input type="number" id="f-tre-amount" value="${r.freight_amount || 0}"></div>
        </div>
        <div class="form-group"><label>ステータス</label>
            <select id="f-tre-status">${['下書き','送付済','受諾','完了','キャンセル'].map(s => `<option ${r.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        </div>
        <div class="form-actions">
            <button class="btn" onclick="closeModal()">キャンセル</button>
            <button class="btn btn-primary" onclick="updateTransportRequest(${r.id})">更新</button>
        </div>`;
    showModal();
}

async function updateTransportRequest(id) {
    const data = {
        partner_id: parseInt(document.getElementById('f-tre-partner').value),
        pickup_date: document.getElementById('f-tre-pickup-date').value || null,
        pickup_time: document.getElementById('f-tre-pickup-time').value,
        delivery_date: document.getElementById('f-tre-delivery-date').value || null,
        delivery_time: document.getElementById('f-tre-delivery-time').value,
        pickup_address: document.getElementById('f-tre-pickup-addr').value,
        delivery_address: document.getElementById('f-tre-delivery-addr').value,
        cargo_description: document.getElementById('f-tre-cargo').value,
        freight_amount: parseInt(document.getElementById('f-tre-amount').value) || 0,
        status: document.getElementById('f-tre-status').value,
    };
    await apiPut(`/transport-requests/${id}`, data);
    closeModal(); loadDocuments();
}

async function deleteTransportRequest(id) {
    if (!await showConfirm('この輸送依頼書を削除しますか？')) return;
    await apiDelete(`/transport-requests/${id}`); loadDocuments();
}

// 輸送依頼書PDF印刷（標準貨物自動車運送約款 第6条準拠）
async function printTransportRequest(id) {
    const trs = await apiGet('/transport-requests');
    const r = trs.find(x => x.id === id);
    if (!r) return;
    const settings = await apiGet('/settings');
    const today = new Date().toLocaleDateString('ja-JP');
    const printWin = window.open('', '_blank', 'width=800,height=1000');
    printWin.document.write(`<!DOCTYPE html><html><head><title>輸送依頼書</title>
        <style>
        @page{size:A4;margin:15mm}
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic','Meiryo',sans-serif;padding:20mm 15mm;color:#000;font-size:11pt;line-height:1.5}
        h1{font-size:18pt;text-align:center;letter-spacing:10pt;margin-bottom:4px;font-weight:700}
        .subtitle{text-align:center;font-size:8.5pt;color:#555;margin-bottom:18px;border-bottom:2px double #000;padding-bottom:10px}
        .parties{display:flex;justify-content:space-between;margin-bottom:16px}
        .party-box{width:48%;font-size:9.5pt;line-height:1.8}
        .party-label{background:#333;color:#fff;padding:3px 10px;font-size:9pt;font-weight:600;margin-bottom:6px;display:inline-block}
        .party-name{font-size:13pt;font-weight:700;margin:4px 0}
        .doc-info{text-align:right;font-size:9pt;margin-bottom:10px;line-height:1.8}
        table{width:100%;border-collapse:collapse;margin-bottom:10px}
        th,td{border:1px solid #000;padding:5px 10px;font-size:10pt;vertical-align:top}
        th{background:#f0f0f0;font-weight:600;text-align:center;white-space:nowrap;width:110px}
        .sec-title{background:#333;color:#fff;font-weight:700;font-size:10pt;padding:4px 10px;text-align:left}
        .amount-cell{font-size:13pt;font-weight:700;text-align:right;padding-right:16px}
        .notes-area{min-height:40px}
        .seal-section{margin-top:18px;display:flex;justify-content:space-between;align-items:flex-start}
        .seal-left{font-size:8.5pt;color:#555;line-height:1.6;max-width:55%}
        .seal-boxes{display:flex;gap:0}
        .seal-box{border:1px solid #000;width:75px;height:65px;text-align:center;font-size:8pt}
        .seal-box .seal-label{background:#f0f0f0;border-bottom:1px solid #000;padding:2px 0;font-weight:600}
        .seal-box .seal-space{height:45px}
        .legal-note{margin-top:10px;font-size:7.5pt;color:#666;text-align:center}
        </style></head><body>

        <h1>輸 送 依 頼 書</h1>
        <div class="subtitle">標準貨物自動車運送約款 第6条に基づく運送申込書</div>

        <div class="doc-info">
            依頼番号: <strong>${r.request_number}</strong><br>
            依頼日: ${r.request_date || today}
        </div>

        <div class="parties">
            <div class="party-box">
                <div class="party-label">委託事業者（依頼元）</div>
                <div class="party-name">${settings.company_name || '（未設定）'}</div>
                ${settings.address || ''}<br>
                TEL: ${settings.phone || ''}<br>
                FAX: ${settings.fax || ''}<br>
                事業者番号: ${settings.registration_number || ''}
            </div>
            <div class="party-box">
                <div class="party-label">受託事業者（依頼先）</div>
                <div class="party-name">${r.partner_name || '（未設定）'}</div>
                <br><br><br>
            </div>
        </div>

        <table>
            <tr><td class="sec-title" colspan="4">集荷情報</td></tr>
            <tr><th>集荷日</th><td>${r.pickup_date || '-'}</td><th>集荷時刻</th><td>${r.pickup_time || '-'}</td></tr>
            <tr><th>積地住所</th><td colspan="3">${r.pickup_address || '-'}</td></tr>
            <tr><th>積地連絡先</th><td colspan="3">${r.pickup_contact || '-'}</td></tr>
        </table>

        <table>
            <tr><td class="sec-title" colspan="4">配達情報</td></tr>
            <tr><th>配達日</th><td>${r.delivery_date || '-'}</td><th>配達時刻</th><td>${r.delivery_time || '-'}</td></tr>
            <tr><th>卸地住所</th><td colspan="3">${r.delivery_address || '-'}</td></tr>
            <tr><th>卸地連絡先</th><td colspan="3">${r.delivery_contact || '-'}</td></tr>
        </table>

        <table>
            <tr><td class="sec-title" colspan="4">貨物情報</td></tr>
            <tr><th>品名</th><td>${r.cargo_description || '-'}</td><th>荷姿・数量</th><td>${r.cargo_quantity || '-'}</td></tr>
            <tr><th>重量</th><td>${r.cargo_weight ? r.cargo_weight + 'kg' : '-'}</td><th>車種指定</th><td>${r.vehicle_type_required || '指定なし'}</td></tr>
        </table>

        <table>
            <tr><td class="sec-title" colspan="2">運賃・料金</td></tr>
            <tr><th>運賃</th><td class="amount-cell">¥${(r.freight_amount || 0).toLocaleString()}-</td></tr>
            <tr><th>附帯料金</th><td style="text-align:right;padding-right:16px">-</td></tr>
            <tr><th>合計金額</th><td class="amount-cell">¥${(r.freight_amount || 0).toLocaleString()}-</td></tr>
            <tr><th>支払方法</th><td>（　締め　　日　/　翌月　　日払い　）</td></tr>
        </table>

        <table>
            <tr><td class="sec-title" colspan="2">特記事項・附帯業務</td></tr>
            <tr><td colspan="2" class="notes-area">${r.special_instructions || ''}</td></tr>
        </table>

        <div class="seal-section">
            <div class="seal-left">
                上記内容にて運送を依頼いたします。<br>
                標準貨物自動車運送約款の内容について承諾します。
            </div>
            <div class="seal-boxes">
                <div class="seal-box"><div class="seal-label">委託者</div><div class="seal-space"></div></div>
                <div class="seal-box"><div class="seal-label">受託者</div><div class="seal-space"></div></div>
            </div>
        </div>

        <div class="legal-note">※本書は標準貨物自動車運送約款第6条に基づき作成された運送申込書です。双方で正副を保管してください。</div>
        <script>window.print();<\/script></body></html>`);
}

// 車番連絡票
async function openVehicleNotificationModal() {
    const today = fmt(new Date());
    document.getElementById('modal-title').textContent = '車番連絡票作成';
    document.getElementById('modal-body').innerHTML = `
        <div class="form-row">
            <div class="form-group"><label>到着予定日</label><input type="date" id="f-vn-date" value="${today}"></div>
            <div class="form-group"><label>到着予定時刻</label><input type="time" id="f-vn-time"></div>
        </div>
        <div class="form-row">
            <div class="form-group"><label>車番</label><input type="text" id="f-vn-vehicle" placeholder="品川100あ1234"></div>
            <div class="form-group"><label>車種</label><input type="text" id="f-vn-type" placeholder="4tウイング"></div>
        </div>
        <div class="form-row">
            <div class="form-group"><label>運転者名</label><input type="text" id="f-vn-driver"></div>
            <div class="form-group"><label>運転者携帯</label><input type="text" id="f-vn-phone"></div>
        </div>
        <div class="form-group"><label>届け先名称</label><input type="text" id="f-vn-dest-name"></div>
        <div class="form-group"><label>届け先住所</label><input type="text" id="f-vn-dest-addr"></div>
        <div class="form-group"><label>届け先担当者</label><input type="text" id="f-vn-dest-contact"></div>
        <div class="form-row">
            <div class="form-group"><label>荷物内容</label><input type="text" id="f-vn-cargo"></div>
            <div class="form-group"><label>数量</label><input type="text" id="f-vn-qty"></div>
        </div>
        <div class="form-group"><label>出荷元/荷主名</label><input type="text" id="f-vn-sender"></div>
        <div class="form-group"><label>特記事項</label><textarea id="f-vn-notes" placeholder="パレット回収、リフト要否"></textarea></div>
        <div class="form-actions">
            <button class="btn" onclick="closeModal()">キャンセル</button>
            <button class="btn btn-primary" onclick="saveVehicleNotification()">作成</button>
        </div>`;
    showModal();
}

async function saveVehicleNotification() {
    const data = {
        arrival_date: document.getElementById('f-vn-date').value || null,
        arrival_time: document.getElementById('f-vn-time').value,
        vehicle_number: document.getElementById('f-vn-vehicle').value,
        vehicle_type: document.getElementById('f-vn-type').value,
        driver_name: document.getElementById('f-vn-driver').value,
        driver_phone: document.getElementById('f-vn-phone').value,
        destination_name: document.getElementById('f-vn-dest-name').value,
        destination_address: document.getElementById('f-vn-dest-addr').value,
        destination_contact: document.getElementById('f-vn-dest-contact').value,
        cargo_description: document.getElementById('f-vn-cargo').value,
        quantity: document.getElementById('f-vn-qty').value,
        sender_name: document.getElementById('f-vn-sender').value,
        special_notes: document.getElementById('f-vn-notes').value,
        notification_date: fmt(new Date()),
    };
    await apiPost('/vehicle-notifications', data);
    closeModal(); loadDocuments();
}

// ===== 書類送付方法選択（メール / PDF）=====
async function showDocSendOptions(docType, dispatchId) {
    const dispatches = await apiGet('/dispatches');
    const d = dispatches.find(x => x.id === dispatchId);
    if (!d) return;

    const shipments = d.shipment_id ? await apiGet('/shipments') : [];
    const s = d.shipment_id ? shipments.find(x => x.id === d.shipment_id) : null;
    const clients = await cachedApiGet('/clients');
    const partners = await apiGet('/partners');
    const partner = d.partner_id ? partners.find(p => p.id === d.partner_id) : null;
    const client = d.client_name ? clients.find(c => c.name === d.client_name) : null;

    // 送付先メールアドレスを特定（協力会社 → 荷主 の優先順）
    let recipientName = '', recipientEmail = '';
    if (docType === 'transport-request' && partner) {
        recipientName = partner.name;
        recipientEmail = partner.email || '';
    }
    if (!recipientEmail && client) {
        recipientName = client.name;
        recipientEmail = client.billing_email || '';
    }

    const docLabel = docType === 'transport-request' ? '輸送依頼書' : '車番連絡票';
    const routeInfo = `${d.pickup_address || (s ? s.pickup_address : '')} → ${d.delivery_address || (s ? s.delivery_address : '')}`;

    closeModal();
    document.getElementById('modal-title').textContent = `${docLabel} - 送付方法`;
    document.getElementById('modal-body').innerHTML = `
        <div style="margin-bottom:16px;padding:12px;background:#f8fafc;border-radius:8px;font-size:0.85rem">
            <div><strong>案件:</strong> ${d.client_name || '-'} / ${d.cargo_description || '-'}</div>
            <div><strong>区間:</strong> ${routeInfo}</div>
            <div><strong>日時:</strong> ${d.date} ${d.start_time}〜${d.end_time}</div>
            ${recipientEmail ? `<div style="margin-top:6px"><strong>送付先:</strong> ${recipientName} &lt;${recipientEmail}&gt;</div>` : ''}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
            <button class="btn btn-primary" style="padding:16px;font-size:1rem" onclick="docSendByEmail('${docType}', ${dispatchId})" ${!recipientEmail ? 'disabled title="送付先メールアドレスが未設定です"' : ''}>
                📧 メール送付
                ${recipientEmail ? `<div style="font-size:0.7rem;margin-top:4px;opacity:0.8">${recipientEmail}</div>` : '<div style="font-size:0.7rem;margin-top:4px;color:#ef4444">メール未設定</div>'}
            </button>
            <button class="btn btn-edit" style="padding:16px;font-size:1rem" onclick="docSendAsPDF('${docType}', ${dispatchId})">
                📄 PDF生成
                <div style="font-size:0.7rem;margin-top:4px;opacity:0.8">書類一覧に保存</div>
            </button>
        </div>
        <div class="form-actions">
            <button class="btn" onclick="closeModal()">キャンセル</button>
        </div>`;
    showModal();
}

async function docSendAsPDF(docType, dispatchId) {
    closeModal();
    if (docType === 'transport-request') {
        const dispatches = await apiGet('/dispatches');
        const d = dispatches.find(x => x.id === dispatchId);
        if (!d) return;
        const shipments = d.shipment_id ? await apiGet('/shipments') : [];
        const s = d.shipment_id ? shipments.find(x => x.id === d.shipment_id) : null;
        const trData = {
            partner_id: d.partner_id || null,
            shipment_id: d.shipment_id || null,
            request_date: new Date().toISOString().split('T')[0],
            pickup_date: d.date, pickup_time: d.start_time || '',
            delivery_date: d.end_date || d.date, delivery_time: d.end_time || '',
            pickup_address: d.pickup_address || (s ? s.pickup_address : ''),
            delivery_address: d.delivery_address || (s ? s.delivery_address : ''),
            cargo_description: d.cargo_description || (s ? s.cargo_description : ''),
            cargo_weight: d.weight || (s ? s.weight : 0),
            freight_amount: d.price || (s ? s.price : 0),
            status: '下書き',
        };
        try {
            const result = await apiPost('/transport-requests', trData);
            if (result && result.id) {
                alert('輸送依頼書を書類一覧に生成しました（書類管理ページで確認・印刷できます）');
            }
        } catch (e) { alert('輸送依頼書の作成に失敗しました: ' + e.message); }
    } else {
        try {
            await apiPost(`/vehicle-notifications/from-dispatch/${dispatchId}`, {});
            alert('車番連絡票を書類一覧に生成しました（書類管理ページで確認・印刷できます）');
        } catch (e) { alert('車番連絡票の作成に失敗しました: ' + e.message); }
    }
}

async function docSendByEmail(docType, dispatchId) {
    const dispatches = await apiGet('/dispatches');
    const d = dispatches.find(x => x.id === dispatchId);
    if (!d) return;
    const shipments = d.shipment_id ? await apiGet('/shipments') : [];
    const s = d.shipment_id ? shipments.find(x => x.id === d.shipment_id) : null;
    const clients = await cachedApiGet('/clients');
    const partners = await apiGet('/partners');
    const partner = d.partner_id ? partners.find(p => p.id === d.partner_id) : null;
    const client = d.client_name ? clients.find(c => c.name === d.client_name) : null;

    let recipientEmail = '';
    if (docType === 'transport-request' && partner) recipientEmail = partner.email || '';
    if (!recipientEmail && client) recipientEmail = client.billing_email || '';
    if (!recipientEmail) return alert('送付先のメールアドレスが設定されていません');

    const docLabel = docType === 'transport-request' ? '輸送依頼書' : '車番連絡票';

    // まず書類を生成
    let docId = null;
    if (docType === 'transport-request') {
        const trData = {
            partner_id: d.partner_id || null, shipment_id: d.shipment_id || null,
            request_date: new Date().toISOString().split('T')[0],
            pickup_date: d.date, pickup_time: d.start_time || '',
            delivery_date: d.end_date || d.date, delivery_time: d.end_time || '',
            pickup_address: d.pickup_address || (s ? s.pickup_address : ''),
            delivery_address: d.delivery_address || (s ? s.delivery_address : ''),
            cargo_description: d.cargo_description || (s ? s.cargo_description : ''),
            cargo_weight: d.weight || (s ? s.weight : 0),
            freight_amount: d.price || (s ? s.price : 0),
            status: '送付済',
        };
        const result = await apiPost('/transport-requests', trData);
        docId = result?.id;
    } else {
        const result = await apiPost(`/vehicle-notifications/from-dispatch/${dispatchId}`, {});
        docId = result?.id;
    }
    if (!docId) return alert(`${docLabel}の作成に失敗しました`);

    // メール送信
    try {
        const res = await fetch(`${API}/settings/send-doc-email`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                doc_type: docType,
                doc_id: docId,
                to_email: recipientEmail,
            })
        });
        if (res.ok) {
            closeModal();
            alert(`${docLabel}を ${recipientEmail} にメール送付しました`);
        } else {
            const err = await res.json().catch(() => ({}));
            alert(`メール送付に失敗しました: ${err.detail || res.statusText}`);
        }
    } catch (e) {
        alert(`メール送付に失敗しました: ${e.message}`);
    }
}

async function sendTransportRequestByEmail(trData, partnerName) {
    const result = await apiPost('/transport-requests', trData);
    if (result.id) {
        // メール送信処理（設定のSMTP使用）
        try {
            const res = await fetch(`${API}/export/send-transport-request-email`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ transport_request_id: result.id })
            });
            if (res.ok) {
                alert(`${partnerName}宛に輸送依頼書をメール送付しました。`);
            } else {
                alert('メール送信に失敗しました。PDF表示に切り替えます。');
                printTransportRequest(result.id);
            }
        } catch (e) {
            alert('メール送信に失敗しました。PDF表示に切り替えます。');
            printTransportRequest(result.id);
        }
    }
    closeModal();
}

async function sendTransportRequestAsPDF(trData) {
    const result = await apiPost('/transport-requests', trData);
    if (result.id) {
        printTransportRequest(result.id);
    }
    closeModal();
}

async function createTransportRequestFromShipment(shipmentId) {
    const shipments = await apiGet('/shipments');
    const s = shipments.find(x => x.id === shipmentId);
    if (!s) return;
    openTransportRequestModal(s);
}

// 配車から輸送依頼書を作成（配車詳細の📄ボタン）
async function createTransportRequestFromDispatch(dispatchId) {
    const dispatches = await apiGet('/dispatches');
    const d = dispatches.find(x => x.id === dispatchId);
    if (!d) return;
    // 配車データを案件形式に変換してモーダルを開く
    const shipmentLike = {
        pickup_address: d.pickup_address || '',
        delivery_address: d.delivery_address || '',
        pickup_date: d.date,
        delivery_date: d.end_date || d.date,
        pickup_time: d.start_time || '',
        delivery_time: d.end_time || '',
        cargo_description: d.cargo_description || '',
        weight: d.weight || 0,
        price: d.price || 0,
    };
    closeModal();
    openTransportRequestModal(shipmentLike);
}

// 案件から運行指示書を印刷（案件一覧の🖨ボタン）
async function printShipmentInstruction(shipmentId) {
    const shipments = await apiGet('/shipments');
    const s = shipments.find(x => x.id === shipmentId);
    if (!s) return;
    const settings = await apiGet('/settings');
    const today = new Date().toLocaleDateString('ja-JP');
    const printWin = window.open('', '_blank', 'width=800,height=1000');
    printWin.document.write(`<!DOCTYPE html><html><head><title>運行指示書</title>
        <style>
        @page{size:A4;margin:15mm}
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic','Meiryo',sans-serif;padding:20mm 15mm;color:#000;font-size:11pt;line-height:1.5}
        h1{font-size:18pt;text-align:center;letter-spacing:8pt;margin-bottom:6px;font-weight:700}
        .subtitle{text-align:center;font-size:9pt;color:#555;margin-bottom:16px}
        .doc-header{display:flex;justify-content:space-between;margin-bottom:14px;font-size:9.5pt}
        .doc-header .left{line-height:1.8}
        .doc-header .right{text-align:right;line-height:1.8}
        .company-name{font-size:11pt;font-weight:700}
        table{width:100%;border-collapse:collapse;margin-bottom:10px}
        th,td{border:1px solid #000;padding:5px 10px;font-size:10pt;vertical-align:top}
        th{background:#f0f0f0;font-weight:600;text-align:center;white-space:nowrap;width:100px}
        .sec-title{background:#333;color:#fff;font-weight:700;font-size:10pt;padding:4px 10px;text-align:left}
        .timeline-table th{width:80px}
        .notes-area{min-height:45px}
        .sign-section{margin-top:18px;display:flex;justify-content:flex-end;gap:0}
        .sign-box{border:1px solid #000;width:80px;height:70px;text-align:center;font-size:8.5pt}
        .sign-box .sign-label{background:#f0f0f0;border-bottom:1px solid #000;padding:3px 0;font-weight:600}
        .sign-box .sign-space{height:48px}
        .driver-input{margin-top:14px;font-size:9.5pt;border:1px solid #000;padding:8px 12px}
        .driver-input span{display:inline-block;border-bottom:1px solid #000;width:200px;margin:0 8px}
        .legal-note{margin-top:10px;font-size:7.5pt;color:#666;text-align:center}
        </style></head><body>

        <h1>運 行 指 示 書</h1>
        <div class="subtitle">貨物自動車運送事業輸送安全規則 第9条の3</div>

        <div class="doc-header">
            <div class="left">
                <span class="company-name">${settings.company_name || ''}</span><br>
                ${settings.address || ''}<br>
                TEL: ${settings.phone || ''}<br>
                事業者番号: ${settings.registration_number || ''}
            </div>
            <div class="right">
                作成日: ${today}<br>
                指示書番号: SI-${String(s.id).padStart(4,'0')}
            </div>
        </div>

        <table>
            <tr>
                <th>乗務員氏名</th>
                <td style="font-size:12pt;font-weight:700">（　　　　　　　　　　　　　）</td>
                <th>車両番号</th>
                <td style="font-size:12pt;font-weight:700">（　　　　　　　　　　　　　）</td>
            </tr>
            <tr>
                <th>案件名</th>
                <td colspan="3">${s.name || '-'}</td>
            </tr>
        </table>

        <table>
            <tr><td class="sec-title" colspan="4">運行経路・スケジュール</td></tr>
        </table>
        <table class="timeline-table">
            <tr>
                <th>区分</th>
                <th>日付</th>
                <th>時刻</th>
                <th>地点・作業内容</th>
            </tr>
            <tr>
                <td style="text-align:center;font-weight:600">出庫</td>
                <td style="text-align:center">${s.pickup_date || '-'}</td>
                <td style="text-align:center;font-weight:600">${s.pickup_time || '　　'}</td>
                <td>営業所出発 → 積地へ移動</td>
            </tr>
            <tr>
                <td style="text-align:center;font-weight:600">積込</td>
                <td style="text-align:center">${s.pickup_date || '-'}</td>
                <td style="text-align:center;font-weight:600">${s.pickup_time || '　　'} ${s.time_note ? '(' + s.time_note + ')' : ''}</td>
                <td>${s.pickup_address || '-'}　（${s.client_name}）</td>
            </tr>
            <tr>
                <td style="text-align:center;font-weight:600">荷卸</td>
                <td style="text-align:center">${s.delivery_date || '-'}</td>
                <td style="text-align:center;font-weight:600">${s.delivery_time || '　　'}</td>
                <td>${s.delivery_address || '-'}</td>
            </tr>
            <tr>
                <td style="text-align:center;font-weight:600">帰庫</td>
                <td style="text-align:center">${s.delivery_date || '-'}</td>
                <td style="text-align:center;font-weight:600">　　</td>
                <td>営業所帰着</td>
            </tr>
        </table>

        <table>
            <tr><td class="sec-title" colspan="2">貨物情報</td></tr>
            <tr><th>品名</th><td>${s.cargo_description || '-'}</td></tr>
            <tr><th>重量</th><td>${s.weight ? s.weight + 'kg' : '-'}</td></tr>
        </table>

        <table>
            <tr><td class="sec-title" colspan="2">休憩・注意事項</td></tr>
            <tr><th>休憩地点</th><td class="notes-area">（　　　　　　　　　　）　休憩時間：　　　分</td></tr>
            <tr><th>注意箇所</th><td class="notes-area">（運行経路上の危険箇所・工事情報等）</td></tr>
            <tr><th>備考</th><td class="notes-area">${s.notes || ''}</td></tr>
        </table>

        <div class="sign-section">
            <div class="sign-box"><div class="sign-label">運行管理者</div><div class="sign-space"></div></div>
            <div class="sign-box"><div class="sign-label">補助者</div><div class="sign-space"></div></div>
            <div class="sign-box"><div class="sign-label">乗務員</div><div class="sign-space"></div></div>
        </div>

        <div class="legal-note">※正副2部作成し、正本は乗務員が携行、副本は営業所で1年間保管すること（貨物自動車運送事業輸送安全規則 第9条の3）</div>
        <script>window.print();<\/script></body></html>`);
}

async function deleteVehicleNotification(id) {
    if (!await showConfirm('この車番連絡票を削除しますか？')) return;
    await apiDelete(`/vehicle-notifications/${id}`); loadDocuments();
}

// 車番連絡票PDF印刷（FAX送付用 A4書式）
async function printVehicleNotification(id) {
    const vns = await apiGet('/vehicle-notifications');
    const v = vns.find(x => x.id === id);
    if (!v) return;
    const settings = await apiGet('/settings');
    const today = new Date().toLocaleDateString('ja-JP');
    const printWin = window.open('', '_blank', 'width=800,height=1000');
    printWin.document.write(`<!DOCTYPE html><html><head><title>車番連絡票</title>
        <style>
        @page{size:A4;margin:15mm}
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic','Meiryo',sans-serif;padding:20mm 15mm;color:#000;font-size:11pt;line-height:1.5}
        h1{font-size:20pt;text-align:center;letter-spacing:12pt;margin-bottom:4px;font-weight:700}
        .fax-header{border:2px solid #000;padding:12px 16px;margin-bottom:16px}
        .fax-row{display:flex;justify-content:space-between;font-size:10pt;line-height:2}
        .fax-row .label{font-weight:600;min-width:50px}
        .fax-row .value{flex:1;border-bottom:1px solid #999;margin-left:8px;padding-left:4px}
        .fax-left,.fax-right{width:48%}
        .fax-parties{display:flex;justify-content:space-between;margin-bottom:0}
        .date-line{text-align:right;font-size:9.5pt;margin-bottom:14px}
        table{width:100%;border-collapse:collapse;margin-bottom:10px}
        th,td{border:2px solid #000;padding:8px 12px;font-size:10.5pt;vertical-align:middle}
        th{background:#f0f0f0;font-weight:700;text-align:center;width:110px}
        .sec-title{background:#333;color:#fff;font-weight:700;font-size:10.5pt;padding:5px 12px;text-align:left}
        .vehicle-number{font-size:20pt;font-weight:900;letter-spacing:3pt;text-align:center}
        .driver-info{font-size:13pt;font-weight:700}
        .notes-area{min-height:50px;font-size:10pt}
        .footer-note{margin-top:14px;font-size:8pt;color:#555;text-align:center;border-top:1px solid #ccc;padding-top:8px}
        </style></head><body>

        <h1>車 番 連 絡 票</h1>

        <div class="fax-header">
            <div class="fax-parties">
                <div class="fax-left">
                    <div class="fax-row"><span class="label">宛先</span><span class="value" style="font-size:12pt;font-weight:700">${v.destination_name || '　'} 御中</span></div>
                    <div class="fax-row"><span class="label">TEL</span><span class="value">${v.destination_contact || '　'}</span></div>
                </div>
                <div class="fax-right">
                    <div class="fax-row"><span class="label">発信</span><span class="value" style="font-weight:600">${settings.company_name || '　'}</span></div>
                    <div class="fax-row"><span class="label">TEL</span><span class="value">${settings.phone || '　'}</span></div>
                    <div class="fax-row"><span class="label">FAX</span><span class="value">${settings.fax || '　'}</span></div>
                </div>
            </div>
        </div>

        <div class="date-line">連絡日: ${v.notification_date || today}　　　No. VN-${String(v.id).padStart(4,'0')}</div>

        <table>
            <tr><td class="sec-title" colspan="4">車両・乗務員情報</td></tr>
            <tr>
                <th>車番</th>
                <td class="vehicle-number" colspan="3">${v.vehicle_number || '-'}</td>
            </tr>
            <tr>
                <th>車種</th>
                <td>${v.vehicle_type || '-'}</td>
                <th>台数</th>
                <td style="text-align:center">1台</td>
            </tr>
            <tr>
                <th>乗務員名</th>
                <td class="driver-info">${v.driver_name || '-'}</td>
                <th>携帯電話</th>
                <td class="driver-info">${v.driver_phone || '-'}</td>
            </tr>
        </table>

        <table>
            <tr><td class="sec-title" colspan="4">配送情報</td></tr>
            <tr>
                <th>到着予定日</th>
                <td style="font-size:12pt;font-weight:700">${v.arrival_date || '-'}</td>
                <th>到着時刻</th>
                <td style="font-size:12pt;font-weight:700">${v.arrival_time || '-'}</td>
            </tr>
            <tr>
                <th>届け先</th>
                <td colspan="3">${v.destination_name || '-'}<br>${v.destination_address || ''}</td>
            </tr>
            <tr>
                <th>出荷元</th>
                <td colspan="3">${v.sender_name || '-'}</td>
            </tr>
        </table>

        <table>
            <tr><td class="sec-title" colspan="4">貨物情報</td></tr>
            <tr>
                <th>品名</th>
                <td>${v.cargo_description || '-'}</td>
                <th>数量</th>
                <td>${v.quantity || '-'}</td>
            </tr>
        </table>

        <table>
            <tr><td class="sec-title" colspan="2">特記事項・入構注意</td></tr>
            <tr><td colspan="2" class="notes-area">${v.special_notes || '（特になし）'}</td></tr>
        </table>

        <div class="footer-note">
            ※本票はFAX送信用書面です。ご確認の上、ご不明な点がございましたらお問い合わせください。<br>
            ${settings.company_name || ''} TEL: ${settings.phone || ''} / FAX: ${settings.fax || ''}
        </div>
        <script>window.print();<\/script></body></html>`);
}

// ===== 勤怠管理 =====
async function loadAttendance() {
    const monthEl = document.getElementById('att-month');
    if (!monthEl.value) {
        const now = new Date();
        monthEl.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
    const month = monthEl.value;
    const [records, drivers] = await Promise.all([
        apiGet('/attendance'), apiGet('/drivers')
    ]);

    // ドライバーフィルタ設定
    const filterEl = document.getElementById('att-driver-filter');
    if (filterEl.options.length <= 1) {
        drivers.forEach(d => { const o = document.createElement('option'); o.value = d.id; o.textContent = d.name; filterEl.appendChild(o); });
    }
    const filterDriver = parseInt(filterEl.value) || 0;

    const filtered = records.filter(r => {
        if (!r.date.startsWith(month)) return false;
        if (filterDriver && r.driver_id !== filterDriver) return false;
        return true;
    });

    // サマリー
    const totalDays = filtered.filter(r => r.work_type === '通常' || r.work_type === '休日出勤').length;
    const totalOT = filtered.reduce((s, r) => s + (r.overtime_minutes || 0), 0);
    const totalLN = filtered.reduce((s, r) => s + (r.late_night_minutes || 0), 0);
    const totalWork = filtered.reduce((s, r) => {
        if (r.clock_in && r.clock_out) {
            const [sh, sm] = r.clock_in.split(':').map(Number);
            const [eh, em] = r.clock_out.split(':').map(Number);
            return s + (eh * 60 + em) - (sh * 60 + sm) - (r.break_minutes || 0);
        }
        return s;
    }, 0);

    document.getElementById('att-summary').innerHTML = `
        <div class="stat-card blue"><div class="stat-label">出勤日数</div><div class="stat-value">${totalDays}日</div></div>
        <div class="stat-card green"><div class="stat-label">総労働時間</div><div class="stat-value">${Math.floor(totalWork/60)}h${totalWork%60}m</div></div>
        <div class="stat-card orange"><div class="stat-label">残業時間</div><div class="stat-value">${Math.floor(totalOT/60)}h${totalOT%60}m</div></div>
        <div class="stat-card purple"><div class="stat-label">深夜時間</div><div class="stat-value">${Math.floor(totalLN/60)}h${totalLN%60}m</div></div>`;

    document.getElementById('attendance-table').innerHTML = filtered.map(r => {
        const typeBadge = r.work_type === '有給' ? '<span class="badge badge-green">有給</span>'
            : r.work_type === '休日出勤' ? '<span class="badge badge-orange">休日出勤</span>'
            : r.work_type === '欠勤' ? '<span class="badge badge-red">欠勤</span>'
            : r.work_type === '公休' ? '<span class="badge badge-gray">公休</span>'
            : '<span class="badge badge-blue">通常</span>';
        return `<tr>
            <td>${r.date}</td>
            <td><strong>${r.driver_name}</strong></td>
            <td>${r.clock_in || '-'}</td>
            <td>${r.clock_out || '-'}</td>
            <td>${r.break_minutes}</td>
            <td>${typeBadge}</td>
            <td>${r.overtime_minutes || 0}</td>
            <td>${r.late_night_minutes || 0}</td>
            <td>
                <button class="btn btn-sm btn-edit" onclick="editAttendance(${r.id})">編集</button>
                <button class="btn btn-sm btn-danger" onclick="deleteAttendance(${r.id})">削除</button>
            </td>
        </tr>`;
    }).join('') || '<tr><td colspan="9" style="text-align:center;color:#94a3b8;padding:40px">勤怠データがありません</td></tr>';
}

function openAttendanceModal(att = null) {
    const isEdit = !!att;
    const today = fmt(new Date());
    document.getElementById('modal-title').textContent = isEdit ? '勤怠編集' : '勤怠登録';
    const driversPromise = apiGet('/drivers');
    driversPromise.then(drivers => {
        document.getElementById('modal-body').innerHTML = `
            <div class="form-group"><label>ドライバー</label>
                <select id="f-at-driver">${drivers.map(d => `<option value="${d.id}" ${att?.driver_id === d.id ? 'selected' : ''}>${d.name}</option>`).join('')}</select>
            </div>
            <div class="form-row">
                <div class="form-group"><label>日付</label><input type="date" id="f-at-date" value="${att?.date || today}"></div>
                <div class="form-group"><label>勤務種別</label>
                    <select id="f-at-type">${['通常','休日出勤','有給','欠勤','公休'].map(t => `<option ${att?.work_type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
                </div>
            </div>
            <div class="form-row">
                <div class="form-group"><label>出勤時刻</label><input type="time" id="f-at-in" value="${att?.clock_in || ''}"></div>
                <div class="form-group"><label>退勤時刻</label><input type="time" id="f-at-out" value="${att?.clock_out || ''}"></div>
            </div>
            <div class="form-row">
                <div class="form-group"><label>休憩(分)</label><input type="number" id="f-at-break" value="${att?.break_minutes ?? 60}"></div>
                <div class="form-group"><label>手当(円)</label><input type="number" id="f-at-allowance" value="${att?.allowance || 0}"></div>
            </div>
            <div class="form-group"><label>備考</label><textarea id="f-at-notes">${att?.notes || ''}</textarea></div>
            <div class="form-actions">
                <button class="btn" onclick="closeModal()">キャンセル</button>
                <button class="btn btn-primary" onclick="saveAttendance(${att?.id || 'null'})">${isEdit ? '更新' : '登録'}</button>
            </div>`;
        showModal();
    });
}

async function saveAttendance(id) {
    const data = {
        driver_id: parseInt(document.getElementById('f-at-driver').value),
        date: document.getElementById('f-at-date').value,
        clock_in: document.getElementById('f-at-in').value,
        clock_out: document.getElementById('f-at-out').value,
        break_minutes: parseInt(document.getElementById('f-at-break').value) || 60,
        work_type: document.getElementById('f-at-type').value,
        allowance: parseInt(document.getElementById('f-at-allowance').value) || 0,
        notes: document.getElementById('f-at-notes').value,
    };
    if (id) await apiPut(`/attendance/${id}`, data); else await apiPost('/attendance', data);
    closeModal(); loadAttendance();
}

async function editAttendance(id) {
    const records = await apiGet('/attendance');
    const r = records.find(x => x.id === id);
    if (r) openAttendanceModal(r);
}

async function deleteAttendance(id) {
    if (!await showConfirm('この勤怠記録を削除しますか？')) return;
    await apiDelete(`/attendance/${id}`); loadAttendance();
}

async function generateAttendanceFromDispatches() {
    const today = fmt(new Date());
    const result = await apiPost(`/attendance/from-dispatches?target_date=${today}`, {});
    alert(`${result.created}件の勤怠を生成しました`);
    loadAttendance();
}

// ===== 会計 =====
async function loadAccounting() {
    const monthEl = document.getElementById('acc-month');
    if (!monthEl.value) {
        const now = new Date();
        monthEl.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
    const month = monthEl.value;
    const [entries, summary] = await Promise.all([
        apiGet('/accounting'), apiGet(`/accounting/summary?month=${month}`)
    ]);

    const filtered = entries.filter(e => e.date.startsWith(month));
    const profitRate = summary.income > 0 ? Math.round(summary.profit / summary.income * 100) : 0;

    document.getElementById('acc-summary').innerHTML = `
        <div class="stat-card green"><div class="stat-label">収入</div><div class="stat-value">¥${summary.income.toLocaleString()}</div></div>
        <div class="stat-card red"><div class="stat-label">支出</div><div class="stat-value">¥${summary.expense.toLocaleString()}</div></div>
        <div class="stat-card blue"><div class="stat-label">粗利</div><div class="stat-value">¥${summary.profit.toLocaleString()}</div></div>
        <div class="stat-card purple"><div class="stat-label">利益率</div><div class="stat-value">${profitRate}%</div></div>`;

    document.getElementById('accounting-table').innerHTML = filtered.map(e => {
        const typeBadge = e.entry_type === '収入' ? '<span class="badge badge-green">収入</span>' : '<span class="badge badge-red">支出</span>';
        return `<tr>
            <td>${e.date}</td>
            <td>${typeBadge}</td>
            <td>${e.category || '-'}</td>
            <td>${e.description || '-'}</td>
            <td><strong>¥${e.amount.toLocaleString()}</strong></td>
            <td>
                <button class="btn btn-sm btn-edit" onclick="editAccountEntry(${e.id})">編集</button>
                <button class="btn btn-sm btn-danger" onclick="deleteAccountEntry(${e.id})">削除</button>
            </td>
        </tr>`;
    }).join('') || '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:40px">仕訳データがありません</td></tr>';
}

async function openAccountEntryModal(entry = null) {
    const isEdit = !!entry;
    const today = fmt(new Date());
    const categories = await apiGet('/accounting/categories');
    document.getElementById('modal-title').textContent = isEdit ? '仕訳編集' : '仕訳登録';
    document.getElementById('modal-body').innerHTML = `
        <div class="form-row">
            <div class="form-group"><label>日付</label><input type="date" id="f-ac-date" value="${entry?.date || today}"></div>
            <div class="form-group"><label>種別</label>
                <select id="f-ac-type" onchange="updateAccCategories()">
                    <option value="収入" ${entry?.entry_type === '収入' ? 'selected' : ''}>収入</option>
                    <option value="支出" ${entry?.entry_type === '支出' ? 'selected' : ''}>支出</option>
                </select>
            </div>
        </div>
        <div class="form-group"><label>カテゴリ</label>
            <select id="f-ac-category">
                ${(entry?.entry_type === '支出' ? categories.expense : categories.income).map(c => `<option ${entry?.category === c ? 'selected' : ''}>${c}</option>`).join('')}
            </select>
        </div>
        <div class="form-group"><label>摘要</label><input type="text" id="f-ac-desc" value="${entry?.description || ''}"></div>
        <div class="form-group"><label>金額</label><input type="number" id="f-ac-amount" value="${entry?.amount || 0}"></div>
        <div class="form-group"><label>備考</label><textarea id="f-ac-notes">${entry?.notes || ''}</textarea></div>
        <div class="form-actions">
            <button class="btn" onclick="closeModal()">キャンセル</button>
            <button class="btn btn-primary" onclick="saveAccountEntry(${entry?.id || 'null'})">${isEdit ? '更新' : '登録'}</button>
        </div>`;
    showModal();
    window._accCategories = categories;
}

function updateAccCategories() {
    const type = document.getElementById('f-ac-type').value;
    const cats = type === '支出' ? window._accCategories.expense : window._accCategories.income;
    document.getElementById('f-ac-category').innerHTML = cats.map(c => `<option>${c}</option>`).join('');
}

async function saveAccountEntry(id) {
    const data = {
        date: document.getElementById('f-ac-date').value,
        entry_type: document.getElementById('f-ac-type').value,
        category: document.getElementById('f-ac-category').value,
        description: document.getElementById('f-ac-desc').value,
        amount: parseInt(document.getElementById('f-ac-amount').value) || 0,
        notes: document.getElementById('f-ac-notes').value,
    };
    if (id) await apiPut(`/accounting/${id}`, data); else await apiPost('/accounting', data);
    closeModal(); loadAccounting();
}

async function editAccountEntry(id) {
    const entries = await apiGet('/accounting');
    const e = entries.find(x => x.id === id);
    if (e) openAccountEntryModal(e);
}

async function deleteAccountEntry(id) {
    if (!await showConfirm('この仕訳を削除しますか？')) return;
    await apiDelete(`/accounting/${id}`); loadAccounting();
}

async function importRevenueToAccounting() {
    const month = document.getElementById('acc-month').value;
    if (!month) return alert('月を選択してください');
    const result = await apiPost(`/accounting/import-revenue?month=${month}`, {});
    alert(`${result.created}件の売上を取り込みました`);
    loadAccounting();
}

// ===== 設定 =====
async function loadCompanySettings() {
    const s = await apiGet('/settings');
    document.getElementById('s-company-name').value = s.company_name || '';
    document.getElementById('s-postal-code').value = s.postal_code || '';
    document.getElementById('s-address').value = s.address || '';
    document.getElementById('s-phone').value = s.phone || '';
    document.getElementById('s-fax').value = s.fax || '';
    document.getElementById('s-email').value = s.email || '';
    document.getElementById('s-representative').value = s.representative || '';
    document.getElementById('s-reg-number').value = s.registration_number || '';
    document.getElementById('s-bank-info').value = s.bank_info || '';
    document.getElementById('s-notes').value = s.notes || '';
    document.getElementById('s-payment-terms').value = s.payment_terms || '月末締め翌月末払い';
    document.getElementById('s-tax-rate').value = s.tax_rate ?? 10;
    document.getElementById('s-seal-text').value = s.seal_text || '';
    document.getElementById('s-invoice-note').value = s.invoice_note || '';
    document.getElementById('s-smtp-host').value = s.smtp_host || '';
    document.getElementById('s-smtp-port').value = s.smtp_port || '';
    document.getElementById('s-smtp-user').value = s.smtp_user || '';
    document.getElementById('s-smtp-password').value = s.smtp_password || '';
    document.getElementById('s-sender-email').value = s.sender_email || '';
}

async function saveCompanySettings() {
    const data = {
        company_name: document.getElementById('s-company-name').value,
        postal_code: document.getElementById('s-postal-code').value,
        address: document.getElementById('s-address').value,
        phone: document.getElementById('s-phone').value,
        fax: document.getElementById('s-fax').value,
        email: document.getElementById('s-email').value,
        representative: document.getElementById('s-representative').value,
        registration_number: document.getElementById('s-reg-number').value,
        bank_info: document.getElementById('s-bank-info').value,
        notes: document.getElementById('s-notes').value,
        payment_terms: document.getElementById('s-payment-terms').value,
        tax_rate: parseInt(document.getElementById('s-tax-rate').value) || 10,
        seal_text: document.getElementById('s-seal-text').value,
        invoice_note: document.getElementById('s-invoice-note').value,
        smtp_host: document.getElementById('s-smtp-host').value,
        smtp_port: parseInt(document.getElementById('s-smtp-port').value) || null,
        smtp_user: document.getElementById('s-smtp-user').value,
        smtp_password: document.getElementById('s-smtp-password').value,
        sender_email: document.getElementById('s-sender-email').value,
    };
    await apiPut('/settings', data);
    alert('保存しました');
}
