MHTalk 0.9.1 — ابدأ من هنا

هذه حزمة المصدر الكاملة للإصدار 0.9.1 داخل مسار العمل الثابت C:\Dev\MHTalk. رقم الإصدار مأخوذ من manifests ولا يدخل في اسم مجلد المشروع.

للاختبار المحلي شغّل:
TEST_CURRENT_VERSION.cmd

للبناء الكامل والتوقيع ونشر Cloudflare Worker ورفع GitHub Release انقر مرتين على:
BUILD_AND_UPLOAD_GITHUB.cmd

أو شغّل أمراً واحداً من PowerShell:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\BUILD_AND_PUBLISH.ps1

اسم السكربت والمجلد ثابتان لكل الإصدارات. يقرأ السكربت رقم النسخة تلقائياً من package.json ويبني وينشر الإصدار من C:\Dev\MHTalk من دون إعادة تسمية المجلد.

السكربت ينفذ تلقائياً:
- التحقق من تطابق رقم النسخة الحالية في npm وCargo وTauri والتطبيق والـWorker وتطبيق الصوت.
- تثبيت الاعتماديات المقفلة من registry.npmjs.org.
- تشغيل npm run verify وTypeScript واختبارات RTC والترجمة والأمن.
- بناء MHTalkVoice sidecar ثم فحص Rust.
- تنزيل مفتاح updater المشفر وفكّه مؤقتاً بعد إدخال Recovery password.
- بناء وتوقيع NSIS Installer وملف updater signature.
- إنشاء latest.json.
- إنشاء GitHub Draft ورفع Installer وملف .sig وlatest.json والتحقق منها.
- نشر Cloudflare Worker 0.9.1 والتحقق من نسخته.
- نشر GitHub Release v0.9.1 كـLatest فقط بعد نجاح جميع الخطوات السابقة.

المتطلبات:
- Windows مع Node.js/npm وRust MSVC وGitHub CLI وGit for Windows/OpenSSL.
- gh auth status يجب أن يكون مسجلاً بحساب يملك صلاحية mhlko-tech/MhlkoTalk وMhlko-tech/MHTalk-Recovery.
- Wrangler يجب أن يكون مسجلاً بحساب Cloudflare الصحيح.
- Recovery password الخاص بمفتاح updater.
- اتصال إنترنت مستقر.

مهم: لا تغلق PowerShell أثناء البناء، ولا تنشر Worker أو GitHub Release يدوياً بالتوازي مع السكربت.

تفاصيل التغييرات:
CHANGELOG_0.9.1_AR.md

نص GitHub Release:
GITHUB_RELEASE_DESCRIPTION_0.9.1.md
