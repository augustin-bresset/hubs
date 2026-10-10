#!/bin/sh
# Construit l'application Android sans Gradle : ressources (aapt2), Java (javac), code Android (d8),
# alignement puis signature. Il faut un JDK et le SDK Android (build-tools 35.0.0, platforms;android-35).
#
#   android/build.sh            construit android/build/hubs.apk
#   android/build.sh publish    le dépose aussi dans public/ : le serveur le sert à l'adresse /hubs.apk
set -eu
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
JAVA_HOME="${JAVA_HOME:-$HOME/Android/jdk-21}"
export PATH="$JAVA_HOME/bin:$PATH"
TOOLS="$SDK/build-tools/35.0.0"
PLATFORM="$SDK/platforms/android-35/android.jar"
MIN_SDK=29     # Android 10
TARGET_SDK=34
WORK=build/work

# Nom et version viennent du reste du projet ; le numéro de version croît avec l'heure de
# construction, pour qu'une nouvelle construction s'installe par-dessus l'ancienne.
BRAND=$(sed -n "s/^export const BRAND = '\(.*\)';$/\1/p" ../public/brand.js)
VERSION=$(sed -n 's/^ *"version": "\(.*\)",$/\1/p' ../package.json)
CODE=$(date +%y%m%d%H)

rm -rf "$WORK"
mkdir -p "$WORK/brand/values" "$WORK/gen" "$WORK/classes"
printf '<?xml version="1.0" encoding="utf-8"?>\n<resources><string name="app_name">%s</string></resources>\n' "$BRAND" > "$WORK/brand/values/brand.xml"

"$TOOLS/aapt2" compile --dir res -o "$WORK/res.zip"
"$TOOLS/aapt2" compile --dir "$WORK/brand" -o "$WORK/brand.zip"
"$TOOLS/aapt2" link -o "$WORK/unsigned.apk" -I "$PLATFORM" --manifest AndroidManifest.xml --java "$WORK/gen" \
  --min-sdk-version "$MIN_SDK" --target-sdk-version "$TARGET_SDK" --version-code "$CODE" --version-name "$VERSION" \
  "$WORK/res.zip" "$WORK/brand.zip"
javac --release 11 -Xlint:all -Xlint:-options -cp "$PLATFORM" -d "$WORK/classes" $(find src "$WORK/gen" -name '*.java')
"$TOOLS/d8" --release --lib "$PLATFORM" --min-api "$MIN_SDK" --output "$WORK" $(find "$WORK/classes" -name '*.class')
(cd "$WORK" && zip -q -j unsigned.apk classes.dex)
"$TOOLS/zipalign" -f -p 4 "$WORK/unsigned.apk" "$WORK/aligned.apk"

# Clé de signature. Par défaut, une clé de développement créée une fois et gardée hors de build/ :
# Android refuse de mettre à jour une application signée par une autre clé (il faudrait la
# désinstaller d'abord). Pour une diffusion publique, fournir sa propre clé (alias « hubs ») :
#   HUBS_KEYSTORE=chemin/vers/cle.jks HUBS_KEYSTORE_PASS=… android/build.sh
KEYSTORE="${HUBS_KEYSTORE:-.keystore}"
export HUBS_KEYSTORE_PASS="${HUBS_KEYSTORE_PASS:-android}"
if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -keystore "$KEYSTORE" -storepass:env HUBS_KEYSTORE_PASS -keypass:env HUBS_KEYSTORE_PASS -alias hubs \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=$BRAND" >/dev/null 2>&1
fi
"$TOOLS/apksigner" sign --ks "$KEYSTORE" --ks-pass env:HUBS_KEYSTORE_PASS --ks-key-alias hubs --out build/hubs.apk "$WORK/aligned.apk"
echo "build/hubs.apk : $BRAND $VERSION ($CODE), $(du -h build/hubs.apk | cut -f1)"

if [ "${1:-}" = publish ]; then
  cp build/hubs.apk ../public/hubs.apk
  echo "Déposé dans public/hubs.apk : à ouvrir sur le téléphone à l'adresse du serveur suivie de /hubs.apk"
fi
