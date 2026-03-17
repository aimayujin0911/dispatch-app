"""テストデータ投入スクリプト"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))

from datetime import date, timedelta
from database import engine, SessionLocal, Base
from models import Vehicle, Driver, Shipment, Dispatch, DailyReport


def seed():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()

    today = date.today()

    # 車両
    vehicles = [
        Vehicle(number="品川 100 あ 1234", chassis_number="ABC-1234567", type="ウイング車", capacity=10000, status="稼働中", first_registration="2020-04", inspection_expiry="2026-04-15"),
        Vehicle(number="品川 200 い 5678", chassis_number="DEF-2345678", type="冷蔵車", capacity=4000, status="空車", first_registration="2021-07", inspection_expiry="2026-07-20"),
        Vehicle(number="横浜 300 う 9012", chassis_number="GHI-3456789", type="平ボディ", capacity=2000, status="空車", first_registration="2019-11", inspection_expiry="2026-05-10"),
        Vehicle(number="大宮 400 え 3456", chassis_number="JKL-4567890", type="トレーラー", capacity=20000, status="稼働中", first_registration="2022-01", inspection_expiry="2026-09-30"),
        Vehicle(number="千葉 500 お 7890", chassis_number="MNO-5678901", type="ウイング車", capacity=10000, status="整備中", notes="タイヤ交換中", first_registration="2018-06", inspection_expiry="2026-03-25"),
        Vehicle(number="品川 600 か 1111", chassis_number="PQR-6789012", type="バン", capacity=4000, status="空車", first_registration="2023-03", inspection_expiry="2027-03-15"),
    ]
    db.add_all(vehicles)
    db.flush()

    # ドライバー
    drivers = [
        Driver(name="田中 太郎", phone="090-1234-5678", license_type="大型", status="運行中"),
        Driver(name="鈴木 一郎", phone="090-2345-6789", license_type="大型", status="運行中"),
        Driver(name="佐藤 花子", phone="090-3456-7890", license_type="中型", status="待機中"),
        Driver(name="山田 次郎", phone="090-4567-8901", license_type="大型", status="待機中"),
        Driver(name="高橋 三郎", phone="090-5678-9012", license_type="けん引", status="非番"),
        Driver(name="伊藤 美咲", phone="090-6789-0123", license_type="中型", status="待機中"),
    ]
    db.add_all(drivers)
    db.flush()

    # 荷主企業
    from models import Client
    clients = [
        Client(name="ABC物流", address="東京都大田区南蒲田1-1-1", phone="03-1234-5678", contact_person="鈴木部長"),
        Client(name="XYZ商事", address="埼玉県さいたま市大宮区桜木町1-1", phone="048-123-4567", contact_person="田中課長"),
        Client(name="山本建設", address="東京都江東区有明3-3-3", phone="03-2345-6789", contact_person="山本社長"),
        Client(name="日本通商", address="東京都品川区東品川2-2-2", phone="03-3456-7890", contact_person="佐々木主任"),
        Client(name="太陽食品", address="千葉県船橋市本町5-5-5", phone="047-123-4567", contact_person="中村係長"),
        Client(name="関東運輸", address="東京都墨田区錦糸1-1-1", phone="03-4567-8901", contact_person="高橋部長"),
        Client(name="東海配送", address="神奈川県横浜市鶴見区鶴見中央1-1", phone="045-123-4567", contact_person="伊藤店長"),
        Client(name="北関東商事", address="群馬県高崎市栄町1-1-1", phone="027-123-4567", contact_person="小林課長"),
        Client(name="湘南物流", address="神奈川県藤沢市藤沢1-1-1", phone="0466-12-3456", contact_person="渡辺部長"),
    ]
    db.add_all(clients)
    db.flush()

    # 案件
    shipments = [
        Shipment(name="ABC家電定期便", client_name="ABC物流", cargo_description="家電製品", weight=3000,
                 pickup_address="東京都大田区平和島", delivery_address="神奈川県横浜市港北区",
                 pickup_date=today, delivery_date=today, price=85000, status="配車済",
                 frequency_type="曜日指定", frequency_days="月,水,金"),
        Shipment(name="XYZ冷蔵便", client_name="XYZ商事", cargo_description="食品(冷蔵)", weight=8000,
                 pickup_address="埼玉県さいたま市大宮区", delivery_address="千葉県千葉市美浜区",
                 pickup_date=today, delivery_date=today, price=120000, status="配車済",
                 frequency_type="毎日", frequency_days=""),
        Shipment(name="山本建材輸送", client_name="山本建設", cargo_description="建材", weight=5000,
                 pickup_address="東京都江東区有明", delivery_address="茨城県つくば市",
                 pickup_date=today, delivery_date=today + timedelta(days=1), price=95000, status="未配車",
                 frequency_type="単発", frequency_days=""),
        Shipment(name="日本通商精密機器", client_name="日本通商", cargo_description="精密機器", weight=1500,
                 pickup_address="東京都品川区東品川", delivery_address="静岡県浜松市中区",
                 pickup_date=today + timedelta(days=1), delivery_date=today + timedelta(days=1), price=150000, status="未配車",
                 frequency_type="曜日指定", frequency_days="火,木"),
        Shipment(name="太陽飲料配送", client_name="太陽食品", cargo_description="飲料", weight=6000,
                 pickup_address="千葉県船橋市", delivery_address="東京都新宿区",
                 pickup_date=today + timedelta(days=2), delivery_date=today + timedelta(days=2), price=65000, status="未配車",
                 frequency_type="毎日", frequency_days=""),
        # 完了済み(売上データ用)
        Shipment(name="関東雑貨便", client_name="関東運輸", cargo_description="雑貨", weight=2000,
                 pickup_address="東京都墨田区", delivery_address="神奈川県川崎市",
                 pickup_date=today - timedelta(days=1), delivery_date=today - timedelta(days=1), price=55000, status="完了",
                 frequency_type="曜日指定", frequency_days="月,火,水,木,金"),
        Shipment(name="東海部品輸送", client_name="東海配送", cargo_description="自動車部品", weight=7000,
                 pickup_address="神奈川県横浜市鶴見区", delivery_address="静岡県沼津市",
                 pickup_date=today - timedelta(days=2), delivery_date=today - timedelta(days=2), price=180000, status="完了",
                 frequency_type="単発", frequency_days=""),
        Shipment(name="北関東衣料便", client_name="北関東商事", cargo_description="衣料品", weight=3500,
                 pickup_address="群馬県高崎市", delivery_address="東京都渋谷区",
                 pickup_date=today - timedelta(days=3), delivery_date=today - timedelta(days=3), price=72000, status="完了",
                 frequency_type="曜日指定", frequency_days="月,水"),
        Shipment(name="湘南医薬品配送", client_name="湘南物流", cargo_description="医薬品", weight=500,
                 pickup_address="東京都中央区", delivery_address="神奈川県藤沢市",
                 pickup_date=today - timedelta(days=4), delivery_date=today - timedelta(days=4), price=98000, status="完了",
                 frequency_type="毎日", frequency_days=""),
    ]
    db.add_all(shipments)
    db.flush()

    # 配車(本日分)
    dispatches_data = [
        Dispatch(vehicle_id=vehicles[0].id, driver_id=drivers[0].id, shipment_id=shipments[0].id,
                 date=today, start_time="06:00", end_time="12:00", status="運行中", notes="午前中配達希望"),
        Dispatch(vehicle_id=vehicles[3].id, driver_id=drivers[1].id, shipment_id=shipments[1].id,
                 date=today, start_time="08:00", end_time="16:00", status="予定", notes="冷蔵車使用"),
        Dispatch(vehicle_id=vehicles[1].id, driver_id=drivers[2].id, shipment_id=shipments[2].id,
                 date=today + timedelta(days=1), start_time="07:00", end_time="15:00", status="予定", notes="建材配送"),
        Dispatch(vehicle_id=vehicles[2].id, driver_id=drivers[3].id, shipment_id=shipments[3].id,
                 date=today + timedelta(days=1), start_time="09:00", end_time="18:00", status="予定", notes="精密機器取扱注意"),
    ]
    db.add_all(dispatches_data)
    db.flush()

    # 日報
    reports = [
        DailyReport(driver_id=drivers[0].id, date=today - timedelta(days=1),
                    start_time="06:30", end_time="18:00", distance_km=245.5, fuel_liters=42.0,
                    notes="首都高渋滞あり"),
        DailyReport(driver_id=drivers[1].id, date=today - timedelta(days=1),
                    start_time="07:00", end_time="17:30", distance_km=180.0, fuel_liters=35.0,
                    notes="問題なし"),
        DailyReport(driver_id=drivers[2].id, date=today - timedelta(days=1),
                    start_time="08:00", end_time="16:00", distance_km=120.0, fuel_liters=18.0,
                    notes="荷受け待ち30分"),
        DailyReport(driver_id=drivers[0].id, date=today - timedelta(days=2),
                    start_time="05:00", end_time="19:00", distance_km=310.0, fuel_liters=55.0,
                    notes="長距離運行"),
    ]
    db.add_all(reports)

    db.commit()
    db.close()
    print("テストデータ投入完了!")


if __name__ == "__main__":
    seed()
