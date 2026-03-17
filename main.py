import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse
from database import engine, Base
from routers import vehicles, drivers, shipments, dispatches, reports, dashboard, clients

Base.metadata.create_all(bind=engine)

app = FastAPI(title="配車管理システム")


@app.on_event("startup")
def seed_on_startup():
    """DBが空の場合テストデータ投入、既存DBにはカラム追加"""
    from database import SessionLocal
    from models import Vehicle
    from sqlalchemy import text
    db = SessionLocal()
    try:
        if db.query(Vehicle).count() == 0:
            from seed_data import seed
            seed()
        # 既存DBにカラム追加（なければ追加）
        migrate_cols = [
            ("shipments", "name", "VARCHAR(100) DEFAULT ''"),
            ("shipments", "frequency_type", "VARCHAR(20) DEFAULT '単発'"),
            ("shipments", "frequency_days", "VARCHAR(50) DEFAULT ''"),
            ("vehicles", "chassis_number", "VARCHAR(30) DEFAULT ''"),
            ("vehicles", "first_registration", "VARCHAR(10) DEFAULT ''"),
            ("vehicles", "inspection_expiry", "VARCHAR(10) DEFAULT ''"),
            ("dispatches", "end_date", "DATE"),
        ]
        for table, col, coltype in migrate_cols:
            try:
                db.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {coltype}"))
                db.commit()
            except Exception:
                db.rollback()
    finally:
        db.close()

app.mount("/static", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static")), name="static")
templates = Jinja2Templates(directory=os.path.join(os.path.dirname(__file__), "templates"))

app.include_router(dashboard.router, prefix="/api")
app.include_router(clients.router, prefix="/api/clients", tags=["clients"])
app.include_router(vehicles.router, prefix="/api/vehicles", tags=["vehicles"])
app.include_router(drivers.router, prefix="/api/drivers", tags=["drivers"])
app.include_router(shipments.router, prefix="/api/shipments", tags=["shipments"])
app.include_router(dispatches.router, prefix="/api/dispatches", tags=["dispatches"])
app.include_router(reports.router, prefix="/api/reports", tags=["reports"])


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=True)
