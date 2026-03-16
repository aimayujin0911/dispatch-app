from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel
from typing import Optional
from datetime import date
from database import get_db
from models import DailyReport

router = APIRouter()


class ReportCreate(BaseModel):
    driver_id: int
    date: date
    start_time: str = ""
    end_time: str = ""
    distance_km: float = 0
    fuel_liters: float = 0
    notes: str = ""


class ReportUpdate(BaseModel):
    driver_id: Optional[int] = None
    date: Optional[date] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    distance_km: Optional[float] = None
    fuel_liters: Optional[float] = None
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
