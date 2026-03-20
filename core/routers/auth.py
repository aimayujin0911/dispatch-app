from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List

from database import get_db
from sqlalchemy import distinct
from models import User, Branch, Driver, UserTenant
from auth import hash_password, verify_password, create_access_token, get_current_user

router = APIRouter()


# ── Pydantic スキーマ ──────────────────────────────────────

class LoginRequest(BaseModel):
    email: Optional[str] = None
    login_id: Optional[str] = None
    password: str


class CreateUserRequest(BaseModel):
    name: str
    email: Optional[str] = None
    login_id: Optional[str] = None
    password: str
    role: str = "dispatcher"  # admin/manager/dispatcher/driver
    branch_id: Optional[int] = None
    driver_id: Optional[int] = None


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
    email: Optional[str] = ""
    login_id: Optional[str] = ""
    role: str
    tenant_id: Optional[str] = ""
    branch_id: Optional[int] = None
    branch_name: Optional[str] = None
    driver_id: Optional[int] = None


class MeResponse(UserOut):
    branches: List[BranchOut] = []
    can_switch_branch: bool = False    # admin のみ拠点切替可能
    can_access_admin: bool = False     # admin/manager のみ管理・会計アクセス可能
    accessible_tenants: List[str] = []  # アクセス可能テナント一覧
    can_switch_tenant: bool = False     # テナント切替可能か


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut
    tenants: List[str] = []  # アクセス可能テナント一覧


# ── ヘルパー ──────────────────────────────────────────────

def _build_user_out(user: User) -> dict:
    """User モデルから UserOut 用の dict を作成"""
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email or "",
        "login_id": user.login_id or "",
        "role": user.role,
        "tenant_id": user.tenant_id or "",
        "branch_id": user.branch_id,
        "branch_name": user.branch.name if user.branch else None,
        "driver_id": user.driver_id,
    }


def _get_accessible_tenants(user: User, db) -> list:
    """ユーザーがアクセス可能なテナント一覧を返す"""
    if user.role == "operator":
        # オペレーターは全テナント
        tenant_ids = db.query(distinct(User.tenant_id)).filter(
            User.tenant_id != "", User.tenant_id != None
        ).all()
        return [t[0] for t in tenant_ids]
    # 自分のテナント + user_tenants の追加テナント
    tenants = []
    if user.tenant_id:
        tenants.append(user.tenant_id)
    extra = db.query(UserTenant.tenant_id).filter(UserTenant.user_id == user.id).all()
    for t in extra:
        if t[0] and t[0] not in tenants:
            tenants.append(t[0])
    return tenants


def _login_response(user: User, db=None, active_tenant: str = "") -> dict:
    """ログイン / 登録後の共通レスポンスを生成"""
    payload = {
        "sub": str(user.id),
        "email": user.email or "",
        "role": user.role,
        "branch_id": user.branch_id,
        "driver_id": user.driver_id,
    }
    # active_tenantをJWTに含める（オペレーター or テナント切替時）
    if active_tenant:
        payload["active_tenant"] = active_tenant
    token = create_access_token(payload)
    user_out = _build_user_out(user)
    if active_tenant:
        user_out["tenant_id"] = active_tenant
    result = {
        "access_token": token,
        "token_type": "bearer",
        "user": user_out,
    }
    # アクセス可能テナント一覧を付与
    if db:
        tenants = _get_accessible_tenants(user, db)
        result["tenants"] = tenants
    return result


# ── エンドポイント ────────────────────────────────────────

@router.post("/login")
def login(req: LoginRequest, db: Session = Depends(get_db)):
    """ログイン（email or login_id）"""
    user = None
    if req.email:
        user = db.query(User).filter(User.email == req.email, User.is_active == True).first()
    elif req.login_id:
        user = db.query(User).filter(User.login_id == req.login_id, User.is_active == True).first()
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="メールアドレスまたはログインIDを入力してください",
        )
    if not user or not verify_password(req.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="ログイン情報が正しくありません",
        )
    return _login_response(user, db=db)


@router.get("/users")
def list_users(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """ユーザー一覧（管理者/オペレーターのみ）"""
    if current_user.role not in ("admin", "operator"):
        raise HTTPException(status_code=403, detail="管理者権限が必要です")
    # テナントでフィルタ（current_user.tenant_idはJWTのactive_tenantで上書き済み）
    q = db.query(User)
    if current_user.tenant_id:
        q = q.filter(User.tenant_id == current_user.tenant_id)
    # 運営管理者（operator）はテナントユーザーに見せない
    q = q.filter(User.role != "operator")
    users = q.order_by(User.id).all()
    result = []
    for u in users:
        result.append({
            "id": u.id,
            "name": u.name,
            "email": u.email or "",
            "login_id": u.login_id or "",
            "role": u.role,
            "branch_id": u.branch_id,
            "branch_name": u.branch.name if u.branch else None,
            "driver_id": u.driver_id,
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
    if current_user.role not in ("admin", "operator"):
        raise HTTPException(status_code=403, detail="管理者権限が必要です")
    if req.role not in ("admin", "manager", "dispatcher", "driver", "operator"):
        raise HTTPException(status_code=400, detail="権限はadmin/manager/dispatcher/driver/operatorのいずれかです")
    # email or login_id のどちらかは必須
    if not req.email and not req.login_id:
        raise HTTPException(status_code=400, detail="メールアドレスまたはログインIDのどちらかは必須です")
    # 重複チェック
    if req.email:
        existing = db.query(User).filter(User.email == req.email).first()
        if existing:
            raise HTTPException(status_code=400, detail="このメールアドレスは既に登録されています")
    if req.login_id:
        existing = db.query(User).filter(User.login_id == req.login_id).first()
        if existing:
            raise HTTPException(status_code=400, detail="このログインIDは既に使用されています")
    # ドライバーロールの場合、Driverレコードも自動作成（driver_id未指定時）
    driver_id = req.driver_id
    if req.role == "driver" and not driver_id:
        driver = Driver(
            name=req.name,
            tenant_id=current_user.tenant_id,
            branch_id=req.branch_id,
        )
        db.add(driver)
        db.flush()
        driver_id = driver.id

    user = User(
        name=req.name,
        email=req.email or None,
        login_id=req.login_id or None,
        password_hash=hash_password(req.password),
        role=req.role,
        branch_id=req.branch_id,
        driver_id=driver_id,
        tenant_id=current_user.tenant_id,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return {"id": user.id, "name": user.name, "email": user.email or "", "login_id": user.login_id or "", "role": user.role, "branch_name": user.branch.name if user.branch else None}


class UpdateUserRequest(BaseModel):
    name: Optional[str] = None
    email: Optional[str] = None
    login_id: Optional[str] = None
    password: Optional[str] = None
    role: Optional[str] = None
    branch_id: Optional[int] = None
    driver_id: Optional[int] = None
    is_active: Optional[bool] = None


@router.put("/users/{user_id}")
def update_user(
    user_id: int,
    req: UpdateUserRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """ユーザー編集（管理者のみ）"""
    if current_user.role not in ("admin", "operator"):
        raise HTTPException(status_code=403, detail="管理者権限が必要です")
    q = db.query(User).filter(User.id == user_id)
    if current_user.tenant_id:
        q = q.filter(User.tenant_id == current_user.tenant_id)
    user = q.first()
    if not user:
        raise HTTPException(status_code=404, detail="ユーザーが見つかりません")
    if req.name is not None: user.name = req.name
    if req.email is not None: user.email = req.email or None
    if req.login_id is not None: user.login_id = req.login_id or None
    if req.password: user.password_hash = hash_password(req.password)
    if req.role is not None: user.role = req.role
    if req.branch_id is not None: user.branch_id = req.branch_id
    if req.driver_id is not None: user.driver_id = req.driver_id
    if req.is_active is not None: user.is_active = req.is_active
    # 紐付いたDriverの名前も同期
    if req.name is not None and user.driver_id:
        linked_driver = db.query(Driver).filter(Driver.id == user.driver_id).first()
        if linked_driver:
            linked_driver.name = req.name
    db.commit()
    return {"message": "更新しました"}


@router.delete("/users/{user_id}")
def delete_user(
    user_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """ユーザー削除（管理者のみ）"""
    if current_user.role not in ("admin", "operator"):
        raise HTTPException(status_code=403, detail="管理者権限が必要です")
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="自分自身は削除できません")
    q = db.query(User).filter(User.id == user_id)
    if current_user.tenant_id:
        q = q.filter(User.tenant_id == current_user.tenant_id)
    user = q.first()
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
    user_dict["can_switch_branch"] = current_user.role in ("admin", "operator")
    user_dict["can_access_admin"] = current_user.role in ("admin", "manager", "operator")
    user_dict["is_operator"] = current_user.role == "operator"
    # アクセス可能テナント一覧
    tenants = _get_accessible_tenants(current_user, db)
    user_dict["accessible_tenants"] = tenants
    user_dict["can_switch_tenant"] = len(tenants) > 1 or current_user.role == "operator"
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


@router.get("/tenants")
def list_tenants(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """テナント一覧（オペレーターのみ）"""
    if current_user.role != "operator":
        raise HTTPException(status_code=403, detail="運営管理者のみアクセスできます")
    # usersテーブルからユニークなtenant_idを取得
    tenant_ids = db.query(distinct(User.tenant_id)).filter(User.tenant_id != "", User.tenant_id != None).all()
    return [{"tenant_id": t[0]} for t in tenant_ids]


class SwitchTenantRequest(BaseModel):
    tenant_id: str


@router.put("/switch-tenant")
def switch_tenant(
    req: SwitchTenantRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """テナント切替 → 新しいJWTを返す（オペレーター or 複数テナントユーザー）"""
    accessible = _get_accessible_tenants(current_user, db)
    if current_user.role != "operator" and req.tenant_id not in accessible:
        raise HTTPException(status_code=403, detail="このテナントへのアクセス権がありません")
    return _login_response(current_user, db=db, active_tenant=req.tenant_id)


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
