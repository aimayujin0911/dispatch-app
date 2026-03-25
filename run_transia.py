import os
os.environ["TENANT_ID"] = "transia"
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "core"))
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8001))
    uvicorn.run("core.main:app", host="0.0.0.0", port=port, reload=True)
