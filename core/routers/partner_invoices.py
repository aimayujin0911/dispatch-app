import os
import re
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List
from datetime import date
from database import get_db
from models import PartnerInvoice, PartnerInvoiceItem, PartnerCompany, User
from core.auth import get_current_user

router = APIRouter()

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "uploads")


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
    pdf_filename: str = ""
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


def _tenant_partner_ids(db: Session, tenant_id: str) -> list:
    """Get partner IDs belonging to this tenant"""
    return [p.id for p in db.query(PartnerCompany.id).filter(PartnerCompany.tenant_id == tenant_id).all()]


@router.get("")
def list_invoices(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    partner_ids = _tenant_partner_ids(db, current_user.tenant_id)
    invoices = db.query(PartnerInvoice).filter(PartnerInvoice.partner_id.in_(partner_ids)).order_by(PartnerInvoice.invoice_date.desc()).all()
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
            "pdf_filename": inv.pdf_filename or "",
            "items": [{"id": it.id, "date": str(it.date) if it.date else None, "description": it.description, "amount": it.amount, "notes": it.notes} for it in items],
        }
        result.append(d)
    return result


@router.post("")
def create_invoice(data: InvoiceCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    # Verify partner belongs to tenant
    partner = db.query(PartnerCompany).filter(PartnerCompany.id == data.partner_id, PartnerCompany.tenant_id == current_user.tenant_id).first()
    if not partner:
        raise HTTPException(status_code=404, detail="協力会社が見つかりません")
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


@router.post("/upload-pdf")
async def upload_pdf(file: UploadFile = File(...), db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """PDFアップロード→テキスト抽出→請求情報を自動解析"""
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    filename = f"invoice_{int(__import__('time').time())}_{file.filename}"
    filepath = os.path.join(UPLOAD_DIR, filename)
    content = await file.read()
    with open(filepath, "wb") as f:
        f.write(content)

    # PDF内テキスト抽出を試みる（簡易解析）
    extracted = _extract_invoice_data(content)
    extracted["pdf_filename"] = filename

    return extracted


def _extract_invoice_data(pdf_bytes: bytes) -> dict:
    """PDFバイトデータから請求情報を簡易抽出"""
    text = ""
    try:
        # pdfminerが使える場合
        from pdfminer.high_level import extract_text
        import io
        text = extract_text(io.BytesIO(pdf_bytes))
    except ImportError:
        pass

    if not text:
        try:
            # PyPDF2フォールバック
            import PyPDF2
            import io
            reader = PyPDF2.PdfReader(io.BytesIO(pdf_bytes))
            for page in reader.pages:
                text += page.extract_text() or ""
        except ImportError:
            pass

    if not text:
        return {"extracted_text": "", "auto_parsed": False}

    # テキストから金額・日付・請求番号を正規表現で抽出
    result = {"extracted_text": text[:2000], "auto_parsed": True}

    # 合計金額パターン
    amount_patterns = [
        r'合計[金額\s]*[¥￥]?\s*([0-9,]+)',
        r'請求金額[\s:：]*[¥￥]?\s*([0-9,]+)',
        r'ご請求額[\s:：]*[¥￥]?\s*([0-9,]+)',
        r'[¥￥]\s*([0-9,]{4,})',
    ]
    for p in amount_patterns:
        m = re.search(p, text)
        if m:
            result["total_amount"] = int(m.group(1).replace(",", ""))
            break

    # 消費税
    tax_patterns = [r'消費税[額\s]*[¥￥]?\s*([0-9,]+)', r'税額[\s:：]*[¥￥]?\s*([0-9,]+)']
    for p in tax_patterns:
        m = re.search(p, text)
        if m:
            result["tax_amount"] = int(m.group(1).replace(",", ""))
            break

    # 請求番号
    num_patterns = [r'請求番号[:\s：]*([A-Z0-9\-]+)', r'No[.\s:：]*([A-Z0-9\-]+)']
    for p in num_patterns:
        m = re.search(p, text)
        if m:
            result["invoice_number"] = m.group(1)
            break

    # 日付
    date_patterns = [r'(\d{4})[年/\-](\d{1,2})[月/\-](\d{1,2})']
    dates = re.findall(date_patterns[0], text)
    if dates:
        result["invoice_date"] = f"{dates[0][0]}-{int(dates[0][1]):02d}-{int(dates[0][2]):02d}"
        if len(dates) > 1:
            result["due_date"] = f"{dates[1][0]}-{int(dates[1][1]):02d}-{int(dates[1][2]):02d}"

    return result


@router.put("/{invoice_id}")
def update_invoice(invoice_id: int, data: InvoiceUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    partner_ids = _tenant_partner_ids(db, current_user.tenant_id)
    inv = db.query(PartnerInvoice).filter(PartnerInvoice.id == invoice_id, PartnerInvoice.partner_id.in_(partner_ids)).first()
    if not inv:
        raise HTTPException(status_code=404, detail="請求書が見つかりません")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(inv, key, value)
    db.commit()
    return {"ok": True}


@router.delete("/{invoice_id}")
def delete_invoice(invoice_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    partner_ids = _tenant_partner_ids(db, current_user.tenant_id)
    inv = db.query(PartnerInvoice).filter(PartnerInvoice.id == invoice_id, PartnerInvoice.partner_id.in_(partner_ids)).first()
    if not inv:
        raise HTTPException(status_code=404, detail="請求書が見つかりません")
    items = db.query(PartnerInvoiceItem).filter(PartnerInvoiceItem.partner_invoice_id == invoice_id).all()
    for item in items:
        db.delete(item)
    # PDFファイルも削除
    if inv.pdf_filename:
        pdf_path = os.path.join(UPLOAD_DIR, inv.pdf_filename)
        if os.path.exists(pdf_path):
            os.remove(pdf_path)
    db.delete(inv)
    db.commit()
    return {"ok": True}
