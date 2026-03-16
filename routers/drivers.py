from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from database import get_db
from models import Driver

router = APIRouter()


class DriverCreate(BaseModel):
    name: str
    phone: str = ""
    license_type: str = "普通"
    status: str = "待機中"
    notes: str = ""


class DriverUpdate(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None
    license_type: Optional[str] = None
    status: Optional[str] = None
    notes: Optional[str] = None


@router.get("")
def list_drivers(db: Session = Depends(get_db)):
    return db.query(Driver).order_by(Driver.id.desc()).all()


@router.post("")
def create_driver(data: DriverCreate, db: Session = Depends(get_db)):
    driver = Driver(**data.model_dump())
    db.add(driver)
    db.commit()
    db.refresh(driver)
    return driver


@router.put("/{driver_id}")
def update_driver(driver_id: int, data: DriverUpdate, db: Session = Depends(get_db)):
    driver = db.query(Driver).filter(Driver.id == driver_id).first()
    if not driver:
        raise HTTPException(status_code=404, detail="ドライバーが見つかりません")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(driver, key, value)
    db.commit()
    db.refresh(driver)
    return driver


@router.delete("/{driver_id}")
def delete_driver(driver_id: int, db: Session = Depends(get_db)):
    driver = db.query(Driver).filter(Driver.id == driver_id).first()
    if not driver:
        raise HTTPException(status_code=404, detail="ドライバーが見つかりません")
    db.delete(driver)
    db.commit()
    return {"ok": True}
