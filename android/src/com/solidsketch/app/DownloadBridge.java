package com.solidsketch.app;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * JavaScript interface "SolidSketchAndroid" used by assets/android-bridge.js to save
 * files the page offers as blob: downloads. The page streams the file as base64 chunks:
 * begin(name, mime) -> token, append(token, base64)*, finish(token).
 *
 * The WebView Java bridge looks methods up by name AND argument count, so the JS must call
 * these with exactly the arities declared here (build.sh enforces it with
 * tools/check_bridge.py). Error contract: begin()/append()/finish() show their own error
 * toast; begin() then returns null and append() false, and the JS stops without calling
 * failed(). failed() is only for errors on the JS side (reading the Blob, a bridge
 * exception), so every failed save produces exactly one error toast.
 *
 * API 29+: written to the public Downloads collection through MediaStore (no permission).
 * API 24-28: written to the app-specific external Downloads dir (no permission) and
 * registered with DownloadManager so it shows up in the Downloads app.
 */
public final class DownloadBridge {
    private static final String TAG = "SolidSketch";

    private static final class Pending {
        String name;
        String mime;
        OutputStream out;
        Uri uri;    // API 29+
        File file;  // API 24-28
        long bytes;
    }

    private final Activity activity;
    private final Map<String, Pending> pending = new HashMap<String, Pending>();
    private int seq;

    DownloadBridge(Activity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public synchronized String begin(String name, String mime) {
        String clean = sanitize(name);
        String type = (mime == null || mime.trim().length() == 0) ? "application/octet-stream" : mime.trim();
        try {
            Pending p = new Pending();
            p.name = clean;
            p.mime = type;
            if (Build.VERSION.SDK_INT >= 29) {
                Api29.open(activity, p);
            } else {
                File dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dir == null) dir = new File(activity.getFilesDir(), "Download");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
                p.file = unique(dir, clean);
                p.name = p.file.getName();
                p.out = new BufferedOutputStream(new FileOutputStream(p.file), 65536);
            }
            String token = "d" + (++seq);
            pending.put(token, p);
            return token;
        } catch (Exception e) {
            Log.e(TAG, "begin download failed", e);
            toast("Could not save " + clean + ": " + e.getMessage());
            return null;
        }
    }

    @JavascriptInterface
    public synchronized boolean append(String token, String base64) {
        Pending p = pending.get(token);
        if (p == null) {
            toast("Could not save the file: the download was interrupted");
            return false;
        }
        try {
            byte[] data = Base64.decode(base64, Base64.DEFAULT);
            p.out.write(data);
            p.bytes += data.length;
            return true;
        } catch (Exception e) {
            Log.e(TAG, "write failed", e);
            pending.remove(token);
            discard(p);
            toast("Could not save " + p.name + ": " + e.getMessage());
            return false;
        }
    }

    @JavascriptInterface
    public synchronized void finish(String token) {
        Pending p = pending.remove(token);
        if (p == null) return;
        try {
            p.out.close();
            if (Build.VERSION.SDK_INT >= 29) {
                String shown = Api29.publish(activity, p);
                toast("Saved " + shown + " to Downloads");
            } else {
                registerLegacy(p);
                String path = p.file.getAbsolutePath();
                File ext = Environment.getExternalStorageDirectory();
                if (ext != null && path.startsWith(ext.getAbsolutePath() + "/")) {
                    path = path.substring(ext.getAbsolutePath().length() + 1);
                }
                toast("Saved " + p.name + " to " + path);
            }
        } catch (Exception e) {
            Log.e(TAG, "finish download failed", e);
            discard(p);
            toast("Could not save " + p.name + ": " + e.getMessage());
        }
    }

    @JavascriptInterface
    public void failed(String name, String message) {
        toast("Could not save " + sanitize(name) + ": " + message);
    }

    private void registerLegacy(Pending p) {
        try {
            DownloadManager dm = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm != null) {
                dm.addCompletedDownload(p.name, "SolidSketch export", true, p.mime,
                        p.file.getAbsolutePath(), p.file.length(), true);
            }
        } catch (Exception e) {
            Log.w(TAG, "addCompletedDownload failed (file is still saved)", e);
        }
    }

    private void discard(Pending p) {
        try { if (p.out != null) p.out.close(); } catch (Exception ignored) { }
        try {
            if (p.file != null) p.file.delete();
            if (p.uri != null) activity.getContentResolver().delete(p.uri, null, null);
        } catch (Exception ignored) { }
    }

    private void toast(final String msg) {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(activity, msg, Toast.LENGTH_LONG).show();
            }
        });
    }

    static String sanitize(String name) {
        String n = name == null ? "" : name;
        int slash = Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\'));
        if (slash >= 0) n = n.substring(slash + 1);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < n.length(); i++) {
            char c = n.charAt(i);
            if (c < 0x20 || c == 0x7f || ":*?\"<>|".indexOf(c) >= 0) sb.append('_');
            else sb.append(c);
        }
        n = sb.toString().trim();
        while (n.startsWith(".")) n = n.substring(1);
        if (n.length() == 0) n = "download";
        if (n.length() > 120) n = n.substring(n.length() - 120);
        return n;
    }

    private static File unique(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 10000; i++) {
            f = new File(dir, base + " (" + i + ")" + ext);
            if (!f.exists()) return f;
        }
        return new File(dir, base + "-" + System.currentTimeMillis() + ext);
    }

    /** API 29+ code kept in its own class so older runtimes never verify it. */
    private static final class Api29 {
        static void open(Activity a, Pending p) throws IOException {
            ContentResolver cr = a.getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, p.name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, p.mime);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new IOException("MediaStore refused " + p.name);
            p.uri = uri;
            OutputStream os = cr.openOutputStream(uri, "w");
            if (os == null) {
                cr.delete(uri, null, null);
                throw new IOException("cannot open " + uri);
            }
            p.out = new BufferedOutputStream(os, 65536);
        }

        static String publish(Activity a, Pending p) {
            ContentResolver cr = a.getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(p.uri, v, null, null);
            String shown = p.name;
            Cursor c = null;
            try {
                c = cr.query(p.uri, new String[] { MediaStore.MediaColumns.DISPLAY_NAME }, null, null, null);
                if (c != null && c.moveToFirst() && c.getString(0) != null) shown = c.getString(0);
            } catch (Exception ignored) {
            } finally {
                if (c != null) c.close();
            }
            return shown;
        }
    }
}
