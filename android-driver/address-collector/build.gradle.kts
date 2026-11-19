plugins {
    id("com.android.application")
}

// Signing material is never stored in this public repository. Set both
// environment variables from GitHub Actions repository secrets.
val releaseStorePath = System.getenv("SVOI_COLLECTOR_RELEASE_STORE_FILE")
val releaseStorePassword = System.getenv("SVOI_COLLECTOR_RELEASE_STORE_PASSWORD")
val releaseSigningReady = !releaseStorePath.isNullOrBlank() && !releaseStorePassword.isNullOrBlank()

android {
    namespace = "ru.svoitaxi.addresscollector"
    compileSdk = 36

    defaultConfig {
        applicationId = "ru.svoitaxi.collector"
        minSdk = 26
        targetSdk = 35
        versionCode = 10
        versionName = "0.8.2"
    }

    buildFeatures {
        buildConfig = false
    }

    signingConfigs {
        if (releaseSigningReady) {
            create("collectorRelease") {
                storeFile = file(releaseStorePath!!)
                storePassword = releaseStorePassword!!
                keyAlias = "svoi-collector"
                keyPassword = releaseStorePassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (releaseSigningReady) {
                signingConfig = signingConfigs.getByName("collectorRelease")
            }
        }
    }

    sourceSets.getByName("main").assets.srcDir("build/generated/collector-maplibre")

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

val copyCollectorMapLibre by tasks.registering(Copy::class) {
    val dist = rootProject.projectDir.parentFile.resolve("node_modules/maplibre-gl/dist")
    from(dist.resolve("maplibre-gl.js"))
    from(dist.resolve("maplibre-gl.css"))
    into(layout.buildDirectory.dir("generated/collector-maplibre"))
    doFirst {
        require(dist.resolve("maplibre-gl.js").length() > 200_000L) { "MapLibre library is not installed" }
        require(dist.resolve("maplibre-gl.css").length() > 2_000L) { "MapLibre stylesheet is not installed" }
    }
}

tasks.named("preBuild") {
    dependsOn(copyCollectorMapLibre)
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.core:core:1.17.0")
}

tasks.matching { it.name == "packageRelease" }.configureEach {
    doFirst {
        if (!releaseSigningReady) {
            throw GradleException("Refusing unsigned official release: protected signing credentials missing")
        }
    }
}
