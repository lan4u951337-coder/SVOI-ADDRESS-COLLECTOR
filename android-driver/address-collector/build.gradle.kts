plugins {
    id("com.android.application")
}

android {
    namespace = "ru.svoitaxi.addresscollector"
    compileSdk = 36

    defaultConfig {
        applicationId = "ru.svoitaxi.addresscollector.preview"
        minSdk = 26
        targetSdk = 35
        versionCode = 7
        versionName = "0.7-preview-public-build"
    }

    buildFeatures {
        buildConfig = false
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
}
