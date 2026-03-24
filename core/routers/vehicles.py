from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from database import get_db
from models import Vehicle, User
from core.auth import get_current_user

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
def list_vehicles(type: Optional[str] = None, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    from models import Driver
    query = db.query(Vehicle).filter(Vehicle.tenant_id == current_user.tenant_id)
    if type:
        query = query.filter(Vehicle.type == type)
    vehicles = query.order_by(Vehicle.id.desc()).all()
    # default_driver_nameを付与
    driver_ids = [v.default_driver_id for v in vehicles if v.default_driver_id]
    driver_map = {}
    if driver_ids:
        drivers = db.query(Driver).filter(Driver.id.in_(driver_ids)).all()
        driver_map = {d.id: d.name for d in drivers}
    result = []
    for v in vehicles:
        vd = {c.name: getattr(v, c.name) for c in v.__table__.columns}
        vd["default_driver_name"] = driver_map.get(v.default_driver_id, "") if v.default_driver_id else ""
        result.append(vd)
    return result


@router.post("")
def create_vehicle(data: VehicleCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    vehicle = Vehicle(**data.model_dump())
    vehicle.tenant_id = current_user.tenant_id
    db.add(vehicle)
    db.commit()
    db.refresh(vehicle)
    return vehicle


@router.put("/{vehicle_id}")
def update_vehicle(vehicle_id: int, data: VehicleUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    vehicle = db.query(Vehicle).filter(Vehicle.id == vehicle_id, Vehicle.tenant_id == current_user.tenant_id).first()
    if not vehicle:
        raise HTTPException(status_code=404, detail="車両が見つかりません")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(vehicle, key, value)
    db.commit()
    db.refresh(vehicle)
    return vehicle


@router.delete("/{vehicle_id}")
def delete_vehicle(vehicle_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    vehicle = db.query(Vehicle).filter(Vehicle.id == vehicle_id, Vehicle.tenant_id == current_user.tenant_id).first()
    if not vehicle:
        raise HTTPException(status_code=404, detail="車両が見つかりません")
    db.delete(vehicle)
    db.commit()
    return {"ok": True}
