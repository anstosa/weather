plugins {
    id("com.android.application")
}

val weatherFixtureResDir = providers.gradleProperty("weatherFixtureResDir").orNull
// require explicit local opt-in for debug widget downloads
val liveDebugWidgetRefresh = providers.gradleProperty("weatherLiveWidgetRefresh")
    .map { it.toBooleanStrict() }
    .getOrElse(false)

val versionCodeProperty = providers.gradleProperty("VERSION_CODE")
// validate the optional release version code
val releaseVersionCode = versionCodeProperty.map { rawVersionCode ->
    val parsedVersionCode = rawVersionCode.toIntOrNull()
    // reject invalid play store version codes
    if (parsedVersionCode == null || parsedVersionCode !in 1..2_100_000_000) {
        throw GradleException("VERSION_CODE must be a positive integer no greater than 2100000000")
    }
    parsedVersionCode
}.getOrElse(1)

val versionNameProperty = providers.gradleProperty("VERSION_NAME")
val releaseVersionNamePattern = Regex("""\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?""")
// validate the optional release version name
val releaseVersionName = versionNameProperty.map { rawVersionName ->
    // reject ambiguous release version names
    if (!releaseVersionNamePattern.matches(rawVersionName)) {
        throw GradleException(
            "VERSION_NAME must match digits.digits[.digits] with an optional alphanumeric release suffix",
        )
    }
    rawVersionName
}.getOrElse("0.1.0")

// require an explicit publish-time signing opt-in
val requireReleaseSigning = providers.gradleProperty("weatherRequireReleaseSigning")
    .map { it.toBooleanStrict() }
    .getOrElse(false)
val uploadKeystorePath = providers.environmentVariable("ANDROID_UPLOAD_KEYSTORE_FILE").orNull
val uploadKeystorePassword = providers.environmentVariable("ANDROID_UPLOAD_KEYSTORE_PASSWORD").orNull
val uploadKeyAlias = providers.environmentVariable("ANDROID_UPLOAD_KEY_ALIAS").orNull
val uploadKeyPassword = providers.environmentVariable("ANDROID_UPLOAD_KEY_PASSWORD").orNull
val uploadSigningProvided = uploadKeystorePath != null ||
    uploadKeystorePassword != null ||
    uploadKeyAlias != null ||
    uploadKeyPassword != null
val uploadSigningComplete = !uploadKeystorePath.isNullOrBlank() &&
    !uploadKeystorePassword.isNullOrBlank() &&
    !uploadKeyAlias.isNullOrBlank() &&
    !uploadKeyPassword.isNullOrBlank()

// reject partial or blank signing credentials
if (uploadSigningProvided && !uploadSigningComplete) {
    throw GradleException(
        "Android upload signing requires all four ANDROID_UPLOAD_* environment variables to be nonblank",
    )
}

// fail closed when publish signing is required
if (requireReleaseSigning && !uploadSigningComplete) {
    throw GradleException(
        "weatherRequireReleaseSigning=true requires all four ANDROID_UPLOAD_* environment variables",
    )
}

// require immutable publish version inputs
if (requireReleaseSigning && (!versionCodeProperty.isPresent || !versionNameProperty.isPresent)) {
    throw GradleException("weatherRequireReleaseSigning=true requires explicit VERSION_CODE and VERSION_NAME")
}

// resolve the keystore only after credentials are complete
val uploadKeystore = if (uploadSigningComplete) file(checkNotNull(uploadKeystorePath)) else null

// reject missing or non-file keystore paths
if (uploadKeystore != null && !uploadKeystore.isFile) {
    throw GradleException("ANDROID_UPLOAD_KEYSTORE_FILE must reference an existing file")
}

android {
    namespace = "farm.ballydidean.weather"
    compileSdk {
        version = release(37) {
            minorApiLevel = 0
        }
    }
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "farm.ballydidean.weather"
        minSdk = 26
        targetSdk = 36
        versionCode = releaseVersionCode
        versionName = releaseVersionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("boolean", "DEBUG_LIVE_WIDGET_REFRESH", "false")
    }

    // configure upload signing only from complete environment credentials
    val releaseUploadSigning = if (uploadSigningComplete) {
        signingConfigs.create("releaseUpload") {
            storeFile = uploadKeystore
            storePassword = checkNotNull(uploadKeystorePassword)
            keyAlias = checkNotNull(uploadKeyAlias)
            keyPassword = checkNotNull(uploadKeyPassword)
        }
    } else {
        null
    }

    sourceSets {
        getByName("test").resources.srcDir("../../shared")
        getByName("androidTest").assets.srcDir("../../shared")
        getByName("debug").assets.srcDir("../../shared")
        // overlay only ephemeral debug fixture trust resources
        if (weatherFixtureResDir != null) {
            getByName("debug").res.srcDir(weatherFixtureResDir)
        }
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            buildConfigField("boolean", "DEBUG_LIVE_WIDGET_REFRESH", liveDebugWidgetRefresh.toString())
        }
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // keep ordinary release builds unsigned
            if (releaseUploadSigning != null) {
                signingConfig = releaseUploadSigning
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        managedDevices {
            // run the host contract on a public aosp image
            localDevices {
                create("widgetPhone") {
                    device = "Pixel 4"
                    apiLevel = 36
                    systemImageSource = "aosp"
                    testedAbi = "x86_64"
                }
            }
        }
    }
}

dependencies {
    implementation("androidx.work:work-runtime:2.11.2")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.work:work-testing:2.11.2")
}
