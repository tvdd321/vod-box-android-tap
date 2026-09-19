# 影视盒子 · Android 版

多采集源影视聚合应用（量子 / 红牛 / 非凡 / 天空）的 **Android 客户端**。App 内嵌
[nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile) 的 `libnode`，以 WebView 加载
`http://127.0.0.1:3000/`，服务端逻辑与前端页面完全复用 Node 版（见 `node-server/`），无需额外
云服务器与域名，无需 root，断网也能看（前提：采集源本身可达）。

> 仅供个人学习与功能演示，请遵守相关法律法规，不传播侵权内容。

## 仓库结构

```
vod-android/
├── app/
│   ├── CMakeLists.txt              # 编译 native-lib，链接 libnode
│   ├── libnode/                    # 由 fetch-libnode.sh 填充（bin/ + include/，已 gitignore）
│   └── src/main/
│       ├── assets/nodejs-project/  # 由 prepare-node-project.sh 生成，随 APK 打包（已 gitignore）
│       ├── cpp/native-lib.cpp      # JNI：将 stdout/stderr 转发 logcat 并调用 node::Start
│       ├── java/com/vodbox/app/MainActivity.java  # 启动 node + WebView 加载 3000 端口
│       └── res/                    # 图标与名称（影视盒子）
├── node-server/                    # Node 版后端源码副本（服务端逻辑的修改都改这里）
├── scripts/
│   ├── fetch-libnode.sh            # 下载 nodejs-mobile 的 libnode.so 与头文件
│   └── prepare-node-project.sh     # 由 node-server/ 生成 assets/nodejs-project
├── .github/workflows/build-apk.yml # push 后自动构建签名、发布 Release、同步 update.json
└── settings.gradle / build.gradle
```

## 如何构建

两种方式：**GitHub Actions（推荐，无需本机 Android 环境）** 或本机 Gradle。

### 方式一：GitHub Actions（自动）

1. 把 `vod-android` 目录作为一个 Git 仓库推到 GitHub（可单独建仓库）；
2. 仓库页面 → Actions → `build-apk` 工作流会自动在 push 后运行；
3. 构建成功后，在仓库 Releases 页面（或 Actions 运行记录页底部 Artifacts）下载 APK：
   - `app-arm64-v8a-release.apk`：主流手机
   - `app-armeabi-v7a-release.apk`：老机型
4. 安装到 Android 设备。

后续只要修改 `node-server/` 下的服务端或页面代码并 push，就会自动重新构建新 APK。

## 如何发一个新版本（一键发版）

构建成功后 CI 会**自动**发布 GitHub Release（v`versionName`）并把 `update.json`
推送到 tvdd321.github.io 仓库，App 启动时检测到新版本即可弹窗一键升级。只需两步：

1. 修改 `app/build.gradle` 的版本号：

   ```gradle
   versionCode 3        // 必须比上一版大，否则 App 收不到升级提示
   versionName "1.2"    // 与 update.json 保持一致，作为 Release tag（v1.2）
   ```

2. 提交并把升级说明写在 commit message 里，然后 push：

   ```bash
   git add -A
   git commit -m "新增 XX 功能，修复 YY 问题"   # 这段文字会成为升级弹窗里的更新说明
   git push origin main
   ```

CI 会自动完成后续所有事：签名构建 → 发布 `v1.2` Release → 读取最新 commit
message 生成 update.json 并推送到 `tvdd321/tvdd321.github.io`。

### 发版注意事项

- `versionCode` 必须**单调递增**：等于或小于已装版本的 versionCode 时不会弹升级提示；
- 首次从旧版（随机 debug 签名）升级到新签名版本需**先卸载旧版**再安装，此后可正常覆盖升级；
- 同一版本重复构建时 update.json 内容不变，CI 会跳过推送，不会产生冗余提交；
- CI 仓库需配置 secrets：`VODBOX_KEYSTORE_B64`、`VODBOX_KEYSTORE_PASS`（签名）与
  `VOD_PAGES_TOKEN`（推送 tvdd321.github.io 的 token，未配置则跳过 update.json 同步）。

### 方式二：本机手动构建

前置条件：
- Node.js 18+（npm 用于给 `node-server` 安装运行时依赖）
- JDK 17
- Android SDK（platform 34、build-tools 34.0.0、NDK 25.2.9519653、cmake 3.22.1）
- Gradle 8.9

按顺序执行：

```bash
# 1. 下载 nodejs-mobile 预编译动态库（bin/ 与 include/ 写入 app/libnode/）
bash scripts/fetch-libnode.sh

# 2. 从 node-server/ 生成内嵌后端（express、hls.js 会装进 assets/nodejs-project/node_modules）
bash scripts/prepare-node-project.sh

# 3. 构建 release APK
gradle assembleRelease --no-daemon
```

产物在 `app/build/outputs/apk/release/`。

## 运行机制

1. `MainActivity` 启动后先把 APK 内的 `assets/nodejs-project` 释放到 `filesDir`；
2. 后台线程调用 `node::Start` 启动 `server.js`，监听 `127.0.0.1:3000`；
3. 轮询 `GET /api/sources` 确认服务就绪后，WebView 加载 `http://127.0.0.1:3000/`；
4. `server.js` 通过 `/hls.js` 路由把 `node_modules/hls.js/dist` 暴露给页面，实现手机端 HLS 播放；
5. 播放页仍走系统浏览器 `ACTION_VIEW`（点"手机播放"链接时），其余导航全部留在 WebView 内。

## 常见调整

- **服务端逻辑 / 页面 / 播放器**：改 `node-server/server.js`、`node-server/public/*`，重新构建；
- **采集源 / 访问密码**：改 `node-server/config.json`（新设备首次安装生效；已装设备需卸载重装或
  手动更新 `filesDir/nodejs-project/config.json`），配置模板见 `node-server/config.example.json`；
- **Node 运行时版本**：改 `scripts/fetch-libnode.sh` 的默认版本参数后重新拉取 `libnode`；
- **包名 / 应用名**：`app/build.gradle` 的 `applicationId` / `res/values/strings.xml`。

## 关于 libnode 的说明

`libnode.so` 来自 nodejs-mobile 官方 Release（默认 `v18.20.4`），仅内嵌运行时代码，不包含 Node
的可执行文件；脚本已按 abi（arm64-v8a、armeabi-v7a）拆分为 `jniLibs`，APK 大小约为
libnode + express + hls.js + 页面的体积。
