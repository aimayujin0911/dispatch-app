from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from database import get_db
from models import Client, ClientNote

router = APIRouter()


class ClientCreate(BaseModel):
    name: str
    address: str = ""
    phone: str = ""
    fax: str = ""
    contact_person: str = ""
    notes: str = ""
    billing_address: str = ""
    billing_contact: str = ""
    billing_email: str = ""
    payment_terms: str = "月末締め翌月末払い"
    credit_limit: int = 0
    tax_id: str = ""
    bank_info: str = ""


class ClientUpdate(BaseModel):
    name: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    fax: Optional[str] = None
    contact_person: Optional[str] = None
    notes: Optional[str] = None
    billing_address: Optional[str] = None
    billing_contact: Optional[str] = None
    billing_email: Optional[str] = None
    payment_terms: Optional[str] = None
    credit_limit: Optional[int] = None
    tax_id: Optional[str] = None
    bank_info: Optional[str] = None


class NoteCreate(BaseModel):
    content: str
    created_by: str = ""


@router.get("")
def list_clients(db: Session = Depends(get_db)):
    clients = db.query(Client).order_by(Client.name).all()
    result = []
    for c in clients:
        d = {col.name: getattr(c, col.name) for col in c.__table__.columns}
        d["created_at"] = str(d["created_at"]) if d.get("created_at") else None
        result.append(d)
    return result


@router.get("/{client_id}")
def get_client(client_id: int, db: Session = Depends(get_db)):
    client = db.query(Client).filter(Client.id == client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="荷主が見つかりません")
    d = {col.name: getattr(client, col.name) for col in client.__table__.columns}
    d["created_at"] = str(d["created_at"]) if d.get("created_at") else None
    notes = db.query(ClientNote).filter(ClientNote.client_id == client_id).order_by(ClientNote.date.desc()).all()
    d["notes_log"] = [{"id": n.id, "date": str(n.date), "content": n.content, "created_by": n.created_by} for n in notes]
    return d


@router.post("")
def create_client(data: ClientCreate, db: Session = Depends(get_db)):
    existing = db.query(Client).filter(Client.name == data.name).first()
    if existing:
        raise HTTPException(status_code=400, detail="同名の荷主企業が既に存在します")
    client = Client(**data.model_dump())
    db.add(client)
    db.commit()
    db.refresh(client)
    return client


@router.put("/{client_id}")
def update_client(client_id: int, data: ClientUpdate, db: Session = Depends(get_db)):
    client = db.query(Client).filter(Client.id == client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="荷主企業が見つかりません")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(client, key, value)
    db.commit()
    db.refresh(client)
    return client


@router.delete("/{client_id}")
def delete_client(client_id: int, db: Session = Depends(get_db)):
    client = db.query(Client).filter(Client.id == client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="荷主企業が見つかりません")
    # 関連ノートも削除
    db.query(ClientNote).filter(ClientNote.client_id == client_id).delete()
    db.delete(client)
    db.commit()
    return {"ok": True}


# --- Client Notes ---
@router.get("/{client_id}/notes")
def list_notes(client_id: int, db: Session = Depends(get_db)):
    notes = db.query(ClientNote).filter(ClientNote.client_id == client_id).order_by(ClientNote.date.desc()).all()
    return [{"id": n.id, "date": str(n.date), "content": n.content, "created_by": n.created_by} for n in notes]


@router.post("/{client_id}/notes")
def create_note(client_id: int, data: NoteCreate, db: Session = Depends(get_db)):
    note = ClientNote(client_id=client_id, content=data.content, created_by=data.created_by)
    db.add(note)
    db.commit()
    return {"id": note.id}


@router.delete("/{client_id}/notes/{note_id}")
def delete_note(client_id: int, note_id: int, db: Session = Depends(get_db)):
    note = db.query(ClientNote).filter(ClientNote.id == note_id, ClientNote.client_id == client_id).first()
    if note:
        db.delete(note)
        db.commit()
    return {"ok": True}
