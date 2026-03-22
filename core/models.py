from sqlalchemy import Column, Integer, String, Float, Date, DateTime, ForeignKey, Text, Boolean, Index
from sqlalchemy.orm import relationship
from datetime import datetime
from database import Base


class Branch(Base):
    """営業所"""
    __tablename__ = "branches"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(String(50), default="")
    name = Column(String(100), nullable=False)
    address = Column(String(200), default="")
    phone = Column(String(20), default="")
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.now)

    users = relationship("User", back_populates="branch")


class User(Base):
    """ログインユーザー"""
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(100), unique=True, nullable=True, index=True)
    login_id = Column(String(50), unique=True, nullable=True, index=True)  # ドライバー用ログインID（メール不要）
    password_hash = Column(String(200), nullable=False)
    name = Column(String(50), nullable=False)
    role = Column(String(20), default="dispatcher")  # admin/manager/dispatcher/driver
    tenant_id = Column(String(50), default="")
    branch_id = Column(Integer, ForeignKey("branches.id"), nullable=True)
    driver_id = Column(Integer, ForeignKey("drivers.id"), nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.now)

    branch = relationship("Branch", back_populates="users")
    accessible_tenants = relationship("UserTenant", back_populates="user", cascade="all, delete-orphan")


class UserTenant(Base):
    """ユーザーがアクセス可能な追加テナント"""
    __tablename__ = "user_tenants"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    tenant_id = Column(String(50), nullable=False)

    user = relationship("User", back_populates="accessible_tenants")


class CompanySettings(Base):
    __tablename__ = "company_settings"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(String(50), default="", index=True)
    company_name = Column(String(100), default="")
    address = Column(String(200), default="")
    phone = Column(String(20), default="")
    fax = Column(String(20), default="")
    representative = Column(String(50), default="")
    registration_number = Column(String(50), default="")  # 適格請求書発行事業者登録番号
    bank_info = Column(Text, default="")
    notes = Column(Text, default="")
    # 請求書追加情報
    postal_code = Column(String(10), default="")
    email = Column(String(100), default="")
    payment_terms = Column(String(100), default="月末締め翌月末払い")
    tax_rate = Column(Integer, default=10)  # 消費税率(%)
    seal_text = Column(String(50), default="")  # 社印テキスト
    invoice_note = Column(String(200), default="")  # 請求書備考
    # SMTP設定（請求書メール送付用）
    smtp_host = Column(String(100), default="")
    smtp_port = Column(Integer, default=587)
    smtp_user = Column(String(100), default="")
    smtp_password = Column(String(200), default="")
    sender_email = Column(String(100), default="")


class Client(Base):
    __tablename__ = "clients"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(String(50), default="", index=True)
    name = Column(String(100), nullable=False)
    address = Column(String(200), default="")
    phone = Column(String(20), default="")
    fax = Column(String(20), default="")
    contact_person = Column(String(50), default="")
    notes = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.now)
    # 請求先情報
    billing_address = Column(String(200), default="")
    billing_contact = Column(String(50), default="")
    billing_email = Column(String(100), default="")
    payment_terms = Column(String(50), default="月末締め翌月末払い")
    credit_limit = Column(Integer, default=0)
    tax_id = Column(String(50), default="")
    bank_info = Column(Text, default="")


class ClientNote(Base):
    __tablename__ = "client_notes"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False)
    date = Column(DateTime, default=datetime.now)
    content = Column(Text, default="")
    created_by = Column(String(50), default="")

    client = relationship("Client", backref="notes_log")


class PartnerCompany(Base):
    __tablename__ = "partner_companies"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(String(50), default="", index=True)
    name = Column(String(100), unique=True, nullable=False)
    address = Column(String(200), default="")
    phone = Column(String(20), default="")
    fax = Column(String(20), default="")
    email = Column(String(100), default="")
    contact_person = Column(String(50), default="")
    bank_info = Column(Text, default="")
    payment_terms = Column(String(50), default="月末締め翌月末払い")
    notes = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.now)


class PartnerInvoice(Base):
    __tablename__ = "partner_invoices"

    id = Column(Integer, primary_key=True, index=True)
    partner_id = Column(Integer, ForeignKey("partner_companies.id"), nullable=False)
    invoice_number = Column(String(50), default="")
    invoice_date = Column(Date, nullable=True)
    due_date = Column(Date, nullable=True)
    total_amount = Column(Integer, default=0)
    tax_amount = Column(Integer, default=0)
    status = Column(String(20), default="未確認")
    payment_date = Column(Date, nullable=True)
    period_start = Column(Date, nullable=True)
    period_end = Column(Date, nullable=True)
    notes = Column(Text, default="")
    pdf_filename = Column(String(200), default="")
    created_at = Column(DateTime, default=datetime.now)

    partner = relationship("PartnerCompany")


class PartnerInvoiceItem(Base):
    __tablename__ = "partner_invoice_items"

    id = Column(Integer, primary_key=True, index=True)
    partner_invoice_id = Column(Integer, ForeignKey("partner_invoices.id"), nullable=False)
    date = Column(Date, nullable=True)
    description = Column(String(200), default="")
    amount = Column(Integer, default=0)
    shipment_id = Column(Integer, ForeignKey("shipments.id"), nullable=True)
    notes = Column(String(200), default="")


class TransportRequest(Base):
    __tablename__ = "transport_requests"

    id = Column(Integer, primary_key=True, index=True)
    request_number = Column(String(30), default="")
    partner_id = Column(Integer, ForeignKey("partner_companies.id"), nullable=False)
    shipment_id = Column(Integer, ForeignKey("shipments.id"), nullable=True)
    request_date = Column(Date, nullable=True)
    pickup_date = Column(Date, nullable=True)
    pickup_time = Column(String(50), default="")
    delivery_date = Column(Date, nullable=True)
    delivery_time = Column(String(50), default="")
    pickup_address = Column(String(200), default="")
    pickup_contact = Column(String(100), default="")
    delivery_address = Column(String(200), default="")
    delivery_contact = Column(String(100), default="")
    cargo_description = Column(String(200), default="")
    cargo_weight = Column(Float, default=0)
    cargo_quantity = Column(String(50), default="")
    vehicle_type_required = Column(String(50), default="")
    special_instructions = Column(Text, default="")
    freight_amount = Column(Integer, default=0)
    status = Column(String(20), default="下書き")
    notes = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.now)

    partner = relationship("PartnerCompany")
    shipment = relationship("Shipment", foreign_keys=[shipment_id])


class VehicleNotification(Base):
    __tablename__ = "vehicle_notifications"

    id = Column(Integer, primary_key=True, index=True)
    dispatch_id = Column(Integer, ForeignKey("dispatches.id"), nullable=True)
    notification_date = Column(Date, nullable=True)
    arrival_date = Column(Date, nullable=True)
    arrival_time = Column(String(50), default="")
    vehicle_number = Column(String(20), default="")
    vehicle_type = Column(String(50), default="")
    driver_name = Column(String(50), default="")
    driver_phone = Column(String(20), default="")
    cargo_description = Column(String(200), default="")
    quantity = Column(String(50), default="")
    destination_name = Column(String(100), default="")
    destination_address = Column(String(200), default="")
    destination_contact = Column(String(100), default="")
    sender_name = Column(String(100), default="")
    special_notes = Column(Text, default="")
    status = Column(String(20), default="未送付")
    created_at = Column(DateTime, default=datetime.now)


class Vendor(Base):
    """取引先（燃料店、ETC会社、整備工場等）"""
    __tablename__ = "vendors"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    vendor_type = Column(String(50), default="")  # 燃料, ETC, 整備, タイヤ, 保険, その他
    address = Column(String(200), default="")
    phone = Column(String(20), default="")
    contact_person = Column(String(50), default="")
    billing_cycle = Column(String(50), default="月末締め翌月末払い")
    account_number = Column(String(50), default="")  # 契約番号・顧客番号
    notes = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.now)


class Attendance(Base):
    __tablename__ = "attendance"

    id = Column(Integer, primary_key=True, index=True)
    driver_id = Column(Integer, ForeignKey("drivers.id"), nullable=False)
    vehicle_id = Column(Integer, ForeignKey("vehicles.id"), nullable=True)
    date = Column(Date, nullable=False)
    clock_in = Column(String(5), default="")
    clock_out = Column(String(5), default="")
    break_minutes = Column(Integer, default=60)
    break_location = Column(String(100), default="")
    work_type = Column(String(20), default="通常")
    overtime_minutes = Column(Integer, default=0)
    late_night_minutes = Column(Integer, default=0)
    # 運行情報
    departure_time = Column(String(5), default="")  # 出庫時間
    return_time = Column(String(5), default="")      # 帰庫時間
    distance_km = Column(Float, default=0)
    routes = Column(Text, default="")  # JSON: 運行経路
    # 点呼
    pre_check_time = Column(String(5), default="")   # 出庫前点呼時間
    post_check_time = Column(String(5), default="")  # 帰庫後点呼時間
    alcohol_check = Column(String(20), default="")   # 異常なし/要確認
    # 作業時間
    waiting_time = Column(Integer, default=0)
    loading_time = Column(Integer, default=0)
    unloading_time = Column(Integer, default=0)
    # 給油・高速
    fuel_liters = Column(Float, default=0)
    fuel_cost = Column(Integer, default=0)
    highway_cost = Column(Integer, default=0)
    highway_sections = Column(String(200), default="")  # 高速区間
    # その他
    allowance = Column(Integer, default=0)
    weather = Column(String(20), default="")  # 晴/曇/雨/雪
    incidents = Column(Text, default="")  # 事故・故障等
    notes = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.now)

    driver = relationship("Driver")
    vehicle = relationship("Vehicle", foreign_keys=[vehicle_id])


class AccountEntry(Base):
    __tablename__ = "account_entries"

    id = Column(Integer, primary_key=True, index=True)
    date = Column(Date, nullable=False)
    entry_type = Column(String(20), default="収入")
    category = Column(String(50), default="")
    description = Column(String(200), default="")
    amount = Column(Integer, default=0)
    related_shipment_id = Column(Integer, nullable=True)
    related_partner_id = Column(Integer, nullable=True)
    vehicle_id = Column(Integer, ForeignKey("vehicles.id"), nullable=True)
    notes = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.now)

    vehicle = relationship("Vehicle", foreign_keys=[vehicle_id])


class VehicleCost(Base):
    """車両ごとの固定費用（月額リース料、保険料等）"""
    __tablename__ = "vehicle_costs"

    id = Column(Integer, primary_key=True, index=True)
    vehicle_id = Column(Integer, ForeignKey("vehicles.id"), nullable=False)
    cost_type = Column(String(50), default="")  # リース料, 保険料, 車検費用 etc
    amount = Column(Integer, default=0)
    frequency = Column(String(20), default="月額")  # 月額, 年額, 一回
    start_date = Column(Date, nullable=True)
    end_date = Column(Date, nullable=True)
    notes = Column(String(200), default="")
    created_at = Column(DateTime, default=datetime.now)

    vehicle = relationship("Vehicle")


class Vehicle(Base):
    __tablename__ = "vehicles"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(String(50), default="", index=True)
    branch_id = Column(Integer, ForeignKey("branches.id"), nullable=True)
    number = Column(String(20), nullable=False)
    chassis_number = Column(String(30), default="")
    type = Column(String(50), nullable=False)  # ウイング車/平ボディ/バン/ユニック車/トレーラー
    temperature_zone = Column(String(20), default="常温")  # 常温/冷蔵/冷凍/冷蔵冷凍兼用
    has_power_gate = Column(Boolean, default=False)  # パワーゲート有無
    capacity = Column(Float, nullable=False)
    status = Column(String(20), default="空車")
    first_registration = Column(String(10), default="")
    inspection_expiry = Column(String(10), default="")
    notes = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.now)

    dispatches = relationship("Dispatch", back_populates="vehicle")


class Driver(Base):
    __tablename__ = "drivers"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(String(50), default="", index=True)
    branch_id = Column(Integer, ForeignKey("branches.id"), nullable=True)
    name = Column(String(50), nullable=False)
    phone = Column(String(20), default="")
    email = Column(String(100), default="")
    password_hash = Column(String(200), default="")
    license_type = Column(String(30), default="普通")
    license_expiry = Column(String(10), default="")
    status = Column(String(20), default="待機中")
    hire_date = Column(Date, nullable=True)
    paid_leave_balance = Column(Float, default=10.0)
    work_start = Column(String(5), default="08:00")
    work_end = Column(String(5), default="17:00")
    notes = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.now)

    dispatches = relationship("Dispatch", back_populates="driver")
    daily_reports = relationship("DailyReport", back_populates="driver")


class Shipment(Base):
    __tablename__ = "shipments"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(String(50), default="", index=True)
    branch_id = Column(Integer, ForeignKey("branches.id"), nullable=True)
    name = Column(String(100), default="")
    client_name = Column(String(100), nullable=False)
    cargo_description = Column(String(200), default="")
    weight = Column(Float, default=0)
    pickup_address = Column(String(200), nullable=False)
    delivery_address = Column(String(200), nullable=False)
    pickup_date = Column(Date, nullable=False)
    pickup_time = Column(String(50), default="")
    delivery_date = Column(Date, nullable=False)
    delivery_time = Column(String(50), default="")
    time_note = Column(String(100), default="")
    price = Column(Integer, default=0)
    # 輸送タイプ・請求単価
    transport_type = Column(String(20), default="ドライ")  # ドライ/危険物
    temperature_zone = Column(String(20), default="常温")  # 常温/冷蔵/冷凍/チルド
    unit_price_type = Column(String(20), default="個建")  # 個建/kg単価/ケース単価/車建/才建
    unit_price = Column(Float, default=0)  # 単価
    unit_quantity = Column(Float, default=0)  # 数量
    frequency_type = Column(String(20), default="単発")
    frequency_days = Column(String(50), default="")
    status = Column(String(20), default="未配車")
    invoice_status = Column(String(20), default="未請求")
    invoice_date = Column(Date, nullable=True)
    # 作業時間
    waiting_time = Column(Integer, default=0)
    loading_time = Column(Integer, default=0)
    unloading_time = Column(Integer, default=0)
    notes = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.now)

    __table_args__ = (
        Index('ix_shipments_tenant_status', 'tenant_id', 'status'),
    )

    dispatches = relationship("Dispatch", back_populates="shipment")


class Dispatch(Base):
    __tablename__ = "dispatches"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(String(50), default="", index=True)
    vehicle_id = Column(Integer, ForeignKey("vehicles.id"), nullable=True)
    driver_id = Column(Integer, ForeignKey("drivers.id"), nullable=True)
    partner_id = Column(Integer, ForeignKey("partner_companies.id"), nullable=True)
    shipment_id = Column(Integer, ForeignKey("shipments.id"), nullable=True)
    date = Column(Date, nullable=False)
    end_date = Column(Date, nullable=True)
    start_time = Column(String(5), default="08:00")
    end_time = Column(String(5), default="17:00")
    status = Column(String(20), default="予定")
    notes = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.now)

    __table_args__ = (
        Index('ix_dispatches_tenant_date', 'tenant_id', 'date'),
    )

    vehicle = relationship("Vehicle", back_populates="dispatches")
    driver = relationship("Driver", back_populates="dispatches")
    partner = relationship("PartnerCompany")
    shipment = relationship("Shipment", back_populates="dispatches")


class DailyReport(Base):
    __tablename__ = "daily_reports"

    id = Column(Integer, primary_key=True, index=True)
    driver_id = Column(Integer, ForeignKey("drivers.id"), nullable=False)
    date = Column(Date, nullable=False)
    start_time = Column(String(5), default="")
    end_time = Column(String(5), default="")
    distance_km = Column(Float, default=0)
    fuel_liters = Column(Float, default=0)
    waiting_time = Column(Integer, default=0)
    loading_time = Column(Integer, default=0)
    unloading_time = Column(Integer, default=0)
    routes = Column(Text, default="")  # JSON: 運行経路情報
    client_names = Column(String(200), default="")
    notes = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.now)

    driver = relationship("Driver", back_populates="daily_reports")


class Inquiry(Base):
    """問い合わせ"""
    __tablename__ = "inquiries"

    id = Column(Integer, primary_key=True, index=True)
    company = Column(String(100), default="")
    name = Column(String(50), nullable=False)
    email = Column(String(100), nullable=False)
    phone = Column(String(20), default="")
    message = Column(Text, default="")
    status = Column(String(20), default="未対応")  # 未対応/対応中/対応済み
    created_at = Column(DateTime, default=datetime.now)
