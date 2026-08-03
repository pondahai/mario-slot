# 專案慣例

## Git 身分

這個 repo 的 commit 一律用：

```
pondahai <dahai.pon@gmail.com>
```

新的工作環境（每次 session 會重新 clone）請先設定，再開始 commit：

```
git config user.name "pondahai"
git config user.email "dahai.pon@gmail.com"
```

## 專案性質

純靜態網頁，沒有建置步驟、沒有相依套件。`index.html` 直接用瀏覽器打開就能跑。

`assets/*.png` 是由 `tools/slice_assets.py` 從原圖 `34d80fa1-*.jpg` 切出來的，
**不要手改**；要調整切圖範圍請改腳本再重跑：

```
python3 tools/slice_assets.py
```

其餘說明見 README.md。
