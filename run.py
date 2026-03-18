"""
配車管理システム エントリーポイント
テナント指定で起動: TENANT_ID=xxx python run.py
テナント未指定: python run.py (デフォルト設定で起動)
"""
import os
import sys

# coreをPythonパスに追加
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "core"))

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8001))
    uvicorn.run("core.main:app", host="0.0.0.0", port=port, reload=True)
