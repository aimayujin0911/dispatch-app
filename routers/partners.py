from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from database import get_db
from models import PartnerCompany

router = APIRouter()


class PartnerCreate(BaseModel):
    name: str
    address: str = ""
    phone: str = ""
    fax: str = ""
    contact_person: str = ""
    bank_info: str = ""
    payment_terms: str = "月末締め翌月末払い"
    notes: str = ""


class PartnerUpdate(BaseModel):
    name: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    fax: Optional[str] = None
    contact_person: Optional[str] = None
    bank_info: Optional[str] = None
    payment_terms: Optional[str] = None
    notes: Optional[str] = None


@router.get("")
def list_partners(db: Session = Depends(get_db)):
    return db.query(PartnerCompany).order_by(PartnerCompany.name).all()


@router.post("")
def create_partner(data: PartnerCreate, db: Session = Depends(get_db)):
    partner = PartnerCompany(**data.model_dump())
    db.add(partner)
    db.commit()
    db.refresh(partner)
    return partner


@router.put("/{partner_id}")
def update_partner(partner_id: int, data: PartnerUpdate, db: Session = Depends(get_db)):
    partner = db.query(PartnerCompany).filter(PartnerCompany.id == partner_id).first()
    if not partner:
        raise HTTPException(status_code=404, detail="協力会社が見つかりません")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(partner, key, value)
    db.commit()
    db.refresh(partner)
    return partner


@router.delete("/{partner_id}")
def delete_partner(partner_id: int, db: Session = Depends(get_db)):
    partner = db.query(PartnerCompany).filter(PartnerCompany.id == partner_id).first()
    if not partner:
        raise HTTPException(status_code=404, detail="協力会社が見つかりません")
    db.delete(partner)
    db.commit()
    return {"ok": True}
