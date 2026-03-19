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
                     vendors, feedback)

Base.metadata.create_all(bind=engine)

app = FastAPI(title="配車管理システム")


@app.on_event("startup")
def seed_on_startup():
    """DBが空の場合テストデータ投入、既存DBにはカラム追加"""
    import logging
    logger = logging.getLogger("startup")
    from database import SessionLocal, DB_PATH
    from models import Vehicle
    from sqlalchemy import text
    logger.info(f"DB path: {DB_PATH}")
    db = SessionLocal()
    try:
        count = db.query(Vehicle).count()
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
        ]
        for table, col, coltype in migrate_cols:
            try:
                db.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {coltype}"))
                db.commit()
            except Exception:
                db.rollback()
    finally:
        db.close()

# uploads ディレクトリ作成
os.makedirs(os.path.join(os.path.dirname(__file__), "uploads"), exist_ok=True)

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


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    return templates.TemplateResponse("login.html", {"request": request})


@app.get("/lp", response_class=HTMLResponse)
async def landing_page(request: Request):
    return templates.TemplateResponse("lp.html", {"request": request})


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    # ルートドメイン（unsoubako.com）の場合はLPを表示
    host = request.headers.get("host", "")
    # サブドメインなし（ルートドメイン or www）の場合はLP
    if host in ("unsoubako.com", "www.unsoubako.com"):
        return templates.TemplateResponse("lp.html", {"request": request})
    return templates.TemplateResponse("index.html", {"request": request})


# サブアプリ（別ページ）
@app.get("/app/top", response_class=HTMLResponse)
async def app_top(request: Request):
    return templates.TemplateResponse("app_top.html", {"request": request})


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
