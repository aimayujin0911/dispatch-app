from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from datetime import date
from database import get_db
from models import Attendance, Driver, Dispatch

router = APIRouter()


class AttendanceCreate(BaseModel):
    driver_id: int
    date: date
    clock_in: str = ""
    clock_out: str = ""
    break_minutes: int = 60
    work_type: str = "通常"
    overtime_minutes: int = 0
    late_night_minutes: int = 0
    distance_km: float = 0
    allowance: int = 0
    waiting_time: int = 0
    loading_time: int = 0
    unloading_time: int = 0
    notes: str = ""


class AttendanceUpdate(BaseModel):
    clock_in: Optional[str] = None
    clock_out: Optional[str] = None
    break_minutes: Optional[int] = None
    work_type: Optional[str] = None
    overtime_minutes: Optional[int] = None
    late_night_minutes: Optional[int] = None
    distance_km: Optional[float] = None
    allowance: Optional[int] = None
    waiting_time: Optional[int] = None
    loading_time: Optional[int] = None
    unloading_time: Optional[int] = None
    notes: Optional[str] = None


@router.get("")
def list_attendance(month: str = "", driver_id: int = 0, db: Session = Depends(get_db)):
    q = db.query(Attendance)
    if driver_id:
        q = q.filter(Attendance.driver_id == driver_id)
    records = q.order_by(Attendance.date.desc()).all()
    result = []
    for a in records:
        driver = db.query(Driver).filter(Driver.id == a.driver_id).first()
        d = {c.name: getattr(a, c.name) for c in a.__table__.columns}
        d["driver_name"] = driver.name if driver else "不明"
        d["date"] = str(a.date)
        if d.get("created_at"):
            d["created_at"] = str(d["created_at"])
        result.append(d)
    return result


@router.post("")
def create_attendance(data: AttendanceCreate, db: Session = Depends(get_db)):
    att = Attendance(**data.model_dump())
    if att.clock_in and att.clock_out:
        work_mins = _time_diff(att.clock_in, att.clock_out) - att.break_minutes
        if work_mins > 480:
            att.overtime_minutes = work_mins - 480
        att.late_night_minutes = _calc_late_night(att.clock_in, att.clock_out)
    db.add(att)
    db.commit()
    db.refresh(att)
    return {"id": att.id}


@router.post("/from-dispatches")
def generate_from_dispatches(target_date: str, db: Session = Depends(get_db)):
    dispatches = db.query(Dispatch).filter(Dispatch.date == target_date).all()
    created = 0
    for disp in dispatches:
        existing = db.query(Attendance).filter(
            Attendance.driver_id == disp.driver_id,
            Attendance.date == disp.date
        ).first()
        if existing:
            continue
        # 案件の作業時間を取得
        shipment = disp.shipment if disp.shipment_id else None
        att = Attendance(
            driver_id=disp.driver_id,
            date=disp.date,
            clock_in=disp.start_time or "",
            clock_out=disp.end_time or "",
            break_minutes=60,
            work_type="通常",
            waiting_time=shipment.waiting_time if shipment else 0,
            loading_time=shipment.loading_time if shipment else 0,
            unloading_time=shipment.unloading_time if shipment else 0,
        )
        if att.clock_in and att.clock_out:
            work_mins = _time_diff(att.clock_in, att.clock_out) - att.break_minutes
            att.overtime_minutes = max(0, work_mins - 480)
            att.late_night_minutes = _calc_late_night(att.clock_in, att.clock_out)
        db.add(att)
        created += 1
    db.commit()
    return {"created": created}


@router.put("/{att_id}")
def update_attendance(att_id: int, data: AttendanceUpdate, db: Session = Depends(get_db)):
    att = db.query(Attendance).filter(Attendance.id == att_id).first()
    if not att:
        raise HTTPException(status_code=404, detail="勤怠記録が見つかりません")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(att, key, value)
    if att.clock_in and att.clock_out:
        work_mins = _time_diff(att.clock_in, att.clock_out) - att.break_minutes
        att.overtime_minutes = max(0, work_mins - 480)
        att.late_night_minutes = _calc_late_night(att.clock_in, att.clock_out)
    db.commit()
    return {"ok": True}


@router.delete("/{att_id}")
def delete_attendance(att_id: int, db: Session = Depends(get_db)):
    att = db.query(Attendance).filter(Attendance.id == att_id).first()
    if att:
        db.delete(att)
        db.commit()
    return {"ok": True}


def _time_diff(start: str, end: str) -> int:
    sh, sm = map(int, start.split(':'))
    eh, em = map(int, end.split(':'))
    return (eh * 60 + em) - (sh * 60 + sm)


def _calc_late_night(start: str, end: str) -> int:
    sh, sm = map(int, start.split(':'))
    eh, em = map(int, end.split(':'))
    start_min = sh * 60 + sm
    end_min = eh * 60 + em
    late_night = 0
    ln_start = 22 * 60
    ln_end = 24 * 60
    if end_min > ln_start:
        late_night += min(end_min, ln_end) - max(start_min, ln_start)
    early_end = 5 * 60
    if start_min < early_end:
        late_night += min(end_min, early_end) - start_min
    return max(0, late_night)
