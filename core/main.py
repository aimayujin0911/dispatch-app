import sys
import os

# core/ ディレクトリをパスに追加（相対インポート対応）
CORE_DIR = os.path.dirname(__file__)
PROJECT_ROOT = os.path.dirname(CORE_DIR)
if CORE_DIR not in sys.path:
    sys.path.insert(0, CORE_DIR)
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from fastapi import FastAPI, Request, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, RedirectResponse
from database import engine, Base
from routers import (auth as auth_router, vehicles, drivers, shipments, dispatches, reports, dashboard,
                     clients, partners, partner_invoices, transport_requests,
                     vehicle_notifications, attendance, accounting, export, company_settings,
                     vendors, feedback, inquiries)

Base.metadata.create_all(bind=engine)

app = FastAPI(title="配車管理システム")


@app.on_event("startup")
def seed_on_startup():
    """DBが空の場合テストデータ投入、既存DBにはカラム追加"""
    import logging
    logger = logging.getLogger("startup")
    from database import SessionLocal, DATABASE_URL
    from models import Vehicle
    from sqlalchemy import text
    logger.info(f"DB URL: {DATABASE_URL[:30]}...")
    db = SessionLocal()
    try:
        # FORCE_RESEED: 環境変数が設定されていればDB全テーブルdrop→再seed
        if os.environ.get("FORCE_RESEED") == "1":
            logger.info("FORCE_RESEED=1 detected, dropping all tables...")
            from models import Base
            from database import engine
            Base.metadata.drop_all(bind=engine)
            Base.metadata.create_all(bind=engine)
            logger.info("Tables recreated, running seed...")
            from seed_data import seed
            seed()
            logger.info("FORCE_RESEED completed!")
            db.close()
            return
        # マイグレーション前にモデルクエリすると新カラムでエラーになるため生SQL使用
        count = db.execute(text("SELECT count(*) FROM vehicles")).scalar()
        logger.info(f"Vehicle count: {count}")
        if count == 0:
            logger.info("No vehicles found, running seed...")
            from seed_data import seed
            seed()
            logger.info("Seed completed")
        # 既存DBにカラム追加（なければ追加）
        migrate_cols = [
            ("shipments", "name", "VARCHAR(100) DEFAULT ''"),
            ("shipments", "frequency_type", "VARCHAR(20) DEFAULT '単発'"),
            ("shipments", "frequency_days", "VARCHAR(50) DEFAULT ''"),
            ("vehicles", "chassis_number", "VARCHAR(30) DEFAULT ''"),
            ("vehicles", "first_registration", "VARCHAR(10) DEFAULT ''"),
            ("vehicles", "inspection_expiry", "VARCHAR(10) DEFAULT ''"),
            ("dispatches", "end_date", "DATE"),
            ("shipments", "invoice_status", "VARCHAR(20) DEFAULT '未請求'"),
            ("shipments", "invoice_date", "DATE"),
            ("shipments", "pickup_time", "VARCHAR(50) DEFAULT ''"),
            ("shipments", "delivery_time", "VARCHAR(50) DEFAULT ''"),
            ("shipments", "time_note", "VARCHAR(100) DEFAULT ''"),
            ("clients", "fax", "VARCHAR(20) DEFAULT ''"),
            # Phase2: 新規カラム
            ("clients", "billing_address", "VARCHAR(200) DEFAULT ''"),
            ("clients", "billing_contact", "VARCHAR(50) DEFAULT ''"),
            ("clients", "billing_email", "VARCHAR(100) DEFAULT ''"),
            ("clients", "payment_terms", "VARCHAR(50) DEFAULT '月末締め翌月末払い'"),
            ("clients", "credit_limit", "INTEGER DEFAULT 0"),
            ("clients", "tax_id", "VARCHAR(50) DEFAULT ''"),
            ("clients", "bank_info", "TEXT DEFAULT ''"),
            ("shipments", "waiting_time", "INTEGER DEFAULT 0"),
            ("shipments", "loading_time", "INTEGER DEFAULT 0"),
            ("shipments", "unloading_time", "INTEGER DEFAULT 0"),
            ("attendance", "waiting_time", "INTEGER DEFAULT 0"),
            ("attendance", "loading_time", "INTEGER DEFAULT 0"),
            ("attendance", "unloading_time", "INTEGER DEFAULT 0"),
            ("daily_reports", "waiting_time", "INTEGER DEFAULT 0"),
            ("daily_reports", "loading_time", "INTEGER DEFAULT 0"),
            ("daily_reports", "unloading_time", "INTEGER DEFAULT 0"),
            ("daily_reports", "routes", "TEXT DEFAULT ''"),
            ("daily_reports", "client_names", "VARCHAR(200) DEFAULT ''"),
            ("account_entries", "vehicle_id", "INTEGER"),
            ("partner_invoices", "pdf_filename", "VARCHAR(200) DEFAULT ''"),
            ("company_settings", "postal_code", "VARCHAR(10) DEFAULT ''"),
            ("company_settings", "email", "VARCHAR(100) DEFAULT ''"),
            ("company_settings", "payment_terms", "VARCHAR(100) DEFAULT '月末締め翌月末払い'"),
            ("company_settings", "tax_rate", "INTEGER DEFAULT 10"),
            ("company_settings", "seal_text", "VARCHAR(50) DEFAULT ''"),
            ("company_settings", "invoice_note", "VARCHAR(200) DEFAULT ''"),
            ("company_settings", "smtp_host", "VARCHAR(100) DEFAULT ''"),
            ("company_settings", "smtp_port", "INTEGER DEFAULT 587"),
            ("company_settings", "smtp_user", "VARCHAR(100) DEFAULT ''"),
            ("company_settings", "smtp_password", "VARCHAR(200) DEFAULT ''"),
            ("company_settings", "sender_email", "VARCHAR(100) DEFAULT ''"),
            # Phase3: ドライバー拡張
            ("drivers", "email", "VARCHAR(100) DEFAULT ''"),
            ("drivers", "password_hash", "VARCHAR(200) DEFAULT ''"),
            ("drivers", "license_expiry", "VARCHAR(10) DEFAULT ''"),
            ("drivers", "hire_date", "DATE"),
            ("drivers", "paid_leave_balance", "REAL DEFAULT 10.0"),
            ("drivers", "work_start", "VARCHAR(5) DEFAULT '08:00'"),
            ("drivers", "work_end", "VARCHAR(5) DEFAULT '17:00'"),
            # Phase4: 勤怠拡張（運送業日報項目）
            ("attendance", "vehicle_id", "INTEGER"),
            ("attendance", "departure_time", "VARCHAR(5) DEFAULT ''"),
            ("attendance", "return_time", "VARCHAR(5) DEFAULT ''"),
            ("attendance", "routes", "TEXT DEFAULT ''"),
            ("attendance", "pre_check_time", "VARCHAR(5) DEFAULT ''"),
            ("attendance", "post_check_time", "VARCHAR(5) DEFAULT ''"),
            ("attendance", "alcohol_check", "VARCHAR(20) DEFAULT ''"),
            ("attendance", "fuel_liters", "REAL DEFAULT 0"),
            ("attendance", "fuel_cost", "INTEGER DEFAULT 0"),
            ("attendance", "highway_cost", "INTEGER DEFAULT 0"),
            ("attendance", "highway_sections", "VARCHAR(200) DEFAULT ''"),
            ("attendance", "break_location", "VARCHAR(100) DEFAULT ''"),
            ("attendance", "weather", "VARCHAR(20) DEFAULT ''"),
            ("attendance", "incidents", "TEXT DEFAULT ''"),
            # 営業所対応
            ("vehicles", "branch_id", "INTEGER"),
            ("drivers", "branch_id", "INTEGER"),
            ("shipments", "branch_id", "INTEGER"),
            # 請求単価対応
            ("shipments", "transport_type", "VARCHAR(20) DEFAULT 'ドライ'"),
            ("shipments", "unit_price_type", "VARCHAR(20) DEFAULT '個建'"),
            ("shipments", "unit_price", "REAL DEFAULT 0"),
            ("shipments", "unit_quantity", "REAL DEFAULT 0"),
            # 配車の協力会社対応
            ("dispatches", "partner_id", "INTEGER"),
            # ドライバーログイン対応
            ("users", "login_id", "VARCHAR(50)"),
            ("users", "driver_id", "INTEGER"),
            # 車両: 温度帯・パワーゲート・固定ドライバー
            ("vehicles", "temperature_zone", "VARCHAR(20) DEFAULT '常温'"),
            ("vehicles", "has_power_gate", "BOOLEAN DEFAULT false"),
            ("vehicles", "default_driver_id", "INTEGER"),
            # テナント表示設定
            ("company_settings", "dispatch_view_mode", "VARCHAR(20) DEFAULT 'gantt'"),
            # 案件: 温度帯
            ("shipments", "temperature_zone", "VARCHAR(20) DEFAULT '常温'"),
            # 協力会社: メールアドレス
            ("partner_companies", "email", "VARCHAR(100) DEFAULT ''"),
            # 案件: 座標キャッシュ
            ("shipments", "pickup_lat", "FLOAT"),
            ("shipments", "pickup_lng", "FLOAT"),
            ("shipments", "delivery_lat", "FLOAT"),
            ("shipments", "delivery_lng", "FLOAT"),
            # 課（部署）カラム
            ("vehicles", "department", "VARCHAR(10) DEFAULT ''"),
            ("drivers", "department", "VARCHAR(10) DEFAULT ''"),
            ("shipments", "department", "VARCHAR(50) DEFAULT ''"),
        ]
        for table, col, coltype in migrate_cols:
            try:
                db.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {coltype}"))
                db.commit()
            except Exception:
                db.rollback()
        # オペレーター（運営管理者）アカウント自動作成
        from models import User
        from auth import hash_password
        op_email = "yuujin@li-go.jp"
        existing_op = db.query(User).filter(User.email == op_email).first()
        if not existing_op:
            op_user = User(
                email=op_email,
                password_hash=hash_password("Ligo0106"),
                name="運営管理者",
                role="operator",
                tenant_id="",
                branch_id=None,
            )
            db.add(op_user)
            db.commit()
            logger.info(f"Operator account created: {op_email}")
        else:
            # 既存ユーザーがoperatorじゃなければ更新
            if existing_op.role != "operator":
                existing_op.role = "operator"
                existing_op.password_hash = hash_password("Ligo0106")
                db.commit()
                logger.info(f"Updated existing user to operator: {op_email}")
        # パフォーマンス: 複合インデックス追加（既存DBに対応）
        perf_indexes = [
            "CREATE INDEX IF NOT EXISTS ix_dispatches_tenant_date ON dispatches(tenant_id, date)",
            "CREATE INDEX IF NOT EXISTS ix_shipments_tenant_status ON shipments(tenant_id, status)",
            "CREATE INDEX IF NOT EXISTS ix_shipments_tenant_delivery ON shipments(tenant_id, delivery_date)",
        ]
        for idx_sql in perf_indexes:
            try:
                db.execute(text(idx_sql))
                db.commit()
            except Exception:
                db.rollback()
        # デモデータのtenant_idが空のレコードを "demo" に修正
        demo_tables = ["drivers", "vehicles", "shipments", "clients", "dispatches"]
        for tbl in demo_tables:
            try:
                db.execute(text(
                    f"UPDATE {tbl} SET tenant_id = 'demo' WHERE tenant_id IS NULL OR tenant_id = ''"
                ))
                db.commit()
            except Exception:
                db.rollback()
        # Userも同様（operatorと空テナント以外）
        try:
            db.execute(text(
                "UPDATE users SET tenant_id = 'demo' WHERE (tenant_id IS NULL OR tenant_id = '') AND role != 'operator'"
            ))
            db.commit()
        except Exception:
            db.rollback()
        # usersテーブルのemail NOT NULL制約を解除（モデルはnullable=Trueだが古いDBはNOT NULL）
        try:
            db.execute(text("ALTER TABLE users ALTER COLUMN email DROP NOT NULL"))
            db.commit()
            print("[DB fix] users.email NOT NULL constraint dropped", flush=True)
        except Exception:
            db.rollback()
        # 既存ドライバーに対応するUserが無ければ自動作成（Driver⇔User統合）
        try:
            linked = set(
                r[0] for r in db.execute(text(
                    "SELECT driver_id FROM users WHERE driver_id IS NOT NULL"
                )).fetchall()
            )
            orphans = db.execute(text(
                "SELECT id, name, tenant_id FROM drivers"
            )).fetchall()
            created = 0
            for did, dname, dtenant in orphans:
                if did not in linked:
                    db.execute(text(
                        "INSERT INTO users (name, email, role, tenant_id, driver_id, password_hash, is_active, login_id) "
                        "VALUES (:name, :email, 'driver', :tid, :did, '', true, :lid)"
                    ), {"name": dname, "email": f"driver_{did}@{dtenant or 'demo'}.local", "tid": dtenant or "demo", "did": did, "lid": f"driver_{did}"})
                    created += 1
            if created:
                db.commit()
                print(f"[Driver-User sync] Created {created} users", flush=True)
            else:
                print(f"[Driver-User sync] No orphans (linked={len(linked)}, drivers={len(orphans)})", flush=True)
        except Exception as e:
            db.rollback()
            print(f"[Driver-User sync] FAILED: {e}", flush=True)
        # 座標キャッシュが無い案件をバックグラウンドでジオコーディング
        try:
            no_geo = db.execute(text(
                "SELECT id FROM shipments WHERE (pickup_lat IS NULL AND pickup_address != '' AND pickup_address IS NOT NULL) "
                "OR (delivery_lat IS NULL AND delivery_address != '' AND delivery_address IS NOT NULL) LIMIT 50"
            )).fetchall()
            if no_geo:
                import threading
                def bg_geocode():
                    from routers.shipments import geocode_shipment_bg
                    for row in no_geo:
                        geocode_shipment_bg(row[0])
                threading.Thread(target=bg_geocode, daemon=True).start()
                print(f"[Geocode] Queueing {len(no_geo)} shipments for background geocoding", flush=True)
        except Exception as e:
            print(f"[Geocode] Init failed: {e}", flush=True)
        # トランシアのダミーデータ削除（実データ投入前のクリーンアップ）
        try:
            for tbl in ['dispatches', 'shipments', 'vehicles', 'drivers', 'clients']:
                # 車番がTRA-で始まるダミー車両や、ダミードライバーを削除
                if tbl == 'vehicles':
                    db.execute(text("DELETE FROM vehicles WHERE tenant_id = 'transia' AND chassis_number LIKE 'TRA-%'"))
                elif tbl == 'drivers':
                    db.execute(text("DELETE FROM drivers WHERE tenant_id = 'transia' AND phone LIKE '090-000%'"))
                elif tbl == 'clients':
                    db.execute(text("DELETE FROM clients WHERE tenant_id = 'transia' AND phone LIKE '0480-XX%'"))
                elif tbl == 'shipments':
                    db.execute(text("DELETE FROM shipments WHERE tenant_id = 'transia' AND name LIKE '%定期便' OR (tenant_id = 'transia' AND name LIKE '%冷蔵便') OR (tenant_id = 'transia' AND name LIKE '%配送')"))
            db.commit()
        except Exception:
            db.rollback()
        # トランシアテナント: バージョンチェックで自動更新
        try:
            from seed_data import seed_transia
            seed_transia()
        except Exception as e:
                logger.error(f"Transia seed failed: {e}")
    finally:
        db.close()

# uploads ディレクトリ作成
os.makedirs(os.path.join(os.path.dirname(__file__), "uploads"), exist_ok=True)

# テナント固有の静的ファイルをマウント（/static より先にマウントして優先させる）
# TENANT_ID環境変数がある場合はそのテナントのみ、なければ全テナントを個別マウント
_tenant_id = os.environ.get("TENANT_ID", "")
_tenants_dir = os.path.join(os.path.dirname(__file__), "..", "tenants")
if _tenant_id:
    _tenant_static = os.path.join(_tenants_dir, _tenant_id, "static")
    if os.path.isdir(_tenant_static):
        app.mount("/static/tenant", StaticFiles(directory=_tenant_static), name="tenant_static")
        app.mount(f"/static/tenants/{_tenant_id}", StaticFiles(directory=_tenant_static), name=f"tenant_static_{_tenant_id}")
# マルチテナント: 各テナントの静的ファイルを /static/tenants/{tenant_id}/ でマウント
if os.path.isdir(_tenants_dir):
    for _t in os.listdir(_tenants_dir):
        _ts = os.path.join(_tenants_dir, _t, "static")
        if os.path.isdir(_ts) and not _t.startswith("_") and _t != _tenant_id:
            app.mount(f"/static/tenants/{_t}", StaticFiles(directory=_ts), name=f"tenant_static_{_t}")

app.mount("/static", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static")), name="static")
app.mount("/uploads", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "uploads")), name="uploads")
templates = Jinja2Templates(directory=os.path.join(os.path.dirname(__file__), "templates"))

app.include_router(auth_router.router, prefix="/api/auth", tags=["auth"])
app.include_router(dashboard.router, prefix="/api")
app.include_router(clients.router, prefix="/api/clients", tags=["clients"])
app.include_router(vehicles.router, prefix="/api/vehicles", tags=["vehicles"])
app.include_router(drivers.router, prefix="/api/drivers", tags=["drivers"])
app.include_router(shipments.router, prefix="/api/shipments", tags=["shipments"])
app.include_router(dispatches.router, prefix="/api/dispatches", tags=["dispatches"])
app.include_router(reports.router, prefix="/api/reports", tags=["reports"])
app.include_router(partners.router, prefix="/api/partners", tags=["partners"])
app.include_router(partner_invoices.router, prefix="/api/partner-invoices", tags=["partner_invoices"])
app.include_router(transport_requests.router, prefix="/api/transport-requests", tags=["transport_requests"])
app.include_router(vehicle_notifications.router, prefix="/api/vehicle-notifications", tags=["vehicle_notifications"])
app.include_router(attendance.router, prefix="/api/attendance", tags=["attendance"])
app.include_router(accounting.router, prefix="/api/accounting", tags=["accounting"])
app.include_router(export.router, prefix="/api/export", tags=["export"])
app.include_router(company_settings.router, prefix="/api/settings", tags=["settings"])
app.include_router(vendors.router, prefix="/api/vendors", tags=["vendors"])
app.include_router(feedback.router, prefix="/api/feedback", tags=["feedback"])
app.include_router(inquiries.router, prefix="/api/inquiries", tags=["inquiries"])


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    host = request.headers.get("host", "").split(":")[0]  # ポート除去
    # サブドメインからのアクセスはルートドメインにリダイレクト
    tenant_domains = {"hakoprofor.jp", "unsoubako.com"}
    for d in tenant_domains:
        if host != d and host != f"www.{d}" and host.endswith(f".{d}"):
            return RedirectResponse(url=f"https://{d}/login", status_code=302)
    return templates.TemplateResponse("login.html", {"request": request})


@app.get("/lp", response_class=HTMLResponse)
async def landing_page(request: Request):
    return templates.TemplateResponse("lp.html", {"request": request})


def _resolve_tenant_id(request: Request) -> str:
    """サブドメインまたは環境変数からテナントIDを解決"""
    if _tenant_id:
        return _tenant_id
    host = request.headers.get("host", "").split(":")[0]
    # サブドメインからテナントID抽出: {tenant}.unsoubako.com, {tenant}.hakoprofor.jp
    for domain in ("unsoubako.com", "hakoprofor.jp"):
        if host.endswith(f".{domain}"):
            sub = host[: -(len(domain) + 1)]
            if sub and sub not in ("www", "demo"):
                return sub
    return ""


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    host = request.headers.get("host", "")
    # ?app=1 パラメータがあれば認証済みユーザーとしてアプリ表示
    tenant = _resolve_tenant_id(request)
    if request.query_params.get("app") == "1":
        return templates.TemplateResponse("index.html", {"request": request, "tenant_id": tenant})
    # サブドメインがある場合はメインアプリ表示
    # 例: demo.hakoprofor.jp → アプリ、hakoprofor.jp → LP
    # テスト環境: unsoubako.com → LP、hakopro-dev の onrender.com → LP
    lp_hosts = ("hakoprofor.jp", "www.hakoprofor.jp", "unsoubako.com", "www.unsoubako.com", "hakopro-dev.onrender.com")
    if host in lp_hosts:
        return templates.TemplateResponse("lp.html", {"request": request})
    return templates.TemplateResponse("index.html", {"request": request, "tenant_id": tenant})


# サブアプリ（別ページ）
@app.get("/app/billing", response_class=HTMLResponse)
async def billing_app(request: Request):
    return templates.TemplateResponse("app_billing.html", {"request": request})


@app.get("/app/attendance", response_class=HTMLResponse)
async def attendance_app(request: Request):
    return templates.TemplateResponse("app_attendance.html", {"request": request})


@app.get("/app/accounting", response_class=HTMLResponse)
async def accounting_app(request: Request):
    return templates.TemplateResponse("app_accounting.html", {"request": request})


@app.get("/app/analysis", response_class=HTMLResponse)
async def analysis_app(request: Request):
    return templates.TemplateResponse("app_analysis.html", {"request": request})


@app.get("/app/reports", response_class=HTMLResponse)
async def reports_app(request: Request):
    return templates.TemplateResponse("app_reports.html", {"request": request})


@app.get("/app/settings", response_class=HTMLResponse)
async def settings_app(request: Request):
    return templates.TemplateResponse("app_settings.html", {"request": request})


@app.get("/app/rollcall", response_class=HTMLResponse)
async def rollcall_app(request: Request):
    return templates.TemplateResponse("app_rollcall.html", {"request": request})


@app.get("/app/users", response_class=HTMLResponse)
async def users_app(request: Request):
    return templates.TemplateResponse("app_users.html", {"request": request})


@app.get("/m/attendance", response_class=HTMLResponse)
async def mobile_attendance(request: Request):
    return templates.TemplateResponse("mobile_attendance.html", {"request": request})


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8001))
    uvicorn.run("core.main:app", host="0.0.0.0", port=port, reload=True)
