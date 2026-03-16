// ===== グローバル =====
const API = '/api';
let map = null;
let currentPage = 'dashboard';

// ===== 初期化 =====
document.addEventListener('DOMContentLoaded', () => {
    // 日付表示
    const today = new Date();
    document.getElementById('currentDate').textContent =
        today.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });

    // 配車フィルター初期値
    document.getElementById('dispatch-date-filter').value = today.toISOString().split('T')[0];
    document.getElementById('dispatch-date-filter').addEventListener('change', loadDispatches);

    // ナビゲーション
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            const page = item.dataset.page;
            navigateTo(page);
        });
    });

    // モバイルメニュー
    document.getElementById('menuToggle').addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('open');
    });

    // 初期読み込み
    loadDashboard();
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
        vehicles: '車両管理', drivers: 'ドライバー管理', map: '地図表示',
        revenue: '売上管理', reports: '日報'
    };
    document.getElementById('pageTitle').textContent = titles[page] || '';

    // ページ別読み込み
    const loaders = {
        dashboard: loadDashboard, dispatches: loadDispatches, shipments: loadShipments,
        vehicles: loadVehicles, drivers: loadDrivers, map: initMap,
        revenue: loadRevenue, reports: loadReports
    };
    if (loaders[page]) loaders[page]();

    // モバイルでサイドバーを閉じる
    document.getElementById('sidebar').classList.remove('open');
}

// ===== API ヘルパー =====
async function apiGet(url) {
    const res = await fetch(API + url);
    return res.json();
}

async function apiPost(url, data) {
    const res = await fetch(API + url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    return res.json();
}

async function apiPut(url, data) {
    const res = await fetch(API + url, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    return res.json();
}

async function apiDelete(url) {
    const res = await fetch(API + url, { method: 'DELETE' });
    return res.json();
}

// ===== ダッシュボード =====
async function loadDashboard() {
    const data = await apiGet('/dashboard');

    document.getElementById('stat-today-dispatches').textContent = data.today_dispatches;
    document.getElementById('stat-unassigned').textContent = data.unassigned_shipments;
    document.getElementById('stat-vehicles-active').innerHTML =
        `${data.vehicles.active}<small>/${data.vehicles.total}</small>`;
    document.getElementById('stat-monthly-revenue').textContent = `¥${data.monthly_revenue.toLocaleString()}`;

    // 車両ステータスバー
    const vTotal = data.vehicles.total || 1;
    document.getElementById('vehicle-status-bars').innerHTML = `
        ${statusBar('稼働中', data.vehicles.active, vTotal, 'blue')}
        ${statusBar('空車', data.vehicles.empty, vTotal, 'green')}
        ${statusBar('整備中', data.vehicles.maintenance, vTotal, 'orange')}
    `;

    // ドライバーステータスバー
    const dTotal = data.drivers.total || 1;
    document.getElementById('driver-status-bars').innerHTML = `
        ${statusBar('運行中', data.drivers.active, dTotal, 'blue')}
        ${statusBar('待機中', data.drivers.standby, dTotal, 'green')}
    `;

    // 売上チャート
    const maxRev = Math.max(...data.revenue_trend.map(r => r.revenue), 1);
    document.getElementById('revenue-chart').innerHTML = data.revenue_trend.map(r => {
        const h = Math.max((r.revenue / maxRev) * 160, 2);
        const dateLabel = r.date.slice(5);
        return `<div class="chart-bar-wrapper">
            <div class="chart-value">${r.revenue > 0 ? '¥' + (r.revenue / 1000).toFixed(0) + 'k' : ''}</div>
            <div class="chart-bar" style="height:${h}px"></div>
            <div class="chart-label">${dateLabel}</div>
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

// ===== 車両管理 =====
async function loadVehicles() {
    const vehicles = await apiGet('/vehicles');
    document.getElementById('vehicles-table').innerHTML = vehicles.map(v => `
        <tr>
            <td><strong>${v.number}</strong></td>
            <td>${v.type}</td>
            <td>${v.capacity.toLocaleString()}</td>
            <td>${statusBadge(v.status)}</td>
            <td>${v.notes || '-'}</td>
            <td>
                <button class="btn btn-sm btn-edit" onclick="editVehicle(${v.id})">編集</button>
                <button class="btn btn-sm btn-danger" onclick="deleteVehicle(${v.id})">削除</button>
            </td>
        </tr>
    `).join('') || '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:40px">車両が登録されていません</td></tr>';
}

function openVehicleModal(vehicle = null) {
    const isEdit = !!vehicle;
    document.getElementById('modal-title').textContent = isEdit ? '車両編集' : '車両追加';
    document.getElementById('modal-body').innerHTML = `
        <div class="form-group">
            <label>車両番号</label>
            <input type="text" id="f-v-number" value="${vehicle?.number || ''}" placeholder="品川 100 あ 1234">
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>車種</label>
                <select id="f-v-type">
                    ${['ウイング車', '平ボディ', '冷凍車', '冷蔵車', 'バン', 'トレーラー', 'ダンプ', 'タンクローリー', '軽バン', 'その他'].map(t =>
                        `<option ${vehicle?.type === t ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
            </div>
            <div class="form-group">
                <label>積載量(kg)</label>
                <input type="number" id="f-v-capacity" value="${vehicle?.capacity || 2000}">
            </div>
        </div>
        <div class="form-group">
            <label>ステータス</label>
            <select id="f-v-status">
                ${['空車', '稼働中', '整備中'].map(s =>
                    `<option ${vehicle?.status === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
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
        type: document.getElementById('f-v-type').value,
        capacity: parseFloat(document.getElementById('f-v-capacity').value),
        status: document.getElementById('f-v-status').value,
        notes: document.getElementById('f-v-notes').value,
    };
    if (!data.number) return alert('車両番号を入力してください');
    if (id) await apiPut(`/vehicles/${id}`, data);
    else await apiPost('/vehicles', data);
    closeModal();
    loadVehicles();
}

async function editVehicle(id) {
    const vehicles = await apiGet('/vehicles');
    const v = vehicles.find(x => x.id === id);
    if (v) openVehicleModal(v);
}

async function deleteVehicle(id) {
    if (!confirm('この車両を削除しますか？')) return;
    await apiDelete(`/vehicles/${id}`);
    loadVehicles();
}

// ===== ドライバー管理 =====
async function loadDrivers() {
    const drivers = await apiGet('/drivers');
    document.getElementById('drivers-table').innerHTML = drivers.map(d => `
        <tr>
            <td><strong>${d.name}</strong></td>
            <td>${d.phone || '-'}</td>
            <td>${d.license_type}</td>
            <td>${statusBadge(d.status)}</td>
            <td>${d.notes || '-'}</td>
            <td>
                <button class="btn btn-sm btn-edit" onclick="editDriver(${d.id})">編集</button>
                <button class="btn btn-sm btn-danger" onclick="deleteDriver(${d.id})">削除</button>
            </td>
        </tr>
    `).join('') || '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:40px">ドライバーが登録されていません</td></tr>';
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
        license_type: document.getElementById('f-d-license').value,
        status: document.getElementById('f-d-status').value,
        notes: document.getElementById('f-d-notes').value,
    };
    if (!data.name) return alert('名前を入力してください');
    if (id) await apiPut(`/drivers/${id}`, data);
    else await apiPost('/drivers', data);
    closeModal();
    loadDrivers();
}

async function editDriver(id) {
    const drivers = await apiGet('/drivers');
    const d = drivers.find(x => x.id === id);
    if (d) openDriverModal(d);
}

async function deleteDriver(id) {
    if (!confirm('このドライバーを削除しますか？')) return;
    await apiDelete(`/drivers/${id}`);
    loadDrivers();
}

// ===== 案件管理 =====
async function loadShipments() {
    const shipments = await apiGet('/shipments');
    document.getElementById('shipments-table').innerHTML = shipments.map(s => `
        <tr>
            <td><strong>${s.client_name}</strong></td>
            <td>${s.cargo_description || '-'}</td>
            <td>${s.pickup_address}</td>
            <td>${s.delivery_address}</td>
            <td>${s.pickup_date}</td>
            <td>${s.delivery_date}</td>
            <td>¥${s.price.toLocaleString()}</td>
            <td>${statusBadge(s.status)}</td>
            <td>
                <button class="btn btn-sm btn-edit" onclick="editShipment(${s.id})">編集</button>
                <button class="btn btn-sm btn-danger" onclick="deleteShipment(${s.id})">削除</button>
            </td>
        </tr>
    `).join('') || '<tr><td colspan="9" style="text-align:center;color:#94a3b8;padding:40px">案件が登録されていません</td></tr>';
}

function openShipmentModal(shipment = null) {
    const isEdit = !!shipment;
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('modal-title').textContent = isEdit ? '案件編集' : '新規案件';
    document.getElementById('modal-body').innerHTML = `
        <div class="form-group">
            <label>荷主名</label>
            <input type="text" id="f-s-client" value="${shipment?.client_name || ''}">
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
            <input type="text" id="f-s-pickup" value="${shipment?.pickup_address || ''}" placeholder="東京都大田区...">
        </div>
        <div class="form-group">
            <label>卸地</label>
            <input type="text" id="f-s-delivery" value="${shipment?.delivery_address || ''}" placeholder="神奈川県横浜市...">
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>集荷日</label>
                <input type="date" id="f-s-pickup-date" value="${shipment?.pickup_date || today}">
            </div>
            <div class="form-group">
                <label>配達日</label>
                <input type="date" id="f-s-delivery-date" value="${shipment?.delivery_date || today}">
            </div>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>運賃(円)</label>
                <input type="number" id="f-s-price" value="${shipment?.price || 0}">
            </div>
            <div class="form-group">
                <label>ステータス</label>
                <select id="f-s-status">
                    ${['未配車', '配車済', '運行中', '完了', 'キャンセル'].map(s =>
                        `<option ${shipment?.status === s ? 'selected' : ''}>${s}</option>`).join('')}
                </select>
            </div>
        </div>
        <div class="form-group">
            <label>備考</label>
            <textarea id="f-s-notes">${shipment?.notes || ''}</textarea>
        </div>
        <div class="form-actions">
            <button class="btn" onclick="closeModal()">キャンセル</button>
            <button class="btn btn-primary" onclick="saveShipment(${shipment?.id || 'null'})">${isEdit ? '更新' : '追加'}</button>
        </div>`;
    showModal();
}

async function saveShipment(id) {
    const data = {
        client_name: document.getElementById('f-s-client').value,
        cargo_description: document.getElementById('f-s-cargo').value,
        weight: parseFloat(document.getElementById('f-s-weight').value),
        pickup_address: document.getElementById('f-s-pickup').value,
        delivery_address: document.getElementById('f-s-delivery').value,
        pickup_date: document.getElementById('f-s-pickup-date').value,
        delivery_date: document.getElementById('f-s-delivery-date').value,
        price: parseInt(document.getElementById('f-s-price').value),
        status: document.getElementById('f-s-status').value,
        notes: document.getElementById('f-s-notes').value,
    };
    if (!data.client_name || !data.pickup_address || !data.delivery_address) {
        return alert('荷主名、積地、卸地は必須です');
    }
    if (id) await apiPut(`/shipments/${id}`, data);
    else await apiPost('/shipments', data);
    closeModal();
    loadShipments();
}

async function editShipment(id) {
    const shipments = await apiGet('/shipments');
    const s = shipments.find(x => x.id === id);
    if (s) openShipmentModal(s);
}

async function deleteShipment(id) {
    if (!confirm('この案件を削除しますか？')) return;
    await apiDelete(`/shipments/${id}`);
    loadShipments();
}

// ===== 配車表 =====
async function loadDispatches() {
    const dateFilter = document.getElementById('dispatch-date-filter').value;
    const url = dateFilter ? `/dispatches?target_date=${dateFilter}` : '/dispatches';
    const dispatches = await apiGet(url);
    document.getElementById('dispatches-table').innerHTML = dispatches.map(d => `
        <tr>
            <td>${d.date}</td>
            <td>${d.vehicle_number}</td>
            <td>${d.driver_name}</td>
            <td>${d.client_name}</td>
            <td>${d.pickup_address}</td>
            <td>${d.delivery_address}</td>
            <td>${statusBadge(d.status)}</td>
            <td>
                <button class="btn btn-sm btn-success" onclick="completeDispatch(${d.id})">完了</button>
                <button class="btn btn-sm btn-danger" onclick="deleteDispatch(${d.id})">削除</button>
            </td>
        </tr>
    `).join('') || '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:40px">配車データがありません</td></tr>';
}

async function openDispatchModal() {
    const [vehicles, drivers, shipments] = await Promise.all([
        apiGet('/vehicles'), apiGet('/drivers'), apiGet('/shipments')
    ]);
    const today = new Date().toISOString().split('T')[0];
    const availableVehicles = vehicles.filter(v => v.status !== '整備中');
    const availableDrivers = drivers.filter(d => d.status !== '非番');
    const unassigned = shipments.filter(s => s.status === '未配車');

    document.getElementById('modal-title').textContent = '新規配車';
    document.getElementById('modal-body').innerHTML = `
        <div class="form-group">
            <label>車両</label>
            <select id="f-dp-vehicle">
                <option value="">-- 選択 --</option>
                ${availableVehicles.map(v => `<option value="${v.id}">${v.number} (${v.type}) [${v.status}]</option>`).join('')}
            </select>
        </div>
        <div class="form-group">
            <label>ドライバー</label>
            <select id="f-dp-driver">
                <option value="">-- 選択 --</option>
                ${availableDrivers.map(d => `<option value="${d.id}">${d.name} (${d.license_type}) [${d.status}]</option>`).join('')}
            </select>
        </div>
        <div class="form-group">
            <label>案件</label>
            <select id="f-dp-shipment">
                <option value="">-- 選択 --</option>
                ${unassigned.map(s => `<option value="${s.id}">${s.client_name}: ${s.pickup_address} → ${s.delivery_address}</option>`).join('')}
            </select>
        </div>
        <div class="form-group">
            <label>配車日</label>
            <input type="date" id="f-dp-date" value="${today}">
        </div>
        <div class="form-group">
            <label>備考</label>
            <textarea id="f-dp-notes"></textarea>
        </div>
        <div class="form-actions">
            <button class="btn" onclick="closeModal()">キャンセル</button>
            <button class="btn btn-primary" onclick="saveDispatch()">配車する</button>
        </div>`;
    showModal();
}

async function saveDispatch() {
    const data = {
        vehicle_id: parseInt(document.getElementById('f-dp-vehicle').value),
        driver_id: parseInt(document.getElementById('f-dp-driver').value),
        shipment_id: parseInt(document.getElementById('f-dp-shipment').value),
        date: document.getElementById('f-dp-date').value,
        notes: document.getElementById('f-dp-notes').value,
    };
    if (!data.vehicle_id || !data.driver_id || !data.shipment_id) {
        return alert('車両、ドライバー、案件を選択してください');
    }
    await apiPost('/dispatches', data);
    closeModal();
    loadDispatches();
}

async function completeDispatch(id) {
    if (!confirm('この配車を完了にしますか？')) return;
    await apiPut(`/dispatches/${id}`, { status: '完了' });
    loadDispatches();
}

async function deleteDispatch(id) {
    if (!confirm('この配車を削除しますか？')) return;
    await apiDelete(`/dispatches/${id}`);
    loadDispatches();
}

// ===== 地図 =====
function initMap() {
    if (!map) {
        map = L.map('map').setView([35.6812, 139.7671], 10);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors'
        }).addTo(map);
    }
    setTimeout(() => map.invalidateSize(), 100);
    loadMapMarkers();
}

async function loadMapMarkers() {
    // 配車中の案件をマーカー表示（デモ用に東京周辺のランダム座標）
    const dispatches = await apiGet('/dispatches');
    // 既存マーカーをクリア
    map.eachLayer(layer => {
        if (layer instanceof L.Marker) map.removeLayer(layer);
    });

    if (dispatches.length === 0) {
        L.marker([35.6812, 139.7671]).addTo(map)
            .bindPopup('<strong>配車データなし</strong><br>配車を作成するとここに表示されます')
            .openPopup();
        return;
    }

    dispatches.forEach((d, i) => {
        // 実際にはジオコーディングAPIで住所→座標変換が必要
        // デモとして東京周辺にランダム配置
        const lat = 35.6 + Math.random() * 0.3;
        const lng = 139.5 + Math.random() * 0.5;
        L.marker([lat, lng]).addTo(map)
            .bindPopup(`<strong>${d.driver_name}</strong><br>${d.vehicle_number}<br>${d.pickup_address} → ${d.delivery_address}<br>ステータス: ${d.status}`);
    });
}

// ===== 売上管理 =====
async function loadRevenue() {
    const data = await apiGet('/dashboard');
    const shipments = await apiGet('/shipments');
    const completed = shipments.filter(s => s.status === '完了');

    document.getElementById('rev-monthly').textContent = `¥${data.monthly_revenue.toLocaleString()}`;
    document.getElementById('rev-completed').textContent = data.monthly_completed;
    const avg = data.monthly_completed > 0 ? Math.round(data.monthly_revenue / data.monthly_completed) : 0;
    document.getElementById('rev-avg').textContent = `¥${avg.toLocaleString()}`;

    document.getElementById('revenue-table').innerHTML = completed.map(s => `
        <tr>
            <td>${s.client_name}</td>
            <td>${s.cargo_description || '-'}</td>
            <td>${s.pickup_address} → ${s.delivery_address}</td>
            <td>${s.delivery_date}</td>
            <td><strong>¥${s.price.toLocaleString()}</strong></td>
        </tr>
    `).join('') || '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:40px">完了済み案件がありません</td></tr>';
}

// ===== 日報 =====
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
            <td>
                <button class="btn btn-sm btn-danger" onclick="deleteReport(${r.id})">削除</button>
            </td>
        </tr>
    `).join('') || '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:40px">日報がありません</td></tr>';
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
        <div class="form-group">
            <label>日付</label>
            <input type="date" id="f-r-date" value="${today}">
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>出発時刻</label>
                <input type="time" id="f-r-start">
            </div>
            <div class="form-group">
                <label>帰着時刻</label>
                <input type="time" id="f-r-end">
            </div>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>走行距離(km)</label>
                <input type="number" id="f-r-distance" value="0" step="0.1">
            </div>
            <div class="form-group">
                <label>給油量(L)</label>
                <input type="number" id="f-r-fuel" value="0" step="0.1">
            </div>
        </div>
        <div class="form-group">
            <label>備考</label>
            <textarea id="f-r-notes"></textarea>
        </div>
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
    await apiPost('/reports', data);
    closeModal();
    loadReports();
}

async function deleteReport(id) {
    if (!confirm('この日報を削除しますか？')) return;
    await apiDelete(`/reports/${id}`);
    loadReports();
}

// ===== ステータスバッジ =====
function statusBadge(status) {
    const colors = {
        '空車': 'green', '稼働中': 'blue', '整備中': 'orange',
        '待機中': 'green', '運行中': 'blue', '休憩中': 'orange', '非番': 'gray',
        '未配車': 'orange', '配車済': 'blue', '完了': 'green', 'キャンセル': 'red',
        '予定': 'purple',
    };
    return `<span class="badge badge-${colors[status] || 'gray'}">${status}</span>`;
}

// ===== モーダル =====
function showModal() {
    document.getElementById('modal-overlay').classList.add('active');
}

function closeModal() {
    document.getElementById('modal-overlay').classList.remove('active');
}
