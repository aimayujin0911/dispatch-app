from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from datetime import date
import httpx
from database import get_db, SessionLocal
from models import Shipment, User
from core.auth import get_current_user

_geo_cache = {}  # メモリキャッシュ: 住所 → (lat, lng)

def geocode_address(address: str):
    """住所→緯度経度（Nominatim）"""
    if not address:
        return None, None
    if address in _geo_cache:
        return _geo_cache[address]
    try:
        r = httpx.get(
            "https://nominatim.openstreetmap.org/search",
            params={"format": "json", "q": address, "countrycodes": "jp", "limit": 1},
            headers={"User-Agent": "HakoPro/1.0"},
            timeout=5,
        )
        data = r.json()
        if data:
            lat, lng = float(data[0]["lat"]), float(data[0]["lon"])
            _geo_cache[address] = (lat, lng)
            return lat, lng
    except Exception:
        pass
    return None, None

def geocode_shipment_bg(shipment_id: int):
    """バックグラウンドで座標取得してDB更新"""
    db = SessionLocal()
    try:
        s = db.query(Shipment).filter(Shipment.id == shipment_id).first()
        if not s:
            return
        changed = False
        if s.pickup_address and not s.pickup_lat:
            lat, lng = geocode_address(s.pickup_address)
            if lat:
                s.pickup_lat, s.pickup_lng = lat, lng
                changed = True
        if s.delivery_address and not s.delivery_lat:
            lat, lng = geocode_address(s.delivery_address)
            if lat:
                s.delivery_lat, s.delivery_lng = lat, lng
                changed = True
        if changed:
            db.commit()
    finally:
        db.close()

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
    transport_type: str = "ドライ"
    temperature_zone: str = "常温"
    unit_price_type: str = "個建"
    unit_price: float = 0
    unit_quantity: float = 0
    frequency_type: str = "単発"
    frequency_days: str = ""
    status: str = "未配車"
    department: str = ""
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
    transport_type: Optional[str] = None
    temperature_zone: Optional[str] = None
    unit_price_type: Optional[str] = None
    unit_price: Optional[float] = None
    unit_quantity: Optional[float] = None
    frequency_type: Optional[str] = None
    frequency_days: Optional[str] = None
    status: Optional[str] = None
    department: Optional[str] = None
    invoice_status: Optional[str] = None
    invoice_date: Optional[date] = None
    waiting_time: Optional[int] = None
    loading_time: Optional[int] = None
    unloading_time: Optional[int] = None
    notes: Optional[str] = None


@router.get("")
def list_shipments(year: int = 0, month: int = 0, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    q = db.query(Shipment).filter(Shipment.tenant_id == current_user.tenant_id)
    if year and month:
        from datetime import date as d
        start = d(year, month, 1)
        if month == 12:
            end = d(year + 1, 1, 1)
        else:
            end = d(year, month + 1, 1)
        q = q.filter(
            ((Shipment.delivery_date >= start) & (Shipment.delivery_date < end)) |
            ((Shipment.pickup_date >= start) & (Shipment.pickup_date < end))
        )
    return q.order_by(Shipment.pickup_date.desc()).all()


@router.post("")
def create_shipment(data: ShipmentCreate, bg: BackgroundTasks = BackgroundTasks(), db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    shipment = Shipment(**data.model_dump())
    shipment.tenant_id = current_user.tenant_id
    db.add(shipment)
    db.commit()
    db.refresh(shipment)
    bg.add_task(geocode_shipment_bg, shipment.id)
    return shipment


@router.put("/{shipment_id}")
def update_shipment(shipment_id: int, data: ShipmentUpdate, bg: BackgroundTasks = BackgroundTasks(), db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    shipment = db.query(Shipment).filter(Shipment.id == shipment_id, Shipment.tenant_id == current_user.tenant_id).first()
    if not shipment:
        raise HTTPException(status_code=404, detail="案件が見つかりません")
    update_data = data.model_dump(exclude_unset=True)
    addr_changed = 'pickup_address' in update_data or 'delivery_address' in update_data
    for key, value in update_data.items():
        setattr(shipment, key, value)
    if addr_changed:
        shipment.pickup_lat = shipment.pickup_lng = None
        shipment.delivery_lat = shipment.delivery_lng = None
    db.commit()
    db.refresh(shipment)
    if addr_changed:
        bg.add_task(geocode_shipment_bg, shipment.id)
    return shipment


@router.delete("/{shipment_id}")
def delete_shipment(shipment_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    shipment = db.query(Shipment).filter(Shipment.id == shipment_id, Shipment.tenant_id == current_user.tenant_id).first()
    if not shipment:
        raise HTTPException(status_code=404, detail="案件が見つかりません")
    db.delete(shipment)
    db.commit()
    return {"ok": True}
