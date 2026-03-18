from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
import csv
import io
from database import get_db
from models import Vehicle, Driver, Shipment, Dispatch, Client, PartnerCompany, Attendance, AccountEntry

router = APIRouter()


def csv_response(filename: str, headers: list, rows: list):
    output = io.StringIO()
    output.write('\ufeff')  # BOM for Excel
    writer = csv.writer(output)
    writer.writerow(headers)
    for row in rows:
        writer.writerow(row)
    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


@router.get("/vehicles")
def export_vehicles(db: Session = Depends(get_db)):
    vehicles = db.query(Vehicle).all()
    return csv_response("vehicles.csv",
        ["車両番号", "車台番号", "車種", "積載量(kg)", "ステータス", "初度登録", "車検期限", "備考"],
        [[v.number, v.chassis_number, v.type, v.capacity, v.status, v.first_registration, v.inspection_expiry, v.notes] for v in vehicles])


@router.get("/drivers")
def export_drivers(db: Session = Depends(get_db)):
    drivers = db.query(Driver).all()
    return csv_response("drivers.csv",
        ["名前", "電話番号", "免許種別", "ステータス", "備考"],
        [[d.name, d.phone, d.license_type, d.status, d.notes] for d in drivers])


@router.get("/shipments")
def export_shipments(db: Session = Depends(get_db)):
    shipments = db.query(Shipment).all()
    return csv_response("shipments.csv",
        ["案件名", "荷主", "荷物", "重量(kg)", "積地", "卸地", "集荷日", "集荷時間", "配達日", "配達時間", "時間備考", "運賃", "頻度", "ステータス", "請求状態", "請求日", "備考"],
        [[s.name, s.client_name, s.cargo_description, s.weight, s.pickup_address, s.delivery_address,
          str(s.pickup_date), s.pickup_time, str(s.delivery_date), s.delivery_time, s.time_note,
          s.price, s.frequency_type, s.status, s.invoice_status, str(s.invoice_date) if s.invoice_date else "", s.notes] for s in shipments])


@router.get("/dispatches")
def export_dispatches(db: Session = Depends(get_db)):
    dispatches = db.query(Dispatch).all()
    rows = []
    for d in dispatches:
        v = db.query(Vehicle).filter(Vehicle.id == d.vehicle_id).first()
        dr = db.query(Driver).filter(Driver.id == d.driver_id).first()
        s = db.query(Shipment).filter(Shipment.id == d.shipment_id).first() if d.shipment_id else None
        rows.append([str(d.date), d.start_time, d.end_time,
                     v.number if v else "", dr.name if dr else "",
                     s.client_name if s else "", s.pickup_address if s else "", s.delivery_address if s else "",
                     s.price if s else 0, d.status, d.notes])
    return csv_response("dispatches.csv",
        ["日付", "開始時刻", "終了時刻", "車両", "ドライバー", "荷主", "積地", "卸地", "運賃", "ステータス", "備考"],
        rows)


@router.get("/clients")
def export_clients(db: Session = Depends(get_db)):
    clients = db.query(Client).all()
    return csv_response("clients.csv",
        ["企業名", "住所", "電話番号", "FAX", "担当者", "備考"],
        [[c.name, c.address, c.phone, c.fax if hasattr(c, 'fax') else "", c.contact_person, c.notes] for c in clients])


@router.get("/partners")
def export_partners(db: Session = Depends(get_db)):
    partners = db.query(PartnerCompany).all()
    return csv_response("partners.csv",
        ["会社名", "住所", "電話番号", "FAX", "担当者", "振込先", "支払条件", "備考"],
        [[p.name, p.address, p.phone, p.fax, p.contact_person, p.bank_info, p.payment_terms, p.notes] for p in partners])


@router.get("/attendance")
def export_attendance(db: Session = Depends(get_db)):
    records = db.query(Attendance).order_by(Attendance.date).all()
    rows = []
    for a in records:
        dr = db.query(Driver).filter(Driver.id == a.driver_id).first()
        rows.append([str(a.date), dr.name if dr else "", a.clock_in, a.clock_out, a.break_minutes,
                     a.work_type, a.overtime_minutes, a.late_night_minutes, a.distance_km, a.allowance, a.notes])
    return csv_response("attendance.csv",
        ["日付", "ドライバー", "出勤", "退勤", "休憩(分)", "勤務種別", "残業(分)", "深夜(分)", "走行距離(km)", "手当", "備考"],
        rows)


@router.get("/accounting")
def export_accounting(db: Session = Depends(get_db)):
    entries = db.query(AccountEntry).order_by(AccountEntry.date).all()
    return csv_response("accounting.csv",
        ["日付", "種別", "カテゴリ", "摘要", "金額", "備考"],
        [[str(e.date), e.entry_type, e.category, e.description, e.amount, e.notes] for e in entries])
