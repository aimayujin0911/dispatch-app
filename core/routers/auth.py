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


class RegisterRequest(BaseModel):
    name: str
    email: str
    password: str


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


@router.post("/register", response_model=TokenResponse)
def register(req: RegisterRequest, db: Session = Depends(get_db)):
    """新規ユーザー登録"""
    existing = db.query(User).filter(User.email == req.email).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="このメールアドレスは既に登録されています",
        )

    # 最初のユーザーは admin、それ以降は dispatcher
    user_count = db.query(User).count()
    role = "admin" if user_count == 0 else "dispatcher"

    user = User(
        name=req.name,
        email=req.email,
        password_hash=hash_password(req.password),
        role=role,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    return _login_response(user)


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
