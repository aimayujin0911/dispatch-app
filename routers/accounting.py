from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from datetime import date
from database import get_db
from models import AccountEntry, Shipment, PartnerInvoice, PartnerCompany

router = APIRouter()

INCOME_CATEGORIES = ["運賃収入", "付帯作業収入", "その他収入"]
EXPENSE_CATEGORIES = ["燃料費", "高速代", "修理・整備費", "保険料", "車検費用", "リース料", "協力会社支払", "給与・手当", "事務所経費", "その他支出"]


class EntryCreate(BaseModel):
    date: date
    entry_type: str = "収入"
    category: str = ""
    description: str = ""
    amount: int = 0
    related_shipment_id: Optional[int] = None
    related_partner_id: Optional[int] = None
    notes: str = ""


class EntryUpdate(BaseModel):
    date: Optional[date] = None
    entry_type: Optional[str] = None
    category: Optional[str] = None
    description: Optional[str] = None
    amount: Optional[int] = None
    notes: Optional[str] = None


@router.get("")
def list_entries(month: str = "", db: Session = Depends(get_db)):
    q = db.query(AccountEntry)
    entries = q.order_by(AccountEntry.date.desc()).all()
    result = []
    for e in entries:
        d = {c.name: getattr(e, c.name) for c in e.__table__.columns}
        d["date"] = str(e.date)
        if d.get("created_at"):
            d["created_at"] = str(d["created_at"])
        result.append(d)
    return result


@router.get("/categories")
def get_categories():
    return {"income": INCOME_CATEGORIES, "expense": EXPENSE_CATEGORIES}


@router.get("/summary")
def get_summary(month: str = "", db: Session = Depends(get_db)):
    entries = db.query(AccountEntry).all()
    if month:
        entries = [e for e in entries if str(e.date).startswith(month)]
    income = sum(e.amount for e in entries if e.entry_type == "収入")
    expense = sum(e.amount for e in entries if e.entry_type == "支出")
    by_category = {}
    for e in entries:
        key = e.category or "未分類"
        by_category[key] = by_category.get(key, 0) + (e.amount if e.entry_type == "収入" else -e.amount)
    return {"income": income, "expense": expense, "profit": income - expense, "by_category": by_category}


@router.post("")
def create_entry(data: EntryCreate, db: Session = Depends(get_db)):
    entry = AccountEntry(**data.model_dump())
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return {"id": entry.id}


@router.post("/import-revenue")
def import_revenue(month: str, db: Session = Depends(get_db)):
    """完了案件から売上を自動インポート"""
    shipments = db.query(Shipment).filter(Shipment.status == "完了").all()
    month_shipments = [s for s in shipments if str(s.delivery_date).startswith(month)]
    created = 0
    for s in month_shipments:
        existing = db.query(AccountEntry).filter(
            AccountEntry.related_shipment_id == s.id,
            AccountEntry.entry_type == "収入"
        ).first()
        if existing:
            continue
        entry = AccountEntry(
            date=s.delivery_date,
            entry_type="収入",
            category="運賃収入",
            description=f"{s.client_name}: {s.pickup_address} → {s.delivery_address}",
            amount=s.price,
            related_shipment_id=s.id,
        )
        db.add(entry)
        created += 1
    db.commit()
    return {"created": created}


@router.put("/{entry_id}")
def update_entry(entry_id: int, data: EntryUpdate, db: Session = Depends(get_db)):
    entry = db.query(AccountEntry).filter(AccountEntry.id == entry_id).first()
    if not entry:
        raise HTTPException(status_code=404, detail="仕訳が見つかりません")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(entry, key, value)
    db.commit()
    return {"ok": True}


@router.delete("/{entry_id}")
def delete_entry(entry_id: int, db: Session = Depends(get_db)):
    entry = db.query(AccountEntry).filter(AccountEntry.id == entry_id).first()
    if entry:
        db.delete(entry)
        db.commit()
    return {"ok": True}
