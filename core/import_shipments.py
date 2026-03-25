"""
案件CSVインポートスクリプト
CSVファイルからShipmentテーブルにデータを投入する
"""
import os
import sys
import csv
import codecs
from datetime import datetime, date

# テナント設定（database.pyのimport前に設定必須）
os.environ['TENANT_ID'] = 'transia'

# coreディレクトリをパスに追加
core_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(core_dir)
sys.path.insert(0, core_dir)
sys.path.insert(0, project_root)

from database import SessionLocal, engine, Base
from models import Shipment

# テーブルが存在しない場合は作成
Base.metadata.create_all(bind=engine)

TENANT_ID = 'transia'

# CSVヘッダー → Shipmentフィールド マッピング
FIELD_MAP = {
    '案件名': 'name',
    '荷主名': 'client_name',
    '積荷内容': 'cargo_description',
    '重量kg': 'weight',
    '積地住所': 'pickup_address',
    '卸地住所': 'delivery_address',
    '積込日': 'pickup_date',
    '積込時間': 'pickup_time',
    '納品日': 'delivery_date',
    '納品時間': 'delivery_time',
    '時間備考': 'time_note',
    '運賃': 'price',
    '輸送タイプ': 'transport_type',
    '温度帯': 'temperature_zone',
    '単価種別': 'unit_price_type',
    '単価': 'unit_price',
    '数量': 'unit_quantity',
    '頻度': 'frequency_type',
    '頻度曜日': 'frequency_days',
    'ステータス': 'status',
    '待機時間分': 'waiting_time',
    '積込作業時間分': 'loading_time',
    '卸作業時間分': 'unloading_time',
    '備考': 'notes',
}


def parse_date(value: str):
    """日付文字列をdate型に変換"""
    if not value or not value.strip():
        return None
    value = value.strip()
    try:
        return datetime.strptime(value, '%Y-%m-%d').date()
    except ValueError:
        return None


def parse_float(value: str, default=0.0):
    """数値文字列をfloatに変換"""
    if not value or not value.strip():
        return default
    try:
        return float(value.strip())
    except ValueError:
        return default


def parse_int(value: str, default=0):
    """数値文字列をintに変換"""
    if not value or not value.strip():
        return default
    try:
        return int(float(value.strip()))
    except ValueError:
        return default


def import_shipments(csv_path: str):
    db = SessionLocal()
    try:
        # 既存のtransiaのshipmentデータを削除
        deleted = db.query(Shipment).filter(Shipment.tenant_id == TENANT_ID).delete()
        db.commit()
        print(f"既存データ削除: {deleted}件")

        # BOM付きUTF-8で読み込み
        with open(csv_path, 'r', encoding='utf-8-sig') as f:
            lines = f.readlines()

        # コメント行と空行をフィルタ
        data_lines = []
        header_line = None
        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith('#'):
                continue
            if header_line is None:
                header_line = line
            else:
                data_lines.append(line)

        if not header_line:
            print("エラー: ヘッダー行が見つかりません")
            return

        # CSVパース
        all_lines = [header_line] + data_lines
        reader = csv.DictReader(all_lines)

        success_count = 0
        error_count = 0

        for row_num, row in enumerate(reader, start=1):
            try:
                # 必須フィールドチェック
                pickup_date = parse_date(row.get('積込日', ''))
                delivery_date = parse_date(row.get('納品日', ''))

                if not pickup_date:
                    print(f"  行{row_num}: 積込日が不正 '{row.get('積込日', '')}' - スキップ")
                    error_count += 1
                    continue
                if not delivery_date:
                    print(f"  行{row_num}: 納品日が不正 '{row.get('納品日', '')}' - スキップ")
                    error_count += 1
                    continue

                # 積地住所・卸地住所: 空なら空文字列を許容
                pickup_address = (row.get('積地住所') or '').strip()
                delivery_address = (row.get('卸地住所') or '').strip()

                # 荷主名: 空の場合はデフォルト値
                client_name = (row.get('荷主名') or '').strip()
                if not client_name:
                    client_name = '未設定'

                shipment = Shipment(
                    tenant_id=TENANT_ID,
                    name=(row.get('案件名') or '').strip(),
                    client_name=client_name,
                    cargo_description=(row.get('積荷内容') or '').strip(),
                    weight=parse_float(row.get('重量kg', '')),
                    pickup_address=pickup_address,
                    delivery_address=delivery_address,
                    pickup_date=pickup_date,
                    pickup_time=(row.get('積込時間') or '').strip(),
                    delivery_date=delivery_date,
                    delivery_time=(row.get('納品時間') or '').strip(),
                    time_note=(row.get('時間備考') or '').strip(),
                    price=parse_int(row.get('運賃', '')),
                    transport_type=(row.get('輸送タイプ') or 'ドライ').strip() or 'ドライ',
                    temperature_zone=(row.get('温度帯') or '常温').strip() or '常温',
                    unit_price_type=(row.get('単価種別') or '').strip(),
                    unit_price=parse_float(row.get('単価', '')),
                    unit_quantity=parse_float(row.get('数量', '')),
                    frequency_type=(row.get('頻度') or '単発').strip() or '単発',
                    frequency_days=(row.get('頻度曜日') or '').strip(),
                    status=(row.get('ステータス') or '未配車').strip() or '未配車',
                    waiting_time=parse_int(row.get('待機時間分', '')),
                    loading_time=parse_int(row.get('積込作業時間分', '')),
                    unloading_time=parse_int(row.get('卸作業時間分', '')),
                    notes=(row.get('備考') or '').strip(),
                )
                db.add(shipment)
                success_count += 1

                # 500件ごとにコミット（メモリ効率）
                if success_count % 500 == 0:
                    db.commit()
                    print(f"  {success_count}件コミット済み...")

            except Exception as e:
                print(f"  行{row_num}: エラー - {e} - スキップ")
                error_count += 1
                continue

        db.commit()
        print(f"\n=== インポート完了 ===")
        print(f"成功: {success_count}件")
        print(f"エラー: {error_count}件")
        print(f"合計処理行: {success_count + error_count}件")

    except Exception as e:
        db.rollback()
        print(f"致命的エラー: {e}")
        raise
    finally:
        db.close()


if __name__ == '__main__':
    csv_path = sys.argv[1] if len(sys.argv) > 1 else r'C:\Users\yuuji\Downloads\2025年12月_案件一括登録.csv'
    print(f"CSVファイル: {csv_path}")
    print(f"テナント: {TENANT_ID}")
    print(f"DB: tenants/{TENANT_ID}/dispatch.db")
    print()
    import_shipments(csv_path)
