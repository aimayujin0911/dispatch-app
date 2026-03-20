from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

from database import get_db
from models import Inquiry, User
from auth import get_current_user

router = APIRouter()


class InquiryCreate(BaseModel):
    company: str = ""
    name: str
    email: str
    phone: str = ""
    message: str = ""


@router.post("")
def create_inquiry(req: InquiryCreate, db: Session = Depends(get_db)):
    """問い合わせ作成（認証不要 - LP公開フォーム）"""
    if not req.name or not req.email:
        raise HTTPException(status_code=400, detail="名前とメールアドレスは必須です")
    inquiry = Inquiry(
        company=req.company,
        name=req.name,
        email=req.email,
        phone=req.phone,
        message=req.message,
    )
    db.add(inquiry)
    db.commit()
    db.refresh(inquiry)
    return {"id": inquiry.id, "message": "お問い合わせを受け付けました"}


@router.get("")
def list_inquiries(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """問い合わせ一覧（オペレーターのみ）"""
    if current_user.role != "operator":
        raise HTTPException(status_code=403, detail="運営管理者のみアクセスできます")
    inquiries = db.query(Inquiry).order_by(Inquiry.created_at.desc()).all()
    return [{
        "id": i.id,
        "company": i.company,
        "name": i.name,
        "email": i.email,
        "phone": i.phone,
        "message": i.message,
        "status": i.status,
        "created_at": str(i.created_at) if i.created_at else None,
    } for i in inquiries]


class InquiryUpdate(BaseModel):
    status: Optional[str] = None


@router.put("/{inquiry_id}")
def update_inquiry(
    inquiry_id: int,
    req: InquiryUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """問い合わせステータス更新（オペレーターのみ）"""
    if current_user.role != "operator":
        raise HTTPException(status_code=403, detail="運営管理者のみアクセスできます")
    inquiry = db.query(Inquiry).filter(Inquiry.id == inquiry_id).first()
    if not inquiry:
        raise HTTPException(status_code=404, detail="問い合わせが見つかりません")
    if req.status:
        inquiry.status = req.status
    db.commit()
    return {"message": "更新しました"}
