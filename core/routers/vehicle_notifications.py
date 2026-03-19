from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from datetime import date
from database import get_db
from models import VehicleNotification, Dispatch, Vehicle, Driver, Shipment, User
from core.auth import get_current_user

router = APIRouter()


class VNCreate(BaseModel):
    dispatch_id: Optional[int] = None
    notification_date: Optional[date] = None
    arrival_date: Optional[date] = None
    arrival_time: str = ""
    vehicle_number: str = ""
    vehicle_type: str = ""
    driver_name: str = ""
    driver_phone: str = ""
    cargo_description: str = ""
    quantity: str = ""
    destination_name: str = ""
    destination_address: str = ""
    destination_contact: str = ""
    sender_name: str = ""
    special_notes: str = ""
    status: str = "未送付"


class VNUpdate(BaseModel):
    notification_date: Optional[date] = None
    arrival_date: Optional[date] = None
    arrival_time: Optional[str] = None
    vehicle_number: Optional[str] = None
    vehicle_type: Optional[str] = None
    driver_name: Optional[str] = None
    driver_phone: Optional[str] = None
    cargo_description: Optional[str] = None
    quantity: Optional[str] = None
    destination_name: Optional[str] = None
    destination_address: Optional[str] = None
    destination_contact: Optional[str] = None
    sender_name: Optional[str] = None
    special_notes: Optional[str] = None
    status: Optional[str] = None


def _tenant_dispatch_ids(db: Session, tenant_id: str) -> list:
    """Get dispatch IDs belonging to this tenant"""
    return [d.id for d in db.query(Dispatch.id).filter(Dispatch.tenant_id == tenant_id).all()]


@router.get("")
def list_notifications(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    dispatch_ids = _tenant_dispatch_ids(db, current_user.tenant_id)
    # Include notifications linked to tenant dispatches, or with no dispatch link
    from sqlalchemy import or_
    vns = db.query(VehicleNotification).filter(
        or_(
            VehicleNotification.dispatch_id.in_(dispatch_ids) if dispatch_ids else False,
            VehicleNotification.dispatch_id == None,
        )
    ).order_by(VehicleNotification.arrival_date.desc()).all()
    result = []
    for vn in vns:
        d = {c.name: getattr(vn, c.name) for c in vn.__table__.columns}
        for k in ["notification_date", "arrival_date", "created_at"]:
            if d.get(k):
                d[k] = str(d[k])
        result.append(d)
    return result


@router.post("")
def create_notification(data: VNCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    # Verify dispatch belongs to tenant if specified
    if data.dispatch_id:
        disp = db.query(Dispatch).filter(Dispatch.id == data.dispatch_id, Dispatch.tenant_id == current_user.tenant_id).first()
        if not disp:
            raise HTTPException(status_code=404, detail="配車が見つかりません")
    vn = VehicleNotification(**data.model_dump())
    db.add(vn)
    db.commit()
    db.refresh(vn)
    return {"id": vn.id}


@router.post("/from-dispatch/{dispatch_id}")
def create_from_dispatch(dispatch_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    disp = db.query(Dispatch).filter(Dispatch.id == dispatch_id, Dispatch.tenant_id == current_user.tenant_id).first()
    if not disp:
        raise HTTPException(status_code=404, detail="配車が見つかりません")
    vehicle = db.query(Vehicle).filter(Vehicle.id == disp.vehicle_id).first()
    driver = db.query(Driver).filter(Driver.id == disp.driver_id).first()
    shipment = db.query(Shipment).filter(Shipment.id == disp.shipment_id).first() if disp.shipment_id else None

    vn = VehicleNotification(
        dispatch_id=dispatch_id,
        notification_date=date.today(),
        arrival_date=disp.date,
        arrival_time=disp.start_time or "",
        vehicle_number=vehicle.number if vehicle else "",
        vehicle_type=vehicle.type if vehicle else "",
        driver_name=driver.name if driver else "",
        driver_phone=driver.phone if driver else "",
        cargo_description=shipment.cargo_description if shipment else "",
        quantity="",
        destination_name=shipment.client_name if shipment else "",
        destination_address=shipment.delivery_address if shipment else "",
        destination_contact="",
        sender_name=shipment.client_name if shipment else "",
        special_notes=disp.notes or "",
        status="未送付",
    )
    db.add(vn)
    db.commit()
    db.refresh(vn)
    return {"id": vn.id}


@router.put("/{vn_id}")
def update_notification(vn_id: int, data: VNUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    dispatch_ids = _tenant_dispatch_ids(db, current_user.tenant_id)
    from sqlalchemy import or_
    vn = db.query(VehicleNotification).filter(
        VehicleNotification.id == vn_id,
        or_(
            VehicleNotification.dispatch_id.in_(dispatch_ids) if dispatch_ids else False,
            VehicleNotification.dispatch_id == None,
        )
    ).first()
    if not vn:
        raise HTTPException(status_code=404, detail="車番連絡票が見つかりません")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(vn, key, value)
    db.commit()
    return {"ok": True}


@router.delete("/{vn_id}")
def delete_notification(vn_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    dispatch_ids = _tenant_dispatch_ids(db, current_user.tenant_id)
    from sqlalchemy import or_
    vn = db.query(VehicleNotification).filter(
        VehicleNotification.id == vn_id,
        or_(
            VehicleNotification.dispatch_id.in_(dispatch_ids) if dispatch_ids else False,
            VehicleNotification.dispatch_id == None,
        )
    ).first()
    if vn:
        db.delete(vn)
        db.commit()
    return {"ok": True}
