MHTalk 0.9.2 — ابدأ من هنا

هذه حزمة المصدر الجاهزة للإصدار 0.9.2.

طريقة الرفع والنشر:
1) فك الضغط وضع المجلد في المسار C:\Dev\MHTalk.
2) أغلق VS Code وأي نسخة شغالة من MHTalk.
3) انقر مرتين على:
   PUBLISH_MHTALK_0.9.2.cmd
4) عند مرحلة التوقيع الصق Recovery password المحفوظ في Telegram.
5) اترك النافذة مفتوحة إلى أن تظهر كلمة SUCCESS.

السكربت ينفذ تلقائياً:
- يثبت رابط signaling الإنتاجي الصحيح داخل ملف .env المحلي.
- يحفظ main القديم على GitHub داخل archive/main-before-0.9.2.
- يرفع الفرع release-0.9.2 ويجعل النسخة الحالية هي main باستعمال force-with-lease الآمن.
- يثبت الاعتماديات المقفلة من npm الرسمي.
- يشغل جميع فحوص المشروع ويبني MHTalkVoice والبرنامج الرئيسي.
- ينزل نسخة مفتاح updater المشفرة من المستودع الخاص.
- يطلب منك Recovery password ويفك المفتاح مؤقتاً فقط.
- يبني ويوقع Windows NSIS Installer.
- ينشئ ملف التوقيع وlatest.json.
- يرفع ملفات الإصدار v0.9.2 إلى GitHub.
- ينشر Cloudflare Worker ويتحقق أن نسخته 0.9.2.
- ينشر GitHub Release كـLatest بعد نجاح كل الخطوات.

المتطلبات الموجودة مسبقاً على جهازك:
- Windows مع Node.js/npm وRust MSVC وGitHub CLI وGit for Windows.
- تسجيل GitHub CLI بالحساب mhlko-tech.
- تسجيل Wrangler بحساب Cloudflare الصحيح.
- Recovery password المحفوظ في Telegram.
- اتصال إنترنت مستقر.

لا تضع مفتاح التوقيع أو كلمة مروره داخل المشروع. يتم تنزيل النسخة المشفرة وفكها مؤقتاً أثناء البناء، ثم حذف الملفات المؤقتة.

تفاصيل الإصدار:
CHANGELOG_0.9.2_AR.md

نص GitHub Release:
GITHUB_RELEASE_DESCRIPTION_0.9.2.md
