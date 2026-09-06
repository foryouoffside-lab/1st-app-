# ─────────────────────────────────────────────────────────────────────────────
# SkillDrills — R8 / ProGuard rules for the release build
# ─────────────────────────────────────────────────────────────────────────────
#
# minifyEnabled is TRUE in build.gradle. Everything below exists because this is
# a Capacitor app: almost nothing in the Java layer is called from other Java
# code, so R8's reachability analysis sees it as dead and deletes or renames it.
# It is actually reached in one of three reflective ways R8 cannot follow:
#
#   1. android/app/src/main/assets/capacitor.plugins.json lists every plugin by
#      its FULLY-QUALIFIED CLASS NAME as a string, and the bridge does
#      Class.forName() on each one at startup. Rename or strip those classes and
#      the app boots to a blank WebView with every native call failing.
#   2. Plugin methods are invoked by NAME from JavaScript (@PluginMethod), never
#      from Java.
#   3. The JS<->native bridge itself is an @JavascriptInterface object the
#      WebView calls into.
#
# So the rule of thumb here: keep anything a string can name. The size cost is
# small — in a Capacitor app the APK is dominated by the web assets and native
# libs, not this bytecode — and a wrong guess here is a crash on a user's phone,
# not a compile error.
#
# NOTE: shrinkResources is deliberately NOT enabled alongside minifyEnabled.
# Capacitor resolves drawables by name at runtime (getIdentifier) — the splash
# is configured as the string "splash" in capacitor.config.ts, and the
# LocalNotifications icon likewise — so resource shrinking would strip assets
# that nothing references from code and the splash/notification icons would
# silently disappear.

# ── Capacitor core + bridge ──────────────────────────────────────────────────
-keep class com.getcapacitor.** { *; }
-dontwarn com.getcapacitor.**

# Every plugin class named as a string in capacitor.plugins.json, plus our own
# two registered in MainActivity (KeepAwakePlugin, ImmersiveModePlugin).
-keep public class * extends com.getcapacitor.Plugin { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin public class * { *; }

# Methods JavaScript calls by name.
-keepclassmembers class * extends com.getcapacitor.Plugin {
    @com.getcapacitor.PluginMethod <methods>;
}

# The WebView bridge object.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# ── This app's own package (custom plugins + MainActivity) ───────────────────
-keep class com.skilldrills.pro.** { *; }

# ── Bundled Capacitor plugins (loaded reflectively, see above) ───────────────
-keep class com.capacitorjs.plugins.** { *; }
-keep class io.capawesome.capacitorjs.plugins.** { *; }
-dontwarn com.capacitorjs.plugins.**
-dontwarn io.capawesome.capacitorjs.plugins.**

# ── Firebase (Auth / Analytics / Crashlytics) ────────────────────────────────
# Firebase discovers its components through the registrar/reflection machinery.
-keep class com.google.firebase.** { *; }
-keep class com.google.android.gms.** { *; }
-dontwarn com.google.firebase.**
-dontwarn com.google.android.gms.**

# Crashlytics is useless without these: keep the file name and line numbers so
# uploaded stack traces stay readable instead of arriving as obfuscated frames.
# (The Crashlytics Gradle plugin uploads the mapping file, but these attributes
# are what make the deobfuscated trace point at a real line.)
-keepattributes SourceFile,LineNumberTable
-keepattributes *Annotation*
-keepattributes Signature
-keepattributes Exceptions
-keepattributes InnerClasses
-keepattributes EnclosingMethod

# ── AndroidX bits used only from XML/manifest ────────────────────────────────
-keep class androidx.core.splashscreen.** { *; }

# ── WebView + JSON model classes ─────────────────────────────────────────────
# Plugin option/result objects are populated by field name from JS payloads.
-keepclassmembers class * implements android.os.Parcelable {
    public static final ** CREATOR;
}
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}
