#!/usr/bin/env bash
# Build, sign and verify SolidSketch-v24.apk WITHOUT the Android SDK / Gradle / AGP.
#
# Toolchain (all fetched once into android/.cache/, pinned by SHA-256):
#   aapt2  - prebuilt linux binary inside org.apktool:apktool-lib:3.0.3        (Maven Central)
#   dx     - com.jakewharton.android.repackaged:dalvik-dx:16.0.1                (Maven Central)
#   apksig - com.android.tools.build:apksig:2.3.0                               (Maven Central)
#   android.jar (API 34 stubs + framework resources.arsc) - Sable/android-platforms on GitHub
#   + the local JDK (javac, java, keytool) and python3.
#
# Usage: android/build.sh [path/to/solidsketch.html] [path/to/output.apk]
#   defaults: <repo>/solidsketch_v24.html  ->  <repo>/SolidSketch-v24.apk
#        android/build.sh --check [html] [apk]
#   only checks that the APK still bundles exactly this HTML and bridge JS (run it before
#   committing html + apk together; exit 1 = stale APK, rebuild with android/build.sh)
# Env overrides: KEYSTORE STOREPASS KEYALIAS KEYPASS MAVEN_REPO ANDROID_JAR_URL
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
CHECK_ONLY=0
if [ "${1:-}" = "--check" ]; then CHECK_ONLY=1; shift; fi
HTML="$(realpath "${1:-$ROOT/solidsketch_v24.html}")"
OUT="$(realpath -m "${2:-$ROOT/SolidSketch-v24.apk}")"
CACHE="$HERE/.cache"
BUILD="$HERE/build"
KEYSTORE="${KEYSTORE:-$HERE/solidsketch-release.jks}"
STOREPASS="${STOREPASS:-solidsketch}"
KEYALIAS="${KEYALIAS:-solidsketch}"
KEYPASS="${KEYPASS:-$STOREPASS}"
MAVEN_REPO="${MAVEN_REPO:-https://repo1.maven.org/maven2}"
ANDROID_JAR_URL="${ANDROID_JAR_URL:-https://raw.githubusercontent.com/Sable/android-platforms/master/android-34/android.jar}"

# apksig 2.3.0 parses PKCS#7 with JDK-internal classes (v1 verification)
JAVA_EXPORTS=(--add-exports=java.base/sun.security.x509=ALL-UNNAMED
              --add-exports=java.base/sun.security.pkcs=ALL-UNNAMED
              --add-exports=java.base/sun.security.util=ALL-UNNAMED)

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# check_assets APK HTML - the APK must bundle exactly this HTML and assets/android-bridge.js
check_assets() {
  local apk="$1" html="$2" want got rc=0
  [ -f "$apk" ] || { echo "    no APK at $apk"; return 1; }
  want=$(sha256sum < "$html" | cut -d' ' -f1)
  got=$(unzip -p "$apk" assets/solidsketch.html 2>/dev/null | sha256sum | cut -d' ' -f1) || true
  echo "    html   source $want  $html"
  echo "           apk    $got  assets/solidsketch.html"
  [ "$want" = "$got" ] || { echo "    STALE: the APK bundles a different solidsketch.html"; rc=1; }
  want=$(sha256sum < "$HERE/assets/android-bridge.js" | cut -d' ' -f1)
  got=$(unzip -p "$apk" assets/android-bridge.js 2>/dev/null | sha256sum | cut -d' ' -f1) || true
  echo "    bridge source $want  android/assets/android-bridge.js"
  echo "           apk    $got  assets/android-bridge.js"
  [ "$want" = "$got" ] || { echo "    STALE: the APK bundles a different android-bridge.js"; rc=1; }
  return $rc
}

if [ "$CHECK_ONLY" = 1 ]; then
  [ -f "$HTML" ] || die "HTML not found: $HTML"
  echo "==> does $OUT bundle the current sources?"
  if check_assets "$OUT" "$HTML"; then echo "OK: up to date"; exit 0; fi
  echo "Rebuild with: $HERE/build.sh $HTML $OUT" >&2
  exit 1
fi

for t in java javac keytool python3 curl sha256sum unzip; do
  command -v "$t" >/dev/null || die "missing required tool: $t"
done
[ -f "$HTML" ] || die "HTML not found: $HTML"

# fetch URL DEST SHA256 - download with retry/backoff (Maven Central answers 429 when busy)
fetch() {
  local url="$1" dest="$2" sum="$3" i code
  if [ -f "$dest" ] && echo "$sum  $dest" | sha256sum -c --quiet - 2>/dev/null; then return 0; fi
  mkdir -p "$(dirname "$dest")"
  for i in 1 2 3 4 5 6 7 8; do
    code=$(curl -sS -L --retry 2 -m 600 -o "$dest.part" -w '%{http_code}' "$url" || echo 000)
    if [ "$code" = 200 ]; then
      if echo "$sum  $dest.part" | sha256sum -c --quiet - 2>/dev/null; then
        mv "$dest.part" "$dest"; echo "    fetched $(basename "$dest")"; sleep 1; return 0
      fi
      rm -f "$dest.part"; die "SHA-256 mismatch for $url"
    fi
    rm -f "$dest.part"
    [ "$code" = 404 ] && die "404 for $url"
    echo "    HTTP $code for $(basename "$dest"), retry $i in $((i * 4))s" >&2
    sleep $((i * 4))
  done
  die "could not download $url"
}

# maven GROUP ARTIFACT VERSION SHA256 -> prints local jar path
maven() {
  local g="$1" a="$2" v="$3" sum="$4"
  local jar="$CACHE/m2/$a-$v.jar"
  fetch "$MAVEN_REPO/${g//.//}/$a/$v/$a-$v.jar" "$jar" "$sum" >&2
  echo "$jar"
}

log "[1/8] toolchain (cache: $CACHE)"
APKTOOL_LIB=$(maven org.apktool apktool-lib 3.0.3 983773879fd89ede2cd938858e3efce2a90ac1123f6a5140e9d949dcf4464e3e)
DX_JAR=$(maven com.jakewharton.android.repackaged dalvik-dx 16.0.1 1e4b645628e3bdb097b5331d669e177ef235a551582a8c646dbe36865e541907)
APKSIG_JAR=$(maven com.android.tools.build apksig 2.3.0 9637078c0016244e4be0941836295365a7e2e5b164c59cb7885783c40460bfee)
ANDROID_JAR="$CACHE/android-34.jar"
fetch "$ANDROID_JAR_URL" "$ANDROID_JAR" 6cea1df3efb77103ac3e2beb9bf4718964b0e0869ab16d39d29d5cbae1c147ad
AAPT2="$CACHE/tools/aapt2"
if ! { [ -x "$AAPT2" ] && echo "df312db814c018019b2b79a993b041b738d7b76f4a8f28da25bc874a026368cc  $AAPT2" | sha256sum -c --quiet - 2>/dev/null; }; then
  mkdir -p "$CACHE/tools"
  unzip -o -q -j "$APKTOOL_LIB" prebuilt/linux/aapt2 -d "$CACHE/tools/"
  chmod +x "$AAPT2"
  echo "df312db814c018019b2b79a993b041b738d7b76f4a8f28da25bc874a026368cc  $AAPT2" | sha256sum -c --quiet - || die "aapt2 hash mismatch"
fi
echo "    aapt2:   $("$AAPT2" version 2>&1)"
echo "    dx:      $DX_JAR"
echo "    apksig:  $APKSIG_JAR"
echo "    javac:   $(javac -version 2>&1 | grep -v '^Picked up')"

rm -rf "$BUILD"
mkdir -p "$BUILD"/{compiled,gen,classes,assets}

log "[2/8] launcher icons"
if [ ! -f "$HERE/res/mipmap-xxxhdpi/ic_launcher.png" ]; then
  python3 -I "$HERE/tools/make_icons.py" "$HERE/res"
else
  echo "    using existing res/mipmap-*/ic_launcher.png (delete them to regenerate)"
fi

log "[3/8] aapt2 compile + link (manifest, resources, assets)"
cp "$HTML" "$BUILD/assets/solidsketch.html"
cp "$HERE/assets/android-bridge.js" "$BUILD/assets/android-bridge.js"
"$AAPT2" compile --dir "$HERE/res" -o "$BUILD/compiled/res.zip"
"$AAPT2" link -I "$ANDROID_JAR" \
  --manifest "$HERE/AndroidManifest.xml" \
  -A "$BUILD/assets" \
  --java "$BUILD/gen" \
  -o "$BUILD/base.apk" \
  "$BUILD/compiled/res.zip"
echo "    $(du -h "$BUILD/base.apk" | cut -f1) base.apk"

log "[4/8] javac (Java 8 bytecode against android-34 android.jar)"
mapfile -t SOURCES < <(find "$HERE/src" "$BUILD/gen" -name '*.java' | sort)
javac -source 8 -target 8 -encoding UTF-8 -Xlint:-options -nowarn \
  -bootclasspath "$ANDROID_JAR" -classpath "$ANDROID_JAR" \
  -d "$BUILD/classes" "${SOURCES[@]}" 2>&1 | grep -v -e '^Picked up' -e '^Note:' || true
[ -f "$BUILD/classes/com/solidsketch/app/MainActivity.class" ] || die "javac failed"
echo "    JS -> Java bridge calls (WebView matches name + argument count):"
python3 -I "$HERE/tools/check_bridge.py" "$BUILD/classes/com/solidsketch/app/DownloadBridge.class" \
  "$HERE/assets/android-bridge.js" || die "android-bridge.js calls DownloadBridge with the wrong arguments"

log "[5/8] dx --dex (classes.dex)"
java -cp "$DX_JAR" com.android.dx.command.Main --dex --min-sdk-version=24 \
  --output="$BUILD/classes.dex" "$BUILD/classes" 2>&1 | grep -v '^Picked up' || true
[ -s "$BUILD/classes.dex" ] || die "dx failed"

log "[6/8] package + align (resources.arsc STORED, STORED entries 4-byte aligned)"
python3 -I "$HERE/tools/package.py" "$BUILD/base.apk" "$BUILD/unsigned.apk" "$BUILD/classes.dex=classes.dex"

log "[7/8] sign (v1 JAR + v2) with apksig"
if [ ! -f "$KEYSTORE" ]; then
  echo "    creating keystore $KEYSTORE"
  keytool -genkeypair -keystore "$KEYSTORE" -storetype PKCS12 -storepass "$STOREPASS" -keypass "$KEYPASS" \
    -alias "$KEYALIAS" -keyalg RSA -keysize 2048 -sigalg SHA256withRSA -validity 10000 \
    -dname "CN=SolidSketch, O=SolidSketch, C=US" 2>&1 | grep -v '^Picked up'
fi
java "${JAVA_EXPORTS[@]}" -cp "$APKSIG_JAR" "$HERE/tools/ApkSignTool.java" sign \
  "$BUILD/unsigned.apk" "$BUILD/signed.apk" "$KEYSTORE" "$STOREPASS" "$KEYALIAS" "$KEYPASS" 2> >(grep -v '^Picked up' >&2)
cp "$BUILD/signed.apk" "$OUT"

log "[8/8] verification of $OUT"
set +e
java "${JAVA_EXPORTS[@]}" -cp "$APKSIG_JAR" "$HERE/tools/ApkSignTool.java" verify "$OUT" 2> >(grep -v '^Picked up' >&2)
V_SIG=$?
echo
python3 -I "$HERE/tools/check_apk.py" "$OUT" com.solidsketch.app.MainActivity
V_ZIP=$?
echo
echo "== bundled assets"
check_assets "$OUT" "$HTML"
V_ASSETS=$?
echo
"$AAPT2" dump badging "$OUT" 2>&1 | head -n 12
echo
echo "== manifest (activity)"
"$AAPT2" dump xmltree --file AndroidManifest.xml "$OUT" 2>&1 | grep -E 'android:(name|exported|configChanges|hardwareAccelerated|theme)\(' | grep -v 'android.intent' || true
echo
unzip -lv "$OUT"
echo
echo "size:   $(stat -c %s "$OUT") bytes"
echo "sha256: $(sha256sum "$OUT" | cut -d' ' -f1)"
set -e
[ "$V_SIG" = 0 ] && [ "$V_ZIP" = 0 ] && [ "$V_ASSETS" = 0 ] || die "verification failed (signature=$V_SIG structure=$V_ZIP assets=$V_ASSETS)"
echo
echo "OK: $OUT"
