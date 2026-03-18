"""テストデータ投入スクリプト"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))

from datetime import date, datetime, timedelta
from database import engine, SessionLocal, Base
from models import (Vehicle, Driver, Shipment, Dispatch, DailyReport, Client,
                    PartnerCompany, PartnerInvoice, PartnerInvoiceItem,
                    TransportRequest, VehicleNotification, Attendance,
                    AccountEntry, CompanySettings, ClientNote, VehicleCost, Vendor,
                    Branch, User)


def seed():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()

    today = date.today()

    # 営業所
    branch_honsha = Branch(name="本社", address="東京都大田区南蒲田1-10-5", phone="03-5555-1234")
    branch_yokohama = Branch(name="横浜営業所", address="神奈川県横浜市鶴見区鶴見中央1-1", phone="045-555-6789")
    db.add_all([branch_honsha, branch_yokohama])
    db.flush()

    # 管理者ユーザー
    from auth import hash_password
    admin_user = User(
        email="admin@example.com",
        password_hash=hash_password("admin1234"),
        name="管理者",
        role="admin",
        branch_id=branch_honsha.id,
    )
    manager_user = User(
        email="manager@example.com",
        password_hash=hash_password("manager1234"),
        name="横浜所長",
        role="manager",
        branch_id=branch_yokohama.id,
    )
    db.add_all([admin_user, manager_user])
    db.flush()

    # 自社情報
    settings = CompanySettings(
        id=1,
        company_name="株式会社サンプル運輸",
        postal_code="144-0035",
        address="東京都大田区南蒲田1-10-5",
        phone="03-5555-1234",
        fax="03-5555-1235",
        email="info@sample-unyu.co.jp",
        representative="代表取締役 佐藤一郎",
        registration_number="T1234567890123",
        bank_info="みずほ銀行 蒲田支店 普通 1234567\n口座名義: カ）サンプルウンユ",
        payment_terms="月末締め翌月末払い",
        tax_rate=10,
        seal_text="株式会社サンプル運輸",
        invoice_note="お振込手数料はお客様にてご負担願います。",
        notes="一般貨物自動車運送事業 関自貨第1234号",
    )
    db.add(settings)

    # 車両
    vehicles = [
        # ウイング車（大型・中型）
        Vehicle(number="品川 100 あ 1234", chassis_number="ABC-1234567", type="ウイング車", capacity=10, status="通常", first_registration="2020-04", inspection_expiry="2026-04-15"),
        Vehicle(number="品川 100 さ 3333", chassis_number="STU-1112233", type="ウイング車", capacity=13, status="通常", first_registration="2021-10", inspection_expiry="2026-10-20"),
        Vehicle(number="千葉 500 お 7890", chassis_number="MNO-5678901", type="ウイング車", capacity=10, status="整備中", notes="タイヤ交換中", first_registration="2018-06", inspection_expiry="2026-03-25"),
        # 冷蔵・冷凍車
        Vehicle(number="品川 200 い 5678", chassis_number="DEF-2345678", type="冷蔵車", capacity=4, status="通常", first_registration="2021-07", inspection_expiry="2026-07-20"),
        Vehicle(number="横浜 200 な 7777", chassis_number="WXY-4445566", type="冷凍車", capacity=10, status="通常", first_registration="2022-05", inspection_expiry="2027-05-10", notes="-25℃対応"),
        # 平ボディ
        Vehicle(number="横浜 300 う 9012", chassis_number="GHI-3456789", type="平ボディ", capacity=2, status="通常", first_registration="2019-11", inspection_expiry="2026-05-10"),
        Vehicle(number="大宮 300 た 4444", chassis_number="VWX-3334455", type="平ボディ", capacity=4, status="通常", first_registration="2020-08", inspection_expiry="2026-08-30"),
        # トレーラー
        Vehicle(number="大宮 400 え 3456", chassis_number="JKL-4567890", type="トレーラー", capacity=20, status="通常", first_registration="2022-01", inspection_expiry="2026-09-30"),
        Vehicle(number="川崎 400 ち 8888", chassis_number="ZAB-7778899", type="トレーラー", capacity=24, status="通常", first_registration="2023-06", inspection_expiry="2027-06-15"),
        # バン
        Vehicle(number="品川 600 か 1111", chassis_number="PQR-6789012", type="バン", capacity=4, status="通常", first_registration="2023-03", inspection_expiry="2027-03-15"),
        Vehicle(number="足立 600 つ 5555", chassis_number="CDE-5556677", type="バン", capacity=2, status="通常", first_registration="2024-01", inspection_expiry="2028-01-20"),
        # ユニック車（クレーン付き）
        Vehicle(number="品川 800 に 2222", chassis_number="FGH-8889900", type="ユニック車", capacity=4, status="通常", first_registration="2019-03", inspection_expiry="2026-03-10", notes="2.9tクレーン付"),
        # 軽貨物
        Vehicle(number="品川 480 は 9999", chassis_number="IJK-9990011", type="軽貨物", capacity=0.35, status="通常", first_registration="2024-06", inspection_expiry="2028-06-01"),
        # 整備中追加
        Vehicle(number="横浜 100 ま 6666", chassis_number="LMN-6667788", type="冷蔵車", capacity=4, status="整備中", notes="冷凍機修理中", first_registration="2020-02", inspection_expiry="2026-06-15"),
    ]
    db.add_all(vehicles)
    db.flush()

    # ドライバー（メール/パスワード付き → 勤怠アプリログイン可能）
    import hashlib
    def h(pw): return hashlib.sha256(pw.encode()).hexdigest()
    drivers = [
        Driver(name="田中 太郎", phone="090-1234-5678", email="tanaka@sample-unyu.co.jp", password_hash=h("pass1234"), license_type="大型", status="運行中", paid_leave_balance=8.5, work_start="06:00", work_end="15:00"),
        Driver(name="鈴木 一郎", phone="090-2345-6789", email="suzuki@sample-unyu.co.jp", password_hash=h("pass1234"), license_type="大型", status="運行中", paid_leave_balance=10.0, work_start="07:00", work_end="16:00"),
        Driver(name="佐藤 花子", phone="090-3456-7890", email="sato@sample-unyu.co.jp", password_hash=h("pass1234"), license_type="中型", status="待機中", paid_leave_balance=12.0, work_start="08:00", work_end="17:00"),
        Driver(name="山田 次郎", phone="090-4567-8901", email="yamada@sample-unyu.co.jp", password_hash=h("pass1234"), license_type="大型", status="待機中", paid_leave_balance=10.0, work_start="05:00", work_end="14:00"),
        Driver(name="高橋 三郎", phone="090-5678-9012", license_type="けん引", status="非番", paid_leave_balance=5.0, work_start="08:00", work_end="17:00"),
        Driver(name="伊藤 美咲", phone="090-6789-0123", email="ito@sample-unyu.co.jp", password_hash=h("pass1234"), license_type="中型", status="待機中", paid_leave_balance=10.0, work_start="13:00", work_end="22:00"),
    ]
    db.add_all(drivers)
    db.flush()

    # 荷主企業（請求先情報付き）
    clients = [
        Client(name="ABC物流", address="東京都大田区南蒲田1-1-1", phone="03-1234-5678", fax="03-1234-5679",
               contact_person="鈴木部長",
               billing_address="東京都大田区南蒲田1-1-1 経理部宛", billing_contact="経理 山田",
               billing_email="keiri@abc-logistics.co.jp", payment_terms="月末締め翌月末払い",
               credit_limit=5000000, tax_id="T9876543210123"),
        Client(name="XYZ商事", address="埼玉県さいたま市大宮区桜木町1-1", phone="048-123-4567", fax="048-123-4568",
               contact_person="田中課長",
               billing_address="埼玉県さいたま市大宮区桜木町1-1", billing_contact="経理 佐藤",
               billing_email="billing@xyz-trading.co.jp", payment_terms="月末締め翌月末払い",
               credit_limit=3000000),
        Client(name="山本建設", address="東京都江東区有明3-3-3", phone="03-2345-6789",
               contact_person="山本社長",
               billing_email="yamamoto@yamaken.co.jp", payment_terms="20日締め翌月末払い",
               credit_limit=2000000),
        Client(name="日本通商", address="東京都品川区東品川2-2-2", phone="03-3456-7890", fax="03-3456-7891",
               contact_person="佐々木主任",
               billing_address="東京都品川区東品川2-2-2 管理部", billing_contact="管理部 木村",
               billing_email="accounts@nihon-tsusho.co.jp", payment_terms="月末締め翌月末払い",
               credit_limit=10000000, tax_id="T1111222233334"),
        Client(name="太陽食品", address="千葉県船橋市本町5-5-5", phone="047-123-4567",
               contact_person="中村係長",
               billing_email="nakamura@taiyo-foods.co.jp", payment_terms="月末締め翌月末払い"),
        Client(name="関東運輸", address="東京都墨田区錦糸1-1-1", phone="03-4567-8901",
               contact_person="高橋部長", payment_terms="月末締め翌月末払い"),
        Client(name="東海配送", address="神奈川県横浜市鶴見区鶴見中央1-1", phone="045-123-4567",
               contact_person="伊藤店長", payment_terms="20日締め翌月末払い"),
        Client(name="北関東商事", address="群馬県高崎市栄町1-1-1", phone="027-123-4567",
               contact_person="小林課長", payment_terms="月末締め翌月末払い"),
        Client(name="湘南物流", address="神奈川県藤沢市藤沢1-1-1", phone="0466-12-3456",
               contact_person="渡辺部長", billing_email="watanabe@shonan-logi.co.jp",
               payment_terms="月末締め翌月末払い"),
    ]
    db.add_all(clients)
    db.flush()

    # 荷主連絡履歴
    client_notes = [
        ClientNote(client_id=clients[0].id, content="月次定例ミーティング実施。来月から週3回→週5回に増便希望あり。", created_by="佐藤"),
        ClientNote(client_id=clients[0].id, content="増便の見積り¥425,000/月で提出済み。返答待ち。", created_by="佐藤"),
        ClientNote(client_id=clients[1].id, content="冷蔵便の温度管理について要望あり。庫内温度3℃以下を希望。", created_by="田中"),
        ClientNote(client_id=clients[3].id, content="精密機器輸送の保険について問い合わせあり。別途見積り中。", created_by="佐藤"),
    ]
    for note in client_notes:
        note.date = datetime.now() - timedelta(days=client_notes.index(note) * 3)
    db.add_all(client_notes)

    # 協力会社
    partners = [
        PartnerCompany(name="丸一運送", address="東京都足立区千住1-1-1", phone="03-6666-1111", fax="03-6666-1112",
                       contact_person="松本配車担当", bank_info="三菱UFJ銀行 北千住支店 普通 9876543", payment_terms="月末締め翌月末払い"),
        PartnerCompany(name="大和急送", address="神奈川県川崎市川崎区駅前本町1-1", phone="044-555-2222", fax="044-555-2223",
                       contact_person="中野所長", bank_info="りそな銀行 川崎支店 普通 1112233", payment_terms="月末締め翌月末払い"),
        PartnerCompany(name="富士ロジスティクス", address="静岡県沼津市大手町1-1", phone="055-444-3333", fax="055-444-3334",
                       contact_person="望月運行管理者", bank_info="静岡銀行 沼津支店 普通 4445566", payment_terms="20日締め翌月末払い"),
    ]
    db.add_all(partners)
    db.flush()

    # 案件（待機・積込・荷卸時間付き）
    shipments = [
        Shipment(name="ABC家電定期便", client_name="ABC物流", cargo_description="家電製品", weight=3000,
                 pickup_address="東京都大田区平和島", delivery_address="神奈川県横浜市港北区",
                 pickup_date=today, pickup_time="06:00", delivery_date=today, delivery_time="12:00",
                 time_note="午前必着", price=85000, status="運行中",
                 transport_type="ドライ", unit_price_type="車建", unit_price=85000, unit_quantity=1,
                 waiting_time=15, loading_time=30, unloading_time=20,
                 frequency_type="曜日指定", frequency_days="月,水,金"),
        Shipment(name="XYZ冷蔵便", client_name="XYZ商事", cargo_description="食品(冷蔵)", weight=8000,
                 pickup_address="埼玉県さいたま市大宮区", delivery_address="千葉県千葉市美浜区",
                 pickup_date=today, pickup_time="08:00", delivery_date=today, delivery_time="16:00",
                 price=120000, status="運行中",
                 transport_type="冷蔵", unit_price_type="kg単価", unit_price=15, unit_quantity=8000,
                 waiting_time=10, loading_time=45, unloading_time=30,
                 frequency_type="毎日", frequency_days=""),
        Shipment(name="山本建材輸送", client_name="山本建設", cargo_description="建材", weight=5000,
                 pickup_address="東京都江東区有明", delivery_address="茨城県つくば市",
                 pickup_date=today, delivery_date=today + timedelta(days=1), price=95000, status="未配車",
                 transport_type="ドライ", unit_price_type="車建", unit_price=95000, unit_quantity=1,
                 waiting_time=20, loading_time=60, unloading_time=45,
                 time_note="AM指定", frequency_type="単発", frequency_days=""),
        Shipment(name="日本通商精密機器", client_name="日本通商", cargo_description="精密機器", weight=1500,
                 pickup_address="東京都品川区東品川", delivery_address="静岡県浜松市中区",
                 pickup_date=today + timedelta(days=1), pickup_time="09:00", delivery_date=today + timedelta(days=1), delivery_time="18:00",
                 time_note="取扱注意・時間厳守", price=150000, status="未配車",
                 transport_type="ドライ", unit_price_type="個建", unit_price=150000, unit_quantity=1,
                 waiting_time=30, loading_time=40, unloading_time=40,
                 frequency_type="曜日指定", frequency_days="火,木"),
        Shipment(name="太陽飲料配送", client_name="太陽食品", cargo_description="飲料", weight=6000,
                 pickup_address="千葉県船橋市", delivery_address="東京都新宿区",
                 pickup_date=today + timedelta(days=2), pickup_time="07:00", delivery_date=today + timedelta(days=2), delivery_time="11:00",
                 price=65000, status="未配車",
                 transport_type="チルド", unit_price_type="ケース単価", unit_price=32.5, unit_quantity=2000,
                 waiting_time=5, loading_time=20, unloading_time=15,
                 frequency_type="毎日", frequency_days=""),
        # 完了済み(売上データ用)
        Shipment(name="関東雑貨便", client_name="関東運輸", cargo_description="雑貨", weight=2000,
                 pickup_address="東京都墨田区", delivery_address="神奈川県川崎市",
                 pickup_date=today - timedelta(days=1), delivery_date=today - timedelta(days=1), price=55000, status="完了",
                 transport_type="ドライ", unit_price_type="車建", unit_price=55000, unit_quantity=1,
                 waiting_time=10, loading_time=15, unloading_time=10,
                 frequency_type="曜日指定", frequency_days="月,火,水,木,金"),
        Shipment(name="東海部品輸送", client_name="東海配送", cargo_description="自動車部品", weight=7000,
                 pickup_address="神奈川県横浜市鶴見区", delivery_address="静岡県沼津市",
                 pickup_date=today - timedelta(days=2), delivery_date=today - timedelta(days=2), price=180000, status="完了",
                 transport_type="ドライ", unit_price_type="車建", unit_price=180000, unit_quantity=1,
                 invoice_status="請求済", invoice_date=today - timedelta(days=1),
                 waiting_time=20, loading_time=50, unloading_time=35,
                 frequency_type="単発", frequency_days=""),
        Shipment(name="北関東衣料便", client_name="北関東商事", cargo_description="衣料品", weight=3500,
                 pickup_address="群馬県高崎市", delivery_address="東京都渋谷区",
                 pickup_date=today - timedelta(days=3), delivery_date=today - timedelta(days=3), price=72000, status="完了",
                 transport_type="ドライ", unit_price_type="kg単価", unit_price=20.57, unit_quantity=3500,
                 frequency_type="曜日指定", frequency_days="月,水"),
        Shipment(name="湘南医薬品配送", client_name="湘南物流", cargo_description="医薬品", weight=500,
                 pickup_address="東京都中央区", delivery_address="神奈川県藤沢市",
                 pickup_date=today - timedelta(days=4), delivery_date=today - timedelta(days=4), price=98000, status="完了",
                 transport_type="冷蔵", unit_price_type="個建", unit_price=98000, unit_quantity=1,
                 invoice_status="入金済", invoice_date=today - timedelta(days=2),
                 frequency_type="毎日", frequency_days=""),
        # 追加案件データ
        Shipment(name="ABC定温輸送", client_name="ABC物流", cargo_description="冷凍食品", weight=4000,
                 pickup_address="東京都大田区平和島", delivery_address="埼玉県川越市",
                 pickup_date=today + timedelta(days=1), pickup_time="05:00", delivery_date=today + timedelta(days=1), delivery_time="10:00",
                 price=78000, status="未配車",
                 waiting_time=10, loading_time=25, unloading_time=20,
                 frequency_type="曜日指定", frequency_days="月,水,金"),
        Shipment(name="XYZ青果便", client_name="XYZ商事", cargo_description="青果物", weight=3000,
                 pickup_address="千葉県市川市", delivery_address="東京都豊島区",
                 pickup_date=today, pickup_time="04:00", delivery_date=today, delivery_time="08:00",
                 time_note="早朝着指定", price=52000, status="未配車",
                 waiting_time=5, loading_time=20, unloading_time=15,
                 frequency_type="毎日", frequency_days=""),
        Shipment(name="日本通商電子部品", client_name="日本通商", cargo_description="電子部品", weight=800,
                 pickup_address="東京都品川区東品川", delivery_address="群馬県太田市",
                 pickup_date=today + timedelta(days=2), pickup_time="10:00", delivery_date=today + timedelta(days=2), delivery_time="16:00",
                 time_note="精密品・振動注意", price=125000, status="未配車",
                 waiting_time=20, loading_time=30, unloading_time=30,
                 frequency_type="曜日指定", frequency_days="火,金"),
        Shipment(name="東海タイヤ輸送", client_name="東海配送", cargo_description="タイヤ", weight=6000,
                 pickup_address="神奈川県横浜市鶴見区", delivery_address="愛知県名古屋市港区",
                 pickup_date=today + timedelta(days=3), delivery_date=today + timedelta(days=3), price=220000, status="未配車",
                 waiting_time=15, loading_time=40, unloading_time=30,
                 time_note="午前中集荷希望",
                 frequency_type="単発", frequency_days=""),
        Shipment(name="太陽食品チルド便", client_name="太陽食品", cargo_description="乳製品(チルド)", weight=2500,
                 pickup_address="千葉県船橋市", delivery_address="東京都世田谷区",
                 pickup_date=today, pickup_time="06:00", delivery_date=today, delivery_time="09:00",
                 price=45000, status="未配車",
                 waiting_time=5, loading_time=15, unloading_time=10,
                 frequency_type="毎日", frequency_days=""),
        Shipment(name="関東文具配送", client_name="関東運輸", cargo_description="文具・事務用品", weight=1800,
                 pickup_address="東京都墨田区錦糸", delivery_address="千葉県柏市",
                 pickup_date=today + timedelta(days=1), delivery_date=today + timedelta(days=1), price=48000, status="未配車",
                 waiting_time=10, loading_time=20, unloading_time=15,
                 frequency_type="曜日指定", frequency_days="月,木"),
        Shipment(name="北関東鋼材輸送", client_name="北関東商事", cargo_description="鋼材", weight=9000,
                 pickup_address="群馬県高崎市", delivery_address="栃木県宇都宮市",
                 pickup_date=today + timedelta(days=2), delivery_date=today + timedelta(days=2), price=88000, status="未配車",
                 waiting_time=25, loading_time=50, unloading_time=40,
                 frequency_type="単発", frequency_days=""),
        Shipment(name="湘南化粧品配送", client_name="湘南物流", cargo_description="化粧品", weight=600,
                 pickup_address="神奈川県藤沢市", delivery_address="東京都港区",
                 pickup_date=today + timedelta(days=1), pickup_time="08:00", delivery_date=today + timedelta(days=1), delivery_time="12:00",
                 price=55000, status="未配車",
                 waiting_time=5, loading_time=10, unloading_time=10,
                 frequency_type="曜日指定", frequency_days="火,木,土"),
        Shipment(name="山本建設資材(埼玉)", client_name="山本建設", cargo_description="コンクリート資材", weight=12000,
                 pickup_address="東京都江東区有明", delivery_address="埼玉県さいたま市岩槻区",
                 pickup_date=today + timedelta(days=3), delivery_date=today + timedelta(days=3), price=135000, status="未配車",
                 waiting_time=30, loading_time=60, unloading_time=50,
                 time_note="大型車指定",
                 frequency_type="単発", frequency_days=""),
        Shipment(name="ABC物流引越便", client_name="ABC物流", cargo_description="家財道具", weight=2000,
                 pickup_address="東京都世田谷区", delivery_address="神奈川県相模原市",
                 pickup_date=today + timedelta(days=4), delivery_date=today + timedelta(days=4), price=110000, status="未配車",
                 waiting_time=15, loading_time=90, unloading_time=60,
                 frequency_type="単発", frequency_days=""),
        Shipment(name="XYZ冷凍水産便", client_name="XYZ商事", cargo_description="冷凍水産物", weight=5000,
                 pickup_address="千葉県銚子市", delivery_address="東京都築地",
                 pickup_date=today + timedelta(days=1), pickup_time="03:00", delivery_date=today + timedelta(days=1), delivery_time="07:00",
                 time_note="深夜発・早朝着", price=95000, status="未配車",
                 waiting_time=10, loading_time=30, unloading_time=20,
                 frequency_type="曜日指定", frequency_days="月,水,金"),
        # ===== 追加案件（バリエーション豊富に） =====
        # 当日の案件
        Shipment(name="日本通商OA機器", client_name="日本通商", cargo_description="コピー機・プリンター", weight=1200,
                 pickup_address="東京都品川区東品川", delivery_address="東京都千代田区大手町",
                 pickup_date=today, pickup_time="10:00", delivery_date=today, delivery_time="13:00",
                 time_note="エレベーター搬入", price=68000, status="未配車",
                 waiting_time=15, loading_time=30, unloading_time=40,
                 frequency_type="単発", frequency_days=""),
        Shipment(name="太陽食品冷凍便", client_name="太陽食品", cargo_description="冷凍食品", weight=4500,
                 pickup_address="千葉県船橋市", delivery_address="埼玉県さいたま市浦和区",
                 pickup_date=today, pickup_time="05:00", delivery_date=today, delivery_time="09:00",
                 price=58000, status="未配車",
                 waiting_time=5, loading_time=25, unloading_time=20,
                 frequency_type="毎日", frequency_days=""),
        Shipment(name="関東運輸ルート便A", client_name="関東運輸", cargo_description="日用品", weight=3000,
                 pickup_address="東京都墨田区", delivery_address="千葉県松戸市",
                 pickup_date=today, pickup_time="09:00", delivery_date=today, delivery_time="12:00",
                 price=42000, status="未配車",
                 waiting_time=5, loading_time=15, unloading_time=15,
                 frequency_type="曜日指定", frequency_days="月,火,水,木,金"),
        Shipment(name="湘南物流医療機器", client_name="湘南物流", cargo_description="医療機器", weight=300,
                 pickup_address="神奈川県藤沢市", delivery_address="東京都文京区",
                 pickup_date=today, pickup_time="08:00", delivery_date=today, delivery_time="11:00",
                 time_note="精密機器・温度管理", price=85000, status="未配車",
                 waiting_time=10, loading_time=20, unloading_time=25,
                 frequency_type="曜日指定", frequency_days="火,金"),
        # 翌日の案件
        Shipment(name="ABC物流パレット便", client_name="ABC物流", cargo_description="パレット貨物", weight=8000,
                 pickup_address="東京都大田区平和島", delivery_address="神奈川県横浜市中区",
                 pickup_date=today + timedelta(days=1), pickup_time="06:00", delivery_date=today + timedelta(days=1), delivery_time="10:00",
                 price=72000, status="未配車",
                 waiting_time=10, loading_time=30, unloading_time=25,
                 frequency_type="曜日指定", frequency_days="月,水,金"),
        Shipment(name="東海配送資材(静岡)", client_name="東海配送", cargo_description="住宅資材", weight=11000,
                 pickup_address="神奈川県横浜市鶴見区", delivery_address="静岡県静岡市清水区",
                 pickup_date=today + timedelta(days=1), delivery_date=today + timedelta(days=1), price=195000, status="未配車",
                 waiting_time=20, loading_time=45, unloading_time=40,
                 time_note="大型車指定・午前着",
                 frequency_type="単発", frequency_days=""),
        Shipment(name="山本建設足場材", client_name="山本建設", cargo_description="足場材", weight=7500,
                 pickup_address="埼玉県川口市", delivery_address="千葉県市原市",
                 pickup_date=today + timedelta(days=1), pickup_time="07:00", delivery_date=today + timedelta(days=1), delivery_time="12:00",
                 price=82000, status="未配車",
                 waiting_time=15, loading_time=40, unloading_time=35,
                 frequency_type="単発", frequency_days=""),
        Shipment(name="北関東商事紙製品", client_name="北関東商事", cargo_description="紙製品(ロール)", weight=5500,
                 pickup_address="群馬県高崎市", delivery_address="東京都板橋区",
                 pickup_date=today + timedelta(days=1), pickup_time="06:00", delivery_date=today + timedelta(days=1), delivery_time="11:00",
                 price=68000, status="未配車",
                 waiting_time=10, loading_time=30, unloading_time=20,
                 frequency_type="曜日指定", frequency_days="月,木"),
        # 2日後以降
        Shipment(name="XYZ商事冷蔵花卉", client_name="XYZ商事", cargo_description="切花(冷蔵)", weight=1500,
                 pickup_address="千葉県南房総市", delivery_address="東京都大田区",
                 pickup_date=today + timedelta(days=2), pickup_time="04:00", delivery_date=today + timedelta(days=2), delivery_time="08:00",
                 time_note="冷蔵車必須・5℃管理", price=75000, status="未配車",
                 waiting_time=5, loading_time=20, unloading_time=15,
                 frequency_type="曜日指定", frequency_days="月,水,金"),
        Shipment(name="ABC物流展示会搬入", client_name="ABC物流", cargo_description="展示ブース資材", weight=3500,
                 pickup_address="東京都大田区平和島", delivery_address="千葉県千葉市美浜区幕張",
                 pickup_date=today + timedelta(days=2), pickup_time="14:00", delivery_date=today + timedelta(days=2), delivery_time="18:00",
                 time_note="搬入時間厳守", price=92000, status="未配車",
                 waiting_time=20, loading_time=60, unloading_time=45,
                 frequency_type="単発", frequency_days=""),
        Shipment(name="日本通商半導体輸送", client_name="日本通商", cargo_description="半導体部品", weight=200,
                 pickup_address="東京都品川区東品川", delivery_address="茨城県つくば市",
                 pickup_date=today + timedelta(days=2), pickup_time="10:00", delivery_date=today + timedelta(days=2), delivery_time="14:00",
                 time_note="防振・クリーンルーム納品", price=180000, status="未配車",
                 waiting_time=30, loading_time=45, unloading_time=60,
                 frequency_type="単発", frequency_days=""),
        Shipment(name="関東運輸ルート便B", client_name="関東運輸", cargo_description="食品・飲料", weight=4000,
                 pickup_address="東京都江東区新木場", delivery_address="神奈川県相模原市",
                 pickup_date=today + timedelta(days=3), pickup_time="07:00", delivery_date=today + timedelta(days=3), delivery_time="12:00",
                 price=55000, status="未配車",
                 waiting_time=5, loading_time=20, unloading_time=20,
                 frequency_type="曜日指定", frequency_days="月,火,水,木,金"),
        Shipment(name="湘南物流返品回収", client_name="湘南物流", cargo_description="返品商品", weight=1000,
                 pickup_address="東京都渋谷区", delivery_address="神奈川県藤沢市",
                 pickup_date=today + timedelta(days=3), delivery_date=today + timedelta(days=3), price=38000, status="未配車",
                 waiting_time=10, loading_time=15, unloading_time=10,
                 frequency_type="単発", frequency_days=""),
        Shipment(name="東海配送長距離(名古屋)", client_name="東海配送", cargo_description="機械部品", weight=15000,
                 pickup_address="神奈川県横浜市鶴見区", delivery_address="愛知県名古屋市中川区",
                 pickup_date=today + timedelta(days=4), delivery_date=today + timedelta(days=4), price=280000, status="未配車",
                 waiting_time=20, loading_time=60, unloading_time=50,
                 time_note="高速利用・トレーラー指定",
                 frequency_type="単発", frequency_days=""),
        Shipment(name="山本建設生コン運搬", client_name="山本建設", cargo_description="建築資材", weight=18000,
                 pickup_address="東京都江東区有明", delivery_address="千葉県千葉市中央区",
                 pickup_date=today + timedelta(days=4), pickup_time="06:00", delivery_date=today + timedelta(days=4), delivery_time="10:00",
                 time_note="大型車指定・積込注意", price=145000, status="未配車",
                 waiting_time=15, loading_time=30, unloading_time=25,
                 frequency_type="単発", frequency_days=""),
        # 完了済み追加（売上データ用）
        Shipment(name="ABC物流定期(先週)", client_name="ABC物流", cargo_description="家電製品", weight=3200,
                 pickup_address="東京都大田区平和島", delivery_address="神奈川県横浜市港北区",
                 pickup_date=today - timedelta(days=5), delivery_date=today - timedelta(days=5), price=85000, status="完了",
                 invoice_status="請求済", invoice_date=today - timedelta(days=3),
                 frequency_type="曜日指定", frequency_days="月,水,金"),
        Shipment(name="XYZ商事冷蔵(先週)", client_name="XYZ商事", cargo_description="食品(冷蔵)", weight=7500,
                 pickup_address="埼玉県さいたま市大宮区", delivery_address="千葉県千葉市美浜区",
                 pickup_date=today - timedelta(days=5), delivery_date=today - timedelta(days=5), price=118000, status="完了",
                 invoice_status="入金済", invoice_date=today - timedelta(days=3),
                 frequency_type="毎日", frequency_days=""),
        Shipment(name="太陽食品配送(先週)", client_name="太陽食品", cargo_description="飲料", weight=5800,
                 pickup_address="千葉県船橋市", delivery_address="東京都新宿区",
                 pickup_date=today - timedelta(days=6), delivery_date=today - timedelta(days=6), price=63000, status="完了",
                 frequency_type="毎日", frequency_days=""),
        Shipment(name="日本通商精密(先週)", client_name="日本通商", cargo_description="精密機器", weight=1400,
                 pickup_address="東京都品川区東品川", delivery_address="静岡県浜松市中区",
                 pickup_date=today - timedelta(days=7), delivery_date=today - timedelta(days=7), price=148000, status="完了",
                 invoice_status="請求済", invoice_date=today - timedelta(days=5),
                 frequency_type="曜日指定", frequency_days="火,木"),
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
        # 日またぎ配車テスト
        Dispatch(vehicle_id=vehicles[5].id, driver_id=drivers[5].id, shipment_id=shipments[4].id,
                 date=today, end_date=today + timedelta(days=1), start_time="20:00", end_time="06:00", status="予定", notes="夜間長距離便"),
    ]
    db.add_all(dispatches_data)
    db.flush()

    # 日報（待機・積込・荷卸時間付き）
    reports = [
        DailyReport(driver_id=drivers[0].id, date=today - timedelta(days=1),
                    start_time="06:30", end_time="18:00", distance_km=245.5, fuel_liters=42.0,
                    waiting_time=25, loading_time=30, unloading_time=20,
                    notes="首都高渋滞あり"),
        DailyReport(driver_id=drivers[1].id, date=today - timedelta(days=1),
                    start_time="07:00", end_time="17:30", distance_km=180.0, fuel_liters=35.0,
                    waiting_time=10, loading_time=45, unloading_time=30,
                    notes="問題なし"),
        DailyReport(driver_id=drivers[2].id, date=today - timedelta(days=1),
                    start_time="08:00", end_time="16:00", distance_km=120.0, fuel_liters=18.0,
                    waiting_time=30, loading_time=20, unloading_time=15,
                    notes="荷受け待ち30分"),
        DailyReport(driver_id=drivers[0].id, date=today - timedelta(days=2),
                    start_time="05:00", end_time="19:00", distance_km=310.0, fuel_liters=55.0,
                    waiting_time=40, loading_time=60, unloading_time=35,
                    notes="長距離運行"),
    ]
    db.add_all(reports)
    db.flush()

    # 協力会社請求書
    pi1 = PartnerInvoice(
        partner_id=partners[0].id, invoice_number="MR-2026-0301", invoice_date=today - timedelta(days=5),
        due_date=today + timedelta(days=25), total_amount=280000, tax_amount=28000,
        status="確認済", period_start=today - timedelta(days=35), period_end=today - timedelta(days=5),
        notes="3月前半分")
    db.add(pi1)
    db.flush()
    db.add_all([
        PartnerInvoiceItem(partner_invoice_id=pi1.id, date=today - timedelta(days=10), description="東京→横浜 雑貨 4t車", amount=85000),
        PartnerInvoiceItem(partner_invoice_id=pi1.id, date=today - timedelta(days=8), description="埼玉→千葉 食品 冷蔵車", amount=95000),
        PartnerInvoiceItem(partner_invoice_id=pi1.id, date=today - timedelta(days=6), description="東京→静岡 部品 10t車", amount=100000),
    ])

    pi2 = PartnerInvoice(
        partner_id=partners[1].id, invoice_number="YK-2026-03", invoice_date=today - timedelta(days=2),
        due_date=today + timedelta(days=28), total_amount=150000, tax_amount=15000,
        status="未確認", period_start=today - timedelta(days=30), period_end=today - timedelta(days=2),
        notes="2月分")
    db.add(pi2)
    db.flush()
    db.add_all([
        PartnerInvoiceItem(partner_invoice_id=pi2.id, date=today - timedelta(days=15), description="川崎→横浜 建材 平ボディ", amount=75000),
        PartnerInvoiceItem(partner_invoice_id=pi2.id, date=today - timedelta(days=12), description="川崎→大田区 家電 バン", amount=75000),
    ])

    # 輸送依頼書
    db.add_all([
        TransportRequest(
            request_number="TR-0001", partner_id=partners[0].id, shipment_id=shipments[2].id,
            request_date=today, pickup_date=today + timedelta(days=1), pickup_time="08:00",
            delivery_date=today + timedelta(days=1), delivery_time="15:00",
            pickup_address="東京都江東区有明", pickup_contact="山本建設 山本社長 03-2345-6789",
            delivery_address="茨城県つくば市", delivery_contact="現場事務所 090-1111-2222",
            cargo_description="建材（鉄骨・合板）", cargo_weight=5000, cargo_quantity="鉄骨10本、合板50枚",
            vehicle_type_required="平ボディ", freight_amount=75000,
            special_instructions="荷下ろしにクレーン必要。現場到着後に電話連絡のこと。",
            status="送付済"),
        TransportRequest(
            request_number="TR-0002", partner_id=partners[2].id,
            request_date=today, pickup_date=today + timedelta(days=2), pickup_time="06:00",
            delivery_date=today + timedelta(days=2), delivery_time="14:00",
            pickup_address="神奈川県横浜市鶴見区", pickup_contact="東海配送 伊藤店長 045-123-4567",
            delivery_address="静岡県沼津市", delivery_contact="富士工場 055-111-2222",
            cargo_description="自動車部品", cargo_weight=7000, cargo_quantity="20パレット",
            vehicle_type_required="ウイング車", freight_amount=120000,
            special_instructions="パレット回収あり（空パレット15枚）。温度管理不要。",
            status="下書き"),
    ])

    # 車番連絡票
    db.add_all([
        VehicleNotification(
            dispatch_id=dispatches_data[0].id, notification_date=today - timedelta(days=1),
            arrival_date=today, arrival_time="06:00",
            vehicle_number="品川 100 あ 1234", vehicle_type="ウイング車 10t",
            driver_name="田中 太郎", driver_phone="090-1234-5678",
            cargo_description="家電製品", quantity="パレット8枚",
            destination_name="横浜倉庫", destination_address="神奈川県横浜市港北区",
            destination_contact="倉庫管理 鈴木様 045-XXX-XXXX",
            sender_name="ABC物流", special_notes="リフト使用可。バースNo.3に付け。",
            status="送付済"),
        VehicleNotification(
            dispatch_id=dispatches_data[1].id, notification_date=today,
            arrival_date=today, arrival_time="08:00",
            vehicle_number="大宮 400 え 3456", vehicle_type="トレーラー 20t",
            driver_name="鈴木 一郎", driver_phone="090-2345-6789",
            cargo_description="食品(冷蔵)", quantity="パレット15枚",
            destination_name="千葉物流センター", destination_address="千葉県千葉市美浜区",
            destination_contact="入荷担当 佐藤様 043-XXX-XXXX",
            sender_name="XYZ商事", special_notes="冷蔵車。庫内温度5℃以下維持。検品あり。",
            status="未送付"),
    ])

    # 取引先（燃料店・ETC会社等）
    vendor_list = [
        Vendor(name="出光興産 大田SS", vendor_type="燃料", address="東京都大田区蒲田5-1-1",
               phone="03-5555-8001", contact_person="給油担当", billing_cycle="月末締め翌月末払い",
               account_number="OTA-001234"),
        Vendor(name="ENEOS 品川SS", vendor_type="燃料", address="東京都品川区南品川3-2-1",
               phone="03-5555-8002", contact_person="店長 渡辺", billing_cycle="月末締め翌月末払い",
               account_number="SGW-005678"),
        Vendor(name="ETCコーポレート（NEXCO東日本）", vendor_type="ETC", address="東京都千代田区神田1-1-1",
               phone="0570-024-024", contact_person="法人窓口", billing_cycle="月末締め翌月20日払い",
               account_number="ETC-9900123"),
        Vendor(name="山田自動車整備", vendor_type="整備", address="東京都大田区池上6-1-1",
               phone="03-5555-8003", contact_person="山田工場長", billing_cycle="都度払い"),
        Vendor(name="ブリヂストン タイヤ館蒲田", vendor_type="タイヤ", address="東京都大田区西蒲田7-1-1",
               phone="03-5555-8004", contact_person="タイヤ担当", billing_cycle="月末締め翌月末払い"),
    ]
    db.add_all(vendor_list)
    db.flush()

    # 勤怠データ（過去2週間分、運送業日報項目付き）
    weather_list = ["晴", "曇", "晴", "雨", "晴", "曇", "晴", "晴", "曇", "晴"]
    routes_list = [
        "大田区→横浜港北区（第三京浜）",
        "大宮→千葉美浜（外環→京葉道路）",
        "江東区→つくば（常磐道）",
        "品川→浜松（東名高速）",
    ]
    for d_offset in range(1, 15):
        d = today - timedelta(days=d_offset)
        if d.weekday() >= 5:  # 土日スキップ
            continue
        for drv_idx in range(4):  # 4人分
            clock_in = ["06:00", "07:00", "06:30", "08:00"][drv_idx]
            clock_out = ["17:00", "18:00", "16:30", "19:00"][drv_idx]
            dep_time = ["05:45", "06:45", "06:15", "07:45"][drv_idx]
            ret_time = ["17:15", "18:15", "16:45", "19:15"][drv_idx]
            pre_check = ["05:30", "06:30", "06:00", "07:30"][drv_idx]
            post_check = ["17:20", "18:20", "16:50", "19:20"][drv_idx]
            # 勤務時間計算
            sh, sm = map(int, clock_in.split(':'))
            eh, em = map(int, clock_out.split(':'))
            work_mins = (eh * 60 + em) - (sh * 60 + sm) - 60
            overtime = max(0, work_mins - 480)
            late_night = 0
            if eh >= 22 or sh < 5:
                late_night = 30
            db.add(Attendance(
                driver_id=drivers[drv_idx].id,
                vehicle_id=vehicles[drv_idx].id,
                date=d,
                clock_in=clock_in, clock_out=clock_out,
                departure_time=dep_time, return_time=ret_time,
                break_minutes=60, break_location=["海老名SA", "三芳PA", "守谷SA", "足柄SA"][drv_idx],
                work_type="通常",
                overtime_minutes=overtime, late_night_minutes=late_night,
                distance_km=[245, 180, 120, 300][drv_idx],
                allowance=[1000, 1000, 500, 1500][drv_idx],
                waiting_time=[15, 10, 30, 20][drv_idx],
                loading_time=[30, 45, 20, 50][drv_idx],
                unloading_time=[20, 30, 15, 35][drv_idx],
                pre_check_time=pre_check, post_check_time=post_check,
                alcohol_check="異常なし",
                routes=routes_list[drv_idx],
                fuel_liters=[42, 35, 18, 55][drv_idx],
                fuel_cost=[5880, 4900, 2520, 7700][drv_idx],
                highway_cost=[2100, 1800, 1500, 4200][drv_idx],
                highway_sections=["第三京浜", "外環+京葉道路", "常磐道", "東名高速"][drv_idx],
                weather=weather_list[d_offset % len(weather_list)],
                incidents="" if d_offset != 5 or drv_idx != 0 else "左ミラー接触（軽微）",
            ))

    # 車両固定費
    vehicle_costs = [
        VehicleCost(vehicle_id=vehicles[0].id, cost_type="リース料", amount=180000, frequency="月額", notes="ウイング車リース"),
        VehicleCost(vehicle_id=vehicles[0].id, cost_type="任意保険", amount=360000, frequency="年額", notes="対人対物無制限"),
        VehicleCost(vehicle_id=vehicles[0].id, cost_type="自賠責保険", amount=30000, frequency="年額"),
        VehicleCost(vehicle_id=vehicles[1].id, cost_type="リース料", amount=200000, frequency="月額", notes="冷蔵車リース（冷凍機含む）"),
        VehicleCost(vehicle_id=vehicles[1].id, cost_type="任意保険", amount=380000, frequency="年額"),
        VehicleCost(vehicle_id=vehicles[2].id, cost_type="ローン", amount=120000, frequency="月額", notes="残り24回"),
        VehicleCost(vehicle_id=vehicles[2].id, cost_type="任意保険", amount=300000, frequency="年額"),
        VehicleCost(vehicle_id=vehicles[3].id, cost_type="リース料", amount=250000, frequency="月額", notes="トレーラーリース"),
        VehicleCost(vehicle_id=vehicles[3].id, cost_type="任意保険", amount=420000, frequency="年額"),
        VehicleCost(vehicle_id=vehicles[4].id, cost_type="任意保険", amount=360000, frequency="年額"),
        VehicleCost(vehicle_id=vehicles[5].id, cost_type="リース料", amount=100000, frequency="月額", notes="バンリース"),
        VehicleCost(vehicle_id=vehicles[5].id, cost_type="任意保険", amount=280000, frequency="年額"),
    ]
    db.add_all(vehicle_costs)

    # 会計データ
    # 収入（完了案件から、車両紐付き）
    completed_vehicle_map = {0: vehicles[0].id, 1: vehicles[3].id}  # shipment index → vehicle_id
    for idx, s in enumerate(shipments):
        if s.status == "完了":
            v_id = completed_vehicle_map.get(idx)
            db.add(AccountEntry(
                date=s.delivery_date, entry_type="収入", category="運賃収入",
                description=f"{s.client_name}: {s.pickup_address} → {s.delivery_address}",
                amount=s.price, related_shipment_id=s.id,
                vehicle_id=v_id))

    # 支出（一括請求方式：燃料費・高速代は取引先から月一括請求、車両紐付けなし）
    expenses = [
        # 燃料費：出光興産から一括請求（月末締め）
        (today - timedelta(days=1), "燃料費", "出光興産 大田SS 2月分燃料費一括", 184800, None),
        # 高速代：ETC法人カードから一括請求
        (today - timedelta(days=2), "高速代(ETC)", "ETCコーポレート 2月分高速代一括", 89600, None),
        # 個別経費
        (today - timedelta(days=5), "タイヤ代", "ブリヂストン タイヤ館蒲田 千葉500お7890 タイヤ交換4本", 120000, vehicles[4].id),
        (today - timedelta(days=7), "保険料", "車両保険 月額分", 85000, None),
        (today - timedelta(days=7), "リース料", "大宮400え3456 月額リース", 250000, vehicles[3].id),
        (today - timedelta(days=10), "協力会社支払", "丸一運送 2月分", 280000, None),
        (today - timedelta(days=10), "給与・手当", "ドライバー手当 3月前半", 180000, None),
        (today - timedelta(days=12), "事務所経費", "事務所家賃 3月分", 150000, None),
        (today - timedelta(days=2), "駐車場代", "月極駐車場 3月分", 50000, None),
        # 整備費：山田自動車整備から請求
        (today - timedelta(days=8), "修理・整備費", "山田自動車整備 品川100あ1234 オイル交換・点検", 35000, vehicles[0].id),
    ]
    for d, cat, desc, amt, v_id in expenses:
        db.add(AccountEntry(date=d, entry_type="支出", category=cat, description=desc, amount=amt, vehicle_id=v_id))

    db.commit()
    db.close()
    print("テストデータ投入完了!")


if __name__ == "__main__":
    seed()
