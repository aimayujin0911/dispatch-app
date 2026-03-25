# 配車アプリ（ハコプロFor）開発ルール

## Core / テナント分離ルール

このプロジェクトは**マルチテナント構成**で、Coreコードとテナント固有コードを明確に分離する。

### ディレクトリ構成
```
core/                    # 全テナント共通コード（編集時は影響範囲に注意）
├── static/js/app.js     # メインフロントエンド
├── static/css/style.css  # 共通スタイル
├── templates/            # HTMLテンプレート
├── models.py             # DBモデル
├── routers/              # APIエンドポイント
└── main.py               # アプリエントリーポイント

tenants/                 # テナント固有コード（他テナントに影響なし）
├── _base/config.yaml    # ベーステンプレート
└── transia/             # トランシアテナント
    ├── config.yaml      # テナント設定
    ├── dispatch.db      # テナントDB
    └── static/          # テナント固有静的ファイル
        ├── js/transia-matrix.js
        └── css/transia-matrix.css
```

### 絶対遵守事項

1. **Core内にテナント固有のハードコードを入れない**
   - `if (tenant_id === 'transia')` のような分岐をcore内に書かない
   - テナント固有の機能はフックパターンで実装する

2. **テナント固有の変更はテナントディレクトリ内で行う**
   - `tenants/transia/static/` 配下のファイルのみ編集
   - CSSクラスは `.transia-` プレフィックスを使用

3. **フックパターン**（core側で定義、テナント側で実装）
   - `window._tenantDispatchButtons()` — ガントビューに追加ボタンを返す
   - `window._tenantMatrixControls()` — マトリクスコントロール部にUIを追加
   - `window._tenantFilterVehicles(vehicles)` — 車両リストをフィルタ

4. **Coreを編集する場合**
   - 指示のあった箇所以外に編集が入らないよう注意
   - テナント固有の変更がcoreに混入していないか確認
   - 既存のフックポイントで対応できないか先に検討

5. **テンプレートでのテナントJS/CSS読み込み**
   - `index.html` で `{% if tenant_id == 'transia' %}` で条件読み込み
   - テナントJSは `app.js` の後、`tenant-switcher.js` の前に読み込む

### このファイルの参照
**今後のセッションで最初に必ずこのファイルを参照すること。**
Core/テナント分離のルールを確認してから作業を開始する。
