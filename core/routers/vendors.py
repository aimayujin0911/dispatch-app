from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from datetime import date
from database import get_db
from models import Vendor, AccountEntry, User
from core.auth import get_current_user

router = APIRouter()


class VendorCreate(BaseModel):
    name: str
    vendor_type: str = ""
    address: str = ""
    phone: str = ""
    contact_person: str = ""
    billing_cycle: str = "月末締め翌月末払い"
    account_number: str = ""
    notes: str = ""


class VendorUpdate(BaseModel):
    name: Optional[str] = None
    vendor_type: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    contact_person: Optional[str] = None
    billing_cycle: Optional[str] = None
    account_number: Optional[str] = None
    notes: Optional[str] = None


class BulkCostImport(BaseModel):
    vendor_id: int
    date: date
    category: str  # 燃料費, 高速代(ETC), etc.
    description: str = ""
    total_amount: int = 0
    items: list = []  # optional line items [{description, amount, vehicle_id?}]


@router.get("")
def list_vendors(vendor_type: str = "", db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    # Vendor has no tenant_id; filter by tenant_id if column exists, otherwise return all for authenticated user
    q = db.query(Vendor)
    if vendor_type:
        q = q.filter(Vendor.vendor_type == vendor_type)
    if hasattr(Vendor, 'tenant_id'):
        q = q.filter(Vendor.tenant_id == current_user.tenant_id)
    return q.order_by(Vendor.name).all()


@router.get("/{vendor_id}")
def get_vendor(vendor_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    v = db.query(Vendor).filter(Vendor.id == vendor_id).first()
    if not v:
        raise HTTPException(status_code=404, detail="取引先が見つかりません")
    return v


@router.post("")
def create_vendor(data: VendorCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    v = Vendor(**data.model_dump())
    if hasattr(v, 'tenant_id'):
        v.tenant_id = current_user.tenant_id
    db.add(v)
    db.commit()
    db.refresh(v)
    return {"id": v.id}


@router.put("/{vendor_id}")
def update_vendor(vendor_id: int, data: VendorUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    q = db.query(Vendor).filter(Vendor.id == vendor_id)
    if hasattr(Vendor, 'tenant_id'):
        q = q.filter(Vendor.tenant_id == current_user.tenant_id)
    v = q.first()
    if not v:
        raise HTTPException(status_code=404, detail="取引先が見つかりません")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(v, key, value)
    db.commit()
    return {"ok": True}


@router.delete("/{vendor_id}")
def delete_vendor(vendor_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    q = db.query(Vendor).filter(Vendor.id == vendor_id)
    if hasattr(Vendor, 'tenant_id'):
        q = q.filter(Vendor.tenant_id == current_user.tenant_id)
    v = q.first()
    if v:
        db.delete(v)
        db.commit()
    return {"ok": True}


@router.post("/bulk-cost-import")
def bulk_cost_import(data: BulkCostImport, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """取引先からの一括請求を会計データとして取り込む"""
    q = db.query(Vendor).filter(Vendor.id == data.vendor_id)
    if hasattr(Vendor, 'tenant_id'):
        q = q.filter(Vendor.tenant_id == current_user.tenant_id)
    vendor = q.first()
    if not vendor:
        raise HTTPException(status_code=404, detail="取引先が見つかりません")

    created = 0
    if data.items and len(data.items) > 0:
        # 明細ごとに登録
        for item in data.items:
            entry = AccountEntry(
                date=data.date,
                entry_type="支出",
                category=data.category,
                description=item.get("description", f"{vendor.name}: {data.description}"),
                amount=item.get("amount", 0),
                vehicle_id=item.get("vehicle_id"),
                related_partner_id=vendor.id,
                notes=f"取引先: {vendor.name}",
            )
            if hasattr(entry, 'tenant_id'):
                entry.tenant_id = current_user.tenant_id
            db.add(entry)
            created += 1
    else:
        # 一括で1件登録
        entry = AccountEntry(
            date=data.date,
            entry_type="支出",
            category=data.category,
            description=f"{vendor.name}: {data.description}",
            amount=data.total_amount,
            related_partner_id=vendor.id,
            notes=f"取引先: {vendor.name}",
        )
        if hasattr(entry, 'tenant_id'):
            entry.tenant_id = current_user.tenant_id
        db.add(entry)
        created = 1

    db.commit()
    return {"created": created}
