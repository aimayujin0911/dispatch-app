from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from database import get_db
from models import Vehicle

router = APIRouter()


class VehicleCreate(BaseModel):
    number: str
    chassis_number: str = ""
    type: str
    capacity: float
    status: str = "空車"
    first_registration: str = ""
    inspection_expiry: str = ""
    notes: str = ""


class VehicleUpdate(BaseModel):
    number: Optional[str] = None
    chassis_number: Optional[str] = None
    type: Optional[str] = None
    capacity: Optional[float] = None
    status: Optional[str] = None
    first_registration: Optional[str] = None
    inspection_expiry: Optional[str] = None
    notes: Optional[str] = None


@router.get("")
def list_vehicles(type: Optional[str] = None, db: Session = Depends(get_db)):
    query = db.query(Vehicle)
    if type:
        query = query.filter(Vehicle.type == type)
    return query.order_by(Vehicle.id.desc()).all()


@router.post("")
def create_vehicle(data: VehicleCreate, db: Session = Depends(get_db)):
    vehicle = Vehicle(**data.model_dump())
    db.add(vehicle)
    db.commit()
    db.refresh(vehicle)
    return vehicle


@router.put("/{vehicle_id}")
def update_vehicle(vehicle_id: int, data: VehicleUpdate, db: Session = Depends(get_db)):
    vehicle = db.query(Vehicle).filter(Vehicle.id == vehicle_id).first()
    if not vehicle:
        raise HTTPException(status_code=404, detail="車両が見つかりません")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(vehicle, key, value)
    db.commit()
    db.refresh(vehicle)
    return vehicle


@router.delete("/{vehicle_id}")
def delete_vehicle(vehicle_id: int, db: Session = Depends(get_db)):
    vehicle = db.query(Vehicle).filter(Vehicle.id == vehicle_id).first()
    if not vehicle:
        raise HTTPException(status_code=404, detail="車両が見つかりません")
    db.delete(vehicle)
    db.commit()
    return {"ok": True}
