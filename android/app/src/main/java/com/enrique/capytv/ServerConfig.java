package com.enrique.capytv;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.util.Collections;
import java.util.Enumeration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

public final class ServerConfig {

    public static final String LOG_TAG = "capytv";

    private static final String PREFERENCES_NAME = "capytv";
    private static final String BASE_URL_KEY = "serverBaseUrl";
    private static final String EMPTY_STRING = "";
    private static final int SERVER_PORT = 8787;
    private static final String APPLICATION_MARKER = "\"name\":\"capytv\"";
    private static final int SWEEP_THREAD_COUNT = 32;
    private static final int SWEEP_CONNECT_TIMEOUT_MILLISECONDS = 600;
    private static final int SWEEP_READ_TIMEOUT_MILLISECONDS = 900;
    private static final int SWEEP_DEADLINE_SECONDS = 25;
    private static final int WORKER_DRAIN_SECONDS = 1;
    private static final int VERIFY_TIMEOUT_MILLISECONDS = 2500;
    private static final int FIRST_HOST = 2;
    private static final int LAST_HOST = 254;
    private static final int ADDRESS_PART_COUNT = 4;
    private static final int RESPONSE_BUFFER_SIZE = 512;
    private static final String CHARSET_NAME = "UTF-8";

    private ServerConfig() {
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
    }

    public static String getBaseUrl(Context context) {
        return preferences(context).getString(BASE_URL_KEY, EMPTY_STRING);
    }

    public static void setBaseUrl(Context context, String baseUrl) {
        if (baseUrl == null || baseUrl.length() == 0) {
            return;
        }
        preferences(context).edit().putString(BASE_URL_KEY, normalise(baseUrl)).apply();
    }

    public static void forgetBaseUrl(Context context) {
        preferences(context).edit().remove(BASE_URL_KEY).apply();
    }

    // Accepts "192.168.1.8", "192.168.1.8:8787" or a full url, so the address box is forgiving.
    public static String normalise(String typed) {
        String trimmed = typed.trim();
        if (trimmed.length() == 0) {
            return EMPTY_STRING;
        }
        if (trimmed.startsWith("http://") == false && trimmed.startsWith("https://") == false) {
            trimmed = "http://" + trimmed;
        }
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        if (trimmed.lastIndexOf(':') <= trimmed.indexOf("://") + 2) {
            trimmed = trimmed + ":" + SERVER_PORT;
        }
        return trimmed;
    }

    public static String buildCandidateBaseUrl(String hostAddress) {
        return "http://" + hostAddress + ":" + SERVER_PORT;
    }

    public static boolean answersAsCapyTv(String baseUrl, int connectTimeout, int readTimeout) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(baseUrl + "/api/hello").openConnection();
            connection.setConnectTimeout(connectTimeout);
            connection.setReadTimeout(readTimeout);
            connection.setRequestMethod("GET");
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
                return false;
            }
            byte[] buffer = new byte[RESPONSE_BUFFER_SIZE];
            int read = connection.getInputStream().read(buffer);
            if (read <= 0) {
                return false;
            }
            return new String(buffer, 0, read, CHARSET_NAME).contains(APPLICATION_MARKER);
        } catch (Exception error) {
            return false;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    public static boolean isReachable(String baseUrl) {
        return answersAsCapyTv(baseUrl, VERIFY_TIMEOUT_MILLISECONDS, VERIFY_TIMEOUT_MILLISECONDS);
    }

    private static String findOwnAddress() {
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            for (NetworkInterface networkInterface : Collections.list(interfaces)) {
                if (networkInterface.isLoopback() || networkInterface.isUp() == false) {
                    continue;
                }
                for (InetAddress address : Collections.list(networkInterface.getInetAddresses())) {
                    String text = address.getHostAddress();
                    if (address.isLoopbackAddress() == false && text != null && text.indexOf(':') < 0) {
                        return text;
                    }
                }
            }
        } catch (Exception error) {
            Log.w(LOG_TAG, "could not read the local address: " + error.getMessage());
        }
        return EMPTY_STRING;
    }

    private static String subnetOf(String ownAddress) {
        String[] parts = ownAddress.split("\\.");
        if (parts.length != ADDRESS_PART_COUNT) {
            return EMPTY_STRING;
        }
        return parts[0] + "." + parts[1] + "." + parts[2];
    }

    public static String sweepSubnet() {
        String subnet = subnetOf(findOwnAddress());
        if (subnet.length() == 0) {
            return EMPTY_STRING;
        }
        Log.i(LOG_TAG, "sweeping " + subnet + ".0/24 for the pc");
        final AtomicReference<String> found = new AtomicReference<>(EMPTY_STRING);
        final CountDownLatch finished = new CountDownLatch(1);
        ExecutorService workers = Executors.newFixedThreadPool(SWEEP_THREAD_COUNT);
        for (int host = FIRST_HOST; host <= LAST_HOST; host += 1) {
            final String candidate = buildCandidateBaseUrl(subnet + "." + host);
            workers.execute(() -> {
                boolean stillLooking = found.get().length() == 0;
                if (stillLooking && answersAsCapyTv(candidate,
                        SWEEP_CONNECT_TIMEOUT_MILLISECONDS, SWEEP_READ_TIMEOUT_MILLISECONDS)) {
                    if (found.compareAndSet(EMPTY_STRING, candidate)) {
                        finished.countDown();
                    }
                }
            });
        }
        workers.shutdown();
        try {
            if (finished.await(SWEEP_DEADLINE_SECONDS, TimeUnit.SECONDS) == false) {
                workers.awaitTermination(WORKER_DRAIN_SECONDS, TimeUnit.SECONDS);
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
        workers.shutdownNow();
        Log.i(LOG_TAG, "sweep finished, pc=" + (found.get().length() == 0 ? "not found" : found.get()));
        return found.get();
    }

    // The stored address first, because it is instant when it is still right, then a sweep.
    public static String resolveBaseUrl(Context context) {
        String stored = getBaseUrl(context);
        if (stored.length() > 0 && isReachable(stored)) {
            return stored;
        }
        String found = sweepSubnet();
        if (found.length() > 0) {
            setBaseUrl(context, found);
        }
        return found;
    }
}
