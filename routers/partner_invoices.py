from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List
from datetime import date
from database import get_db
from models import PartnerInvoice, PartnerInvoiceItem, PartnerCompany

router = APIRouter()


class InvoiceItemCreate(BaseModel):
    date: Optional[date] = None
    description: str = ""
    amount: int = 0
    shipment_id: Optional[int] = None
    notes: str = ""


class InvoiceCreate(BaseModel):
    partner_id: int
    invoice_number: str = ""
    invoice_date: Optional[date] = None
    due_date: Optional[date] = None
    total_amount: int = 0
    tax_amount: int = 0
    status: str = "未確認"
    period_start: Optional[date] = None
    period_end: Optional[date] = None
    notes: str = ""
    items: List[InvoiceItemCreate] = []


class InvoiceUpdate(BaseModel):
    partner_id: Optional[int] = None
    invoice_number: Optional[str] = None
    invoice_date: Optional[date] = None
    due_date: Optional[date] = None
    total_amount: Optional[int] = None
    tax_amount: Optional[int] = None
    status: Optional[str] = None
    payment_date: Optional[date] = None
    period_start: Optional[date] = None
    period_end: Optional[date] = None
    notes: Optional[str] = None


@router.get("")
def list_invoices(db: Session = Depends(get_db)):
    invoices = db.query(PartnerInvoice).order_by(PartnerInvoice.invoice_date.desc()).all()
    result = []
    for inv in invoices:
        partner = db.query(PartnerCompany).filter(PartnerCompany.id == inv.partner_id).first()
        items = db.query(PartnerInvoiceItem).filter(PartnerInvoiceItem.partner_invoice_id == inv.id).all()
        d = {
            "id": inv.id, "partner_id": inv.partner_id,
            "partner_name": partner.name if partner else "不明",
            "invoice_number": inv.invoice_number, "invoice_date": str(inv.invoice_date) if inv.invoice_date else None,
            "due_date": str(inv.due_date) if inv.due_date else None,
            "total_amount": inv.total_amount, "tax_amount": inv.tax_amount,
            "status": inv.status, "payment_date": str(inv.payment_date) if inv.payment_date else None,
            "period_start": str(inv.period_start) if inv.period_start else None,
            "period_end": str(inv.period_end) if inv.period_end else None,
            "notes": inv.notes,
            "items": [{"id": it.id, "date": str(it.date) if it.date else None, "description": it.description, "amount": it.amount, "notes": it.notes} for it in items],
        }
        result.append(d)
    return result


@router.post("")
def create_invoice(data: InvoiceCreate, db: Session = Depends(get_db)):
    items_data = data.items
    inv_data = data.model_dump(exclude={"items"})
    inv = PartnerInvoice(**inv_data)
    db.add(inv)
    db.commit()
    db.refresh(inv)
    for item in items_data:
        db.add(PartnerInvoiceItem(partner_invoice_id=inv.id, **item.model_dump()))
    db.commit()
    return {"id": inv.id}


@router.put("/{invoice_id}")
def update_invoice(invoice_id: int, data: InvoiceUpdate, db: Session = Depends(get_db)):
    inv = db.query(PartnerInvoice).filter(PartnerInvoice.id == invoice_id).first()
    if not inv:
        raise HTTPException(status_code=404, detail="請求書が見つかりません")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(inv, key, value)
    db.commit()
    return {"ok": True}


@router.delete("/{invoice_id}")
def delete_invoice(invoice_id: int, db: Session = Depends(get_db)):
    items = db.query(PartnerInvoiceItem).filter(PartnerInvoiceItem.partner_invoice_id == invoice_id).all()
    for item in items:
        db.delete(item)
    inv = db.query(PartnerInvoice).filter(PartnerInvoice.id == invoice_id).first()
    if inv:
        db.delete(inv)
    db.commit()
    return {"ok": True}
