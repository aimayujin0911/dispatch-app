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
    driver_id: Optional[int] = None
    partner_id: Optional[int] = None  # 協力会社ID（ドライバーの代わり）
    shipment_id: Optional[int] = None
    date: date
    end_date: Optional[date] = None
    start_time: str = "08:00"
    end_time: str = "17:00"
    pickup_address: str = ""
    delivery_address: str = ""
    client_name: str = ""
    status: str = "予定"
    notes: str = ""


class DispatchUpdate(BaseModel):
    vehicle_id: Optional[int] = None
    driver_id: Optional[int] = None
    partner_id: Optional[int] = None
    shipment_id: Optional[int] = None
    date: Optional[date] = None
    end_date: Optional[date] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    status: Optional[str] = None
    notes: Optional[str] = None
    pickup_address: Optional[str] = None
    delivery_address: Optional[str] = None


@router.get("")
def list_dispatches(target_date: Optional[str] = None, week_start: Optional[str] = None, db: Session = Depends(get_db)):
    from sqlalchemy import or_
    query = db.query(Dispatch).options(
        joinedload(Dispatch.vehicle),
        joinedload(Dispatch.driver),
        joinedload(Dispatch.shipment),
    )
    if target_date:
        td = date.fromisoformat(target_date)
        query = query.filter(
            or_(
                Dispatch.date == td,
                (Dispatch.end_date != None) & (Dispatch.date <= td) & (Dispatch.end_date >= td)
            )
        )
    elif week_start:
        from datetime import timedelta
        start = date.fromisoformat(week_start)
        end = start + timedelta(days=6)
        query = query.filter(
            or_(
                (Dispatch.date >= start) & (Dispatch.date <= end),
                (Dispatch.end_date != None) & (Dispatch.date <= end) & (Dispatch.end_date >= start)
            )
        )
    dispatches = query.order_by(Dispatch.date, Dispatch.start_time).all()
    result = []
    for d in dispatches:
        # 協力会社名取得
        partner_name = ""
        if d.notes and d.notes.startswith("partner:"):
            partner_name = d.notes.split("partner:")[1].split("\n")[0].strip()
        result.append({
            "id": d.id,
            "vehicle_id": d.vehicle_id,
            "driver_id": d.driver_id,
            "shipment_id": d.shipment_id,
            "date": str(d.date),
            "end_date": str(d.end_date) if d.end_date else None,
            "start_time": d.start_time or "08:00",
            "end_time": d.end_time or "17:00",
            "status": d.status,
            "notes": d.notes,
            "partner_name": partner_name,
            "is_partner": bool(partner_name),
            "vehicle_number": d.vehicle.number if d.vehicle else "",
            "vehicle_type": d.vehicle.type if d.vehicle else "",
            "vehicle_capacity": d.vehicle.capacity if d.vehicle else 0,
            "driver_name": d.driver.name if d.driver else partner_name or "",
            "shipment_name": d.shipment.name if d.shipment else "",
            "client_name": d.shipment.client_name if d.shipment else "",
            "pickup_address": d.shipment.pickup_address if d.shipment else "",
            "delivery_address": d.shipment.delivery_address if d.shipment else "",
            "cargo_description": d.shipment.cargo_description if d.shipment else "",
            "weight": d.shipment.weight if d.shipment else 0,
            "price": d.shipment.price if d.shipment else 0,
            # 案件の指定時間（D&D用）
            "pickup_time": d.shipment.pickup_time if d.shipment else "",
            "delivery_time": d.shipment.delivery_time if d.shipment else "",
            "time_note": d.shipment.time_note if d.shipment else "",
            "waiting_time": d.shipment.waiting_time if d.shipment else 0,
            "loading_time": d.shipment.loading_time if d.shipment else 0,
            "unloading_time": d.shipment.unloading_time if d.shipment else 0,
        })
    return result


@router.post("")
def create_dispatch(data: DispatchCreate, db: Session = Depends(get_db)):
    # driver_idが0またはNullの場合、協力会社配車
    actual_driver_id = data.driver_id
    notes = data.notes or ""
    if data.partner_id and not data.driver_id:
        # 協力会社の場合、ダミードライバーID=最初のドライバーを使う（or partner情報をnotesに保存）
        from models import PartnerCompany
        partner = db.query(PartnerCompany).filter(PartnerCompany.id == data.partner_id).first()
        if partner:
            notes = f"partner:{partner.name}\n{notes}"
        # driver_idは必須なので最初のドライバーを仮設定
        first_driver = db.query(Driver).first()
        if first_driver:
            actual_driver_id = first_driver.id
        else:
            raise HTTPException(status_code=400, detail="ドライバーまたは協力会社を選択してください")
    elif not actual_driver_id:
        raise HTTPException(status_code=400, detail="ドライバーまたは協力会社を選択してください")

    dispatch_data = {
        "vehicle_id": data.vehicle_id,
        "driver_id": actual_driver_id,
        "date": data.date,
        "end_date": data.end_date,
        "start_time": data.start_time,
        "end_time": data.end_time,
        "status": data.status,
        "notes": notes,
    }
    if data.shipment_id:
        dispatch_data["shipment_id"] = data.shipment_id
        shipment = db.query(Shipment).filter(Shipment.id == data.shipment_id).first()
        if shipment:
            shipment.status = "配車済"
    else:
        if data.pickup_address and data.delivery_address:
            shipment = Shipment(
                client_name=data.client_name or "直接入力",
                pickup_address=data.pickup_address,
                delivery_address=data.delivery_address,
                pickup_date=data.date,
                delivery_date=data.date,
                status="配車済",
            )
            db.add(shipment)
            db.flush()
            dispatch_data["shipment_id"] = shipment.id

    dispatch = Dispatch(**dispatch_data)
    db.add(dispatch)
    db.commit()
    db.refresh(dispatch)
    return dispatch


@router.put("/{dispatch_id}")
def update_dispatch(dispatch_id: int, data: DispatchUpdate, db: Session = Depends(get_db)):
    dispatch = db.query(Dispatch).filter(Dispatch.id == dispatch_id).first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="配車が見つかりません")
    update_data = data.model_dump(exclude_unset=True)
    pickup_addr = update_data.pop("pickup_address", None)
    delivery_addr = update_data.pop("delivery_address", None)
    # partner_idはDispatchモデルにないので除外
    update_data.pop("partner_id", None)
    for key, value in update_data.items():
        setattr(dispatch, key, value)
    if (pickup_addr is not None or delivery_addr is not None) and dispatch.shipment_id:
        shipment = db.query(Shipment).filter(Shipment.id == dispatch.shipment_id).first()
        if shipment:
            if pickup_addr is not None:
                shipment.pickup_address = pickup_addr
            if delivery_addr is not None:
                shipment.delivery_address = delivery_addr
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
