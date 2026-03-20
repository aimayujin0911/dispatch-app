/**
 * テナント切替ドロップダウン（ヘッダー用）
 * 複数テナントにアクセス可能なユーザー or オペレーターに表示
 * ※ localStorageからユーザー情報を取得（APIコール不要）
 */
(function() {
    var token = localStorage.getItem('access_token');
    if (!token) return;

    function buildSwitcher(user) {
        if (!user.can_switch_tenant || !user.accessible_tenants || user.accessible_tenants.length <= 1) return;

        var nav = document.querySelector('nav');
        if (!nav) return;
        // 既に挿入済みなら何もしない
        if (nav.querySelector('.tenant-switcher')) return;

        var select = document.createElement('select');
        select.className = 'tenant-switcher';
        select.style.cssText = 'font-size:0.8rem;padding:3px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.4);background:rgba(255,255,255,0.1);color:#fff;cursor:pointer;margin-left:auto;margin-right:8px';

        user.accessible_tenants.forEach(function(t) {
            var opt = document.createElement('option');
            opt.value = t;
            opt.textContent = t;
            opt.style.color = '#000';
            if (t === user.tenant_id) opt.selected = true;
            select.appendChild(opt);
        });

        select.addEventListener('change', function() {
            var tenantId = this.value;
            fetch('/api/auth/switch-tenant', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({ tenant_id: tenantId })
            })
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (data.access_token) {
                    localStorage.setItem('access_token', data.access_token);
                    if (data.user) localStorage.setItem('user', JSON.stringify(data.user));
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
            });
        });

        // navの右側（フィードバック・ログアウトボタンの前）に挿入
        var autoMarginEl = null;
        var children = nav.children;
        for (var i = 0; i < children.length; i++) {
            if (children[i].style.marginLeft === 'auto') {
                autoMarginEl = children[i];
                children[i].style.marginLeft = '';
                break;
            }
        }
        if (autoMarginEl) {
            nav.insertBefore(select, autoMarginEl);
        } else {
            nav.appendChild(select);
        }
    }

    // まずlocalStorageから即座に表示を試みる（API不要）
    var cached = localStorage.getItem('user_info') || localStorage.getItem('user');
    if (cached) {
        try {
            var user = JSON.parse(cached);
            buildSwitcher(user);
            return; // localStorageにデータあればAPIコール不要
        } catch(e) {}
    }

    // localStorageにデータがない場合のみAPIコール
    fetch('/api/auth/me', {
        headers: { 'Authorization': 'Bearer ' + token }
    })
    .then(function(r) { if (!r.ok) throw new Error(); return r.json(); })
    .then(function(user) {
        localStorage.setItem('user_info', JSON.stringify(user));
        buildSwitcher(user);
    })
    .catch(function() {});
})();
