# SolidSketch for Android (WebView wrapper)

`SolidSketch-v24.apk` packages the single-file web app `solidsketch_v24.html` as an
Android app: one Activity with a full-screen WebView that loads
`file:///android_asset/solidsketch.html`.

| | |
|---|---|
| package | `com.solidsketch.app` |
| version | versionCode 24, versionName "24" |
| SDK | minSdkVersion 24 (Android 7.0), targetSdkVersion 34 |
| permissions | none |
| signing | APK Signature Scheme v2 + v1 (JAR), RSA 2048 / SHA-256 |

## Rebuild

```sh
android/build.sh                                   # solidsketch_v24.html -> SolidSketch-v24.apk
android/build.sh path/to/other.html out/App.apk    # other page / output path
android/build.sh --check                           # is the APK still built from the current html + bridge JS?
```

The APK holds a **copy** of the page, so it goes stale as soon as `solidsketch_v24.html`
changes. Before committing the HTML and the APK together, run `android/build.sh --check`.
It compares the SHA-256 of `solidsketch_v24.html` and `assets/android-bridge.js` with the
copies inside the APK, prints both, and exits 1 if either differs. In that case, rebuild
with `android/build.sh`. The full build runs the same comparison as part of its verification.

The script downloads the toolchain once into `android/.cache/` and checks each file
against a pinned SHA-256. It then builds into `android/build/`, signs the APK, and
prints the verification output (apksig, alignment, dex, `aapt2 dump badging`,
`unzip -lv`, size and sha256). It needs only a JDK 11+ (tested with OpenJDK 21),
python3, curl and unzip. It does not use the Android SDK, Gradle, AGP or
dl.google.com.

## Toolchain

| step | tool | where it comes from |
|---|---|---|
| resources, manifest, assets | **aapt2** 2.20 (static linux x86-64 binary `prebuilt/linux/aapt2`) | Maven Central `org.apktool:apktool-lib:3.0.3` |
| platform API + framework resources | `android.jar` API 34 (stubs + `resources.arsc`) | `https://raw.githubusercontent.com/Sable/android-platforms/master/android-34/android.jar` |
| Java -> bytecode | `javac -source 8 -target 8 -bootclasspath android.jar` | local JDK |
| bytecode -> `classes.dex` (dex 037) | **dx** (`com.android.dx.command.Main --dex --min-sdk-version=24`) | Maven Central `com.jakewharton.android.repackaged:dalvik-dx:16.0.1` |
| zip + alignment | `tools/package.py` (zipalign -p 4 equivalent) | this repo |
| signing / verification | **apksig** (`ApkSigner`, `DefaultApkSignerEngine`, `ApkVerifier`) driven by `tools/ApkSignTool.java` | Maven Central `com.android.tools.build:apksig:2.3.0` |
| launcher icon PNGs | `tools/make_icons.py` (pure Python, no PIL) | this repo |

Pinned SHA-256 (the Maven jars also match Maven Central's published `.sha1`):

```
983773879fd89ede2cd938858e3efce2a90ac1123f6a5140e9d949dcf4464e3e  apktool-lib-3.0.3.jar
df312db814c018019b2b79a993b041b738d7b76f4a8f28da25bc874a026368cc  aapt2 (extracted)
1e4b645628e3bdb097b5331d669e177ef235a551582a8c646dbe36865e541907  dalvik-dx-16.0.1.jar
9637078c0016244e4be0941836295365a7e2e5b164c59cb7885783c40460bfee  apksig-2.3.0.jar
6cea1df3efb77103ac3e2beb9bf4718964b0e0869ab16d39d29d5cbae1c147ad  android-34.jar
```

Build steps, in `build.sh` order:

1. `aapt2 compile --dir res` and then `aapt2 link -I android-34.jar --manifest AndroidManifest.xml -A assets`.
   This step generates the binary manifest, `resources.arsc`, the compiled XML and icons, and `R.java`.
   At this point `assets/` holds `solidsketch.html`, a copy of the input page, and `android-bridge.js`.
2. `javac` compiles `src/` and `R.java`, and `dx` turns the class files into `classes.dex`.
   Before `dx`, `tools/check_bridge.py` reads the public `@JavascriptInterface` methods and their parameter counts from the compiled `DownloadBridge.class`.
   It checks every `bridge.<method>(...)` call in `assets/android-bridge.js` against them, and the build stops on a mismatch.
   This matters because the WebView Java bridge finds a method by name **and** argument count (Chromium `GinJavaBoundObject::FindMethod`).
   A call with one argument too many fails at runtime with `Error invoking begin: Method not found`.
3. `tools/package.py` merges `classes.dex` into the linked APK. It writes the entries in a fixed order with fixed timestamps.
   `resources.arsc` and the PNGs are **STORED**, and each STORED entry's data is 4-byte aligned.
   Alignment uses padding in the local-header extra field (`0xd935`), the same method as zipalign and apksig.
4. `tools/ApkSignTool.java sign` signs the APK **after** alignment.
   apksig's `DefaultApkSignerEngine` writes the **v2** block.
   apksig 2.3.0's own **v1** signer calls `sun.security.pkcs.PKCS7.encodeSignedData(OutputStream)`, which exists only in JDK 8.
   So the v1 part is produced by a small delegating `ApkSignerEngine` in the same file, in the format apksig itself uses:
   - SHA-256 `MANIFEST.MF`
   - `CERT.SF` carrying `X-Android-APK-Signed: 2`, which gives v2 stripping protection
   - a DER PKCS#7 `CERT.RSA`

   `ApkSigner` keeps the alignment while it rewrites the zip.
5. `ApkSignTool verify` runs apksig `ApkVerifier` twice:
   - for the APK's own platform range, where Android 7.0+ uses v2
   - again from API 18, which forces the v1 signature to be verified too

   `tools/check_apk.py` then re-checks the alignment, that `resources.arsc` is STORED, the dex header (magic, Adler-32, SHA-1, size), the class list and the signing block.
   `build.sh` also checks that the bundled `solidsketch.html` and `android-bridge.js` match their sources (the same check as `--check`).
   It then decodes the manifest's activity attributes with `aapt2 dump xmltree`.
   Running the same input twice gives a byte-identical APK, because RSA PKCS#1 v1.5 signatures are deterministic.

The JVM needs `--add-exports java.base/sun.security.{x509,pkcs,util}=ALL-UNNAMED` because apksig 2.3.0's v1 *verifier* uses those internal classes. `build.sh` passes these flags.

## Signing key

`solidsketch-release.jks` is a PKCS#12 keystore with alias `solidsketch`, store and key password `solidsketch`, and an RSA 2048 self-signed certificate `CN=SolidSketch, O=SolidSketch, C=US` valid until 2054.
The certificate's SHA-256 is `1a9ad03327e996d674f0019aec92672134a5c44cde83dacf5de19be5c8adb13d`.
The password is in this file on purpose: this key only makes the APK installable and updatable from this repo, so treat it as public.
For a store release, use your own key:

```sh
KEYSTORE=~/keys/release.p12 STOREPASS=... KEYALIAS=... KEYPASS=... android/build.sh
```

If the keystore file is missing, `build.sh` creates a new one with `keytool`.
Android refuses to install an APK signed with a different key as an update over an existing install.

## What the wrapper adds to the web page

All of this lives in `src/com/solidsketch/app/` and `assets/android-bridge.js`.

- **WebView settings:** JavaScript, DOM storage (the page's localStorage autosave) and the database are on.
  File access, including from file URLs, is allowed because the page is local.
  Zoom is off because the app does its own pinch zoom. Wide viewport and overview mode are on, to match `width=device-width, initial-scale=1`. `textZoom` is fixed at 100.
  Remote debugging is on only in debuggable builds.
- **File picker:** `<input type=file>` (DXF/DWG import and the image picker) opens the system picker (`ACTION_GET_CONTENT`), with `ACTION_OPEN_DOCUMENT` as a fallback.
  Picking MIME-only accept lists such as `image/*` filters by those types.
  Lists that contain extensions (`.dxf,.dwg`) use `*/*`, because Android has no reliable MIME type for DXF or DWG.
  Cancelling delivers `null`.
- **Downloads:** the page exports STL/OBJ and DXF zips through `URL.createObjectURL` and `<a download>.click()`.
  A WebView cannot save blob: URLs, so `android-bridge.js` handles this:
  1. It is injected in `onPageCommitVisible` and `onPageFinished`, and it is idempotent.
  2. It records each Blob at `createObjectURL` time.
  3. It intercepts `HTMLAnchorElement.prototype.click` and real taps on `a[download]` with blob: or data: hrefs.
  4. It streams the bytes as base64 chunks to the `SolidSketchAndroid` `@JavascriptInterface`.
     The calls are `begin(name, mime)` → token, then `append(token, base64)`, then `finish(token)`. The arity must match exactly; `build.sh` checks it.
  5. A failed save shows **one** error toast.
     If Java fails in `begin` or `append`, Java shows the toast and returns `null`/`false`, and the JS stops.
     `failed(name, message)` is only for errors on the JS side, such as when the Blob cannot be read.

  On API 29+ the file goes to the public **Downloads** folder through `MediaStore.Downloads`.
  On API 24–28 it goes to `Android/data/com.solidsketch.app/files/Download/` and is registered with DownloadManager, so it shows in the Downloads app.
  Neither path needs a storage permission. A toast shows the file name and where it was saved.
  The `DownloadListener` remains as a fallback.
- **Back button** goes back in the WebView history when there is any; otherwise it does the default.
- **Configuration changes:** these do not reload the page:
  - rotation and resizing (split screen, foldables)
  - keyboards
  - display size (`density`)
  - font size (`fontScale`; `textZoom` is pinned at 100)

  The full `configChanges` value is `orientation|screenSize|keyboardHidden|smallestScreenSize|screenLayout|keyboard|navigation|density|fontScale`, which is `0x40001df0` in the binary manifest.
  `uiMode` is left out on purpose. Switching system dark mode recreates the activity, which is how the `values-night` theme, and with it the page's `prefers-color-scheme`, takes effect. The page then restores its localStorage autosave.
  `adjustResize` keeps number fields above the soft keyboard.
- **Themes:** a light theme is used by default and a dark theme under `values-night`. The WebView reports `prefers-color-scheme` from the theme, so the page follows system dark mode. The window background and system bars use the page colours.
- If the WebView renderer crashes or is killed (API 26+), the WebView is rebuilt instead of the app dying. The page then restores its autosave.
- **Links:** external `http(s)`/`mailto` links open in other apps. The app has no INTERNET permission and works fully offline.

The page needs an up-to-date **Android System WebView** (Chromium 80+). It uses WebAssembly and `DecompressionStream`. Android 7.0+ devices get WebView updates from the Play Store.

## Files

```
android/
  build.sh                 reproducible build (downloads + caches tools, builds, signs, verifies)
  AndroidManifest.xml
  src/com/solidsketch/app/MainActivity.java   WebView host, file chooser, back, crash recovery
  src/com/solidsketch/app/DownloadBridge.java @JavascriptInterface that writes downloads
  assets/android-bridge.js injected download hook
  res/                     themes, adaptive icon (vector), legacy icon PNGs
  tools/make_icons.py      regenerates res/mipmap-*/ic_launcher.png
  tools/package.py         zip writer with 4-byte alignment for STORED entries
  tools/ApkSignTool.java   apksig front end: v1 + v2 signing, verification
  tools/check_apk.py       structural checks (alignment, arsc, dex, signing block)
  tools/check_bridge.py    JS -> @JavascriptInterface name + arity check (run by build.sh)
  solidsketch-release.jks  signing key (public, see above)
  .cache/  build/          (git-ignored)
```
