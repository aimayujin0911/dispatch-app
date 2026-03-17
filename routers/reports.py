from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel
from typing import Optional
from datetime import date
import json
from database import get_db
from models import DailyReport, Dispatch, Shipment

router = APIRouter()


class ReportCreate(BaseModel):
    driver_id: int
    date: date
    start_time: str = ""
    end_time: str = ""
    distance_km: float = 0
    fuel_liters: float = 0
    waiting_time: int = 0
    loading_time: int = 0
    unloading_time: int = 0
    routes: str = ""
    client_names: str = ""
    notes: str = ""


class ReportUpdate(BaseModel):
    driver_id: Optional[int] = None
    date: Optional[date] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    distance_km: Optional[float] = None
    fuel_liters: Optional[float] = None
    waiting_time: Optional[int] = None
    loading_time: Optional[int] = None
    unloading_time: Optional[int] = None
    routes: Optional[str] = None
    client_names: Optional[str] = None
    notes: Optional[str] = None


@router.get("")
def list_reports(db: Session = Depends(get_db)):
    reports = db.query(DailyReport).options(
        joinedload(DailyReport.driver)
    ).order_by(DailyReport.date.desc()).all()
    result = []
    for r in reports:
        result.append({
            "id": r.id,
            "driver_id": r.driver_id,
            "driver_name": r.driver.name if r.driver else "",
            "date": str(r.date),
            "start_time": r.start_time,
            "end_time": r.end_time,
            "distance_km": r.distance_km,
            "fuel_liters": r.fuel_liters,
            "waiting_time": getattr(r, 'waiting_time', 0) or 0,
            "loading_time": getattr(r, 'loading_time', 0) or 0,
            "unloading_time": getattr(r, 'unloading_time', 0) or 0,
            "routes": getattr(r, 'routes', '') or '',
            "client_names": getattr(r, 'client_names', '') or '',
            "notes": r.notes,
        })
    return result


@router.post("")
def create_report(data: ReportCreate, db: Session = Depends(get_db)):
    report = DailyReport(**data.model_dump())
    db.add(report)
    db.commit()
    db.refresh(report)
    return report


@router.post("/auto-generate")
def auto_generate_reports(target_date: str, db: Session = Depends(get_db)):
    """配車データから日報を自動生成"""
    td = date.fromisoformat(target_date)
    dispatches = db.query(Dispatch).options(
        joinedload(Dispatch.shipment)
    ).filter(Dispatch.date == td).all()

    # ドライバーごとにグループ化
    by_driver = {}
    for d in dispatches:
        if d.driver_id not in by_driver:
            by_driver[d.driver_id] = []
        by_driver[d.driver_id].append(d)

    created = 0
    for driver_id, driver_dispatches in by_driver.items():
        existing = db.query(DailyReport).filter(
            DailyReport.driver_id == driver_id,
            DailyReport.date == td
        ).first()
        if existing:
            continue

        # 集約
        start_times = [d.start_time for d in driver_dispatches if d.start_time]
        end_times = [d.end_time for d in driver_dispatches if d.end_time]
        total_waiting = sum((d.shipment.waiting_time or 0) for d in driver_dispatches if d.shipment)
        total_loading = sum((d.shipment.loading_time or 0) for d in driver_dispatches if d.shipment)
        total_unloading = sum((d.shipment.unloading_time or 0) for d in driver_dispatches if d.shipment)

        routes_list = []
        clients = []
        for d in driver_dispatches:
            if d.shipment:
                routes_list.append({
                    "pickup": d.shipment.pickup_address,
                    "delivery": d.shipment.delivery_address,
                    "cargo": d.shipment.cargo_description,
                    "start": d.start_time,
                    "end": d.end_time,
                })
                if d.shipment.client_name and d.shipment.client_name not in clients:
                    clients.append(d.shipment.client_name)

        report = DailyReport(
            driver_id=driver_id,
            date=td,
            start_time=min(start_times) if start_times else "",
            end_time=max(end_times) if end_times else "",
            waiting_time=total_waiting,
            loading_time=total_loading,
            unloading_time=total_unloading,
            routes=json.dumps(routes_list, ensure_ascii=False),
            client_names=", ".join(clients),
            notes=f"配車データから自動生成（{len(driver_dispatches)}件）",
        )
        db.add(report)
        created += 1

    db.commit()
    return {"created": created}


@router.put("/{report_id}")
def update_report(report_id: int, data: ReportUpdate, db: Session = Depends(get_db)):
    report = db.query(DailyReport).filter(DailyReport.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="日報が見つかりません")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(report, key, value)
    db.commit()
    db.refresh(report)
    return report


@router.delete("/{report_id}")
def delete_report(report_id: int, db: Session = Depends(get_db)):
    report = db.query(DailyReport).filter(DailyReport.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="日報が見つかりません")
    db.delete(report)
    db.commit()
    return {"ok": True}
