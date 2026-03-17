from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from datetime import date
from database import get_db
from models import Shipment

router = APIRouter()


class ShipmentCreate(BaseModel):
    name: str = ""
    client_name: str
    cargo_description: str = ""
    weight: float = 0
    pickup_address: str
    delivery_address: str
    pickup_date: date
    pickup_time: str = ""
    delivery_date: date
    delivery_time: str = ""
    time_note: str = ""
    price: int = 0
    frequency_type: str = "単発"
    frequency_days: str = ""
    status: str = "未配車"
    waiting_time: int = 0
    loading_time: int = 0
    unloading_time: int = 0
    notes: str = ""


class ShipmentUpdate(BaseModel):
    name: Optional[str] = None
    client_name: Optional[str] = None
    cargo_description: Optional[str] = None
    weight: Optional[float] = None
    pickup_address: Optional[str] = None
    delivery_address: Optional[str] = None
    pickup_date: Optional[date] = None
    pickup_time: Optional[str] = None
    delivery_date: Optional[date] = None
    delivery_time: Optional[str] = None
    time_note: Optional[str] = None
    price: Optional[int] = None
    frequency_type: Optional[str] = None
    frequency_days: Optional[str] = None
    status: Optional[str] = None
    invoice_status: Optional[str] = None
    invoice_date: Optional[date] = None
    waiting_time: Optional[int] = None
    loading_time: Optional[int] = None
    unloading_time: Optional[int] = None
    notes: Optional[str] = None


@router.get("")
def list_shipments(db: Session = Depends(get_db)):
    return db.query(Shipment).order_by(Shipment.pickup_date.desc()).all()


@router.post("")
def create_shipment(data: ShipmentCreate, db: Session = Depends(get_db)):
    shipment = Shipment(**data.model_dump())
    db.add(shipment)
    db.commit()
    db.refresh(shipment)
    return shipment


@router.put("/{shipment_id}")
def update_shipment(shipment_id: int, data: ShipmentUpdate, db: Session = Depends(get_db)):
    shipment = db.query(Shipment).filter(Shipment.id == shipment_id).first()
    if not shipment:
        raise HTTPException(status_code=404, detail="案件が見つかりません")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(shipment, key, value)
    db.commit()
    db.refresh(shipment)
    return shipment


@router.delete("/{shipment_id}")
def delete_shipment(shipment_id: int, db: Session = Depends(get_db)):
    shipment = db.query(Shipment).filter(Shipment.id == shipment_id).first()
    if not shipment:
        raise HTTPException(status_code=404, detail="案件が見つかりません")
    db.delete(shipment)
    db.commit()
    return {"ok": True}
