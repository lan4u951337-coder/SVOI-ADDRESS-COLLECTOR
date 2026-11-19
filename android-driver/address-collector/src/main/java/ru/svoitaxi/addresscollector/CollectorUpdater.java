package ru.svoitaxi.addresscollector;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Opt-in updater for the standalone, GitHub-distributed collector APK.
 * Never downloads private data and never installs silently: Android owns the final consent.
 */
final class CollectorUpdater {
    interface Reporter { void report(String state, String message, String version); }

    private static final String API =
        "https://api.github.com/repos/lan4u951337-coder/SVOI-ADDRESS-COLLECTOR/releases/latest";
    private static final String DOWNLOAD_PREFIX =
        "https://github.com/lan4u951337-coder/SVOI-ADDRESS-COLLECTOR/releases/download/";
    private static final String APK_NAME = "SVOI-Address-Collector.apk";
    private static final int MAX_APK_BYTES = 35_000_000;
    private static final Pattern VERSION = Pattern.compile("^v?(\\d+)\\.(\\d+)\\.(\\d+)$");
    private static final Pattern DIGEST = Pattern.compile("^sha256:([a-fA-F0-9]{64})$");

    private final Activity activity;
    private final Reporter reporter;
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private volatile Release available;
    private volatile File verifiedApk;
    private volatile boolean busy = false;
    private volatile boolean closed = false;

    private static final class Release {
        final String tag, url, digest;
        final int size;
        Release(String tag, String url, String digest, int size) {
            this.tag = tag; this.url = url; this.digest = digest; this.size = size;
        }
    }

    CollectorUpdater(Activity activity, Reporter reporter) {
        this.activity = activity;
        this.reporter = reporter;
    }

    private void report(String state, String text, String version) {
        activity.runOnUiThread(() -> {
            if(!closed)reporter.report(state, text, version);
        });
    }

    private static int[] parsedVersion(String value) throws Exception {
        Matcher m = VERSION.matcher(value);
        if(!m.matches())throw new Exception("Неверный номер версии приложения");
        return new int[]{Integer.parseInt(m.group(1)),Integer.parseInt(m.group(2)),
            Integer.parseInt(m.group(3))};
    }

    private static int compareVersions(String newer,String older) throws Exception {
        int[] a=parsedVersion(newer),b=parsedVersion(older);
        for(int i=0;i<a.length;i++)if(a[i]!=b[i])return Integer.compare(a[i],b[i]);
        return 0;
    }

    @SuppressWarnings("deprecation")
    private PackageInfo installedInfo() throws Exception {
        int flags = Build.VERSION.SDK_INT>=28?PackageManager.GET_SIGNING_CERTIFICATES:PackageManager.GET_SIGNATURES;
        return activity.getPackageManager().getPackageInfo(activity.getPackageName(),flags);
    }

    private String installedVersion() throws Exception {
        return installedInfo().versionName;
    }

    private static byte[] readLimited(InputStream in,int max) throws Exception {
        ByteArrayOutputStream out=new ByteArrayOutputStream();
        byte[] chunk=new byte[8192];
        int n;
        while((n=in.read(chunk))!=-1){
            if(out.size()+n>max)throw new Exception("Ответ сервера превышает лимит");
            out.write(chunk,0,n);
        }
        return out.toByteArray();
    }

    private static HttpURLConnection connection(String location) throws Exception {
        URL url=new URL(location);
        if(!"https".equalsIgnoreCase(url.getProtocol()))throw new Exception("Небезопасный адрес обновления");
        HttpURLConnection con=(HttpURLConnection)url.openConnection();
        con.setInstanceFollowRedirects(true);
        con.setConnectTimeout(15000);
        con.setReadTimeout(30000);
        con.setRequestProperty("Accept","application/vnd.github+json");
        con.setRequestProperty("User-Agent","SVOI-Address-Collector-Updater");
        return con;
    }

    private static String shaHex(byte[] input){
        final String alphabet="0123456789abcdef";
        StringBuilder result=new StringBuilder(input.length*2);
        for(byte b:input){
            result.append(alphabet.charAt((b>>4)&15));
            result.append(alphabet.charAt(b&15));
        }
        return result.toString();
    }

    private Release latestRelease() throws Exception {
        HttpURLConnection con=connection(API);
        try{
            if(con.getResponseCode()!=200)throw new Exception("GitHub не ответил: "+con.getResponseCode());
            JSONObject json;
            try(InputStream in=con.getInputStream()){
                json=new JSONObject(new String(readLimited(in,200_000),StandardCharsets.UTF_8));
            }
            if(json.optBoolean("draft")||json.optBoolean("prerelease"))
                throw new Exception("Нет официального стабильного обновления");
            String tag=json.optString("tag_name","");
            parsedVersion(tag);
            JSONArray assets=json.optJSONArray("assets");
            if(assets==null)throw new Exception("Официальная сборка ещё не опубликована");
            for(int i=0;i<assets.length();i++){
                JSONObject asset=assets.optJSONObject(i);
                if(asset==null||!APK_NAME.equals(asset.optString("name")))continue;
                String url=asset.optString("browser_download_url","");
                if(!url.equals(DOWNLOAD_PREFIX+tag+"/"+APK_NAME))
                    throw new Exception("Ссылка на APK не прошла проверку");
                int size=asset.optInt("size",0);
                if(size<=0||size>MAX_APK_BYTES)throw new Exception("Недопустимый размер APK");
                Matcher matcher=DIGEST.matcher(asset.optString("digest",""));
                if(!matcher.matches())throw new Exception("Нет контрольной суммы APK");
                return new Release(tag,url,matcher.group(1).toLowerCase(Locale.ROOT),size);
            }
            throw new Exception("APK отсутствует в официальном выпуске");
        }finally{con.disconnect();}
    }

    void check(){
        if(closed||busy)return;
        busy=true;
        report("checking","Проверяем официальные обновления…","");
        network.execute(()->{
            try{
                Release newest=latestRelease();
                if(compareVersions(newest.tag,installedVersion())>0){
                    available=newest;
                    verifiedApk=null;
                    report("available","Доступна версия "+newest.tag.substring(1)+". Обновить внутри приложения?",newest.tag);
                }else{
                    available=null;verifiedApk=null;
                    report("current","Установлена актуальная версия сборщика.","");
                }
            }catch(Exception e){
                report("error","Не удалось проверить обновления: "+safeMessage(e),"");
            }finally{busy=false;}
        });
    }

    void install(){
        if(closed||busy)return;
        Release release=available;
        if(release==null){
            report("error","Сначала проверьте наличие обновления.","");
            return;
        }
        if(verifiedApk!=null&&verifiedApk.isFile()){
            try{beginAndroidInstall(verifiedApk);}catch(Exception e){
                report("error","Не удалось открыть установку: "+safeMessage(e),release.tag);
            }
            return;
        }
        busy=true;
        report("downloading","Загружаем проверенное обновление "+release.tag+"…",release.tag);
        network.execute(()->{
            try{
                File file=downloadAndValidate(release);
                verifiedApk=file;
                report("ready","APK проверен. Подтвердите обновление в Android.",release.tag);
                activity.runOnUiThread(()->{
                    if(!closed){
                        try{beginAndroidInstall(file);}catch(Exception e){
                            report("error","Не удалось открыть установку: "+safeMessage(e),release.tag);
                        }
                    }
                });
            }catch(Exception e){
                report("available","Не удалось загрузить обновление: "+safeMessage(e)+". Можно повторить.",release.tag);
            }finally{busy=false;}
        });
    }

    private File downloadAndValidate(Release release) throws Exception {
        File dir=new File(activity.getCacheDir(),"updates");
        if(!dir.isDirectory()&&!dir.mkdirs())throw new Exception("Не удалось подготовить папку обновлений");
        // Android PackageManager parses archives reliably only with an .apk suffix.
        File tmp=new File(dir,"svoi-update-pending.apk");
        File complete=new File(dir,"svoi-update-"+release.tag+".apk");
        if(tmp.exists())tmp.delete();
        HttpURLConnection con=connection(release.url);
        try{
            if(con.getResponseCode()!=200)throw new Exception("Загрузка APK: HTTP "+con.getResponseCode());
            URL redirected=con.getURL();
            String host=redirected.getHost().toLowerCase(Locale.ROOT);
            if(!"https".equalsIgnoreCase(redirected.getProtocol())||
              !(host.equals("github.com")||host.endsWith(".githubusercontent.com")))
                throw new Exception("Непроверенный сервер загрузки");
            MessageDigest sha=MessageDigest.getInstance("SHA-256");
            int total=0;
            try(InputStream in=con.getInputStream();FileOutputStream out=new FileOutputStream(tmp)){
                byte[] chunk=new byte[32768];
                int n;
                while((n=in.read(chunk))!=-1){
                    total+=n;
                    if(total>MAX_APK_BYTES||total>release.size)
                        throw new Exception("Слишком большой файл обновления");
                    sha.update(chunk,0,n);
                    out.write(chunk,0,n);
                }
                out.flush();
            }
            if(total!=release.size||!shaHex(sha.digest()).equals(release.digest))
                throw new Exception("Контрольная сумма обновления не совпала");
            verifySignatureAndVersion(tmp);
            if(complete.exists()&&!complete.delete())throw new Exception("Не удалось заменить временный APK");
            if(!tmp.renameTo(complete))throw new Exception("Не удалось сохранить APK для установки");
            return complete;
        }finally{
            con.disconnect();
            if(tmp.exists())tmp.delete();
        }
    }

    @SuppressWarnings("deprecation")
    private void verifySignatureAndVersion(File file) throws Exception {
        PackageManager pm=activity.getPackageManager();
        int flags=Build.VERSION.SDK_INT>=28?PackageManager.GET_SIGNING_CERTIFICATES:PackageManager.GET_SIGNATURES;
        PackageInfo archive=pm.getPackageArchiveInfo(file.getAbsolutePath(),flags);
        PackageInfo current=installedInfo();
        if(archive==null||!activity.getPackageName().equals(archive.packageName))
            throw new Exception("APK принадлежит другому приложению");
        long newCode=Build.VERSION.SDK_INT>=28?archive.getLongVersionCode():archive.versionCode;
        long oldCode=Build.VERSION.SDK_INT>=28?current.getLongVersionCode():current.versionCode;
        if(newCode<=oldCode)throw new Exception("Версия APK не новее установленной");
        Signature[] target=Build.VERSION.SDK_INT>=28?
            (archive.signingInfo==null?null:archive.signingInfo.getApkContentsSigners()):archive.signatures;
        Signature[] original=Build.VERSION.SDK_INT>=28?
            (current.signingInfo==null?null:current.signingInfo.getApkContentsSigners()):current.signatures;
        if(target==null||original==null||target.length!=1||original.length!=1||
            !Arrays.equals(target[0].toByteArray(),original[0].toByteArray()))
            throw new Exception("Цифровая подпись отличается от установленного приложения");
    }

    private void beginAndroidInstall(File file) throws Exception {
        if(!file.isFile())throw new Exception("APK больше не доступен, повторите загрузку");
        if(Build.VERSION.SDK_INT>=26&&!activity.getPackageManager().canRequestPackageInstalls()){
            report("permission","Разрешите установку обновлений из СВОИ · Сбор адресов в настройках Android, затем нажмите «Обновить».","");
            Intent settings=new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:"+activity.getPackageName()));
            activity.startActivity(settings);
            return;
        }
        Uri uri=FileProvider.getUriForFile(activity,
            activity.getPackageName()+".updatefiles",file);
        Intent intent=new Intent(Intent.ACTION_INSTALL_PACKAGE);
        intent.setData(uri);
        intent.setClipData(ClipData.newRawUri("Обновление СВОИ",uri));
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        activity.startActivity(intent);
    }

    private static String safeMessage(Exception e){
        String msg=e.getMessage();
        if(msg==null||msg.isBlank())return "ошибка сети или устройства";
        // Do not display user-sensitive exception content on the public screen.
        return msg.length()>120?msg.substring(0,120):msg;
    }

    void close(){
        closed=true;
        network.shutdownNow();
    }
}
