# WhatsApp Channel Auto Forward Bot

بوت Node.js يراقب IDs لقنوات/جروبات واتساب محددة، وينسخ النص والصورة والفيديو والصوت والملفات إلى وجهة تحددها أنت.

> **تنبيه مهم:** البوت يستخدم مكتبة غير رسمية للاتصال بواتساب، وليس WhatsApp Business Cloud API. قد يتوقف مع أي تحديث من واتساب، وقد يعرّض الحساب للتقييد. الأفضل تجربته على رقم ثانٍ، ولا تعِد نشر محتوى لا تملك حق استخدامه.

## تشغيله من تابلت أندرويد باستخدام Termux

### 1. تثبيت Termux

نزّل Termux من [F-Droid](https://f-droid.org/packages/com.termux/) أو من صفحة الإصدارات الرسمية في GitHub. نسخة Play Store القديمة غالبًا لا تعمل جيدًا.

افتح Termux ونفّذ الأوامر التالية واحدًا واحدًا:

```bash
pkg update -y && pkg upgrade -y
pkg install -y nodejs-lts git nano tmux
termux-setup-storage
```

اضغط **Allow** عندما يطلب Termux صلاحية الملفات.

### 2. تنزيل المشروع

هذه الجلسة تعمل على فرع المشروع التالي، لذلك استخدم الأمر كما هو:

```bash
git clone -b arena/01a01ada-whatsapp-channel https://github.com/samahadel721/Whatsapp_channel.git
cd Whatsapp_channel
npm install
cp .env.example .env
nano .env
```

في `nano`:

- احفظ: `Ctrl + O` ثم `Enter`
- اخرج: `Ctrl + X`

### 3. أول تشغيل: الحصول على IDs

في أول مرة اترك هذه القيم في `.env`:

```env
PHONE_NUMBER=2015xxxxxxxxx
USE_PAIRING_CODE=true
TARGET_CHANNEL=
MONITORED_CHANNELS=
DISCOVERY_MODE=true
SAVE_DOWNLOADS=true
```

استبدل `2015xxxxxxxxx` برقمك بصيغة دولية، بدون `+` أو مسافات أو شرطات. مثال: الرقم المصري الذي يبدأ بـ `015` يتحول إلى `20` ثم الرقم بدون الصفر الأول.

شغّل البوت:

```bash
npm start
```

سيظهر في Termux **كود ربط**. في تطبيق واتساب افتح:

**الإعدادات > الأجهزة المرتبطة > ربط جهاز > الربط برقم الهاتف**

ثم اكتب الكود الظاهر في Termux. لا ترسل كود الربط أو مجلد `auth_info` لأي شخص.

بعد نجاح الربط، افتح/تابع القنوات المطلوبة، واكتب رسالة اختبار في القناة التي تملكها إن أمكن. عندما يتعرف البوت على قناة سيطبع شيئًا مثل:

```text
🆔 تم العثور على قناة واتساب رسمية (message):
   1203xxxxxxxxxxxx@newsletter
```

انسخ الـ ID كاملًا. القناة الرسمية غالبًا تنتهي بـ `@newsletter`، أما `@g.us` فعادةً يكون جروبًا وليس قناة رسمية.

> **مهم:** واتساب لا يرسل للبوت حدثًا صريحًا اسمه "تم فتح القناة". لذلك فتح القناة وحده قد لا يطبع ID فورًا؛ البوت يطبعه عندما تصل مزامنة/إشعار قراءة/رسالة من واتساب.
>
> **بديل أسهل:** بعد ربط الحساب، يمكنك وضع رابط القناة العام أو رابط دعوة الجروب نفسه داخل `TARGET_CHANNEL` أو `MONITORED_CHANNELS`، مثل `https://whatsapp.com/channel/0029...` أو `https://chat.whatsapp.com/...`. البوت سيحاول تحويل الرابط إلى ID تلقائيًا. يجب أن يكون الرابط قابلًا للفتح من الحساب المرتبط.

### 4. تفعيل إعادة النشر

أوقف البوت بـ `Ctrl + C` ثم افتح الملف:

```bash
nano .env
```

ضع الـ ID الخاص بوجهة النشر في `TARGET_CHANNEL`، وضع IDs القنوات التي تريد مراقبتها في `MONITORED_CHANNELS` مفصولة بفاصلة. مثال شكلي فقط:

```env
PHONE_NUMBER=2015xxxxxxxxx
USE_PAIRING_CODE=true
TARGET_CHANNEL=1203xxxxxxxxxxxx@newsletter
MONITORED_CHANNELS=1203aaaaaaaaaaaa@newsletter,1203bbbbbbbbbbbb@newsletter
DISCOVERY_MODE=false
SAVE_DOWNLOADS=true
```

ثم شغّل:

```bash
npm start
```

سيتم تجاهل الرسائل القديمة عادةً، ويُعاد إرسال الرسائل الجديدة فقط. إذا كانت القناة المستهدفة قناة واتساب رسمية، يجب أن يكون الحساب المرتبط لديه صلاحية النشر فيها؛ وإلا قد يفشل الإرسال.

## تشغيله مع قفل شاشة التابلت

اترك Termux يعمل وأبقِ التابلت على الشاحن عند الإمكان:

```bash
termux-wake-lock
tmux new -s whatsapp
npm start
```

لفصل الشاشة عن الجلسة مع ترك البوت يعمل، اضغط `Ctrl + B` ثم `D`. للعودة لاحقًا:

```bash
tmux attach -t whatsapp
```

ولإيقافه من داخل الجلسة اضغط `Ctrl + C`. من إعدادات أندرويد اجعل بطارية Termux **Unrestricted / غير مقيّدة**؛ أندرويد قد يغلق أي تطبيق في الخلفية، لذلك التشغيل 24 ساعة غير مضمون على التابلت.

## تحديث المشروع

```bash
cd ~/Whatsapp_channel
git pull origin arena/01a01ada-whatsapp-channel
npm install
```

## ملفات مهمة

- `.env`: إعداداتك المحلية، ولا ترفعه إلى GitHub.
- `auth_info/`: جلسة واتساب؛ لا تشاركها.
- `downloads/`: نسخ الوسائط التي تم تنزيلها، ويمكن تعطيل حفظها بوضع `SAVE_DOWNLOADS=false`.
