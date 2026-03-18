from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from datetime import date
from database import get_db
from models import TransportRequest, PartnerCompany

router = APIRouter()


class TRCreate(BaseModel):
    partner_id: int
    shipment_id: Optional[int] = None
    request_date: Optional[date] = None
    pickup_date: Optional[date] = None
    pickup_time: str = ""
    delivery_date: Optional[date] = None
    delivery_time: str = ""
    pickup_address: str = ""
    pickup_contact: str = ""
    delivery_address: str = ""
    delivery_contact: str = ""
    cargo_description: str = ""
    cargo_weight: float = 0
    cargo_quantity: str = ""
    vehicle_type_required: str = ""
    special_instructions: str = ""
    freight_amount: int = 0
    status: str = "下書き"
    notes: str = ""


class TRUpdate(BaseModel):
    partner_id: Optional[int] = None
    shipment_id: Optional[int] = None
    request_date: Optional[date] = None
    pickup_date: Optional[date] = None
    pickup_time: Optional[str] = None
    delivery_date: Optional[date] = None
    delivery_time: Optional[str] = None
    pickup_address: Optional[str] = None
    pickup_contact: Optional[str] = None
    delivery_address: Optional[str] = None
    delivery_contact: Optional[str] = None
    cargo_description: Optional[str] = None
    cargo_weight: Optional[float] = None
    cargo_quantity: Optional[str] = None
    vehicle_type_required: Optional[str] = None
    special_instructions: Optional[str] = None
    freight_amount: Optional[int] = None
    status: Optional[str] = None
    notes: Optional[str] = None


@router.get("")
def list_requests(db: Session = Depends(get_db)):
    reqs = db.query(TransportRequest).order_by(TransportRequest.created_at.desc()).all()
    result = []
    for r in reqs:
        partner = db.query(PartnerCompany).filter(PartnerCompany.id == r.partner_id).first()
        d = {c.name: getattr(r, c.name) for c in r.__table__.columns}
        d["partner_name"] = partner.name if partner else "不明"
        for k in ["request_date", "pickup_date", "delivery_date", "created_at"]:
            if d.get(k):
                d[k] = str(d[k])
        if not d.get("request_number"):
            d["request_number"] = f"TR-{r.id:04d}"
        result.append(d)
    return result


@router.post("")
def create_request(data: TRCreate, db: Session = Depends(get_db)):
    tr = TransportRequest(**data.model_dump())
    db.add(tr)
    db.commit()
    db.refresh(tr)
    tr.request_number = f"TR-{tr.id:04d}"
    db.commit()
    return {"id": tr.id, "request_number": tr.request_number}


@router.put("/{req_id}")
def update_request(req_id: int, data: TRUpdate, db: Session = Depends(get_db)):
    tr = db.query(TransportRequest).filter(TransportRequest.id == req_id).first()
    if not tr:
        raise HTTPException(status_code=404, detail="輸送依頼書が見つかりません")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(tr, key, value)
    db.commit()
    return {"ok": True}


@router.delete("/{req_id}")
def delete_request(req_id: int, db: Session = Depends(get_db)):
    tr = db.query(TransportRequest).filter(TransportRequest.id == req_id).first()
    if tr:
        db.delete(tr)
        db.commit()
    return {"ok": True}
