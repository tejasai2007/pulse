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
fun runtimeSetting(name: String, fallback: String) = localProperties.getProperty(name)
    ?: providers.environmentVariable(name).getOrElse(fallback)

android {
    namespace = "dev.nitrostack.coach.watch"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.nitrostack.coach"
        minSdk = 30
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "VITALS_SOURCE", "\"watch\"")
        buildConfigField("String", "DEVICE_ACTIONS", "\"simulated\"")
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
    implementation("androidx.health:health-services-client:1.1.0-alpha05")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.wear.compose:compose-material3:1.0.0-alpha32")
    implementation("com.google.android.gms:play-services-wearable:19.0.0")
    implementation("com.google.guava:guava:33.3.1-android")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.9.0")
}
