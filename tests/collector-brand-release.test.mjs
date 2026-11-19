import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url);
const read=path=>readFileSync(new URL(path,root),'utf8');
const iconPath='android-driver/address-collector/src/main/res/drawable-nodpi/svoi_collector_icon.png';

test('address collector launcher uses approved СВОИ address-pin brand icon',()=>{
  const p=new URL(iconPath,root);
  assert.ok(existsSync(p),'Approved СВОИ address-pin launcher icon missing');
  const bytes=readFileSync(p);
  assert.equal(bytes.length,5369);
  const sha=createHash('sha1').update(Buffer.from('blob '+bytes.length+String.fromCharCode(0))).update(bytes).digest('hex');
  assert.equal(sha,'2940c67071b6431bbacce66556dc832fc7b7e4f1');
  const xml=read('android-driver/address-collector/src/main/AndroidManifest.xml');
  assert.match(xml,/android:icon="@drawable\/svoi_collector_icon"/);
  assert.match(xml,/android:roundIcon="@drawable\/svoi_collector_icon"/);
  assert.match(xml,/android:allowBackup="false"/);
});
test('official app installs separately from older test builds without deleting addresses',()=>{
  const gradle=read('android-driver/address-collector/build.gradle.kts');
  const html=read('android-driver/address-collector/src/main/assets/collector.html');
  assert.match(gradle,/applicationId = "ru\.svoitaxi\.collector"/);
  assert.match(gradle,/versionCode = 11/);
  assert.match(gradle,/versionName = "0\.8\.3"/);
  assert.doesNotMatch(html,/Сбор адресов · тестовая версия/);
  assert.match(html,/Сбор адресов · общая карта/);
});
test('official release requires permanent protected signing and never publishes unsigned APK',()=>{
  const gradle=read('android-driver/address-collector/build.gradle.kts');
  const workflow=read('.github/workflows/build-apk.yml');
  assert.match(gradle,/SVOI_COLLECTOR_RELEASE_STORE_FILE/);
  assert.match(gradle,/SVOI_COLLECTOR_RELEASE_STORE_PASSWORD/);
  assert.match(gradle,/throw GradleException\("Refusing unsigned official release/);
  assert.match(workflow,/COLLECTOR_RELEASE_KEYSTORE_BASE64/);
  assert.match(workflow,/COLLECTOR_RELEASE_KEYSTORE_PASSWORD/);
  assert.match(workflow,/needs\.apk\.outputs\.signing_ready == 'true'/);
  assert.match(workflow,/SVOI-Address-Collector\.apk/);
  assert.match(workflow,/gh release create v0\.8\.3/);
  assert.match(workflow,/7f57730bcaa2648a725cf11264a8a2829fd0a16bc1d06e55ed1cefd4371b1063/);
  assert.doesNotMatch(workflow,/sshpass|VPS_ROOT|docker compose|POSTGRES_PASSWORD|DATABASE_URL/);
  assert.ok(workflow.includes(iconPath));
});
