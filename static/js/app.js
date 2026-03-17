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

// ===== 初期化 =====
document.addEventListener('DOMContentLoaded', () => {
    const today = new Date();
    document.getElementById('currentDate').textContent =
        today.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });

    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => navigateTo(item.dataset.page));
    });

    document.getElementById('menuToggle').addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('open');
    });

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
        clients: '荷主管理', vehicles: '車両管理', drivers: 'ドライバー管理', map: '地図表示',
        revenue: '売上・請求管理', reports: '日報'
    };
    document.getElementById('pageTitle').textContent = titles[page] || '';

    const loaders = {
        dashboard: loadDashboard, dispatches: loadDispatchCalendar, shipments: loadShipments,
        clients: loadClients, vehicles: loadVehicles, drivers: loadDrivers, map: initMap,
        revenue: loadRevenue, reports: loadReports
    };
    if (loaders[page]) loaders[page]();
    document.getElementById('sidebar').classList.remove('open');
}

// ===== API ヘルパー =====
async function apiGet(url) { return (await fetch(API + url)).json(); }
async function apiPost(url, data) {
    return (await fetch(API + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })).json();
}
async function apiPut(url, data) {
    return (await fetch(API + url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })).json();
}
async function apiDelete(url) { return (await fetch(API + url, { method: 'DELETE' })).json(); }

// ===== ダッシュボード =====
async function loadDashboard() {
    const data = await apiGet('/dashboard');
    document.getElementById('stat-today-dispatches').textContent = data.today_dispatches;
    document.getElementById('stat-unassigned').textContent = data.unassigned_shipments;
    document.getElementById('stat-vehicles-active').innerHTML = `${data.vehicles.active}<small>/${data.vehicles.total}</small>`;
    document.getElementById('stat-monthly-revenue').textContent = `¥${data.monthly_revenue.toLocaleString()}`;

    const vTotal = data.vehicles.total || 1;
    document.getElementById('vehicle-status-bars').innerHTML = `
        ${statusBar('稼働中', data.vehicles.active, vTotal, 'blue')}
        ${statusBar('空車', data.vehicles.empty, vTotal, 'green')}
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
let HOUR_START = 5;
let HOUR_END = 22;
let HOUR_COUNT = HOUR_END - HOUR_START;
let selectedDayIndex = 0;

async function loadDispatchCalendar() {
    const baseDate = new Date(calendarDate);
    baseDate.setHours(0, 0, 0, 0);

    const [dispatches, vehicles, shipments] = await Promise.all([
        apiGet(`/dispatches?week_start=${fmt(baseDate)}`),
        apiGet('/vehicles'),
        apiGet('/shipments'),
    ]);

    const days = [];
    const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
    for (let i = 0; i < CAL_DAYS; i++) {
        const d = new Date(baseDate);
        d.setDate(d.getDate() + i);
        days.push(d);
    }
    const dayStrs = days.map(d => fmt(d));

    const vehicleTypes = [...new Set(vehicles.map(v => v.type))];
    const filterType = document.getElementById('cal-filter-type')?.value || '';
    const filteredVehicles = filterType ? vehicles.filter(v => v.type === filterType) : vehicles;

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

    const calContainer = document.getElementById('dispatch-calendar');
    calContainer.innerHTML = `
        <div class="cal-controls">
            <button class="btn btn-sm" onclick="changeDays(-${CAL_DAYS})">◀ 前</button>
            <button class="btn btn-sm" onclick="calendarDate=new Date();selectedDayIndex=0;loadDispatchCalendar()">今日</button>
            <button class="btn btn-sm" onclick="changeDays(${CAL_DAYS})">次 ▶</button>
            <input type="date" class="input-date" value="${fmt(baseDate)}" onchange="calendarDate=new Date(this.value+'T00:00:00');selectedDayIndex=0;loadDispatchCalendar()">
            <div class="cal-day-tabs">
                ${days.map((d, i) => `<button class="cal-day-tab ${i === selectedDayIndex ? 'active' : ''} ${isToday(d) ? 'today' : ''}" onclick="selectedDayIndex=${i};loadDispatchCalendar()">${(d.getMonth() + 1)}/${d.getDate()}(${dayNames[d.getDay()]})</button>`).join('')}
            </div>
            <button class="btn btn-sm" onclick="printDispatchTable()" title="印刷">🖨</button>
            <select id="cal-hour-start" class="select" onchange="changeHourRange()" title="開始時刻" style="width:70px">
                ${Array.from({length:24}, (_,h) => `<option value="${h}" ${HOUR_START === h ? 'selected' : ''}>${String(h).padStart(2,'0')}:00</option>`).join('')}
            </select>
            <span style="color:var(--text-light);font-size:0.8rem">〜</span>
            <select id="cal-hour-end" class="select" onchange="changeHourRange()" title="終了時刻" style="width:70px">
                ${Array.from({length:24}, (_,i) => i+1).map(h => `<option value="${h}" ${HOUR_END === h ? 'selected' : ''}>${h === 24 ? '24:00' : String(h).padStart(2,'0')+':00'}</option>`).join('')}
            </select>
            <select id="cal-filter-type" class="select" onchange="loadDispatchCalendar()" style="margin-left:auto">
                <option value="">全車種</option>
                ${vehicleTypes.map(t => `<option value="${t}" ${filterType === t ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
        </div>
        <div class="gantt-wrapper" id="gantt-print-area">
            <div class="gantt-grid" style="grid-template-columns: 140px repeat(${HOUR_COUNT}, 1fr);">
                <div class="cal-header cal-vehicle-col">車両</div>
                ${hours.map(h => `<div class="cal-header gantt-hour-header">${String(h).padStart(2, '0')}</div>`).join('')}
                ${buildGanttRows(activeDayStr, dayDispatches2, filteredVehicles)}
            </div>
        </div>`;

    // 【機能3】未配車案件パネル（その日に該当する案件のみ表示）
    const unassigned = shipments.filter(s => {
        if (s.status !== '未配車') return false;
        return isShipmentForDate(s, activeDayStr);
    });
    const allUnassigned = shipments.filter(s => s.status === '未配車');
    const panel = document.getElementById('unassigned-panel');
    if (unassigned.length > 0) {
        panel.innerHTML = `<h3 style="margin-bottom:12px">📦 未配車案件 - ${activeDayStr} (${unassigned.length}件<span style="color:var(--text-light);font-size:0.8rem"> / 全${allUnassigned.length}件</span>)</h3>
            <div class="unassigned-list">
                ${unassigned.map(s => {
                    const freqLabel = s.frequency_type === '単発' ? '' : s.frequency_type === '毎日' ? ' 🔁毎日' : ` 🔁${s.frequency_days}`;
                    return `<div class="unassigned-item" draggable="false" onmousedown="startShipmentDrag(event, ${s.id}, '${s.client_name}', '${(s.pickup_address||'').replace(/'/g,"\\'")}', '${(s.delivery_address||'').replace(/'/g,"\\'")}', '${activeDayStr}')" onclick="if(!justDragged){openQuickDispatchModal('${activeDayStr}','08:00','17:00', null, ${s.id})}">
                    <strong>${s.name || s.client_name}</strong>
                    <span>${s.pickup_address} → ${s.delivery_address}</span>
                    <span class="badge badge-orange">未配車${freqLabel}</span>
                    <span>¥${s.price.toLocaleString()}</span>
                </div>`;
                }).join('')}
            </div>`;
    } else {
        panel.innerHTML = `<h3 style="margin-bottom:8px">📦 未配車案件 - ${activeDayStr}</h3><p style="color:var(--text-light);font-size:0.85rem">${allUnassigned.length > 0 ? 'この日に該当する未配車案件はありません（全' + allUnassigned.length + '件）' : '全ての案件が配車済みです'}</p>`;
    }
}

function buildGanttRows(dayStr, dispatches, vehicles) {
    let html = '';
    vehicles.forEach(v => {
        const statusCls = v.status === '稼働中' ? 'blue' : v.status === '空車' ? 'green' : 'orange';
        html += `<div class="cal-vehicle-label">`;
        html += `<div class="cal-vehicle-name">${v.number}</div>`;
        html += `<div class="cal-vehicle-info"><span class="badge badge-${statusCls}" style="font-size:0.65rem;padding:1px 6px">${v.status}</span> ${v.type}</div>`;
        html += `</div>`;

        html += `<div class="gantt-timeline" data-vehicle-id="${v.id}" style="grid-column: 2 / -1;" onclick="openQuickDispatchModal('${dayStr}', '08:00', '17:00', ${v.id})">`;

        for (let h = HOUR_START; h <= HOUR_END; h++) {
            const left = ((h - HOUR_START) / HOUR_COUNT) * 100;
            html += `<div class="gantt-gridline" style="left:${left}%"></div>`;
        }

        const vDispatches = dispatches.filter(d => d.vehicle_id === v.id);
        // 重なりを検出して段(row)を割り当て
        const lanes = [];
        const dispatchLanes = vDispatches.map(d => {
            // 日付またぎ対応: 表示日に応じて表示時間を調整
            let startMin, endMin, isMultiDay = false, dayLabel = '';
            if (d.end_date && d.end_date !== d.date) {
                isMultiDay = true;
                if (dayStr === d.date) {
                    // 初日: start_time 〜 表示終了
                    startMin = timeToMinutes(d.start_time);
                    endMin = HOUR_END * 60;
                    dayLabel = '▶';
                } else if (dayStr === d.end_date) {
                    // 最終日: 表示開始 〜 end_time
                    startMin = HOUR_START * 60;
                    endMin = timeToMinutes(d.end_time);
                    dayLabel = '▶';
                } else {
                    // 中間日: 全日表示
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

        if (maxLanes > 1) {
            html = html.replace(
                `data-vehicle-id="${v.id}" style="grid-column: 2 / -1;"`,
                `data-vehicle-id="${v.id}" style="grid-column: 2 / -1; min-height:${timelineMinH}px;"`
            );
        }

        const totalMin = HOUR_COUNT * 60;
        dispatchLanes.forEach(d => {
            const left = ((d.startMin - HOUR_START * 60) / totalMin) * 100;
            const width = ((d.endMin - d.startMin) / totalMin) * 100;
            const color = getDispatchColor(d.status);
            const capBadge = (d.weight > 0 && d.vehicle_capacity > 0) ? ` [${Math.round(d.weight / d.vehicle_capacity * 100)}%]` : '';
            const multiDayTag = d.isMultiDay ? ` 📅${d.date}〜${d.end_date}` : '';
            const top = d.lane * laneHeight + 4;
            const barH = laneHeight - 6;
            const multiDayClass = d.isMultiDay ? ' multi-day' : '';
            html += `<div class="gantt-bar ${color}${multiDayClass}" data-id="${d.id}" data-vehicle-id="${v.id}" data-start="${d.start_time}" data-end="${d.end_time}" style="left:${Math.max(left, 0)}%;width:${Math.min(width, 100 - left)}%;top:${top}px;bottom:auto;height:${barH}px;" onmousedown="event.stopPropagation();startGanttDrag(event, ${d.id}, ${v.id})" onclick="event.stopPropagation()" title="${d.start_time}-${d.end_time} ${d.driver_name}${capBadge}${multiDayTag}">`;
            html += `<div class="gantt-bar-resize gantt-bar-resize-left" onmousedown="event.stopPropagation();event.preventDefault();startGanttResize(event, ${d.id}, 'left', '${d.start_time}', '${d.end_time}')"></div>`;
            const startLabel = d.isMultiDay && dayStr !== d.date ? `${d.dayLabel}` : `${d.start_time} ${d.pickup_address || ''}`;
            const endLabel = d.isMultiDay && dayStr !== d.end_date ? '▶' : `${d.end_time} ${d.delivery_address || ''}`;
            html += `<span class="gantt-bar-start">${startLabel}</span>`;
            html += `<span class="gantt-bar-end">${endLabel}</span>`;
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
function startGanttDrag(e, dispatchId, vehicleId) {
    if (e.target.classList.contains('gantt-bar-resize')) return;
    e.preventDefault();
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
        if (!confirm('この配車を取り消して未配車に戻しますか？')) return;
        const dispatches = await apiGet('/dispatches');
        const d = dispatches.find(x => x.id === id);
        if (d && d.shipment_id) {
            await apiPut(`/shipments/${d.shipment_id}`, { status: '未配車' });
        }
        await apiDelete(`/dispatches/${id}`);
        loadDispatchCalendar();
        return;
    }

    const vehicleChanged = targetVehicleId && targetVehicleId !== vehicleId;
    const timeChanged = newStart !== origStart || newEnd !== origEnd;

    if (vehicleChanged || timeChanged) {
        const update = {};
        if (vehicleChanged) update.vehicle_id = targetVehicleId;
        if (timeChanged) { update.start_time = newStart; update.end_time = newEnd; }
        await apiPut(`/dispatches/${id}`, update);
        loadDispatchCalendar();
    }
}

// ===== 未配車案件ドラッグ＆ドロップ =====
function startShipmentDrag(e, shipmentId, clientName, pickup, delivery, dayStr) {
    e.preventDefault();
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

    // ドライバー選択モーダルを開く（車両・時間・案件はドロップから確定）
    const drivers = await apiGet('/drivers');
    const availableDrivers = drivers.filter(d => d.status !== '非番');
    const endMin = timeToMinutes(dropTime) + 60;
    const endTime = minutesToTime(Math.min(endMin, HOUR_END * 60));

    document.getElementById('modal-title').textContent = '配車確定 - ドライバー選択';
    document.getElementById('modal-body').innerHTML = `
        <div style="margin-bottom:16px;padding:12px;background:#f0fdf4;border-radius:8px;font-size:0.85rem">
            <div><strong>日付:</strong> ${dayStr}</div>
            <div><strong>時間:</strong> ${dropTime} 〜 ${endTime}</div>
        </div>
        <div class="form-group">
            <label>ドライバー</label>
            <select id="f-sd-driver">
                <option value="">-- 選択 --</option>
                ${availableDrivers.map(d => `<option value="${d.id}">${d.name} (${d.license_type}) [${d.status}]</option>`).join('')}
            </select>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>開始時刻</label>
                <input type="time" id="f-sd-start" value="${dropTime}">
            </div>
            <div class="form-group">
                <label>終了時刻</label>
                <input type="time" id="f-sd-end" value="${endTime}">
            </div>
        </div>
        <div class="form-actions">
            <button class="btn" onclick="closeModal()">キャンセル</button>
            <button class="btn btn-primary" onclick="confirmShipmentDrop(${targetVehicleId}, ${shipmentId}, '${dayStr}')">配車する</button>
        </div>`;
    showModal();
}

async function confirmShipmentDrop(vehicleId, shipmentId, dayStr) {
    const driverId = parseInt(document.getElementById('f-sd-driver').value);
    if (!driverId) return alert('ドライバーを選択してください');
    const startTime = document.getElementById('f-sd-start').value;
    const endTime = document.getElementById('f-sd-end').value;
    await apiPost('/dispatches', {
        vehicle_id: vehicleId,
        driver_id: driverId,
        shipment_id: shipmentId,
        date: dayStr,
        start_time: startTime,
        end_time: endTime,
    });
    closeModal();
    loadDispatchCalendar();
}

// ===== ガントバーリサイズ =====
function startGanttResize(e, dispatchId, edge, startTime, endTime) {
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
    await apiPut(`/dispatches/${id}`, { start_time: newStart, end_time: newEnd });
    loadDispatchCalendar();
}

function getDispatchColor(status) {
    return { '予定': 'ev-blue', '運行中': 'ev-green', 'キャンセル': 'ev-red' }[status] || 'ev-blue';
}

function changeDays(dir) {
    calendarDate.setDate(calendarDate.getDate() + dir);
    loadDispatchCalendar();
}

function changeHourRange() {
    const newStart = parseInt(document.getElementById('cal-hour-start').value);
    const newEnd = parseInt(document.getElementById('cal-hour-end').value);
    if (newEnd <= newStart) { alert('終了時刻は開始時刻より後にしてください'); return; }
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
    mins = Math.max(0, Math.min(mins, 23 * 60 + 30));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function calcDuration(start, end) {
    return timeToMinutes(end) - timeToMinutes(start);
}

// ===== 配車作成モーダル =====
async function openQuickDispatchModal(date, startTime, endTime, preselectedVehicleId, preselectedShipmentId) {
    if (justDragged) { justDragged = false; return; }
    const [vehicles, drivers, shipments, clients] = await Promise.all([
        apiGet('/vehicles'), apiGet('/drivers'), apiGet('/shipments'), apiGet('/clients')
    ]);
    const availableVehicles = vehicles.filter(v => v.status !== '整備中');
    const availableDrivers = drivers.filter(d => d.status !== '非番');
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
                <input type="time" id="f-qd-start" value="${startTime}">
            </div>
            <div class="form-group">
                <label>終了時刻</label>
                <input type="time" id="f-qd-end" value="${endTime}">
            </div>
        </div>
        <div class="form-group">
            <label>車両</label>
            <select id="f-qd-vehicle">
                <option value="">-- 選択 --</option>
                ${availableVehicles.map(v => `<option value="${v.id}" ${preselectedVehicleId === v.id ? 'selected' : ''}>${v.number} (${v.type}) [${v.status}]</option>`).join('')}
            </select>
        </div>
        <div class="form-group">
            <label>ドライバー</label>
            <select id="f-qd-driver">
                <option value="">-- 選択 --</option>
                ${availableDrivers.map(d => `<option value="${d.id}">${d.name} (${d.license_type}) [${d.status}]</option>`).join('')}
            </select>
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
                <div style="display:flex;gap:8px">
                    <select id="f-qd-client-select" onchange="document.getElementById('f-qd-client').value=this.value" style="flex:1">
                        <option value="">-- 選択 --</option>
                        ${clients.map(c => `<option value="${c.name}">${c.name}</option>`).join('')}
                    </select>
                    <input type="text" id="f-qd-client" placeholder="手入力も可" style="flex:1">
                </div>
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

function toggleManualAddress() {
    const shipmentId = document.getElementById('f-qd-shipment').value;
    document.getElementById('manual-address').style.display = shipmentId ? 'none' : 'block';
}

async function saveQuickDispatch() {
    const vehicleId = parseInt(document.getElementById('f-qd-vehicle').value);
    const driverId = parseInt(document.getElementById('f-qd-driver').value);
    if (!vehicleId || !driverId) return alert('車両とドライバーを選択してください');
    const date = document.getElementById('f-qd-date').value;
    if (!date) return alert('日付を選択してください');

    const endDate = document.getElementById('f-qd-end-date').value;
    const shipmentId = document.getElementById('f-qd-shipment').value;
    const data = {
        vehicle_id: vehicleId, driver_id: driverId, date: date,
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
async function showDispatchDetail(id) {
    const dispatches = await apiGet('/dispatches');
    const d = dispatches.find(x => x.id === id);
    if (!d) return;

    // 【機能8】積載効率
    const capInfo = (d.weight > 0 && d.vehicle_capacity > 0) ? `<div><strong>積載効率:</strong> ${d.weight.toLocaleString()}kg / ${d.vehicle_capacity.toLocaleString()}kg (${Math.round(d.weight / d.vehicle_capacity * 100)}%)</div>` : '';
    const priceInfo = d.price > 0 ? `<div><strong>運賃:</strong> ¥${d.price.toLocaleString()}</div>` : '';

    document.getElementById('modal-title').textContent = '配車詳細';
    document.getElementById('modal-body').innerHTML = `
        <div style="display:grid;gap:12px">
            <div><strong>日付:</strong> ${d.date}</div>
            <div><strong>時間:</strong> ${d.start_time} 〜 ${d.end_time}</div>
            <div><strong>車両:</strong> ${d.vehicle_number}</div>
            <div><strong>ドライバー:</strong> ${d.driver_name}</div>
            <div><strong>荷主:</strong> ${d.client_name || '-'}</div>
            <div><strong>積地:</strong> ${d.pickup_address || '-'}</div>
            <div><strong>卸地:</strong> ${d.delivery_address || '-'}</div>
            ${capInfo}${priceInfo}
            <div><strong>ステータス:</strong> ${statusBadge(d.status)}</div>
            <div><strong>備考:</strong> ${d.notes || '-'}</div>
        </div>
        <div class="form-actions">
            <button class="btn btn-danger" onclick="deleteDispatch(${d.id})">削除</button>
            <button class="btn btn-edit" onclick="editDispatch(${d.id})">✎ 編集</button>
            <button class="btn btn-sm" onclick="printDispatchInstruction(${d.id})" title="指示書印刷">🖨 指示書</button>
            <button class="btn btn-sm" onclick="autoReportFromDispatch(${d.id})" title="日報自動作成">📝 日報作成</button>
            <button class="btn" onclick="closeModal()">閉じる</button>
        </div>`;
    showModal();
}

// 【機能4】配車指示書印刷
async function printDispatchInstruction(id) {
    const dispatches = await apiGet('/dispatches');
    const d = dispatches.find(x => x.id === id);
    if (!d) return;
    const printWin = window.open('', '_blank', 'width=600,height=800');
    printWin.document.write(`<!DOCTYPE html><html><head><title>配車指示書</title>
        <style>body{font-family:'Hiragino Sans',sans-serif;padding:30px;color:#333}
        h1{font-size:1.5rem;border-bottom:3px solid #333;padding-bottom:10px;margin-bottom:20px}
        table{width:100%;border-collapse:collapse;margin:16px 0}
        th,td{border:1px solid #ccc;padding:10px 14px;text-align:left}
        th{background:#f5f5f5;width:120px;font-size:0.9rem}
        td{font-size:0.95rem}
        .footer{margin-top:30px;font-size:0.8rem;color:#666;text-align:center}
        </style></head><body>
        <h1>配車指示書</h1>
        <table>
            <tr><th>日付</th><td>${d.date}</td></tr>
            <tr><th>時間</th><td>${d.start_time} 〜 ${d.end_time}</td></tr>
            <tr><th>車両</th><td>${d.vehicle_number} (${d.vehicle_type})</td></tr>
            <tr><th>ドライバー</th><td>${d.driver_name}</td></tr>
            <tr><th>荷主</th><td>${d.client_name || '-'}</td></tr>
            <tr><th>積地</th><td>${d.pickup_address || '-'}</td></tr>
            <tr><th>卸地</th><td>${d.delivery_address || '-'}</td></tr>
            <tr><th>荷物</th><td>${d.cargo_description || '-'}</td></tr>
            <tr><th>備考</th><td>${d.notes || '-'}</td></tr>
        </table>
        <div class="footer">配車管理システム - 印刷日: ${new Date().toLocaleDateString('ja-JP')}</div>
        <script>window.print();</script></body></html>`);
}

// 【機能7】配車から日報自動生成
async function autoReportFromDispatch(id) {
    const dispatches = await apiGet('/dispatches');
    const d = dispatches.find(x => x.id === id);
    if (!d) return;
    if (!confirm(`${d.driver_name}の日報を${d.date}分で自動作成しますか？`)) return;
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
                ${availableVehicles.map(v => `<option value="${v.id}" ${v.id === d.vehicle_id ? 'selected' : ''}>${v.number} (${v.type})</option>`).join('')}
            </select>
        </div>
        <div class="form-group">
            <label>ドライバー</label>
            <select id="f-ed-driver">
                ${availableDrivers.map(dr => `<option value="${dr.id}" ${dr.id === d.driver_id ? 'selected' : ''}>${dr.name} (${dr.license_type})</option>`).join('')}
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
}

async function saveEditDispatch(id) {
    const endDate = document.getElementById('f-ed-end-date').value;
    const data = {
        date: document.getElementById('f-ed-date').value,
        end_date: endDate || null,
        start_time: document.getElementById('f-ed-start').value,
        end_time: document.getElementById('f-ed-end').value,
        vehicle_id: parseInt(document.getElementById('f-ed-vehicle').value),
        driver_id: parseInt(document.getElementById('f-ed-driver').value),
        pickup_address: document.getElementById('f-ed-pickup').value,
        delivery_address: document.getElementById('f-ed-delivery').value,
        notes: document.getElementById('f-ed-notes').value,
    };
    await apiPut(`/dispatches/${id}`, data);
    closeModal();
    loadDispatchCalendar();
}

async function deleteDispatch(id) {
    if (!confirm('この配車を削除しますか？')) return;
    await apiDelete(`/dispatches/${id}`);
    closeModal();
    loadDispatchCalendar();
}

// ===== 車両管理 =====
async function loadVehicles() {
    const vehicles = await apiGet('/vehicles');
    const today = fmt(new Date());
    document.getElementById('vehicles-table').innerHTML = vehicles.map(v => {
        // 車検期限アラート
        let inspBadge = '-';
        if (v.inspection_expiry) {
            const daysLeft = Math.ceil((new Date(v.inspection_expiry) - new Date()) / 86400000);
            if (daysLeft < 0) {
                inspBadge = `<span class="badge badge-red">期限切れ</span>`;
            } else if (daysLeft <= 30) {
                inspBadge = `<span class="badge badge-orange">${v.inspection_expiry} (残${daysLeft}日)</span>`;
            } else {
                inspBadge = `${v.inspection_expiry}`;
            }
        }
        return `<tr>
            <td><strong><a href="#" onclick="event.preventDefault();editVehicle(${v.id})" class="link-cell">${v.number}</a></strong></td>
            <td style="font-size:0.8rem;font-family:monospace">${v.chassis_number || '-'}</td>
            <td>${v.type}</td>
            <td>${v.capacity.toLocaleString()}</td>
            <td>${statusBadge(v.status)}</td>
            <td>${inspBadge}</td>
            <td>
                <button class="btn btn-sm btn-edit" onclick="editVehicle(${v.id})">編集</button>
                <button class="btn btn-sm btn-danger" onclick="deleteVehicle(${v.id})">削除</button>
            </td>
        </tr>`;
    }).join('') || '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:40px">車両が登録されていません</td></tr>';
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
    if (!confirm('この車両を削除しますか？')) return;
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

    document.getElementById('drivers-table').innerHTML = drivers.map(d => {
        const monthMins = driverHours[d.id] || 0;
        const monthH = Math.floor(monthMins / 60);
        const monthM = monthMins % 60;
        const yearMins = driverYearHours[d.id] || 0;
        const yearH = Math.round(yearMins / 60);
        const pct = Math.round(yearMins / yearLimit * 100);
        const barColor = pct >= 95 ? 'red' : pct >= 80 ? 'orange' : 'blue';
        return `<tr>
            <td><strong>${d.name}</strong></td>
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
    if (id) await apiPut(`/drivers/${id}`, data); else await apiPost('/drivers', data);
    closeModal(); loadDrivers();
}

async function editDriver(id) {
    const drivers = await apiGet('/drivers');
    const d = drivers.find(x => x.id === id);
    if (d) openDriverModal(d);
}

async function deleteDriver(id) {
    if (!confirm('このドライバーを削除しますか？')) return;
    await apiDelete(`/drivers/${id}`); loadDrivers();
}

// ===== 案件管理 =====
async function loadShipments() {
    const shipments = await apiGet('/shipments');
    document.getElementById('shipments-table').innerHTML = shipments.map(s => {
        const freqLabel = s.frequency_type === '単発' ? '' : s.frequency_type === '毎日' ? '🔁毎日' : `🔁${s.frequency_days}`;
        return `<tr>
            <td><a href="#" onclick="event.preventDefault();editShipment(${s.id})" class="link-cell">${s.name || '(未設定)'}</a></td>
            <td><strong>${s.client_name}</strong></td>
            <td>${s.cargo_description || '-'}</td>
            <td>${s.pickup_address} → ${s.delivery_address}</td>
            <td>${s.pickup_date}</td>
            <td>¥${s.price.toLocaleString()}</td>
            <td>${freqLabel || '単発'}</td>
            <td>${statusBadge(s.status)}</td>
            <td>
                <button class="btn btn-sm btn-edit" onclick="editShipment(${s.id})">編集</button>
                <button class="btn btn-sm btn-danger" onclick="deleteShipment(${s.id})">削除</button>
            </td>
        </tr>`;
    }).join('') || '<tr><td colspan="9" style="text-align:center;color:#94a3b8;padding:40px">案件が登録されていません</td></tr>';
}

async function openShipmentModal(shipment = null) {
    const isEdit = !!shipment;
    const today = new Date().toISOString().split('T')[0];
    const freqType = shipment?.frequency_type || '単発';
    const freqDays = (shipment?.frequency_days || '').split(',').filter(Boolean);
    const clients = await apiGet('/clients');
    document.getElementById('modal-title').textContent = isEdit ? '案件編集' : '新規案件';
    document.getElementById('modal-body').innerHTML = `
        <div class="form-group">
            <label>案件名</label>
            <input type="text" id="f-s-name" value="${shipment?.name || ''}" placeholder="例: A社定期便">
        </div>
        <div class="form-group">
            <label>荷主名</label>
            <div style="display:flex;gap:8px">
                <select id="f-s-client-select" onchange="onClientSelect()" style="flex:1">
                    <option value="">-- 選択 or 手入力 --</option>
                    ${clients.map(c => `<option value="${c.name}" ${shipment?.client_name === c.name ? 'selected' : ''}>${c.name}</option>`).join('')}
                </select>
                <input type="text" id="f-s-client" value="${shipment?.client_name || ''}" placeholder="手入力も可" style="flex:1">
            </div>
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
            <label>頻度</label>
            <select id="f-s-freq-type" onchange="toggleFreqDays()">
                ${['単発', '毎日', '曜日指定'].map(f =>
                    `<option ${freqType === f ? 'selected' : ''}>${f}</option>`).join('')}
            </select>
        </div>
        <div class="form-group" id="freq-days-group" style="display:${freqType === '曜日指定' ? 'block' : 'none'}">
            <label>曜日選択</label>
            <div class="freq-days-row">
                ${['月', '火', '水', '木', '金', '土', '日'].map(d =>
                    `<label class="freq-day-check"><input type="checkbox" value="${d}" ${freqDays.includes(d) ? 'checked' : ''}> ${d}</label>`).join('')}
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

function toggleFreqDays() {
    const type = document.getElementById('f-s-freq-type').value;
    document.getElementById('freq-days-group').style.display = type === '曜日指定' ? 'block' : 'none';
}

async function saveShipment(id) {
    const freqType = document.getElementById('f-s-freq-type').value;
    let freqDays = '';
    if (freqType === '曜日指定') {
        freqDays = [...document.querySelectorAll('#freq-days-group input:checked')].map(cb => cb.value).join(',');
    }
    const data = {
        name: document.getElementById('f-s-name').value,
        client_name: document.getElementById('f-s-client').value,
        cargo_description: document.getElementById('f-s-cargo').value,
        weight: parseFloat(document.getElementById('f-s-weight').value),
        pickup_address: document.getElementById('f-s-pickup').value,
        delivery_address: document.getElementById('f-s-delivery').value,
        pickup_date: document.getElementById('f-s-pickup-date').value,
        delivery_date: document.getElementById('f-s-delivery-date').value,
        price: parseInt(document.getElementById('f-s-price').value),
        frequency_type: freqType,
        frequency_days: freqDays,
        status: document.getElementById('f-s-status').value,
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

async function deleteShipment(id) {
    if (!confirm('この案件を削除しますか？')) return;
    await apiDelete(`/shipments/${id}`); loadShipments();
}

// ===== 荷主管理 =====
async function loadClients() {
    const clients = await apiGet('/clients');
    document.getElementById('clients-table').innerHTML = clients.map(c => `
        <tr>
            <td><strong>${c.name}</strong></td>
            <td>${c.address || '-'}</td>
            <td>${c.phone || '-'}</td>
            <td>${c.contact_person || '-'}</td>
            <td>${c.notes || '-'}</td>
            <td>
                <button class="btn btn-sm btn-edit" onclick="editClient(${c.id})">編集</button>
                <button class="btn btn-sm btn-danger" onclick="deleteClient(${c.id})">削除</button>
            </td>
        </tr>
    `).join('') || '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:40px">荷主企業が登録されていません</td></tr>';
}

function openClientModal(client = null) {
    const isEdit = !!client;
    document.getElementById('modal-title').textContent = isEdit ? '荷主編集' : '新規荷主';
    document.getElementById('modal-body').innerHTML = `
        <div class="form-group">
            <label>企業名</label>
            <input type="text" id="f-cl-name" value="${client?.name || ''}">
        </div>
        <div class="form-group">
            <label>住所</label>
            <input type="text" id="f-cl-address" value="${client?.address || ''}">
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>電話番号</label>
                <input type="text" id="f-cl-phone" value="${client?.phone || ''}">
            </div>
            <div class="form-group">
                <label>担当者</label>
                <input type="text" id="f-cl-contact" value="${client?.contact_person || ''}">
            </div>
        </div>
        <div class="form-group">
            <label>備考</label>
            <textarea id="f-cl-notes">${client?.notes || ''}</textarea>
        </div>
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
        contact_person: document.getElementById('f-cl-contact').value,
        notes: document.getElementById('f-cl-notes').value,
    };
    if (!data.name) return alert('企業名は必須です');
    if (id) await apiPut(`/clients/${id}`, data); else await apiPost('/clients', data);
    closeModal(); loadClients();
}

async function editClient(id) {
    const clients = await apiGet('/clients');
    const c = clients.find(x => x.id === id);
    if (c) openClientModal(c);
}

async function deleteClient(id) {
    if (!confirm('この荷主企業を削除しますか？')) return;
    await apiDelete(`/clients/${id}`); loadClients();
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
    loadMapMarkers();
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
    const todayDispatches = dispatches.filter(d => d.date === selectedDate);
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
            const line = L.polyline([pickupCoords, deliveryCoords], {
                color: vColor, weight: 4, opacity: 0.8, dashArray: '8, 6'
            }).addTo(map);
            line.bindPopup(`<strong style="color:${vColor}">${d.vehicle_number}</strong>: ${d.pickup_address} → ${d.delivery_address}`);
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
async function loadRevenue() {
    const [data, shipments, dispatches] = await Promise.all([
        apiGet('/dashboard'), apiGet('/shipments'), apiGet('/dispatches')
    ]);
    const completed = shipments.filter(s => s.status === '完了');
    document.getElementById('rev-monthly').textContent = `¥${data.monthly_revenue.toLocaleString()}`;
    document.getElementById('rev-completed').textContent = data.monthly_completed;
    const avg = data.monthly_completed > 0 ? Math.round(data.monthly_revenue / data.monthly_completed) : 0;
    document.getElementById('rev-avg').textContent = `¥${avg.toLocaleString()}`;

    // 【機能2】車両別売上
    const vehicleRevenue = {};
    dispatches.forEach(d => {
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
        if (s.price > 0) {
            clientRevenue[s.client_name] = (clientRevenue[s.client_name] || 0) + s.price;
        }
    });
    const maxCRev = Math.max(...Object.values(clientRevenue), 1);
    document.getElementById('rev-by-client').innerHTML = Object.entries(clientRevenue)
        .sort((a, b) => b[1] - a[1])
        .map(([name, rev]) => `<div class="rev-bar-row">
            <span class="rev-bar-label">${name}</span>
            <div class="rev-bar-track"><div class="rev-bar-fill green" style="width:${(rev / maxCRev) * 100}%"></div></div>
            <span class="rev-bar-value">¥${rev.toLocaleString()}</span>
        </div>`).join('') || '<p style="color:var(--text-light);font-size:0.85rem">データなし</p>';

    // 【機能5】請求一覧テーブル
    let totalInvoice = 0;
    document.getElementById('revenue-table').innerHTML = completed.map(s => {
        totalInvoice += s.price;
        return `<tr>
            <td>${s.client_name}</td>
            <td>${s.cargo_description || '-'}</td>
            <td>${s.pickup_address} → ${s.delivery_address}</td>
            <td>${s.delivery_date}</td>
            <td><strong>¥${s.price.toLocaleString()}</strong></td>
        </tr>`;
    }).join('') + (completed.length > 0 ? `<tr style="background:#f8fafc;font-weight:700">
        <td colspan="4" style="text-align:right">合計</td>
        <td>¥${totalInvoice.toLocaleString()}</td>
    </tr>` : '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:40px">完了済み案件がありません</td></tr>');
}

// 【機能5】請求一覧印刷
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
    if (!confirm(`本日(${today})の配車 ${dispatches.length}件から日報を自動生成しますか？`)) return;

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
    if (!confirm('この日報を削除しますか？')) return;
    await apiDelete(`/reports/${id}`); loadReports();
}

// ===== ユーティリティ =====
function statusBadge(status) {
    const colors = {
        '空車': 'green', '稼働中': 'blue', '整備中': 'orange',
        '待機中': 'green', '運行中': 'blue', '休憩中': 'orange', '非番': 'gray',
        '未配車': 'orange', '配車済': 'blue', '完了': 'green', 'キャンセル': 'red', '予定': 'purple',
    };
    return `<span class="badge badge-${colors[status] || 'gray'}">${status}</span>`;
}

function showModal() { document.getElementById('modal-overlay').classList.add('active'); }
function closeModal() { document.getElementById('modal-overlay').classList.remove('active'); }
