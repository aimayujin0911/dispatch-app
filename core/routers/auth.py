from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List

from database import get_db
from models import User, Branch
from auth import hash_password, verify_password, create_access_token, get_current_user

router = APIRouter()


# ── Pydantic スキーマ ──────────────────────────────────────

class LoginRequest(BaseModel):
    email: str
    password: str


class CreateUserRequest(BaseModel):
    name: str
    email: str
    password: str
    role: str = "dispatcher"  # admin/manager/dispatcher
    branch_id: Optional[int] = None


class SwitchBranchRequest(BaseModel):
    branch_id: int


class BranchCreate(BaseModel):
    name: str
    address: str = ""
    phone: str = ""


class BranchOut(BaseModel):
    id: int
    name: str

    class Config:
        from_attributes = True


class UserOut(BaseModel):
    id: int
    name: str
    email: str
    role: str
    tenant_id: Optional[str] = ""
    branch_id: Optional[int] = None
    branch_name: Optional[str] = None


class MeResponse(UserOut):
    branches: List[BranchOut] = []
    can_switch_branch: bool = False    # admin のみ拠点切替可能
    can_access_admin: bool = False     # admin/manager のみ管理・会計アクセス可能


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


# ── ヘルパー ──────────────────────────────────────────────

def _build_user_out(user: User) -> dict:
    """User モデルから UserOut 用の dict を作成"""
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "role": user.role,
        "tenant_id": user.tenant_id or "",
        "branch_id": user.branch_id,
        "branch_name": user.branch.name if user.branch else None,
    }


def _login_response(user: User) -> dict:
    """ログイン / 登録後の共通レスポンスを生成"""
    token = create_access_token({
        "sub": str(user.id),
        "email": user.email,
        "role": user.role,
        "branch_id": user.branch_id,
    })
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": _build_user_out(user),
    }


# ── エンドポイント ────────────────────────────────────────

@router.post("/login", response_model=TokenResponse)
def login(req: LoginRequest, db: Session = Depends(get_db)):
    """ログイン"""
    user = db.query(User).filter(User.email == req.email, User.is_active == True).first()
    if not user or not verify_password(req.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="メールアドレスまたはパスワードが正しくありません",
        )
    return _login_response(user)


@router.get("/users")
def list_users(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """ユーザー一覧（管理者のみ）"""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="管理者権限が必要です")
    users = db.query(User).order_by(User.id).all()
    result = []
    for u in users:
        result.append({
            "id": u.id,
            "name": u.name,
            "email": u.email,
            "role": u.role,
            "branch_id": u.branch_id,
            "branch_name": u.branch.name if u.branch else None,
            "is_active": u.is_active,
            "created_at": str(u.created_at) if u.created_at else None,
        })
    return result


@router.post("/users")
def create_user(
    req: CreateUserRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """ユーザー追加（管理者のみ）"""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="管理者権限が必要です")
    existing = db.query(User).filter(User.email == req.email).first()
    if existing:
        raise HTTPException(status_code=400, detail="このメールアドレスは既に登録されています")
    if req.role not in ("admin", "manager", "dispatcher"):
        raise HTTPException(status_code=400, detail="権限はadmin/manager/dispatcherのいずれかです")
    user = User(
        name=req.name,
        email=req.email,
        password_hash=hash_password(req.password),
        role=req.role,
        branch_id=req.branch_id,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return {"id": user.id, "name": user.name, "email": user.email, "role": user.role, "branch_name": user.branch.name if user.branch else None}


class UpdateUserRequest(BaseModel):
    name: Optional[str] = None
    email: Optional[str] = None
    password: Optional[str] = None
    role: Optional[str] = None
    branch_id: Optional[int] = None
    is_active: Optional[bool] = None


@router.put("/users/{user_id}")
def update_user(
    user_id: int,
    req: UpdateUserRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """ユーザー編集（管理者のみ）"""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="管理者権限が必要です")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="ユーザーが見つかりません")
    if req.name is not None: user.name = req.name
    if req.email is not None: user.email = req.email
    if req.password: user.password_hash = hash_password(req.password)
    if req.role is not None: user.role = req.role
    if req.branch_id is not None: user.branch_id = req.branch_id
    if req.is_active is not None: user.is_active = req.is_active
    db.commit()
    return {"message": "更新しました"}


@router.delete("/users/{user_id}")
def delete_user(
    user_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """ユーザー削除（管理者のみ）"""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="管理者権限が必要です")
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="自分自身は削除できません")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="ユーザーが見つかりません")
    db.delete(user)
    db.commit()
    return {"message": "削除しました"}


@router.get("/me", response_model=MeResponse)
def get_me(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """ログイン中のユーザー情報 + 営業所一覧 + 権限"""
    branches = db.query(Branch).filter(Branch.is_active == True).order_by(Branch.id).all()
    user_dict = _build_user_out(current_user)
    user_dict["branches"] = [{"id": b.id, "name": b.name} for b in branches]
    user_dict["can_switch_branch"] = current_user.role == "admin"
    user_dict["can_access_admin"] = current_user.role in ("admin", "manager")
    return user_dict


@router.put("/switch-branch")
def switch_branch(
    req: SwitchBranchRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """営業所を切り替え、新しいトークンを返す（管理者のみ）"""
    if current_user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="拠点切替は管理者のみ可能です")
    branch = db.query(Branch).filter(Branch.id == req.branch_id, Branch.is_active == True).first()
    if not branch:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="指定された営業所が見つかりません",
        )

    current_user.branch_id = req.branch_id
    db.commit()
    db.refresh(current_user)

    token = create_access_token({
        "sub": str(current_user.id),
        "email": current_user.email,
        "role": current_user.role,
        "branch_id": current_user.branch_id,
    })
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": _build_user_out(current_user),
    }


@router.get("/branches", response_model=List[BranchOut])
def list_branches(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """営業所一覧"""
    return db.query(Branch).filter(Branch.is_active == True).order_by(Branch.id).all()


@router.post("/branches", response_model=BranchOut)
def create_branch(
    req: BranchCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """営業所を新規作成（管理者のみ）"""
    if current_user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="この操作には管理者権限が必要です",
        )

    branch = Branch(
        name=req.name,
        address=req.address,
        phone=req.phone,
    )
    db.add(branch)
    db.commit()
    db.refresh(branch)
    return branch
