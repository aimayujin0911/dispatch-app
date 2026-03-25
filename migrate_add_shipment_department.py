"""
マイグレーション: shipments テーブルに department カラムを追加
実行: python migrate_add_shipment_department.py
"""
import sqlite3
import os

def migrate():
    tenant_id = os.environ.get("TENANT_ID", "transia")
    db_path = f"tenants/{tenant_id}/dispatch.db"

    if not os.path.exists(db_path):
        print(f"DB not found: {db_path}")
        return

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    # Check if column already exists
    cursor.execute("PRAGMA table_info(shipments)")
    columns = [col[1] for col in cursor.fetchall()]

    if "department" in columns:
        print("Column 'department' already exists in shipments table. Skipping.")
    else:
        cursor.execute("ALTER TABLE shipments ADD COLUMN department VARCHAR DEFAULT ''")
        conn.commit()
        print(f"Successfully added 'department' column to shipments table in {db_path}")

    conn.close()

if __name__ == "__main__":
    migrate()
