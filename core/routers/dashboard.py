from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import func
from datetime import date, timedelta
from database import get_db
from models import Vehicle, Driver, Shipment, Dispatch, DailyReport

router = APIRouter()


@router.get("/dashboard")
def get_dashboard(db: Session = Depends(get_db)):
    today = date.today()
    month_start = today.replace(day=1)

    # 車両ステータス集計
    vehicles_total = db.query(Vehicle).count()
    vehicles_active = db.query(Vehicle).filter(Vehicle.status == "稼働中").count()
    vehicles_empty = db.query(Vehicle).filter(Vehicle.status == "空車").count()
    vehicles_maintenance = db.query(Vehicle).filter(Vehicle.status == "整備中").count()

    # ドライバーステータス集計
    drivers_total = db.query(Driver).count()
    drivers_active = db.query(Driver).filter(Driver.status == "運行中").count()
    drivers_standby = db.query(Driver).filter(Driver.status == "待機中").count()

    # 今日の配車
    today_dispatches = db.query(Dispatch).filter(Dispatch.date == today).count()

    # 未配車案件
    unassigned = db.query(Shipment).filter(Shipment.status == "未配車").count()

    # 月間売上
    monthly_revenue = db.query(func.sum(Shipment.price)).filter(
        Shipment.status == "完了",
        Shipment.delivery_date >= month_start,
        Shipment.delivery_date <= today,
    ).scalar() or 0

    # 月間完了件数
    monthly_completed = db.query(Shipment).filter(
        Shipment.status == "完了",
        Shipment.delivery_date >= month_start,
        Shipment.delivery_date <= today,
    ).count()

    # 直近7日の売上推移
    revenue_trend = []
    for i in range(6, -1, -1):
        d = today - timedelta(days=i)
        day_revenue = db.query(func.sum(Shipment.price)).filter(
            Shipment.status == "完了",
            Shipment.delivery_date == d,
        ).scalar() or 0
        revenue_trend.append({"date": str(d), "revenue": day_revenue})

    return {
        "vehicles": {
            "total": vehicles_total,
            "active": vehicles_active,
            "empty": vehicles_empty,
            "maintenance": vehicles_maintenance,
        },
        "drivers": {
            "total": drivers_total,
            "active": drivers_active,
            "standby": drivers_standby,
        },
        "today_dispatches": today_dispatches,
        "unassigned_shipments": unassigned,
        "monthly_revenue": monthly_revenue,
        "monthly_completed": monthly_completed,
        "revenue_trend": revenue_trend,
    }
