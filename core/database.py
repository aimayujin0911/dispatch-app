from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
import os

# テナントIDに基づいてDB切替
TENANT_ID = os.environ.get("TENANT_ID", "")
PROJECT_ROOT = os.path.dirname(os.path.dirname(__file__))

if TENANT_ID:
    # テナント固有DB: tenants/{tenant_id}/dispatch.db
    tenant_dir = os.path.join(PROJECT_ROOT, "tenants", TENANT_ID)
    os.makedirs(tenant_dir, exist_ok=True)
    DB_PATH = os.path.join(tenant_dir, "dispatch.db")
else:
    # デフォルト: core/dispatch.db
    DB_PATH = os.path.join(os.path.dirname(__file__), "dispatch.db")

DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
