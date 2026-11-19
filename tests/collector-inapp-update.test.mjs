import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const B='android-driver/address-collector/';
const gradle=read(B+'build.gradle.kts');
const manifest=read(B+'src/main/AndroidManifest.xml');
const updater=read(B+'src/main/java/ru/svoitaxi/addresscollector/CollectorUpdater.java');
const activity=read(B+'src/main/java/ru/svoitaxi/addresscollector/CollectorActivity.java');
const html=read(B+'src/main/assets/collector.html');
const js=read(B+'src/main/assets/collector.js');
const paths=read(B+'src/main/res/xml/collector_update_paths.xml');

test('official updater keeps package name, increases version and retains original signing key',()=>{
  assert.ok(gradle.includes('applicationId = "ru.svoitaxi.collector"'));
  assert.ok(gradle.includes('versionCode = 10'));
  assert.ok(gradle.includes('versionName = "0.8.2"'));
  assert.ok(gradle.includes('SVOI_COLLECTOR_RELEASE_STORE_FILE'));
  assert.ok(gradle.includes('signingConfig = signingConfigs.getByName("collectorRelease")'));
});
test('Android installer is restricted to app cache and requires system approval',()=>{
  assert.ok(manifest.includes('android.permission.REQUEST_INSTALL_PACKAGES'));
  assert.ok(manifest.includes('androidx.core.content.FileProvider'));
  assert.ok(manifest.includes('android:exported="false"'));
  assert.ok(paths.includes('cache-path name="verified-updates" path="updates/"'));
  assert.ok(!paths.includes('external-path')&&!paths.includes('root-path'));
  assert.ok(updater.includes('ACTION_MANAGE_UNKNOWN_APP_SOURCES'));
  assert.ok(updater.includes('canRequestPackageInstalls'));
  assert.ok(updater.includes('Intent.ACTION_INSTALL_PACKAGE'));
  assert.ok(updater.includes('FLAG_GRANT_READ_URI_PERMISSION'));
  assert.ok(!manifest.includes('android.permission.INSTALL_PACKAGES'));
});
test('download verifies official stable GitHub release, SHA-256, APK identity and signer',()=>{
  for(const token of [
    'SVOI-ADDRESS-COLLECTOR/releases/latest',
    'SVOI-Address-Collector.apk','browser_download_url',
    'MessageDigest.getInstance("SHA-256")',
    'getPackageArchiveInfo','archive.packageName',
    'svoi-update-pending.apk',
    'getApkContentsSigners','release.digest',
    'Arrays.equals(target[0].toByteArray(),original[0].toByteArray())',
    'newCode<=oldCode',
    'url.equals(DOWNLOAD_PREFIX+tag+"/"+APK_NAME)',
    'host.endsWith(".githubusercontent.com")'
  ])assert.ok(updater.includes(token),'Missing updater verification: '+token);
});
test('update install requires explicit tap; release checking runs on launch',()=>{
  assert.ok(html.includes('id="checkForUpdates"'));
  assert.ok(html.includes('id="installUpdate"'));
  assert.ok(js.includes('function onUpdateStatus(payload)'));
  assert.ok(js.includes("$('installUpdate').addEventListener('click'"));
  assert.ok(js.includes('setTimeout(()=>{if(window.CollectorNative?.checkForUpdates)'));
  assert.ok(activity.includes('public void checkForUpdates()'));
  assert.ok(activity.includes('public void installAvailableUpdate()'));
  assert.ok(activity.includes('updater.close()'));
  assert.ok(activity.includes('onUpdateStatus('));
});
