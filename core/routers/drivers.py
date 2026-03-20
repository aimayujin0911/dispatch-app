from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from datetime import date
from database import get_db
from models import Driver, User
from auth import get_current_user, hash_password

router = APIRouter()


class DriverCreate(BaseModel):
    name: str
    phone: str = ""
    email: str = ""
    password: str = ""
    license_type: str = "普通"
    license_expiry: str = ""
    status: str = "待機中"
    hire_date: Optional[date] = None
    paid_leave_balance: float = 10.0
    work_start: str = "08:00"
    work_end: str = "17:00"
    notes: str = ""


class DriverUpdate(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    password: Optional[str] = None
    license_type: Optional[str] = None
    license_expiry: Optional[str] = None
    status: Optional[str] = None
    hire_date: Optional[date] = None
    paid_leave_balance: Optional[float] = None
    work_start: Optional[str] = None
    work_end: Optional[str] = None
    notes: Optional[str] = None


class DriverLogin(BaseModel):
    email: str
    password: str


@router.get("")
def list_drivers(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    drivers = db.query(Driver).filter(Driver.tenant_id == current_user.tenant_id).order_by(Driver.id).all()
    # 紐付いたUser情報をまとめて取得
    driver_ids = [d.id for d in drivers]
    linked_users = {u.driver_id: u for u in db.query(User).filter(User.driver_id.in_(driver_ids)).all()} if driver_ids else {}
    result = []
    for d in drivers:
        linked = linked_users.get(d.id)
        result.append({
            "id": d.id, "name": d.name, "phone": d.phone,
            "email": d.email or "",
            "license_type": d.license_type,
            "license_expiry": getattr(d, 'license_expiry', '') or '',
            "status": d.status,
            "hire_date": str(d.hire_date) if d.hire_date else "",
            "paid_leave_balance": getattr(d, 'paid_leave_balance', 10.0) or 10.0,
            "work_start": getattr(d, 'work_start', '08:00') or '08:00',
            "work_end": getattr(d, 'work_end', '17:00') or '17:00',
            "has_login": bool(linked and linked.login_id and linked.password_hash),
            "login_id": linked.login_id or "" if linked else "",
            "user_id": linked.id if linked else None,
            "notes": d.notes,
        })
    return result


@router.get("/{driver_id}")
def get_driver(driver_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    d = db.query(Driver).filter(Driver.id == driver_id, Driver.tenant_id == current_user.tenant_id).first()
    if not d:
        raise HTTPException(status_code=404, detail="ドライバーが見つかりません")
    return {
        "id": d.id, "name": d.name, "phone": d.phone,
        "email": d.email or "",
        "license_type": d.license_type,
        "license_expiry": getattr(d, 'license_expiry', '') or '',
        "status": d.status,
        "hire_date": str(d.hire_date) if d.hire_date else "",
        "paid_leave_balance": getattr(d, 'paid_leave_balance', 10.0) or 10.0,
        "work_start": getattr(d, 'work_start', '08:00') or '08:00',
        "work_end": getattr(d, 'work_end', '17:00') or '17:00',
        "has_login": bool(d.email and d.password_hash),
        "notes": d.notes,
    }


@router.post("")
def create_driver(data: DriverCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    driver_data = data.model_dump(exclude={"password"})
    driver = Driver(**driver_data)
    driver.tenant_id = current_user.tenant_id
    driver.branch_id = current_user.branch_id
    if data.password:
        driver.password_hash = hash_password(data.password)
    db.add(driver)
    db.flush()  # IDを確定

    # ログイン用Userも自動作成（パスワード/ログインID未設定=ログイン不可）
    user = User(
        name=driver.name,
        role="driver",
        tenant_id=current_user.tenant_id,
        branch_id=current_user.branch_id,
        driver_id=driver.id,
        password_hash="",  # 空=ログイン不可、後からユーザー管理で設定
    )
    db.add(user)
    db.commit()
    db.refresh(driver)
    return {"id": driver.id, "name": driver.name}


@router.put("/{driver_id}")
def update_driver(driver_id: int, data: DriverUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    driver = db.query(Driver).filter(Driver.id == driver_id, Driver.tenant_id == current_user.tenant_id).first()
    if not driver:
        raise HTTPException(status_code=404, detail="ドライバーが見つかりません")
    update_data = data.model_dump(exclude_unset=True)
    password = update_data.pop("password", None)
    for key, value in update_data.items():
        setattr(driver, key, value)
    if password:
        driver.password_hash = hash_password(password)
    # 紐付いたUserの名前も同期
    if "name" in update_data:
        linked_user = db.query(User).filter(User.driver_id == driver_id).first()
        if linked_user:
            linked_user.name = update_data["name"]
    db.commit()
    db.refresh(driver)
    return {"ok": True}


@router.delete("/{driver_id}")
def delete_driver(driver_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    driver = db.query(Driver).filter(Driver.id == driver_id, Driver.tenant_id == current_user.tenant_id).first()
    if not driver:
        raise HTTPException(status_code=404, detail="ドライバーが見つかりません")
    db.delete(driver)
    db.commit()
    return {"ok": True}


@router.post("/login")
def driver_login(data: DriverLogin, db: Session = Depends(get_db)):
    """ドライバーの勤怠アプリログイン"""
    driver = db.query(Driver).filter(Driver.email == data.email).first()
    if not driver or not driver.password_hash:
        raise HTTPException(status_code=401, detail="メールアドレスまたはパスワードが正しくありません")
    if driver.password_hash != hash_password(data.password):
        raise HTTPException(status_code=401, detail="メールアドレスまたはパスワードが正しくありません")
    return {"id": driver.id, "name": driver.name, "email": driver.email}


@router.put("/{driver_id}/leave")
def update_leave_balance(driver_id: int, delta: float = 0, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """有給残日数の更新"""
    driver = db.query(Driver).filter(Driver.id == driver_id, Driver.tenant_id == current_user.tenant_id).first()
    if not driver:
        raise HTTPException(status_code=404, detail="ドライバーが見つかりません")
    driver.paid_leave_balance = max(0, (driver.paid_leave_balance or 0) + delta)
    db.commit()
    return {"paid_leave_balance": driver.paid_leave_balance}
