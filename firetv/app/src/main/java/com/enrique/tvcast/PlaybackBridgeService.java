package com.enrique.tvcast;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
import android.util.Log;

import org.json.JSONObject;

public class PlaybackBridgeService extends Service {

    public static final int LISTEN_PORT = 8788;

    private static final String LOG_TAG = "tvcast";
    private static final String CHANNEL_ID = "tvcast-bridge";
    private static final int NOTIFICATION_ID = 1;
    private static final String EMPTY_STRING = "";
    private static final int REGISTER_ATTEMPTS = 10;
    private static final int REGISTER_RETRY_MILLISECONDS = 15000;

    private TinyHttpServer listener;

    public static void ensureRunning(Context context) {
        try {
            context.startForegroundService(new Intent(context, PlaybackBridgeService.class));
        } catch (Exception error) {
            Log.w(LOG_TAG, "could not start the bridge: " + error.getMessage());
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        startInForeground();
        listener = new TinyHttpServer(LISTEN_PORT, this::handle);
        listener.start();
        announceToServer();
    }

    private void announceToServer() {
        final String baseUrl = ServerLocator.getBaseUrl(this);
        if (baseUrl.length() == 0) {
            Log.i(LOG_TAG, "no server address stored yet, waiting to be found by the sweep");
            return;
        }
        new Thread(() -> {
            for (int attempt = 0; attempt < REGISTER_ATTEMPTS; attempt += 1) {
                try {
                    ServerApi.post(baseUrl + "/api/tv/register", "{}");
                    Log.i(LOG_TAG, "registered with the pc at " + baseUrl);
                    return;
                } catch (Exception error) {
                    Log.w(LOG_TAG, "register attempt " + (attempt + 1) + " failed: " + error.getMessage());
                    try {
                        Thread.sleep(REGISTER_RETRY_MILLISECONDS);
                    } catch (InterruptedException interrupted) {
                        return;
                    }
                }
            }
        }).start();
    }

    private void startInForeground() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "tvcast bridge", NotificationManager.IMPORTANCE_MIN);
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
        Notification notification = new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("tvcast")
                .setContentText("Ready for the phone")
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .build();
        startForeground(NOTIFICATION_ID, notification);
    }

    private String handle(String method, String path, String body) {
        if (path.startsWith("/ping")) {
            return "{\"app\":\"tvcast\",\"port\":" + LISTEN_PORT + "}";
        }
        if (path.startsWith("/play") && method.equals("POST")) {
            return startPlayback(body);
        }
        if (path.startsWith("/offset") && method.equals("POST")) {
            return applySubtitleOffset(body);
        }
        if (path.startsWith("/stop") && method.equals("POST")) {
            return "{\"ok\":true}";
        }
        return "{\"ok\":false,\"error\":\"unknown route\"}";
    }

    private String applySubtitleOffset(String body) {
        try {
            JSONObject payload = new JSONObject(body);
            boolean applied = PlayerActivity.applyMeasuredOffset(
                    payload.optString("contentKey", EMPTY_STRING),
                    payload.optLong("offsetMilliseconds", 0));
            Log.i(LOG_TAG, "measured subtitle offset applied=" + applied);
            return "{\"ok\":true,\"applied\":" + applied + "}";
        } catch (Exception error) {
            return "{\"ok\":false,\"error\":\"bad offset payload\"}";
        }
    }

    private String startPlayback(String body) {
        try {
            JSONObject payload = new JSONObject(body);
            String serverBaseUrl = payload.optString("serverBaseUrl", EMPTY_STRING);
            if (serverBaseUrl.length() > 0) {
                ServerLocator.setBaseUrl(this, serverBaseUrl);
            }
            startActivity(PlayerActivity.buildIntent(this, body));
            Log.i(LOG_TAG, "started playback from a push");
            return "{\"ok\":true,\"state\":\"starting\"}";
        } catch (Exception error) {
            Log.e(LOG_TAG, "push playback failed", error);
            return "{\"ok\":false,\"error\":\"" + error.getMessage() + "\"}";
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        if (listener != null) {
            listener.stop();
            listener = null;
        }
        super.onDestroy();
    }
}
