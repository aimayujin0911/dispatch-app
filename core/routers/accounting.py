from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from datetime import date
from database import get_db
from models import AccountEntry, Shipment, Vehicle, VehicleCost, Dispatch, Attendance, Driver, User
from core.auth import get_current_user

router = APIRouter()

INCOME_CATEGORIES = ["運賃収入", "付帯作業収入", "その他収入"]
EXPENSE_CATEGORIES = ["燃料費", "高速代(ETC)", "修理・整備費", "保険料", "車検費用", "リース料",
                      "協力会社支払", "給与・手当", "事務所経費", "タイヤ代", "駐車場代", "その他支出"]


class EntryCreate(BaseModel):
    date: date
    entry_type: str = "収入"
    category: str = ""
    description: str = ""
    amount: int = 0
    related_shipment_id: Optional[int] = None
    related_partner_id: Optional[int] = None
    vehicle_id: Optional[int] = None
    notes: str = ""


class EntryUpdate(BaseModel):
    date: Optional[date] = None
    entry_type: Optional[str] = None
    category: Optional[str] = None
    description: Optional[str] = None
    amount: Optional[int] = None
    vehicle_id: Optional[int] = None
    notes: Optional[str] = None


def _tenant_vehicle_ids(db: Session, tenant_id: str) -> list:
    return [v.id for v in db.query(Vehicle.id).filter(Vehicle.tenant_id == tenant_id).all()]


def _tenant_shipment_ids(db: Session, tenant_id: str) -> list:
    return [s.id for s in db.query(Shipment.id).filter(Shipment.tenant_id == tenant_id).all()]


def _tenant_account_entries(db: Session, tenant_id: str):
    """Filter AccountEntry by tenant: entries linked to tenant's vehicles or shipments, or with no link"""
    vehicle_ids = _tenant_vehicle_ids(db, tenant_id)
    shipment_ids = _tenant_shipment_ids(db, tenant_id)
    from sqlalchemy import or_
    return db.query(AccountEntry).filter(
        or_(
            AccountEntry.vehicle_id.in_(vehicle_ids),
            AccountEntry.related_shipment_id.in_(shipment_ids),
            # Include entries with no vehicle/shipment link (general entries)
            # that were created within this tenant context
            (AccountEntry.vehicle_id == None) & (AccountEntry.related_shipment_id == None)
        )
    )


@router.get("")
def list_entries(year: int = 0, month: int = 0, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    vehicle_ids = _tenant_vehicle_ids(db, current_user.tenant_id)
    shipment_ids = _tenant_shipment_ids(db, current_user.tenant_id)
    from sqlalchemy import or_
    q = db.query(AccountEntry).filter(
        or_(
            AccountEntry.vehicle_id.in_(vehicle_ids) if vehicle_ids else False,
            AccountEntry.related_shipment_id.in_(shipment_ids) if shipment_ids else False,
            (AccountEntry.vehicle_id == None) & (AccountEntry.related_shipment_id == None),
        )
    )
    if year and month:
        start = date(year, month, 1)
        if month == 12:
            end = date(year + 1, 1, 1)
        else:
            end = date(year, month + 1, 1)
        q = q.filter(AccountEntry.date >= start, AccountEntry.date < end)
    entries = q.order_by(AccountEntry.date.desc()).all()
    result = []
    for e in entries:
        d = {c.name: getattr(e, c.name) for c in e.__table__.columns}
        d["date"] = str(e.date)
        d["type"] = e.entry_type
        if d.get("created_at"):
            d["created_at"] = str(d["created_at"])
        if e.vehicle_id:
            v = db.query(Vehicle).filter(Vehicle.id == e.vehicle_id).first()
            d["vehicle_number"] = v.number if v else ""
        else:
            d["vehicle_number"] = ""
        result.append(d)
    return result


@router.get("/categories")
def get_categories(current_user: User = Depends(get_current_user)):
    return {"income": INCOME_CATEGORIES, "expense": EXPENSE_CATEGORIES}


@router.get("/summary")
def get_summary(year: int = 0, month: int = 0, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    vehicle_ids = _tenant_vehicle_ids(db, current_user.tenant_id)
    shipment_ids = _tenant_shipment_ids(db, current_user.tenant_id)
    from sqlalchemy import or_
    q = db.query(AccountEntry).filter(
        or_(
            AccountEntry.vehicle_id.in_(vehicle_ids) if vehicle_ids else False,
            AccountEntry.related_shipment_id.in_(shipment_ids) if shipment_ids else False,
            (AccountEntry.vehicle_id == None) & (AccountEntry.related_shipment_id == None),
        )
    )
    if year and month:
        start = date(year, month, 1)
        if month == 12:
            end = date(year + 1, 1, 1)
        else:
            end = date(year, month + 1, 1)
        q = q.filter(AccountEntry.date >= start, AccountEntry.date < end)
    entries = q.all()
    income = sum(e.amount for e in entries if e.entry_type == "収入")
    expense = sum(e.amount for e in entries if e.entry_type == "支出")
    categories = {}
    for e in entries:
        if e.entry_type == "支出":
            key = e.category or "未分類"
            categories[key] = categories.get(key, 0) + e.amount
    return {"income": income, "expense": expense, "profit": income - expense, "categories": categories}


@router.get("/vehicle-pnl")
def vehicle_profit_loss(year: int = 0, month: int = 0, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """車両ごとの損益計算"""
    tid = current_user.tenant_id
    vehicles = db.query(Vehicle).filter(Vehicle.tenant_id == tid).all()
    vehicle_ids = [v.id for v in vehicles]

    from sqlalchemy import or_
    q_entries = db.query(AccountEntry).filter(
        or_(
            AccountEntry.vehicle_id.in_(vehicle_ids) if vehicle_ids else False,
            (AccountEntry.vehicle_id == None),
        )
    )
    q_dispatches = db.query(Dispatch).filter(Dispatch.tenant_id == tid)
    if year and month:
        start = date(year, month, 1)
        if month == 12:
            end = date(year + 1, 1, 1)
        else:
            end = date(year, month + 1, 1)
        q_entries = q_entries.filter(AccountEntry.date >= start, AccountEntry.date < end)
        q_dispatches = q_dispatches.filter(Dispatch.date >= start, Dispatch.date < end)
    entries = q_entries.all()
    dispatches = q_dispatches.all()

    vehicle_revenue = {}
    for d in dispatches:
        if d.shipment and d.shipment.price:
            vehicle_revenue[d.vehicle_id] = vehicle_revenue.get(d.vehicle_id, 0) + d.shipment.price

    # 車両紐付けなしの燃料費・高速代を走行距離で按分
    driver_ids = [d.id for d in db.query(Driver.id).filter(Driver.tenant_id == tid).all()]
    q_attendance = db.query(Attendance).filter(Attendance.driver_id.in_(driver_ids) if driver_ids else False)
    if year and month:
        q_attendance = q_attendance.filter(Attendance.date >= start, Attendance.date < end)
    attendances = q_attendance.all()

    # 車両ごとの月間走行距離を集計
    vehicle_distance = {}
    for a in attendances:
        if a.vehicle_id and a.distance_km:
            vehicle_distance[a.vehicle_id] = vehicle_distance.get(a.vehicle_id, 0) + a.distance_km
    total_distance = sum(vehicle_distance.values()) or 1  # 0除算防止

    # 車両紐付けなしの燃料費・高速代を集計
    unassigned_fuel = sum(e.amount for e in entries if e.entry_type == "支出" and e.category == "燃料費" and not e.vehicle_id)
    unassigned_highway = sum(e.amount for e in entries if e.entry_type == "支出" and e.category == "高速代(ETC)" and not e.vehicle_id)

    result = []
    for v in vehicles:
        revenue = vehicle_revenue.get(v.id, 0)
        # 車両紐付きの経費
        v_expenses = [e for e in entries if e.vehicle_id == v.id and e.entry_type == "支出"]
        expense_total = sum(e.amount for e in v_expenses)
        expense_by_cat = {}
        for e in v_expenses:
            cat = e.category or "その他"
            expense_by_cat[cat] = expense_by_cat.get(cat, 0) + e.amount

        # 走行距離による按分（燃料費・高速代）
        dist_ratio = vehicle_distance.get(v.id, 0) / total_distance
        allocated_fuel = int(unassigned_fuel * dist_ratio)
        allocated_highway = int(unassigned_highway * dist_ratio)
        expense_by_cat["燃料費"] = expense_by_cat.get("燃料費", 0) + allocated_fuel
        expense_by_cat["高速代(ETC)"] = expense_by_cat.get("高速代(ETC)", 0) + allocated_highway
        expense_total += allocated_fuel + allocated_highway

        # 固定費（VehicleCost）
        costs = db.query(VehicleCost).filter(VehicleCost.vehicle_id == v.id).all()
        monthly_fixed = sum(c.amount for c in costs if c.frequency == "月額")
        yearly_to_monthly = sum(c.amount // 12 for c in costs if c.frequency == "年額")
        fixed_total = monthly_fixed + yearly_to_monthly

        result.append({
            "vehicle_id": v.id,
            "vehicle_number": v.number,
            "vehicle_type": v.type,
            "revenue": revenue,
            "expense": expense_total,
            "fixed_cost": fixed_total,
            "profit": revenue - expense_total - fixed_total,
            "expense_by_category": expense_by_cat,
            "distance_km": round(vehicle_distance.get(v.id, 0), 1),
            "distance_ratio": round(dist_ratio * 100, 1),
        })
    return result


@router.post("")
def create_entry(data: EntryCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    # Verify vehicle belongs to tenant if specified
    if data.vehicle_id:
        vehicle = db.query(Vehicle).filter(Vehicle.id == data.vehicle_id, Vehicle.tenant_id == current_user.tenant_id).first()
        if not vehicle:
            raise HTTPException(status_code=404, detail="車両が見つかりません")
    entry = AccountEntry(**data.model_dump())
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return {"id": entry.id}


@router.post("/import-revenue")
def import_revenue(year: int = 0, month: int = 0, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """完了案件から売上を自動インポート"""
    tid = current_user.tenant_id
    q = db.query(Shipment).filter(Shipment.status == "完了", Shipment.tenant_id == tid)
    if year and month:
        start = date(year, month, 1)
        if month == 12:
            end = date(year + 1, 1, 1)
        else:
            end = date(year, month + 1, 1)
        q = q.filter(Shipment.delivery_date >= start, Shipment.delivery_date < end)
    month_shipments = q.all()
    created = 0
    for s in month_shipments:
        existing = db.query(AccountEntry).filter(
            AccountEntry.related_shipment_id == s.id,
            AccountEntry.entry_type == "収入"
        ).first()
        if existing:
            continue
        # 車両IDを配車から取得
        dispatch = db.query(Dispatch).filter(Dispatch.shipment_id == s.id, Dispatch.tenant_id == tid).first()
        entry = AccountEntry(
            date=s.delivery_date,
            entry_type="収入",
            category="運賃収入",
            description=f"{s.client_name}: {s.pickup_address} → {s.delivery_address}",
            amount=s.price,
            related_shipment_id=s.id,
            vehicle_id=dispatch.vehicle_id if dispatch else None,
        )
        db.add(entry)
        created += 1
    db.commit()
    return {"created": created}


@router.put("/{entry_id}")
def update_entry(entry_id: int, data: EntryUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    entry = db.query(AccountEntry).filter(AccountEntry.id == entry_id).first()
    if not entry:
        raise HTTPException(status_code=404, detail="仕訳が見つかりません")
    # Verify ownership through vehicle or shipment link
    if entry.vehicle_id:
        v = db.query(Vehicle).filter(Vehicle.id == entry.vehicle_id, Vehicle.tenant_id == current_user.tenant_id).first()
        if not v:
            raise HTTPException(status_code=404, detail="仕訳が見つかりません")
    if entry.related_shipment_id:
        s = db.query(Shipment).filter(Shipment.id == entry.related_shipment_id, Shipment.tenant_id == current_user.tenant_id).first()
        if not s:
            raise HTTPException(status_code=404, detail="仕訳が見つかりません")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(entry, key, value)
    db.commit()
    return {"ok": True}


@router.delete("/{entry_id}")
def delete_entry(entry_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    entry = db.query(AccountEntry).filter(AccountEntry.id == entry_id).first()
    if not entry:
        return {"ok": True}
    # Verify ownership through vehicle or shipment link
    if entry.vehicle_id:
        v = db.query(Vehicle).filter(Vehicle.id == entry.vehicle_id, Vehicle.tenant_id == current_user.tenant_id).first()
        if not v:
            raise HTTPException(status_code=404, detail="仕訳が見つかりません")
    if entry.related_shipment_id:
        s = db.query(Shipment).filter(Shipment.id == entry.related_shipment_id, Shipment.tenant_id == current_user.tenant_id).first()
        if not s:
            raise HTTPException(status_code=404, detail="仕訳が見つかりません")
    db.delete(entry)
    db.commit()
    return {"ok": True}


# --- Vehicle Costs ---
class VehicleCostCreate(BaseModel):
    vehicle_id: int
    cost_type: str = ""
    amount: int = 0
    frequency: str = "月額"
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    notes: str = ""


@router.get("/vehicle-costs")
def list_vehicle_costs(vehicle_id: int = 0, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    tenant_vehicle_ids = _tenant_vehicle_ids(db, current_user.tenant_id)
    q = db.query(VehicleCost).filter(VehicleCost.vehicle_id.in_(tenant_vehicle_ids))
    if vehicle_id:
        if vehicle_id not in tenant_vehicle_ids:
            return []
        q = q.filter(VehicleCost.vehicle_id == vehicle_id)
    costs = q.all()
    result = []
    for c in costs:
        v = db.query(Vehicle).filter(Vehicle.id == c.vehicle_id).first()
        result.append({
            "id": c.id, "vehicle_id": c.vehicle_id,
            "vehicle_number": v.number if v else "",
            "cost_type": c.cost_type, "amount": c.amount,
            "frequency": c.frequency,
            "start_date": str(c.start_date) if c.start_date else None,
            "end_date": str(c.end_date) if c.end_date else None,
            "notes": c.notes,
        })
    return result


@router.post("/vehicle-costs")
def create_vehicle_cost(data: VehicleCostCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    # Verify vehicle belongs to tenant
    vehicle = db.query(Vehicle).filter(Vehicle.id == data.vehicle_id, Vehicle.tenant_id == current_user.tenant_id).first()
    if not vehicle:
        raise HTTPException(status_code=404, detail="車両が見つかりません")
    cost = VehicleCost(**data.model_dump())
    db.add(cost)
    db.commit()
    return {"id": cost.id}


@router.delete("/vehicle-costs/{cost_id}")
def delete_vehicle_cost(cost_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    tenant_vehicle_ids = _tenant_vehicle_ids(db, current_user.tenant_id)
    cost = db.query(VehicleCost).filter(VehicleCost.id == cost_id, VehicleCost.vehicle_id.in_(tenant_vehicle_ids)).first()
    if cost:
        db.delete(cost)
        db.commit()
    return {"ok": True}
