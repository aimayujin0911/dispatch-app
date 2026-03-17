from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from database import get_db
from models import CompanySettings

router = APIRouter()


class SettingsUpdate(BaseModel):
    company_name: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    fax: Optional[str] = None
    representative: Optional[str] = None
    registration_number: Optional[str] = None
    bank_info: Optional[str] = None
    notes: Optional[str] = None


@router.get("")
def get_settings(db: Session = Depends(get_db)):
    settings = db.query(CompanySettings).first()
    if not settings:
        settings = CompanySettings(id=1)
        db.add(settings)
        db.commit()
        db.refresh(settings)
    return settings


@router.put("")
def update_settings(data: SettingsUpdate, db: Session = Depends(get_db)):
    settings = db.query(CompanySettings).first()
    if not settings:
        settings = CompanySettings(id=1)
        db.add(settings)
        db.commit()
        db.refresh(settings)
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(settings, key, value)
    db.commit()
    return settings
