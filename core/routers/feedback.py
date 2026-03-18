"""開発への依頼（フィードバック）API"""
import os, json
from datetime import datetime
from fastapi import APIRouter, UploadFile, File, Form, Depends, HTTPException
from typing import Optional
from sqlalchemy.orm import Session
from database import get_db

router = APIRouter()

FEEDBACK_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "feedback")
os.makedirs(FEEDBACK_DIR, exist_ok=True)


@router.post("")
async def submit_feedback(
    category: str = Form(...),
    title: str = Form(...),
    description: str = Form(...),
    priority: str = Form("普通"),
    page: str = Form(""),
    user_name: str = Form(""),
    user_email: str = Form(""),
    screenshot: Optional[UploadFile] = File(None),
):
    """フィードバックを保存（JSONファイル + オプションでスクショ）"""
    timestamp = datetime.now()
    feedback_id = timestamp.strftime("%Y%m%d_%H%M%S_%f")

    # スクショ保存
    screenshot_path = ""
    if screenshot and screenshot.filename:
        ext = screenshot.filename.rsplit(".", 1)[-1] if "." in screenshot.filename else "png"
        screenshot_filename = f"{feedback_id}.{ext}"
        screenshot_path = os.path.join(FEEDBACK_DIR, screenshot_filename)
        content = await screenshot.read()
        with open(screenshot_path, "wb") as f:
            f.write(content)
        screenshot_path = screenshot_filename

    # フィードバックデータ
    feedback = {
        "id": feedback_id,
        "category": category,
        "title": title,
        "description": description,
        "priority": priority,
        "page": page,
        "user_name": user_name,
        "user_email": user_email,
        "screenshot": screenshot_path,
        "created_at": timestamp.isoformat(),
        "status": "未対応",
    }

    # JSONファイルに追記
    feedbacks_file = os.path.join(FEEDBACK_DIR, "feedbacks.json")
    feedbacks = []
    if os.path.exists(feedbacks_file):
        try:
            with open(feedbacks_file, "r", encoding="utf-8") as f:
                feedbacks = json.load(f)
        except Exception:
            feedbacks = []
    feedbacks.append(feedback)
    with open(feedbacks_file, "w", encoding="utf-8") as f:
        json.dump(feedbacks, f, ensure_ascii=False, indent=2)

    # Slack webhook（設定されていれば送信）
    slack_url = os.environ.get("FEEDBACK_SLACK_WEBHOOK")
    if slack_url:
        try:
            import httpx
            slack_msg = {
                "text": f"📬 *開発依頼*\n*カテゴリ:* {category}\n*タイトル:* {title}\n*優先度:* {priority}\n*ページ:* {page}\n*送信者:* {user_name}\n\n{description}"
            }
            async with httpx.AsyncClient() as client:
                await client.post(slack_url, json=slack_msg)
        except Exception:
            pass  # Slack送信失敗は無視

    # メール送信（SMTP設定されていれば）
    notify_email = os.environ.get("FEEDBACK_EMAIL")
    if notify_email:
        try:
            import smtplib
            from email.mime.text import MIMEText
            smtp_host = os.environ.get("SMTP_HOST", "")
            smtp_port = int(os.environ.get("SMTP_PORT", "587"))
            smtp_user = os.environ.get("SMTP_USER", "")
            smtp_pass = os.environ.get("SMTP_PASSWORD", "")
            sender = os.environ.get("SENDER_EMAIL", smtp_user)
            if smtp_host and smtp_user:
                msg = MIMEText(
                    f"カテゴリ: {category}\nタイトル: {title}\n優先度: {priority}\nページ: {page}\n送信者: {user_name} ({user_email})\n\n{description}",
                    "plain", "utf-8"
                )
                msg["Subject"] = f"[開発依頼] {title}"
                msg["From"] = sender
                msg["To"] = notify_email
                with smtplib.SMTP(smtp_host, smtp_port) as server:
                    server.starttls()
                    server.login(smtp_user, smtp_pass)
                    server.send_message(msg)
        except Exception:
            pass

    return {"status": "ok", "id": feedback_id, "message": "依頼を送信しました"}


@router.get("")
async def list_feedbacks():
    """フィードバック一覧（管理者向け）"""
    feedbacks_file = os.path.join(FEEDBACK_DIR, "feedbacks.json")
    if not os.path.exists(feedbacks_file):
        return []
    try:
        with open(feedbacks_file, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []
