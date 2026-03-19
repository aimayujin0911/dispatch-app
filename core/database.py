from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
import os

# DATABASE_URL環境変数があればそちらを使う（PostgreSQL等）
# なければSQLiteにフォールバック
DATABASE_URL = os.environ.get("DATABASE_URL", "")

if not DATABASE_URL:
    # テナントIDに基づいてSQLite DB切替
    TENANT_ID = os.environ.get("TENANT_ID", "")
    PROJECT_ROOT = os.path.dirname(os.path.dirname(__file__))
    if TENANT_ID:
        tenant_dir = os.path.join(PROJECT_ROOT, "tenants", TENANT_ID)
        os.makedirs(tenant_dir, exist_ok=True)
        DB_PATH = os.path.join(tenant_dir, "dispatch.db")
    else:
        DB_PATH = os.path.join(os.path.dirname(__file__), "dispatch.db")
    DATABASE_URL = f"sqlite:///{DB_PATH}"

# SQLiteの場合のみcheck_same_thread設定
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
