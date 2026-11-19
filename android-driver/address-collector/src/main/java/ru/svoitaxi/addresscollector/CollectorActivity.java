package ru.svoitaxi.addresscollector;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.Context;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
 import android.webkit.JavascriptInterface;
 import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

public final class CollectorActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final int LOCATION_REQUEST = 201;
    private static final int EXPORT_REQUEST = 202;
    private static final int IMPORT_REQUEST = 203;
    private static final int MAX_EXPORT_BYTES = 8_000_000;

    private WebView browser;
    private CollectorUpdater updater;
    private byte[] pendingExport;
    private LocationManager locationManager;
    private final Handler locationHandler = new Handler(Looper.getMainLooper());
    private boolean locationRequested = false;
    private boolean locationListening = false;
    private long lastFixAt = 0L;

    private final Runnable locationTimeout = () -> {
        if(locationListening && lastFixAt == 0L) {
            sendStatus("timeout", "Не удалось получить координаты за 25 секунд. Включите GPS, выйдите на открытое место и нажмите «Повторить поиск».");
        }
    };

    private final LocationListener locationListener = new LocationListener() {
        @Override
        public void onLocationChanged(Location location) {
            sendLocation(location);
        }

        @Override
        public void onProviderDisabled(String provider) {
            if(!hasEnabledProvider()) {
                sendStatus("disabled", "Геолокация Android выключена. Откройте настройки GPS и включите местоположение.");
            }
        }
    };

    private void sendUpdateStatus(String state,String message,String version){
        if(browser==null)return;
        try{
            JSONObject payload=new JSONObject();
            payload.put("state",state);
            payload.put("message",message);
            payload.put("version",version);
            browser.evaluateJavascript(
                "window.SvoiCollector&&window.SvoiCollector.onUpdateStatus("+payload.toString()+")",null);
        }catch(Exception ignored){}
    }

    private void sendStatus(String code,String message) {
        if(browser==null)return;
        try {
            JSONObject payload=new JSONObject();
            payload.put("code",code);
            payload.put("message",message);
            browser.evaluateJavascript("window.SvoiCollector&&window.SvoiCollector.onNativeStatus("+payload.toString()+")",null);
        } catch(Exception ignored) {}
    }

    private void sendLocation(Location location) {
        if(location==null || !Double.isFinite(location.getLatitude()) ||
                !Double.isFinite(location.getLongitude()))return;
        if(location.getLatitude()==0 && location.getLongitude()==0)return;
        try {
            JSONObject payload=new JSONObject();
            payload.put("lat",location.getLatitude());
            payload.put("lng",location.getLongitude());
            payload.put("accuracyM",location.hasAccuracy()?location.getAccuracy():10000);
            payload.put("at",location.getTime());
            payload.put("speed",location.hasSpeed()?location.getSpeed():JSONObject.NULL);
            payload.put("provider",location.getProvider());
            lastFixAt=System.currentTimeMillis();
            locationHandler.removeCallbacks(locationTimeout);
            browser.evaluateJavascript("window.SvoiCollector&&window.SvoiCollector.onNativeLocation("+payload.toString()+")",null);
        } catch(Exception ignored) {}
    }

    private boolean permissionGranted() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)==PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasEnabledProvider() {
        if(locationManager==null)return false;
        try {
            return locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
                locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch(Exception e) {
            return false;
        }
    }

    private void stopNativeLocation() {
        locationHandler.removeCallbacks(locationTimeout);
        if(locationManager!=null && locationListening){
            try {locationManager.removeUpdates(locationListener);}catch(Exception ignored){}
        }
        locationListening=false;
    }

    private void startNativeLocation(boolean allowPermissionDialog) {
        locationRequested=true;
        if(!permissionGranted()) {
            stopNativeLocation();
            sendStatus("permission", "Нет разрешения на местоположение. Разрешите точную геопозицию для приложения.");
            if(allowPermissionDialog) {
                requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_REQUEST);
            }
            return;
        }
        if(locationManager==null)locationManager=(LocationManager)getSystemService(Context.LOCATION_SERVICE);
        if(!hasEnabledProvider()){
            stopNativeLocation();
            sendStatus("disabled", "Геолокация телефона выключена. Включите GPS в настройках Android.");
            return;
        }
        stopNativeLocation();
        lastFixAt=0L;
        boolean active=false;
        try {
            if(locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)){
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER,1200L,0f,locationListener,Looper.getMainLooper());
                active=true;
            }
        }catch(SecurityException | IllegalArgumentException ignored){}
        try {
            if(locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)){
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER,1200L,0f,locationListener,Looper.getMainLooper());
                active=true;
            }
        }catch(SecurityException | IllegalArgumentException ignored){}
        locationListening=active;
        if(!active){
            sendStatus("unavailable", "Провайдер геолокации недоступен. Включите точное местоположение в настройках приложения.");
            return;
        }
        sendStatus("searching", "Ищем координаты через Android GPS. На улице точность обычно выше.");
        locationHandler.postDelayed(locationTimeout,25000);
        for(String provider:new String[]{LocationManager.GPS_PROVIDER,LocationManager.NETWORK_PROVIDER}){
            try {
                Location last=locationManager.getLastKnownLocation(provider);
                if(last!=null && System.currentTimeMillis()-last.getTime()>=0 &&
                   System.currentTimeMillis()-last.getTime()<30000L)sendLocation(last);
            }catch(SecurityException | IllegalArgumentException ignored){}
        }
    }

    private void inform(String message) {
        runOnUiThread(() -> Toast.makeText(CollectorActivity.this,message,Toast.LENGTH_LONG).show());
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
            .addPathHandler("/",new WebViewAssetLoader.AssetsPathHandler(this)).build();
        browser = new WebView(this);
        updater = new CollectorUpdater(this,this::sendUpdateStatus);
        browser.setBackgroundColor(0xFF090F0D);
        browser.setLayerType(android.view.View.LAYER_TYPE_HARDWARE,null);
        setContentView(browser);
        WebSettings settings=browser.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        browser.addJavascriptInterface(new CollectorBridge(),"CollectorNative");
        browser.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request) {
                Uri uri=request.getUrl();
                if("https".equalsIgnoreCase(uri.getScheme()) &&
                    "appassets.androidplatform.net".equalsIgnoreCase(uri.getHost())){
                    return loader.shouldInterceptRequest(uri);
                }
                return null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request) {
                Uri uri=request.getUrl();
                // Only bundled owner collection screen may navigate this WebView.
                return !("https".equalsIgnoreCase(uri.getScheme()) &&
                    "appassets.androidplatform.net".equalsIgnoreCase(uri.getHost()));
            }
        });
        // Native LocationManager delivers fixes directly to the page. WebView geolocation is not used.
        browser.loadUrl(ORIGIN+"/collector.html");
    }

    private final class CollectorBridge {
        @JavascriptInterface
        public void startLocation(){
            runOnUiThread(()->startNativeLocation(true));
        }

        @JavascriptInterface
        public void retryLocation(){
            runOnUiThread(()->startNativeLocation(true));
        }

        @JavascriptInterface
        public void stopLocation(){
            runOnUiThread(()->stopNativeLocation());
        }

        @JavascriptInterface
        public void openGpsSettings(){
            runOnUiThread(()->{
                try {
                    startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS));
                }catch(Exception e) {
                    inform("Не удалось открыть настройки GPS");
                }
            });
        }

        @JavascriptInterface
        public void exportGeoJson(String data){
            export(data,"application/geo+json","svoi-adresa.geojson");
        }

        @JavascriptInterface
        public void exportCsv(String data){
            export(data,"text/csv","svoi-adresa.csv");
        }

        @JavascriptInterface
        public void checkForUpdates(){
            runOnUiThread(()->{if(updater!=null)updater.check();});
        }

        @JavascriptInterface
        public void installAvailableUpdate(){
            runOnUiThread(()->{if(updater!=null)updater.install();});
        }

        @JavascriptInterface
        public void importGeoJson(){
            runOnUiThread(()->{
                Intent picker=new Intent(Intent.ACTION_OPEN_DOCUMENT);
                picker.addCategory(Intent.CATEGORY_OPENABLE);
                picker.setType("*/*");
                picker.putExtra(Intent.EXTRA_MIME_TYPES,new String[]{"application/json","application/geo+json","text/plain"});
                startActivityForResult(picker,IMPORT_REQUEST);
            });
        }
    }

    private void export(String data,String mime,String filename){
        byte[] bytes=String.valueOf(data).getBytes(StandardCharsets.UTF_8);
        if(bytes.length==0||bytes.length>MAX_EXPORT_BYTES){
            inform("Не удалось выгрузить: файл превышает лимит 8 МБ");
            return;
        }
        runOnUiThread(()->{
            if(pendingExport!=null){
                inform("Сначала завершите предыдущее сохранение файла");
                return;
            }
            pendingExport=bytes;
            Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(mime);
            intent.putExtra(Intent.EXTRA_TITLE,filename);
            try{startActivityForResult(intent,EXPORT_REQUEST);}
            catch(Exception e){pendingExport=null;inform("Не удалось открыть выбор папки");}
        });
    }

    @Override
    protected void onActivityResult(int requestCode,int resultCode,Intent data){
        super.onActivityResult(requestCode,resultCode,data);
        if(requestCode==EXPORT_REQUEST){
            byte[] bytes=pendingExport;pendingExport=null;
            if(resultCode!=RESULT_OK||data==null||data.getData()==null||bytes==null)return;
            try(OutputStream stream=getContentResolver().openOutputStream(data.getData(),"wt")){
                if(stream==null)throw new IllegalStateException("No output stream");
                stream.write(bytes);
                stream.flush();
                inform("Резервная копия адресов сохранена");
            }catch(Exception e){
                inform("Ошибка сохранения. Адреса остались в приложении");
            }
        }
        if(requestCode==IMPORT_REQUEST&&resultCode==RESULT_OK&&data!=null&&data.getData()!=null){
            try(InputStream stream=getContentResolver().openInputStream(data.getData())){
                if(stream==null)throw new IllegalStateException("No input stream");
                ByteArrayOutputStream output=new ByteArrayOutputStream();
                byte[] buffer=new byte[8192];int read;
                while((read=stream.read(buffer))!=-1){
                    if(output.size()+read>MAX_EXPORT_BYTES)throw new IllegalArgumentException("File too large");
                    output.write(buffer,0,read);
                }
                String json=output.toString(StandardCharsets.UTF_8.name());
                browser.evaluateJavascript("window.SvoiCollector&&window.SvoiCollector.receiveImport("+JSONObject.quote(json)+")",null);
            }catch(Exception e){inform("Не удалось прочитать GeoJSON — выберите корректную резервную копию");}
        }
    }

    @Override
    public void onRequestPermissionsResult(int code,String[] names,int[] grants){
        super.onRequestPermissionsResult(code,names,grants);
        if(code!=LOCATION_REQUEST)return;
        boolean allowed=false;
        for(int item:grants){if(item==PackageManager.PERMISSION_GRANTED)allowed=true;}
        if(allowed)startNativeLocation(false);
        else sendStatus("denied", "Доступ к местоположению запрещён. Откройте настройки приложения и разрешите геопозицию.");
    }

    @Override
    protected void onPause(){
        stopNativeLocation();
        if(browser!=null)browser.onPause();
        super.onPause();
    }

    @Override
    protected void onResume(){
        super.onResume();
        if(browser!=null)browser.onResume();
        if(locationRequested)startNativeLocation(false);
    }

    @Override
    protected void onDestroy(){
        stopNativeLocation();
        pendingExport=null;
        if(updater!=null){updater.close();updater=null;}
        if(browser!=null)browser.destroy();
        super.onDestroy();
    }
}
