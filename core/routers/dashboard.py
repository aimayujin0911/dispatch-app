from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import func, case, and_
from datetime import date, timedelta
from database import get_db
from models import Vehicle, Driver, Shipment, Dispatch, DailyReport, User
from core.auth import get_current_user

router = APIRouter()


@router.get("/dashboard")
def get_dashboard(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    today = date.today()
    month_start = today.replace(day=1)
    tid = current_user.tenant_id

    # 車両ステータス集計（1クエリ）
    vehicle_stats = db.query(
        func.count(Vehicle.id).label('total'),
        func.sum(case((Vehicle.status == "稼働中", 1), else_=0)).label('active'),
        func.sum(case((Vehicle.status == "空車", 1), else_=0)).label('empty'),
        func.sum(case((Vehicle.status == "整備中", 1), else_=0)).label('maintenance'),
    ).filter(Vehicle.tenant_id == tid).first()

    # ドライバーステータス集計（1クエリ）
    driver_stats = db.query(
        func.count(Driver.id).label('total'),
        func.sum(case((Driver.status == "運行中", 1), else_=0)).label('active'),
        func.sum(case((Driver.status == "待機中", 1), else_=0)).label('standby'),
    ).filter(Driver.tenant_id == tid).first()

    # 今日の配車 + 未配車案件（2クエリ → 並列で問題なし）
    today_dispatches = db.query(func.count(Dispatch.id)).filter(
        Dispatch.tenant_id == tid, Dispatch.date == today
    ).scalar() or 0

    unassigned = db.query(func.count(Shipment.id)).filter(
        Shipment.tenant_id == tid, Shipment.status == "未配車"
    ).scalar() or 0

    # 月間売上 + 完了件数（1クエリ）
    monthly = db.query(
        func.coalesce(func.sum(Shipment.price), 0),
        func.count(Shipment.id),
    ).filter(
        Shipment.tenant_id == tid,
        Shipment.status == "完了",
        Shipment.delivery_date >= month_start,
        Shipment.delivery_date <= today,
    ).first()
    monthly_revenue = monthly[0] if monthly else 0
    monthly_completed = monthly[1] if monthly else 0

    # 直近7日の売上推移（1クエリでGROUP BY）
    week_start = today - timedelta(days=6)
    trend_rows = db.query(
        Shipment.delivery_date,
        func.sum(Shipment.price),
    ).filter(
        Shipment.tenant_id == tid,
        Shipment.status == "完了",
        Shipment.delivery_date >= week_start,
        Shipment.delivery_date <= today,
    ).group_by(Shipment.delivery_date).all()

    trend_map = {str(row[0]): row[1] or 0 for row in trend_rows}
    revenue_trend = []
    for i in range(6, -1, -1):
        d = today - timedelta(days=i)
        revenue_trend.append({"date": str(d), "revenue": trend_map.get(str(d), 0)})

    return {
        "vehicles": {
            "total": vehicle_stats.total or 0,
            "active": vehicle_stats.active or 0,
            "empty": vehicle_stats.empty or 0,
            "maintenance": vehicle_stats.maintenance or 0,
        },
        "drivers": {
            "total": driver_stats.total or 0,
            "active": driver_stats.active or 0,
            "standby": driver_stats.standby or 0,
        },
        "today_dispatches": today_dispatches,
        "unassigned_shipments": unassigned,
        "monthly_revenue": monthly_revenue,
        "monthly_completed": monthly_completed,
        "revenue_trend": revenue_trend,
    }
