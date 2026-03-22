import os
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List
from database import get_db
from models import CompanySettings, Shipment, Client, User, TransportRequest, VehicleNotification
from core.auth import get_current_user

# システム共通メール設定（環境変数 or テナント設定）
SYSTEM_SMTP_HOST = os.environ.get("SMTP_HOST", "")
SYSTEM_SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SYSTEM_SMTP_USER = os.environ.get("SMTP_USER", "")
SYSTEM_SMTP_PASS = os.environ.get("SMTP_PASSWORD", "")
SYSTEM_SENDER_EMAIL = os.environ.get("SENDER_EMAIL", "noreply@hakoprofor.jp")

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
    postal_code: Optional[str] = None
    email: Optional[str] = None
    payment_terms: Optional[str] = None
    tax_rate: Optional[int] = None
    seal_text: Optional[str] = None
    invoice_note: Optional[str] = None
    smtp_host: Optional[str] = None
    smtp_port: Optional[int] = None
    smtp_user: Optional[str] = None
    smtp_password: Optional[str] = None
    sender_email: Optional[str] = None


class SendInvoiceEmail(BaseModel):
    shipment_ids: List[int]
    recipient_email: str = ""
    subject: str = ""
    body: str = ""


@router.get("")
def get_settings(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    settings = db.query(CompanySettings).filter(CompanySettings.tenant_id == current_user.tenant_id).first()
    if not settings:
        settings = CompanySettings(tenant_id=current_user.tenant_id)
        db.add(settings)
        db.commit()
        db.refresh(settings)
    return settings


@router.put("")
def update_settings(data: SettingsUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    settings = db.query(CompanySettings).filter(CompanySettings.tenant_id == current_user.tenant_id).first()
    if not settings:
        settings = CompanySettings(tenant_id=current_user.tenant_id)
        db.add(settings)
        db.commit()
        db.refresh(settings)
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(settings, key, value)
    db.commit()
    return settings


@router.post("/send-invoice")
def send_invoice_email(data: SendInvoiceEmail, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """請求書をメール送付"""
    settings = db.query(CompanySettings).filter(CompanySettings.tenant_id == current_user.tenant_id).first()
    if not settings or not settings.smtp_host:
        raise HTTPException(status_code=400, detail="SMTP設定が未設定です。設定画面でメール設定を行ってください。")

    shipments = db.query(Shipment).filter(Shipment.id.in_(data.shipment_ids), Shipment.tenant_id == current_user.tenant_id).all()
    if not shipments:
        raise HTTPException(status_code=400, detail="対象案件が見つかりません")

    # 宛先メール解決
    recipient = data.recipient_email
    if not recipient:
        # 荷主のbilling_emailから取得
        client_name = shipments[0].client_name
        client = db.query(Client).filter(Client.name == client_name, Client.tenant_id == current_user.tenant_id).first()
        if client and client.billing_email:
            recipient = client.billing_email
        else:
            raise HTTPException(status_code=400, detail="送信先メールアドレスが未設定です")

    # 請求メール本文生成
    total = sum(s.price for s in shipments)
    items_html = ""
    for s in shipments:
        items_html += f"<tr><td>{s.delivery_date}</td><td>{s.client_name}: {s.pickup_address} → {s.delivery_address}</td><td style='text-align:right'>¥{s.price:,}</td></tr>"

    subject = data.subject or f"請求書送付のご案内 - {settings.company_name}"
    html_body = f"""
    <html><body style="font-family:sans-serif;color:#333">
    <h2>請求書</h2>
    <p>{shipments[0].client_name} 御中</p>
    <p>下記の通りご請求申し上げます。</p>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%">
        <tr style="background:#f0f0f0"><th>日付</th><th>内容</th><th>金額</th></tr>
        {items_html}
        <tr style="background:#f0f0f0;font-weight:bold"><td colspan="2">合計</td><td style="text-align:right">¥{total:,}</td></tr>
    </table>
    <br>
    <p><strong>振込先:</strong><br>{(settings.bank_info or '').replace(chr(10), '<br>')}</p>
    <p><strong>お支払期限:</strong> {data.body or '月末締め翌月末払い'}</p>
    <hr>
    <p style="font-size:0.85em;color:#666">
        {settings.company_name}<br>
        {settings.address}<br>
        TEL: {settings.phone} / FAX: {settings.fax}<br>
        適格請求書番号: {settings.registration_number}
    </p>
    </body></html>
    """

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = settings.sender_email or settings.smtp_user
        msg["To"] = recipient
        msg.attach(MIMEText(html_body, "html"))

        with smtplib.SMTP(settings.smtp_host, settings.smtp_port) as server:
            server.starttls()
            server.login(settings.smtp_user, settings.smtp_password)
            server.send_message(msg)

        # 案件のinvoice_statusを更新
        for s in shipments:
            s.invoice_status = "請求済"
            from datetime import date as date_type
            s.invoice_date = date_type.today()
        db.commit()

        return {"ok": True, "message": f"{recipient} に送信しました"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"メール送信に失敗しました: {str(e)}")


class SendDocEmail(BaseModel):
    doc_type: str  # "transport-request" or "vehicle-notification"
    doc_id: int
    to_email: str


@router.post("/send-doc-email")
def send_doc_email(data: SendDocEmail, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """輸送依頼書・車番連絡票をメール送付"""
    # SMTP設定: システム共通 or テナント設定
    smtp_host = SYSTEM_SMTP_HOST
    smtp_port = SYSTEM_SMTP_PORT
    smtp_user = SYSTEM_SMTP_USER
    smtp_pass = SYSTEM_SMTP_PASS
    sender = SYSTEM_SENDER_EMAIL

    if not smtp_host:
        # フォールバック: テナント設定のSMTP
        settings = db.query(CompanySettings).filter(CompanySettings.tenant_id == current_user.tenant_id).first()
        if settings and settings.smtp_host:
            smtp_host = settings.smtp_host
            smtp_port = settings.smtp_port or 587
            smtp_user = settings.smtp_user
            smtp_pass = settings.smtp_password
            sender = settings.sender_email or settings.smtp_user
        else:
            raise HTTPException(status_code=400, detail="メール設定が未設定です。環境変数またはテナント設定でSMTPを設定してください。")

    # 書類データ取得
    settings = db.query(CompanySettings).filter(CompanySettings.tenant_id == current_user.tenant_id).first()
    company_name = settings.company_name if settings else "ハコプロFor"

    if data.doc_type == "transport-request":
        doc = db.query(TransportRequest).filter(TransportRequest.id == data.doc_id).first()
        if not doc:
            raise HTTPException(status_code=404, detail="輸送依頼書が見つかりません")
        subject = f"輸送依頼書のご送付 - {company_name}"
        html_body = f"""
        <html><body style="font-family:sans-serif;color:#333">
        <h2>輸送依頼書</h2>
        <p>お世話になっております。{company_name}です。</p>
        <p>下記の通り輸送をご依頼申し上げます。</p>
        <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%">
            <tr style="background:#f0f0f0"><th>項目</th><th>内容</th></tr>
            <tr><td>集荷日</td><td>{doc.pickup_date} {doc.pickup_time}</td></tr>
            <tr><td>配達日</td><td>{doc.delivery_date} {doc.delivery_time}</td></tr>
            <tr><td>集荷地</td><td>{doc.pickup_address}</td></tr>
            <tr><td>配達先</td><td>{doc.delivery_address}</td></tr>
            <tr><td>荷物</td><td>{doc.cargo_description} ({doc.cargo_weight}kg)</td></tr>
            <tr><td>運賃</td><td>¥{doc.freight_amount:,}</td></tr>
        </table>
        <br>
        <p>ご確認の程よろしくお願いいたします。</p>
        <hr>
        <p style="font-size:0.85em;color:#666">{company_name}</p>
        </body></html>
        """
        doc.status = "送付済"
    elif data.doc_type == "vehicle-notification":
        doc = db.query(VehicleNotification).filter(VehicleNotification.id == data.doc_id).first()
        if not doc:
            raise HTTPException(status_code=404, detail="車番連絡票が見つかりません")
        subject = f"車番連絡票のご送付 - {company_name}"
        html_body = f"""
        <html><body style="font-family:sans-serif;color:#333">
        <h2>車番連絡票</h2>
        <p>お世話になっております。{company_name}です。</p>
        <p>下記の通り車両情報をご連絡いたします。</p>
        <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%">
            <tr style="background:#f0f0f0"><th>項目</th><th>内容</th></tr>
            <tr><td>到着日時</td><td>{doc.arrival_date} {doc.arrival_time}</td></tr>
            <tr><td>車両番号</td><td>{doc.vehicle_number}</td></tr>
            <tr><td>車種</td><td>{doc.vehicle_type}</td></tr>
            <tr><td>ドライバー</td><td>{doc.driver_name} ({doc.driver_phone})</td></tr>
            <tr><td>荷物</td><td>{doc.cargo_description} ({doc.quantity})</td></tr>
            <tr><td>届先</td><td>{doc.destination_name}<br>{doc.destination_address}</td></tr>
        </table>
        <br>
        <p>ご確認の程よろしくお願いいたします。</p>
        <hr>
        <p style="font-size:0.85em;color:#666">{company_name}</p>
        </body></html>
        """
        doc.status = "送付済"
    else:
        raise HTTPException(status_code=400, detail="不明な書類タイプです")

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = sender
        msg["To"] = data.to_email
        msg.attach(MIMEText(html_body, "html"))

        with smtplib.SMTP(smtp_host, smtp_port) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.send_message(msg)

        db.commit()
        return {"ok": True, "message": f"{data.to_email} に送信しました"}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"メール送信に失敗しました: {str(e)}")
