from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from datetime import date
from database import get_db
from models import AccountEntry, Shipment, Vehicle, VehicleCost, Dispatch

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
        # 車両名取得
        if e.vehicle_id:
            v = db.query(Vehicle).filter(Vehicle.id == e.vehicle_id).first()
            d["vehicle_number"] = v.number if v else ""
        else:
            d["vehicle_number"] = ""
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


@router.get("/vehicle-pnl")
def vehicle_profit_loss(month: str = "", db: Session = Depends(get_db)):
    """車両ごとの損益計算"""
    vehicles = db.query(Vehicle).all()
    entries = db.query(AccountEntry).all()
    if month:
        entries = [e for e in entries if str(e.date).startswith(month)]

    # 車両ごとの売上は配車→案件から算出
    dispatches = db.query(Dispatch).all()
    if month:
        dispatches = [d for d in dispatches if str(d.date).startswith(month)]

    vehicle_revenue = {}
    for d in dispatches:
        if d.shipment and d.shipment.price:
            vehicle_revenue[d.vehicle_id] = vehicle_revenue.get(d.vehicle_id, 0) + d.shipment.price

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

        # 固定費（VehicleCost）
        from database import SessionLocal
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
        })
    return result


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
        # 車両IDを配車から取得
        dispatch = db.query(Dispatch).filter(Dispatch.shipment_id == s.id).first()
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
def list_vehicle_costs(vehicle_id: int = 0, db: Session = Depends(get_db)):
    q = db.query(VehicleCost)
    if vehicle_id:
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
def create_vehicle_cost(data: VehicleCostCreate, db: Session = Depends(get_db)):
    cost = VehicleCost(**data.model_dump())
    db.add(cost)
    db.commit()
    return {"id": cost.id}


@router.delete("/vehicle-costs/{cost_id}")
def delete_vehicle_cost(cost_id: int, db: Session = Depends(get_db)):
    cost = db.query(VehicleCost).filter(VehicleCost.id == cost_id).first()
    if cost:
        db.delete(cost)
        db.commit()
    return {"ok": True}
