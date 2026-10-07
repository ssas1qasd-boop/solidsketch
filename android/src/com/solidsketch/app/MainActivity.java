package com.solidsketch.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.DownloadListener;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Single full-screen WebView hosting the bundled SolidSketch page
 * (file:///android_asset/solidsketch.html). Adds what a bare WebView lacks:
 * the system file picker for &lt;input type=file&gt;, saving blob: downloads to
 * Downloads, back navigation and recovery from a crashed renderer.
 */
public class MainActivity extends Activity {
    static final String TAG = "SolidSketch";
    static final String PAGE_URL = "file:///android_asset/solidsketch.html";
    static final String BRIDGE_ASSET = "android-bridge.js";
    static final String BRIDGE_NAME = "SolidSketchAndroid";
    static final int REQ_FILE = 4201;

    private FrameLayout root;
    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private DownloadBridge downloads;
    private String bridgeJs = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        bridgeJs = readAsset(BRIDGE_ASSET);
        downloads = new DownloadBridge(this);
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        root = new FrameLayout(this);
        root.setBackgroundColor(pageBackground());
        setContentView(root);
        createWebView();
    }

    private int pageBackground() {
        int night = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return night == Configuration.UI_MODE_NIGHT_YES ? Color.parseColor("#1C1E23") : Color.parseColor("#EEF1F5");
    }

    private void createWebView() {
        web = new WebView(this);
        web.setBackgroundColor(pageBackground());
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);           // localStorage autosave
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);             // default is false for targetSdk 30+
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(true); // the page is local (file:///android_asset)
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setSupportZoom(false);                // the app does its own pinch zoom
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true);             // honour <meta name=viewport content="width=device-width, initial-scale=1">
        s.setLoadWithOverviewMode(true);
        s.setTextZoom(100);                     // the CAD UI has a fixed layout
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        web.addJavascriptInterface(downloads, BRIDGE_NAME);
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimetype, long contentLength) {
                onDownload(url, contentDisposition, mimetype);
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.loadUrl(PAGE_URL);
    }

    private void injectBridge(WebView view) {
        if (bridgeJs.length() > 0) view.evaluateJavascript(bridgeJs, null);
    }

    /** Fallback for downloads the injected click hook did not catch. */
    private void onDownload(String url, String contentDisposition, String mimetype) {
        if (url == null) return;
        String lower = url.toLowerCase(Locale.ROOT);
        if (lower.startsWith("blob:") || lower.startsWith("data:")) {
            String guessed = lower.startsWith("blob:") ? URLUtil.guessFileName(url, contentDisposition, mimetype) : "download";
            injectBridge(web);
            web.evaluateJavascript("window.__solidsketchSave && window.__solidsketchSave("
                    + JSONObject.quote(url) + "," + JSONObject.quote(mimetype == null ? "" : mimetype) + ","
                    + JSONObject.quote(guessed == null ? "download" : guessed) + ")", null);
        } else {
            openExternally(Uri.parse(url));
        }
    }

    private boolean openExternally(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No app can open " + uri, Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handle(request.getUrl());
        }

        @SuppressWarnings("deprecation")
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handle(Uri.parse(url));
        }

        private boolean handle(Uri uri) {
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (scheme.equals("file") || scheme.equals("about") || scheme.equals("blob")
                    || scheme.equals("data") || scheme.equals("javascript")) {
                return false; // stay inside the WebView
            }
            return openExternally(uri); // http(s), mailto:, ... go to other apps
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            injectBridge(view);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            injectBridge(view); // idempotent
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // API 26+: the renderer crashed or was killed for memory. Rebuild the WebView
            // instead of letting the whole app die; the page restores its localStorage autosave.
            Log.w(TAG, "WebView renderer gone, crashed=" + detail.didCrash());
            if (fileCallback != null) {
                fileCallback.onReceiveValue(null);
                fileCallback = null;
            }
            if (view == web) {
                root.removeView(web);
                web.destroy();
                createWebView();
                Toast.makeText(MainActivity.this, "SolidSketch was reloaded (the WebView stopped)", Toast.LENGTH_LONG).show();
            } else {
                view.destroy();
            }
            return true;
        }
    }

    private final class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(null);
                fileCallback = null;
            }
            List<String> mimes = new ArrayList<String>();
            boolean extensionOnly = false;
            String[] accept = params.getAcceptTypes();
            if (accept != null) {
                for (String a : accept) {
                    if (a == null) continue;
                    for (String t : a.split(",")) {
                        t = t.trim().toLowerCase(Locale.ROOT);
                        if (t.length() == 0) continue;
                        if (t.startsWith(".")) extensionOnly = true;  // e.g. .dxf / .dwg: no reliable MIME type on Android
                        else if (t.indexOf('/') > 0 && !mimes.contains(t)) mimes.add(t);
                    }
                }
            }
            Intent i = new Intent(Intent.ACTION_GET_CONTENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            if (extensionOnly || mimes.isEmpty()) {
                i.setType("*/*");
            } else if (mimes.size() == 1) {
                i.setType(mimes.get(0));
            } else {
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
            }
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
            fileCallback = callback;
            try {
                startActivityForResult(i, REQ_FILE);
            } catch (ActivityNotFoundException e) {
                try {
                    Intent o = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    o.addCategory(Intent.CATEGORY_OPENABLE);
                    o.setType("*/*");
                    startActivityForResult(o, REQ_FILE);
                } catch (ActivityNotFoundException e2) {
                    fileCallback = null;
                    Toast.makeText(MainActivity.this, "No file picker is available", Toast.LENGTH_SHORT).show();
                    return false; // callback not used; WebView cancels the request
                }
            }
            return true;
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            Log.d(TAG, m.messageLevel() + " " + m.sourceId() + ":" + m.lineNumber() + " " + m.message());
            return true;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQ_FILE) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        ValueCallback<Uri[]> cb = fileCallback;
        fileCallback = null;
        if (cb == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                List<Uri> uris = new ArrayList<Uri>();
                for (int k = 0; k < clip.getItemCount(); k++) {
                    Uri u = clip.getItemAt(k).getUri();
                    if (u != null) uris.add(u);
                }
                if (!uris.isEmpty()) result = uris.toArray(new Uri[0]);
            } else if (data.getData() != null) {
                result = new Uri[] { data.getData() };
            }
        }
        cb.onReceiveValue(result); // null = cancelled
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (fileCallback != null) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
        }
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    private String readAsset(String name) {
        InputStream in = null;
        try {
            in = getAssets().open(name);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), "UTF-8");
        } catch (Exception e) {
            Log.e(TAG, "cannot read asset " + name, e);
            return "";
        } finally {
            if (in != null) {
                try { in.close(); } catch (Exception ignored) { }
            }
        }
    }
}
