import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.isFile) file.inputStream().use(::load)
}
val deepgramKey = localProperties.getProperty("DEEPGRAM_API_KEY")
    ?: providers.environmentVariable("DEEPGRAM_API_KEY").getOrElse("")
fun runtimeSetting(name: String, fallback: String) = localProperties.getProperty(name)
    ?: providers.environmentVariable(name).getOrElse(fallback)

android {
    namespace = "dev.nitrostack.coach.phone"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.nitrostack.coach"
        minSdk = 31
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "DEEPGRAM_API_KEY", "\"$deepgramKey\"")
        buildConfigField("String", "BACKEND_URL", "\"${runtimeSetting("BACKEND_URL", "http://rlcraft.hrideshmg.com")}\"")
        buildConfigField("String", "VITALS_SOURCE", "\"${runtimeSetting("VITALS_SOURCE", "simulated")}\"")
        buildConfigField("String", "AUDIO_INPUT", "\"${runtimeSetting("AUDIO_INPUT", "phone")}\"")
        buildConfigField("String", "TRANSCRIPTION_MODE", "\"${runtimeSetting("TRANSCRIPTION_MODE", "fixture")}\"")
        buildConfigField("String", "DEVICE_ACTIONS", "\"${runtimeSetting("DEVICE_ACTIONS", "simulated")}\"")
        buildConfigField("Boolean", "COPILOT_ENABLED", runtimeSetting("COPILOT_ENABLED", "true"))
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation(project(":contracts"))
    implementation("androidx.activity:activity-compose:1.10.0")
    implementation("androidx.compose.material3:material3:1.3.1")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("com.google.android.gms:play-services-wearable:19.0.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.9.0")
    testImplementation("junit:junit:4.13.2")
}
