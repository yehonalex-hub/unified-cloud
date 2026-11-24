# נבחרת הבוטים של Unified Cloud בסרגל הצד

רשימת הבוטים הפעילים באפליקציה, בדיוק כפי שהם מופיעים בסרגל הצד של OpenMausBot:

---

### 🎨 1. ממשק ואתר 1 מאוחד
* **Ziggy 🟣 (UI/UX Lead):** אחראי על עיצוב הממשק, צבעים, מובייל, נגני תצוגה מקדימה וחוויית משתמש ב-[public/index.html](file:///C:/Users/Jonah/.gemini/antigravity/scratch/unified-cloud/public/index.html).
* **Rio 🔴 (אתר 1 מאוחד - Single Unified Site):** אחראי שהכל יהיה **אתר אחד בלבד, פשוט ונקי בלי שום דברים מיותרים** – חוויית משתמש מרוכזת שבה כל הקבצים מכל העננים נגישים במקום אחד.

---

### 🚀 2. פריסה, סנכרון ל-Render ומיתוג ב-GitHub
* **Atlas 🌐 (DevOps & GitHub/Render):** אחראי לדאוג שכל הקוד יושב מסודר ומסונכרן ב-GitHub (`yehonalex-hub/unified-cloud`) ושומר על הפריסה החיה ב-Render רצה 24/7. מנהל את הסקריפט [sync-to-github.bat](file:///C:/Users/Jonah/.gemini/antigravity/scratch/unified-cloud/sync-to-github.bat).
* **Ember 🟡 (GitHub Brand & Showcase):** אחראי על המיתוג והנראות של ה-GitHub – יצר ומתחזק את דף ה-[README.md](file:///C:/Users/Jonah/.gemini/antigravity/scratch/unified-cloud/README.md) המרהיב עם באדג'ים, כפתורי פריסה, טבלאות ענן ותמונת Preview.

---

### ☁️ 3. מומחי חיבורי Google ושירותי ענן (Cloud Connectors)
* **Luna 🔵 (Google Drive Lead):** מומחית ראשית לחיבור Google Drive — Web OAuth 2.0 בלחיצה אחת, רענון טוקנים אוטומטי, וביצועי העלאה/הורדה מהירים.
* **Pixel 🟢 (Multi-Google & Shared Drives):** מומחה לחיבור חשבונות גוגל נוספים במקביל (עבודה, אישי) וחיבור כוננים משותפים (Shared Drives).
* **Atlas 🌐 (OneDrive & Microsoft 365 Lead):** מוביל אינטגרציית Microsoft Graph OAuth 2.0 לקבצי OneDrive אישיים ועסקיים (M365 / SharePoint) עם גילוי אוטומטי של drive_id ו-drive_type ב-[connectors/onedrive.js](file:///C:/Users/Jonah/.gemini/antigravity/scratch/unified-cloud/connectors/onedrive.js).
* **Skye 🔷 (MEGA & S3/Cloudflare R2 Specialist):** מומחה אחסון מוצפן ואחסון אובייקטים. אחראי על חיבור ישיר ומאובטח ל-MEGA (20GB מוצפן מקצה לקצה עם בדיקת תקינות בלייב והצפנת סיסמה ב-rclone) ושרתי S3 תואמים (Cloudflare R2 עם 10GB חינם ו-0$ Egress, AWS S3, Wasabi, MinIO) כולל תמיכה ב-Buckets ספציפיים וזיהוי ספקים חכם ב-[connectors/cloud-providers.js](file:///C:/Users/Jonah/.gemini/antigravity/scratch/unified-cloud/connectors/cloud-providers.js).
* **Turnip 🟠 (WebDAV & Other Clouds):** מומחה חיבור WebDAV, Koofr, pCloud ו-Yandex Disk.

---

### 🛡️ 4. אבטחה וכונן מקומי
* **Clover 🌸 (QA & Windows Mount):** בדיקות יציבות ואבטחה, ומנהלת את סקריפט החיבור המקומי לסייר הקבצים ב-Windows (`Z:\` דרך [mount-drive.bat](file:///C:/Users/Jonah/.gemini/antigravity/scratch/unified-cloud/mount-drive.bat)).
