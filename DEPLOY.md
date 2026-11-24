# העלאת הענן המאוחד לאינטרנט (24/7)

הפרויקט מוכן להעלאה חינמית/זולה ל־**Render**, **Railway**, או כל שרת **Docker** — עם מסך התחברות מאובטח בסיסמה.

## שלב 1: העתקת החשבונות שלך כ־Base64
קודם ודא שחיברת במחשב המקומי את כל חשבונות ה־Google Drive / OneDrive שתרצה (דרך `http://localhost:3456`).
אחר כך הרץ ב־PowerShell בתוך תיקיית הפרויקט:

```powershell
powershell -ExecutionPolicy Bypass -File .\export-config.ps1
```

הסקריפט מעתיק אוטומטית את ההגדרות ללוח (Clipboard) בצורה מקודדת.

> **אבטחה:** לעולם אל תעלה את `rclone.conf` ל־GitHub (הוא כבר חסום ב־`.gitignore`).

## שלב 2: העלאה ל־GitHub
צור Repository פרטי חדש ב־GitHub ודחוף אליו את התיקייה:

```powershell
git init
git add .
git commit -m "Unified Cloud"
git branch -M main
git remote add origin https://github.com/YOUR_USER/unified-cloud.git
git push -u origin main
```

## שלב 3: פריסה ב־Render (חינמי) או Railway
1. היכנס ל־[Render.com](https://render.com) → **New +** → **Web Service** (או **Blueprint** עם `render.yaml`).
2. חבר את ה־Repository שלך מ־GitHub ובחר **Docker** כ־Runtime.
3. תחת **Environment Variables** הוסף את המשתנים:
   - `CLOUD_PASSWORD` — בחר סיסמה חזקה לכניסה לאתר הענן שלך.
   - `RCLONE_CONFIG_BASE64` — הדבק את מה שהועתק בשלב 1 (כולל כל החשבונות שחיברת: Google Drive, OneDrive, Dropbox, Box, MEGA וכו').
   
   **אופציונלי (התחברות Web בלחיצה אחת מכל מכשיר ישירות בענן):**
   - Dropbox: `DROPBOX_CLIENT_ID` ו-`DROPBOX_CLIENT_SECRET` (מתוך [Dropbox App Console](https://www.dropbox.com/developers/apps)).
   - Box: `BOX_CLIENT_ID` ו-`BOX_CLIENT_SECRET` (מתוך [Box Developer Console](https://app.box.com/developers/console)).
   - Google Drive: `GOOGLE_CLIENT_ID` ו-`GOOGLE_CLIENT_SECRET`.
   - OneDrive: `ONEDRIVE_CLIENT_ID` ו-`ONEDRIVE_CLIENT_SECRET`.
4. לחץ **Deploy** — תוך ~2 דקות תקבל כתובת `https://your-cloud.onrender.com` שזמינה מכל טלפון ומחשב בעולם, 24/7!

## חיבור Dropbox ו-Box (Ember 🟡)
- **Dropbox (2GB חינם):**
  - חיבור מקומי: לחץ על **📦 Dropbox** בממשק האתר (`http://localhost:3456`) — ייפתח חלון דפדפן להתחברות מיידית. rclone משתמש באישורים מובנים ולכן אין צורך בהגדרת API Keys מקומית.
  - סנכרון לענן: הרץ `export-config.ps1` והדבק את `RCLONE_CONFIG_BASE64` ב-Render.
- **Box (10GB חינם):**
  - חיבור מקומי: לחץ על **🟦 Box** בממשק האתר — ייפתח חלון דפדפן להתחברות ישירה לחשבון Box שלך.
  - שטח נרחב: Box מעניק 10GB חינם שמתווספים ישירות לשטח האחסון הכולל של הענן המאוחד שלך (`mycloud`).

## הגדרת התחברות 1-קליק ל-OneDrive (כמו של Google!)
כדי שלחיצה על **Microsoft OneDrive** תפתח ישירות את מסך בחירת החשבונות של מיקרוסופט (בדיוק כמו גוגל, בלי פקודות טרמינל):

1. היכנס לפורטל [Microsoft Entra / Azure App Registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade).
2. לחץ על **New registration** (רישום חדש):
   - **Name:** `Unified Cloud`
   - **Supported account types:** בחר באפשרות השלישית:
     `Accounts in any organizational directory and personal Microsoft accounts (e.g. Skype, Xbox, Outlook.com)` *(חשוב מאוד! מאפשר לחבר כל חשבון אישי או ארגוני)*.
   - **Redirect URI:** בחר **Web** והזן:
     `https://unified-cloud.onrender.com/api/oauth/callback/onedrive`
3. לחץ **Register**.
4. בעמוד הראשי של האפליקציה, העתק את ה-**Application (client) ID**.
5. בתפריט הצד לחץ על **Certificates & secrets** → **New client secret** → לחץ **Add** והעתק את ה-**Value** (לא את ה-Secret ID).
6. הוסף ב-**Render** תחת **Environment**:
   - `ONEDRIVE_CLIENT_ID` = ה-Client ID שהעתקת
   - `ONEDRIVE_CLIENT_SECRET` = ערך ה-Secret שהעתקת
   *(או הזן אותם ישירות באתר תחת חלון החיבור בטאב "התחברות ב-1-קליק")*.

ברגע שזה מוגדר, לחיצה על OneDrive תפתח מיד את מסך בחירת החשבון של מיקרוסופט בדיוק כמו גוגל!

## בדיקה מקומית של מסך ההתחברות
אם תרצה לבדוק את מסך הסיסמה כבר עכשיו על המחשב שלך:
```powershell
$env:CLOUD_PASSWORD="my-secret-password"
node server.js
```
