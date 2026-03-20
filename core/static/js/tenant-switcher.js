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

        // 挿入先: topnav (サブアプリ) or topbar-right (配車アプリindex.html)
        var nav = document.querySelector('nav.topnav') || document.querySelector('nav');
        var topbarRight = document.querySelector('.topbar-right');
        var container = nav || topbarRight;
        if (!container) return;
        // 既に挿入済みなら何もしない
        if (container.querySelector('.tenant-switcher')) return;
        if (topbarRight && topbarRight.querySelector('.tenant-switcher')) return;

        var isTopbar = !nav && !!topbarRight;

        var select = document.createElement('select');
        select.className = 'tenant-switcher';
        if (isTopbar) {
            // 配車アプリ（topbar）用: 濃い背景に合わせる
            select.style.cssText = 'font-size:0.8rem;padding:4px 10px;border-radius:6px;border:1px solid #d1d5db;background:#fff;color:#334155;cursor:pointer;font-weight:600';
        } else {
            // サブアプリ（topnav）用: 右寄せ
            select.style.cssText = 'font-size:0.8rem;padding:3px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.4);background:rgba(255,255,255,0.1);color:#fff;cursor:pointer;margin-left:auto;margin-right:8px';
        }

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

        if (isTopbar) {
            // 配車アプリ: topbar-rightの先頭（ユーザー名の前）に挿入
            topbarRight.insertBefore(select, topbarRight.firstChild);
        } else {
            // サブアプリ: navの右側（フィードバック・ログアウトボタンの前）に挿入
            var autoMarginEl = null;
            var children = container.children;
            for (var i = 0; i < children.length; i++) {
                if (children[i].style.marginLeft === 'auto') {
                    autoMarginEl = children[i];
                    children[i].style.marginLeft = '';
                    break;
                }
            }
            if (autoMarginEl) {
                container.insertBefore(select, autoMarginEl);
            } else {
                container.appendChild(select);
            }
        }
    }

    function tryBuild() {
        var cached = localStorage.getItem('user_info') || localStorage.getItem('user');
        if (cached) {
            try {
                var user = JSON.parse(cached);
                buildSwitcher(user);
                return true;
            } catch(e) {}
        }
        return false;
    }

    // まずlocalStorageから即座に表示を試みる（API不要）
    if (tryBuild()) return;

    // localStorageにデータがない場合:
    // 1. app.js の loadUserInfo() 完了後にlocalStorageにデータが入るので少し待って再試行
    // 2. それでもなければAPIコール
    var retryCount = 0;
    var retryInterval = setInterval(function() {
        retryCount++;
        if (tryBuild() || retryCount >= 10) {
            clearInterval(retryInterval);
            if (retryCount >= 10 && !tryBuild()) {
                // 最終手段: APIコール
                fetch('/api/auth/me', {
                    headers: { 'Authorization': 'Bearer ' + token }
                })
                .then(function(r) { if (!r.ok) throw new Error(); return r.json(); })
                .then(function(user) {
                    localStorage.setItem('user_info', JSON.stringify(user));
                    buildSwitcher(user);
                })
                .catch(function() {});
            }
        }
    }, 200);
})();
