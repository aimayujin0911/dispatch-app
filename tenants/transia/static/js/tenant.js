/**
 * トランシアテナント固有JS: マトリクス配車表機能
 * core の _tenantDispatchHook を利用してマトリクス表示を追加
 */

// マトリクス表示モード状態
window._dispatchViewMode = 'gantt'; // 'gantt' | 'matrix'

// テナント配車フック: マトリクスモード時にtrue返却で元のガント描画をスキップ
window._tenantDispatchHook = async function() {
    if (window._dispatchViewMode !== 'matrix') {
        // ガントモード: フック処理しない（元の描画後にボタン注入）
        // 少し遅延して元の描画完了を待つ
        setTimeout(_injectMatrixToggleButton, 100);
        return false;
    }

    // ===== マトリクスモード =====
    const baseDate = new Date(calendarDate);
    baseDate.setHours(0, 0, 0, 0);

    // 1ヶ月分のデータ取得
    const [dispatches, vehicles, shipments, partners] = await Promise.all([
        apiGet(`/dispatches?month_start=${fmt(baseDate)}`),
        cachedApiGet('/vehicles'),
        cachedApiGet('/shipments'),
        cachedApiGet('/partners'),
    ]);

    // フィルタ
    const vehicleTypes = [...new Set(vehicles.map(v => v.type))].sort();
    const capacities = [...new Set(vehicles.map(v => v.capacity))].sort((a, b) => a - b);
    const filterType = document.getElementById('cal-filter-type')?.value || '';
    const filterCap = document.getElementById('cal-filter-cap')?.value || '';
    let filteredVehicles = vehicles.slice();
    if (filterType) filteredVehicles = filteredVehicles.filter(v => v.type === filterType);
    if (filterCap) filteredVehicles = filteredVehicles.filter(v => String(v.capacity) === String(filterCap));

    // 31日分の日付生成
    const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
    const matrixDays = [];
    for (let i = 0; i < 31; i++) {
        const md = new Date(baseDate);
        md.setDate(md.getDate() + i);
        matrixDays.push(md);
    }
    const matrixDayStrs = matrixDays.map(d => fmt(d));

    const calContainer = document.getElementById('dispatch-calendar');
    calContainer.innerHTML = _buildMatrixControls(vehicleTypes, capacities, filterType, filterCap, baseDate)
        + _buildMatrixView(matrixDays, matrixDayStrs, dayNames, dispatches, filteredVehicles, partners);

    return true; // 元の描画をスキップ
};

// マトリクス表示切替
window.toggleDispatchView = function() {
    window._dispatchViewMode = window._dispatchViewMode === 'gantt' ? 'matrix' : 'gantt';
    loadDispatchCalendar();
};

// 月送り
window.changeMonth = function(dir) {
    calendarDate.setMonth(calendarDate.getMonth() + dir);
    loadDispatchCalendar();
};

// マトリクスモードのコントロールバー
function _buildMatrixControls(vehicleTypes, capacities, filterType, filterCap, baseDate) {
    return `<div class="cal-controls" style="gap:8px">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:nowrap">
            <button class="btn btn-sm" onclick="changeMonth(-1)">◀ 前月</button>
            <button class="btn btn-sm" onclick="calendarDate=new Date();selectedDayIndex=0;loadDispatchCalendar()">今月</button>
            <button class="btn btn-sm" onclick="changeMonth(1)">翌月 ▶</button>
            <span style="font-size:1.1rem;font-weight:700;margin:0 4px;white-space:nowrap">${baseDate.getFullYear()}年${baseDate.getMonth()+1}月</span>
            <input type="date" class="input-date" value="${fmt(baseDate)}" onchange="calendarDate=new Date(this.value+'T00:00:00');selectedDayIndex=0;loadDispatchCalendar()" title="日付を選択" style="width:140px">
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:nowrap">
            <button class="btn btn-sm" onclick="printDispatchTable()" title="印刷">🖨</button>
            <select id="cal-filter-type" class="select" onchange="loadDispatchCalendar()" style="margin-left:auto">
                <option value="">全車種</option>
                ${vehicleTypes.map(t => `<option value="${t}" ${filterType === t ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
            <select id="cal-filter-cap" class="select" onchange="loadDispatchCalendar()">
                <option value="">全車格</option>
                ${capacities.map(c => `<option value="${c}" ${filterCap == c ? 'selected' : ''}>${c}t</option>`).join('')}
            </select>
            <button class="btn btn-sm" onclick="toggleDispatchView()" style="background:#64748b;color:#fff;font-weight:600">ガント表示</button>
        </div>
    </div>`;
}

// マトリクスビュー: 日付(行) × 車両(列)
function _buildMatrixView(days, dayStrs, dayNames, dispatches, vehicles, partners) {
    // 協力会社を集計
    const pDisp = dispatches.filter(d => d.partner_id || d.is_partner);
    const pMap = {};
    pDisp.forEach(d => {
        const pName = d.partner_name || '不明';
        if (!pMap[pName]) pMap[pName] = { name: pName, id: d.partner_id, dispatches: [] };
        pMap[pName].dispatches.push(d);
    });
    const pEntries = Object.values(pMap);

    const allCols = [
        ...vehicles.map(v => ({ type: 'vehicle', data: v })),
        ...pEntries.map(p => ({ type: 'partner', data: p }))
    ];

    let html = `<div class="matrix-wrapper"><table class="matrix-table">`;

    // ヘッダー
    html += `<thead><tr><th class="matrix-th-date">日付</th>`;
    allCols.forEach(col => {
        if (col.type === 'vehicle') {
            const v = col.data;
            const shortNum = v.number.split(' ').slice(-1)[0] || v.number;
            const isMaint = v.status === '整備中';
            html += `<th class="matrix-th-vehicle${isMaint ? ' matrix-th-maint' : ''}">${shortNum}<br><span class="matrix-th-vinfo">${v.type} ${v.capacity}t</span></th>`;
        } else {
            html += `<th class="matrix-th-vehicle matrix-th-partner">${col.data.name}<br><span class="matrix-th-vinfo">協力</span></th>`;
        }
    });
    html += `</tr></thead><tbody>`;

    // 日付行
    days.forEach((d, di) => {
        const dayStr = dayStrs[di];
        const isT = isToday(d);
        const dow = dayNames[d.getDay()];
        const isSun = d.getDay() === 0;
        const isSat = d.getDay() === 6;
        const rowCls = isT ? 'matrix-row-today' : isSun ? 'matrix-row-sun' : isSat ? 'matrix-row-sat' : '';

        html += `<tr class="${rowCls}">`;
        html += `<td class="matrix-date-cell${isT ? ' matrix-today' : ''}"><span class="matrix-date-num">${d.getDate()}</span><span class="matrix-date-dow${isSun ? ' sun' : ''}${isSat ? ' sat' : ''}">${dow}</span></td>`;

        allCols.forEach(col => {
            let cellDisp;
            if (col.type === 'vehicle') {
                cellDisp = dispatches.filter(dp => dp.vehicle_id === col.data.id && (dp.date === dayStr || (dp.end_date && dp.date <= dayStr && dp.end_date >= dayStr)));
            } else {
                cellDisp = col.data.dispatches.filter(dp => dp.date === dayStr || (dp.end_date && dp.date <= dayStr && dp.end_date >= dayStr));
            }
            const vehicleId = col.type === 'vehicle' ? col.data.id : null;
            const partnerId = col.type === 'partner' ? col.data.id : null;

            if (cellDisp.length === 0) {
                const onclick = vehicleId
                    ? `onclick="selectedDayIndex=${di % CAL_DAYS};openQuickDispatchModal('${dayStr}','08:00','17:00',${vehicleId})"`
                    : (partnerId ? `onclick="selectedDayIndex=${di % CAL_DAYS};openQuickDispatchModal('${dayStr}','08:00','17:00',null,null,${partnerId})"` : '');
                html += `<td class="matrix-cell matrix-cell-empty" ${onclick}></td>`;
            } else {
                let inner = '';
                cellDisp.forEach(dp => {
                    const dc = getDriverColor(dp.driver_id);
                    const driverName = dp.driver_name || '';
                    const pickup = (dp.pickup_address || '').substring(0, 4);
                    const delivery = (dp.delivery_address || '').substring(0, 4);
                    inner += `<div class="matrix-dispatch" style="border-left:3px solid ${dc.border};background:${dc.bg}" onclick="event.stopPropagation();showDispatchDetail(${dp.id})">
                        <span class="matrix-d-driver" style="color:${dc.text}">${driverName}</span>
                        <span class="matrix-d-route">${pickup}→${delivery}</span>
                    </div>`;
                });
                html += `<td class="matrix-cell">${inner}</td>`;
            }
        });
        html += `</tr>`;
    });

    html += `</tbody></table></div>`;
    return html;
}

// ガント表示にマトリクスボタンを注入
function _injectMatrixToggleButton() {
    // デスクトップ: コントロールバーの最後に追加
    const desktopControls = document.querySelector('.cal-controls');
    if (desktopControls && !desktopControls.querySelector('.matrix-toggle-btn')) {
        const lastRow = desktopControls.querySelector('div:last-child');
        if (lastRow) {
            const btn = document.createElement('button');
            btn.className = 'btn btn-sm matrix-toggle-btn';
            btn.style.cssText = 'background:#f59e0b;color:#fff;font-weight:600';
            btn.textContent = 'マトリクス表示';
            btn.onclick = toggleDispatchView;
            lastRow.appendChild(btn);
        }
    }

    // モバイル: コントロールの2行目に追加
    const mobileRows = document.querySelectorAll('.m-cal-row');
    if (mobileRows.length >= 2) {
        const secondRow = mobileRows[1];
        if (!secondRow.querySelector('.matrix-toggle-btn')) {
            const btn = document.createElement('button');
            btn.className = 'm-cal-btn m-cal-matrix-btn matrix-toggle-btn';
            btn.textContent = 'マトリクス表示';
            btn.onclick = toggleDispatchView;
            secondRow.appendChild(btn);
        }
    }
}
