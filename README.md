# سيرفر اللعبة الجماعية — C++

هذه نسخة C++17 بديلة لملف `server.py` الموجود في الأرشيف المرسل. تستخدم Boost.Beast / Boost.Asio لاتصالات WebSocket ومكتبة nlohmann/json لمعالجة الرسائل. لا تحتاج Python لتشغيلها أو بنائها.

## التوافق مع المشروع الحالي

حافظت النسخة على بروتوكول السيرفر الأصلي:

1. يُسجَّل اللاعب بعد نجاح اتصال WebSocket ويحصل على `player_id` من نوع نص.
2. يرسل العميل كائن JSON بأي حقول يحتاجها، مثل الانضمام أو الحركة أو البطاقات.
3. يضع السيرفر معرّف المرسل في `player_id`، مستبدلًا أي معرّف أرسله العميل.
4. يُرسَل الكائن إلى جميع اللاعبين الآخرين، ولا يعود إلى المرسل.
5. عند قطع الاتصال، يتلقى الآخرون:

```json
{"action":"disconnect","player_id":"1"}
```

مثلًا، عند إرسال:

```json
{"action":"move","x":100,"y":200}
```

يستقبل اللاعبون الآخرون:

```json
{"action":"move","x":100,"y":200,"player_id":"1"}
```

القيمة `1` مثال فقط. المعرفات متسلسلة وفريدة خلال تشغيل العملية، وتتغير عند إعادة الاتصال. ليست حسابات دائمة، وتبدأ من جديد عند إعادة تشغيل السيرفر. ترتيب مفاتيح JSON والمسافات قد يختلفان عن Python؛ عميل Godot الذي يفك JSON إلى قاموس يستمر في التعامل معها بالطريقة نفسها.

لا توجد رسالة ترحيب أو إشارة انضمام تلقائية جديدة: العميل يرسل حدث الانضمام كما كان يفعل سابقًا. تدعم النسخة كائنات JSON في الرسائل النصية وكذلك رسائل binary التي تحتوي JSON بترميز UTF-8، وتبث النتائج كرسائل نصية.

## الملفات

| الملف | الغرض |
|---|---|
| `server.cpp` | السيرفر الكامل |
| `CMakeLists.txt` | بناء C++ على Linux أو Windows |
| `Dockerfile` | بناء وتشغيل السيرفر على Render أو Docker محليًا |
| `render.yaml` | إعداد Blueprint اختياري لـRender |
| `tests/integration.mjs` | اختبارات اتصال فعلية باستخدام Node.js 22 أو أحدث |
| `VERIFICATION.md` | نتائج التحقق وحدوده |

## النشر على Render

1. فك الضغط وارفع **محتويات مجلد المشروع** إلى مستودع GitHub؛ يجب أن يكون `Dockerfile` بجانب `server.cpp` في جذر المستودع. لا يلزم رفع ملف ZIP نفسه أو `server.py` أو `requirements.txt` لتشغيل هذه النسخة.
2. أنشئ **Web Service** في Render واربطها بالمستودع.
3. اختر **Language / Runtime: Docker** واختر خطة الاستضافة المناسبة من لوحة Render.
4. إذا كانت الملفات في جذر المستودع، استخدم `./Dockerfile`، واترك Docker Command فارغًا ليستخدم أمر التشغيل الموجود في الملف. لا تستخدم `python server.py` لهذه الخدمة.
5. اضبط **Health Check Path** إلى `/health`.
6. بعد اكتمال النشر، ضع رابط الخدمة في سكربت Godot:

```gdscript
var error = websocket.connect_to_url("wss://YOUR-SERVICE.onrender.com")
```

استخدم اسم متغير `WebSocketPeer` الموجود عندك بدل `websocket`. إذا أنشأت خدمة جديدة، حدّث رابط السيرفر في Godot. لا يلزم تغيير حقول الرسائل أو إشارات الاستقبال بسبب هذا التحويل. لم يتضمن الأرشيف ملفات Godot، لذلك جرى اختبار البروتوكول باستخدام عملاء WebSocket بدل تشغيل اللعبة نفسها.

يمكن بدل الإعداد اليدوي استخدام **New → Blueprint** مع `render.yaml`. راجع إعدادات الخدمة والخطة في Render قبل إنشائها. ملف الإعداد يستهدف نسخة سيرفر واحدة؛ بيانات اللاعبين محفوظة في ذاكرة هذه العملية.

Render يتولى شهادة TLS للعنوان العام `wss://`، ويوجّه الاتصال إلى السيرفر الداخلي. لا تحتاج إلى إضافة شهادة داخل C++ لهذا النشر. يستمع السيرفر على `0.0.0.0` والمنفذ المحدد في `PORT`؛ وإذا لم يوجد المتغير يستخدم `8080`.

## التشغيل محليًا بواسطة Docker

من مجلد المشروع:

```sh
docker build -t multiplayer-server-cpp .
docker run --rm -p 8080:8080 multiplayer-server-cpp
```

رابط Godot المحلي:

```text
ws://127.0.0.1:8080
```

فحص الصحة:

```text
http://127.0.0.1:8080/health
```

## البناء المباشر على Linux

على Debian / Ubuntu، ثبّت المتطلبات ثم ابنِ المشروع:

```sh
sudo apt-get update
sudo apt-get install -y g++ cmake make libboost-dev nlohmann-json3-dev
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel 1
./build/multiplayer_server
```

لتغيير المنفذ:

```sh
PORT=9000 ./build/multiplayer_server
```

## البناء المباشر على Windows

تحتاج إلى مترجم C++17 وCMake ومكتبتَي Boost وnlohmann-json. مثال باستخدام Visual Studio C++ ونسخة vcpkg مثبتة مسبقًا:

```powershell
C:\vcpkg\vcpkg.exe install boost-beast:x64-windows nlohmann-json:x64-windows
cmake -S . -B build -DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake
cmake --build build --config Release
.\build\Release\multiplayer_server.exe
```

عدّل مسار vcpkg إلى مكانه عندك. لتغيير المنفذ في PowerShell قبل التشغيل:

```powershell
$env:PORT = "9000"
.\build\Release\multiplayer_server.exe
```

## الاختبارات

يحتاج الاختبار فقط إلى Node.js 22 أو أحدث بالإضافة إلى السيرفر المبني؛ لا يحتاج حزم npm. يبدأ عملية سيرفر محلية على منفذ متاح، ويغلقها عند الانتهاء.

```sh
node tests/integration.mjs ./build/multiplayer_server
```

على Windows مع Visual Studio:

```powershell
node tests/integration.mjs .\build\Release\multiplayer_server.exe
```

إذا وجد CMake برنامج `node` وقت الإعداد، يسجّل الاختبار أيضًا مع CTest:

```sh
ctest --test-dir build --output-on-failure -C Release
```

## معالجة الاتصال وحدود النسخة

- تتجاهل النسخة JSON التالف أو القيم التي ليست كائنات، وتُبقي اتصال اللاعب مفتوحًا. هذه معالجة إضافية مقارنة بملف Python الأصلي.
- أقصى حجم للرسالة الواردة هو 1 MiB. الرسالة الأكبر تغلق اتصال مرسلها برمز WebSocket `1009`، ثم يُبلَّغ الآخرون بخروجه.
- لكل لاعب طابور إرسال مستقل لمنع تداخل عمليات الكتابة. يُقطع اتصال العميل البطيء إذا تجاوزت بيانات إرساله المعلقة 4 MiB.
- توجد مهلة للاتصال ورسائل WebSocket ping لاكتشاف الاتصالات التي لا تستجيب. يظل على عميل Godot استدعاء `poll()` ومعالجة إعادة الاتصال كما في نظامه الحالي.
- جميع العمليات تعمل على حلقة أحداث واحدة. لا تضف استدعاءات `io_context::run()` من خيوط إضافية دون إضافة مزامنة مناسبة.
- يبقى المشروع مرحّل رسائل لمجموعة واحدة مثل الأصل: لا توجد غرف منفصلة، أو حفظ لحالة المباراة، أو تحقق من قوانين اللعبة، أو مزامنة بين عدة نسخ سيرفر. لا يُعيد تشغيل السيرفر حالة المباراة السابقة.

## المراجع الرسمية

- [Boost.Beast WebSocket](https://www.boost.org/doc/libs/1_74_0/libs/beast/doc/html/beast/using_websocket.html)
- [nlohmann/json](https://github.com/nlohmann/json)
- [Docker on Render](https://render.com/docs/docker)
- [WebSockets on Render](https://render.com/docs/websocket)
- [Render port binding](https://render.com/docs/web-services#port-binding)
