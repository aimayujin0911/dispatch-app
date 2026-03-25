/**
 * トランシア テナント固有 マトリクスビュー
 * - マトリクス表示の全機能（描画、ナビゲーション、D&D、モーダル等）
 * - マトリクス表示ボタン（ガントビューのコントロールに追加）
 * - 課ごとの絞り込みフィルタ
 *
 * Core の app.js から参照する共通関数:
 *   cachedApiGet, apiGet, apiPost, apiPut, apiDelete, invalidateCache,
 *   isToday, fmt, isMobile, getDriverColor, loadDispatchCalendar,
 *   showToast, showModal, closeModal, isShipmentForDate, openQuickShipmentModal,
 *   openQuickDispatchModal, autoDispatch, justDragged
 *
 * Core の app.js に残るグローバル変数:
 *   showAllUnassigned (ガントビューでも使用)
 */

// ===== マトリクスビュー グローバル変数 =====
window._matrixMonthStart = null;      // マトリクスビューの月開始日
window._matrixUnassignedDate = null;  // マトリクス未配車パネルの選択日付
window._matrixDragData = null;        // マトリクスD&Dデータ
window._matrixScrollReset = false;    // 月変更時のスクロールリセットフラグ
window._matrixSavedScrollTop = 0;     // スクロール位置保存
window._matrixSavedScrollLeft = 0;    // スクロール位置保存

// 時間帯定義: 1マス=2時間、8時開始（8-20時の業務時間帯）
const MATRIX_PERIODS = [
    { startH: 8, endH: 10 },
    { startH: 10, endH: 12 },
    { startH: 12, endH: 14 },
    { startH: 14, endH: 16 },
    { startH: 16, endH: 18 },
    { startH: 18, endH: 20 },
];

function getTimePeriodIndex(timeStr) {
    if (!timeStr) return 0; // デフォルト8時（スロット0）
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

// ===== ガントビュー用フック =====

// ガントビューのコントロールにマトリクス切替ボタンを追加
window._tenantDispatchButtons = function() {
    return '<button class="btn btn-sm" onclick="toggleDispatchViewMode()" style="background:#ea580c;color:#fff;font-weight:600;margin-left:8px" title="マトリクス表示に切替">マトリクス表示</button>';
};

// マトリクスビューのコントロールに課フィルタを追加
window._tenantMatrixControls = function() {
    const current = localStorage.getItem('matrixDeptFilter') || '';
    const depts = ['1課', '2課', '3課', '4課', '5課'];
    let html = '<select class="select transia-dept-filter" onchange="setMatrixDeptFilter(this.value)" style="font-size:0.8rem;padding:2px 6px">';
    html += `<option value=""${!current ? ' selected' : ''}>全課</option>`;
    depts.forEach(d => {
        html += `<option value="${d}"${current === d ? ' selected' : ''}>${d}</option>`;
    });
    html += '</select>';
    return html;
};

// 課フィルタでマトリクスの車両を絞り込み
window._tenantFilterVehicles = function(vehicles) {
    const dept = localStorage.getItem('matrixDeptFilter') || '';
    if (!dept) return vehicles;
    return vehicles.filter(v => v.department === dept);
};

// 課フィルタの値変更ハンドラ
window.setMatrixDeptFilter = function(dept) {
    localStorage.setItem('matrixDeptFilter', dept);
    if (typeof loadDispatchCalendar === 'function') {
        loadDispatchCalendar();
    }
};

// ===== ビュー切替 =====

function toggleDispatchViewMode() {
    const current = localStorage.getItem('dispatchViewMode') || 'gantt';
    localStorage.setItem('dispatchViewMode', current === 'matrix' ? 'gantt' : 'matrix');
    loadDispatchCalendar();
}

// ===== 月ナビゲーション =====

function matrixChangeMonth(dir) {
    if (!window._matrixMonthStart) window._matrixMonthStart = new Date();
    // setDate(1)を先に呼ぶ: 31日→2月のように日数オーバーフローで月がズレるのを防止
    window._matrixMonthStart.setDate(1);
    window._matrixMonthStart.setMonth(window._matrixMonthStart.getMonth() + dir);
    // 月変更時: 未配車パネルの日付もその月の1日にリセット
    window._matrixUnassignedDate = fmt(window._matrixMonthStart);
    window._matrixScrollReset = true;
    loadDispatchCalendar();
}

function matrixGoToday() {
    window._matrixMonthStart = new Date();
    window._matrixMonthStart.setDate(1);
    // 今月に戻る: 未配車パネルも今日にリセット
    window._matrixUnassignedDate = fmt(new Date());
    window._matrixScrollReset = true;
    loadDispatchCalendar();
}

function matrixSelectMonth(value) {
    // value is "YYYY-MM" from <input type="month">
    if (!value) return;
    const [y, m] = value.split('-').map(Number);
    window._matrixMonthStart = new Date(y, m - 1, 1);
    // 年月ピッカー選択時: 未配車パネルもその月の1日にリセット
    window._matrixUnassignedDate = fmt(window._matrixMonthStart);
    window._matrixScrollReset = true;
    loadDispatchCalendar();
}

// Legacy alias for week navigation (unused but kept for safety)
function matrixChangeWeek(dir) { matrixChangeMonth(dir > 0 ? 1 : -1); }

// ===== ドライバー選択ドロップダウン =====

function openDriverDropdown(event, vehicleId) {
    event.stopPropagation();
    closeDriverDropdown();

    const cell = event.currentTarget;
    const currentDriverId = cell.getAttribute('data-driver-id') || '';

    cachedApiGet('/drivers').then(drivers => {
        const dropdown = document.createElement('div');
        dropdown.className = 'matrix-driver-dropdown';
        dropdown.id = 'matrix-driver-dropdown';

        // 検索入力欄
        const searchBox = document.createElement('input');
        searchBox.type = 'text';
        searchBox.className = 'matrix-driver-search';
        searchBox.placeholder = '名前で検索…';
        searchBox.onclick = (e) => e.stopPropagation();
        dropdown.appendChild(searchBox);

        // ドライバーリストコンテナ
        const listContainer = document.createElement('div');
        listContainer.className = 'matrix-driver-list';
        dropdown.appendChild(listContainer);

        function renderList(query) {
            listContainer.innerHTML = '';
            const q = (query || '').trim().toLowerCase();

            // 「なし」オプション
            if (!q || '（なし）'.includes(q) || 'なし'.includes(q)) {
                const noneItem = document.createElement('div');
                noneItem.className = 'matrix-driver-dropdown-item' + (!currentDriverId ? ' selected' : '');
                noneItem.textContent = '（なし）';
                noneItem.onclick = (e) => { e.stopPropagation(); selectDriver(vehicleId, null, cell); };
                listContainer.appendChild(noneItem);
            }

            const filtered = q ? drivers.filter(d => d.name.toLowerCase().includes(q)) : drivers;
            filtered.forEach(d => {
                const item = document.createElement('div');
                item.className = 'matrix-driver-dropdown-item' + (String(d.id) === String(currentDriverId) ? ' selected' : '');
                // マッチ部分をハイライト
                if (q && d.name.toLowerCase().includes(q)) {
                    const idx = d.name.toLowerCase().indexOf(q);
                    item.innerHTML = d.name.substring(0, idx) +
                        `<strong style="color:#ea580c">${d.name.substring(idx, idx + q.length)}</strong>` +
                        d.name.substring(idx + q.length);
                } else {
                    item.textContent = d.name;
                }
                item.onclick = (e) => { e.stopPropagation(); selectDriver(vehicleId, d.id, cell, d.name); };
                listContainer.appendChild(item);
            });

            if (filtered.length === 0 && q) {
                const noResult = document.createElement('div');
                noResult.className = 'matrix-driver-dropdown-item';
                noResult.style.color = '#94a3b8';
                noResult.style.fontStyle = 'italic';
                noResult.textContent = '該当なし';
                listContainer.appendChild(noResult);
            }
        }

        searchBox.addEventListener('input', () => renderList(searchBox.value));
        renderList(''); // 初期表示

        // 配置
        const rect = cell.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.left = rect.left + 'px';
        dropdown.style.top = (rect.bottom + 2) + 'px';
        dropdown.style.minWidth = Math.max(rect.width, 180) + 'px';

        document.body.appendChild(dropdown);

        // 画面外調整
        const dropRect = dropdown.getBoundingClientRect();
        if (dropRect.bottom > window.innerHeight) {
            dropdown.style.top = (rect.top - dropRect.height - 2) + 'px';
        }
        if (dropRect.right > window.innerWidth) {
            dropdown.style.left = (window.innerWidth - dropRect.width - 8) + 'px';
        }

        // フォーカスを検索欄に
        setTimeout(() => {
            searchBox.focus();
            document.addEventListener('click', _closeDriverDropdownOnClick);
            document.addEventListener('keydown', _closeDriverDropdownOnEsc);
        }, 0);
    });
}

function closeDriverDropdown() {
    const existing = document.getElementById('matrix-driver-dropdown');
    if (existing) existing.remove();
    document.removeEventListener('click', _closeDriverDropdownOnClick);
    document.removeEventListener('keydown', _closeDriverDropdownOnEsc);
}

function _closeDriverDropdownOnClick() {
    closeDriverDropdown();
}

function _closeDriverDropdownOnEsc(e) {
    if (e.key === 'Escape') closeDriverDropdown();
}

async function selectDriver(vehicleId, driverId, cell, driverName) {
    closeDriverDropdown();
    try {
        await apiPut(`/vehicles/${vehicleId}`, { default_driver_id: driverId });
        // セルのテキストとdata属性を更新
        cell.textContent = driverName || '\u00A0';
        cell.setAttribute('data-driver-id', driverId || '');
        // キャッシュを無効化して次回の取得で最新データを使う
        invalidateCache('/vehicles');
    } catch (err) {
        alert('ドライバー更新に失敗しました: ' + (err.message || err));
    }
}

// ===== マトリクス未配車パネル =====

async function renderMatrixUnassignedPanel(ignoredShipments, dispatches) {
    // デフォルトは今日の日付
    if (!window._matrixUnassignedDate) window._matrixUnassignedDate = fmt(new Date());
    const dateStr = window._matrixUnassignedDate;

    // 未配車案件をAPIから効率的に取得（ステータス=未配車のみ、上限200件）
    let shipments;
    if (_cache['_unassignedShipments']?.ts > Date.now() - 30000) {
        shipments = _cache['_unassignedShipments'].data;
    } else {
        shipments = await apiGet('/shipments?status=未配車&limit=200');
        _cache['_unassignedShipments'] = { data: shipments, ts: Date.now() };
    }

    // 全件モード: 全案件を表示（ステータス=未配車のものはAPI側でフィルタ済み）
    // 日付モード: その日付に該当する案件のみ、配車済みを除外
    let unassigned;
    if (showAllUnassigned) {
        unassigned = shipments; // API側でstatus=未配車フィルタ済み
    } else {
        const dispatchedIds = new Set(dispatches.filter(d => d.date === dateStr).map(d => d.shipment_id));
        unassigned = shipments.filter(s => {
            if (!isShipmentForDate(s, dateStr)) return false;
            return !dispatchedIds.has(s.id);
        });
    }
    const totalAvailable = shipments.length;

    const panel = document.getElementById('matrix-unassigned-panel');
    if (!panel) return;

    // 日付セレクター + 未配車一覧を生成
    const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
    const selDate = new Date(dateStr + 'T00:00:00');
    const dateLabel = `${selDate.getFullYear()}年${selDate.getMonth() + 1}月${selDate.getDate()}日(${dayNames[selDate.getDay()]})`;

    const mToggleLabel = showAllUnassigned ? '日付で絞る' : `全件(${totalAvailable})`;
    const mToggleStyle = showAllUnassigned
        ? 'background:#2563eb;color:#fff;font-weight:600;font-size:0.75rem;padding:2px 10px'
        : 'background:#e5e7eb;color:#374151;font-size:0.75rem;padding:2px 10px';
    let html = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap">
        <h3 style="margin:0;display:flex;align-items:center;gap:8px">📦 未配車案件</h3>
        <div style="display:flex;align-items:center;gap:6px">
            <button class="btn btn-sm" onclick="changeMatrixUnassignedDate(-1)" title="前日">◀</button>
            <input type="date" class="input-date" value="${dateStr}" onchange="updateMatrixUnassignedDate(this.value)" style="width:150px">
            <button class="btn btn-sm" onclick="changeMatrixUnassignedDate(1)" title="翌日">▶</button>
            <button class="btn btn-sm" onclick="updateMatrixUnassignedDate(fmt(new Date()))">今日</button>
        </div>
        <span style="font-size:0.9rem;font-weight:600;color:var(--text-dark,#1e293b)">${dateLabel}</span>
        <span style="font-size:0.85rem;color:var(--text-light,#64748b)">(${unassigned.length}件)</span>
        <div style="display:flex;gap:6px;margin-left:auto">
            <button class="btn btn-sm" onclick="toggleShowAllUnassigned()" style="${mToggleStyle};border-radius:4px">${mToggleLabel}</button>
            <button class="btn btn-sm btn-primary" onclick="openQuickShipmentModal('${dateStr}')" style="font-size:0.75rem;padding:2px 10px">＋ 案件追加</button>
            ${unassigned.length > 0 ? `<button class="btn btn-sm" onclick="autoDispatch('${dateStr}')" style="background:#ea580c;color:#fff;font-weight:600;font-size:0.75rem;padding:2px 10px">⚡ 自動配車</button>` : ''}
        </div>
    </div>`;

    // 表示件数制限（パフォーマンス対策）
    const MAX_DISPLAY = 50;
    const displayItems = unassigned.slice(0, MAX_DISPLAY);
    const hasMore = unassigned.length > MAX_DISPLAY;

    if (unassigned.length > 0) {
        html += `<div class="unassigned-list">`;
        displayItems.forEach(s => {
            const freqLabel = s.frequency_type === '単発' ? '' : s.frequency_type === '毎日' ? ' 🔁毎日' : ` 🔁${s.frequency_days}`;
            const cargoDesc = s.cargo_description ? `<span style="font-size:0.78rem;color:#6b7280">${s.cargo_description}</span>` : '';
            const weightDesc = s.weight > 0 ? `<span style="font-size:0.78rem;color:#6b7280">${s.weight}kg</span>` : '';
            const timeStr = s.pickup_time || s.delivery_time
                ? `<span style="color:#1d4ed8;font-weight:700;white-space:nowrap">${s.pickup_time || '?'}→${s.delivery_time || '?'}</span>`
                : (s.time_note ? `<span style="color:#6b7280;white-space:nowrap">${s.time_note}</span>` : '');
            html += `<div class="unassigned-item" draggable="true" ondragstart="matrixUnassignedDragStart(event,${s.id})" ondragend="matrixUnassignedDragEnd(event)" onclick="openQuickDispatchModal('${dateStr}','08:00','17:00', null, ${s.id})">
                <div style="display:flex;flex-direction:column;gap:1px;min-width:0;flex:1;overflow:hidden">
                    <div style="display:flex;justify-content:space-between;align-items:center;gap:4px">
                        <strong style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.name || s.client_name}${freqLabel}</strong>
                        ${timeStr}
                    </div>
                    <div style="font-size:0.7rem;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.pickup_address} → ${s.delivery_address}</div>
                    <div style="display:flex;gap:4px;align-items:center">
                        ${cargoDesc}${weightDesc}
                        <span style="margin-left:auto;font-size:0.7rem">¥${s.price.toLocaleString()}</span>
                    </div>
                </div>
            </div>`;
        });
        if (hasMore) {
            html += `<div style="text-align:center;padding:8px"><span style="color:var(--text-light);font-size:0.8rem">他 ${unassigned.length - MAX_DISPLAY}件... 案件管理で全件表示</span></div>`;
        }
        html += `</div>`;
    } else {
        html += `<p style="color:var(--text-light);font-size:0.85rem">この日の未配車案件はありません ✅</p>`;
    }

    panel.innerHTML = html;
}

// マトリクス未配車パネルの日付変更（前日/翌日ボタン用）
function changeMatrixUnassignedDate(dir) {
    if (!window._matrixUnassignedDate) window._matrixUnassignedDate = fmt(new Date());
    const d = new Date(window._matrixUnassignedDate + 'T00:00:00');
    d.setDate(d.getDate() + dir);
    window._matrixUnassignedDate = fmt(d);
    refreshMatrixUnassignedPanel();
}

// マトリクス未配車パネルの日付を直接設定
function updateMatrixUnassignedDate(dateStr) {
    if (!dateStr) return;
    window._matrixUnassignedDate = dateStr;
    refreshMatrixUnassignedPanel();
}

// マトリクス未配車パネルのみ再描画（テーブル全体の再描画は不要）
async function refreshMatrixUnassignedPanel() {
    const dateStr = window._matrixUnassignedDate || fmt(new Date());
    // 未配車キャッシュをクリアして最新を取得
    delete _cache['_unassignedShipments'];
    const dispatches = await apiGet(`/dispatches?date_from=${dateStr}&date_to=${dateStr}`);
    renderMatrixUnassignedPanel([], dispatches);
}

// ===== 車両詳細ツールチップ =====

let _vehicleTooltipTimer = null;
function showVehicleTooltip(e, vehicleId) {
    // 非表示タイマーをキャンセル
    if (_vehicleTooltipTimer) { clearTimeout(_vehicleTooltipTimer); _vehicleTooltipTimer = null; }
    // 既存ツールチップを削除
    const old = document.querySelector('.matrix-vehicle-tooltip');
    if (old) old.remove();
    // 車両データ取得
    cachedApiGet('/vehicles').then(vehicles => {
        const v = vehicles.find(x => x.id === vehicleId);
        if (!v) return;
        const tip = document.createElement('div');
        tip.className = 'matrix-vehicle-tooltip';
        const inspDate = v.inspection_expiry || '未設定';
        const tempZone = v.temperature_zone || '常温';
        const pg = v.has_power_gate ? 'あり' : 'なし';
        const notes = v.notes || '';
        const dept = v.department || '';
        tip.innerHTML = `
            <div class="mvt-title">${v.number}</div>
            ${dept ? `<div class="mvt-row"><span class="mvt-label">課:</span> ${dept}</div>` : ''}
            <div class="mvt-row"><span class="mvt-label">車種:</span> ${v.type || '-'}</div>
            <div class="mvt-row"><span class="mvt-label">積載量:</span> ${v.capacity || '-'}t</div>
            <div class="mvt-row"><span class="mvt-label">温度帯:</span> ${tempZone}</div>
            <div class="mvt-row"><span class="mvt-label">パワーゲート:</span> ${pg}</div>
            <div class="mvt-row"><span class="mvt-label">車検日:</span> ${inspDate}</div>
            ${notes ? `<div class="mvt-row"><span class="mvt-label">備考:</span> ${notes}</div>` : ''}
        `;
        // ツールチップ上のホバーでタイマーキャンセル
        tip.addEventListener('mouseenter', () => { if (_vehicleTooltipTimer) { clearTimeout(_vehicleTooltipTimer); _vehicleTooltipTimer = null; } });
        tip.addEventListener('mouseleave', () => { hideVehicleTooltip(); });
        document.body.appendChild(tip);
        // 位置決定
        const rect = e.target.closest('.matrix-vehicle-col-header').getBoundingClientRect();
        tip.style.top = (rect.bottom + 4) + 'px';
        tip.style.left = Math.max(4, rect.left) + 'px';
    });
}
function hideVehicleTooltip() {
    if (_vehicleTooltipTimer) clearTimeout(_vehicleTooltipTimer);
    _vehicleTooltipTimer = setTimeout(() => {
        const tip = document.querySelector('.matrix-vehicle-tooltip');
        if (tip) tip.remove();
        _vehicleTooltipTimer = null;
    }, 150);
}

// ===== マトリクスD&D =====

function matrixDragStart(e, dispatchId, vehicleId, dateStr, periodIdx) {
    window._matrixDragData = { dispatchId, vehicleId, dateStr, periodIdx };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dispatchId));
    e.target.closest('.matrix-dispatch-item').style.opacity = '0.4';
}

function matrixDragEnd(e) {
    e.target.closest('.matrix-dispatch-item').style.opacity = '1';
    window._matrixDragData = null;
}

// 未配車案件のD&D開始
function matrixUnassignedDragStart(e, shipmentId) {
    window._matrixDragData = { shipmentId, isUnassigned: true };
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', 'shipment_' + shipmentId);
    e.target.closest('.unassigned-item').style.opacity = '0.4';
}

function matrixUnassignedDragEnd(e) {
    e.target.closest('.unassigned-item').style.opacity = '1';
    window._matrixDragData = null;
}

function matrixDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = (window._matrixDragData && window._matrixDragData.isUnassigned) ? 'copy' : 'move';
    // スロット単位でハイライト
    const slot = e.target.closest('.matrix-slot');
    if (slot) {
        slot.classList.add('matrix-drop-target');
    } else {
        const cell = e.target.closest('.matrix-cell-t, .matrix-cell, .matrix-empty-cell');
        if (cell) cell.classList.add('matrix-drop-target');
    }
}

function matrixDragLeave(e) {
    const slot = e.target.closest('.matrix-slot');
    if (slot) {
        slot.classList.remove('matrix-drop-target');
    } else {
        const cell = e.target.closest('.matrix-cell-t, .matrix-cell, .matrix-empty-cell');
        if (cell) cell.classList.remove('matrix-drop-target');
    }
}

// 動的スロット: セル内の既存配車から、ドロップ先スロットの時刻を算出
function calcSlotTime(existingDispatches, targetSlotIdx) {
    // 既存配車をスロット位置順にマップ
    // 各配車は ceil(duration/2) スロット占有
    let nextFreeTime = 8; // デフォルト開始8時
    let slotCursor = 0;

    const sorted = [...existingDispatches].sort((a, b) => (a.start_time || '08:00').localeCompare(b.start_time || '08:00'));
    for (const d of sorted) {
        const dStartH = parseInt((d.start_time || '08:00').split(':')[0]);
        const dEndH = parseInt((d.end_time || '12:00').split(':')[0]) || (dStartH + 4);
        const dSlots = Math.max(1, Math.ceil((dEndH - dStartH) / 2));

        // この配車の前に空きスロットがある場合
        if (dStartH > nextFreeTime) {
            const gapSlots = Math.ceil((dStartH - nextFreeTime) / 2);
            if (slotCursor + gapSlots > targetSlotIdx) {
                // ターゲットはこの空きの中
                return nextFreeTime + (targetSlotIdx - slotCursor) * 2;
            }
            slotCursor += gapSlots;
        }

        // この配車が占有するスロット
        if (slotCursor + dSlots > targetSlotIdx) {
            // ターゲットはこの配車の占有内（既に埋まっている）
            return null;
        }
        slotCursor += dSlots;
        nextFreeTime = dEndH;
    }

    // 残りの空きスロット
    return nextFreeTime + (targetSlotIdx - slotCursor) * 2;
}

async function matrixDrop(e, targetVehicleId, targetDateStr, targetPeriodIdx) {
    e.preventDefault();
    const cell = e.target.closest('.matrix-cell-t, .matrix-cell, .matrix-empty-cell');
    if (cell) cell.classList.remove('matrix-drop-target');
    if (!window._matrixDragData) return;

    // 未配車案件のドロップ → 新規配車作成
    if (window._matrixDragData.isUnassigned) {
        const shipmentId = window._matrixDragData.shipmentId;
        window._matrixDragData = null;
        try {
            const vehicles = await cachedApiGet('/vehicles');
            const vehicle = vehicles.find(v => v.id === targetVehicleId);
            const driverId = vehicle ? vehicle.default_driver_id : null;

            // 同セルの既存配車を取得
            const ld = window._matrixLazyData;
            const existingDispatches = ld?.dispatchIndex?.[targetVehicleId + '-' + targetDateStr] || [];

            // 案件情報を未配車キャッシュまたは個別APIから取得
            const unassignedCache = _cache['_unassignedShipments']?.data || [];
            let shipment = unassignedCache.find(s => s.id === shipmentId);
            if (!shipment) {
                try { shipment = await apiGet('/shipments/' + shipmentId); } catch(e) { shipment = null; }
            }

            // 日付チェック: 案件に指定日がある場合、配車先の日付と一致するか確認
            if (shipment) {
                const sDate = shipment.pickup_date || shipment.delivery_date;
                if (sDate && sDate !== '2025-12-31' && sDate !== targetDateStr) {
                    const ok = confirm(`⚠️ 日付が異なります\n\n案件の指定日: ${sDate}\n配車先の日付: ${targetDateStr}\n\nこのまま配車しますか？`);
                    if (!ok) return;
                }
            }

            // 案件自身の時刻情報を確認
            let startH, endH;

            if (shipment?.pickup_time && shipment.pickup_time !== '00:00') {
                // 案件に時刻指定あり → その時刻を使用
                startH = parseInt(shipment.pickup_time.split(':')[0]);
                endH = shipment.delivery_time ? parseInt(shipment.delivery_time.split(':')[0]) : (startH + 4);
            } else {
                // 時刻指定なし → スロット位置から動的に算出
                const slotTime = calcSlotTime(existingDispatches, targetPeriodIdx);
                if (slotTime === null) {
                    alert('このスロットは既に配車で埋まっています。別のスロットにドロップしてください。');
                    return;
                }
                startH = slotTime;
                endH = startH + 4; // デフォルト2スロット=4時間
            }
            if (endH > 24) endH = 24;
            const newStart = String(startH).padStart(2, '0') + ':00';
            const newEnd = String(endH === 24 ? 23 : endH).padStart(2, '0') + (endH === 24 ? ':59' : ':00');

            // 時系列チェック: 既存配車との前後関係
            if (existingDispatches.length > 0) {
                const sorted = [...existingDispatches].sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
                // 新しい配車の位置（スロット順）で、時刻が前後逆になるケースを検出
                const prevDispatch = sorted.filter(d => {
                    const dIdx = getTimePeriodIndex(d.start_time);
                    return dIdx < targetPeriodIdx;
                }).pop();
                const nextDispatch = sorted.find(d => {
                    const dIdx = getTimePeriodIndex(d.start_time);
                    return dIdx > targetPeriodIdx;
                });

                let conflict = false;
                let conflictMsg = '';
                if (prevDispatch && parseInt((prevDispatch.start_time || '0').split(':')[0]) > startH) {
                    conflict = true;
                    conflictMsg = `上のスロットに${prevDispatch.start_time}開始の配車がありますが、今回の配車は${newStart}開始です。`;
                }
                if (nextDispatch && parseInt((nextDispatch.start_time || '0').split(':')[0]) < startH) {
                    conflict = true;
                    conflictMsg = `下のスロットに${nextDispatch.start_time}開始の配車がありますが、今回の配車は${newStart}開始です。`;
                }

                if (conflict) {
                    const action = confirm(`⚠️ 時間の前後が逆になっています\n\n${conflictMsg}\n\n正しい前後関係に並べ替えますか？\n\n[OK] → 時刻順に並べ替え\n[キャンセル] → 未配車に戻す`);
                    if (!action) return; // 未配車に戻す（配車作成しない）
                    // OK → 配車を作成してからリロード（時刻順で自動再配置）
                }
            }

            const postData = {
                shipment_id: shipmentId,
                vehicle_id: targetVehicleId,
                date: targetDateStr,
                start_time: newStart,
                end_time: newEnd,
            };
            if (driverId) postData.driver_id = driverId;

            // 楽観的UI更新: API応答を待たずにUIを即座に更新
            const tempItem = _matrixInsertOptimisticItem(cell, targetPeriodIdx, shipment, newStart, newEnd);

            // APIをバックグラウンドで実行
            apiPost('/dispatches', postData).then(() => {
                invalidateCache();
                loadDispatchCalendar();
            }).catch(err => {
                console.error('Matrix D&D dispatch failed:', err);
                // 失敗時: 仮アイテムを削除してエラー表示
                if (tempItem && tempItem.parentNode) tempItem.remove();
                if (typeof showToast === 'function') {
                    showToast('配車作成に失敗しました: ' + (err.message || err), 'error');
                } else {
                    alert('配車作成に失敗しました: ' + (err.message || err));
                }
                loadDispatchCalendar();
            });
        } catch (err) {
            console.error('Matrix D&D dispatch failed:', err);
            alert('配車作成に失敗しました: ' + (err.message || err));
            loadDispatchCalendar();
        }
        return;
    }

    // 既存配車の移動
    const { dispatchId, vehicleId, dateStr, periodIdx } = window._matrixDragData;
    window._matrixDragData = null;
    // 同じセルならスキップ
    if (vehicleId === targetVehicleId && dateStr === targetDateStr && periodIdx === targetPeriodIdx) return;

    // ドロップ先のスロット時刻を算出
    const targetPeriod = MATRIX_PERIODS[targetPeriodIdx];
    const moveStart = String(targetPeriod.startH).padStart(2, '0') + ':00';
    const moveEndH = targetPeriod.endH === 24 ? 23 : targetPeriod.endH;
    const moveEnd = String(moveEndH).padStart(2, '0') + (targetPeriod.endH === 24 ? ':59' : ':00');

    // 楽観的UI更新: 元の配車アイテムを半透明にしてローディング表示
    const draggedItem = document.querySelector(`.matrix-dispatch-item[data-dispatch-id="${dispatchId}"]`);
    if (draggedItem) draggedItem.style.opacity = '0.3';
    const tempItem = _matrixInsertOptimisticItem(cell, targetPeriodIdx, null, moveStart, moveEnd);

    apiPut('/dispatches/' + dispatchId, {
        vehicle_id: targetVehicleId,
        date: targetDateStr,
        start_time: moveStart,
        end_time: moveEnd,
    }).then(() => {
        invalidateCache();
        loadDispatchCalendar();
    }).catch(err => {
        console.error('Matrix D&D update failed:', err);
        // 失敗時: 仮アイテムを削除、元アイテムを復元
        if (tempItem && tempItem.parentNode) tempItem.remove();
        if (draggedItem) draggedItem.style.opacity = '1';
        if (typeof showToast === 'function') {
            showToast('配車移動に失敗しました: ' + (err.message || err), 'error');
        }
        loadDispatchCalendar();
    });
}

// 楽観的UI更新: ドロップ先セルに仮の配車アイテムを即座に挿入
function _matrixInsertOptimisticItem(cell, periodIdx, shipment, startTime, endTime) {
    if (!cell) return null;
    const slotsContainer = cell.querySelector('.matrix-slots');
    if (!slotsContainer) return null;

    const CELL_H = 132, SLOT_H = CELL_H / 6;
    const startH = parseInt(startTime.split(':')[0]);
    const endH = parseInt(endTime.split(':')[0]) || (startH + 4);
    const spanSlots = Math.max(1, Math.ceil((endH - startH) / 2));
    const topPx = Math.round(periodIdx * SLOT_H);
    const heightPx = Math.max(Math.round(spanSlots * SLOT_H) - 1, SLOT_H - 1);

    const label = shipment
        ? (shipment.name || shipment.client_name || '配車中...')
        : '移動中...';

    const item = document.createElement('div');
    item.className = 'matrix-dispatch-item matrix-dispatch-abs';
    item.style.cssText = `top:${topPx}px;height:${heightPx}px;border-left-color:#f97316;background:#fff7ed;opacity:0.7`;
    item.innerHTML = `<div class="matrix-dispatch-route" style="color:#ea580c">${label}</div>
        <div class="matrix-dispatch-area" style="color:#f97316">⏳ 保存中...</div>`;
    slotsContainer.appendChild(item);
    return item;
}

// ===== メインのマトリクスビュー描画 =====

async function renderMatrixView(calContainer, dispatches, allVehicles, shipments, partners, filteredVehicles, baseDate) {
    // 月の開始日
    if (!window._matrixMonthStart) {
        window._matrixMonthStart = new Date(baseDate);
        window._matrixMonthStart.setDate(1);
    }
    const monthStart = new Date(window._matrixMonthStart);
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
    // キャッシュに月間配車データを保存（未配車パネル等で再利用）
    _cache['_lastDispatches'] = { data: rangeDispatches, ts: Date.now() };

    // ===== パフォーマンス最適化: ルックアップ用インデックス構築 =====
    // shipmentMap: shipment_id → shipment（O(1)検索、inner loopの.find()を除去）
    const shipmentMap = {};
    for (let i = 0; i < shipments.length; i++) {
        shipmentMap[shipments[i].id] = shipments[i];
    }

    // dispatchIndex: "vehicleId-dateStr" → 配車リスト（O(1)セル検索、inner loopの.filter()を除去）
    const dispatchIndex = {};
    for (let i = 0; i < rangeDispatches.length; i++) {
        const d = rangeDispatches[i];
        const key = d.vehicle_id + '-' + d.date;
        if (!dispatchIndex[key]) dispatchIndex[key] = [];
        dispatchIndex[key].push(d);
    }
    // 各セルの配車リストをstart_timeでソート
    for (const key in dispatchIndex) {
        dispatchIndex[key].sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
    }

    // ドライバー情報を取得
    const drivers = await cachedApiGet('/drivers');
    const driverMap = {};
    drivers.forEach(d => { driverMap[d.id] = d; });

    // 車両ごとのドライバー名を決定（dispatchIndexを活用）
    const vehicleDriverNames = {};
    const vehicleDriverIds = {};
    filteredVehicles.forEach(v => {
        let driverName = '';
        let driverId = null;
        if (v.default_driver_id && driverMap[v.default_driver_id]) {
            driverName = driverMap[v.default_driver_id].name;
            driverId = v.default_driver_id;
        } else {
            // dispatchIndexから該当車両の配車を探す（最新日付の最後の配車を使用）
            for (let di = matrixDayStrs.length - 1; di >= 0; di--) {
                const dList = dispatchIndex[v.id + '-' + matrixDayStrs[di]];
                if (dList) {
                    for (let j = dList.length - 1; j >= 0; j--) {
                        if (dList[j].driver_name) {
                            driverName = dList[j].driver_name;
                            driverId = dList[j].driver_id;
                            break;
                        }
                    }
                    if (driverName) break;
                }
            }
        }
        vehicleDriverNames[v.id] = driverName;
        vehicleDriverIds[v.id] = driverId;
    });

    // 月ラベル
    const monthLabel = `${monthStart.getFullYear()}年${monthStart.getMonth() + 1}月`;

    // コントロール部分 — 年月ピッカー付き
    const monthValue = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}`;
    let controlsHtml = isMobile() ? `
        <div class="m-cal-controls">
            <div class="m-cal-row">
                <button class="m-cal-btn" onclick="matrixChangeMonth(-1)">◀</button>
                <input type="month" class="m-cal-select" value="${monthValue}" onchange="matrixSelectMonth(this.value)" style="max-width:120px;font-size:0.7rem">
                <button class="m-cal-btn" onclick="matrixChangeMonth(1)">▶</button>
                <button class="m-cal-btn" onclick="matrixGoToday()">今月</button>
                <span style="font-size:0.8rem;font-weight:700;color:var(--text-dark,#1e293b);white-space:nowrap">${monthLabel}</span>
            </div>
            <div class="m-cal-row" style="margin-top:2px;gap:4px">
                ${window._tenantMatrixControls ? window._tenantMatrixControls() : ''}
                <button class="m-cal-btn" onclick="toggleDispatchViewMode()" style="background:#ea580c;color:#fff;font-weight:600;font-size:0.65rem">ガントに切替</button>
            </div>
        </div>` : `
        <div class="cal-controls" style="gap:8px">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:nowrap">
                <button class="btn btn-sm" onclick="matrixChangeMonth(-1)" title="前月">◀</button>
                <input type="month" class="input-date" value="${monthValue}" onchange="matrixSelectMonth(this.value)" title="年月を選択" style="width:160px;font-size:0.9rem">
                <button class="btn btn-sm" onclick="matrixChangeMonth(1)" title="翌月">▶</button>
                <button class="btn btn-sm" onclick="matrixGoToday()">今月</button>
                <span style="font-size:1.1rem;font-weight:700;margin:0 4px;color:var(--text-dark,#1e293b);white-space:nowrap">${monthLabel}</span>
            </div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:nowrap;margin-left:auto">
                ${window._tenantMatrixControls ? window._tenantMatrixControls() : ''}
                <button class="btn btn-sm" onclick="toggleDispatchViewMode()" style="background:#ea580c;color:#fff;font-weight:600">ガントに切替</button>
            </div>
        </div>`;

    // ===== テーブル構築（配列ベースで高速化） =====
    // 左: 固定の日付列、右: 横スクロール可能な車両×日付テーブル
    const dateParts = ['<div class="matrix-date-panel"><div class="matrix-corner-header">日付</div><div class="matrix-date-body">'];
    const tableParts = ['<div class="matrix-wrapper"><table class="matrix-table"><thead><tr class="matrix-header-row1">'];

    // ヘッダー行1: 車両番号
    for (let vi = 0; vi < filteredVehicles.length; vi++) {
        const v = filteredVehicles[vi];
        const shortNum = v.number.split(' ').slice(-1)[0] || v.number;
        const vType = v.vehicle_type || v.type || '';
        const cap = v.capacity ? v.capacity + 't' : '';
        const typeLabel = vType + (cap ? cap : '');
        const chassisNum = v.chassis_number || '';
        const chassisShort = chassisNum.length > 4 ? chassisNum.slice(-4) : chassisNum;

        tableParts.push(`<th class="matrix-vehicle-col-header" onmouseenter="showVehicleTooltip(event,${v.id})" onmouseleave="hideVehicleTooltip()" style="cursor:pointer"><div class="mvh-number">${shortNum}</div>`);
        if (typeLabel) tableParts.push(`<div class="mvh-info">${typeLabel}</div>`);
        if (chassisShort) tableParts.push(`<div class="mvh-chassis">${chassisShort}</div>`);
        tableParts.push('</th>');
    }
    tableParts.push('</tr><tr class="matrix-header-row2">');

    // ヘッダー行2: ドライバー名
    for (let vi = 0; vi < filteredVehicles.length; vi++) {
        const v = filteredVehicles[vi];
        const driverName = vehicleDriverNames[v.id] || '';
        const driverId = vehicleDriverIds[v.id] || '';
        tableParts.push(`<th class="matrix-driver-cell" data-vehicle-id="${v.id}" data-driver-id="${driverId}" onclick="openDriverDropdown(event,${v.id})" title="クリックでドライバー変更">${driverName || '&nbsp;'}</th>`);
    }
    tableParts.push('</tr></thead><tbody>');

    // 遅延描画: 今日付近の7日分のみ先に描画、残りはプレースホルダー
    const todayDayIdx = matrixDays.findIndex(d => isToday(d));
    const initialStart = Math.max(0, todayDayIdx - 2);
    const initialEnd = Math.min(NUM_DAYS, initialStart + 7);

    // 遅延描画用データをwindowに保存（IntersectionObserverから参照）
    window._matrixLazyData = { filteredVehicles, matrixDayStrs, matrixDays, dispatchIndex, shipmentMap, NUM_DAYS };

    // 各日付の行
    for (let dayIdx = 0; dayIdx < NUM_DAYS; dayIdx++) {
        const day = matrixDays[dayIdx];
        const dayStr = matrixDayStrs[dayIdx];
        const dow = day.getDay();
        const isSat = dow === 6;
        const isSun = dow === 0;
        const isTodayFlag = isToday(day);

        const rowCls = isTodayFlag ? 'matrix-date-row matrix-today-row' : isSun ? 'matrix-date-row matrix-sunday-row' : isSat ? 'matrix-date-row matrix-saturday-row' : 'matrix-date-row';
        const dateCls = isTodayFlag ? 'matrix-date-label matrix-today-label' : isSun ? 'matrix-date-label matrix-sunday-label' : isSat ? 'matrix-date-label matrix-saturday-label' : 'matrix-date-label';
        const cellCls = isTodayFlag ? 'matrix-cell-t matrix-today-cell' : isSun ? 'matrix-cell-t matrix-sunday-cell' : isSat ? 'matrix-cell-t matrix-saturday-cell' : 'matrix-cell-t';

        // 左パネル: 日付ラベル
        dateParts.push(`<div class="${dateCls}"><span class="matrix-date-num">${day.getDate()}</span><span class="matrix-date-dow">${dayNames[dow]}</span></div>`);

        // 初回描画範囲外はプレースホルダー行（空セル、高さだけ確保）
        // D&Dハンドラは最初から設定（30・31日目でもドロップ可能にする）
        const isDeferred = dayIdx < initialStart || dayIdx >= initialEnd;
        if (isDeferred) {
            tableParts.push(`<tr class="${rowCls}" data-lazy-day="${dayIdx}">`);
            for (let vi = 0; vi < filteredVehicles.length; vi++) {
                const vId = filteredVehicles[vi].id;
                tableParts.push(`<td class="${cellCls}" style="position:relative" ondragover="matrixDragOver(event)" ondragleave="matrixDragLeave(event)" ondrop="matrixDrop(event,${vId},'${dayStr}',2)"><div class="matrix-slots">`);
                for (let pIdx = 0; pIdx < 6; pIdx++) {
                    tableParts.push(`<div class="matrix-slot${pIdx > 0 ? ' matrix-slot-border' : ''} matrix-slot-empty" onclick="if(!event.target.closest('.matrix-dispatch-item'))openMatrixSlotModal('${dayStr}',${pIdx},${vId})" ondragover="matrixDragOver(event)" ondragleave="matrixDragLeave(event)" ondrop="event.stopPropagation();matrixDrop(event,${vId},'${dayStr}',${pIdx})"></div>`);
                }
                tableParts.push('</div></td>');
            }
            tableParts.push('</tr>');
            continue;
        }

        // 右パネル: データ行
        tableParts.push(`<tr class="${rowCls}">`);

        // 各車両のセル
        for (let vi = 0; vi < filteredVehicles.length; vi++) {
            const v = filteredVehicles[vi];
            const vId = v.id;
            // dispatchIndexからO(1)でこの車両・日付の配車を取得（.filter()不要）
            const dayDispatches = dispatchIndex[vId + '-' + dayStr] || [];

            // 6スロットに振り分け
            const slots = [[], [], [], [], [], []];
            for (let di = 0; di < dayDispatches.length; di++) {
                slots[getTimePeriodIndex(dayDispatches[di].start_time)].push(dayDispatches[di]);
            }

            // セル: スロット背景（D&Dターゲット）+ 絶対配置の配車アイテム
            tableParts.push(`<td class="${cellCls}" style="position:relative" ondragover="matrixDragOver(event)" ondragleave="matrixDragLeave(event)" ondrop="matrixDrop(event,${vId},'${dayStr}',2)"><div class="matrix-slots">`);

            // 6スロットの背景枠（D&Dドロップターゲット）
            for (let pIdx = 0; pIdx < 6; pIdx++) {
                const slotCls = pIdx > 0 ? ' matrix-slot-border' : '';
                tableParts.push(`<div class="matrix-slot${slotCls} matrix-slot-empty" onclick="if(!event.target.closest('.matrix-dispatch-item'))openMatrixSlotModal('${dayStr}',${pIdx},${vId})" ondragover="matrixDragOver(event)" ondragleave="matrixDragLeave(event)" ondrop="event.stopPropagation();matrixDrop(event,${vId},'${dayStr}',${pIdx})"></div>`);
            }

            // 配車アイテムを動的スロット位置で絶対配置
            // 各配車は ceil(duration/2h) スロットを占有、時刻順に上から配置
            const CELL_H = 132;
            const SLOT_H = CELL_H / 6;
            let slotCursor = 0; // 次に使えるスロット位置
            for (let di = 0; di < dayDispatches.length; di++) {
                const d = dayDispatches[di];
                const dStartH = parseInt((d.start_time || '08:00').split(':')[0]);
                const dEndH = parseInt((d.end_time || '12:00').split(':')[0]) || (dStartH + 4);
                const spanSlots = Math.max(1, Math.ceil((dEndH - dStartH) / 2));
                const topPx = Math.round(slotCursor * SLOT_H);
                const heightPx = Math.max(Math.round(spanSlots * SLOT_H) - 1, SLOT_H - 1);
                slotCursor += spanSlots; // 次の配車のスロット開始位置

                const ddc = getDriverColor(d.driver_id);
                const borderColor = ddc ? ddc.border : '#94a3b8';
                const bgColor = ddc ? ddc.bg : '#f8fafc';
                const pickup = (d.pickup_address || '').split(/[　 ]/)[0] || '';
                const delivery = (d.delivery_address || '').split(/[　 ]/)[0] || '';
                const pickupShort = pickup.length > 4 ? pickup.substring(0, 4) : pickup;
                const deliveryShort = delivery.length > 4 ? delivery.substring(0, 4) : delivery;
                const routeLabel = pickupShort && deliveryShort ? pickupShort + '～' + deliveryShort : (pickupShort || deliveryShort || '');
                const shipment = shipmentMap[d.shipment_id];
                const areaLabel = (d.delivery_address || '').includes('方面') ? (d.delivery_address || '').split(/[　 ]/).find(s => s.includes('方面')) || '' : (shipment?.cargo_description || d.cargo_type || '');
                const extraLabel = d.client_name || (shipment ? shipment.client_name : '') || '';
                const sH = parseInt((d.start_time || '08:00').split(':')[0]);
                const eH = parseInt((d.end_time || '20:00').split(':')[0]) || 20;
                const timeLabel = sH + '時-' + eH + '時';

                tableParts.push(`<div class="matrix-dispatch-item matrix-dispatch-abs" draggable="true" data-dispatch-id="${d.id}" data-vehicle-id="${vId}" data-date="${dayStr}" ondragstart="matrixDragStart(event,${d.id},${vId},'${dayStr}',${dStartIdx})" ondragend="matrixDragEnd(event)" style="top:${topPx}px;height:${heightPx}px;border-left-color:${borderColor};background:${bgColor}" onclick="event.stopPropagation();openMatrixSlotModal('${dayStr}',${dStartIdx},${vId},${d.id})" title="${d.driver_name || ''}\n${timeLabel}\n${d.pickup_address || ''}→${d.delivery_address || ''}">`);
                tableParts.push(`<div class="matrix-dispatch-route">${routeLabel}</div>`);
                if (heightPx > 20 && areaLabel) tableParts.push(`<div class="matrix-dispatch-area">${areaLabel}</div>`);
                if (heightPx > 35 && extraLabel) tableParts.push(`<div class="matrix-dispatch-extra">${extraLabel}</div>`);
                if (heightPx > 48) tableParts.push(`<div class="matrix-dispatch-time">${timeLabel}</div>`);
                tableParts.push(`<div class="matrix-resize-handle" onmousedown="matrixResizeStart(event,${d.id},${vId},'${dayStr}')"></div>`);
                tableParts.push('</div>');
            }

            tableParts.push('</div></td>');
        }
        tableParts.push('</tr>');
    }

    tableParts.push('</tbody></table></div>');
    dateParts.push('</div></div>');
    const tableHtml = tableParts.join('');
    const dateColHtml = dateParts.join('');

    // 2パネルレイアウトで組み立て（未配車パネル用divも追加）
    const layoutHtml = `<div class="matrix-layout">${dateColHtml}${tableHtml}</div>`;
    const unassignedHtml = `<div id="matrix-unassigned-panel" style="padding:8px 0"></div>`;
    calContainer.innerHTML = controlsHtml + layoutHtml + unassignedHtml;

    // matrix-wrapperの高さ・スクロール設定をレイアウト完了後に実行
    const wrapper = calContainer.querySelector('.matrix-wrapper');
    const datePanel = calContainer.querySelector('.matrix-date-panel');
    const dateBody = datePanel?.querySelector('.matrix-date-body');
    if (wrapper) {
        // 縦スクロール同期: 右パネルscrollTop → 左パネルのdate-body
        wrapper.addEventListener('scroll', () => {
            if (dateBody) dateBody.scrollTop = wrapper.scrollTop;
        });

        // requestAnimationFrame でブラウザのレイアウト計算完了を待つ
        requestAnimationFrame(() => {
            // 高さを動的に設定（レイアウト完了後なので正確な値が取れる）
            const layoutEl = calContainer.querySelector('.matrix-layout');
            if (!layoutEl) return;
            const layoutTop = layoutEl.getBoundingClientRect().top;
            const reserveBottom = 100;
            const availableHeight = window.innerHeight - layoutTop - reserveBottom;
            const h = Math.max(300, availableHeight) + 'px';
            wrapper.style.maxHeight = h;
            wrapper.style.overflow = 'auto';
            if (dateBody) {
                // date-bodyだけスクロール（cornerヘッダーは固定）
                dateBody.style.maxHeight = (availableHeight - 63) + 'px'; // 63px = cornerヘッダー高さ
                dateBody.style.overflow = 'hidden';
            }

            // 行位置同期: 右テーブルの各行offsetTopを左divに絶対位置で完全一致（サブピクセルズレ完全防止）
            if (dateBody) {
                const dateLabels = dateBody.querySelectorAll('.matrix-date-label');
                const wRows = wrapper.querySelectorAll('.matrix-date-row');
                const tbody = wrapper.querySelector('tbody');
                const tbodyTop = tbody ? tbody.offsetTop : 63;
                for (let i = 0; i < Math.min(dateLabels.length, wRows.length); i++) {
                    const rowTop = wRows[i].offsetTop - tbodyTop;
                    const rowH = wRows[i].offsetHeight;
                    dateLabels[i].style.position = 'absolute';
                    dateLabels[i].style.top = rowTop + 'px';
                    dateLabels[i].style.height = rowH + 'px';
                    dateLabels[i].style.width = '100%';
                }
                // dateBodyの合計高さを右テーブルのtbodyに一致
                if (tbody) {
                    dateBody.style.height = tbody.offsetHeight + 'px';
                }
            }

            // スクロール位置の復元または今日の行へスクロール
            // 保存されたスクロール位置がある場合（月変更でない再描画時）はそれを復元
            const savedTop = window._matrixSavedScrollTop || 0;
            const savedLeft = window._matrixSavedScrollLeft || 0;
            if (savedTop > 0 || savedLeft > 0) {
                wrapper.scrollTop = savedTop;
                wrapper.scrollLeft = savedLeft;
            } else {
                // 初回表示または月変更後: 今日の行にスクロール（当月の場合のみ）
                const todayIdx = matrixDays.findIndex(d => isToday(d));
                if (todayIdx >= 0) {
                    const todayRow = wrapper.querySelectorAll('.matrix-date-row')[todayIdx];
                    if (todayRow) {
                        wrapper.scrollTop = todayRow.offsetTop - 60;
                    }
                }
            }

            // 左パネルのスクロールも同期
            if (dateBody) dateBody.scrollTop = wrapper.scrollTop;
        });

        // 未配車パネルを描画（rangeDispatchesは月範囲の配車データ）
        renderMatrixUnassignedPanel(shipments, rangeDispatches);

        // 遅延描画: プレースホルダー行が見えたらセル内容を展開
        const lazyRows = wrapper.querySelectorAll('tr[data-lazy-day]');
        if (lazyRows.length > 0) {
            const lazyObserver = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (!entry.isIntersecting) return;
                    const row = entry.target;
                    const dayIdx = parseInt(row.dataset.lazyDay);
                    lazyObserver.unobserve(row);
                    row.removeAttribute('data-lazy-day');
                    // セル内容を展開
                    _matrixFillRow(row, dayIdx);
                });
            }, { root: wrapper, rootMargin: '600px 0px' }); // 600px先読み（30-31日目も確実に展開）
            lazyRows.forEach(r => lazyObserver.observe(r));
        }
    }
}

// 遅延描画: プレースホルダー行にセル内容を埋める
function _matrixFillRow(row, dayIdx) {
    const ld = window._matrixLazyData;
    if (!ld) return;
    const { filteredVehicles, matrixDayStrs, dispatchIndex, shipmentMap } = ld;
    const dayStr = matrixDayStrs[dayIdx];
    const cells = row.querySelectorAll('.matrix-cell-t');
    const CELL_H = 132, SLOT_H = CELL_H / 6;

    for (let vi = 0; vi < Math.min(cells.length, filteredVehicles.length); vi++) {
        const v = filteredVehicles[vi];
        const vId = v.id;
        const cell = cells[vi];
        const dayDispatches = dispatchIndex[vId + '-' + dayStr] || [];
        if (dayDispatches.length === 0) continue;

        // スロットにD&Dとクリックイベントを付与
        const slots = cell.querySelectorAll('.matrix-slot');
        slots.forEach((slot, pIdx) => {
            slot.classList.add('matrix-slot-empty');
            slot.setAttribute('onclick', `if(!event.target.closest('.matrix-dispatch-item'))openMatrixSlotModal('${dayStr}',${pIdx},${vId})`);
            slot.setAttribute('ondragover', 'matrixDragOver(event)');
            slot.setAttribute('ondragleave', 'matrixDragLeave(event)');
            slot.setAttribute('ondrop', `event.stopPropagation();matrixDrop(event,${vId},'${dayStr}',${pIdx})`);
        });
        // セルにもD&D
        cell.setAttribute('ondragover', 'matrixDragOver(event)');
        cell.setAttribute('ondragleave', 'matrixDragLeave(event)');
        cell.setAttribute('ondrop', `matrixDrop(event,${vId},'${dayStr}',2)`);

        // 配車アイテムを追加（動的スロット: 時刻順に上から配置）
        let lazyCursor = 0;
        for (let di = 0; di < dayDispatches.length; di++) {
            const d = dayDispatches[di];
            const dStartH = parseInt((d.start_time || '08:00').split(':')[0]);
            const dEndH = parseInt((d.end_time || '12:00').split(':')[0]) || (dStartH + 4);
            const spanSlots = Math.max(1, Math.ceil((dEndH - dStartH) / 2));
            const topPx = Math.round(lazyCursor * SLOT_H);
            const heightPx = Math.max(Math.round(spanSlots * SLOT_H) - 1, SLOT_H - 1);
            lazyCursor += spanSlots;
            const ddc = getDriverColor(d.driver_id);
            const borderColor = ddc ? ddc.border : '#94a3b8';
            const bgColor = ddc ? ddc.bg : '#f8fafc';
            const pickup = (d.pickup_address || '').split(/[　 ]/)[0] || '';
            const delivery = (d.delivery_address || '').split(/[　 ]/)[0] || '';
            const pickupShort = pickup.length > 4 ? pickup.substring(0, 4) : pickup;
            const deliveryShort = delivery.length > 4 ? delivery.substring(0, 4) : delivery;
            const routeLabel = pickupShort && deliveryShort ? pickupShort + '～' + deliveryShort : (pickupShort || deliveryShort || '');
            const shipment = shipmentMap[d.shipment_id];
            const areaLabel = (d.delivery_address || '').includes('方面') ? (d.delivery_address || '').split(/[　 ]/).find(s => s.includes('方面')) || '' : (shipment?.cargo_description || d.cargo_type || '');
            const extraLabel = d.client_name || (shipment ? shipment.client_name : '') || '';
            const sH = parseInt((d.start_time || '08:00').split(':')[0]);
            const eH = parseInt((d.end_time || '20:00').split(':')[0]) || 20;
            const timeLabel = sH + '時-' + eH + '時';

            const itemEl = document.createElement('div');
            itemEl.className = 'matrix-dispatch-item matrix-dispatch-abs';
            itemEl.draggable = true;
            itemEl.style.cssText = `top:${topPx}px;height:${heightPx}px;border-left-color:${borderColor};background:${bgColor}`;
            itemEl.setAttribute('ondragstart', `matrixDragStart(event,${d.id},${vId},'${dayStr}',${dStartIdx})`);
            itemEl.setAttribute('ondragend', 'matrixDragEnd(event)');
            itemEl.setAttribute('onclick', `event.stopPropagation();openMatrixSlotModal('${dayStr}',${dStartIdx},${vId},${d.id})`);
            itemEl.title = `${d.driver_name || ''}\n${timeLabel}\n${d.pickup_address || ''}→${d.delivery_address || ''}`;
            let inner = `<div class="matrix-dispatch-route">${routeLabel}</div>`;
            if (heightPx > 20 && areaLabel) inner += `<div class="matrix-dispatch-area">${areaLabel}</div>`;
            if (heightPx > 35 && extraLabel) inner += `<div class="matrix-dispatch-extra">${extraLabel}</div>`;
            if (heightPx > 48) inner += `<div class="matrix-dispatch-time">${timeLabel}</div>`;
            inner += `<div class="matrix-resize-handle" onmousedown="matrixResizeStart(event,${d.id},${vId},'${dayStr}')"></div>`;
            itemEl.innerHTML = inner;
            cell.querySelector('.matrix-slots').appendChild(itemEl);
        }
    }
}

// ===== マトリクスセルスロット配車モーダル =====

async function openMatrixSlotModal(dateStr, slotIdx, vehicleId, dispatchId) {
    if (justDragged) { justDragged = false; return; }
    const period = MATRIX_PERIODS[slotIdx];
    const slotLabel = `${String(period.startH).padStart(2,'0')}:00-${period.endH === 24 ? '24:00' : String(period.endH).padStart(2,'0')+':00'}`;

    const [vehicles, clients] = await Promise.all([
        cachedApiGet('/vehicles'),
        cachedApiGet('/clients')
    ]);
    const vehicle = vehicles.find(v => v.id === vehicleId);
    const vehicleLabel = vehicle ? vehicle.number : `車両ID:${vehicleId}`;
    const defaultDriverId = vehicle ? vehicle.default_driver_id : null;

    // If editing existing dispatch, fetch its data (キャッシュ優先で高速化)
    let existing = null;
    if (dispatchId) {
        // まずキャッシュ済みの月間配車データから検索
        const cachedDisp = _cache['_lastDispatches']?.data;
        if (cachedDisp) {
            existing = cachedDisp.find(d => d.id === dispatchId);
        }
        // キャッシュにない場合のみAPI呼び出し
        if (!existing) {
            const allDisp = await apiGet('/dispatches');
            existing = allDisp.find(d => d.id === dispatchId);
        }
    }

    const isEdit = !!existing;
    const modalTitle = isEdit ? '配車編集' : '配車作成';
    const clientOptions = clients.map(c => `<option value="${c.name}" ${existing && existing.client_name === c.name ? 'selected' : ''}>${c.name}</option>`).join('');

    document.getElementById('modal-title').textContent = modalTitle;
    document.getElementById('modal-body').innerHTML = `
        <div style="margin-bottom:12px;padding:8px 12px;background:#fff7ed;border-radius:6px;font-size:0.85rem;color:#9a3412">
            <strong>${vehicleLabel}</strong> / ${dateStr}
        </div>
        <div class="form-group">
            <label>荷主名</label>
            <select id="f-ms-client" style="width:100%">
                <option value="">-- 選択 --</option>
                ${clientOptions}
            </select>
        </div>
        <div class="form-group">
            <label>積地</label>
            <input type="text" id="f-ms-pickup" placeholder="東京都大田区..." value="${existing ? (existing.pickup_address || '') : ''}">
        </div>
        <div class="form-group">
            <label>卸地</label>
            <input type="text" id="f-ms-delivery" placeholder="神奈川県横浜市..." value="${existing ? (existing.delivery_address || '') : ''}">
        </div>
        <div class="form-group">
            <label>備考</label>
            <textarea id="f-ms-notes" rows="2">${existing ? (existing.notes || '') : ''}</textarea>
        </div>
        <div class="form-group">
            <label>重量 (kg) ※任意</label>
            <input type="number" id="f-ms-weight" placeholder="例: 1500" value="${existing && existing.weight ? existing.weight : ''}">
        </div>
        <input type="hidden" id="f-ms-date" value="${dateStr}">
        <input type="hidden" id="f-ms-slot" value="${slotIdx}">
        <input type="hidden" id="f-ms-vehicle-id" value="${vehicleId}">
        <input type="hidden" id="f-ms-driver-id" value="${defaultDriverId || ''}">
        <input type="hidden" id="f-ms-dispatch-id" value="${dispatchId || ''}">
        <div class="form-actions">
            <button class="btn" onclick="closeModal()">キャンセル</button>
            ${isEdit ? `<button class="btn" onclick="unassignDispatch(${dispatchId})" style="margin-right:auto;background:#64748b;color:#fff">未配車に戻す</button><button class="btn btn-danger" onclick="deleteDispatchFromSlotModal(${dispatchId})">削除</button>` : ''}
            <button class="btn btn-primary" onclick="saveMatrixSlotDispatch()">保存</button>
        </div>`;
    showModal();
}

async function saveMatrixSlotDispatch() {
    const dateStr = document.getElementById('f-ms-date').value;
    const slotIdx = parseInt(document.getElementById('f-ms-slot').value);
    const vehicleId = parseInt(document.getElementById('f-ms-vehicle-id').value);
    const driverId = parseInt(document.getElementById('f-ms-driver-id').value) || null;
    const dispatchId = parseInt(document.getElementById('f-ms-dispatch-id').value) || null;
    const clientName = document.getElementById('f-ms-client').value;
    const pickup = document.getElementById('f-ms-pickup').value;
    const delivery = document.getElementById('f-ms-delivery').value;
    const notes = document.getElementById('f-ms-notes').value;
    const weight = parseFloat(document.getElementById('f-ms-weight').value) || 0;

    if (!pickup && !delivery) return alert('積地または卸地を入力してください');

    const period = MATRIX_PERIODS[slotIdx];
    const startTime = String(period.startH).padStart(2, '0') + ':00';
    const endTime = period.endH === 24 ? '23:59' : String(period.endH).padStart(2, '0') + ':00';

    if (dispatchId) {
        // Edit existing dispatch
        const updateData = {
            pickup_address: pickup,
            delivery_address: delivery,
            notes: notes,
            client_name: clientName,
            weight: weight,
            start_time: startTime,
            end_time: endTime
        };
        await apiPut(`/dispatches/${dispatchId}`, updateData);
    } else {
        // Create shipment first, then dispatch
        const shipmentData = {
            client_name: clientName,
            pickup_address: pickup,
            delivery_address: delivery,
            pickup_date: dateStr,
            delivery_date: dateStr,
            cargo_description: notes ? notes.substring(0, 50) : '',
            weight: weight,
            price: 0,
            status: '配車済'
        };
        const shipment = await apiPost('/shipments', shipmentData);
        const shipmentId = shipment.id;

        // Create dispatch
        const dispatchData = {
            vehicle_id: vehicleId,
            driver_id: driverId,
            shipment_id: shipmentId,
            date: dateStr,
            start_time: startTime,
            end_time: endTime,
            pickup_address: pickup,
            delivery_address: delivery,
            notes: notes,
            client_name: clientName
        };
        await apiPost('/dispatches', dispatchData);
    }

    closeModal();
    loadDispatchCalendar();
}

async function deleteDispatchFromSlotModal(dispatchId) {
    if (!confirm('この配車を削除しますか？')) return;
    await apiDelete(`/dispatches/${dispatchId}`);
    closeModal();
    loadDispatchCalendar();
}

// ===== 未配車に戻す =====
async function unassignDispatch(dispatchId) {
    if (!confirm('この配車を未配車に戻しますか？\n（配車データは削除され、案件は未配車一覧に戻ります）')) return;
    await apiDelete(`/dispatches/${dispatchId}`);
    closeModal();
    invalidateCache();
    loadDispatchCalendar();
}

// ===== リサイズ機能: 配車アイテムの下辺ドラッグで時間変更 =====
let _resizeData = null;

function matrixResizeStart(e, dispatchId, vehicleId, dateStr) {
    e.preventDefault();
    e.stopPropagation();
    const item = e.target.closest('.matrix-dispatch-abs');
    if (!item) return;
    const cell = item.closest('.matrix-cell-t');
    const cellRect = cell.getBoundingClientRect();
    const CELL_H = 132;

    _resizeData = {
        dispatchId, vehicleId, dateStr,
        item, cellRect, CELL_H,
        startY: e.clientY,
        origHeight: item.offsetHeight,
        origTop: parseInt(item.style.top) || 0
    };

    document.addEventListener('mousemove', matrixResizeMove);
    document.addEventListener('mouseup', matrixResizeEnd);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
}

function matrixResizeMove(e) {
    if (!_resizeData) return;
    const dy = e.clientY - _resizeData.startY;
    const newHeight = Math.max(11, _resizeData.origHeight + dy);
    // 4時間単位(22px)にスナップ
    const SLOT_H = _resizeData.CELL_H / 6;
    const snapped = Math.round(newHeight / SLOT_H) * SLOT_H;
    _resizeData.item.style.height = Math.max(SLOT_H, snapped) + 'px';

    // ツールチップで時間表示
    const startH = Math.round((_resizeData.origTop / _resizeData.CELL_H) * 24);
    const endH = Math.min(24, Math.round(((_resizeData.origTop + Math.max(SLOT_H, snapped)) / _resizeData.CELL_H) * 24));
    _resizeData.item.title = `${startH}時〜${endH}時`;
    _resizeData.newEndH = endH;
}

async function matrixResizeEnd(e) {
    document.removeEventListener('mousemove', matrixResizeMove);
    document.removeEventListener('mouseup', matrixResizeEnd);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (!_resizeData || _resizeData.newEndH === undefined) { _resizeData = null; return; }

    const endH = _resizeData.newEndH;
    const newEnd = String(endH === 24 ? 23 : endH).padStart(2, '0') + (endH === 24 ? ':59' : ':00');
    try {
        await apiPut('/dispatches/' + _resizeData.dispatchId, { end_time: newEnd });
        invalidateCache();
        loadDispatchCalendar();
    } catch (err) {
        alert('リサイズ失敗: ' + (err.message || err));
        loadDispatchCalendar();
    }
    _resizeData = null;
}

// ===== テナントフック: マトリクスビューのエントリポイント =====
// core の loadDispatchCalendar() から呼ばれる
window._tenantRenderMatrixView = async function(calContainer, dispatches, vehicles, shipments, partners, matrixVehicles, baseDate) {
    await renderMatrixView(calContainer, dispatches, vehicles, shipments, partners, matrixVehicles, baseDate);
};
