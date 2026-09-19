package com.vodbox.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.ProgressDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Looper;
import android.provider.Settings;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class MainActivity extends Activity {

    private static final String NODE_URL = "http://127.0.0.1:3000/";
    private static final String UPDATE_JSON_URL = "https://tvdd321.github.io/update-tap.json";

    static {
        System.loadLibrary("native-lib");
        System.loadLibrary("node");
    }

    public static boolean _startedNodeAlready = false;

    private WebView webView;
    private FrameLayout loadingView;
    private static boolean clearedProSession = false;
    // 页面内全屏状态（由网页通过 JS 桥控制），用于返回键退出全屏
    private boolean jsFullscreen = false;
    private AudioManager audioManager = null;
    // 视频播放时保持屏幕常亮
    private boolean videoPlaying = false;
    private static final String SCREEN_KEEP_JS =
            "(function(){if(window.__vbScreenKeep)return;window.__vbScreenKeep=true;" +
            "function k(on){try{window.VodBoxScreen.setKeep(on)}catch(e){}}" +
            "document.addEventListener('play',function(e){if(e.target&&e.target.tagName==='VIDEO')k(true)},true);" +
            "document.addEventListener('playing',function(e){if(e.target&&e.target.tagName==='VIDEO')k(true)},true);" +
            "document.addEventListener('pause',function(e){if(e.target&&e.target.tagName==='VIDEO')k(false)},true);" +
            "document.addEventListener('ended',function(e){if(e.target&&e.target.tagName==='VIDEO')k(false)},true);" +
            "document.addEventListener('emptied',function(e){if(e.target&&e.target.tagName==='VIDEO')k(false)},true);" +
            "})();";

    // 更新检测相关
    private static final String UPDATE_FILE_AUTHORITY = "com.vodbox.app.tap.updatefile";

    public native Integer startNodeWithArguments(String[] arguments);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);

        webView = new WebView(this);
        loadingView = new FrameLayout(this);
        loadingView.setBackgroundColor(Color.WHITE);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.gravity = android.view.Gravity.CENTER;
        ProgressBar pb = new ProgressBar(this);
        TextView tv = new TextView(this);
        tv.setText("正在启动服务…");
        tv.setTextColor(Color.GRAY);
        tv.setPadding(0, 24, 0, 0);
        box.addView(pb);
        box.addView(tv);
        loadingView.addView(box, lp);

        root.addView(loadingView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
        webView.setVisibility(android.view.View.GONE);

        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);

        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(false);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setUseWideViewPort(true);
        if (android.os.Build.VERSION.SDK_INT >= 21) {
            ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        webView.addJavascriptInterface(new ScreenKeepBridge(), "VodBoxScreen");
        webView.addJavascriptInterface(new FullscreenBridge(), "VodBoxFullscreen");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                view.evaluateJavascript(SCREEN_KEEP_JS, null);
                // 每次进程冷启动只清一次：清除已保存的高级模式密码标记，
                // 使"每次打开 App 后进入高级模式(/aaa)都需重新输入密码"
                if (!clearedProSession) {
                    clearedProSession = true;
                    if (url != null && url.startsWith(NODE_URL)) {
                        view.evaluateJavascript(
                            "try{localStorage.removeItem('vb_pro_ok');localStorage.removeItem('vb_pro_pwd')}catch(e){}",
                            null);
                    }
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String u = request.getUrl().toString();
                if (u.startsWith(NODE_URL)) {
                    return false;
                }
                try {
                    android.content.Intent i = new android.content.Intent(
                            android.content.Intent.ACTION_VIEW, android.net.Uri.parse(u));
                    startActivity(i);
                } catch (Exception ignored) {}
                return true;
            }
        });

        // HTML5 视频全屏：统一重定向到网页的“页面内全屏”。
        // 原生全屏在小尺寸/竖屏视频上会立刻触发 onHideCustomView（表现为闪一下），
        // 因此这里直接取消原生全屏，交给网页用全屏 CSS 接管，手势也才能生效。
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                callback.onCustomViewHidden();
                webView.evaluateJavascript("(window.__vbToggleFs?window.__vbToggleFs():0)", null);
            }
        });

        if (!_startedNodeAlready) {
            _startedNodeAlready = true;
            startNodeThread();
        }
        waitForServerThenLoad();
        checkForUpdates();
    }

    // ==================== 视频播放屏幕常亮 ====================

    private class ScreenKeepBridge {
        @JavascriptInterface
        public void setKeep(final boolean on) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    videoPlaying = on;
                    applyKeepScreenOn(on);
                }
            });
        }
    }

    private void applyKeepScreenOn(boolean on) {
        if (on) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
    }

    // ==================== 页面内全屏 & 亮度/音量桥接 ====================

    private class FullscreenBridge {
        /** landscape: 1 横屏, 0 竖屏, -1 未知（保持当前方向） */
        @JavascriptInterface
        public void enter(final double landscape) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    jsFullscreen = true;
                    if (landscape == 1) {
                        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                    } else if (landscape == 0) {
                        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT);
                    }
                    applyImmersive(true);
                }
            });
        }

        @JavascriptInterface
        public void exit() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    jsFullscreen = false;
                    applyImmersive(false);
                    setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                    WindowManager.LayoutParams lp = getWindow().getAttributes();
                    lp.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
                    getWindow().setAttributes(lp);
                }
            });
        }

        @JavascriptInterface
        public double getBrightness() {
            float b = getWindow().getAttributes().screenBrightness;
            if (b >= 0) return b;
            try {
                int v = Settings.System.getInt(getContentResolver(), Settings.System.SCREEN_BRIGHTNESS);
                return v / 255.0;
            } catch (Exception e) {
                return 0.5;
            }
        }

        @JavascriptInterface
        public void setBrightness(final double v) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    WindowManager.LayoutParams lp = getWindow().getAttributes();
                    lp.screenBrightness = (float) Math.max(0.01, Math.min(1.0, v));
                    getWindow().setAttributes(lp);
                }
            });
        }

        @JavascriptInterface
        public int getVolume() {
            if (audioManager == null) return 50;
            int max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
            int cur = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC);
            return max > 0 ? Math.round(cur * 100f / max) : 0;
        }

        @JavascriptInterface
        public void setVolume(final double percent) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (audioManager == null) return;
                    int max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
                    int v = Math.round((float) Math.max(0, Math.min(100, percent)) * max / 100f);
                    try {
                        audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, v, 0);
                    } catch (Exception ignored) {}
                }
            });
        }
    }

    private void applyImmersive(boolean on) {
        View decor = getWindow().getDecorView();
        if (on) {
            if (Build.VERSION.SDK_INT >= 30) {
                getWindow().setDecorFitsSystemWindows(false);
                WindowInsetsController c = getWindow().getInsetsController();
                if (c != null) {
                    c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                    c.setSystemBarsBehavior(
                            WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                }
            } else {
                decor.setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
            }
        } else {
            if (Build.VERSION.SDK_INT >= 30) {
                WindowInsetsController c = getWindow().getInsetsController();
                if (c != null) {
                    c.show(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                }
                getWindow().setDecorFitsSystemWindows(true);
            } else {
                decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
            }
        }
    }

    // ==================== 启动检查更新 ====================

    private void checkForUpdates() {
        new Thread(new Runnable() {
            @Override
            public void run() {
                String json;
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(UPDATE_JSON_URL).openConnection();
                    c.setConnectTimeout(8000);
                    c.setReadTimeout(8000);
                    int code = c.getResponseCode();
                    if (code != 200) { c.disconnect(); return; }
                    InputStream in = c.getInputStream();
                    ByteArrayOutputStream bo = new ByteArrayOutputStream();
                    byte[] buf = new byte[4096];
                    int n;
                    while ((n = in.read(buf)) != -1) bo.write(buf, 0, n);
                    in.close();
                    c.disconnect();
                    json = bo.toString("UTF-8");
                } catch (Exception e) {
                    return;
                }
                try {
                    JSONObject o = new JSONObject(json);
                    final int remoteVersion = o.optInt("versionCode", 0);
                    int localVersion = getAppVersionCode();
                    if (remoteVersion <= localVersion) return;
                    final String apkUrl = pickApkUrl(o);
                    if (apkUrl.isEmpty()) return;
                    final String note = o.optString("note", "发现新版本，是否立即更新？");
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            new AlertDialog.Builder(MainActivity.this)
                                    .setTitle("发现新版本 v" + o.optString("versionName", String.valueOf(remoteVersion)))
                                    .setMessage(note)
                                    .setPositiveButton("立即更新", (dialog, which) -> downloadAndInstall(apkUrl))
                                    .setNegativeButton("暂不更新", null)
                                    .show();
                        }
                    });
                } catch (Exception ignored) {}
            }
        }).start();
    }

    private int getAppVersionCode() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            if (Build.VERSION.SDK_INT >= 28) return (int) pi.getLongVersionCode();
            return pi.versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    private String pickApkUrl(JSONObject o) {
        String abi = Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "arm64-v8a";
        String apkUrl = o.optString("apk", "");
        if (abi.contains("arm64")) {
            String v = o.optString("apkArm64", "");
            if (!v.isEmpty()) apkUrl = v;
        } else if (abi.contains("armeabi")) {
            String v = o.optString("apkArm", "");
            if (!v.isEmpty()) apkUrl = v;
        }
        return apkUrl;
    }

    private void downloadAndInstall(final String url) {
        final ProgressDialog pd = new ProgressDialog(this);
        pd.setMessage("正在下载更新包…");
        pd.setIndeterminate(true);
        pd.setCancelable(false);
        pd.show();
        new Thread(new Runnable() {
            @Override
            public void run() {
                File target = null;
                String err = null;
                try {
                    File dir = getExternalFilesDir("update");
                    if (dir == null) dir = getFilesDir();
                    if (!dir.exists()) dir.mkdirs();
                    target = new File(dir, "vodbox-update.apk");
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    c.setConnectTimeout(10000);
                    c.setReadTimeout(30000);
                    int code = c.getResponseCode();
                    if (code != 200) {
                        err = "下载失败（HTTP " + code + "）";
                    } else {
                        InputStream in = c.getInputStream();
                        OutputStream out = new FileOutputStream(target);
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                        in.close();
                        out.close();
                    }
                    c.disconnect();
                } catch (Exception e) {
                    err = "下载失败：" + e.getMessage();
                }
                final File apk = target;
                final String e2 = err;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        pd.dismiss();
                        if (e2 != null) {
                            Toast.makeText(MainActivity.this, e2, Toast.LENGTH_LONG).show();
                            return;
                        }
                        if (apk != null && apk.exists()) {
                            installApk(apk);
                        }
                    }
                });
            }
        }).start();
    }

    private void installApk(File apk) {
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            new AlertDialog.Builder(this)
                    .setTitle("需要安装权限")
                    .setMessage("为保证更新可正常安装，请在系统设置中允许本应用安装未知来源应用。")
                    .setPositiveButton("去设置", (dialog, which) -> {
                        try {
                            Intent it = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                    Uri.parse("package:" + getPackageName()));
                            startActivity(it);
                        } catch (Exception ignored) {}
                    })
                    .setNegativeButton("取消", null)
                    .show();
            return;
        }
        try {
            Uri uri = Uri.parse("content://" + UPDATE_FILE_AUTHORITY + "/" + Uri.encode(apk.getName()));
            Intent it = new Intent(Intent.ACTION_VIEW);
            it.setDataAndType(uri, "application/vnd.android.package-archive");
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(it);
        } catch (Exception e) {
            Toast.makeText(this, "无法打开安装器", Toast.LENGTH_LONG).show();
        }
    }

    private void startNodeThread() {
        new Thread(new Runnable() {
            @Override
            public void run() {
                final String nodeDir = getApplicationContext().getFilesDir().getAbsolutePath()
                        + "/nodejs-project";
                if (wasAPKUpdated()) {
                    File nodeDirReference = new File(nodeDir);
                    if (nodeDirReference.exists()) {
                        deleteFolderRecursively(nodeDirReference);
                    }
                    copyAssetFolder(getApplicationContext().getAssets(), "nodejs-project", nodeDir);
                    saveLastUpdateTime();
                }
                startNodeWithArguments(new String[]{"node", nodeDir + "/server.js"});
            }
        }).start();
    }

    private void waitForServerThenLoad() {
        new Thread(new Runnable() {
            @Override
            public void run() {
                int tries = 0;
                while (!isServerUp() && tries < 80) {
                    try { Thread.sleep(300); } catch (InterruptedException e) { break; }
                    tries++;
                }
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        loadingView.setVisibility(android.view.View.GONE);
                        webView.setVisibility(android.view.View.VISIBLE);
                        webView.loadUrl(NODE_URL);
                    }
                });
            }
        }).start();
    }

    private boolean isServerUp() {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(NODE_URL + "api/sources").openConnection();
            c.setConnectTimeout(300);
            c.setReadTimeout(300);
            int code = c.getResponseCode();
            c.disconnect();
            return code >= 200 && code < 500;
        } catch (Exception e) {
            return false;
        }
    }

    @Override
    public void onBackPressed() {
        // 页面内全屏时，返回键先退出全屏
        if (jsFullscreen && webView != null) {
            webView.evaluateJavascript("(window.__vbExitFs?window.__vbExitFs():0)", null);
            return;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    private boolean wasAPKUpdated() {
        SharedPreferences prefs = getApplicationContext().getSharedPreferences("NODEJS_MOBILE_PREFS", Context.MODE_PRIVATE);
        long previousLastUpdateTime = prefs.getLong("NODEJS_MOBILE_APK_LastUpdateTime", 0);
        long lastUpdateTime = getApkUpdateTime();
        return lastUpdateTime != previousLastUpdateTime;
    }

    private void saveLastUpdateTime() {
        SharedPreferences prefs = getApplicationContext().getSharedPreferences("NODEJS_MOBILE_PREFS", Context.MODE_PRIVATE);
        SharedPreferences.Editor editor = prefs.edit();
        editor.putLong("NODEJS_MOBILE_APK_LastUpdateTime", getApkUpdateTime());
        editor.commit();
    }

    private long getApkUpdateTime() {
        long t = 1;
        try {
            PackageInfo packageInfo = getApplicationContext().getPackageManager()
                    .getPackageInfo(getApplicationContext().getPackageName(), 0);
            t = packageInfo.lastUpdateTime;
        } catch (PackageManager.NameNotFoundException e) {
            e.printStackTrace();
        }
        return t;
    }

    private static boolean deleteFolderRecursively(File file) {
        try {
            boolean res = true;
            File[] children = file.listFiles();
            if (children != null) {
                for (File childFile : children) {
                    if (childFile.isDirectory()) {
                        res &= deleteFolderRecursively(childFile);
                    } else {
                        res &= childFile.delete();
                    }
                }
            }
            res &= file.delete();
            return res;
        } catch (Exception e) {
            e.printStackTrace();
            return false;
        }
    }

    private static boolean copyAssetFolder(AssetManager assetManager, String fromAssetPath, String toPath) {
        try {
            String[] files = assetManager.list(fromAssetPath);
            if (files == null) return false;
            if (files.length == 0) {
                return copyAsset(assetManager, fromAssetPath, toPath);
            } else {
                new File(toPath).mkdirs();
                boolean res = true;
                for (String file : files) {
                    res &= copyAssetFolder(assetManager, fromAssetPath + "/" + file, toPath + "/" + file);
                }
                return res;
            }
        } catch (Exception e) {
            e.printStackTrace();
            return false;
        }
    }

    private static boolean copyAsset(AssetManager assetManager, String fromAssetPath, String toPath) {
        InputStream in = null;
        OutputStream out = null;
        try {
            in = assetManager.open(fromAssetPath);
            new File(toPath).createNewFile();
            out = new FileOutputStream(toPath);
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            in.close();
            in = null;
            out.flush();
            out.close();
            out = null;
            return true;
        } catch (Exception e) {
            e.printStackTrace();
            return false;
        } finally {
            if (in != null) { try { in.close(); } catch (IOException ignored) {} }
            if (out != null) { try { out.close(); } catch (IOException ignored) {} }
        }
    }
}
