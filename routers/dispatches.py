from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel
from typing import Optional
from datetime import date
from database import get_db
from models import Dispatch, Shipment, Vehicle, Driver

router = APIRouter()


class DispatchCreate(BaseModel):
    vehicle_id: int
    driver_id: int
    shipment_id: int
    date: date
    status: str = "予定"
    notes: str = ""


class DispatchUpdate(BaseModel):
    vehicle_id: Optional[int] = None
    driver_id: Optional[int] = None
    shipment_id: Optional[int] = None
    date: Optional[date] = None
    status: Optional[str] = None
    notes: Optional[str] = None


@router.get("")
def list_dispatches(target_date: Optional[str] = None, db: Session = Depends(get_db)):
    query = db.query(Dispatch).options(
        joinedload(Dispatch.vehicle),
        joinedload(Dispatch.driver),
        joinedload(Dispatch.shipment),
    )
    if target_date:
        query = query.filter(Dispatch.date == target_date)
    dispatches = query.order_by(Dispatch.date.desc()).all()
    result = []
    for d in dispatches:
        result.append({
            "id": d.id,
            "vehicle_id": d.vehicle_id,
            "driver_id": d.driver_id,
            "shipment_id": d.shipment_id,
            "date": str(d.date),
            "status": d.status,
            "notes": d.notes,
            "vehicle_number": d.vehicle.number if d.vehicle else "",
            "driver_name": d.driver.name if d.driver else "",
            "client_name": d.shipment.client_name if d.shipment else "",
            "pickup_address": d.shipment.pickup_address if d.shipment else "",
            "delivery_address": d.shipment.delivery_address if d.shipment else "",
            "cargo_description": d.shipment.cargo_description if d.shipment else "",
        })
    return result


@router.post("")
def create_dispatch(data: DispatchCreate, db: Session = Depends(get_db)):
    dispatch = Dispatch(**data.model_dump())
    db.add(dispatch)
    # 案件ステータスを「配車済」に更新
    shipment = db.query(Shipment).filter(Shipment.id == data.shipment_id).first()
    if shipment:
        shipment.status = "配車済"
    # 車両ステータスを「稼働中」に更新
    vehicle = db.query(Vehicle).filter(Vehicle.id == data.vehicle_id).first()
    if vehicle:
        vehicle.status = "稼働中"
    # ドライバーステータスを「運行中」に更新
    driver = db.query(Driver).filter(Driver.id == data.driver_id).first()
    if driver:
        driver.status = "運行中"
    db.commit()
    db.refresh(dispatch)
    return dispatch


@router.put("/{dispatch_id}")
def update_dispatch(dispatch_id: int, data: DispatchUpdate, db: Session = Depends(get_db)):
    dispatch = db.query(Dispatch).filter(Dispatch.id == dispatch_id).first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="配車が見つかりません")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(dispatch, key, value)
    # ステータスが「完了」になったら関連も更新
    if data.status == "完了":
        shipment = db.query(Shipment).filter(Shipment.id == dispatch.shipment_id).first()
        if shipment:
            shipment.status = "完了"
        vehicle = db.query(Vehicle).filter(Vehicle.id == dispatch.vehicle_id).first()
        if vehicle:
            vehicle.status = "空車"
        driver = db.query(Driver).filter(Driver.id == dispatch.driver_id).first()
        if driver:
            driver.status = "待機中"
    db.commit()
    db.refresh(dispatch)
    return dispatch


@router.delete("/{dispatch_id}")
def delete_dispatch(dispatch_id: int, db: Session = Depends(get_db)):
    dispatch = db.query(Dispatch).filter(Dispatch.id == dispatch_id).first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="配車が見つかりません")
    db.delete(dispatch)
    db.commit()
    return {"ok": True}
